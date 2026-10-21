import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, Copy, Download, KeyRound, LoaderCircle, LogOut, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { AuthUser, MfaStatus } from '../types';
import { Brand } from '../components/Brand';
import { LoadingScreen } from '../components/LoadingScreen';
import { Modal } from '../components/Modal';
import { PasswordField } from '../components/PasswordField';
import { ThemeToggle } from '../components/ThemeToggle';
import './account-security.css';

type Action = 'regenerate' | 'codes' | null;

export function AccountSecurity({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [action, setAction] = useState<Action>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copyNotice, setCopyNotice] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    document.title = 'Segurança da conta';
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadError('');
    api.mfaStatus(controller.signal).then(result => {
      if (!controller.signal.aborted) setStatus(result);
    }).catch(failure => {
      if (!controller.signal.aborted) setLoadError(errorMessage(failure));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);

  function clearSecrets() {
    setPassword(''); setCode(''); setRecoveryCodes([]); setError(''); setCopyNotice('');
  }

  function open(next: Action) {
    clearSecrets(); setNotice(''); setAction(next);
  }

  function close() {
    if (busy) return;
    clearSecrets(); setAction(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setCopyNotice('');
    try {
      if (action === 'regenerate') {
        const result = await api.mfaRecoveryCodes(password, code);
        if (!mounted.current) return;
        clearSecrets(); setRecoveryCodes(result.recoveryCodes); setAction('codes'); setNotice('Novos códigos de recuperação gerados. Os anteriores não são mais válidos.');
      }
    } catch (failure) {
      if (mounted.current) { setError(errorMessage(failure)); setCode(''); }
    } finally { if (mounted.current) setBusy(false); }
  }

  async function copy(value: string, message: string) {
    setCopyNotice(''); setError('');
    try { await navigator.clipboard.writeText(value); if (mounted.current) setCopyNotice(message); }
    catch { if (mounted.current) setError('Não foi possível copiar. Selecione o texto e copie manualmente.'); }
  }

  function downloadCodes() {
    const blob = new Blob([`Códigos de recuperação — documentação\n\n${recoveryCodes.join('\n')}\n\nCada código permite um único acesso. Guarde este arquivo em um local seguro.\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'codigos-de-recuperacao.txt'; link.click(); URL.revokeObjectURL(url);
    setCopyNotice('Arquivo de recuperação baixado.');
  }

  async function logout() {
    setLoggingOut(true); setLoadError('');
    try { await onLogout(); }
    catch (failure) { if (mounted.current) { setLoadError(errorMessage(failure)); setLoggingOut(false); } }
  }

  const back = user.role === 'admin' ? '/admin' : '/docs';
  return <div className="workspace-shell account-security">
    <LoadingScreen active={loading} label="Carregando segurança da conta…" />
    <header className="workspace-header" inert={loading} aria-hidden={loading}><div className="workspace-header__inner"><Brand href={back} /><div className="workspace-header__actions"><a className="workspace-button workspace-button--quiet" href={back}><ArrowLeft />Voltar</a><ThemeToggle /><span className="workspace-header__divider" /><div className="workspace-account"><span>{user.name}</span><small>Sua conta</small></div><button className="workspace-icon-button" type="button" onClick={() => void logout()} disabled={loggingOut} aria-label="Sair da conta" title="Sair da conta">{loggingOut ? <LoaderCircle className="workspace-spin" /> : <LogOut />}</button></div></div></header>
    <main className="account-security__main" inert={loading} aria-hidden={loading}>
      <a className="account-security__back" href={back}><ArrowLeft size={14} />{user.role === 'admin' ? 'Administração' : 'Documentação'}</a>
      <div className="workspace-page-heading"><div><p className="workspace-eyebrow"><ShieldCheck size={14} /> SUA CONTA</p><h1>Segurança</h1><p>Gerencie a segunda verificação obrigatória da sua conta.</p></div></div>
      {loadError && <div className="workspace-page-error" role="alert">{loadError}<button className="workspace-button" onClick={() => setRetry(current => current + 1)}>Tentar novamente</button></div>}
      {notice && <div className="workspace-notice" role="status"><Check size={16} /><span>{notice}</span></div>}
      {status && <>
        <section className="security-card" aria-labelledby="mfa-heading"><div className="security-card__heading"><span className="security-card__icon"><Smartphone /></span><div><h2 id="mfa-heading">Autenticação em duas etapas</h2><p>Uma camada extra de proteção com um aplicativo autenticador.</p></div><span className={`security-status${status.enabled ? ' is-enabled' : ''}`}><i />{status.enabled ? 'Ativada' : 'Desativada'}</span></div>
          <div className="security-card__body"><p>{status.enabled ? 'Ao entrar, você informa sua senha e o código temporário gerado no seu aplicativo.' : 'Além da senha, seu acesso passa a exigir um código temporário gerado no seu celular. Você pode usar Google Authenticator, Microsoft Authenticator, 1Password ou outro aplicativo compatível.'}</p>
          {!status.configured && <p className="security-unavailable">A configuração está temporariamente indisponível. Entre em contato com o administrador.</p>}
          <div className="security-card__footer"><span><ShieldCheck size={15} />{status.enabled ? 'Sua conta tem uma segunda verificação.' : 'O MFA é obrigatório para acessar a documentação.'}</span><span className="security-required">Obrigatório</span></div></div>
        </section>
        <section className="security-card" aria-labelledby="recovery-heading"><div className="security-card__heading"><span className="security-card__icon"><KeyRound /></span><div><h2 id="recovery-heading">Códigos de recuperação</h2><p>Uma alternativa quando você estiver sem acesso ao autenticador.</p></div></div><div className="security-card__body"><p>{status.enabled ? 'Cada código pode ser utilizado uma única vez no lugar do código do aplicativo. Gere uma nova lista se perder seus códigos ou suspeitar que alguém teve acesso a eles.' : 'Seus códigos de recuperação serão exibidos ao concluir a ativação. Guarde-os em um local seguro, fora do celular que usa como autenticador.'}</p>{status.enabled && <div className="security-card__footer"><span>Os códigos anteriores serão substituídos.</span><button className="workspace-button" onClick={() => open('regenerate')} disabled={busy}><RefreshCw />Gerar novos códigos</button></div>}</div></section>
      </>}
    </main>
    {action && <Modal busy={busy} title={action === 'codes' ? 'Guarde seus códigos de recuperação' : 'Gerar novos códigos'} description={action === 'codes' ? 'Esta lista é exibida uma única vez. Salve os códigos antes de fechar.' : 'Sua nova lista substitui todos os códigos de recuperação anteriores.'} onClose={close}>
      {action === 'codes' ? <div className="security-recovery"><div className="security-recovery__note"><KeyRound size={16} /><p>Cada código permite um único acesso. Guarde-os em um gerenciador de senhas ou outro local seguro.</p></div><ul className="security-recovery__codes" aria-label="Códigos de recuperação">{recoveryCodes.map(item => <li key={item}><code>{item}</code></li>)}</ul><div className="security-recovery__actions"><button className="workspace-button" onClick={() => void copy(recoveryCodes.join('\n'), 'Códigos copiados.')}><Copy />Copiar códigos</button><button className="workspace-button" onClick={downloadCodes}><Download />Baixar arquivo</button></div>{error && <p className="workspace-error" role="alert">{error}</p>}{copyNotice && <p className="security-copy-notice" role="status">{copyNotice}</p>}<div className="workspace-modal__footer"><button className="workspace-button workspace-button--primary" onClick={close}>Concluir<Check /></button></div></div> : <form className="security-form" onSubmit={event => void submit(event)} aria-busy={busy}>
        <PasswordField id="mfa-password" label="Senha atual" value={password} onChange={setPassword} autoComplete="current-password" minLength={1} disabled={busy} /><div className="workspace-field"><label htmlFor="mfa-confirmation-code">Código do aplicativo ou de recuperação</label><input id="mfa-confirmation-code" value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code" maxLength={128} required disabled={busy} placeholder="Código de verificação" /></div>
        {error && <p className="workspace-error" role="alert">{error}</p>}{copyNotice && <p className="security-copy-notice" role="status">{copyNotice}</p>}
        <div className="workspace-modal__footer"><button className="workspace-button" type="button" onClick={close} disabled={busy}>Cancelar</button><button className="workspace-button workspace-button--primary" disabled={busy}>{busy ? <><LoaderCircle className="workspace-spin" />Aguarde…</> : 'Gerar novos códigos'}</button></div>
      </form>}
    </Modal>}
  </div>;
}
