import type { Database } from './database.js';

interface Limit { key: string; maximum: number }
export interface Reservation { entries: { key: string; expiresAt: number }[] }

/** Reserve before asynchronous password work; the transaction serializes quotas across connections. */
export class PersistentRateLimiter {
  constructor(private readonly database: Database, private readonly windowMs = 15 * 60 * 1000, private readonly maximumEntries = 5000) {}

  async reserve(limits: Limit[]): Promise<{ reservation: Reservation; retryAfter?: never } | { retryAfter: number; reservation?: never }> {
    return this.database.transaction(async database => {
      await database.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('facet:rate-limit'))");
      const now = Date.now();
      await database.run('DELETE FROM rate_limits WHERE expires_at <= $1', [now]);
      const entries = await Promise.all(limits.map(async limit => ({ ...limit, row: await database.get<{ count: number; expires_at: number }>('SELECT count, expires_at FROM rate_limits WHERE key = $1', [limit.key]) })));
      const retryAfter = Math.max(0, ...entries.map(({ row, maximum }) => row && row.count >= maximum ? Math.max(1, Math.ceil((row.expires_at - now) / 1000)) : 0));
      const size = (await database.get<{ size: number }>('SELECT count(*) AS size FROM rate_limits'))!.size;
      if (retryAfter || size + entries.filter(entry => !entry.row).length > this.maximumEntries) return { retryAfter: retryAfter || 60 };
      const reservation: Reservation = { entries: [] };
      for (const { key, row } of entries) {
        const expiresAt = row?.expires_at ?? now + this.windowMs;
        await database.run('INSERT INTO rate_limits (key, count, expires_at) VALUES ($1, 1, $2) ON CONFLICT(key) DO UPDATE SET count = rate_limits.count + 1', [key, expiresAt]);
        reservation.entries.push({ key, expiresAt });
      }
      return { reservation };
    });
  }

  async release(reservation: Reservation) {
    await this.database.transaction(async database => {
      await database.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('facet:rate-limit'))");
      for (const { key, expiresAt } of reservation.entries) {
        await database.run('UPDATE rate_limits SET count = count - 1 WHERE key = $1 AND expires_at = $2 AND count > 0', [key, expiresAt]);
        await database.run('DELETE FROM rate_limits WHERE key = $1 AND count = 0', [key]);
      }
    });
  }
}
