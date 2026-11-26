import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Miniflare } from 'miniflare';
import worker from '../src/index.js';
import { seal } from '../src/security.js';
import { matchTotp, newSeed } from '../src/totp.js';

const rfcSeed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
for (const [time, code] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
  assert.equal(matchTotp(rfcSeed, code, time * 1000, 8), Math.floor(time / 30));
}
assert.match(newSeed(), /^[A-Z2-7]{32}$/);

function referenceCode(seed, now, digits = 6) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let packed = 0n;
  for (const char of seed) packed = (packed << 5n) | BigInt(alphabet.indexOf(char));
  const key = Buffer.from(packed.toString(16).padStart(40, '0'), 'hex');
  const counter = Math.floor(now / 30_000).toString(16).padStart(16, '0');
  const digest = createHmac('sha1', key).update(Buffer.from(counter, 'hex')).digest();
  const position = digest[19] & 15;
  return String((digest.readUInt32BE(position) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0');
}

const emulator = new Miniflare({ workers: [{ config: {
  name: 'test', compatibilityDate: '2026-11-25', env: { DB: { type: 'd1', id: 'auth-test-db' } },
  manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response() } }' } } },
} }] });
const db = await emulator.getD1Database('DB');
for (const migration of ['0001_initial', '0002_notifications', '0003_schedule_and_channels', '0004_admin_totp', '0005_schedule_index']) {
  const sql = await readFile(new URL(`../migrations/${migration}.sql`, import.meta.url), 'utf8');
  await db.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
}
const env = { DB: db, ADMIN_PASSWORD: randomBytes(24).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'), LOGIN_LIMIT: { limit: async () => ({ success: true }) } };
const origin = 'https://auth-test.example';
const realNow = Date.now;
let tick = Date.parse('2026-11-26T02:32:02Z');
Date.now = () => tick;

function send(path, method = 'GET', cookie, body, requestOrigin = origin, ip = '192.0.2.1') {
  const headers = { Origin: requestOrigin, 'CF-Connecting-IP': ip };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(`${origin}/api${path}`, { method, headers, ...(body && { body: JSON.stringify(body) }) }), env);
}
async function payload(response, status = 200) {
  const data = await response.json();
  assert.equal(response.status, status, data.error ?? 'Unexpected HTTP status');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return data;
}
function cookieFrom(response) {
  const header = response.headers.get('Set-Cookie');
  assert.match(header, /^__Host-skyland-admin=.*HttpOnly; SameSite=Strict; .*Secure$/);
  return header.split(';')[0];
}

