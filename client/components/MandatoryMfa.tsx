import { useState, type FormEvent } from 'react';
import { ArrowRight, Check, Copy, Download, LoaderCircle, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { MfaEnrollment } from '../types';
import { Brand } from './Brand';
import { ThemeToggle } from './ThemeToggle';
import '../pages/account-security.css';

export function MandatoryMfa({enrollment,onComplete,onBack}:{enrollment:MfaEnrollment;onComplete:()=>void;onBack?:()=>void}) {
  const [code,setCode]=useState('');
  const [codes,setCodes]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  async function confirm(event:FormEvent){
    event.preventDefault();if(busy)return;
    setBusy(true);setError('');
    try{const result=await api.mfaEnrollmentConfirm(enrollment.enrollmentToken,code);setCodes(result.recoveryCodes);setCode('');}
    catch(failure){setError(errorMessage(failure));setCode('');}
    finally{setBusy(false);}
  }
  async function copy(){try{await navigator.clipboard.writeText(codes.join('\n'));setNotice('Códigos copiados.');}catch{setError('Selecione os códigos e copie manualmente.');}}
  function download(){const url=URL.createObjectURL(new Blob([codes.join('\n')],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='codigos-de-recuperacao.txt';link.click();URL.revokeObjectURL(url);setNotice('Arquivo baixado.');}
  return <div className="workspace-shell workspace-login">
    <header className="workspace-login__header"><Brand href="/login"/><ThemeToggle/></header>
    <main className="mandatory-mfa">
      <span className="workspace-login__symbol"><ShieldCheck/></span>
      <p className="workspace-eyebrow">{codes.length?'Cadastro concluído':'Etapa 2 de 2 · obrigatória'}</p>
      <h1>{codes.length?'Guarde seus códigos de recuperação':'Cadastre seu autenticador'}</h1>
      <p>{codes.length?'Sua conta está ativa. Salve estes códigos antes de continuar. Cada código permite um único acesso.':'Sua senha foi definida, mas a conta permanece inativa até confirmar o autenticador.'}</p>
      {codes.length ? <>
        <ul className="security-recovery__codes">{codes.map(value=><li key={value}><code>{value}</code></li>)}</ul>
        <div className="security-recovery__actions"><button className="workspace-button" onClick={()=>void copy()}><Copy/>Copiar códigos</button><button className="workspace-button" onClick={download}><Download/>Baixar arquivo</button></div>
        <button className="workspace-button workspace-button--primary mandatory-mfa__continue" onClick={()=>{setCodes([]);onComplete();}}>Guardei os códigos<Check/></button>
      </> : <form onSubmit={event=>void confirm(event)} aria-busy={busy}>
        <div className="security-setup"><img className="security-setup__qr" src={enrollment.qrCode} alt="QR code para configurar o aplicativo autenticador"/><div className="security-setup__manual"><h3>Leia o QR code com seu aplicativo</h3><p>Você também pode inserir esta chave manualmente, na opção baseada em tempo.</p><div className="security-setup__secret"><code>{enrollment.secret}</code></div><small>Se o cadastro expirar, entre com sua senha para retomá-lo. Nenhum acesso é liberado antes da confirmação.</small></div></div>
        <div className="workspace-field"><label htmlFor="enrollment-code">Código do aplicativo</label><input id="enrollment-code" value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,'').slice(0,6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required disabled={busy} autoFocus/></div>
        <button className="workspace-button workspace-button--primary mandatory-mfa__continue" disabled={busy}>{busy?<><LoaderCircle className="workspace-spin"/>Confirmando…</>:<>Confirmar autenticador e ativar<ArrowRight/></>}</button>
        {onBack&&<button className="workspace-button workspace-button--quiet" type="button" disabled={busy} onClick={onBack}>Voltar ao login</button>}
      </form>}
      {error&&<p className="workspace-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    </main>
  </div>;
}
