import { apiLogin, submitLogin, submitInvitation, completeSecondFactor } from './auth-helpers';
import { expect, test, type Page, type BrowserContext } from '@playwright/test';

function spec(path = '/service/ping', server?: string) {
  return {
    openapi: '3.0.3', info: { title: 'Explorer security fixture', version: '1.0' },
    ...(server ? { servers: [{ url: server }] } : {}),
    paths: {
      [path]: { post: { tags: ['__proto__'], summary: 'Security request', responses: { '200': { description: 'OK' } }, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string', example: 'Security fixture' }, email: { type: 'string', example: 'security-fixture@facet.test' } } } } } } } },
      '/other': { get: { tags: ['constructor'], summary: 'Other request', responses: { '200': { description: 'OK' } } } },
    },
  };
}

async function openExplorer(page: Page, context: BrowserContext, source = spec()) {
  const login = await apiLogin(context.request, { data: { email: 'admin@facet.test', password: 'browser-admin-password' } });
  expect(login.ok()).toBeTruthy();
  const publication = await context.request.put('/api/admin/documentation/openapi', { data: { source: JSON.stringify(source), sourceName: 'security-fixture.json' } });
  expect(publication.ok()).toBeTruthy();
  await page.goto('/docs');
  await expect(page.locator('[data-nav-tag="__proto__"]')).toBeVisible();
  await expect(page.locator('[data-nav-tag="constructor"]')).toBeVisible();
  await page.locator('[data-try-operation]').click();
}

test('Explorer blocks internal portal URLs, including encoded traversal', async ({ page, context, baseURL }) => {
  await openExplorer(page, context, spec('/api/admin/users'));
  const explorerRequests: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') explorerRequests.push(request.url()); });
  const paths = ['/api/admin/users', '/API/admin/users', '/%61pi/admin/users', '/%2561pi/admin/users', '/public/../api/admin/users', '/public%2f..%2fapi/admin/users', '/%5capi/admin/users', '/admin', '/login', '/invite', '/docs-assets/sample-openapi.json'];
  for (const path of paths) {
    await page.locator('#request-url').fill(baseURL + path);
    await page.locator('#send-request').click();
    await expect(page.locator('#response-network-detail')).toContainText('rotas internas');
    await expect(page.locator('#send-request')).toBeEnabled();
  }
  expect(explorerRequests).toEqual([]);
  const users = await context.request.get('/api/admin/users');
  expect((await users.json()).users.some((user: { email: string }) => user.email === 'security-fixture@facet.test')).toBeFalsy();
});

test('Explorer omits browser cookies while preserving intentional API credentials', async ({ page, context, baseURL }) => {
  await openExplorer(page, context);
  const captured: Record<string, string>[] = [];
  await page.route('**/service/ping', async route => {
    captured.push(await route.request().allHeaders());
    await route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.locator('#connection-token').fill('portal-origin-api-token');
  await page.locator('#send-request').click();
  await expect(page.locator('#response-code')).toContainText('true');
  expect(captured[0].cookie).toBeUndefined();
  expect(captured[0].authorization).toBe('Bearer portal-origin-api-token');

  await page.locator('#connection-add-header').click();
  const header = page.locator('#connection-headers .header-row').last();
  await header.getByLabel('Nome do header').fill('X-API-Key');
  await header.getByLabel('Valor do header').fill('old-api-key');
  await context.addCookies([{ name: 'external_session', value: 'should-not-send', url: 'https://api.example.test' }]);
  await page.locator('#connection-base-url').fill('https://api.example.test');
  await expect(page.locator('#connection-token')).toHaveValue('');
  await expect(page.locator('#connection-headers .header-row')).toHaveCount(1);
  await expect(page.locator('#connection-headers input').first()).toHaveValue('Accept');
  await page.locator('#connection-token').fill('new-api-token');
  await page.locator('#send-request').click();
  await expect.poll(() => captured.length).toBe(2);
  expect(captured[1].cookie).toBeUndefined();
  expect(captured[1].authorization).toBe('Bearer new-api-token');
  expect(captured[1]['x-api-key']).toBeUndefined();

  // Changing the URL directly must clear credentials before the user configures
  // a new token; changing only a path within the same origin preserves it.
  await page.locator('#request-url').fill(baseURL + '/service/ping');
  await expect(page.locator('#connection-token')).toHaveValue('');
  await page.locator('#connection-token').fill('fresh-direct-url-token');
  await page.locator('#request-url').fill(baseURL + '/service/ping?next=1');
  await expect(page.locator('#connection-token')).toHaveValue('fresh-direct-url-token');
});

test('Explorer refuses redirects before sending requests to a second destination', async ({ page, context, baseURL }) => {
  await openExplorer(page, context);
  let redirected = false;
  await page.route('**/service/ping', route => route.fulfill({ status: 307, headers: { location: baseURL + '/api/admin/users' } }));
  page.on('request', request => { if (request.url() === baseURL + '/api/admin/users' && request.method() === 'POST') redirected = true; });
  await page.locator('#send-request').click();
  await expect(page.locator('#response-network-error')).toBeVisible();
  await expect(page.locator('#send-request')).toBeEnabled();
  expect(redirected).toBeFalsy();
});

test('Replacing a specification clears API credentials even for the same origin', async ({ page, context }) => {
  await openExplorer(page, context, spec('/service/ping', 'https://api.example.test'));
  await page.locator('#connection-token').fill('old-spec-token');
  await page.evaluate(() => (document.querySelector('#import-dialog') as HTMLDialogElement).showModal());
  await page.locator('[data-import-tab="paste"]').click();
  await page.locator('#spec-paste').fill(JSON.stringify(spec('/replacement', 'https://api.example.test')));
  await page.locator('#load-spec').click();
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(page.locator('#connection-token')).toHaveValue('');
  await expect(page.locator('#auth-token')).toHaveValue('');
  await expect(page.locator('#connection-headers .header-row')).toHaveCount(1);
});
