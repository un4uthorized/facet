import { lazy, Suspense, useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from './api';
import { AcceptInvitation } from './pages/AcceptInvitation';
import { Login } from './pages/Login';
import { Admin } from './pages/Admin';
import type { AuthUser } from './types';
import { AccountSecurity } from './pages/AccountSecurity';
import { LoadingScreen } from './components/LoadingScreen';

const Documentation = lazy(() => import('./documentation/Documentation'));

export function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const path = window.location.pathname.replace(/\/+$/, '') || '/';

  useEffect(() => {
    const controller = new AbortController();
    api.me(controller.signal)
      .then(({ user }) => setUser(user))
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (!(failure instanceof ApiError && failure.status === 401)) setError(errorMessage(failure));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const unauthorized = () => window.location.assign('/login');
    window.addEventListener('facet:unauthorized', unauthorized);
    return () => {
      controller.abort();
      window.removeEventListener('facet:unauthorized', unauthorized);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    const checkSession = () => {
      if (document.visibilityState !== 'visible') return;
      api.me().catch((failure: unknown) => {
        if (failure instanceof ApiError && failure.status === 401) window.location.assign('/login');
      });
    };
    const timer = window.setInterval(checkSession, 60_000);
    document.addEventListener('visibilitychange', checkSession);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', checkSession);
    };
  }, [user]);

  useEffect(() => {
    if (loading || error) return;
    if (!user && path !== '/login' && path !== '/invite') window.location.replace('/login');
    else if (user && (path === '/login' || path === '/' || (path === '/admin' && user.role !== 'admin'))) window.location.replace('/docs');
  }, [loading, user, path, error]);

  const logout = async () => {
    await api.logout();
    window.location.assign('/login');
  };

  let content;
  if (error) content = <main className="facet-loading"><div role="alert"><p>{error}</p><button onClick={() => window.location.reload()}>Tentar novamente</button></div></main>;
  else if (!loading) {
    if (path === '/invite') content = <AcceptInvitation />;
    else if (!user && path === '/login') content = <Login onLogin={(account) => window.location.assign(account.role === 'admin' ? '/admin' : '/docs')} />;
    else if (user && path === '/account/security') content = <AccountSecurity user={user} onLogout={logout} />;
    else if (user && path === '/admin' && user.role === 'admin') content = <Admin user={user} onLogout={logout} />;
    else if (user) content = <Suspense fallback={<LoadingScreen label="Abrindo documentação…" />}><Documentation user={user} onLogout={logout} /></Suspense>;
  }
  const redirecting = !loading && !error && !user && path !== '/login' && path !== '/invite';
  return <><LoadingScreen active={loading || redirecting} />{content}</>;
}
