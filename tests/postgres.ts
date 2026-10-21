import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const testSchemaPattern = /^facet_test_[a-f0-9]{32}$/;

function testServerUrl(): URL {
  const source = process.env.TEST_DATABASE_URL;
  if (!source) {
    throw new Error('Defina TEST_DATABASE_URL para um PostgreSQL de testes. Inicie o serviço postgres com podman-compose ou use um PostgreSQL local; os testes criam schemas isolados e nunca usam DATABASE_URL como alternativa.');
  }
  let url: URL;
  try { url = new URL(source); }
  catch { throw new Error('TEST_DATABASE_URL precisa ser uma URL PostgreSQL válida.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('TEST_DATABASE_URL precisa usar postgres:// ou postgresql://.');
  return url;
}

function normalizedServer(url: URL): string {
  const normalized = new URL(url);
  normalized.searchParams.delete('options');
  return normalized.href;
}

export async function createTestDatabase(): Promise<{ databaseUrl: string; drop: () => Promise<void> }> {
  const serverUrl = testServerUrl();
  const schema = `facet_test_${randomUUID().replace(/-/g, '')}`;
  const pool = new Pool({ connectionString: serverUrl.href, max: 1, connectionTimeoutMillis: 10_000 });
  try { await pool.query(`CREATE SCHEMA "${schema}"`); }
  catch (error) {
    throw new Error('Não foi possível criar o schema de testes. Confira TEST_DATABASE_URL e se o PostgreSQL de testes está disponível e permite CREATE SCHEMA.', { cause: error });
  } finally { await pool.end(); }
  const databaseUrl = new URL(serverUrl);
  // No public fallback: every unqualified application table belongs to this run.
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  let dropped = false;
  return {
    databaseUrl: databaseUrl.href,
    drop: async () => {
      if (dropped) return;
      await dropTestDatabase(databaseUrl.href);
      dropped = true;
    },
  };
}

export function validateTestDatabaseUrl(databaseUrl: string): string {
  const serverUrl = testServerUrl();
  const isolatedUrl = new URL(databaseUrl);
  const options = isolatedUrl.searchParams.get('options') ?? '';
  const schema = options.startsWith('-c search_path=') ? options.slice('-c search_path='.length) : '';
  if (!testSchemaPattern.test(schema) || normalizedServer(isolatedUrl) !== normalizedServer(serverUrl)) {
    throw new Error('Banco de testes inválido: o schema precisa ter o prefixo facet_test_ e pertencer ao servidor configurado em TEST_DATABASE_URL.');
  }
  return schema;
}

export async function dropTestDatabase(databaseUrl: string): Promise<void> {
  const schema = validateTestDatabaseUrl(databaseUrl);
  const serverUrl = testServerUrl();
  const pool = new Pool({ connectionString: serverUrl.href, max: 1, connectionTimeoutMillis: 10_000 });
  try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { await pool.end(); }
}
