import { createCipheriv, createDecipheriv, createHash, randomInt } from 'node:crypto';

/**
 * Encryption for the TOTP secret, as free functions.
 *
 * Apart from the service because the seed needs to enrol an account too, and a
 * second copy of this in a seed script is exactly how a stored secret ends up
 * in a form the running application cannot read.
 *
 * AES-256-GCM rather than plain AES: without the authentication tag, a secret
 * in the database could be swapped for one an attacker holds, and the swap
 * would go unnoticed until they signed in with it.
 */
export function encryptMfaSecret(plaintext: string, key: string): string {
  const iv = randomBytes12();
  const cipher = createCipheriv('aes-256-gcm', deriveKey(key), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

export function decryptMfaSecret(stored: string, key: string): string {
  const [iv, tag, payload] = stored.split('.');
  if (!iv || !tag || !payload) throw new Error('Stored MFA secret is malformed');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(key), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Derived from the configured key so any length works, and derived on each call
 * rather than held, so rotating the environment variable takes effect on
 * restart without a migration.
 */
function deriveKey(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

function randomBytes12(): Buffer {
  const bytes = Buffer.alloc(12);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = randomInt(256);
  return bytes;
}

export function hashMfaValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Strips the presentation so `ABCDE-FGHIJ` and `abcdefghij` are one code. */
export function canonicalRecoveryCode(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Ten characters from an alphabet with no 0/O or 1/I/L, because these get
 * written on paper and read back under pressure.
 */
export function generateRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let index = 0; index < 10; index += 1) {
    code += alphabet[randomInt(alphabet.length)];
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}
