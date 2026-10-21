import { useId, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { ManagedUser } from '../types';
import { Modal } from './Modal';
import { InvitationLink } from './InvitationLink';

interface UserEditorProps {
  user: ManagedUser | null;
  onClose: () => void;
  onSaved: (user: ManagedUser) => void;
  onCreated: () => void;
}

export function UserEditor({ user, onClose, onSaved, onCreated }: UserEditorProps) {
  const id = useId();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [active, setActive] = useState(user?.active ?? true);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (user) {
        const result = await api.updateUser(user.id, { name: name.trim(), email: email.trim(), active });
        onSaved(result.user);
      } else {
        const result = await api.createUser({ name: name.trim(), email: email.trim() });
        setPath(result.path);
        onCreated();
      }
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <Modal title={path ? 'Convite criado' : user ? 'Editar usuário' : 'Novo usuário'} description={user ? 'Atualize os dados e as permissões de acesso.' : 'Defina nome e e-mail. O usuário cria a própria senha pelo link de convite.'} onClose={onClose} busy={busy}>
    <form onSubmit={submit} className="workspace-user-form" aria-busy={busy}>
      <div className="workspace-modal__body">
        <div className="workspace-field"><label htmlFor={`${id}-name`}>Nome</label><input id={`${id}-name`} name="name" value={name} onChange={event => setName(event.target.value)} autoComplete="name" required maxLength={128} disabled={busy} readOnly={Boolean(path)} /></div>
        <div className="workspace-field"><label htmlFor={`${id}-email`}>E-mail</label><input id={`${id}-email`} name="email" type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="off" required maxLength={254} disabled={busy} readOnly={Boolean(path)} /></div>
        {path && <InvitationLink path={path} />}
        {user && <label className="workspace-access-toggle"><span><strong>Acesso à documentação</strong><span>Desative para bloquear o acesso deste usuário.</span></span><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} disabled={busy} /><span className="workspace-switch" aria-hidden="true" /></label>}
        {error && <p className="workspace-error" role="alert">{error}</p>}
      </div>
      <div className="workspace-modal__footer"><button className="workspace-button" type="button" onClick={onClose} disabled={busy}>{path ? 'Concluir' : 'Cancelar'}</button>{!path && <button className="workspace-button workspace-button--primary" type="submit" disabled={busy}>{busy && <LoaderCircle className="workspace-spin" />}{busy ? 'Salvando…' : user ? 'Salvar alterações' : 'Criar usuário'}</button>}</div>
    </form>
  </Modal>;
}
