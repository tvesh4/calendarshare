const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_BYTES = 32;

function getKey() {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!hex || typeof hex !== 'string') {
    throw new Error(
      'Set CREDENTIAL_ENCRYPTION_KEY to 64 hex characters (32 bytes), e.g. `openssl rand -hex 32`',
    );
  }
  const key = Buffer.from(hex.trim(), 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be exactly 64 hex characters');
  }
  return key;
}

function encryptSecret(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

function decryptSecret(stored) {
  const key = getKey();
  const parts = String(stored).split('.');
  if (parts.length !== 3) throw new Error('Invalid stored credential');
  const iv = Buffer.from(parts[0], 'base64url');
  const tag = Buffer.from(parts[1], 'base64url');
  const data = Buffer.from(parts[2], 'base64url');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret, getKey };
