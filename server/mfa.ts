import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response, RequestHandler } from 'express';
import QRCode from 'qrcode';
import type { Database } from './database.js';
import type { PersistentRateLimiter } from './rate-limit.js';
import { createTotp, decryptSecret, encryptSecret, generateRecoveryCodes, generateSecret, hashRecoveryCode, verifyTotp } from './totp.js';

export interface MfaAccount { id: string; name: string; email: string; role: 'admin' | 'user'; fingerprint: string }
interface Factor { account_id: string; secret_encrypted: string | null; pending_encrypted: string | null; pending_expires_at: number | null; pending_fingerprint: string | null; last_counter: number; recovery_hashes: string[]; version: string }
interface Challenge { token_hash: string; account_id: string; credential_fingerprint: string; factor_version: string; pending_password_hash: string | null; expires_at: number; attempts: number }
interface Options {
  database: Database; key: Buffer | null; limiter: PersistentRateLimiter;
  readEnrollmentAccount: (transaction: Database, id: string) => Promise<MfaAccount | null>;
  readAccount: (transaction: Database, id: string) => Promise<MfaAccount | null>;
  reauthenticate: (request: Request, response: Response) => Promise<MfaAccount | null>;
  issueSession: (transaction: Database, request: Request, account: MfaAccount, passwordHash?: string | null, revokeAll?: boolean) => Promise<string>;
  setSession: (response: Response, token: string) => void;
}
class MfaError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const invalid = 'Código inválido ou já utilizado. Aguarde o próximo código do app ou use um código de recuperação.';

