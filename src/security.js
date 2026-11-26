import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const secureCookieName = '__Host-skyland-admin';
const localCookieName = 'skyland-local-admin';
const sessionSeconds = 12 * 60 * 60;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encryptionReady(env) {
  return /^[a-f0-9]{64}$/i.test(env.ENCRYPTION_KEY ?? '');
}

export function passwordReady(env) {
  return typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.length >= 24 && env.ADMIN_PASSWORD.length <= 256 &&
    env.ADMIN_PASSWORD !== env.ENCRYPTION_KEY;
}

export function verifyPassword(input, expected) {
  const hash = value => createHash('sha256').update(value).digest();
  return typeof input === 'string' && timingSafeEqual(hash(input), hash(expected));
}

function sessionSignature(value, env, auth) {
  if (auth.generation === 0) return createHmac('sha256', env.ADMIN_PASSWORD).update(`skyland:session:${value}`).digest('base64url');
  const mode = auth.totp_enabled ? 'totp' : 'password';
  const key = auth.totp_enabled
    ? createHmac('sha256', Buffer.from(env.ENCRYPTION_KEY, 'hex')).update('skyland:admin-session-key').digest()
    : env.ADMIN_PASSWORD;
  return createHmac('sha256', key).update(`skyland:session:v2:${auth.generation}:${mode}:${value}`).digest('base64url');
}

export function trustedOrigin(url) {
  return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function sessionCookie(url, env, auth, clear = false) {
  const secure = url.protocol === 'https:';
  const name = secure ? secureCookieName : localCookieName;
  const value = `${crypto.randomUUID()}.${Date.now() + sessionSeconds * 1000}`;
  const session = clear ? '' : `${value}.${sessionSignature(value, env, auth)}`;
  return `${name}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : sessionSeconds}${secure ? '; Secure' : ''}`;
}

export function readSession(request, url, env, auth) {
  const name = url.protocol === 'https:' ? secureCookieName : localCookieName;
  const cookie = (request.headers.get('Cookie') ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  const parts = (cookie ?? '').slice(name.length + 1).split('.');
  const [id, expiresAt, signature] = parts;
  if (parts.length !== 3 || !/^[a-f0-9-]{36}$/.test(id) || !/^\d{13}$/.test(expiresAt) || Number(expiresAt) <= Date.now()) return null;
  const expected = sessionSignature(`${id}.${expiresAt}`, env, auth);
  return verifyPassword(signature, expected) ? id : null;
}

async function encryptionKey(env) {
  return crypto.subtle.importKey('raw', Buffer.from(env.ENCRYPTION_KEY, 'hex'), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(value, scope, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: textEncoder.encode(scope) },
    await encryptionKey(env), textEncoder.encode(value));
  return `${Buffer.from(iv).toString('base64url')}.${Buffer.from(ciphertext).toString('base64url')}`;
}

export async function unseal(value, scope, env) {
  const [iv, ciphertext] = value.split('.').map(x => Buffer.from(x, 'base64url'));
  return textDecoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: textEncoder.encode(scope) },
    await encryptionKey(env), ciphertext));
}

export function accountKey(value) {
  return createHash('sha256').update(`skyland:account:${value}`).digest('base64url');
}
