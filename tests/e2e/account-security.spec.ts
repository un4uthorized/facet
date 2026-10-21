import { apiLogin, submitLogin, submitInvitation, completeSecondFactor } from './auth-helpers';
import { expect, test } from '@playwright/test';
import { createTotp } from '../../server/totp.js';

test('invitation requires a password followed by TOTP before activating the account',async({page,context},testInfo)=>{
 const email='account-security-reader@facet.test';const password='Account security reader password!';
 expect((await apiLogin(context.request,{data:{email:'admin@facet.test',password:'browser-admin-password'}})).status()).toBe(200);
 const invite=await context.request.post('/api/admin/users',{data:{name:'Leitor de segurança',email}});const {path}=await invite.json();
 await context.clearCookies();await page.goto('/invite'+path.slice(path.indexOf('#')));
 await page.getByLabel('Senha',{exact:true}).fill(password);
 const response=page.waitForResponse(response=>response.url().endsWith('/api/invitations/accept'));
 await page.getByRole('button',{name:'Continuar para o autenticador',exact:true}).click();
 const enrollment=await (await response).json();
 expect(enrollment.user.active).toBe(false);expect(enrollment.user.status).toBe('mfa_pending');
 expect((await context.request.get('/api/auth/me')).status()).toBe(401);
 await expect(page.getByRole('heading',{name:'Cadastre seu autenticador'})).toBeVisible();
 await expect(page.getByAltText('QR code para configurar o aplicativo autenticador')).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('mandatory-enrollment.png')});
 await page.getByLabel('Código do aplicativo',{exact:true}).fill(createTotp(enrollment.secret,'Fixture').generate());
 await page.getByRole('button',{name:'Confirmar autenticador e ativar',exact:true}).click();
 await expect(page.locator('.security-recovery__codes code')).toHaveCount(10);
 expect((await context.request.get('/api/auth/me')).status()).toBe(401);
 await page.getByRole('button',{name:'Guardei os códigos',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Sua conta está pronta'})).toBeVisible();
 expect((await apiLogin(context.request,{data:{email,password}})).status()).toBe(200);
 await page.goto('/account/security');
 await expect(page.locator('.security-status')).toHaveText('Ativada');
 await expect(page.getByRole('button',{name:'Desativar',exact:true})).toHaveCount(0);
 expect((await context.request.post('/api/auth/mfa/disable',{data:{password,code:'invalid'}})).status()).toBe(403);
});

test('documentation waits for bootstrap with a neutral accessible loader and hides the account email', async ({ page, context }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect((await apiLogin(context.request, { data: { email: 'admin@facet.test', password: 'browser-admin-password' } })).status()).toBe(200);
  let releaseSettings!: () => void;
  const settingsReady = new Promise<void>(resolve => { releaseSettings = resolve; });
  await page.route('**/api/documentation/settings', async route => { await settingsReady; await route.continue(); });
  try {
    await page.goto('/docs');
    await expect(page.locator('.docs-stage')).toHaveAttribute('inert', '');
    await expect(page.locator('.docs-stage')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.page-loading.is-active')).toBeVisible();
    expect(await page.locator('#root').ariaSnapshot()).toBe('- status: Abrindo documentação…');
    expect(await page.locator('.page-loading.is-active').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s');
    await page.screenshot({ path: testInfo.outputPath('documentation-loading.png'), animations: 'disabled' });
  } finally { releaseSettings(); }
  await expect(page.locator('.docs-stage')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.docs-stage')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('.docs-stage')).not.toHaveAttribute('inert');
  await expect(page.locator('.page-loading.is-active')).toHaveCount(0);
  await expect(page.locator('.docs-account summary')).toContainText('adminstrador');
  await page.locator('.docs-account summary').click();
  await expect(page.locator('.docs-account')).not.toContainText('admin@facet.test');
  await expect(page.getByRole('link', { name: 'Segurança da conta', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('documentation-account.png'), animations: 'disabled' });
});