export class MfaService {
  constructor(private options: Options) {}
  private async lock(transaction: Database, id: string) { await transaction.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext('facet:mfa'))", [id]); }
  private key() { if (!this.options.key) throw new MfaError(503, 'A configuração do autenticador está indisponível. Use um código de recuperação ou contate o responsável pela aplicação.'); return this.options.key; }
  private async quota(request: Request, accountId: string, purpose: string) {
    const result = await this.options.limiter.reserve([
      { key: `mfa:${purpose}:ip:${hash(request.ip ?? 'unknown')}`, maximum: 60 },
      { key: `mfa:${purpose}:account:${hash(accountId)}`, maximum: 8 },
    ]);
    if (result.retryAfter !== undefined) throw new MfaError(429, 'Muitas tentativas. Aguarde alguns minutos e tente novamente.');
    return result.reservation;
  }
  private route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
    return async (request, response) => {
      try { await handler(request, response); }
      catch (error) {
        if (!(error instanceof MfaError)) throw error;
        if (error.status === 429) response.set('Retry-After', '900');
        response.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
    };
  }
  private async account(transaction: Database, proof: MfaAccount) {
    const account = await this.options.readAccount(transaction, proof.id);
    if (!account || account.fingerprint !== proof.fingerprint) throw new MfaError(400, 'Sua conta foi alterada. Entre novamente para continuar.');
    await this.lock(transaction, account.id);
    return account;
  }
  private async consume(transaction: Database, factor: Factor, code: unknown): Promise<boolean> {
    if (typeof code !== 'string' || code.length > 128) return false;
    const recovery = hashRecoveryCode(code);
    const index = factor.recovery_hashes.findIndex(stored => timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(recovery, 'hex')));
    if (index >= 0) {
      const remaining = factor.recovery_hashes.filter((_, i) => i !== index);
      await transaction.run('UPDATE mfa_factors SET recovery_hashes = $1::jsonb WHERE account_id = $2', [JSON.stringify(remaining), factor.account_id]);
      return true;
    }
    if (!factor.secret_encrypted || !/^\d{6}$/.test(code)) return false;
    const secret = decryptSecret(factor.secret_encrypted, this.key(), factor.account_id);
    const counter = verifyTotp(secret, code, factor.last_counter);
    if (counter === null) return false;
    await transaction.run('UPDATE mfa_factors SET last_counter = $1 WHERE account_id = $2', [counter, factor.account_id]);
    return true;
  }

  async beginEnrollment(transaction: Database, account: MfaAccount, pendingPasswordHash?: string | null) {
    const secret = generateSecret();
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 10 * 60 * 1000;
    await this.lock(transaction, account.id);
    const factor = await transaction.get<Factor>('SELECT * FROM mfa_factors WHERE account_id=$1 FOR UPDATE', [account.id]);
    if (factor?.secret_encrypted) throw new MfaError(409, 'O autenticador já está cadastrado. Entre com seu código.');
    await transaction.run('INSERT INTO mfa_factors (account_id,user_id,pending_encrypted,pending_expires_at,pending_fingerprint,version) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id) DO UPDATE SET pending_encrypted=excluded.pending_encrypted,pending_expires_at=excluded.pending_expires_at,pending_fingerprint=excluded.pending_fingerprint,version=excluded.version', [account.id,account.role==='admin'?null:account.id,encryptSecret(secret,this.key(),account.id),expiresAt,account.fingerprint,randomUUID()]);
    await transaction.run('DELETE FROM mfa_enrollments WHERE account_id=$1 OR expires_at<=$2', [account.id,Date.now()]);
    await transaction.run('INSERT INTO mfa_enrollments (token_hash,account_id,credential_fingerprint,pending_password_hash,expires_at) VALUES ($1,$2,$3,$4,$5)', [hash(token),account.id,account.fingerprint,pendingPasswordHash??null,expiresAt]);
    const uri=createTotp(secret,account.name).toString();
    return {mfaEnrollmentRequired:true as const,enrollmentToken:token,secret,uri,qrCode:await QRCode.toDataURL(uri,{width:240,margin:2,errorCorrectionLevel:'M'}),expiresAt:new Date(expiresAt).toISOString()};
  }

  async beginLogin(transaction: Database, account: MfaAccount, pendingPasswordHash?: string | null) {
    await this.lock(transaction, account.id);
    const factor = await transaction.get<Factor>('SELECT * FROM mfa_factors WHERE account_id = $1 FOR UPDATE', [account.id]);
    if (!factor?.secret_encrypted) return this.beginEnrollment(transaction, account, pendingPasswordHash);
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 5 * 60 * 1000;
    await transaction.run('DELETE FROM mfa_challenges WHERE account_id = $1 OR expires_at <= $2', [account.id, Date.now()]);
    await transaction.run('INSERT INTO mfa_challenges (token_hash, account_id, credential_fingerprint, factor_version, pending_password_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6)', [hash(token), account.id, account.fingerprint, factor.version, pendingPasswordHash ?? null, expiresAt]);
    return { mfaRequired: true as const, challengeToken: token, expiresAt: new Date(expiresAt).toISOString() };
  }

  mount(app: Express, requireUser: RequestHandler) {
    app.post('/api/auth/mfa/enrollment/confirm', this.route(async (request,response)=>{
      const token=request.body?.enrollmentToken;
      if(typeof token!=='string'||! /^[a-f0-9]{64}$/.test(token)) throw new MfaError(410,'O cadastro expirou. Retome a configuração com sua senha.');
      const initial=await this.options.database.get<{account_id:string}>('SELECT account_id FROM mfa_enrollments WHERE token_hash=$1',[hash(token)]);
      if(!initial) throw new MfaError(410,'O cadastro expirou ou já foi concluído. Retome a configuração com sua senha.');
      const quota=await this.quota(request,initial.account_id,'enroll');
      const recovery=generateRecoveryCodes();
      const result=await this.options.database.transaction(async transaction=>{
        const account=await this.options.readEnrollmentAccount(transaction,initial.account_id);
        await this.lock(transaction,initial.account_id);
        const enrollment=await transaction.get<{credential_fingerprint:string;expires_at:number;attempts:number;pending_password_hash:string|null}>('SELECT * FROM mfa_enrollments WHERE token_hash=$1 FOR UPDATE',[hash(token)]);
        const factor=await transaction.get<Factor>('SELECT * FROM mfa_factors WHERE account_id=$1 FOR UPDATE',[initial.account_id]);
        if(!account||!enrollment||enrollment.expires_at<=Date.now()||enrollment.attempts>=5||enrollment.credential_fingerprint!==account.fingerprint||!factor?.pending_encrypted||factor.secret_encrypted||factor.pending_fingerprint!==account.fingerprint) return {error:'expired' as const};
        const counter=verifyTotp(decryptSecret(factor.pending_encrypted,this.key(),account.id),request.body?.code);
        if(counter===null){await transaction.run('UPDATE mfa_enrollments SET attempts=attempts+1 WHERE token_hash=$1',[hash(token)]);return {error:'invalid' as const};}
        await transaction.run('UPDATE mfa_factors SET secret_encrypted=pending_encrypted,pending_encrypted=NULL,pending_expires_at=NULL,pending_fingerprint=NULL,last_counter=$1,recovery_hashes=$2::jsonb,version=$3 WHERE account_id=$4',[counter,JSON.stringify(recovery.hashes),randomUUID(),account.id]);
        if(account.role==='user'){
          await transaction.run('UPDATE users SET active=1,mfa_pending=false,password_hash=COALESCE($1,password_hash),updated_at=$2 WHERE id=$3',[enrollment.pending_password_hash,new Date().toISOString(),account.id]);
          await transaction.run('DELETE FROM sessions WHERE user_id=$1',[account.id]);
        }
        await transaction.run('DELETE FROM mfa_enrollments WHERE account_id=$1',[account.id]);
        await transaction.run('DELETE FROM mfa_challenges WHERE account_id=$1',[account.id]);
        return {error:null};
      });
      if(result.error==='expired') throw new MfaError(410,'O cadastro expirou ou a conta foi alterada. Retome a configuração com sua senha.');
      if(result.error) throw new MfaError(400,invalid);
      await this.options.limiter.release(quota);
      response.json({recoveryCodes:recovery.codes});
    }));
    app.post('/api/auth/mfa/disable',requireUser,this.route(async()=>{throw new MfaError(403,'O MFA é obrigatório e não pode ser desativado.');}));
    app.get('/api/auth/mfa', requireUser, this.route(async (_request, response) => {
      const factor = await this.options.database.get<Factor>('SELECT secret_encrypted FROM mfa_factors WHERE account_id = $1', [response.locals.user.id]);
      response.json({ enabled: Boolean(factor?.secret_encrypted), configured: Boolean(this.options.key) });
    }));
    app.post('/api/auth/mfa/setup', requireUser, this.route(async (request, response) => {
      const key = this.key();
      const proof = await this.options.reauthenticate(request, response);
      if (!proof) return;
      const secret = generateSecret();
      const expiresAt = Date.now() + 10 * 60 * 1000;
      await this.options.database.transaction(async transaction => {
        const account = await this.account(transaction, proof);
        const factor = await transaction.get<Factor>('SELECT * FROM mfa_factors WHERE account_id = $1 FOR UPDATE', [account.id]);
        if (factor?.secret_encrypted) throw new MfaError(409, 'A autenticação em duas etapas já está ativa.');
        await transaction.run('INSERT INTO mfa_factors (account_id,user_id,pending_encrypted,pending_expires_at,pending_fingerprint,version) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id) DO UPDATE SET pending_encrypted=excluded.pending_encrypted,pending_expires_at=excluded.pending_expires_at,pending_fingerprint=excluded.pending_fingerprint,version=excluded.version', [account.id, account.role === 'admin' ? null : account.id, encryptSecret(secret, key, account.id), expiresAt, account.fingerprint, randomUUID()]);
      });
      const uri = createTotp(secret, proof.name).toString();
      const qrCode = await QRCode.toDataURL(uri, { width: 240, margin: 2, errorCorrectionLevel: 'M' });
      response.json({ secret, uri, qrCode, expiresAt: new Date(expiresAt).toISOString() });
    }));
    app.post('/api/auth/mfa/enable', requireUser, this.route(async (request, response) => {
      const quota = await this.quota(request, response.locals.user.id, 'enable');
      const recovery = generateRecoveryCodes();
      const token = await this.options.database.transaction(async transaction => {
        const account = await this.options.readAccount(transaction, response.locals.user.id);
        if (!account) throw new MfaError(401, 'Entre novamente para continuar.');
        await this.lock(transaction, account.id);
        const factor = await transaction.get<Factor>('SELECT * FROM mfa_factors WHERE account_id = $1 FOR UPDATE', [account.id]);
        if (!factor || factor.secret_encrypted || !factor.pending_encrypted || !factor.pending_expires_at || factor.pending_expires_at <= Date.now() || factor.pending_fingerprint !== account.fingerprint) throw new MfaError(400, 'A configuração expirou ou a conta foi alterada. Inicie a configuração novamente.');
        const counter = verifyTotp(decryptSecret(factor.pending_encrypted, this.key(), account.id), request.body?.code);
        if (counter === null) throw new MfaError(400, invalid);
        await transaction.run('UPDATE mfa_factors SET secret_encrypted=pending_encrypted,pending_encrypted=NULL,pending_expires_at=NULL,pending_fingerprint=NULL,last_counter=$1,recovery_hashes=$2::jsonb,version=$3 WHERE account_id=$4', [counter, JSON.stringify(recovery.hashes), randomUUID(), account.id]);
        await transaction.run('DELETE FROM mfa_challenges WHERE account_id=$1', [account.id]);
        return this.options.issueSession(transaction, request, account, null, true);
      });
      await this.options.limiter.release(quota);
      this.options.setSession(response, token);
      response.json({ recoveryCodes: recovery.codes });
    }));
    for (const action of ['recovery-codes'] as const) app.post(`/api/auth/mfa/${action}`, requireUser, this.route(async (request, response) => {
      const proof = await this.options.reauthenticate(request, response);
      if (!proof) return;
      const quota = await this.quota(request, proof.id, 'manage');
      const recovery = generateRecoveryCodes();
      const token = await this.options.database.transaction(async transaction => {
        const account = await this.account(transaction, proof);
        const factor = await transaction.get<Factor>('SELECT * FROM mfa_factors WHERE account_id=$1 FOR UPDATE', [account.id]);
        if (!factor?.secret_encrypted) throw new MfaError(400, 'A autenticação em duas etapas não está ativa.');
        if (!(await this.consume(transaction, factor, request.body?.code))) throw new MfaError(400, invalid);
        await transaction.run('UPDATE mfa_factors SET recovery_hashes=$1::jsonb,version=$2 WHERE account_id=$3', [JSON.stringify(recovery.hashes), randomUUID(), account.id]);
        await transaction.run('DELETE FROM mfa_challenges WHERE account_id=$1', [account.id]);
        return this.options.issueSession(transaction, request, account, null, true);
      });
      await this.options.limiter.release(quota);
      this.options.setSession(response, token);
      response.json({ recoveryCodes: recovery.codes });
    }));
    app.post('/api/auth/mfa/verify', this.route(async (request, response) => {
      const token = request.body?.challengeToken;
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new MfaError(401, 'A verificação expirou. Entre novamente.', 'MFA_CHALLENGE_EXPIRED');
      const initial = await this.options.database.get<Challenge>('SELECT * FROM mfa_challenges WHERE token_hash=$1 AND expires_at>$2', [hash(token), Date.now()]);
      if (!initial) throw new MfaError(401, 'A verificação expirou ou já foi utilizada. Entre novamente.', 'MFA_CHALLENGE_EXPIRED');
      const quota = await this.quota(request, initial.account_id, 'verify');
      const result = await this.options.database.transaction(async transaction => {
        const account = await this.options.readAccount(transaction, initial.account_id);
        await this.lock(transaction, initial.account_id);
        const challenge = await transaction.get<Challenge>('SELECT * FROM mfa_challenges WHERE token_hash=$1 FOR UPDATE', [hash(token)]);
        const factor = await transaction.get<Factor>('SELECT * FROM mfa_factors WHERE account_id=$1 FOR UPDATE', [initial.account_id]);
        if (!account || !challenge || challenge.expires_at <= Date.now() || challenge.attempts >= 5 || challenge.credential_fingerprint !== account.fingerprint || !factor?.secret_encrypted || factor.version !== challenge.factor_version) {
          await transaction.run('DELETE FROM mfa_challenges WHERE token_hash=$1', [hash(token)]);
          return { expired: true as const };
        }
        if (!(await this.consume(transaction, factor, request.body?.code))) {
          await transaction.run('UPDATE mfa_challenges SET attempts=attempts+1 WHERE token_hash=$1', [hash(token)]);
          return null;
        }
        await transaction.run('DELETE FROM mfa_challenges WHERE token_hash=$1', [hash(token)]);
        const session = await this.options.issueSession(transaction, request, account, challenge.pending_password_hash, Boolean(challenge.pending_password_hash));
        return { account, session };
      });
      if (!result) throw new MfaError(401, invalid);
      if ('expired' in result) throw new MfaError(401, 'A verificação expirou. Entre novamente.', 'MFA_CHALLENGE_EXPIRED');
      await this.options.limiter.release(quota);
      this.options.setSession(response, result.session);
      const { fingerprint: _fingerprint, ...user } = result.account;
      response.json({ user });
    }));
  }
}
