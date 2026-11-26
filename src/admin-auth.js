import QRCode from 'qrcode';
import { seal, unseal } from './security.js';
import { enrollmentDigits, matchTotp, newSeed, normalizeCode, periodSeconds, setupUri } from './totp.js';

const lifetime = 10 * 60_000;
const setupAttempts = 5;
const shortWindow = 10 * 60_000;
const shortLimit = 5;
const dayLimit = 30;
const activeScope = 'admin:totp';
const pendingScope = (owner, id) => `admin:totp:pending:${owner}:${id}`;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readAuth(db) {
  return db.prepare('SELECT generation, totp_secret_enc IS NOT NULL AS totp_enabled, enabled_at, totp_digits FROM admin_auth WHERE id = 1').first();
}

export const loginMode = auth => auth.totp_enabled ? 'totp' : 'password';

export function authSettings(auth) {
  return { enabled: loginMode(auth) === 'totp', enabled_at: auth.enabled_at, digits: auth.totp_enabled ? auth.totp_digits : enrollmentDigits, period: periodSeconds };
}

function formattedCode(input, digits) {
  const code = normalizeCode(input, digits);
  if (!code) throw new AuthError(400, `请输入 ${digits} 位动态验证码。`);
  return code;
}

export async function startTotpSetup(env, auth, owner, hostname) {
  if (loginMode(auth) === 'totp') throw new AuthError(409, '动态验证码已经启用。');
  const seed = newSeed();
  const id = crypto.randomUUID();
  const uri = setupUri(seed, hostname);
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 4, errorCorrectionLevel: 'M' });
  const qr = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  const at = Date.now();
  const expiresAt = at + lifetime;
  const secret = await seal(seed, pendingScope(owner, id), env);
  const updated = await env.DB.prepare(`UPDATE admin_auth SET pending_id = ?, pending_owner = ?, pending_secret_enc = ?,
    pending_expires_at = ?, totp_digits = ?, pending_attempts = 0 WHERE id = 1 AND generation = ? AND totp_secret_enc IS NULL`)
    .bind(id, owner, secret, expiresAt, enrollmentDigits, auth.generation).run();
  if (!updated.meta.changes) throw new AuthError(409, '登录方式已变化，请刷新页面。');
  return { id, seed, uri, qr, expires_at: expiresAt, digits: enrollmentDigits, period: periodSeconds };
}

export async function cancelTotpSetup(db, owner, id) {
  await db.prepare(`UPDATE admin_auth SET pending_id = NULL, pending_owner = NULL, pending_secret_enc = NULL,
    pending_expires_at = 0, pending_attempts = 0 WHERE id = 1 AND pending_owner = ? AND pending_id = ?`)
    .bind(owner, id).run();
}

export async function confirmTotpSetup(env, auth, owner, id, input) {
  const code = formattedCode(input, auth.totp_digits);
  const at = Date.now();
  const pending = await env.DB.prepare(`UPDATE admin_auth SET pending_attempts = pending_attempts + 1
    WHERE id = 1 AND generation = ? AND totp_secret_enc IS NULL AND pending_owner = ? AND pending_id = ?
    AND pending_expires_at > ? AND pending_attempts < ? RETURNING pending_secret_enc`)
    .bind(auth.generation, owner, id, at, setupAttempts).first();
  if (!pending) throw new AuthError(409, '绑定已失效或验证次数用完，请重新生成二维码。');
  const seed = await unseal(pending.pending_secret_enc, pendingScope(owner, id), env);
  const step = matchTotp(seed, code, at, auth.totp_digits);
  if (step === null) throw new AuthError(422, '验证码不正确，请用验证器生成的新验证码重试。');
  const secret = await seal(seed, activeScope, env);
  const promoted = await env.DB.prepare(`UPDATE admin_auth SET generation = generation + 1, totp_secret_enc = ?,
    enabled_at = ?, last_step = ?, short_window = -1, short_attempts = 0, day_window = -1, day_attempts = 0,
    pending_id = NULL, pending_owner = NULL, pending_secret_enc = NULL, pending_expires_at = 0, pending_attempts = 0
    WHERE id = 1 AND generation = ? AND totp_secret_enc IS NULL AND pending_owner = ? AND pending_id = ? AND pending_expires_at > ?
    RETURNING generation, totp_secret_enc IS NOT NULL AS totp_enabled, enabled_at, totp_digits`)
    .bind(secret, at, step, auth.generation, owner, id, Date.now()).first();
  if (!promoted) throw new AuthError(409, '绑定已失效，请刷新页面后重试。');
  return promoted;
}

export async function verifyTotpLogin(env, auth, input) {
  const code = formattedCode(input, auth.totp_digits);
  const at = Date.now();
  const bucket = Math.floor(at / shortWindow);
  const day = Math.floor(at / 86_400_000);
  const reserved = await env.DB.prepare(`UPDATE admin_auth SET
    short_attempts = CASE WHEN short_window = ? THEN short_attempts + 1 ELSE 1 END, short_window = ?,
    day_attempts = CASE WHEN day_window = ? THEN day_attempts + 1 ELSE 1 END, day_window = ?
    WHERE id = 1 AND generation = ? AND totp_secret_enc IS NOT NULL
    AND (short_window <> ? OR short_attempts < ?) AND (day_window <> ? OR day_attempts < ?) RETURNING totp_secret_enc`)
    .bind(bucket, bucket, day, day, auth.generation, bucket, shortLimit, day, dayLimit).first();
  if (!reserved) throw new AuthError(429, '验证码尝试次数过多，请稍后重试。');
  const seed = await unseal(reserved.totp_secret_enc, activeScope, env);
  const step = matchTotp(seed, code, at, auth.totp_digits);
  if (step === null) throw new AuthError(401, '验证码不正确，请检查验证器当前显示的动态验证码。');
  const updated = await env.DB.prepare(`UPDATE admin_auth SET last_step = ?, short_attempts = 0, day_attempts = 0
    WHERE id = 1 AND generation = ? AND last_step < ?`).bind(step, auth.generation, step).run();
  if (!updated.meta.changes) throw new AuthError(401, '该验证码已使用，请等待下一组验证码。');
}
