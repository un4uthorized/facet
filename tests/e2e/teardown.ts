import { dropTestDatabase } from '../postgres.js';

export default async function teardown() {
  const databaseUrl = process.env.FACET_E2E_DATABASE_URL;
  if (databaseUrl) await dropTestDatabase(databaseUrl);
}
