export interface SnippetLanguage { id: string; label: string; group: string }
export interface RequestSnippet {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | null;
}


export const languages: SnippetLanguage[] = [
    { id: 'curl', label: 'cURL', group: 'Linha de comando' },
    { id: 'httpie', label: 'HTTPie', group: 'Linha de comando' },
    { id: 'wget', label: 'Wget', group: 'Linha de comando' },
    { id: 'javascript', label: 'JavaScript · Fetch', group: 'JavaScript' },
    { id: 'node', label: 'Node.js · Fetch', group: 'JavaScript' },
    { id: 'python', label: 'Python · Requests', group: 'Outras linguagens' },
    { id: 'go', label: 'Go · net/http', group: 'Outras linguagens' },
    { id: 'php', label: 'PHP · cURL', group: 'Outras linguagens' },
    { id: 'powershell', label: 'PowerShell', group: 'Outras linguagens' }
  ];

  const quote = JSON.stringify;
  const shellQuote = (value: unknown) => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const phpQuote = (value: unknown) => "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  const psQuote = (value: unknown) => "'" + String(value).replace(/'/g, "''") + "'";
  const continuation = (parts: string[]) => parts.join(' \\\n  ');

export function generate(language: string, request: RequestSnippet): string {
    const method = request.method.toUpperCase();
    const url = request.url;
    const headers = Object.fromEntries(Object.entries(request.headers || {}).map(([name, value]) => [name, String(value)]));
    const body = ['GET', 'HEAD'].includes(method) || request.body == null ? null : String(request.body);
    const entries = Object.entries(headers);

    switch (language) {
      case 'curl':
        return continuation(['curl --request ' + method, '--url ' + shellQuote(url)]
          .concat(entries.map(([name, value]) => '--header ' + shellQuote(name + ': ' + value)))
          .concat(body === null ? [] : ['--data-raw ' + shellQuote(body)]));

      case 'httpie': {
        const command = continuation(['http' + (body === null ? ' --ignore-stdin' : '') + ' ' + method + ' ' + shellQuote(url)]
          .concat(entries.map(([name, value]) => shellQuote(name + ':' + value))));
        return body === null ? command : "printf '%s' " + shellQuote(body) + ' | ' + command;
      }

      case 'wget':
        return continuation(['wget --quiet --output-document=-', '--method=' + method]
          .concat(entries.map(([name, value]) => '--header=' + shellQuote(name + ': ' + value)))
          .concat(body === null ? [] : ['--body-data=' + shellQuote(body)])
          .concat([shellQuote(url)]));

      case 'javascript':
      case 'node': {
        const options: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
        if (body !== null) options.body = body;
        const lines = ['async function main() {',
          '  const response = await fetch(' + quote(url) + ', ' + JSON.stringify(options, null, 2).split('\n').join('\n  ') + ');',
          '', '  console.log(response.status);', '  console.log(await response.text());',
          '}', '', 'main().catch(console.error);'];
        return (language === 'node' ? '// Node.js 18+\n' : '') + lines.join('\n');
      }

      case 'python':
        return ['# pip install requests', 'import requests', '',
          'headers = ' + JSON.stringify(headers, null, 2), '',
          'response = requests.request(', '    ' + quote(method) + ',',
          '    ' + quote(url) + ',', '    headers=headers,']
          .concat(body === null ? [] : ['    data=' + quote(body) + '.encode("utf-8"),'])
          .concat([')', '', 'print(response.status_code)', 'print(response.text)']).join('\n');

      case 'go': {
        const lines = ['package main', '', 'import (']
          .concat(body === null ? [] : ['    "strings"'])
          .concat(['    "fmt"', '    "io"', '    "net/http"', ')', '', 'func main() {']);
        if (body !== null) lines.push('    body := strings.NewReader(' + quote(body) + ')');
        lines.push('    req, err := http.NewRequest(' + quote(method) + ', ' + quote(url) + ', ' + (body === null ? 'nil' : 'body') + ')',
          '    if err != nil { panic(err) }');
        entries.forEach(([name, value]) => lines.push('    req.Header.Set(' + quote(name) + ', ' + quote(value) + ')'));
        return lines.concat(['', '    resp, err := http.DefaultClient.Do(req)',
          '    if err != nil { panic(err) }', '    defer resp.Body.Close()', '',
          '    data, err := io.ReadAll(resp.Body)', '    if err != nil { panic(err) }', '',
          '    fmt.Println(resp.Status)', '    fmt.Println(string(data))', '}']).join('\n');
      }

      case 'php':
        return ['<?php', '', '$curl = curl_init();', 'curl_setopt_array($curl, [',
          '    CURLOPT_URL => ' + phpQuote(url) + ',',
          '    CURLOPT_RETURNTRANSFER => true,',
          '    CURLOPT_CUSTOMREQUEST => ' + phpQuote(method) + ',',
          '    CURLOPT_HTTPHEADER => [']
          .concat(entries.map(([name, value]) => '        ' + phpQuote(name + ': ' + value) + ','))
          .concat(['    ],'])
          .concat(body === null ? [] : ['    CURLOPT_POSTFIELDS => ' + phpQuote(body) + ','])
          .concat([']);', '', '$response = curl_exec($curl);',
            'if ($response === false) {', '    throw new RuntimeException(curl_error($curl));', '}',
            '', 'echo $response;', 'curl_close($curl);']).join('\n');

      case 'powershell': {
        const contentType = entries.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
        const lines = ['$headers = @{']
          .concat(entries.filter(([name]) => name.toLowerCase() !== 'content-type').map(([name, value]) => '    ' + psQuote(name) + ' = ' + psQuote(value)))
          .concat(['}', '']);
        if (body !== null) lines.push('$body = ' + psQuote(body), '');
        const command = ['$response = Invoke-RestMethod', '-Method ' + psQuote(method), '-Uri ' + psQuote(url), '-Headers $headers'];
        if (contentType) command.push('-ContentType ' + psQuote(contentType));
        if (body !== null) command.push('-Body ([System.Text.Encoding]::UTF8.GetBytes($body))');
        return lines.concat([command.join(' '), '', '$response | ConvertTo-Json -Depth 20']).join('\n');
      }

      default:
        throw new RangeError('Unsupported request snippet: ' + language);
    }
  }

