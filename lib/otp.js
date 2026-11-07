// One-time codes: HOTP (RFC 4226) and TOTP (RFC 6238), computed with WebCrypto.
// This is the exact same maths Google Authenticator runs on your phone.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const HASHES = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=-]/g, '');
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index === -1) throw new Error(`"${ch}" isn't a valid character in a secret key`);
    value = ((value << 5) | index) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

// Validates and normalises an account, whatever it was imported from.
export function makeAccount({ issuer = '', name = '', secret, algorithm = 'SHA1', digits = 6, period = 30, type = 'totp', counter = 0 }) {
  const cleanSecret = String(secret ?? '').toUpperCase().replace(/[\s=-]/g, '');
  if (!cleanSecret) throw new Error('The secret key is missing');
  if (base32Decode(cleanSecret).length === 0) throw new Error('The secret key is too short');

  const algo = String(algorithm).toUpperCase().replace('-', '');
  if (algo === 'MD5') throw new Error(`${issuer || name || 'An account'} uses MD5, which browsers can't compute`);
  if (!HASHES[algo]) throw new Error(`Unknown algorithm "${algorithm}"`);

  const kind = String(type).toLowerCase();
  if (kind !== 'totp' && kind !== 'hotp') throw new Error(`Unknown code type "${type}"`);

  const digitCount = Number(digits);
  if (![6, 7, 8].includes(digitCount)) throw new Error(`Codes must be 6–8 digits, not ${digits}`);

  const seconds = Number(period);
  if (!Number.isInteger(seconds) || seconds < 1) throw new Error(`Invalid period "${period}"`);

  return {
    id: crypto.randomUUID(),
    issuer: String(issuer).trim(),
    name: String(name).trim(),
    secret: cleanSecret,
    algorithm: algo,
    digits: digitCount,
    period: seconds,
    type: kind,
    counter: Math.max(0, Math.floor(Number(counter) || 0)),
  };
}

const keyCache = new Map();

function hmacKey(secret, algorithm) {
  const id = `${algorithm}:${secret}`;
  if (!keyCache.has(id)) {
    keyCache.set(id, crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: HASHES[algorithm] }, false, ['sign']));
  }
  return keyCache.get(id);
}

export async function hotp(account, counter) {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(account.secret, account.algorithm), message));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** account.digits).padStart(account.digits, '0');
}

export function totpCounter(account, now = Date.now()) {
  return Math.floor(now / 1000 / account.period);
}

export function secondsLeft(account, now = Date.now()) {
  return account.period - ((now / 1000) % account.period);
}

// "123456" -> "123 456", "12345678" -> "1234 5678"
export function formatCode(code) {
  const half = Math.floor(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}
