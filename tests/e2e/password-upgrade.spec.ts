import { apiLogin, submitLogin, submitInvitation, completeSecondFactor } from './auth-helpers';
import { expect, test } from '@playwright/test';
import { scryptSync, randomBytes } from 'node:crypto';
import { createTotp } from '../../server/totp';
import { Pool } from 'pg';

test('a legacy short password requires an upgrade before opening the documentation', async ({ page, context }) => {
  const email = 'legacy-password@facet.test';
  const admin = await apiLogin(context.request, { data: { email: 'admin@facet.test', password: 'browser-admin-password' } });
  expect(admin.status()).toBe(200);
  const invitation = await context.request.post('/api/admin/users', { data: { name: 'Legacy reader', email } });
  expect(invitation.status()).toBe(201);
  const token = (await invitation.json()).path.split('#')[1];
  const accepted = await context.request.post('/api/invitations/accept', { data: { token, password: 'initial-strong-password' } });
  expect(accepted.status()).toBe(201);
  const enrollment=await accepted.json();
  expect((await context.request.post('/api/auth/mfa/enrollment/confirm',{data:{enrollmentToken:enrollment.enrollmentToken,code:createTotp(enrollment.secret,'Fixture').generate()}})).status()).toBe(200);
  const databaseUrl = process.env.FACET_E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing isolated PostgreSQL E2E schema URL');
  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const salt = randomBytes(16).toString('hex');
    const key = scryptSync('x', salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    await database.query('UPDATE users SET password_hash = $1 WHERE email = $2', [`scrypt$${salt}$${key.toString('hex')}`, email]);
  } finally { await database.end(); }
  await context.clearCookies();
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill('x');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByLabel('Nova senha', { exact: true })).toBeVisible();
  expect((await context.request.get('/api/auth/me')).status()).toBe(401);
  await page.getByLabel('Nova senha', { exact: true }).fill('upgraded-secure-password');
  await page.getByRole('button', { name: 'Atualizar senha e entrar', exact: true }).click();
  await completeSecondFactor(page,email);
  await expect(page).toHaveURL(/\/docs$/);
  expect((await context.request.get('/api/auth/me')).status()).toBe(200);
  const oldPassword = await apiLogin(context.request, { data: { email, password: 'x' } });
  expect(oldPassword.status()).toBe(401);
});
