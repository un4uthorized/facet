import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronRight, LockKeyhole, Palette, Check, CircleAlert, ExternalLink, LoaderCircle, LogOut, Pause, Pencil, Play, Plus, RefreshCw, Search, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { AuthUser, ManagedUser } from '../types';
import { Brand } from '../components/Brand';
import { Modal } from '../components/Modal';
import { ThemeToggle } from '../components/ThemeToggle';
import { Customization } from './Customization';
import { InvitationLink } from '../components/InvitationLink';
import { UserEditor } from '../components/UserEditor';

type Filter = 'all' | 'active' | 'inactive' | 'pending';
const awaitingActivation = (user: ManagedUser) => user.status === 'pending' || user.status === 'expired';

const dateFormatter = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short' });

function DateCell({ value, empty = '—' }: { value: string | null; empty?: string }) {
  if (!value) return <span className="workspace-date workspace-date--empty">{empty}</span>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="workspace-date">—</span>;
  return <time className="workspace-date" dateTime={value} title={dateTimeFormatter.format(date)}>{dateFormatter.format(date)}</time>;
}

export function Admin({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const section = ['documentation', 'customization'].includes(new URLSearchParams(window.location.search).get('section') ?? '') ? 'customization' : 'users';
  const [logoUrl, setLogoUrl] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api.documentationSettings(controller.signal).then(result => {
      if (!controller.signal.aborted) setLogoUrl(result.settings.logoUrl);
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  const [invitationPath, setInvitationPath] = useState('');
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editor, setEditor] = useState<{ user: ManagedUser | null } | null>(null);
  const [removing, setRemoving] = useState<ManagedUser | null>(null);
  const [removeError, setRemoveError] = useState('');
  const [removeBusy, setRemoveBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const result = await api.listUsers(signal);
      if (!signal?.aborted) setUsers(result.users);
    } catch (failure) {
      if (!signal?.aborted) setError(errorMessage(failure));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const activeCount = users.filter(item => item.status === 'active').length;
  const inactiveCount = users.filter(item => item.status === 'inactive').length;
  const pendingCount = users.filter(item=>awaitingActivation(item)||item.status==='mfa_pending').length;
  const filteredUsers = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return users.filter(item => (filter === 'all' || (filter === 'pending' ? (awaitingActivation(item)||item.status==='mfa_pending') : item.status === filter)) && (!term || (item.email.toLocaleLowerCase().includes(term) || item.name.toLocaleLowerCase().includes(term))));
  }, [users, query, filter]);

  function saved(savedUser: ManagedUser) {
    setUsers(current => current.map(item => item.id === savedUser.id ? savedUser : item));
    setEditor(null);
    setNotice('Alterações salvas.');
  }

  async function toggleAccess(target: ManagedUser) {
    if (busyId) return;
    setBusyId(target.id);
    setError('');
    try {
      const result = await api.updateUser(target.id, { active: !target.active });
      setUsers(current => current.map(item => item.id === target.id ? result.user : item));
      setNotice(result.user.active ? `Acesso de ${target.email} reativado.` : `Acesso de ${target.email} desativado.`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusyId(null);
    }
  }

  async function remove() {
    if (!removing || removeBusy) return;
    setRemoveBusy(true);
    setRemoveError('');
    try {
      if (awaitingActivation(removing)) await api.revokeInvitation(removing.id);
      else await api.deleteUser(removing.id);
      setUsers(current => current.filter(item => item.id !== removing.id));
      setRemoving(null);
      setNotice(awaitingActivation(removing) ? 'Convite revogado.' : 'Usuário removido.');
    } catch (failure) {
      setRemoveError(errorMessage(failure));
    } finally {
      setRemoveBusy(false);
    }
  }

  async function regenerateInvitation(target: ManagedUser) {
    if (busyId) return;
    setBusyId(target.id); setError('');
    try {
      const result = await api.createUser({ name: target.name, email: target.email });
      setInvitationPath(result.path);
      await load();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusyId(null); }
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try { await onLogout(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setLoggingOut(false); }
  }

  const noMatches = users.length > 0;

  return (
    <div className="workspace-shell workspace-admin">
      <aside className="workspace-admin-sidebar">
        {logoUrl ? <a className="workspace-admin-logo" href="/admin" aria-label="Administração"><img src={logoUrl} alt="Logo" referrerPolicy="no-referrer" /></a> : <Brand href="/admin" />}
        <div className="workspace-sidebar-space"><span className="workspace-space-symbol"><LockKeyhole /></span><span><strong>Workspace privado</strong><small>Gerenciamento de acesso</small></span></div><p className="workspace-sidebar-label">Administração</p>
        <nav aria-label="Administração">
          <a href="/admin" aria-current={section === 'users' ? 'page' : undefined}><Users /><span>Usuários</span><ChevronRight className="workspace-nav-chevron" /></a>
          <a href="/admin?section=customization" aria-current={section === 'customization' ? 'page' : undefined}><Palette /><span>Customização</span><ChevronRight className="workspace-nav-chevron" /></a>
        </nav>
        <div className="workspace-sidebar-bottom"><a href="/docs"><BookOpen /> Abrir documentação <ArrowUpRight /></a><div className="workspace-sidebar-security"><ShieldCheck /><span>Acesso protegido<small>Somente pessoas convidadas</small></span></div></div>
      </aside>
      <div className="workspace-admin-content">
      <header className="workspace-header">
        <div className="workspace-header__inner">
          <span className="workspace-admin-breadcrumb">Administração <span>/</span> <strong>{section === 'users' ? 'Usuários' : 'Customização'}</strong></span>
          <div className="workspace-header__actions">
            <a className="workspace-icon-button" href="/account/security" aria-label="Segurança da conta" title="Segurança da conta"><ShieldCheck /></a>
            <a className="workspace-button workspace-button--quiet workspace-docs-link" href="/docs">Documentação <ArrowUpRight /></a>
            <ThemeToggle />
            <span className="workspace-header__divider" />
            <div className="workspace-account"><span>{user.name}</span><small>Administrador</small></div><span className="workspace-account-avatar" aria-hidden="true">{user.name.charAt(0).toUpperCase()}</span>
            <button className="workspace-icon-button" type="button" onClick={() => void logout()} disabled={loggingOut} aria-label="Sair da conta" title="Sair da conta">{loggingOut ? <LoaderCircle className="workspace-spin" /> : <LogOut />}</button>
          </div>
        </div>
      </header>

      <main className="workspace-main">
        {section === 'customization' ? <Customization onLogoSaved={setLogoUrl} /> : <>
        <div className="workspace-page-heading">
          <div><p className="workspace-eyebrow">Seu workspace, sua equipe</p><h1>Usuários</h1><p>Controle acessos e convide as pessoas da sua equipe.</p></div>
          <div className="workspace-heading-actions"><button className="workspace-button workspace-button--primary" type="button" onClick={() => setEditor({ user: null })} disabled={loading} data-dialog-fallback><Plus /> Novo usuário</button></div>
        </div>

        <div className="workspace-summary" aria-label="Resumo de usuários">
          <div><span>Total de usuários</span><strong>{users.length.toString().padStart(2, '0')}</strong><small>Pessoas no workspace</small></div>
          <div><span><i className="is-active" />Ativos</span><strong>{activeCount.toString().padStart(2, '0')}</strong><small>Acesso à documentação</small></div>
          <div><span><i className="is-pending" />Aguardando ativação</span><strong>{pendingCount.toString().padStart(2, '0')}</strong><small>Convites para sua equipe</small></div>
          <div><span><i className="is-inactive" />Inativos</span><strong>{inactiveCount.toString().padStart(2, '0')}</strong><small>Acesso desativado</small></div>
        </div>

        {notice && <div className="workspace-notice" role="status"><Check aria-hidden="true" /><span>{notice}</span><button className="workspace-icon-button" type="button" onClick={() => setNotice('')} aria-label="Fechar aviso"><X /></button></div>}
        {error && <div className="workspace-page-error" role="alert"><CircleAlert aria-hidden="true" /><span>{error}</span></div>}

        <section className="workspace-users" aria-label="Lista de usuários" aria-busy={loading}>
          <div className="workspace-users-heading"><div><h2>Pessoas e permissões</h2><p>Todos os usuários, em um só lugar.</p></div><span className="workspace-members-count">{users.length} {users.length === 1 ? 'pessoa' : 'pessoas'}</span></div>
          <div className="workspace-list-toolbar">
            <div className="workspace-filter" role="group" aria-label="Filtrar por acesso">
              {([{ value: 'all', label: 'Todos' }, { value: 'active', label: 'Ativos' }, { value: 'inactive', label: 'Inativos' }, { value: 'pending', label: 'Aguardando ativação' }] as const).map(item => <button type="button" key={item.value} className={filter === item.value ? 'is-active' : undefined} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)} aria-label={item.label}>{item.label}<span>{item.value === 'all' ? users.length : item.value === 'active' ? activeCount : item.value === 'inactive' ? inactiveCount : pendingCount}</span></button>)}
            </div>
            <div className="workspace-list-toolbar__actions">
              <div className="workspace-search"><Search aria-hidden="true" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar por nome ou e-mail…" aria-label="Buscar usuários por nome ou e-mail" /></div>
              <button className="workspace-icon-button" type="button" onClick={() => void load()} disabled={loading || Boolean(busyId)} aria-label="Atualizar usuários" title="Atualizar usuários"><RefreshCw className={loading ? 'workspace-spin' : undefined} /></button>
            </div>
          </div>

          {loading ? <div className="workspace-empty" role="status"><LoaderCircle className="workspace-spin" /><p>Carregando usuários…</p></div> : filteredUsers.length ? (
            <div className="workspace-table-scroll">
              <table className="workspace-user-table">
                <thead><tr><th scope="col">Usuário</th><th scope="col">Status</th><th scope="col" className="workspace-column-last-login">Último acesso</th><th scope="col" className="workspace-column-created">Criado em</th><th scope="col"><span className="workspace-sr-only">Ações</span></th></tr></thead>
                <tbody>{filteredUsers.map(item => <tr key={item.id}>
                  <td><div className="workspace-user-identity"><span className="workspace-avatar" aria-hidden="true">{item.name.charAt(0).toUpperCase()}</span><span className="workspace-user-email"><strong>{item.name}{item.role === 'admin' && <small className="workspace-admin-tag">Administrador</small>}</strong><span>{item.email}</span></span></div></td>
                  <td><span className={`workspace-access-status is-${item.status}`} title={item.invitationExpiresAt ? `Convite válido até ${dateTimeFormatter.format(new Date(item.invitationExpiresAt))}` : undefined}><i aria-hidden="true" />{item.status === 'mfa_pending' ? 'MFA pendente' : item.status === 'pending' ? 'Aguardando ativação' : item.status === 'expired' ? 'Convite expirado' : item.active ? 'Ativo' : 'Inativo'}</span></td>
                  <td className="workspace-column-last-login"><DateCell value={item.lastLoginAt} empty={item.role === 'admin' ? '—' : 'Ainda não acessou'} /></td>
                  <td className="workspace-column-created"><DateCell value={item.createdAt} /></td>
                  <td>{item.role === 'admin' ? <span className="workspace-managed-account" title="E-mail e senha configurados no ambiente do servidor"><LockKeyhole aria-hidden="true" /><span>Gerenciado pelo ambiente</span></span> : <div className="workspace-row-actions">
                    {awaitingActivation(item) ? <>
                      <button className="workspace-icon-button" type="button" onClick={() => void regenerateInvitation(item)} disabled={Boolean(busyId)} aria-label={`Gerar novo link para ${item.email}`} title="Gerar novo link">{busyId === item.id ? <LoaderCircle className="workspace-spin" /> : <RefreshCw />}</button>
                      <button className="workspace-icon-button workspace-icon-button--danger" type="button" onClick={() => { setRemoveError(''); setRemoving(item); }} disabled={Boolean(busyId)} aria-label={`Revogar convite de ${item.email}`} title="Revogar convite"><Trash2 /></button>
                    </> : <>
                    <button className="workspace-icon-button" type="button" onClick={() => setEditor({ user: item })} disabled={Boolean(busyId)} aria-label={`Editar ${item.email}`} title="Editar usuário"><Pencil /></button>
                    {item.status !== 'mfa_pending' && <button className="workspace-icon-button" type="button" onClick={() => void toggleAccess(item)} disabled={Boolean(busyId)} aria-label={`${item.active ? 'Desativar' : 'Reativar'} acesso de ${item.email}`} title={item.active ? 'Desativar acesso' : 'Reativar acesso'}>{busyId === item.id ? <LoaderCircle className="workspace-spin" /> : item.active ? <Pause /> : <Play />}</button>}
                    <button className="workspace-icon-button workspace-icon-button--danger" type="button" onClick={() => { setRemoveError(''); setRemoving(item); }} disabled={busyId === item.id} aria-label={`Remover ${item.email}`} title="Remover usuário"><Trash2 /></button>
                    </>}
                  </div>}</td>
                </tr>)}</tbody>
              </table>
            </div>
          ) : <div className="workspace-empty"><Users aria-hidden="true" /><h2>{noMatches ? 'Nenhum usuário encontrado' : error ? 'Não foi possível carregar os usuários' : 'Seu primeiro usuário começa aqui'}</h2><p>{noMatches ? 'Tente outro e-mail ou altere o filtro de acesso.' : error ? 'Atualize a lista para tentar novamente.' : 'Adicione as pessoas que podem consultar a documentação.'}</p>{noMatches ? <button className="workspace-button" type="button" onClick={() => { setQuery(''); setFilter('all'); }}>Limpar filtros</button> : error ? <button className="workspace-button" type="button" onClick={() => void load()}><RefreshCw /> Tentar novamente</button> : <button className="workspace-button" type="button" onClick={() => setEditor({ user: null })}><Plus /> Criar usuário</button>}</div>}

          {!loading && filteredUsers.length > 0 && <div className="workspace-table-footer"><span>{filteredUsers.length} {filteredUsers.length === 1 ? 'usuário' : 'usuários'}{filteredUsers.length !== users.length ? ` de ${users.length}` : ''}</span><span><ShieldCheck aria-hidden="true" /> Acesso restrito a usuários ativos</span></div>}
        </section>

        </>}
        <footer className="workspace-admin-footer"><span>Administração</span><a href="/docs">Abrir documentação <ExternalLink /></a></footer>
      </main>

      </div>
      {editor && <UserEditor user={editor.user} onClose={() => { setEditor(null); void load(); }} onSaved={saved} onCreated={() => void load()} />}
      {invitationPath && <Modal title="Novo link de convite" description="O link anterior foi invalidado. Compartilhe este novo link com o usuário." onClose={() => setInvitationPath('')}><div className="workspace-modal__body"><InvitationLink path={invitationPath} /></div><div className="workspace-modal__footer"><button className="workspace-button" onClick={() => setInvitationPath('')}>Concluir</button></div></Modal>}
      {removing && <Modal title={awaitingActivation(removing) ? 'Revogar convite?' : 'Remover usuário?'} description={awaitingActivation(removing) ? 'O link de convite será invalidado e o cadastro pendente será removido.' : 'O usuário perderá o acesso à documentação. Esta ação não pode ser desfeita.'} onClose={() => setRemoving(null)} busy={removeBusy} compact>
        <div className="workspace-modal__body"><div className="workspace-remove-target"><span className="workspace-avatar" aria-hidden="true">{removing.email.charAt(0).toUpperCase()}</span><span>{removing.email}</span></div>{removeError && <p className="workspace-error" role="alert">{removeError}</p>}</div>
        <div className="workspace-modal__footer"><button className="workspace-button" type="button" onClick={() => setRemoving(null)} disabled={removeBusy}>Cancelar</button><button className="workspace-button workspace-button--danger" type="button" onClick={() => void remove()} disabled={removeBusy}>{removeBusy ? <LoaderCircle className="workspace-spin" /> : <Trash2 />}{removeBusy ? 'Removendo…' : awaitingActivation(removing) ? 'Revogar convite' : 'Remover usuário'}</button></div>
      </Modal>}
    </div>
  );
}
