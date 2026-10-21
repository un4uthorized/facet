import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle, LockKeyhole } from 'lucide-react';
import { api, ApiError, errorMessage } from '../api';
import type { AuthUser, MfaChallenge, MfaEnrollment } from '../types';
import { MandatoryMfa } from '../components/MandatoryMfa';
import { Brand } from '../components/Brand';
import { PasswordField } from '../components/PasswordField';
import { ThemeToggle } from '../components/ThemeToggle';

export function Login({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordUpdateRequired, setPasswordUpdateRequired] = useState(false);
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [code, setCode] = useState('');
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function resetLogin() {
    setEnrollment(null);
    setChallenge(null);
    setCode('');
    setRecoveryMode(false);
    setEmail('');
    setPassword('');
    setNewPassword('');
    setPasswordUpdateRequired(false);
    setError('');
  }

  useEffect(() => {
    if (!challenge) return;
    const timeout = window.setTimeout(() => {
      resetLogin();
      setError('A verificação expirou. Entre novamente para receber uma nova tentativa.');
    }, Math.max(0, Date.parse(challenge.expiresAt) - Date.now()));
  return () => window.clearTimeout(timeout);
  }, [challenge]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (challenge) {
        const result = await api.mfaVerify(challenge.challengeToken, code.trim());
        onLogin(result.user);
        return;
      }
      const result = await api.login(email.trim(), password, passwordUpdateRequired ? newPassword : undefined);
      if ('mfaEnrollmentRequired' in result) {
        setEnrollment(result); setEmail(''); setPassword(''); setNewPassword(''); setPasswordUpdateRequired(false);
      } else if ('mfaRequired' in result) {
        setChallenge(result);
        setCode('');
        setRecoveryMode(false);
        setEmail('');
        setPassword('');
        setNewPassword('');
        setPasswordUpdateRequired(false);
      } else onLogin(result.user);
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'PASSWORD_UPDATE_REQUIRED') setPasswordUpdateRequired(true);
      if (challenge) {
        setCode('');
        if (failure instanceof ApiError && (failure.status === 410 || failure.code === 'MFA_CHALLENGE_EXPIRED')) resetLogin();
      }
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

    if(enrollment) return <MandatoryMfa enrollment={enrollment} onComplete={()=>{resetLogin();setError('Autenticador cadastrado. Entre com sua senha e o código do app.');}} onBack={resetLogin} />;
  return (
    <div className="workspace-shell workspace-login">
      <header className="workspace-login__header"><Brand href="/login" /><ThemeToggle /></header>
      <main className="workspace-login__main">
        <div className="workspace-login__content">
          <span className="workspace-login__symbol" aria-hidden="true"><LockKeyhole /></span>
          <h1>{challenge ? 'Verifique sua identidade' : 'Acesse a documentação'}</h1>
          <p className="workspace-login__intro">{challenge
            ? recoveryMode ? 'Informe um dos códigos de recuperação que você salvou ao ativar a autenticação em duas etapas.' : 'Abra seu aplicativo autenticador e informe o código de seis dígitos.'
            : 'Entre com sua conta para explorar a API.'}</p>
          <form className="workspace-login__form" onSubmit={submit} aria-busy={busy}>
            {challenge ? <>
              <div className="workspace-field">
                <label htmlFor="login-mfa-code">{recoveryMode ? 'Código de recuperação' : 'Código de verificação'}</label>
                <input key={recoveryMode ? 'recovery' : 'totp'} id="login-mfa-code" name="code" type="text" value={code}
                  onChange={event => setCode(recoveryMode ? event.target.value : event.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode={recoveryMode ? 'text' : 'numeric'} autoComplete={recoveryMode ? 'off' : 'one-time-code'}
                  autoCapitalize={recoveryMode ? 'characters' : 'off'} spellCheck={false} required
                  minLength={recoveryMode ? 1 : 6} maxLength={recoveryMode ? 64 : 6}
                  pattern={recoveryMode ? undefined : '[0-9]{6}'} disabled={busy} autoFocus />
              </div>
            </> : <>
            <div className="workspace-field">
              <label htmlFor="login-email">E-mail</label>
              <input id="login-email" name="email" type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" placeholder="voce@empresa.com" required maxLength={254} disabled={busy} autoFocus />
            </div>
            <PasswordField id="login-password" value={password} onChange={setPassword} autoComplete="current-password" minLength={1} disabled={busy} />
            {passwordUpdateRequired && <PasswordField id="login-new-password" label="Nova senha" value={newPassword} onChange={setNewPassword} hint="Use de 15 a 128 caracteres." disabled={busy} />}
            </>}
            {error && <p className="workspace-error" role="alert">{error}</p>}
            <button className="workspace-button workspace-button--primary workspace-login__submit" type="submit" disabled={busy}>
              {busy ? <><LoaderCircle className="workspace-spin" /> {challenge ? 'Verificando…' : 'Entrando…'}</> : <>{challenge ? 'Verificar e entrar' : passwordUpdateRequired ? 'Atualizar senha e entrar' : 'Entrar'} <ArrowRight /></>}
            </button>
            {challenge && <>
              <button className="workspace-button workspace-button--quiet" type="button" disabled={busy} onClick={() => { setRecoveryMode(!recoveryMode); setCode(''); setError(''); }}>
                {recoveryMode ? 'Usar aplicativo autenticador' : 'Usar código de recuperação'}
              </button>
              <button className="workspace-button workspace-button--quiet" type="button" disabled={busy} onClick={resetLogin}>Voltar ao login</button>
            </>}
          </form>
          <p className="workspace-login__note">Precisa de acesso ou esqueceu sua senha?<br />Entre em contato com o administrador.</p>
        </div>
      </main>
      <footer className="workspace-login__footer"><LockKeyhole aria-hidden="true" /> Documentação com acesso restrito</footer>
    </div>
  );
}
