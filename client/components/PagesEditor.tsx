import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Bold, Check, Code, Eye, FileText, Italic, Link, List, LoaderCircle, Plus, Save, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { ContentPage } from '../types';
import { renderMarkdown } from '../content/markdown';
import { Modal } from './Modal';

const slugify = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
export function PagesEditor() {
  const [pages, setPages] = useState<ContentPage[]>([]);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState('[]');
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState(false);
  const [removing, setRemoving] = useState<ContentPage | null>(null);
  const [retry, setRetry] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const page = pages.find(item => item.id === selected);
  const dirty = JSON.stringify(pages) !== snapshot;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api.customizationContent(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setPages(result.pages); setSnapshot(JSON.stringify(result.pages)); setRevision(result.revision); setSelected(result.pages[0]?.id ?? '');
    }).catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function update(change: Partial<ContentPage>) {
    setPages(current => current.map(item => item.id === selected ? { ...item, ...change } : item)); setSaved(false);
  }
  function add() {
    const id = crypto.randomUUID();
    setPages(current => [...current, { id, title: '', slug: '', group: page?.group ?? 'Guias', markdown: '', published: false }]);
    setSelected(id); setSaved(false); setPreview(false);
  }
  function move(id: string, direction: number) {
    setPages(current => {
      const index = current.findIndex(item => item.id === id);
      const next = index + direction;
      if (next < 0 || next >= current.length) return current;
      const result = [...current]; [result[index], result[next]] = [result[next], result[index]]; return result;
    }); setSaved(false);
  }
  async function save() {
    if (busy || loading) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const result = await api.savePages(pages, revision);
      setPages(result.pages); setRevision(result.revision); setSnapshot(JSON.stringify(result.pages)); setSaved(true);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  function format(before: string, after = before, placeholder = 'texto') {
    if (!page || !textarea.current) return;
    const { selectionStart: start, selectionEnd: end } = textarea.current;
    const content = page.markdown.slice(start, end) || placeholder;
    update({ markdown: page.markdown.slice(0, start) + before + content + after + page.markdown.slice(end) });
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(start + before.length, start + before.length + content.length); });
  }
  return <div className="cms-pages">
    <header className="cms-section-heading"><div><h2>Páginas e menu</h2><p>Crie guias em Markdown e organize a navegação da documentação.</p></div><div className="cms-heading-actions">{dirty && <span className="cms-unsaved">Alterações não salvas</span>}{saved && <span className="cms-saved" role="status"><Check /> Páginas salvas.</span>}<button className="workspace-button workspace-button--primary" onClick={() => void save()} disabled={busy || loading || !dirty}>{busy ? <LoaderCircle className="workspace-spin" /> : <Save />}{busy ? 'Salvando…' : 'Salvar páginas'}</button></div></header>
    {error && <div className="workspace-page-error" role="alert">{error}{!pages.length && <button className="workspace-button" onClick={() => setRetry(value => value + 1)}>Tentar novamente</button>}</div>}
    {loading ? <p role="status">Carregando páginas…</p> : <div className="cms-pages-workspace">
      <aside className="cms-page-list" aria-label="Páginas do menu"><header><span>{pages.length} páginas</span><button className="workspace-icon-button" onClick={add} disabled={busy || pages.length >= 100} aria-label="Adicionar página" title="Adicionar página"><Plus /></button></header>
        <div className="cms-page-list-items">{pages.map((item, index) => <div key={item.id} className={selected === item.id ? 'is-selected' : undefined}><button className="cms-page-select" onClick={() => { setSelected(item.id); setPreview(false); }}><FileText /><span><strong>{item.title || 'Nova página'}</strong><small>{item.group} · {item.published ? 'Publicada' : 'Rascunho'}</small></span></button><div className="cms-page-order"><button className="workspace-icon-button" disabled={busy || index === 0} onClick={() => move(item.id, -1)} aria-label={`Mover ${item.title || 'página'} para cima`} title="Mover para cima"><ArrowUp /></button><button className="workspace-icon-button" disabled={busy || index === pages.length - 1} onClick={() => move(item.id, 1)} aria-label={`Mover ${item.title || 'página'} para baixo`} title="Mover para baixo"><ArrowDown /></button></div></div>)}</div>
        <footer><p>As páginas aparecem antes dos endpoints, agrupadas pelo nome da seção.</p><button className="workspace-button" onClick={add} disabled={busy || pages.length >= 100}><Plus /> Nova página</button></footer>
      </aside>
      {page ? <section className="cms-page-editor" aria-label="Editor da página"><fieldset disabled={busy}>
        <div className="cms-page-meta"><div className="workspace-field"><label htmlFor="page-title">Título da página</label><input id="page-title" value={page.title} maxLength={100} onChange={event => update({ title: event.target.value, ...(page.slug === slugify(page.title) ? { slug: slugify(event.target.value) } : {}) })} placeholder="Ex.: Primeiros passos" required /></div><div className="cms-page-meta-secondary"><div className="workspace-field"><label htmlFor="page-slug">Endereço da página</label><input id="page-slug" value={page.slug} maxLength={100} onChange={event => update({ slug: event.target.value })} placeholder="primeiros-passos" required /><small>/docs#guide-{page.slug || 'endereco'}</small></div><div className="workspace-field"><label htmlFor="page-group">Grupo no menu</label><input id="page-group" list="page-groups" value={page.group} maxLength={60} onChange={event => update({ group: event.target.value })} required /><datalist id="page-groups">{[...new Set(pages.map(item => item.group))].map(group => <option key={group} value={group} />)}</datalist></div></div></div>
        <div className="cms-editor-toolbar"><div><button type="button" title="Negrito" aria-label="Inserir negrito" disabled={preview} onClick={() => format('**')}><Bold /></button><button type="button" title="Itálico" aria-label="Inserir itálico" disabled={preview} onClick={() => format('*')}><Italic /></button><button type="button" title="Link" aria-label="Inserir link" disabled={preview} onClick={() => format('[', '](https://exemplo.com)')}><Link /></button><button type="button" title="Lista" aria-label="Inserir lista" disabled={preview} onClick={() => format('\n- ', '\n', 'Item da lista')}><List /></button><button type="button" title="Bloco de código" aria-label="Inserir código" disabled={preview} onClick={() => format('\n```\n', '\n```\n', 'seu código')}><Code /></button></div><button type="button" className={preview ? 'is-active' : undefined} aria-pressed={preview} onClick={() => setPreview(value => !value)}><Eye /> Prévia</button></div>
        {preview ? <div className="cms-page-preview cms-markdown" role="region" aria-label="Prévia da página"><h1>{page.title || 'Nova página'}</h1><div dangerouslySetInnerHTML={{ __html: renderMarkdown(page.markdown) }} /></div> : <textarea ref={textarea} className="cms-markdown-editor" aria-label="Conteúdo em Markdown" spellCheck={false} value={page.markdown} maxLength={100000} onChange={event => update({ markdown: event.target.value })} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void save(); } }} placeholder={'## Comece por aqui\n\nEscreva sua documentação em **Markdown**.\n\n- Guias e tutoriais\n- Tabelas e exemplos\n- Blocos de código'} />}
        <div className="cms-editor-footer"><label><input type="checkbox" checked={page.published} onChange={event => update({ published: event.target.checked })} />Exibir na documentação</label><button className="workspace-icon-button workspace-icon-button--danger" onClick={() => setRemoving(page)} title="Excluir página" aria-label="Excluir página"><Trash2 /></button></div>
      </fieldset></section> : <div className="cms-panel cms-empty"><FileText /><h3>Conte a história da sua API</h3><p>Adicione a primeira página para criar guias e introduções.</p><button className="workspace-button" onClick={add}><Plus /> Nova página</button></div>}
    </div>}
    {removing && createPortal(<Modal title="Excluir página?" description={`“${removing.title || 'Nova página'}” será removida do menu quando você salvar as páginas.`} compact onClose={() => setRemoving(null)}><div className="workspace-modal__footer"><button className="workspace-button" onClick={() => setRemoving(null)}>Cancelar</button><button className="workspace-button workspace-button--danger" onClick={() => { const remaining = pages.filter(item => item.id !== removing.id); setPages(remaining); if (selected === removing.id) setSelected(remaining[0]?.id ?? ''); setSaved(false); setRemoving(null); }}>Excluir página</button></div></Modal>, document.querySelector('.workspace-shell') ?? document.body)}
  </div>;
}
