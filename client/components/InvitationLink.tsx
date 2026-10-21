import { useState } from 'react';
import { Copy, Link } from 'lucide-react';

export function InvitationLink({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const link = new URL(path, window.location.origin).href;
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setError(''); }
    catch { setError('Selecione o link e copie manualmente.'); }
  }
  return <div className="workspace-invite-link">
    <div className="workspace-field"><label htmlFor="invitation-link"><Link /> Link do convite</label><input id="invitation-link" value={link} readOnly onFocus={event => event.target.select()} /></div>
    <button className="workspace-button" type="button" onClick={() => void copy()}><Copy /> {copied ? 'Copiado' : 'Copiar link'}</button>
    <p>Compartilhe com o usuário para ele criar a própria senha. O link vale por 7 dias, permite um único uso e só é exibido ao gerar.</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
