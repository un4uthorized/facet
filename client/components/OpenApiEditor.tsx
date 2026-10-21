import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, FileCode2, LoaderCircle, Upload } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { ImportedOpenApi } from '../types';

export function OpenApiEditor() {
  const [current, setCurrent] = useState<ImportedOpenApi | null>(null);
  const [source, setSource] = useState('');
  const [sourceName, setSourceName] = useState('openapi.yaml');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.customizationContent(controller.signal).then(result => setCurrent(result.openapi))
      .catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  async function readFile(file?: File) {
    if (!file) return;
    setError(''); setSaved(false);
    if (file.size > 2 * 1024 * 1024) { setError('Selecione um arquivo de até 2 MB.'); return; }
    try { setSource(await file.text()); setSourceName(file.name); }
    catch { setError('Não foi possível ler o arquivo.'); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setSaved(false);
    try { const result = await api.importOpenApi(source, sourceName); setCurrent(result.openapi); setSource(''); setSaved(true); if (fileRef.current) fileRef.current.value = ''; }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  const operationCount = current ? Object.values(current.spec.paths).reduce((sum, item) => sum + Object.keys(item).filter(key => ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(key)).length, 0) : 0;
  return <div className="cms-openapi-grid">
    <form className="cms-panel" onSubmit={save}>
      <header><span className="cms-panel-icon"><Upload /></span><div><h2>Importar especificação</h2><p>Transforme seu OpenAPI em uma referência navegável.</p></div></header>
      <fieldset disabled={busy || loading}>
        <div className="cms-upload"><FileCode2 /><strong>Escolha seu arquivo OpenAPI</strong><span>JSON ou YAML · OpenAPI 3.0 e 3.1 · Até 2 MB</span><input ref={fileRef} type="file" accept=".json,.yaml,.yml,application/json,text/yaml" aria-label="Arquivo OpenAPI" onChange={event => void readFile(event.target.files?.[0])} /></div>
        <div className="workspace-field"><label htmlFor="openapi-source">Ou cole o conteúdo</label><textarea id="openapi-source" className="cms-source" spellCheck={false} value={source} onChange={event => { setSource(event.target.value); setSaved(false); }} placeholder={'openapi: 3.0.3\ninfo:\n  title: Minha API\n  version: 1.0.0\npaths: {}'} /></div>
      </fieldset>
      {error && <p className="workspace-error" role="alert">{error}</p>}
      <footer><button className="workspace-button workspace-button--primary" disabled={busy || loading || !source.trim()}>{busy ? <LoaderCircle className="workspace-spin" /> : <Upload />}{busy ? 'Importando…' : 'Publicar OpenAPI'}</button>{saved && <span className="cms-saved" role="status"><Check /> OpenAPI publicado.</span>}</footer>
      <p className="cms-hint">A publicação substitui a referência atual para todos os usuários. As páginas em Markdown são preservadas.</p>
    </form>
    <aside className="cms-panel cms-current-spec"><header><span className="cms-panel-icon"><FileCode2 /></span><div><h2>Referência publicada</h2><p>A especificação usada na documentação.</p></div></header>{loading ? <p role="status">Carregando…</p> : current ? <><strong className="cms-api-title">{current.spec.info.title}</strong><dl><div><dt>Versão da API</dt><dd>{current.spec.info.version}</dd></div><div><dt>OpenAPI</dt><dd>{current.spec.openapi}</dd></div><div><dt>Endpoints</dt><dd>{operationCount}</dd></div><div><dt>Arquivo</dt><dd>{current.sourceName}</dd></div><div><dt>Publicado em</dt><dd>{new Date(current.updatedAt).toLocaleString('pt-BR')}</dd></div></dl></> : <div className="cms-empty"><FileCode2 /><h3>Sua API começa aqui</h3><p>A documentação usa uma especificação de exemplo até você publicar a sua.</p></div>}</aside>
  </div>;
}
