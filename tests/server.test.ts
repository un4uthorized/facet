import assert from 'node:assert/strict';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, type AppConfig, type FacetApp } from '../server/app.js';
import { createTestDatabase } from './postgres.js';
import { createTotp, hashRecoveryCode, decryptSecret, generateRecoveryCodes } from '../server/totp.js';

const adminEmail = 'admin@example.com';
const adminPassword = 'Audit admin password! 739';
const userEmail = 'reader@example.com';
const userPassword = 'Audit-reader#15';
const mfaEncryptionKey = Buffer.alloc(32, 7).toString('base64');

const configurations = new Map<string, AppConfig>();

interface RunningApp { app: FacetApp; server: Server; url: string; stop: () => Promise<void> }

async function listen(config: AppConfig): Promise<RunningApp> {
  const app = await createApp(config);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  } catch (error) { await app.close(); throw error; }
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  configurations.set(`http://127.0.0.1:${address.port}`, config);
  let stopping: Promise<void> | undefined;
  return {
    app, server, url: `http://127.0.0.1:${address.port}`,
    stop: () => stopping ??= (async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await app.close();
    })(),
  };
}

async function fixture(overrides: Partial<AppConfig> = {}) {
  const { databaseUrl, drop: dropDatabase } = await createTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), 'facet-server-'));
  const clientDirectory = join(directory, 'client');
  const documentationDirectory = join(directory, 'documentation');
  await mkdir(clientDirectory);
  await mkdir(documentationDirectory);
  await writeFile(join(clientDirectory, 'index.html'), '<html><body>Public React shell</body></html>');
  await writeFile(join(documentationDirectory, 'sample-openapi.json'), '{"secretDocumentation":true}');
  await writeFile(join(documentationDirectory, 'index.html'), '<html>Protected documentation</html>');
  const config: AppConfig = {
    adminEmail, adminPassword, databaseUrl, mfaEncryptionKey,
    clientDirectory, documentationDirectory, ...overrides,
  };
  let running: RunningApp;
  try { running = await listen(config); }
  catch (error) {
    await dropDatabase();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    ...running, config, directory, dropDatabase,
    dispose: async () => {
      try { await running.stop(); }
      finally { await dropDatabase(); await rm(directory, { recursive: true, force: true }); }
    },
  };
}

