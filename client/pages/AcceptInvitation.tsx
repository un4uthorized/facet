import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Check, Link, LoaderCircle } from 'lucide-react';
import { MandatoryMfa } from '../components/MandatoryMfa';
import type { MfaEnrollment } from '../types';
import { api, errorMessage } from '../api';
import { Brand } from '../components/Brand';
import { PasswordField } from '../components/PasswordField';
import { ThemeToggle } from '../components/ThemeToggle';

export function AcceptInvitation() {
  const [token, setToken] = useState(() => window.location.hash.slice(1));
  const [invitation, setInvitation] = useState<{ name: string; email: string; expiresAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [complete, setComplete] = useState(false);
  useEffect(() => {
    const changed = () => setToken(window.location.hash.slice(1));
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    setLoading(true); setError(''); setInvitation(null); setEnrollment(null); setComplete(false); setPassword('');
    const controller = new AbortController();
    api.inspectInvitation(token, controller.signal).then(result => setInvitation(result.invitation))
      .catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token]);
  async function accept(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await api.acceptInvitation(token, password);
      setPassword(''); setEnrollment(result);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  if(enrollment) return <MandatoryMfa enrollment={enrollment} onComplete={()=>{setEnrollment(null);setComplete(true);window.history.replaceState(null,'','/invite');}} />;
  return <div className="workspace-shell workspace-login">
    <header className="workspace-login__header"><Brand href="/login" /><ThemeToggle /></header>
    <main className="workspace-login__main"><div className="workspace-login__content">
      <span className="workspace-login__symbol" aria-hidden="true">{complete ? <Check /> : <Link />}</span>
      <h1>{complete ? 'Sua conta está pronta' : 'Você foi convidado'}</h1>
      <p className="workspace-login__intro">{complete ? 'Entre com seu e-mail e a senha que você acabou de criar.' : 'Defina sua senha. Em seguida, cadastre seu autenticador para ativar a conta.'}</p>
      {loading ? <p role="status">Verificando convite…</p> : complete ? <a className="workspace-button workspace-button--primary" href="/login">Ir para o login <ArrowRight /></a> : <>
        {invitation && <form className="workspace-login__form" onSubmit={accept} aria-busy={busy}>
          <div className="workspace-field"><label htmlFor="invite-email">E-mail</label><input id="invite-email" type="email" value={invitation.email} readOnly /></div>
          <div className="workspace-field"><label htmlFor="invite-name">Nome</label><input id="invite-name" value={invitation.name} readOnly /></div>
          <PasswordField id="invite-password" value={password} onChange={setPassword} hint="Use de 15 a 128 caracteres." disabled={busy} />
          <button className="workspace-button workspace-button--primary workspace-login__submit" disabled={busy}>{busy ? <><LoaderCircle className="workspace-spin" /> Criando…</> : <>Continuar para o autenticador <ArrowRight /></>}</button>
          <p className="workspace-login__note">Convite válido até {new Date(invitation.expiresAt).toLocaleString('pt-BR')}.</p>
        </form>}
        {error && <p className="workspace-error" role="alert">{error}</p>}
        {!invitation && <p className="workspace-login__note">Peça um novo link ao administrador.<br /><a href="/login">Ir para o login</a></p>}
      </>}
    </div></main>
  </div>;
}
