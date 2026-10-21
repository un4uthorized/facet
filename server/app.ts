import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler, type Response } from 'express';
import { createHash, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from './database.js';
import { MfaService, type MfaAccount } from './mfa.js';
import { parseEncryptionKey } from './totp.js';
import { PersistentRateLimiter } from './rate-limit.js';
import { defaultPages, parseOpenApi, validatePages, type ContentPage } from './documentation.js';

export interface AuthUser { id: string; name: string; email: string; role: 'admin' | 'user' }
export interface ManagedUser {
  id: string; name: string; email: string; role: 'admin' | 'user'; status: 'active' | 'inactive' | 'pending' | 'expired' | 'mfa_pending'; active: boolean; invitationExpiresAt?: string; createdAt: string | null; updatedAt: string | null; lastLoginAt: string | null;
}
export interface AppConfig {
  adminEmail: string;
  adminPassword: string;
  databaseUrl: string;
  mfaEncryptionKey?: string;
  sessionTtlMs?: number;
  secureCookies?: boolean;
  requireHttps?: boolean;
  clientDirectory?: string;
  documentationDirectory?: string;
  clientMiddleware?: RequestHandler;
  trustProxy?: boolean | number | string;
}
export type FacetApp = Express & { close: () => Promise<void> };

interface UserRow {
  id: string; name: string; email: string; password_hash: string; active: number; mfa_pending: boolean; created_at: string; updated_at: string; last_login_at: string | null;
}
interface InvitationRow { id: string; name: string; email: string; token_hash: string; created_at: string; expires_at: number }
interface SessionRow { user_id: string | null; admin_fingerprint: string | null; expires_at: number }

const cookieName = 'facet_session';
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const passwordMinLength = 15;
const passwordMaxLength = 128;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && emailPattern.test(email) ? email : null;
}

function normalizedName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 128 ? name : null;
}

function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= passwordMinLength && value.length <= passwordMaxLength;
}

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, scryptOptions, (error, key) => error ? reject(error) : resolve(key));
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await derivePassword(password, salt);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, stored] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !stored || !/^[a-f0-9]{128}$/.test(stored)) return false;
  return timingSafeEqual(await derivePassword(password, salt), Buffer.from(stored, 'hex'));
}

function publicUser(user: UserRow): ManagedUser {
  return {
    id: user.id, name: user.name, email: user.email, role: 'user', status: user.mfa_pending ? 'mfa_pending' : user.active === 1 ? 'active' : 'inactive', active: user.active === 1,
    createdAt: user.created_at, updatedAt: user.updated_at, lastLoginAt: user.last_login_at,
  };
}

function sessionHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

function sessionToken(request: Request): string | null {
  const parts = request.headers.cookie?.split(';') ?? [];
  for (const part of parts) {
    const [name, ...value] = part.trim().split('=');
    if (name === cookieName) {
      const token = value.join('=');
      return /^[a-f0-9]{64}$/.test(token) ? token : null;
    }
  }
  return null;
}

