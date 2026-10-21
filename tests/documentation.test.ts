import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Script, runInNewContext } from 'node:vm';
import { generate, languages } from '../client/documentation/request-snippets.ts';

const request = {
  method: 'POST',
  url: "https://api.example.test/v1/ação?q=O'Reilly&n=1",
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: "Bearer t'\\$oken",
    'X-Custom': 'ação 💚',
  },
  body: JSON.stringify({ title: "O'Reilly \\ $test `ok` <script>", body: 'ação 💚\nsecond line', enabled: true }, null, 2),
};

test('all nine snippet formats support bodies and omit them for GET and HEAD', () => {
  assert.equal(languages.length, 9);
  assert.equal(new Set(languages.map(({ id }) => id)).size, languages.length);
  for (const { id } of languages) {
    assert.ok(generate(id, request).length > 50, id);
    for (const method of ['get', 'HEAD']) {
      const code = generate(id, { ...request, method, body: 'BODY_MUST_BE_OMITTED' });
      assert.ok(!code.includes('BODY_MUST_BE_OMITTED'), `${id}: ${method}`);
    }
    assert.ok(generate(id, { method: 'DELETE', url: 'https://api.example.test', body: null }).length > 0);
  }
  assert.throws(() => generate('unsupported', request), RangeError);
});

for (const id of ['javascript', 'node']) {
  test(`${id} fetch snippet sends the exact URL, headers and raw body`, async () => {
    let captured: { url: string; options: RequestInit } | undefined;
    const code = generate(id, request);
    new Script(code);
    const failures: unknown[] = [];
    runInNewContext(code, {
      fetch: async (url: string, options: RequestInit) => {
        captured = { url, options };
        return { status: 201, text: async () => '{"ok":true}' };
      },
      console: { log() {}, error(error: unknown) { failures.push(error); } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(failures, []);
    assert.ok(captured);
    assert.equal(captured.url, request.url);
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.body, request.body);
    assert.deepEqual(JSON.parse(JSON.stringify(captured.options.headers)), request.headers);
  });
}

for (const id of ['curl', 'httpie', 'wget']) {
  test(`${id} shell snippet preserves quotes, unicode, headers and payload`, { skip: process.platform === 'win32' }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'facet-snippet-'));
    try {
      const recorder = join(directory, 'record.cjs');
      writeFileSync(recorder, "const fs = require('node:fs'); process.stdout.write(JSON.stringify({ args: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }));");
      const executable = id === 'httpie' ? 'http' : id;
      const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
      // Substitute the executable with an argv recorder; no API request is sent.
      const code = generate(id, request).replace(new RegExp('\\b' + executable + '(?= )'), `${shellQuote(process.execPath)} ${shellQuote(recorder)}`);
      execFileSync('/bin/sh', ['-n'], { input: code });
      const recorded = JSON.parse(execFileSync('/bin/sh', ['-c', code], { input: '', encoding: 'utf8' })) as { args: string[]; stdin: string };
      assert.ok(recorded.args.includes(request.url));
      const delimiter = id === 'httpie' ? ':' : ': ';
      for (const [name, value] of Object.entries(request.headers)) {
        const header = name + delimiter + value;
        assert.ok(recorded.args.includes(id === 'wget' ? '--header=' + header : header), `${id}: ${name}`);
      }
      if (id === 'curl') assert.equal(recorded.args[recorded.args.indexOf('--data-raw') + 1], request.body);
      if (id === 'wget') assert.ok(recorded.args.includes('--body-data=' + request.body));
      if (id === 'httpie') assert.equal(recorded.stdin, request.body);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
