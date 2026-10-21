import { useEffect, useState, type FormEvent } from 'react';
import { Check, LoaderCircle, Save } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { DocumentationSettings as Settings } from '../types';

export function DocumentationSettings({ onLogoSaved }: { onLogoSaved: (logoUrl: string) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api.documentationSettings(controller.signal).then(result => setSettings(result.settings)).catch(failure => {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    });
    return () => controller.abort();
  }, [retry]);
  function change(key: keyof Settings, value: string) {
    setSettings(current => current && { ...current, [key]: value });
    setSaved(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!settings || busy) return;
    setBusy(true); setError(''); setSaved(false);
    try { const result = await api.saveDocumentationSettings(settings); setSettings(result.settings); onLogoSaved(result.settings.logoUrl); setSaved(true); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <>

    {error && <div className="workspace-page-error" role="alert">{error}{!settings && <button className="workspace-button" onClick={() => { setError(''); setRetry(value => value + 1); }}>Tentar novamente</button>}</div>}
    {!settings ? !error && <p role="status">Carregando configurações…</p> : <form onSubmit={save} className="workspace-settings-grid">
      <div className="workspace-settings-card">
        <h2>Marca e aparência</h2><p>As alterações salvas serão exibidas para todos os usuários.</p>
        <fieldset disabled={busy}>
          <div className="workspace-field"><label htmlFor="docs-title">Nome da documentação</label><input id="docs-title" value={settings.title} onChange={event => change('title', event.target.value)} required maxLength={80} /><small>Usado no título da aba do navegador. Não aparece no menu lateral.</small></div>
          <div className="workspace-field"><label htmlFor="docs-logo">URL do logo</label><input id="docs-logo" type="url" value={settings.logoUrl} onChange={event => change('logoUrl', event.target.value)} placeholder="https://sua-empresa.com/logo.png" maxLength={2048} /><small>Use uma imagem em HTTPS. Opcional. Sem logo, o topo do menu lateral fica sem marca.</small></div>
        </fieldset>
        <div className="workspace-settings-save"><button className="workspace-button workspace-button--primary" disabled={busy} type="submit">{busy ? <LoaderCircle className="workspace-spin" /> : <Save />}{busy ? 'Salvando…' : 'Salvar alterações'}</button>{saved && <span role="status"><Check /> Configurações salvas.</span>}</div>
      </div>
      <div className="workspace-settings-preview"><p className="workspace-eyebrow">Prévia da identidade</p>{(['light', 'dark'] as const).map(theme => <div key={theme} className={`workspace-brand-preview ${theme}`}><small>Tema {theme === 'light' ? 'claro' : 'escuro'}</small><div>{settings.logoUrl && <img src={settings.logoUrl} alt="Logo" referrerPolicy="no-referrer" />}{!settings.logoUrl && <span className="workspace-brand-preview-empty">Sem logo</span>}</div><span>Visão geral</span><p>Endpoints e referências da sua API.</p><i /></div>)}<small>A prévia acompanha as alterações. Salve para aplicar na documentação.</small></div>
    </form>}
  </>;
}