/** Creates an isolated app and database connection; call app.close() after its HTTP server closes. */
export async function createApp(config: AppConfig): Promise<FacetApp> {
  const adminEmail = normalizedEmail(config.adminEmail);
  if (!adminEmail) throw new Error('ADMIN_EMAIL deve ser um e-mail válido.');
  if (!validPassword(config.adminPassword)) throw new Error('ADMIN_PASSWORD deve ter entre 15 e 128 caracteres.');
  const sessionTtlMs = config.sessionTtlMs ?? 12 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0) throw new Error('Duração de sessão inválida.');
  if (!config.databaseUrl) throw new Error('DATABASE_URL é obrigatória.');
  const mfaKey = parseEncryptionKey(config.mfaEncryptionKey);
  const database = Database.connect(config.databaseUrl);
  try { await database.initialize(); }
  catch (error) { await database.close(); throw error; }

  await database.transaction(async transaction=>{
    const candidates=await transaction.all<{id:string}>('SELECT id FROM users WHERE active=1 AND NOT EXISTS (SELECT 1 FROM mfa_factors WHERE account_id=users.id AND secret_encrypted IS NOT NULL) FOR UPDATE');
    for(const {id} of candidates) if(!(await transaction.get('SELECT account_id FROM mfa_factors WHERE account_id=$1 AND secret_encrypted IS NOT NULL',[id]))) await transaction.run('UPDATE users SET active=0,mfa_pending=true WHERE id=$1',[id]);
    await transaction.run("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE active=0) OR NOT EXISTS (SELECT 1 FROM mfa_factors WHERE account_id=COALESCE(sessions.user_id,'admin') AND secret_encrypted IS NOT NULL)");
  });

  const adminSalt = `facet-admin:${adminEmail}`;
  const adminKey = scryptSync(config.adminPassword, adminSalt, 64, scryptOptions);
  const adminFingerprint = adminKey.toString('hex');
  // Persist a slow password-derived fingerprint so changing either admin credential revokes sessions.
  await database.run('DELETE FROM sessions WHERE expires_at <= $1 OR (admin_fingerprint IS NOT NULL AND admin_fingerprint != $2)', [Date.now(), adminFingerprint]);
  const dummyPassword = `scrypt$${randomBytes(16).toString('hex')}$${randomBytes(64).toString('hex')}`;
  const limiter = new PersistentRateLimiter(database);
  const acceptingInvitations = new Set<string>();
  let activePasswordWork = 0;
  const maximumPasswordWork = 4;
  const clientDirectory = resolve(config.clientDirectory ?? 'build/client');
  const documentationDirectory = resolve(config.documentationDirectory ?? 'documentation');
  const app = express() as FacetApp;
  app.disable('x-powered-by');
  if (config.trustProxy !== undefined) app.set('trust proxy', config.trustProxy);
  app.close = () => database.close();

  app.use(async (request, response, next) => {
    if (config.requireHttps && !request.secure) {
      response.set('Cache-Control', 'no-store').status(426).json({ error: 'Use HTTPS para acessar a aplicação.' });
      return;
    }
    if (config.requireHttps) response.set('Strict-Transport-Security', 'max-age=31536000');
    response.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
    });
    next();
  });

  app.use('/api', async (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    const origin = request.get('origin');
    const ownOrigin = `${request.protocol}://${request.get('host')}`;
    if (request.get('sec-fetch-site') === 'cross-site' || (origin && origin !== ownOrigin)) {
      response.status(403).json({ error: 'Origem da requisição não permitida.' });
      return;
    }
    if (['POST', 'PATCH', 'PUT'].includes(request.method) && request.path !== '/auth/logout' && !request.is('application/json')) {
      response.status(415).json({ error: 'Envie os dados no formato JSON.' });
      return;
    }
    next();
  }, async (request, response, next) => {
    const largeContent = request.path === '/admin/documentation/openapi' || request.path === '/admin/documentation/pages';
    express.json({ limit: largeContent ? '3mb' : '16kb', strict: true })(request, response, next);
  });

  async function currentUser(request: Request): Promise<AuthUser | null> {
    const token = sessionToken(request);
    if (!token) return null;
    const hash = sessionHash(token);
    const session = await database.get('SELECT user_id, admin_fingerprint, expires_at FROM sessions WHERE token_hash = $1', [hash]) as SessionRow | undefined;
    if (!session) return null;
    if (session.expires_at <= Date.now()) {
      await database.run('DELETE FROM sessions WHERE token_hash = $1', [hash]);
      return null;
    }
    if (!(await database.get('SELECT account_id FROM mfa_factors WHERE account_id=$1 AND secret_encrypted IS NOT NULL', [session.user_id ?? 'admin']))) return null;
    if (session.admin_fingerprint === adminFingerprint) return { id: 'admin', name: 'adminstrador', email: adminEmail!, role: 'admin' };
    if (!session.user_id) return null;
    const user = await database.get('SELECT * FROM users WHERE id = $1 AND active = 1', [session.user_id]) as UserRow | undefined;
    return user ? { id: user.id, name: user.name, email: user.email, role: 'user' } : null;
  }

  const requireUser: RequestHandler = async (request, response, next) => {
    const user = await currentUser(request);
    if (!user) { response.status(401).json({ error: 'Entre na sua conta para continuar.' }); return; }
    response.locals.user = user;
    next();
  };
  const requireAdmin: RequestHandler = async (request, response, next) => {
    if ((response.locals.user as AuthUser).role !== 'admin') {
      response.status(403).json({ error: 'Acesso permitido apenas ao administrador.' });
      return;
    }
    next();
  };

  const cookieOptions = { httpOnly: true, secure: config.secureCookies ?? false, sameSite: 'lax' as const, path: '/' };
  async function clearSession(request: Request, response: Response) {
    const token = sessionToken(request);
    if (token) await database.run('DELETE FROM sessions WHERE token_hash = $1', [sessionHash(token)]);
    response.clearCookie(cookieName, cookieOptions);
  }

  function rejectBusy(response: Response, status = 503, retryAfter = 1) {
    response.set('Retry-After', String(retryAfter)).status(status).json({ error: 'Muitas solicitações. Aguarde alguns instantes e tente novamente.' });
  }

  function userAccount(user: UserRow): MfaAccount {
    return { id: user.id, name: user.name, email: user.email, role: 'user', fingerprint: sessionHash(JSON.stringify([user.password_hash, user.email, user.updated_at])) };
  }
  async function readAccount(transaction: Database, id: string): Promise<MfaAccount | null> {
    if (id === 'admin') return { id, name: 'adminstrador', email: adminEmail!, role: 'admin', fingerprint: sessionHash(adminFingerprint) };
    const user = await transaction.get<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id]);
    return user?.active === 1 ? userAccount(user) : null;
  }
  async function issueSession(transaction: Database, request: Request, account: MfaAccount, passwordHash?: string | null, revokeAll = false): Promise<string> {
    if(!(await transaction.get('SELECT account_id FROM mfa_factors WHERE account_id=$1 AND secret_encrypted IS NOT NULL',[account.id]))) throw new Error('MFA obrigatório não confirmado.');
    if (passwordHash && account.role === 'user') await transaction.run('UPDATE users SET password_hash=$1, updated_at=$2 WHERE id=$3', [passwordHash, new Date().toISOString(), account.id]);
    if (revokeAll || passwordHash) {
      if (account.role === 'admin') await transaction.run('DELETE FROM sessions WHERE admin_fingerprint=$1', [adminFingerprint]);
      else await transaction.run('DELETE FROM sessions WHERE user_id=$1', [account.id]);
    }
    const oldToken = sessionToken(request);
    if (oldToken) await transaction.run('DELETE FROM sessions WHERE token_hash=$1', [sessionHash(oldToken)]);
    if (account.role === 'user') await transaction.run('UPDATE users SET last_login_at=$1 WHERE id=$2', [new Date().toISOString(), account.id]);
    const token = randomBytes(32).toString('hex');
    await transaction.run('DELETE FROM sessions WHERE expires_at <= $1', [Date.now()]);
    await transaction.run('INSERT INTO sessions (token_hash,user_id,admin_fingerprint,expires_at) VALUES ($1,$2,$3,$4)', [sessionHash(token), account.role === 'user' ? account.id : null, account.role === 'admin' ? adminFingerprint : null, Date.now() + sessionTtlMs]);
    return token;
  }
  const mfa = new MfaService({ database, key: mfaKey, limiter, readAccount, issueSession,
    readEnrollmentAccount: async (transaction,id)=>{
      if(id==='admin') return readAccount(transaction,id);
      const user=await transaction.get<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE',[id]);
      return user && (user.active===1||user.mfa_pending) ? userAccount(user):null;
    },
    setSession: (response, token) => { response.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionTtlMs }); },
    reauthenticate: async (request, response) => {
      const user = response.locals.user as AuthUser;
      const quota = await limiter.reserve([
        { key: `mfa:reauth:ip:${sessionHash(request.ip ?? 'unknown')}`, maximum: 60 },
        { key: `mfa:reauth:account:${sessionHash(user.id)}`, maximum: 8 },
      ]);
      if (quota.retryAfter !== undefined) { rejectBusy(response, 429, quota.retryAfter); return null; }
      if (activePasswordWork >= maximumPasswordWork) { await limiter.release(quota.reservation); rejectBusy(response); return null; }
      activePasswordWork += 1;
      let verified = false;
      try {
        const password = request.body?.password;
        const input = typeof password === 'string' && password.length <= passwordMaxLength ? password : '';
        const stored = user.role === 'user' ? await database.get<UserRow>('SELECT * FROM users WHERE id=$1', [user.id]) : undefined;
        const matches = user.role === 'admin' ? timingSafeEqual(await derivePassword(input, adminSalt), adminKey) : await verifyPassword(input, stored?.password_hash ?? dummyPassword);
        if (!matches || (user.role === 'user' && stored?.active !== 1)) { response.status(400).json({ error: 'A senha atual está incorreta.' }); return null; }
        verified = true;
        return stored ? userAccount(stored) : { ...user, fingerprint: sessionHash(adminFingerprint) };
      } finally { activePasswordWork -= 1; if (verified) await limiter.release(quota.reservation); }
    },
  });

  app.get('/api/auth/me', requireUser, async (_request, response) => response.json({ user: response.locals.user }));
  app.post('/api/auth/login', async (request, response) => {
    const email = normalizedEmail(request.body?.email);
    const password = request.body?.password;
    const quota = await limiter.reserve([
      { key: `login:ip:${sessionHash(request.ip ?? 'unknown')}`, maximum: 60 },
      { key: `login:account:${sessionHash(email ?? 'invalid')}`, maximum: 8 },
    ]);
    if (quota.retryAfter !== undefined) { rejectBusy(response, 429, quota.retryAfter); return; }
    if (activePasswordWork >= maximumPasswordWork) {
      await limiter.release(quota.reservation); rejectBusy(response); return;
    }
    activePasswordWork += 1;
    let authenticated = false;
    try {
      const passwordInput = typeof password === 'string' && password.length <= passwordMaxLength ? password : '';
      const storedUser = email && email !== adminEmail ? await database.get<UserRow>('SELECT * FROM users WHERE email = $1', [email]) : undefined;
      const matches = email === adminEmail
        ? timingSafeEqual(await derivePassword(passwordInput, adminSalt), adminKey)
        : await verifyPassword(passwordInput, storedUser?.password_hash ?? dummyPassword);
      const needsUpgrade = Boolean(storedUser && matches && !validPassword(passwordInput));
      const newPassword = request.body?.newPassword;
      const upgradedHash = needsUpgrade && validPassword(newPassword) ? await hashPassword(newPassword) : null;
      const result = await database.transaction(async transaction => {
        let account: MfaAccount;
        if (email === adminEmail && matches) account = { id: 'admin', name: 'adminstrador', email, role: 'admin', fingerprint: sessionHash(adminFingerprint) };
        else {
          const latest = storedUser ? await transaction.get<UserRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [storedUser.id]) : undefined;
          if (!storedUser || !latest || (latest.active !== 1 && !latest.mfa_pending) || !matches || latest.password_hash !== storedUser.password_hash
            || latest.email !== storedUser.email || latest.updated_at !== storedUser.updated_at) return { kind: 'invalid' as const };
          if (needsUpgrade && !upgradedHash) return { kind: 'upgrade' as const };
          account = userAccount(latest);
        }
        if(!mfaKey && !(await transaction.get('SELECT account_id FROM mfa_factors WHERE account_id=$1 AND secret_encrypted IS NOT NULL',[account.id]))) return {kind:'unavailable' as const};
        const challenge = await mfa.beginLogin(transaction, account, upgradedHash);
        if (challenge) return { kind: 'mfa' as const, challenge };
        throw new Error('O MFA obrigatório não foi iniciado.');
      });
      if (result.kind === 'invalid') { response.status(401).json({ error: 'E-mail ou senha inválidos.' }); return; }
      authenticated = true;
      if (result.kind === 'upgrade') {
        response.status(newPassword === undefined ? 409 : 400).json({ code: 'PASSWORD_UPDATE_REQUIRED', error: 'Atualize sua senha para uma senha de 15 a 128 caracteres para continuar.' }); return;
      }
      if(result.kind==='unavailable'){response.status(503).json({error:'O MFA obrigatório precisa ser configurado no servidor.'});return;}
      if (result.kind === 'mfa') { response.json(result.challenge); return; }

    } catch (error) {
      authenticated = true;
      throw error;
    } finally {
      activePasswordWork -= 1;
      if (authenticated) await limiter.release(quota.reservation);
    }
  });
  mfa.mount(app, requireUser);
  app.post('/api/auth/logout', async (request, response) => { await clearSession(request, response); response.sendStatus(204); });

  async function findInvitation(token: unknown): Promise<InvitationRow | undefined> {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    return await database.get('SELECT * FROM invitations WHERE token_hash = $1 AND expires_at > $2', [sessionHash(token), Date.now()]) as InvitationRow | undefined;
  }
  app.post('/api/invitations/inspect', async (request, response) => {
    const invitation = await findInvitation(request.body?.token);
    if (!invitation) { response.status(410).json({ error: 'Este convite expirou, foi revogado ou já foi utilizado.' }); return; }
    response.json({ invitation: { name: invitation.name, email: invitation.email, expiresAt: new Date(invitation.expires_at).toISOString() } });
  });
  app.post('/api/invitations/accept', async (request, response) => {
    if(!mfaKey){response.status(503).json({error:'O MFA obrigatório precisa ser configurado no servidor.'});return;}
    const token = request.body?.token;
    const initialInvitation = await findInvitation(token);
    if (!initialInvitation) { response.status(410).json({ error: 'Este convite expirou, foi revogado ou já foi utilizado.' }); return; }
    const password = request.body?.password;
    if (!validPassword(password)) { response.status(400).json({ error: 'Informe uma senha de 15 a 128 caracteres.' }); return; }
    const tokenHash = sessionHash(token);
    if (acceptingInvitations.has(tokenHash)) { rejectBusy(response, 429); return; }
    if (activePasswordWork >= maximumPasswordWork) { rejectBusy(response); return; }
    // Reserve local work before any await; the PostgreSQL lock below handles concurrent processes.
    acceptingInvitations.add(tokenHash);
    activePasswordWork += 1;
    try {
      const quota = await limiter.reserve([
        { key: `invitation:ip:${sessionHash(request.ip ?? 'unknown')}`, maximum: 60 },
        { key: `invitation:token:${tokenHash}`, maximum: 8 },
      ]);
      if (quota.retryAfter !== undefined) { rejectBusy(response, 429, quota.retryAfter); return; }
      const passwordHash = await hashPassword(password);
      const result = await database.transaction(async transaction => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('facet:account'))", [initialInvitation.email]);
        const invitation = await transaction.get<InvitationRow>('SELECT * FROM invitations WHERE token_hash = $1 AND expires_at > $2 FOR UPDATE', [tokenHash, Date.now()]);
        if (!invitation) return { status: 410, error: 'Este convite expirou, foi revogado ou já foi utilizado.' };
        if (invitation.email === adminEmail || await transaction.get('SELECT id FROM users WHERE email = $1', [invitation.email])) {
          return { status: 409, error: 'Já existe uma conta com este e-mail. Entre com sua conta ou contate o administrador.' };
        }
        const id = randomUUID();
        const now = new Date().toISOString();
        await transaction.run('INSERT INTO users (id, name, email, password_hash, active, mfa_pending, created_at, updated_at) VALUES ($1, $2, $3, $4, 0, true, $5, $6)', [id, invitation.name, invitation.email, passwordHash, now, now]);
        await transaction.run('DELETE FROM invitations WHERE id = $1', [invitation.id]);
        const user=(await transaction.get<UserRow>('SELECT * FROM users WHERE id=$1',[id]))!;
        return {status:201,user:publicUser(user),enrollment:await mfa.beginEnrollment(transaction,userAccount(user))};
      });
      if (result.error) response.status(result.status).json({ error: result.error });
      else response.status(201).json({ user: result.user, ...result.enrollment });
    } finally {
      acceptingInvitations.delete(tokenHash);
      activePasswordWork -= 1;
    }
  });

  const defaultSettings = { title: 'Documentação da API', logoUrl: '' };
  async function documentationSettings() {
    const row = await database.get('SELECT value FROM settings WHERE key = $1', ['documentation']) as { value: string } | undefined;
    const stored = row ? JSON.parse(row.value) : defaultSettings;
    return { title: !stored.title?.trim() || stored.title === 'Facet API' ? defaultSettings.title : stored.title, logoUrl: stored.logoUrl ?? defaultSettings.logoUrl };
  }
  async function savedContent(key: string, source = database): Promise<any> {
    const row = await source.get('SELECT value FROM settings WHERE key = $1', [key]) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  async function saveContent(key: string, value: unknown, source = database) {
    await source.run('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
  }
  async function pageCollection(source = database): Promise<{ pages: ContentPage[]; revision: number }> {
    return await savedContent('pages', source) ?? { pages: defaultPages, revision: 0 };
  }
  app.get('/api/documentation/content', requireUser, async (_request, response) => {
    response.json({ pages: (await pageCollection()).pages.filter(page => page.published), openapi: await savedContent('openapi') });
  });
  app.get('/api/documentation/settings', requireUser, async (_request, response) => response.json({ settings: await documentationSettings() }));
  app.use('/api/admin', requireUser, requireAdmin);
  app.get('/api/admin/documentation/content', async (_request, response) => response.json({ ...await pageCollection(), openapi: await savedContent('openapi') }));
  app.put('/api/admin/documentation/openapi', async (request, response) => {
    let spec: Record<string, any>;
    try { spec = parseOpenApi(request.body?.source); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Especificação inválida.' }); return; }
    const sourceName = typeof request.body?.sourceName === 'string' ? request.body.sourceName.trim().slice(0, 180) : 'openapi';
    const openapi = { spec, sourceName: sourceName || 'openapi', updatedAt: new Date().toISOString() };
    await saveContent('openapi', openapi);
    response.json({ openapi });
  });
  app.put('/api/admin/documentation/pages', async (request, response) => {
    let pages: ContentPage[];
    try { pages = validatePages(request.body?.pages); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Páginas inválidas.' }); return; }
    const collection = await database.transaction(async transaction => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('facet:pages'))");
      const current = await pageCollection(transaction);
      if (request.body?.revision !== current.revision) return null;
      const updated = { pages, revision: current.revision + 1 };
      await saveContent('pages', updated, transaction);
      return updated;
    });
    if (!collection) { response.status(409).json({ error: 'As páginas foram alteradas em outra aba. Recarregue antes de salvar.' }); return; }
    response.json(collection);
  });
  app.put('/api/admin/documentation/settings', async (request, response) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['title', 'logoUrl'].includes(key))
      || (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 80)
      || typeof body.logoUrl !== 'string' || body.logoUrl.length > 2048) {
      response.status(400).json({ error: 'Confira o nome (até 80 caracteres) e a URL do logo.' }); return;
    }
    const logoUrl = body.logoUrl.trim();
    if (logoUrl) {
      try {
        const url = new URL(logoUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid logo');
      } catch { response.status(400).json({ error: 'Use uma URL HTTPS válida para o logo.' }); return; }
    }
    const settings = { title: body.title.trim(), logoUrl };
    await database.run('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value', ['documentation', JSON.stringify(settings)]);
    response.json({ settings });
  });

  app.get('/api/admin/invitations', async (_request, response) => {
    const invitations = await database.all('SELECT id, name, email, created_at, expires_at FROM invitations ORDER BY created_at DESC') as unknown as InvitationRow[];
    response.json({ invitations: invitations.map(item => ({ id: item.id, name: item.name, email: item.email, createdAt: item.created_at, expiresAt: new Date(item.expires_at).toISOString() })) });
  });
  app.post('/api/admin/users', async (request, response) => {
    if ('password' in (request.body ?? {})) { response.status(400).json({ error: 'O usuário define a própria senha pelo link de convite.' }); return; }
    const name = normalizedName(request.body?.name);
    if (!name) { response.status(400).json({ error: 'Informe um nome de até 128 caracteres.' }); return; }
    const email = normalizedEmail(request.body?.email);
    if (!email) { response.status(400).json({ error: 'Informe um e-mail válido.' }); return; }
    const token = randomBytes(32).toString('hex');
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const created = await database.transaction(async transaction => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('facet:account'))", [email]);
      if (email === adminEmail || await transaction.get('SELECT id FROM users WHERE email = $1', [email])) return false;
      await transaction.run('INSERT INTO invitations (id, name, email, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT(email) DO UPDATE SET id = excluded.id, name = excluded.name, token_hash = excluded.token_hash, created_at = excluded.created_at, expires_at = excluded.expires_at', [id, name, email, sessionHash(token), createdAt, expiresAt]);
      return true;
    });
    if (!created) { response.status(409).json({ error: 'Já existe uma conta com este e-mail.' }); return; }
    response.status(201).json({ invitation: { id, name, email, createdAt, expiresAt: new Date(expiresAt).toISOString() }, path: `/invite#${token}` });
  });

  app.delete('/api/admin/invitations/:id', async (request, response) => {
    await database.run('DELETE FROM invitations WHERE id = $1', [String(request.params.id)]);
    response.sendStatus(204);
  });

  app.get('/api/admin/users', async (_request, response) => {
    const users = await database.all('SELECT * FROM users ORDER BY created_at DESC, email ASC') as unknown as UserRow[];
    const admin: ManagedUser = { id: 'admin', name: 'adminstrador', email: adminEmail, role: 'admin', status: 'active', active: true, createdAt: null, updatedAt: null, lastLoginAt: null };
    const invitations = await database.all('SELECT * FROM invitations ORDER BY created_at DESC') as unknown as InvitationRow[];
    const pending: ManagedUser[] = invitations.map(item => ({
      id: item.id, name: item.name, email: item.email, role: 'user', active: false,
      status: item.expires_at <= Date.now() ? 'expired' : 'pending',
      invitationExpiresAt: new Date(item.expires_at).toISOString(),
      createdAt: item.created_at, updatedAt: item.created_at, lastLoginAt: null,
    }));
    response.json({ users: [admin, ...users.map(publicUser), ...pending] });
  });
  app.patch('/api/admin/users/:id', async (request, response) => {
    const id = String(request.params.id);
    const user = await database.get('SELECT * FROM users WHERE id = $1', [id]) as UserRow | undefined;
    if (!user) { response.status(404).json({ error: 'Usuário não encontrado.' }); return; }
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) { response.status(400).json({ error: 'Informe os dados que deseja atualizar.' }); return; }
    const keys = Object.keys(body);
    if (!keys.length || keys.some((key) => !['name', 'email', 'active'].includes(key))) {
      response.status(400).json({ error: 'Informe apenas nome, e-mail ou status para atualizar.' }); return;
    }
    const name = 'name' in body ? normalizedName(body.name) : user.name;
    if (!name) { response.status(400).json({ error: 'Informe um nome de até 128 caracteres.' }); return; }
    const email = 'email' in body ? normalizedEmail(body.email) : user.email;
    if (!email) { response.status(400).json({ error: 'Informe um e-mail válido.' }); return; }
    if ('active' in body && typeof body.active !== 'boolean') { response.status(400).json({ error: 'O status do usuário é inválido.' }); return; }
    if (email === adminEmail || await database.get('SELECT id FROM users WHERE email = $1 AND id != $2', [email, id])) {
      response.status(409).json({ error: 'Já existe uma conta com este e-mail.' }); return;
    }
    try {
      const result = await database.transaction(async transaction => {
        const latestUser = await transaction.get<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
        if (!latestUser) return null;
        const finalName = 'name' in body ? name : latestUser.name;
        const finalEmail = 'email' in body ? email : latestUser.email;
        const active = 'active' in body ? Number(body.active) : latestUser.active;
        if(active===1 && !(await transaction.get('SELECT account_id FROM mfa_factors WHERE account_id=$1 AND secret_encrypted IS NOT NULL',[id]))) return 'mfa_required' as const;
        await transaction.run('UPDATE users SET name = $1, email = $2, active = $3, updated_at = $4 WHERE id = $5', [finalName, finalEmail, active, new Date().toISOString(), id]);
        if('active' in body && !body.active){
          await transaction.run('UPDATE users SET mfa_pending=false WHERE id=$1',[id]);
          await transaction.run('DELETE FROM mfa_enrollments WHERE account_id=$1',[id]);
        }
        if (finalEmail !== latestUser.email || active !== latestUser.active) await transaction.run('DELETE FROM sessions WHERE user_id = $1', [id]);
        return (await transaction.get<UserRow>('SELECT * FROM users WHERE id = $1', [id]))!;
      });
      if(result==='mfa_required'){response.status(400).json({error:'O usuário precisa concluir o MFA antes de ser ativado.'});return;}
      if (!result) { response.status(404).json({ error: 'Usuário não encontrado.' }); return; }
      response.json({ user: publicUser(result) });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') { response.status(409).json({ error: 'Já existe uma conta com este e-mail.' }); return; }
      throw error;
    }
  });

  app.delete('/api/admin/users/:id', async (request, response) => {
    const result = await database.run('DELETE FROM users WHERE id = $1', [String(request.params.id)]);
    if (result.changes === 0) { response.status(404).json({ error: 'Usuário não encontrado.' }); return; }
    response.sendStatus(204);
  });
  app.use('/api', (_request, response) => response.status(404).json({ error: 'Recurso não encontrado.' }));

  app.use('/docs-assets', requireUser, (_request, response, next) => {
    response.set('Cache-Control', 'private, no-store');
    next();
  }, express.static(documentationDirectory, { index: false, redirect: false, etag: false, cacheControl: false }),
  (_request, response) => response.status(404).json({ error: 'Arquivo não encontrado.' }));

  app.use(['/docs', '/admin', '/account'], async (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    const user = await currentUser(request);
    if (!user) { response.redirect('/login'); return; }
    if (request.baseUrl.toLowerCase().replace(/\/$/, '') === '/admin' && user.role !== 'admin') { response.redirect('/docs'); return; }
    next();
  });
  app.get('/login', async (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (await currentUser(request)) { response.redirect('/docs'); return; }
    next();
  });
  app.get('/', async (request, response) => response.redirect(await currentUser(request) ? '/docs' : '/login'));
  if (config.clientMiddleware) app.use(config.clientMiddleware);
  app.use(express.static(clientDirectory, { index: false, redirect: false }));
  app.get(['/login', '/invite', '/docs', '/admin', '/account/security'], async (_request, response) => {
    const indexPath = resolve(clientDirectory, 'index.html');
    if (!existsSync(indexPath)) { response.status(503).send('Frontend indisponível. Execute o build antes de iniciar o servidor.'); return; }
    response.sendFile(indexPath);
  });
  app.use((_request, response) => response.status(404).send('Página não encontrada.'));
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      response.status(400).json({ error: 'O JSON enviado é inválido.' }); return;
    }
    if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
      response.status(413).json({ error: 'Os dados enviados excedem o tamanho permitido.' }); return;
    }
    console.error('Falha ao processar requisição:', error instanceof Error ? error.message : 'Erro desconhecido');
    response.status(500).json({ error: 'Não foi possível concluir a solicitação.' });
  };
  app.use(errors);
  return app;
}
