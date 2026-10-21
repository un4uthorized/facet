import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeSecurity } from '../server/runtime-security.js';

test('production requires secure cookies and rejects an explicit insecure override', () => {
  assert.equal(runtimeSecurity({ NODE_ENV: 'production' }).secureCookies, true);
  assert.equal(runtimeSecurity({ NODE_ENV: 'production', COOKIE_SECURE: 'true' }).secureCookies, true);
  assert.throws(() => runtimeSecurity({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }), /não é permitido em produção/);
});

test('local HTTP works by default and accepts explicit secure cookies', () => {
  assert.equal(runtimeSecurity({}).secureCookies, false);
  assert.equal(runtimeSecurity({ NODE_ENV: 'development', COOKIE_SECURE: 'false' }).secureCookies, false);
  assert.equal(runtimeSecurity({ COOKIE_SECURE: 'true' }).secureCookies, true);
});

test('proxy trust is opt-in and malformed security settings fail startup', () => {
  assert.equal(runtimeSecurity({}).trustProxy, false);
  assert.equal(runtimeSecurity({ TRUST_PROXY: 'true' }).trustProxy, 1);
  assert.equal(runtimeSecurity({ TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(runtimeSecurity({ TRUST_PROXY: 'false' }).trustProxy, false);
  assert.throws(() => runtimeSecurity({ COOKIE_SECURE: 'invalid' }), /COOKIE_SECURE/);
  assert.throws(() => runtimeSecurity({ TRUST_PROXY: 'invalid' }), /TRUST_PROXY/);
});
