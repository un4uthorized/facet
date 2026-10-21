import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrateSqlite } from '../server/migrate-sqlite.js';
import { createTestDatabase } from './postgres.js';

const tables = ['users', 'invitations', 'settings', 'sessions', 'rate_limits'] as const;
const passwordHash = `scrypt$${'a'.repeat(32)}$${'b'.repeat(128)}`;
const userSessionHash = 'c'.repeat(64);
const adminSessionHash = 'd'.repeat(64);
const invitationHash = 'e'.repeat(64);
const adminFingerprint = 'f'.repeat(128);
const createdAt = '2026-10-20T12:00:00.000Z';
const expiresAt = 1_900_000_000_000;
const counts = { users: 1, invitations: 1, settings: 2, sessions: 2, rate_limits: 1 };

async function fixture(options: { legacyNames?: boolean; invalidSession?: boolean } = {}) {
  const destination = await createTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), 'facet-migration-'));
  const sourcePath = join(directory, 'source.sqlite');
  const source = new DatabaseSync(sourcePath);
  try {
    const nameColumn = options.legacyNames ? '' : 'name TEXT NOT NULL,';
    source.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, ${nameColumn} email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        active INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT
      );
      CREATE TABLE invitations (
        id TEXT PRIMARY KEY, ${nameColumn} email TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT, admin_fingerprint TEXT, expires_at INTEGER NOT NULL);
      CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    `);
    if (options.legacyNames) {
      source.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)').run('reader-id', 'legacy.reader@example.com', passwordHash, 1, createdAt, createdAt, createdAt);
      source.prepare('INSERT INTO invitations VALUES (?, ?, ?, ?, ?)').run('invite-id', 'legacy.invited@example.com', invitationHash, createdAt, expiresAt);
    } else {
      source.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('reader-id', 'Preserved reader', 'legacy.reader@example.com', passwordHash, 1, createdAt, createdAt, createdAt);
      source.prepare('INSERT INTO invitations VALUES (?, ?, ?, ?, ?, ?)').run('invite-id', 'Preserved invitation', 'legacy.invited@example.com', invitationHash, createdAt, expiresAt);
    }
    source.prepare('INSERT INTO settings VALUES (?, ?)').run('documentation', JSON.stringify({ title: 'Preserved docs', logoUrl: 'https://example.com/logo.svg' }));
    source.prepare('INSERT INTO settings VALUES (?, ?)').run('pages', JSON.stringify({ revision: 7, pages: [] }));
    source.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(userSessionHash, options.invalidSession ? 'missing-user' : 'reader-id', null, expiresAt);
    source.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(adminSessionHash, null, adminFingerprint, expiresAt);
    source.prepare('INSERT INTO rate_limits VALUES (?, ?, ?)').run('login:account:audit-fixture', 7, expiresAt);
  } finally { source.close(); }
  const originalBytes = await readFile(sourcePath);
  const pool = new Pool({ connectionString: destination.databaseUrl });
  return {
    sourcePath, databaseUrl: destination.databaseUrl, originalBytes, pool,
    assertSourcePreserved: async () => assert.deepEqual(await readFile(sourcePath), originalBytes),
    dispose: async () => {
      try { await pool.end(); }
      finally { await destination.drop(); await rm(directory, { recursive: true, force: true }); }
    },
  };
}

test('SQLite migration preserves all five tables, credential hashes, sessions and source bytes', async () => {
  const app = await fixture();
  try {
    assert.deepEqual(await migrateSqlite(app.sourcePath, app.databaseUrl), counts);
    for (const table of tables) {
      assert.equal(Number((await app.pool.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count), counts[table]);
    }
    assert.deepEqual((await app.pool.query('SELECT * FROM users')).rows, [{
      id: 'reader-id', name: 'Preserved reader', email: 'legacy.reader@example.com', password_hash: passwordHash,
      active: 1, mfa_pending: false, created_at: createdAt, updated_at: createdAt, last_login_at: createdAt,
    }]);
    const invitation = (await app.pool.query('SELECT * FROM invitations')).rows[0];
    assert.equal(invitation.name, 'Preserved invitation');
    assert.equal(invitation.token_hash, invitationHash);
    assert.equal(Number(invitation.expires_at), expiresAt);
    const sessions = (await app.pool.query('SELECT * FROM sessions ORDER BY token_hash')).rows;
    assert.deepEqual(sessions.map(row => ({ ...row, expires_at: Number(row.expires_at) })), [
      { token_hash: userSessionHash, user_id: 'reader-id', admin_fingerprint: null, expires_at: expiresAt },
      { token_hash: adminSessionHash, user_id: null, admin_fingerprint: adminFingerprint, expires_at: expiresAt },
    ]);
    const settings = (await app.pool.query('SELECT * FROM settings ORDER BY key')).rows;
    assert.deepEqual(settings, [
      { key: 'documentation', value: JSON.stringify({ title: 'Preserved docs', logoUrl: 'https://example.com/logo.svg' }) },
      { key: 'pages', value: JSON.stringify({ revision: 7, pages: [] }) },
    ]);
    const limit = (await app.pool.query('SELECT * FROM rate_limits')).rows[0];
    assert.equal(limit.key, 'login:account:audit-fixture');
    assert.equal(limit.count, 7);
    assert.equal(Number(limit.expires_at), expiresAt);
    await app.assertSourcePreserved();
  } finally { await app.dispose(); }
});

test('SQLite migration rejects an occupied PostgreSQL destination without overwriting rows', async () => {
  const app = await fixture();
  try {
    await migrateSqlite(app.sourcePath, app.databaseUrl);
    await app.pool.query('UPDATE users SET name = $1', ['Existing destination owner']);
    const before = await Promise.all(tables.map(async table => (await app.pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows));
    await assert.rejects(() => migrateSqlite(app.sourcePath, app.databaseUrl), /destino deve estar vazio/);
    const after = await Promise.all(tables.map(async table => (await app.pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows));
    assert.deepEqual(after, before);
    await app.assertSourcePreserved();
  } finally { await app.dispose(); }
});

test('SQLite migration rolls back users and settings when a session violates the foreign key', async () => {
  const app = await fixture({ invalidSession: true });
  try {
    await assert.rejects(() => migrateSqlite(app.sourcePath, app.databaseUrl), (error: unknown) => {
      assert.equal((error as { code?: string }).code, '23503');
      return true;
    });
    for (const table of tables) {
      assert.equal(Number((await app.pool.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count), 0);
    }
    await app.assertSourcePreserved();
  } finally { await app.dispose(); }
});

test('SQLite migration supplies names for legacy user and invitation tables without a name column', async () => {
  const app = await fixture({ legacyNames: true });
  try {
    assert.deepEqual(await migrateSqlite(app.sourcePath, app.databaseUrl), counts);
    assert.equal((await app.pool.query('SELECT name FROM users')).rows[0].name, 'legacy.reader');
    assert.equal((await app.pool.query('SELECT name FROM invitations')).rows[0].name, 'legacy.invited');
    assert.equal((await app.pool.query('SELECT password_hash FROM users')).rows[0].password_hash, passwordHash);
    await app.assertSourcePreserved();
  } finally { await app.dispose(); }
});