try {
  const legacySeed = newSeed();
  const legacySecret = await seal(legacySeed, 'admin:totp', env);
  await db.prepare('UPDATE admin_auth SET generation = 1, enabled_at = ?, totp_secret_enc = ? WHERE id = 1')
    .bind(tick - 60_000, legacySecret).run();
  const migration = await readFile(new URL('../migrations/0006_totp_digits.sql', import.meta.url), 'utf8');
  await db.prepare(migration).run();
  const legacyCode = referenceCode(legacySeed, tick, 8);
  await payload(await send('/session', 'POST', undefined, { code: legacyCode.slice(-6) }), 400);
  const legacyLogin = await send('/session', 'POST', undefined, { code: legacyCode });
  assert.equal((await payload(legacyLogin)).mode, 'totp');
  assert.equal((await payload(await send('/auth/totp', 'GET', cookieFrom(legacyLogin)))).digits, 8);
  await db.prepare('UPDATE admin_auth SET totp_secret_enc = NULL, generation = 0, enabled_at = NULL, last_step = -1 WHERE id = 1').run();
  assert.deepEqual(await payload(await send('/session')), { authenticated: false, mode: 'password' });
  await payload(await send('/auth/totp/setup', 'POST', undefined, { password: env.ADMIN_PASSWORD }), 401);
  const value = `${randomUUID()}.${tick + 3_600_000}`;
  const signature = createHmac('sha256', env.ADMIN_PASSWORD).update(`skyland:session:${value}`).digest('base64url');
  const original = `__Host-skyland-admin=${value}.${signature}`;
  assert.deepEqual(await payload(await send('/session', 'GET', original)), { authenticated: true, mode: 'password' });
  await payload(await send('/auth/totp/setup', 'POST', original, { password: 'incorrect' }), 422);
  assert.equal((await payload(await send('/auth/totp', 'GET', original))).enabled, false);

  const login = await send('/session', 'POST', undefined, { password: env.ADMIN_PASSWORD });
  const other = cookieFrom(login);
  assert.equal((await payload(login)).mode, 'password');
  const creation = () => send('/auth/totp/setup', 'POST', original, { password: env.ADMIN_PASSWORD });
  const first = await payload(await creation(), 201);
  assert.match(first.qr, /^data:image\/svg\+xml,/);
  const uri = new URL(first.uri);
  assert.equal(uri.protocol, 'otpauth:');
  assert.equal(uri.searchParams.get('secret'), first.seed);
  assert.equal(uri.searchParams.get('digits'), '6');
  assert.equal(uri.searchParams.get('period'), '30');
  assert.equal(uri.searchParams.get('algorithm'), 'SHA1');
  const row = await db.prepare('SELECT pending_secret_enc FROM admin_auth WHERE id = 1').first();
  assert(!row.pending_secret_enc.includes(first.seed));
  const confirm = (setup, cookie = original) => send('/auth/totp/confirm', 'POST', cookie, { id: setup.id, code: referenceCode(setup.seed, tick) });
  await payload(await confirm(first, other), 409);
  await payload(await send(`/auth/totp/setup/${first.id}`, 'DELETE', original));
  await payload(await confirm(first), 409);
  const expired = await payload(await creation(), 201);
  await db.prepare('UPDATE admin_auth SET pending_expires_at = ? WHERE id = 1').bind(tick - 1).run();
  await payload(await confirm(expired), 409);

  const setup = await payload(await creation(), 201);
  const timeCodes = [-30_000, 0, 30_000].map(offset => referenceCode(setup.seed, tick + offset));
  const bad = ['888888', '777777', '666666', '555555'].find(value => !timeCodes.includes(value));
  await payload(await send('/auth/totp/confirm', 'POST', original, { id: setup.id, code: bad }), 422);
  const promoted = await confirm(setup);
  const current = cookieFrom(promoted);
  assert.deepEqual(await payload(promoted), { enabled: true, enabled_at: tick, digits: 6, period: 30 });
  await payload(await send('/dashboard', 'GET', original), 401);
  assert.deepEqual(await payload(await send('/session', 'GET', current)), { authenticated: true, mode: 'totp' });
  assert.deepEqual(await payload(await send('/session', 'GET', other)), { authenticated: false, mode: 'totp' });
  await payload(await send('/session', 'POST', undefined, { password: env.ADMIN_PASSWORD }), 400);
  await payload(await send('/session', 'POST', undefined, { code: timeCodes[1] }), 401);
  await payload(await send('/auth/totp/setup', 'POST', current, { password: env.ADMIN_PASSWORD }), 409);
  const active = await db.prepare('SELECT totp_secret_enc, pending_secret_enc FROM admin_auth').first();
  assert.equal(active.pending_secret_enc, null);
  assert(!active.totp_secret_enc.includes(setup.seed));
  assert.equal((await payload(await send('/dashboard', 'GET', current))).schedule.time, '07:00');

  tick += 30_000;
  const fresh = referenceCode(setup.seed, tick);
  const simultaneous = await Promise.all([send('/session', 'POST', undefined, { code: fresh }), send('/session', 'POST', undefined, { code: fresh })]);
  assert.deepEqual(simultaneous.map(r => r.status).sort(), [200, 401]);
  const nextSession = cookieFrom(simultaneous.find(r => r.status === 200));
  const invalid = (() => {
    const candidates = [-30_000, 0, 30_000].map(d => referenceCode(setup.seed, tick + d));
    return ['000000', '111111', '222222', '333333'].find(c => !candidates.includes(c));
  })();
  const failures = await Promise.all(Array.from({ length: 7 }, (_, index) => send('/session', 'POST', undefined, { code: invalid }, origin, `192.0.2.${10 + index}`)));
  assert(failures.filter(r => r.status === 429).length >= 2);
  const blocked = await send('/session', 'POST', undefined, { code: invalid }, origin, '192.0.2.90');
  await payload(blocked, 429);
  await payload(await send('/session', 'DELETE', nextSession));

  const previousPassword = env.ADMIN_PASSWORD;
  delete env.ADMIN_PASSWORD;
  assert.equal((await payload(await send('/session', 'GET', current))).authenticated, true);
  await worker.scheduled({ scheduledTime: tick }, env);
  env.ADMIN_PASSWORD = previousPassword;
  await db.prepare(`UPDATE admin_auth SET generation = generation + 1, totp_secret_enc = NULL, enabled_at = NULL WHERE id = 1`).run();
  assert.deepEqual(await payload(await send('/session', 'GET', current)), { authenticated: false, mode: 'password' });
  assert.deepEqual(await payload(await send('/session', 'GET', original)), { authenticated: false, mode: 'password' });
  const reset = await send('/session', 'POST', undefined, { password: env.ADMIN_PASSWORD });
  await payload(reset);
  assert.equal((await payload(await send('/session', 'GET', cookieFrom(reset)))).authenticated, true);
  console.log('RFC vectors and full TOTP enrollment, expiry, session rotation, anti-replay, throttling and operator reset passed.');
} finally {
  Date.now = realNow;
  await emulator.dispose();
}
