import { createHmac, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const digits = 8;
export const periodSeconds = 30;

export function newSeed() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0;
  let buffer = 0;
  let seed = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      seed += alphabet[(buffer >>> bits) & 31];
    }
  }
  return seed;
}

function seedBytes(seed) {
  if (!/^[A-Z2-7]{32}$/.test(seed)) throw new Error('Invalid TOTP seed');
  const result = Buffer.alloc(20);
  let bits = 0;
  let buffer = 0;
  let offset = 0;
  for (const character of seed) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits < 8) continue;
    bits -= 8;
    result[offset++] = (buffer >>> bits) & 255;
  }
  return result;
}

export function normalizeCode(input) {
  if (typeof input !== 'string' || input.length > 24) return '';
  const stripped = input.replace(/\s/g, '');
  return /^\d{8}$/.test(stripped) ? stripped : '';
}

function generateCode(key, step) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits);
  return String(value).padStart(digits, '0');
}

export function matchTotp(seed, code, now = Date.now()) {
  const key = seedBytes(seed);
  const entered = Buffer.from(code);
  const step = Math.floor(now / (periodSeconds * 1000));
  let matched = null;
  for (const candidate of [step - 1, step, step + 1]) {
    if (candidate < 0) continue;
    const expected = Buffer.from(generateCode(key, candidate));
    if (entered.length === expected.length && timingSafeEqual(entered, expected)) matched = candidate;
  }
  return matched;
}

export function setupUri(seed, hostname) {
  const issuer = 'Skyland Sign';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(`admin@${hostname}`)}`;
  const parameters = new URLSearchParams({ secret: seed, issuer, algorithm: 'SHA1', digits: String(digits), period: String(periodSeconds) });
  return `otpauth://totp/${label}?${parameters}`;
}
