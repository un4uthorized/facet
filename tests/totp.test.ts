import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createTotp, decryptSecret, encryptSecret, generateRecoveryCodes, generateSecret, hashRecoveryCode, parseEncryptionKey, verifyTotp } from '../server/totp.js';

const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('six-digit TOTP agrees with RFC 6238 SHA-1 vectors including dates beyond 2038', () => {
  // RFC 6238 Appendix B uses eight digits; reducing modulo 10^6 preserves its final six.
  // https://www.rfc-editor.org/rfc/rfc6238#appendix-B
  const vectors = [
    [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
    [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130'],
  ] as const;
  const totp = createTotp(rfcSecret, 'reader@example.com', 'Fixture documentation');
  for (const [seconds, expected] of vectors) {
    assert.equal(totp.generate({ timestamp: seconds * 1000 }), expected);
    assert.equal(verifyTotp(rfcSecret, expected, -1, seconds * 1000), Math.floor(seconds / 30));
  }
  assert.equal(totp.digits, 6);
  assert.equal(totp.period, 30);
  assert.match(totp.toString(), /^otpauth:\/\/totp\//);
});

test('TOTP permits one adjacent time step and rejects replay, old counters and malformed codes', () => {
  const now = 1_700_000_010_000;
  const totp = createTotp(rfcSecret, 'fixture');
  const counter = Math.floor(now / 30_000);
  for (const offset of [-1, 0, 1]) {
    const code = totp.generate({ timestamp: now + offset * 30_000 });
    assert.equal(verifyTotp(rfcSecret, code, -1, now), counter + offset);
    assert.equal(verifyTotp(rfcSecret, code, counter + offset, now), null);
  }
  assert.equal(verifyTotp(rfcSecret, totp.generate({ timestamp: now - 60_000 }), -1, now), null);
  assert.equal(verifyTotp(rfcSecret, totp.generate({ timestamp: now + 60_000 }), -1, now), null);
  for (const invalid of ['', '12345', '1234567', 'abcdef', '123 45', '１２３４５６', ' 287082']) {
    assert.equal(verifyTotp(rfcSecret, invalid, -1, now), null);
  }
  assert.equal(verifyTotp(rfcSecret, '123456', -2, now), null);
  assert.equal(verifyTotp(rfcSecret, '123456', -1, -1), null);
  assert.equal(verifyTotp(rfcSecret, '123456', -1, Number.NaN), null);
});

test('MFA secrets are random base32 values compatible with authenticator provisioning', () => {
  const first = generateSecret();
  const second = generateSecret();
  assert.match(first, /^[A-Z2-7]{32}$/);
  assert.match(second, /^[A-Z2-7]{32}$/);
  assert.notEqual(first, second);
  const uri = new URL(createTotp(first, 'reader@example.com', 'Fixture docs').toString());
  assert.equal(uri.searchParams.get('secret'), first);
  assert.equal(uri.searchParams.get('issuer'), 'Fixture docs');
});

test('encrypted MFA secrets require the original key, account and authenticated ciphertext', () => {
  const key = randomBytes(32);
  const first = encryptSecret(rfcSecret, key, 'reader-one');
  const second = encryptSecret(rfcSecret, key, 'reader-one');
  assert.notEqual(first, second);
  assert.equal(first.includes(rfcSecret), false);
  assert.equal(decryptSecret(first, key, 'reader-one'), rfcSecret);
  assert.throws(() => decryptSecret(first, key, 'reader-two'));
  assert.throws(() => decryptSecret(first, randomBytes(32), 'reader-one'));
  assert.throws(() => encryptSecret(rfcSecret, randomBytes(31), 'reader-one'));
  const parts = first.split('.');
  for (const index of [1, 2, 3]) {
    const tampered = [...parts];
    tampered[index] = (tampered[index][0] === 'A' ? 'B' : 'A') + tampered[index].slice(1);
    assert.throws(() => decryptSecret(tampered.join('.'), key, 'reader-one'));
  }
  for (const invalid of ['', 'v2.' + parts.slice(1).join('.'), first + '.extra', 'v1.invalid.invalid.invalid']) {
    assert.throws(() => decryptSecret(invalid, key, 'reader-one'));
  }
});

test('MFA encryption configuration accepts only canonical base64 keys with exactly 32 bytes', () => {
  const key = randomBytes(32);
  assert.deepEqual(parseEncryptionKey(key.toString('base64')), key);
  assert.deepEqual(parseEncryptionKey(key.toString('base64').replace(/=+$/, '')), key);
  assert.equal(parseEncryptionKey(undefined), null);
  assert.equal(parseEncryptionKey('  '), null);
  for (const invalid of ['not-a-key', randomBytes(31).toString('base64'), randomBytes(33).toString('base64'), 'A'.repeat(44)]) {
    assert.throws(() => parseEncryptionKey(invalid));
  }
});

test('recovery codes are unique random values stored as normalized hashes', () => {
  const { codes, hashes } = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.equal(new Set(hashes).size, 10);
  for (const [index, code] of codes.entries()) {
    assert.match(code, /^[A-F0-9]{6}(?:-[A-F0-9]{6}){3}$/);
    assert.match(hashes[index], /^[a-f0-9]{64}$/);
    assert.equal(hashRecoveryCode(code.toLowerCase().replace(/-/g, ' ')), hashes[index]);
    assert.equal(hashRecoveryCode(code.replace(/-/g, '')), hashes[index]);
    assert.equal(hashes[index].includes(code), false);
  }
});
