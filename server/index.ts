import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { RequestHandler } from 'express';
import { createApp } from './app.js';
import { runtimeSecurity } from './runtime-security.js';

const { production, secureCookies, trustProxy } = runtimeSecurity(process.env);
// Only the source entry starts Vite. The compiled entry always serves the build.
const development = !production && import.meta.url.endsWith('/server/index.ts');
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT deve ser uma porta válida.');

const server = createServer();
const vite = development ? await (await import('vite')).createServer({
  server: { middlewareMode: true, ws: { server } },
  appType: 'custom',
}) : null;
const clientMiddleware: RequestHandler | undefined = vite ? (request, response, next) => {
  if (['GET', 'HEAD'].includes(request.method) && ['/login', '/docs', '/admin', '/account/security'].includes(request.path)) {
    readFile(resolve('client/index.html'), 'utf8')
      .then((html) => vite.transformIndexHtml(request.originalUrl, html))
      .then((html) => response.type('html').send(html))
      .catch(next);
    return;
  }
  vite.middlewares(request, response, next);
} : undefined;

const app = await createApp({
  adminEmail: process.env.ADMIN_EMAIL ?? '',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  databaseUrl: process.env.DATABASE_URL ?? '',
  mfaEncryptionKey: process.env.MFA_ENCRYPTION_KEY,
  secureCookies,
  requireHttps: production,
  trustProxy,
  clientDirectory: resolve('build/client'),
  documentationDirectory: resolve('documentation'),
  clientMiddleware,
});

const host = process.env.HOST ?? '127.0.0.1';
server.on('request', app);
server.listen(port, host, () => console.log(`Facet disponível em http://${host}:${port}`));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await vite?.close();
  server.close(() => { void app.close().then(() => process.exit(0)); });
  server.closeIdleConnections();
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { void shutdown(); });
}
