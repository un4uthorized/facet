import { resolve } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Database } from './database.js';

const tables = ['users', 'invitations', 'settings', 'sessions', 'rate_limits'] as const;
type TableName = typeof tables[number];
type SourceRow = Record<string, SQLOutputValue>;
export type MigrationCounts = Record<TableName, number>;

function legacyName(row: SourceRow, hasName: boolean): string {
  if (hasName && typeof row.name === 'string' && row.name.trim()) return row.name;
  if (typeof row.email !== 'string') throw new Error('A origem contém uma conta sem e-mail válido.');
  return row.email.split('@')[0];
}

/** Copy an SQLite snapshot into an empty PostgreSQL destination, without modifying the source. */
export async function migrateSqlite(sourcePath: string, databaseUrl: string): Promise<MigrationCounts> {
  if (!sourcePath?.trim()) throw new Error('Informe o caminho do arquivo SQLite de origem.');
  if (!databaseUrl?.trim()) throw new Error('DATABASE_URL é obrigatória para a migração.');
  const source = new DatabaseSync(resolve(sourcePath), { readOnly: true });
  let destination: Database | undefined;
  try {
    // Keep every table in the same read-only snapshot, including databases using WAL.
    source.exec('BEGIN');
    const sourceTables = new Set((source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(table => table.name));
    if (!sourceTables.has('users')) throw new Error('A origem não contém a tabela users do portal.');
    destination = Database.connect(databaseUrl);
    await destination.initialize();
    return await destination.transaction(async transaction => {
      // Prevent concurrent writes between checking the empty destination and copying data.
      await transaction.query('LOCK TABLE users, invitations, settings, sessions, rate_limits IN ACCESS EXCLUSIVE MODE');
      for (const table of tables) {
        const occupied = await transaction.get<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${table}) AS present`);
        if (occupied?.present) throw new Error('O PostgreSQL de destino deve estar vazio. Nenhum dado foi importado.');
      }
      const counts: MigrationCounts = { users: 0, invitations: 0, settings: 0, sessions: 0, rate_limits: 0 };
      for (const table of tables) {
        if (!sourceTables.has(table)) continue;
        const columns = new Set((source.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name));
        for (const row of source.prepare(`SELECT * FROM ${table}`).iterate()) {
          const item = row as SourceRow;
          if (table === 'users') {
            await transaction.run('INSERT INTO users (id, name, email, password_hash, active, created_at, updated_at, last_login_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
              [item.id, legacyName(item, columns.has('name')), item.email, item.password_hash, item.active, item.created_at, item.updated_at, item.last_login_at ?? null]);
          } else if (table === 'invitations') {
            await transaction.run('INSERT INTO invitations (id, name, email, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
              [item.id, legacyName(item, columns.has('name')), item.email, item.token_hash, item.created_at, item.expires_at]);
          } else if (table === 'settings') {
            await transaction.run('INSERT INTO settings (key, value) VALUES ($1, $2)', [item.key, item.value]);
          } else if (table === 'sessions') {
            await transaction.run('INSERT INTO sessions (token_hash, user_id, admin_fingerprint, expires_at) VALUES ($1, $2, $3, $4)',
              [item.token_hash, item.user_id, item.admin_fingerprint, item.expires_at]);
          } else {
            await transaction.run('INSERT INTO rate_limits (key, count, expires_at) VALUES ($1, $2, $3)', [item.key, item.count, item.expires_at]);
          }
          counts[table] += 1;
        }
      }
      return counts;
    });
  } finally {
    try { source.close(); }
    finally { await destination?.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const sourcePath = process.argv[2];
  if (!sourcePath || process.argv.length !== 3) {
    console.error('Uso: npm run migrate:sqlite -- /caminho/para/facet.sqlite');
    process.exitCode = 1;
  } else {
    try {
      const counts = await migrateSqlite(sourcePath, process.env.DATABASE_URL ?? '');
      console.log('Migração concluída. O arquivo SQLite de origem foi preservado.', counts);
    } catch (error) {
      console.error('Migração não concluída:', error instanceof Error ? error.message : 'Erro desconhecido.');
      process.exitCode = 1;
    }
  }
}
