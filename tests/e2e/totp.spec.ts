import { apiLogin, submitLogin, submitInvitation, completeSecondFactor } from './auth-helpers';
import { expect, test, type Page } from '@playwright/test';
import { createTotp } from '../../server/totp.js';

const email = 'mfa-browser-reader@facet.test';
const password = 'Browser MFA reader password!';

async function enterCredentials(page: Page) {
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verifique sua identidade' })).toBeVisible();
}

test('MFA login requires a second factor, preserves errors and accepts one-time recovery codes', async ({ page, context }) => {
  const admin = await apiLogin(context.request, { data: { email: 'admin@facet.test', password: 'browser-admin-password' } });
  expect(admin.status()).toBe(200);
  const invitation = await context.request.post('/api/admin/users', { data: { name: 'MFA browser reader', email } });
  expect(invitation.status()).toBe(201);
  const token = (await invitation.json()).path.split('#')[1];
  const acceptance=await context.request.post('/api/invitations/accept',{data:{token,password}});
  expect(acceptance.status()).toBe(201);
  const {secret,uri,qrCode,enrollmentToken}=await acceptance.json();
  expect(uri).toContain('otpauth://totp/');expect(qrCode).toMatch(/^data:image\/png;base64,/);
  const totp=createTotp(secret,email);
  const enabled=await context.request.post('/api/auth/mfa/enrollment/confirm',{data:{enrollmentToken,code:totp.generate()}});
  expect(enabled.status()).toBe(200);
  const { recoveryCodes } = await enabled.json() as { recoveryCodes: string[] };
  expect(recoveryCodes).toHaveLength(10);
  await context.clearCookies();
  await page.goto('/login');
  await enterCredentials(page);
  expect((await context.request.get('/api/auth/me')).status()).toBe(401);
  expect((await context.cookies()).some(cookie => cookie.name === 'facet_session')).toBeFalsy();
  await expect(page.getByLabel('Código de verificação', { exact: true })).toHaveAttribute('autocomplete', 'one-time-code');
  await page.getByRole('button', { name: 'Voltar ao login', exact: true }).click();
  await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Senha', { exact: true })).toHaveValue('');
  await enterCredentials(page);
  await page.evaluate(() => {
    document.documentElement.dataset.mfaUnauthorizedCount = '0';
    window.addEventListener('facet:unauthorized', () => {
      document.documentElement.dataset.mfaUnauthorizedCount = String(Number(document.documentElement.dataset.mfaUnauthorizedCount) + 1);
    });
  });
  const validCodes = new Set([-30_000, 0, 30_000].map(offset => totp.generate({ timestamp: Date.now() + offset })));
  const incorrect = ['000000', '111111', '222222', '333333'].find(code => !validCodes.has(code))!;
  await page.getByLabel('Código de verificação', { exact: true }).fill(incorrect);
  await page.getByRole('button', { name: 'Verificar e entrar', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Código de verificação', { exact: true })).toHaveValue('');
  await expect(page.locator('html')).toHaveAttribute('data-mfa-unauthorized-count', '0');
  expect((await context.request.get('/api/auth/me')).status()).toBe(401);
  // The setup token has already been consumed. The adjacent future step is accepted once.
  await page.getByLabel('Código de verificação', { exact: true }).fill(totp.generate({ timestamp: Date.now() + 30_000 }));
  await page.getByRole('button', { name: 'Verificar e entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/docs$/);
  expect((await context.request.get('/api/auth/me')).status()).toBe(200);

  await context.request.post('/api/auth/logout');
  await page.goto('/login');
  await enterCredentials(page);
  await page.getByRole('button', { name: 'Usar código de recuperação', exact: true }).click();
  await page.getByLabel('Código de recuperação', { exact: true }).fill(recoveryCodes[0]);
  await page.getByRole('button', { name: 'Verificar e entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/docs$/);
  await context.request.post('/api/auth/logout');
  await page.goto('/login');
  await enterCredentials(page);
  await page.getByRole('button', { name: 'Usar código de recuperação', exact: true }).click();
  await page.getByLabel('Código de recuperação', { exact: true }).fill(recoveryCodes[0]);
  await page.getByRole('button', { name: 'Verificar e entrar', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await context.request.get('/api/auth/me')).status()).toBe(401);
  await page.getByLabel('Código de recuperação', { exact: true }).fill(recoveryCodes[1]);
  await page.getByRole('button', { name: 'Verificar e entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/docs$/);
});

test('an expired MFA challenge clears the second step and credentials', async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.route('**/api/auth/login', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ mfaRequired: true, challengeToken: 'fixture-expiring-challenge', expiresAt: new Date(now + 5_000).toISOString() }),
  }));
  await page.goto('/login');
  await enterCredentials(page);
  await page.clock.fastForward(5_001);
  await expect(page.getByRole('alert')).toContainText('expirou');
  await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Senha', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Código de verificação', { exact: true })).toHaveCount(0);
});
