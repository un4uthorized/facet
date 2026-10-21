import { Pool, types, type PoolClient, type QueryResult } from 'pg';

export class Database {
  private constructor(private readonly connection: Pool | PoolClient, private readonly pool?: Pool) {}

  static connect(databaseUrl: string) {
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL deve ser uma URL PostgreSQL válida.');
    const pool = new Pool({
      connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
      types: { getTypeParser: (oid: number, format?: string) => oid === 20 ? Number : types.getTypeParser(oid, format as 'text') },
    });
    pool.on('error', () => console.error('Falha em uma conexão ociosa com PostgreSQL.'));
    return new Database(pool, pool);
  }

  query(sql: string, values: unknown[] = []): Promise<QueryResult> { return this.connection.query(sql, values); }
  async get<T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T | undefined> { return (await this.query(sql, values)).rows[0] as T | undefined; }
  async all<T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T[]> { return (await this.query(sql, values)).rows as T[]; }
  async run(sql: string, values: unknown[] = []) { return { changes: (await this.query(sql, values)).rowCount ?? 0 }; }

  async transaction<T>(work: (transaction: Database) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error('Transações aninhadas não são permitidas.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new Database(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async initialize() {
    await this.transaction(async database => {
      await database.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('facet:migrations'))");
      await database.query(`
        CREATE TABLE IF NOT EXISTS invitations (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL, expires_at BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
          active SMALLINT NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          admin_fingerprint TEXT, expires_at BIGINT NOT NULL,
          CHECK ((user_id IS NOT NULL AND admin_fingerprint IS NULL) OR (user_id IS NULL AND admin_fingerprint IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at BIGINT NOT NULL);
        CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at);
        CREATE TABLE IF NOT EXISTS mfa_factors (
          account_id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          secret_encrypted TEXT, pending_encrypted TEXT, pending_expires_at BIGINT, pending_fingerprint TEXT,
          last_counter BIGINT NOT NULL DEFAULT -1, recovery_hashes JSONB NOT NULL DEFAULT '[]',
          version TEXT NOT NULL,
          CHECK ((account_id = 'admin' AND user_id IS NULL) OR (user_id IS NOT NULL AND account_id = user_id))
        );
        CREATE TABLE IF NOT EXISTS mfa_challenges (
          token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES mfa_factors(account_id) ON DELETE CASCADE,
          credential_fingerprint TEXT NOT NULL, factor_version TEXT NOT NULL,
          pending_password_hash TEXT, expires_at BIGINT NOT NULL, attempts SMALLINT NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS mfa_challenges_expiry ON mfa_challenges(expires_at);
        CREATE INDEX IF NOT EXISTS mfa_challenges_account ON mfa_challenges(account_id);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_pending BOOLEAN NOT NULL DEFAULT false;
        CREATE TABLE IF NOT EXISTS mfa_enrollments (
          token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE REFERENCES mfa_factors(account_id) ON DELETE CASCADE,
          credential_fingerprint TEXT NOT NULL, pending_password_hash TEXT, expires_at BIGINT NOT NULL, attempts SMALLINT NOT NULL DEFAULT 0
        );
      `);
    });
  }

  async close() { await this.pool?.end(); }
}
