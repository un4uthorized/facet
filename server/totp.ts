import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';

const period = 30;
const encryptionVersion = 'v1';

export function generateSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function createTotp(secret: string, label: string, issuer = 'Documentação'): TOTP {
  return new TOTP({ issuer, label, algorithm: 'SHA1', digits: 6, period, secret: Secret.fromBase32(secret) });
}

/** Return the matched counter so callers can persist it atomically to reject reuse. */
export function verifyTotp(secret: string, code: string, lastCounter = -1, now = Date.now()): number | null {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)
    || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(lastCounter) || lastCounter < -1) return null;
  const delta = createTotp(secret, '').validate({ token: code, timestamp: now, window: 1 });
  if (delta === null) return null;
  const counter = Math.floor(now / (period * 1000)) + delta;
  return counter >= 0 && counter > lastCounter ? counter : null;
}

export function parseEncryptionKey(value: string | undefined): Buffer | null {
  const encoded = value?.trim();
  if (!encoded) return null;
  const invalid = () => new Error('MFA_ENCRYPTION_KEY deve conter uma chave aleatória de 32 bytes em Base64.');
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(encoded)) throw invalid();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw invalid();
  return key;
}

function associatedData(accountId: string): Buffer {
  return Buffer.from(`facet:mfa:totp:${encryptionVersion}:${accountId}`, 'utf8');
}

export function encryptSecret(secret: string, key: Buffer, accountId: string): string {
  if (key.length !== 32) throw new Error('A chave de criptografia do MFA precisa ter 32 bytes.');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(associatedData(accountId));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [encryptionVersion, nonce.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

export function decryptSecret(encoded: string, key: Buffer, accountId: string): string {
  try {
    const [version, nonceText, ciphertextText, tagText, extra] = encoded.split('.');
    if (version !== encryptionVersion || extra !== undefined || !nonceText || !ciphertextText || !tagText
      || [nonceText, ciphertextText, tagText].some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Formato inválido.');
    const nonce = Buffer.from(nonceText, 'base64url');
    const ciphertext = Buffer.from(ciphertextText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    if (key.length !== 32 || nonce.length !== 12 || tag.length !== 16
      || nonce.toString('base64url') !== nonceText || ciphertext.toString('base64url') !== ciphertextText || tag.toString('base64url') !== tagText) throw new Error('Formato inválido.');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(associatedData(accountId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Não foi possível abrir o segredo de MFA com a chave e a conta configuradas.');
  }
}

export function hashRecoveryCode(code: string): string {
  const normalized = code.replace(/[-\s]/g, '').toUpperCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function generateRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: 10 }, () => randomBytes(12).toString('hex').toUpperCase().match(/.{6}/g)!.join('-'));
  return { codes, hashes: codes.map(hashRecoveryCode) };
}
