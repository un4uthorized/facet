import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { LogOut, Settings, ShieldCheck, UserRound } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { AuthUser } from '../types';
import layout from './layout.html?raw';
import { mountDocumentation } from './engine';
import '../../documentation/styles.css';
import './account.css';
import './schemas.css';
import { LoadingScreen } from '../components/LoadingScreen';

export default function Documentation({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [error, setError] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);

  useEffect(() => {
    document.title = 'Documentação da API';
    setSlot(document.getElementById('account-controls'));
    const controller = new AbortController();
    let cleanup: (() => void) | undefined;
    let disposed = false;
    mountDocumentation(controller.signal).then((dispose) => {
      if (disposed) dispose();
      else cleanup = dispose;
    }).catch(() => {
      if (!disposed) setError('Não foi possível carregar a documentação. Tente novamente.');
    }).finally(() => { if (!disposed) setEngineReady(true); });
    return () => { disposed = true; controller.abort(); cleanup?.(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api.documentationSettings(controller.signal).then(({ settings }) => {
      if (controller.signal.aborted) return;
      document.title = settings.title ? `${settings.title} — Documentação` : 'Documentação';
      const brand = document.querySelector('.sidebar .brand');
      const label = brand?.querySelector('span:last-child');
      if (label) label.remove();
      brand?.setAttribute('aria-label', settings.title ? `${settings.title} — início` : 'Início da documentação');
      const hasIdentity = Boolean(settings.logoUrl);
      brand?.classList.toggle('docs-brand-empty', !hasIdentity);
      if (brand instanceof HTMLElement) brand.tabIndex = hasIdentity ? 0 : -1;
      if (settings.logoUrl && brand) {
        const logo = document.createElement('img');
        logo.src = settings.logoUrl; logo.alt = ''; logo.className = 'docs-custom-logo'; logo.referrerPolicy = 'no-referrer';
        brand.prepend(logo);
      }
    }).catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setSettingsReady(true); });
    return () => { controller.abort(); };
  }, []);

  async function logout() {
    setLoggingOut(true);
    setLogoutError('');
    try { await onLogout(); }
    catch (failure) { setLogoutError(errorMessage(failure)); setLoggingOut(false); }
  }

  return <>
    <LoadingScreen active={!error && !(engineReady && settingsReady)} label="Abrindo documentação…" />
    <div className={`docs-stage${error || (engineReady && settingsReady) ? ' is-ready' : ''}`} inert={!error && !(engineReady && settingsReady)} aria-hidden={!error && !(engineReady && settingsReady)} aria-busy={!(engineReady && settingsReady)} dangerouslySetInnerHTML={{ __html: layout }} />
    {error && <div className="docs-boot-error" role="alert"><p>{error}</p><a href="/docs">Recarregar documentação</a></div>}
    {slot && createPortal(<details className="docs-account">
      <summary aria-label="Sua conta"><UserRound size={15} aria-hidden="true" /><span>{user.name}</span></summary>
      <div className="docs-account__menu">
        <div className="docs-account__identity"><strong>{user.name}</strong><span>{user.role === 'admin' ? 'Administrador' : 'Acesso à documentação'}</span></div>
        <a href="/account/security"><ShieldCheck size={14} aria-hidden="true" />Segurança da conta</a>
        {user.role === 'admin' && <a href="/admin"><Settings size={14} aria-hidden="true" />Administrar usuários</a>}
        <button onClick={logout} disabled={loggingOut}><LogOut size={14} aria-hidden="true" />{loggingOut ? 'Saindo…' : 'Sair da conta'}</button>
        {logoutError && <p role="alert">{logoutError}</p>}
      </div>
    </details>, slot)}
  </>;
}
