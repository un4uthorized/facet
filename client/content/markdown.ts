import MarkdownIt from 'markdown-it';

// Raw HTML is text; markdown-it also rejects unsafe link protocols.
const renderer = new MarkdownIt({ html: false, breaks: false, linkify: false, typographer: false });
renderer.renderer.rules.table_open = () => '<div class="cms-table-scroll" role="region" aria-label="Tabela de documentação" tabindex="0"><table>\n';
renderer.renderer.rules.table_close = () => '</table></div>\n';
const fence = renderer.renderer.rules.fence!;
renderer.renderer.rules.fence = (tokens, index, options, env, self) => {
  const language = tokens[index].info.trim().split(/\s+/)[0].slice(0, 40);
  const labels: Record<string, string> = { js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript', json: 'JSON', yaml: 'YAML', yml: 'YAML', html: 'HTML', css: 'CSS', bash: 'Shell', sh: 'Shell', python: 'Python', sql: 'SQL' };
  const label = renderer.utils.escapeHtml(labels[language.toLowerCase()] || language || 'Código');
  return `<figure class="cms-code-block"><figcaption><span><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true"><path d="m5 4-4 4 4 4m6-8 4 4-4 4M9.5 2l-3 12" /></svg>${label}</span></figcaption>${fence(tokens, index, options, env, self)}</figure>\n`;
};
export function renderMarkdown(source: string): string { return renderer.render(source); }
