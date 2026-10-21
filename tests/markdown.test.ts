import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../client/content/markdown.js';

test('Markdown renders content while treating HTML as text and rejecting executable links', () => {
  const html = renderMarkdown('# Guia\n\n**Negrito** e `código`.\n\n- Um\n- Dois\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[clique](javascript:alert(1))\n\n![x](data:text/html,evil)');
  assert.match(html, /<h1>Guia<\/h1>/);
  assert.match(html, /<strong>Negrito<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('src="data:text/html'));
});