async function request(url: string, path: string, options: { cookie?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const { cookie, method = 'GET', body, headers = {} } = options;
  return fetch(`${url}${path}`, {
    method, redirect: 'manual',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function completeEnrollment(url: string, enrollment: {enrollmentToken:string;secret:string}) {
  const response=await request(url,'/api/auth/mfa/enrollment/confirm',{method:'POST',body:{enrollmentToken:enrollment.enrollmentToken,code:createTotp(enrollment.secret,'Fixture').generate()}});
  assert.equal(response.status,200,await response.clone().text());
  return response.json();
}
async function recoveryFor(url:string,email:string) {
  email=email.trim().toLowerCase();
  const config=configurations.get(url)!;
  const database=new Pool({connectionString:config.databaseUrl});
  try{
    const id=email===config.adminEmail?'admin':(await database.query('SELECT id FROM users WHERE email=$1',[email])).rows[0].id;
    const code=randomBytes(12).toString('hex');
    await database.query('UPDATE mfa_factors SET recovery_hashes=recovery_hashes || $1::jsonb WHERE account_id=$2',[JSON.stringify([hashRecoveryCode(code)]),id]);
    return code;
  }finally{await database.end();}
}
async function login(url: string, email = adminEmail, password = adminPassword) {
  let response = await request(url, '/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(response.status, 200, await response.clone().text());
  let payload=await response.clone().json();
  if(payload.mfaEnrollmentRequired){await completeEnrollment(url,payload);response=await request(url,'/api/auth/login',{method:'POST',body:{email,password}});payload=await response.clone().json();}
  if(payload.mfaRequired){response=await request(url,'/api/auth/mfa/verify',{method:'POST',body:{challengeToken:payload.challengeToken,code:await recoveryFor(url,email)}});}
  assert.equal(response.status,200,await response.clone().text());
  return { response, cookie:responseCookie(response) };
}

function responseCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).findLast((value) => /^facet_session=[a-f0-9]{64}$/.test(value));
  assert.ok(cookie);
  return cookie;
}

async function enableMfa(url: string, cookie: string, password: string) {
  const me=await request(url,'/api/auth/me',{cookie});const {user}=await me.json();
  const config=configurations.get(url)!;
  const database=new Pool({connectionString:config.databaseUrl});
  const recovery=generateRecoveryCodes();
  let secret:string;
  try{
    const factor=(await database.query('SELECT * FROM mfa_factors WHERE account_id=$1',[user.id])).rows[0];
    secret=decryptSecret(factor.secret_encrypted,Buffer.from(config.mfaEncryptionKey!,'base64'),user.id);
    await database.query('UPDATE mfa_factors SET recovery_hashes=$1::jsonb WHERE account_id=$2',[JSON.stringify(recovery.hashes),user.id]);
  }finally{await database.end();}
  const rotated=await request(url,'/api/auth/mfa/recovery-codes',{method:'POST',cookie,body:{password,code:recovery.codes[0]}});
  assert.equal(rotated.status,200,await rotated.clone().text());
  return {secret,recoveryCodes:(await rotated.json()).recoveryCodes as string[],cookie:responseCookie(rotated)};
}

async function mfaChallenge(url: string, email = adminEmail, password = adminPassword, newPassword?: string) {
  const response = await request(url, '/api/auth/login', { method: 'POST', body: { email, password, newPassword } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.getSetCookie().length, 0);
  const challenge = await response.json() as { mfaRequired: boolean; challengeToken: string; expiresAt: string };
  assert.equal(challenge.mfaRequired, true);
  assert.match(challenge.challengeToken, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(challenge.expiresAt) > Date.now());
  return challenge;
}

async function createReader(url: string, cookie: string, email = userEmail) {
  const response = await request(url, '/api/admin/users', { cookie, method: 'POST', body: { name: 'Leitor', email } });
  assert.equal(response.status, 201, await response.clone().text());
  const invitation = await response.json() as { path: string };
  const accepted = await request(url, '/api/invitations/accept', { method: 'POST', body: { token: invitation.path.split('#')[1], password: userPassword } });
  assert.equal(accepted.status, 201);
  const payload=await accepted.json();
  await completeEnrollment(url,payload);
  return {...payload.user,active:true,status:'active'};
}

test('rejects missing bootstrap credentials and never creates a default admin', async () => {
  const { databaseUrl, drop } = await createTestDatabase();
  try {
    await assert.rejects(() => createApp({ adminEmail: '', adminPassword, databaseUrl }), /ADMIN_EMAIL/);
    for (const password of ['', 'x', 'x'.repeat(14), 'x'.repeat(129)]) {
      await assert.rejects(() => createApp({ adminEmail, adminPassword: password, databaseUrl }), /ADMIN_PASSWORD/);
    }
    const minimum = await createApp({ adminEmail, adminPassword: 'x'.repeat(15), databaseUrl });
    await minimum.close();
  } finally { await drop(); }
});

test('protects API, documentation files and routes; uses a secure opaque session cookie', async () => {
  const app = await fixture();
  try {
    assert.equal((await request(app.url, '/api/auth/me')).status, 401);
    assert.equal((await request(app.url, '/api/admin/users')).status, 401);
    assert.equal((await request(app.url, '/docs-assets/sample-openapi.json')).status, 401);
    assert.equal((await request(app.url, '/docs-assets/index.html')).status, 401);
    for (const path of ['/docs', '/admin', '/']) {
      const response = await request(app.url, path);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/login');
    }
    assert.equal((await request(app.url, '/login')).status, 200);
    const { response, cookie } = await login(app.url, ' ADMIN@EXAMPLE.COM ');
    const setCookie = response.headers.getSetCookie().at(-1)!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(cookie, /^facet_session=[a-f0-9]{64}$/);
    assert.deepEqual(await response.json(), { user: { id: 'admin', name: 'adminstrador', email: adminEmail, role: 'admin' } });
    const authenticated = await request(app.url, '/api/auth/me', { cookie });
    assert.equal(authenticated.status, 200);
    assert.equal(authenticated.headers.get('cache-control'), 'no-store');
    assert.equal((await request(app.url, '/admin', { cookie })).status, 200);
    const documentation = await request(app.url, '/docs-assets/sample-openapi.json', { cookie });
    assert.equal(documentation.status, 200);
    assert.match(documentation.headers.get('cache-control')!, /no-store/);
    assert.deepEqual(await documentation.json(), { secretDocumentation: true });
    assert.equal((await request(app.url, '/login', { cookie })).headers.get('location'), '/docs');
    const logout = await request(app.url, '/api/auth/logout', { method: 'POST', cookie });
    assert.equal(logout.status, 204);
    assert.equal((await request(app.url, '/api/auth/me', { cookie })).status, 401);
  } finally { await app.dispose(); }
});

test('admin manages users; readers cannot access admin; all credential changes revoke sessions', async () => {
  const app = await fixture();
  try {
    const admin = await login(app.url);
    const user = await createReader(app.url, admin.cookie, ' Reader@Example.com ');
    assert.equal(user.email, userEmail);
    assert.equal(user.active, true);
    const reader = await login(app.url, userEmail, userPassword);
    assert.equal((await request(app.url, '/docs', { cookie: reader.cookie })).status, 200);
    assert.equal((await request(app.url, '/admin', { cookie: reader.cookie })).headers.get('location'), '/docs');
    assert.equal((await request(app.url, '/ADMIN', { cookie: reader.cookie })).headers.get('location'), '/docs');
    assert.equal((await request(app.url, '/api/admin/users', { cookie: reader.cookie })).status, 403);
    assert.equal((await request(app.url, '/api/admin/users', { cookie: reader.cookie, method: 'POST', body: { email: 'other@example.com', password: userPassword } })).status, 403);
    assert.equal((await request(app.url, `/api/admin/users/${user.id}`, { cookie: reader.cookie, method: 'PATCH', body: { active: false } })).status, 403);
    assert.equal((await request(app.url, `/api/admin/users/${user.id}`, { cookie: reader.cookie, method: 'DELETE' })).status, 403);
    const list = await request(app.url, '/api/admin/users', { cookie: admin.cookie });
    const users = (await list.json() as { users: Record<string, unknown>[] }).users;
    assert.equal(users.length, 2);
    assert.equal(users[0].id, 'admin');
    assert.equal(users[0].email, adminEmail);
    assert.equal(users[0].role, 'admin');
    assert.equal(users[0].name, 'adminstrador');
    assert.equal(users[1].name, 'Leitor');
    const nameUpdate = await request(app.url, `/api/admin/users/${user.id}`, { cookie: admin.cookie, method: 'PATCH', body: { name: '  Maria Silva  ' } });
    assert.equal(nameUpdate.status, 200);
    assert.equal((await nameUpdate.json()).user.name, 'Maria Silva');
    assert.equal((await (await request(app.url, '/api/auth/me', { cookie: reader.cookie })).json()).user.name, 'Maria Silva');
    assert.equal(users[0].active, true);
    assert.equal(users[1].email, userEmail);
    assert.ok(users[1].lastLoginAt);
    assert.equal('password_hash' in users[0], false);
    assert.equal('password' in users[0], false);
    const status = await request(app.url, `/api/admin/users/${user.id}`, { cookie: admin.cookie, method: 'PATCH', body: { active: false } });
    assert.equal(status.status, 200);
    assert.equal((await request(app.url, '/api/auth/me', { cookie: reader.cookie })).status, 401);
    assert.equal((await request(app.url, '/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } })).status, 401);
    assert.equal((await request(app.url, `/api/admin/users/${user.id}`, { cookie: admin.cookie, method: 'PATCH', body: { active: true } })).status, 200);
    const readerAgain = await login(app.url, userEmail, userPassword);
    assert.equal((await request(app.url, `/api/admin/users/${user.id}`, { cookie: admin.cookie, method: 'PATCH', body: { password: 'admin-defined' } })).status, 400);
    assert.equal((await request(app.url, `/api/admin/users/${user.id}`, { cookie: admin.cookie, method: 'PATCH', body: { email: 'new@example.com' } })).status, 200);
    assert.equal((await request(app.url, '/api/auth/me', { cookie: readerAgain.cookie })).status, 401);
    const renamed = await login(app.url, 'new@example.com', userPassword);
    assert.equal((await request(app.url, `/api/admin/users/${user.id}`, { cookie: admin.cookie, method: 'DELETE' })).status, 204);
    assert.equal((await request(app.url, '/api/auth/me', { cookie: renamed.cookie })).status, 401);
    assert.equal((await request(app.url, '/api/admin/users', { cookie: admin.cookie })).status, 200);
  } finally { await app.dispose(); }
});

test('validates user mutations, prevents duplicates and rejects cross-origin or malformed requests', async () => {
  const app = await fixture();
  try {
    const admin = await login(app.url);
    const user = await createReader(app.url, admin.cookie);
    for (const body of [{ name: 'Leitor', email: 'invalid' }, { name: 'Leitor', email: 'new@example.com', password: 'admin-defined' }, { email: 'new@example.com' }, { name: '   ', email: 'new@example.com' }, { name: 'x'.repeat(129), email: 'new@example.com' }]) {
      assert.equal((await request(app.url, '/api/admin/users', { method: 'POST', cookie: admin.cookie, body })).status, 400);
    }
    for (const email of [userEmail.toUpperCase(), adminEmail]) {
      assert.equal((await request(app.url, '/api/admin/users', { method: 'POST', cookie: admin.cookie, body: { name: 'Leitor', email } })).status, 409);
    }
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 12 }, { name: 'x'.repeat(129) }, { active: 'false' }, { password: '' }, { role: 'admin' }, { email: 'invalid' }]) {
      assert.equal((await request(app.url, `/api/admin/users/${user.id}`, { method: 'PATCH', cookie: admin.cookie, body })).status, 400);
    }
    const forbidden = await request(app.url, '/api/admin/users', { method: 'POST', cookie: admin.cookie, headers: { Origin: 'https://evil.example' }, body: { name: 'Novo', email: 'new@example.com' } });
    assert.equal(forbidden.status, 403);
    const crossSite = await request(app.url, '/api/auth/logout', { method: 'POST', cookie: admin.cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    const sameOrigin = await request(app.url, '/api/admin/users', { method: 'POST', cookie: admin.cookie, headers: { Origin: app.url }, body: { name: 'Novo', email: 'new@example.com' } });
    assert.equal(sameOrigin.status, 201);
    const invalidJson = await fetch(`${app.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(invalidJson.status, 400);
    const tooLarge = await request(app.url, '/api/auth/login', { method: 'POST', body: { email: 'a'.repeat(18000), password: userPassword } });
    assert.equal(tooLarge.status, 413);
    const form = await fetch(`${app.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `email=${adminEmail}&password=${adminPassword}` });
    assert.equal(form.status, 415);
    assert.equal((await request(app.url, '/api/auth/me', { cookie: admin.cookie })).status, 200);
  } finally { await app.dispose(); }
});

test('an in-flight login cannot undo access revocation or deletion from another app instance', async () => {
  const app = await fixture();
  const other = await listen(app.config);
  try {
    const admin = await login(app.url);
    const user = await createReader(app.url, admin.cookie);
    const pendingLogin = request(app.url, '/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
    await delay(10);
    assert.equal((await request(other.url, `/api/admin/users/${user.id}`, { cookie: admin.cookie, method: 'PATCH', body: { active: false } })).status, 200);
    assert.equal((await pendingLogin).status, 401);
    await request(other.url, `/api/admin/users/${user.id}`, { cookie: admin.cookie, method: 'PATCH', body: { active: true } });
    const deletedDuringLogin = request(app.url, '/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
    await delay(10);
    assert.equal((await request(other.url, `/api/admin/users/${user.id}`, { cookie: admin.cookie, method: 'DELETE' })).status, 204);
    assert.equal((await deletedDuringLogin).status, 401);
  } finally { await other.stop(); await app.dispose(); }
});

test('a failed user mutation rolls back the user update and preserves existing sessions', async () => {
  const app = await fixture();
  const database = new Pool({ connectionString: app.config.databaseUrl });
  try {
    const admin = await login(app.url);
    const user = await createReader(app.url, admin.cookie);
    const reader = await login(app.url, userEmail, userPassword);
    await database.query(`
      CREATE FUNCTION test_reject_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Intentional rollback fixture'; END $$;
      CREATE TRIGGER test_reject_session_delete BEFORE DELETE ON sessions
      FOR EACH ROW EXECUTE FUNCTION test_reject_session_delete();
    `);
    try {
      const failed = await request(app.url, `/api/admin/users/${user.id}`, {
        method: 'PATCH', cookie: admin.cookie, body: { name: 'Should roll back', active: false },
      });
      assert.equal(failed.status, 500);
      const stored = (await database.query('SELECT name, active FROM users WHERE id = $1', [user.id])).rows[0];
      assert.equal(stored.name, 'Leitor');
      assert.equal(stored.active, 1);
      assert.equal((await request(app.url, '/api/auth/me', { cookie: reader.cookie })).status, 200);
    } finally {
      await database.query('DROP TRIGGER test_reject_session_delete ON sessions; DROP FUNCTION test_reject_session_delete()');
    }
    assert.equal((await request(app.url, `/api/admin/users/${user.id}`, {
      method: 'PATCH', cookie: admin.cookie, body: { active: false },
    })).status, 200);
    assert.equal((await request(app.url, '/api/auth/me', { cookie: reader.cookie })).status, 401);
  } finally { await database.end(); await app.dispose(); }
});

test('a unique invitation can be accepted only once across app instances', async () => {
  const app = await fixture();
  const other = await listen(app.config);
  const database = new Pool({ connectionString: app.config.databaseUrl });
  try {
    const admin = await login(app.url);
    const created = await request(app.url, '/api/admin/users', {
      method: 'POST', cookie: admin.cookie, body: { name: 'Concurrent reader', email: userEmail },
    });
    assert.equal(created.status, 201);
    const { path } = await created.json() as { path: string };
    const body = { token: path.split('#')[1], password: userPassword };
    const responses = await Promise.all([
      request(app.url, '/api/invitations/accept', { method: 'POST', body }),
      request(other.url, '/api/invitations/accept', { method: 'POST', body }),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 410]);
    assert.equal(Number((await database.query('SELECT count(*) AS count FROM users WHERE email = $1', [userEmail])).rows[0].count), 1);
    assert.equal(Number((await database.query('SELECT count(*) AS count FROM invitations WHERE email = $1', [userEmail])).rows[0].count), 0);
    await login(other.url, userEmail, userPassword);
  } finally { await database.end(); await other.stop(); await app.dispose(); }
});

test('concurrent CMS updates across app instances preserve one revision winner', async () => {
  const app = await fixture();
  const other = await listen(app.config);
  try {
    const admin = await login(app.url);
    const page = (title: string) => [{ id: 'concurrent-page', title, slug: 'concurrent', group: 'Guides', markdown: `# ${title}`, published: true }];
    const responses = await Promise.all([
      request(app.url, '/api/admin/documentation/pages', { method: 'PUT', cookie: admin.cookie, body: { revision: 0, pages: page('First writer') } }),
      request(other.url, '/api/admin/documentation/pages', { method: 'PUT', cookie: admin.cookie, body: { revision: 0, pages: page('Second writer') } }),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const winner = await responses.find(response => response.status === 200)!.json();
    const saved = await (await request(other.url, '/api/admin/documentation/content', { cookie: admin.cookie })).json();
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.pages, winner.pages);
  } finally { await other.stop(); await app.dispose(); }
});

test('legacy short passwords require a verified upgrade and revoke previous sessions', async () => {
  const app = await fixture();
  try {
    const admin = await login(app.url);
    const user = await createReader(app.url, admin.cookie);
    const previous = await login(app.url, userEmail, userPassword);
    const database = new Pool({ connectionString: app.config.databaseUrl });
    try {
      const salt = randomBytes(16).toString('hex');
      const key = scryptSync('x', salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      await database.query('UPDATE users SET password_hash = $1 WHERE id = $2', [`scrypt$${salt}$${key.toString('hex')}`, user.id]);
      const sessionCount = async () => Number((await database.query('SELECT count(*) AS count FROM sessions')).rows[0].count);
      const countBefore = await sessionCount();
      const required = await request(app.url, '/api/auth/login', {
        method: 'POST', body: { email: userEmail, password: 'x' },
      });
      assert.equal(required.status, 409);
      assert.equal((await required.json()).code, 'PASSWORD_UPDATE_REQUIRED');
      assert.equal(required.headers.getSetCookie().some(value => /^facet_session=[a-f0-9]{64};/.test(value)), false);
      assert.equal(await sessionCount(), countBefore);
      assert.equal((await request(app.url, '/api/auth/login', {
        method: 'POST', body: { email: userEmail, password: 'incorrect', newPassword: userPassword },
      })).status, 401);
      assert.equal((await request(app.url, '/api/auth/login', {
        method: 'POST', body: { email: userEmail, password: 'x', newPassword: 'still-short' },
      })).status, 400);
      const upgraded = await request(app.url, '/api/auth/login', {
        method: 'POST', body: { email: userEmail, password: 'x', newPassword: userPassword },
      });
      assert.equal(upgraded.status, 200);
      const pending=await upgraded.json();
      assert.equal(pending.mfaRequired,true);
      const verified=await request(app.url,'/api/auth/mfa/verify',{method:'POST',body:{challengeToken:pending.challengeToken,code:await recoveryFor(app.url,userEmail)}});
      assert.equal(verified.status,200);
      assert.equal((await verified.json()).user.id,user.id);
      assert.equal((await request(app.url, '/api/auth/me', { cookie: previous.cookie })).status, 401);
      assert.equal((await request(app.url, '/api/auth/login', {
        method: 'POST', body: { email: userEmail, password: 'x' },
      })).status, 401);
      const current = await login(app.url, userEmail, userPassword);
      assert.equal((await request(app.url, '/api/auth/me', { cookie: current.cookie })).status, 200);
      const stored = (await database.query('SELECT password_hash FROM users WHERE id = $1', [user.id])).rows[0] as { password_hash: string };
      assert.notEqual(stored.password_hash, `scrypt$${salt}$${key.toString('hex')}`);
      assert.equal(stored.password_hash.includes(userPassword), false);
    } finally { await database.end(); }
  } finally { await app.dispose(); }
});

test('persists users and hashed sessions across restart; rotating admin env revokes previous admin sessions', async () => {
  const app = await fixture();
  let running: RunningApp = app;
  try {
    const admin = await login(running.url);
    const user = await createReader(running.url, admin.cookie);
    const reader = await login(running.url, userEmail, userPassword);
    await running.stop();
    const database = new Pool({ connectionString: app.config.databaseUrl });
    try {
      const stored = (await database.query('SELECT password_hash FROM users WHERE id = $1', [user.id])).rows[0] as { password_hash: string };
      assert.match(stored.password_hash, /^scrypt\$/);
      assert.ok(!stored.password_hash.includes(userPassword));
      assert.equal((await database.query('SELECT token_hash FROM sessions WHERE token_hash = $1', [reader.cookie.split('=')[1]])).rowCount, 0);
      const sessions = (await database.query('SELECT token_hash, admin_fingerprint FROM sessions')).rows;
      assert.equal(sessions.length, 2);
      for (const session of sessions) {
        assert.match(session.token_hash, /^[a-f0-9]{64}$/);
        assert.equal(JSON.stringify(session).includes(adminPassword), false);
        assert.equal(JSON.stringify(session).includes(userPassword), false);
      }
    } finally { await database.end(); }
    running = await listen(app.config);
    const persisted = await request(running.url, '/api/auth/me', { cookie: reader.cookie });
    assert.equal((await persisted.json()).user.name, 'Leitor');
    assert.equal((await request(running.url, '/api/auth/me', { cookie: reader.cookie })).status, 200);
    assert.equal((await request(running.url, '/api/auth/me', { cookie: admin.cookie })).status, 200);
    await running.stop();
    running = await listen({ ...app.config, adminPassword: 'rotated-admin-password-456' });
    assert.equal((await request(running.url, '/api/auth/me', { cookie: admin.cookie })).status, 401);
    assert.equal((await request(running.url, '/api/auth/me', { cookie: reader.cookie })).status, 200);
    const rotated = await login(running.url, adminEmail, 'rotated-admin-password-456');
    assert.equal((await request(running.url, '/api/admin/users', { cookie: rotated.cookie })).status, 200);
  } finally {
    await running.stop();
    await app.dropDatabase();
    await rm(app.directory, { recursive: true, force: true });
  }
});

test('expires server sessions and flags cookies Secure when configured', async () => {
  const app = await fixture({ sessionTtlMs: 30, secureCookies: true });
  try {
    const { response, cookie } = await login(app.url);
    assert.match(response.headers.getSetCookie().at(-1)!, /; Secure/);
    await delay(60);
    assert.equal((await request(app.url, '/api/auth/me', { cookie })).status, 401);
    assert.equal((await request(app.url, '/docs-assets/index.html', { cookie })).status, 401);
  } finally { await app.dispose(); }
});

test('HTTPS enforcement rejects cleartext credentials and trusts forwarded HTTPS only from configured proxies', async () => {
  const app = await fixture({ requireHttps: true, secureCookies: true, trustProxy: 1 });
  try {
    const clearPage = await request(app.url, '/login');
    assert.equal(clearPage.status, 426);
    assert.match(clearPage.headers.get('cache-control')!, /no-store/);
    const clearLogin = await request(app.url, '/api/auth/login', {
      method: 'POST', body: { email: adminEmail, password: adminPassword },
    });
    assert.equal(clearLogin.status, 426);
    assert.equal(clearLogin.headers.getSetCookie().length, 0);
    const httpsHeaders = { 'X-Forwarded-Proto': 'https' };
    const page = await request(app.url, '/login', { headers: httpsHeaders });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('strict-transport-security')!, /max-age=\d+/);
    const authenticated = await request(app.url, '/api/auth/login', {
      method: 'POST', headers: { ...httpsHeaders, Origin: app.url.replace('http:', 'https:') },
      body: { email: adminEmail, password: adminPassword },
    });
    assert.equal(authenticated.status, 200);
    assert.equal(authenticated.headers.getSetCookie().length,0);
    assert.equal((await authenticated.json()).mfaEnrollmentRequired,true);
  } finally { await app.dispose(); }
  const untrusted = await fixture({ requireHttps: true, secureCookies: true, trustProxy: false });
  try {
    const spoofed = await request(untrusted.url, '/login', { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(spoofed.status, 426);
    assert.equal(spoofed.headers.get('strict-transport-security'), null);
  } finally { await untrusted.dispose(); }
});

test('returns generic login errors and rate-limits repeated failures', async () => {
  const app = await fixture();
  try {
    const invalid = await request(app.url, '/api/auth/login', { method: 'POST', body: { email: 'absent@example.com', password: userPassword } });
    assert.equal(invalid.status, 401);
    const invalidError = await invalid.json();
    for (let index = 0; index < 8; index += 1) {
      const response = await request(app.url, '/api/auth/login', { method: 'POST', body: { email: adminEmail, password: 'wrong-password' } });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), invalidError);
    }
    const blocked = await request(app.url, '/api/auth/login', { method: 'POST', body: { email: adminEmail, password: adminPassword } });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  } finally { await app.dispose(); }
});

test('login failures follow the account across IP addresses and persist across restart', async () => {
  const fixtureApp = await fixture({ trustProxy: 1 });
  let running: RunningApp = fixtureApp;
  try {
    for (let index = 0; index < 8; index += 1) {
      const response = await request(running.url, '/api/auth/login', {
        method: 'POST', headers: { 'X-Forwarded-For': `192.0.2.${index + 1}` },
        body: { email: adminEmail, password: 'Incorrect audit password' },
      });
      assert.equal(response.status, 401);
    }
    const attempt = () => request(running.url, '/api/auth/login', {
      method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.1' },
      body: { email: adminEmail, password: adminPassword },
    });
    const blocked = await attempt();
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    await running.stop();
    running = await listen(fixtureApp.config);
    assert.equal((await attempt()).status, 429);
    assert.equal((await request(running.url, '/api/auth/login', {
      method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.1' },
      body: { email: 'different@example.com', password: userPassword },
    })).status, 401);
    const database = new Pool({ connectionString: fixtureApp.config.databaseUrl });
    try { await database.query('UPDATE rate_limits SET expires_at = $1', [Date.now() - 1]); }
    finally { await database.end(); }
    assert.equal((await attempt()).status, 200);
  } finally {
    await running.stop();
    await fixtureApp.dropDatabase();
    await rm(fixtureApp.directory, { recursive: true, force: true });
  }
});

test('successful logins do not exhaust account or shared-IP failure budgets', async () => {
  const app = await fixture();
  try {
    for (let index = 0; index < 65; index += 1) {
      const { cookie } = await login(app.url);
      assert.equal((await request(app.url, '/api/auth/logout', { method: 'POST', cookie })).status, 204);
    }
  } finally { await app.dispose(); }
});

test('bounds concurrent password derivations without an unbounded work queue', async () => {
  const app = await fixture();
  try {
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(app.url, '/api/auth/login', {
      method: 'POST', body: { email: adminEmail, password: adminPassword },
    })));
    assert.ok(responses.some(response => response.status === 200));
    assert.ok(responses.some(response => response.status === 503));
    for (const response of responses) {
      assert.ok([200, 503].includes(response.status), await response.clone().text());
      if (response.status === 503) {
        assert.ok(Number(response.headers.get('retry-after')) > 0);
        assert.equal(response.headers.getSetCookie().some(value => /^facet_session=[a-f0-9]{64};/.test(value)), false);
      }
    }
    await login(app.url);
  } finally { await app.dispose(); }
});

test('documentation branding requires admin writes, validates input and persists across restart', async () => {
  const fixtureApp = await fixture();
  let running: RunningApp = fixtureApp;
  try {
    assert.equal((await request(running.url, '/api/documentation/settings')).status, 401);
    const admin = await login(running.url);
    await createReader(running.url, admin.cookie);
    const reader = await login(running.url, userEmail, userPassword);
    const settings = { title: 'Minha API', logoUrl: 'https://example.com/logo.png' };
    assert.equal((await request(running.url, '/api/documentation/settings', { cookie: reader.cookie })).status, 200);
    assert.equal((await request(running.url, '/api/admin/documentation/settings', { method: 'PUT', cookie: reader.cookie, body: settings })).status, 403);
    for (const change of [{ title: null }, { title: '' }, { title: '   ' }, { title: 'x'.repeat(81) }, { lightColor: '#123456' }, { darkColor: '#abcdef' }, { logoUrl: 'javascript:alert(1)' }, { logoUrl: 'http://example.com/a.png' }, { logoUrl: 'https://user:pass@example.com/a.png' }]) {
      assert.equal((await request(running.url, '/api/admin/documentation/settings', { method: 'PUT', cookie: admin.cookie, body: { ...settings, ...change } })).status, 400);
    }
    assert.equal((await request(running.url, '/api/admin/documentation/settings', { method: 'PUT', cookie: admin.cookie, body: settings })).status, 200);
    await running.stop();
    running = await listen(fixtureApp.config);
    const result = await request(running.url, '/api/documentation/settings', { cookie: reader.cookie });
    assert.deepEqual((await result.json()).settings, settings);
    const blank = await request(running.url, '/api/admin/documentation/settings', { method: 'PUT', cookie: admin.cookie, body: { title: '   ', logoUrl: '' } });
    assert.equal(blank.status, 400);
    const omitted = await request(running.url, '/api/admin/documentation/settings', { method: 'PUT', cookie: admin.cookie, body: { logoUrl: '' } });
    assert.equal(omitted.status, 400);
    assert.equal((await (await request(running.url, '/api/documentation/settings', { cookie: reader.cookie })).json()).settings.title, 'Minha API');
  } finally {
    await running.stop();
    await fixtureApp.dropDatabase();
    await rm(fixtureApp.directory, { recursive: true, force: true });
  }
});

test('invitation links persist as hashes, are email-bound, expire, revoke and accept only once', async () => {
  const fixtureApp = await fixture();
  let running: RunningApp = fixtureApp;
  try {
    const admin = await login(running.url);
    await createReader(running.url, admin.cookie);
    const reader = await login(running.url, userEmail, userPassword);
    const invite = async (email: string) => {
      const response = await request(running.url, '/api/admin/users', { method: 'POST', cookie: admin.cookie, body: { name: 'Pessoa Convidada', email } });
      assert.equal(response.status, 201);
      return await response.json() as { invitation: { id: string; email: string }; path: string };
    };
    const inspect = (token: string) => request(running.url, '/api/invitations/inspect', { method: 'POST', body: { token } });
    const accept = (token: string) => request(running.url, '/api/invitations/accept', { method: 'POST', body: { token, name: 'Nome adulterado', password: userPassword, email: adminEmail, role: 'admin' } });
    assert.equal((await request(running.url, '/invite')).status, 200);
    assert.equal((await request(running.url, '/api/admin/invitations')).status, 401);
    assert.equal((await request(running.url, '/api/admin/users', { method: 'POST', cookie: reader.cookie, body: { name: 'Pessoa Convidada', email: 'invited@example.com' } })).status, 403);
    assert.equal((await request(running.url, '/api/admin/users', { method: 'POST', cookie: admin.cookie, body: { name: 'Pessoa Convidada', email: 'invalid' } })).status, 400);
    for (const email of [adminEmail, userEmail]) assert.equal((await request(running.url, '/api/admin/users', { method: 'POST', cookie: admin.cookie, body: { name: 'Pessoa Convidada', email } })).status, 409);
    assert.equal((await inspect('invalid')).status, 410);
    const first = await invite('Invited@Example.com');
    const second = await invite('invited@example.com');
    assert.equal((await inspect(first.path.split('#')[1])).status, 410);
    const token = second.path.split('#')[1];
    const accounts = await request(running.url, '/api/admin/users', { cookie: admin.cookie });
    const pendingAccount = (await accounts.json()).users.find((item: { email: string }) => item.email === 'invited@example.com');
    assert.equal(pendingAccount.status, 'pending');
    assert.equal(pendingAccount.active, false);
    assert.equal(pendingAccount.name, 'Pessoa Convidada');
    assert.equal('token_hash' in pendingAccount, false);
    const details = await inspect(token);
    assert.equal((await details.json()).invitation.name, 'Pessoa Convidada');
    assert.equal((await request(running.url, '/api/auth/login', { method: 'POST', body: { email: 'invited@example.com', password: 'x' } })).status, 401);
    assert.equal((await request(running.url, '/api/admin/invitations', { method: 'POST', cookie: admin.cookie, body: { email: 'legacy@example.com' } })).status, 404);
    const database = new Pool({ connectionString: fixtureApp.config.databaseUrl });
    try {
      const stored = (await database.query('SELECT token_hash FROM invitations WHERE id = $1', [second.invitation.id])).rows[0] as { token_hash: string };
      assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
      assert.notEqual(stored.token_hash, token);
    } finally { await database.end(); }
    const list = await request(running.url, '/api/admin/invitations', { cookie: admin.cookie });
    const listed = (await list.json()).invitations;
    assert.equal(listed.length, 1);
    assert.equal('token_hash' in listed[0], false);
    assert.equal('token' in listed[0], false);
    await running.stop();
    running = await listen(fixtureApp.config);
    assert.equal((await inspect(token)).status, 200);
    for (const password of ['', 'x', 'x'.repeat(14), 'x'.repeat(129)]) {
      assert.equal((await request(running.url, '/api/invitations/accept', { method: 'POST', body: { token, password } })).status, 400);
    }
    const responses = await Promise.all([accept(token), accept(token)]);
    assert.deepEqual(responses.map(item => item.status).sort(), [201, 429]);
    const created = await responses.find(item => item.status === 201)!.json();
    assert.equal(created.user.email, 'invited@example.com');
    assert.equal(created.user.name, 'Pessoa Convidada');
    assert.equal(created.user.role, 'user');
    assert.equal(created.user.status, 'mfa_pending');
    assert.equal(created.user.active,false);
    await completeEnrollment(running.url,created);
    const activatedAccounts = await request(running.url, '/api/admin/users', { cookie: admin.cookie });
    const activated = (await activatedAccounts.json()).users.filter((item: { email: string }) => item.email === 'invited@example.com');
    assert.equal(activated.length, 1);
    assert.equal(activated[0].status, 'active');
    assert.equal((await inspect(token)).status, 410);
    assert.equal((await accept(token)).status, 410);
    const invitedLogin = await login(running.url, 'invited@example.com', userPassword);
    assert.equal((await request(running.url, '/api/auth/me', { cookie: invitedLogin.cookie })).status, 200);
    const revoked = await invite('revoked@example.com');
    assert.equal((await request(running.url, `/api/admin/invitations/${revoked.invitation.id}`, { method: 'DELETE', cookie: reader.cookie })).status, 403);
    await request(running.url, `/api/admin/invitations/${revoked.invitation.id}`, { method: 'DELETE', cookie: admin.cookie });
    assert.equal((await accept(revoked.path.split('#')[1])).status, 410);
    const expired = await invite('expired@example.com');
    const db = new Pool({ connectionString: fixtureApp.config.databaseUrl });
    try { await db.query('UPDATE invitations SET expires_at = $1 WHERE id = $2', [Date.now() - 1, expired.invitation.id]); }
    finally { await db.end(); }
    assert.equal((await accept(expired.path.split('#')[1])).status, 410);
    const expiredAccounts = await request(running.url, '/api/admin/users', { cookie: admin.cookie });
    assert.equal((await expiredAccounts.json()).users.find((item: { email: string }) => item.email === 'expired@example.com').status, 'expired');
    const pending = await invite('pending@example.com');
    const pendingAcceptance = accept(pending.path.split('#')[1]);
    await delay(10);
    await request(running.url, `/api/admin/invitations/${pending.invitation.id}`, { method: 'DELETE', cookie: admin.cookie });
    assert.equal((await pendingAcceptance).status, 410);
  } finally {
    await running.stop();
    await fixtureApp.dropDatabase();
    await rm(fixtureApp.directory, { recursive: true, force: true });
  }
});

test('CMS content restricts writes, hides drafts, validates OpenAPI and persists after restart', async () => {
  const fixtureApp = await fixture();
  let running: RunningApp = fixtureApp;
  try {
    assert.equal((await request(running.url, '/api/documentation/content')).status, 401);
    const admin = await login(running.url);
    await createReader(running.url, admin.cookie);
    const reader = await login(running.url, userEmail, userPassword);
    const read = async () => (await (await request(running.url, '/api/admin/documentation/content', { cookie: admin.cookie })).json());
    const initial = await read();
    assert.equal(initial.pages.length, 4);
    const pages = [
      { id: 'published-page', title: '<img src=x onerror=alert(1)>', slug: 'start', group: 'Primeiros passos', markdown: '# Olá\n\n**Teste**\n\n<script>alert(1)</script>', published: true },
      { id: 'draft-page', title: 'Rascunho', slug: 'draft', group: 'Guias', markdown: 'Conteúdo privado do rascunho', published: false },
    ];
    const writePages = (body: unknown, cookie = admin.cookie) => request(running.url, '/api/admin/documentation/pages', { method: 'PUT', cookie, body });
    assert.equal((await writePages({ pages, revision: 0 }, reader.cookie)).status, 403);
    assert.equal((await writePages({ pages: [...pages, { ...pages[0], id: 'duplicate' }], revision: 0 })).status, 400);
    assert.equal((await writePages({ pages: [{ ...pages[0], slug: '" onmouseover="evil' }], revision: 0 })).status, 400);
    assert.equal((await writePages({ pages, revision: 0 })).status, 200);
    assert.equal((await writePages({ pages: [], revision: 0 })).status, 409);
    const published = await request(running.url, '/api/documentation/content', { cookie: reader.cookie });
    assert.equal((await published.json()).pages.length, 1);
    const source = 'openapi: 3.0.3\ninfo:\n  title: Test CMS API\n  version: "1.0"\nservers:\n  - url: https://example.com\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: OK\n';
    const importSpec = (source: string, cookie = admin.cookie) => request(running.url, '/api/admin/documentation/openapi', { method: 'PUT', cookie, body: { source, sourceName: 'my-api.yaml' } });
    assert.equal((await importSpec(source, reader.cookie)).status, 403);
    for (const bad of ['not an openapi', 'openapi: [', '{"openapi":"2.0","info":{},"paths":{}}', 'openapi: 3.0.3\ninfo: {title: Test, version: "1"}\npaths: {"/bad": {get: {responses: []}}}']) assert.equal((await importSpec(bad)).status, 400);
    assert.equal((await importSpec(source + '\n# ' + 'a'.repeat(20000))).status, 200);
    assert.equal((await importSpec(source + '\ninvalid: &cycle [*cycle]')).status, 400);
    assert.equal((await importSpec(source.replace('responses:', 'parameters: {}\n      responses:'))).status, 400);
    assert.equal((await importSpec('bad')).status, 400);
    const beforeRestart = await read();
    assert.equal(beforeRestart.openapi.spec.info.title, 'Test CMS API');
    assert.equal(beforeRestart.pages[1].published, false);
    await running.stop();
    running = await listen(fixtureApp.config);
    const afterRestart = await read();
    assert.equal(afterRestart.openapi.sourceName, 'my-api.yaml');
    assert.deepEqual(afterRestart.pages, pages);
    assert.equal(afterRestart.revision, 1);
    assert.equal((await writePages({ pages: [], revision: 1 })).status, 200);
    assert.deepEqual((await (await request(running.url, '/api/documentation/content', { cookie: reader.cookie })).json()).pages, []);
  } finally {
    await running.stop();
    await fixtureApp.dropDatabase();
    await rm(fixtureApp.directory, { recursive: true, force: true });
  }
});

test('mandatory MFA blocks login when enrollment cannot be configured',async()=>{
  const app=await fixture({mfaEncryptionKey:undefined});
  try{const response=await request(app.url,'/api/auth/login',{method:'POST',body:{email:adminEmail,password:adminPassword}});assert.ok([500,503].includes(response.status));assert.equal(response.headers.getSetCookie().length,0);assert.equal((await request(app.url,'/api/auth/me')).status,401);}finally{await app.dispose();}
});

test('admin must enroll before login and cannot disable mandatory MFA',async()=>{
  const app=await fixture();
  try{
    const response=await request(app.url,'/api/auth/login',{method:'POST',body:{email:adminEmail,password:adminPassword}});
    const enrollment=await response.json();assert.equal(enrollment.mfaEnrollmentRequired,true);assert.equal(response.headers.getSetCookie().length,0);
    assert.equal((await request(app.url,'/api/admin/users')).status,401);
    assert.equal((await request(app.url,'/api/auth/mfa/enrollment/confirm',{method:'POST',body:{enrollmentToken:enrollment.enrollmentToken,code:'invalid'}})).status,400);
    const completed=await completeEnrollment(app.url,enrollment);assert.equal(completed.recoveryCodes.length,10);
    const admin=await login(app.url);
    assert.equal((await request(app.url,'/api/auth/mfa/disable',{method:'POST',cookie:admin.cookie,body:{password:adminPassword,code:completed.recoveryCodes[0]}})).status,403);
  }finally{await app.dispose();}
});

test('MFA challenges and recovery codes are single-use across app instances', async () => {
  const app = await fixture({ mfaEncryptionKey });
  const other = await listen(app.config);
  try {
    const admin = await login(app.url);
    const enabled = await enableMfa(app.url, admin.cookie, adminPassword);
    const challenge = await mfaChallenge(app.url);
    const body = { challengeToken: challenge.challengeToken, code: enabled.recoveryCodes[0] };
    const responses = await Promise.all([
      request(app.url, '/api/auth/mfa/verify', { method: 'POST', body }),
      request(other.url, '/api/auth/mfa/verify', { method: 'POST', body }),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 401]);
    const second = await mfaChallenge(other.url);
    const reused = await request(app.url, '/api/auth/mfa/verify', { method: 'POST', body: { challengeToken: second.challengeToken, code: enabled.recoveryCodes[0] } });
    assert.equal(reused.status, 401);
    assert.equal(reused.headers.getSetCookie().length, 0);
    const fresh = await request(other.url, '/api/auth/mfa/verify', { method: 'POST', body: { challengeToken: second.challengeToken, code: enabled.recoveryCodes[1] } });
    assert.equal(fresh.status, 200);
    const rotated = await request(other.url, '/api/auth/mfa/recovery-codes', {
      method: 'POST', cookie: responseCookie(fresh), body: { password: adminPassword, code: enabled.recoveryCodes[2] },
    });
    assert.equal(rotated.status, 200);
    const newCodes = (await rotated.json()).recoveryCodes as string[];
    assert.equal(newCodes.length, 10);
    assert.equal((await request(app.url, '/api/auth/me', { cookie: enabled.cookie })).status, 401);
    const disabled = await request(app.url, '/api/auth/mfa/disable', {
      method: 'POST', cookie: responseCookie(rotated), body: { password: adminPassword, code: newCodes[0] },
    });
    assert.equal(disabled.status, 403);
    assert.equal((await request(app.url, '/api/auth/me', { cookie: responseCookie(rotated) })).status, 200);
    await login(app.url);
  } finally { await other.stop(); await app.dispose(); }
});

test('MFA rejects a challenge after five failures, expiry or account deactivation', async () => {
  const app = await fixture({ mfaEncryptionKey });
  const database = new Pool({ connectionString: app.config.databaseUrl });
  try {
    const admin = await login(app.url);
    const user = await createReader(app.url, admin.cookie);
    const reader = await login(app.url, userEmail, userPassword);
    const enabled = await enableMfa(app.url, reader.cookie, userPassword);
    const challenge = await mfaChallenge(app.url, userEmail, userPassword);
    const verify = (challengeToken: string, code: string) => request(app.url, '/api/auth/mfa/verify', { method: 'POST', body: { challengeToken, code } });
    for (let index = 0; index < 5; index += 1) assert.equal((await verify(challenge.challengeToken, 'invalid')).status, 401);
    assert.equal((await verify(challenge.challengeToken, enabled.recoveryCodes[0])).status, 401);
    const expired = await mfaChallenge(app.url, userEmail, userPassword);
    const hash = createHash('sha256').update(expired.challengeToken).digest('hex');
    await database.query('UPDATE mfa_challenges SET expires_at=$1 WHERE token_hash=$2', [Date.now() - 1, hash]);
    assert.equal((await verify(expired.challengeToken, enabled.recoveryCodes[0])).status, 401);
    const deactivated = await mfaChallenge(app.url, userEmail, userPassword);
    assert.equal((await request(app.url, `/api/admin/users/${user.id}`, { method: 'PATCH', cookie: admin.cookie, body: { active: false } })).status, 200);
    assert.equal((await verify(deactivated.challengeToken, enabled.recoveryCodes[0])).status, 401);
    assert.equal((await request(app.url, '/api/auth/me')).status, 401);
    assert.equal(Number((await database.query('SELECT count(*) AS count FROM sessions WHERE user_id=$1', [user.id])).rows[0].count), 0);
  } finally { await database.end(); await app.dispose(); }
});

test('legacy password upgrades with MFA commit only after the second factor succeeds', async () => {
  const app = await fixture({ mfaEncryptionKey });
  const database = new Pool({ connectionString: app.config.databaseUrl });
  try {
    const admin = await login(app.url);
    const user = await createReader(app.url, admin.cookie);
    const reader = await login(app.url, userEmail, userPassword);
    const enabled = await enableMfa(app.url, reader.cookie, userPassword);
    const salt = randomBytes(16).toString('hex');
    const key = scryptSync('x', salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const oldHash = `scrypt$${salt}$${key.toString('hex')}`;
    await database.query('UPDATE users SET password_hash=$1 WHERE id=$2', [oldHash, user.id]);
    const challenge = await mfaChallenge(app.url, userEmail, 'x', userPassword);
    const storedHash = async () => (await database.query('SELECT password_hash FROM users WHERE id=$1', [user.id])).rows[0].password_hash;
    assert.equal(await storedHash(), oldHash);
    assert.equal((await request(app.url, '/api/auth/mfa/verify', { method: 'POST', body: { challengeToken: challenge.challengeToken, code: 'invalid' } })).status, 401);
    assert.equal(await storedHash(), oldHash);
    const accepted = await request(app.url, '/api/auth/mfa/verify', { method: 'POST', body: { challengeToken: challenge.challengeToken, code: enabled.recoveryCodes[0] } });
    assert.equal(accepted.status, 200);
    assert.notEqual(await storedHash(), oldHash);
    assert.equal((await request(app.url, '/api/auth/me', { cookie: enabled.cookie })).status, 401);
    assert.equal((await request(app.url, '/api/auth/me', { cookie: responseCookie(accepted) })).status, 200);
    assert.equal((await request(app.url, '/api/auth/login', { method: 'POST', body: { email: userEmail, password: 'x' } })).status, 401);
    await mfaChallenge(app.url, userEmail, userPassword);
  } finally { await database.end(); await app.dispose(); }
});

test('successful MFA logins do not exhaust the failed-verification budget', async () => {
  const app = await fixture({ mfaEncryptionKey });
  try {
    const admin = await login(app.url);
    const enabled = await enableMfa(app.url, admin.cookie, adminPassword);
    for (let index = 0; index < 9; index += 1) {
      const challenge = await mfaChallenge(app.url);
      const verified = await request(app.url, '/api/auth/mfa/verify', {
        method: 'POST', body: { challengeToken: challenge.challengeToken, code: enabled.recoveryCodes[index] },
      });
      assert.equal(verified.status, 200, await verified.clone().text());
      const cookie = responseCookie(verified);
      assert.equal((await request(app.url, '/api/auth/me', { cookie })).status, 200);
      assert.equal((await request(app.url, '/api/auth/logout', { method: 'POST', cookie })).status, 204);
    }
  } finally { await app.dispose(); }
});

test('enabled MFA fails closed without the encryption key while recovery codes remain available', async () => {
  const app = await fixture({ mfaEncryptionKey });
  let withoutKey: RunningApp | undefined;
  try {
    const admin = await login(app.url);
    const enabled = await enableMfa(app.url, admin.cookie, adminPassword);
    withoutKey = await listen({ ...app.config, mfaEncryptionKey: undefined });
    assert.deepEqual(await (await request(withoutKey.url, '/api/auth/mfa', { cookie: enabled.cookie })).json(), { enabled: true, configured: false });
    const challenge = await mfaChallenge(withoutKey.url);
    const unavailable = await request(withoutKey.url, '/api/auth/mfa/verify', {
      method: 'POST', body: { challengeToken: challenge.challengeToken, code: createTotp(enabled.secret, 'Fixture').generate({ timestamp: Date.now() + 30_000 }) },
    });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.getSetCookie().length, 0);
    assert.equal((await request(withoutKey.url, '/api/auth/me')).status, 401);
    const recovered = await request(withoutKey.url, '/api/auth/mfa/verify', {
      method: 'POST', body: { challengeToken: challenge.challengeToken, code: enabled.recoveryCodes[0] },
    });
    assert.equal(recovered.status, 200);
    assert.equal((await request(withoutKey.url, '/api/auth/me', { cookie: responseCookie(recovered) })).status, 200);
  } finally { await withoutKey?.stop(); await app.dispose(); }
});

test('invited accounts stay inactive until mandatory TOTP confirmation; admin cannot bypass it',async()=>{
 const app=await fixture();const db=new Pool({connectionString:app.config.databaseUrl});
 try{
  const admin=await login(app.url);
  const invitation=await request(app.url,'/api/admin/users',{method:'POST',cookie:admin.cookie,body:{name:'Pending MFA',email:'pending-mfa@example.com'}});
  const {path}=await invitation.json();
  const acceptance=await request(app.url,'/api/invitations/accept',{method:'POST',body:{token:path.split('#')[1],password:userPassword}});
  assert.equal(acceptance.status,201);assert.equal(acceptance.headers.getSetCookie().length,0);
  const enrollment=await acceptance.json();assert.equal(enrollment.user.active,false);assert.equal(enrollment.user.status,'mfa_pending');assert.equal(enrollment.mfaEnrollmentRequired,true);
  const id=enrollment.user.id;
  assert.equal((await db.query('SELECT active FROM users WHERE id=$1',[id])).rows[0].active,0);
  assert.equal((await request(app.url,'/api/auth/me')).status,401);
  assert.equal((await request(app.url,`/api/admin/users/${id}`,{method:'PATCH',cookie:admin.cookie,body:{active:true}})).status,400);
  const resumed=await request(app.url,'/api/auth/login',{method:'POST',body:{email:'pending-mfa@example.com',password:userPassword}});
  assert.equal(resumed.headers.getSetCookie().length,0);const next=await resumed.json();assert.equal(next.mfaEnrollmentRequired,true);
  assert.equal((await request(app.url,'/api/auth/mfa/enrollment/confirm',{method:'POST',body:{enrollmentToken:enrollment.enrollmentToken,code:createTotp(enrollment.secret,'Fixture').generate()}})).status,410);
  await completeEnrollment(app.url,next);
  const active=(await db.query('SELECT active,mfa_pending FROM users WHERE id=$1',[id])).rows[0];assert.equal(active.active,1);assert.equal(active.mfa_pending,false);
  assert.equal((await request(app.url,'/api/auth/me')).status,401);
  const second=await mfaChallenge(app.url,'pending-mfa@example.com',userPassword);assert.equal(second.mfaRequired,true);
 }finally{await db.end();await app.dispose();}
});

test('expired or administratively deactivated MFA enrollments cannot activate an account',async()=>{
 const app=await fixture();const db=new Pool({connectionString:app.config.databaseUrl});
 try{
  const admin=await login(app.url);
  const invite=await request(app.url,'/api/admin/users',{method:'POST',cookie:admin.cookie,body:{name:'Expired enrollment',email:'expired-enrollment@example.com'}});
  const {path}=await invite.json();
  const response=await request(app.url,'/api/invitations/accept',{method:'POST',body:{token:path.split('#')[1],password:userPassword}});const setup=await response.json();
  await db.query('UPDATE mfa_enrollments SET expires_at=0 WHERE account_id=$1',[setup.user.id]);
  assert.equal((await request(app.url,'/api/auth/mfa/enrollment/confirm',{method:'POST',body:{enrollmentToken:setup.enrollmentToken,code:createTotp(setup.secret,'Fixture').generate()}})).status,410);
  const resumed=await request(app.url,'/api/auth/login',{method:'POST',body:{email:'expired-enrollment@example.com',password:userPassword}});const next=await resumed.json();
  assert.equal((await request(app.url,`/api/admin/users/${setup.user.id}`,{method:'PATCH',cookie:admin.cookie,body:{active:false}})).status,200);
  assert.equal((await request(app.url,'/api/auth/mfa/enrollment/confirm',{method:'POST',body:{enrollmentToken:next.enrollmentToken,code:createTotp(next.secret,'Fixture').generate()}})).status,410);
  assert.equal((await request(app.url,'/api/auth/login',{method:'POST',body:{email:'expired-enrollment@example.com',password:userPassword}})).status,401);
 }finally{await db.end();await app.dispose();}
});

test('existing accounts without MFA lose old sessions and must enroll before access', async () => {
  const app = await fixture();
  const db = new Pool({ connectionString: app.config.databaseUrl });
  let restarted: RunningApp | undefined;
  try {
    const admin = await login(app.url);
    const reader = await createReader(app.url, admin.cookie);
    const session = await login(app.url, userEmail, userPassword);
    await db.query('DELETE FROM mfa_factors WHERE account_id=$1', [reader.id]);
    assert.equal((await request(app.url, '/api/auth/me', { cookie: session.cookie })).status, 401);
    restarted = await listen(app.config);
    const stored = (await db.query('SELECT active,mfa_pending FROM users WHERE id=$1', [reader.id])).rows[0];
    assert.equal(stored.active, 0);
    assert.equal(stored.mfa_pending, true);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM sessions WHERE user_id=$1', [reader.id])).rows[0].count, 0);
    const response = await request(restarted.url, '/api/auth/login', { method: 'POST', body: { email: userEmail, password: userPassword } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.getSetCookie().length, 0);
    const enrollment = await response.json();
    assert.equal(enrollment.mfaEnrollmentRequired, true);
    await completeEnrollment(restarted.url, enrollment);
    assert.equal((await request(restarted.url, '/api/auth/me', { cookie: session.cookie })).status, 401);
    await mfaChallenge(restarted.url, userEmail, userPassword);
  } finally {
    await restarted?.stop();
    await db.end();
    await app.dispose();
  }
});
