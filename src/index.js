import QRCode from 'qrcode';
import { hasProvider, listNotifications, NotificationError, removeNotification, saveNotification, sendSignNotifications, testNotification } from './notifications.js';
import { accountKey, encryptionReady, passwordReady, readSession, seal, sessionCookie, trustedOrigin, unseal, verifyPassword } from './security.js';
import { AuthError, authSettings, cancelTotpSetup, confirmTotpSetup, loginMode, readAuth, startTotpSetup, verifyTotpLogin } from './admin-auth.js';
import { authorize, listRoles, scanStatus, signRole, SklandError, startScan, tokenFromScan } from './skland.js';
import { chinaMinute, dayInChina, describeSchedule, nextScheduledAccount, parseTime, readSchedule, saveSchedule, scheduleStatement } from './schedule.js';

const scanLifetime = 120_000;
const runLock = 6 * 60_000;
const roleBudget = 32;
const accountIdPattern = '[A-Za-z0-9_-]{43}';
const scanIdPattern = '[a-f0-9-]{36}';

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}

async function readJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new RequestError(415, '请求格式无效。');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, '请求内容无效。');
  const decoder = new TextDecoder();
  let text = '';
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 2048) {
      await reader.cancel();
      throw new RequestError(413, '请求内容过长。');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RequestError(400, '请求内容无效。');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, '请求内容无效。');
  return body;
}

async function dashboard(env) {
  const [accounts, runs, schedule] = await env.DB.batch([
    env.DB.prepare(`SELECT id, label, enabled, needs_reauth, roles, updated_at, successful_day
      FROM accounts ORDER BY updated_at DESC, id`),
    env.DB.prepare(`SELECT id, account_id, source, day, at, status, details
      FROM sign_runs ORDER BY at DESC, id LIMIT 30`),
    scheduleStatement(env.DB),
  ]);
  return {
    day: dayInChina(Date.now()),
    schedule: describeSchedule(schedule.results[0]),
    accounts: accounts.results.map(row => ({ ...row, roles: JSON.parse(row.roles) })),
    runs: runs.results.map(row => ({ ...row, details: JSON.parse(row.details) })),
  };
}

async function openScan(env, owner) {
  if (!(await env.LOGIN_LIMIT.limit({ key: `scan:${owner}` })).success) throw new RequestError(429, '操作过于频繁，请稍后重试。');
  const { scanId, scanUrl } = await startScan();
  const id = crypto.randomUUID();
  const svg = await QRCode.toString(scanUrl, { type: 'svg', margin: 4, errorCorrectionLevel: 'M' });
  const qr = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  const expiresAt = Date.now() + scanLifetime;
  const encrypted = await seal(scanId, `scan:${id}`, env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM scans WHERE expires_at <= ?').bind(Date.now()),
    env.DB.prepare(`INSERT INTO scans (owner, id, scan_id_enc, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner) DO UPDATE SET id = excluded.id, scan_id_enc = excluded.scan_id_enc,
        expires_at = excluded.expires_at, poll_after = 0`).bind(owner, id, encrypted, expiresAt),
  ]);
  return json({ id, qr, expiresAt }, 201);
}

async function deleteScan(env, owner, id) {
  return env.DB.prepare('DELETE FROM scans WHERE owner = ? AND id = ?').bind(owner, id).run();
}

async function pollScan(env, owner, id) {
  const now = Date.now();
  const scan = await env.DB.prepare(`UPDATE scans SET poll_after = ?
    WHERE owner = ? AND id = ? AND expires_at > ? AND poll_after <= ? RETURNING scan_id_enc`)
    .bind(now + 40_000, owner, id, now, now).first();
  if (!scan) {
    const current = await env.DB.prepare('SELECT expires_at FROM scans WHERE owner = ? AND id = ?').bind(owner, id).first();
    return json({ state: current?.expires_at > now ? 'pending' : 'expired' });
  }
  try {
    const result = await scanStatus(await unseal(scan.scan_id_enc, `scan:${id}`, env));
    if (result.state === 'pending') {
      await env.DB.prepare('UPDATE scans SET poll_after = ? WHERE owner = ? AND id = ?').bind(Date.now() + 1800, owner, id).run();
      return json({ state: 'pending' });
    }
    if (result.state === 'expired') {
      await deleteScan(env, owner, id);
      return json({ state: 'expired' });
    }

    const token = await tokenFromScan(result.code);
    const session = await authorize(token);
    const roles = await listRoles(session);
    const key = accountKey(session.identity);
    const ciphertext = await seal(token, `account:${key}`, env);
    const at = Date.now();
    const [saved] = await env.DB.batch([
      env.DB.prepare(`INSERT INTO accounts (id, token_enc, roles, updated_at)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM scans WHERE owner = ? AND id = ?)
        ON CONFLICT(id) DO UPDATE SET token_enc = excluded.token_enc, roles = excluded.roles,
          updated_at = excluded.updated_at, needs_reauth = 0, cron_day = NULL
        WHERE accounts.locked_until <= ?`)
        .bind(key, ciphertext, JSON.stringify(roles), at, owner, id, at),
      env.DB.prepare('DELETE FROM scans WHERE owner = ? AND id = ?').bind(owner, id),
    ]);
    if (!saved.meta.changes) throw new RequestError(409, '扫码已取消或账号正在签到，请稍后再试。');
    return json({ state: 'connected', accountId: key });
  } catch (error) {
    await deleteScan(env, owner, id);
    throw error;
  }
}

async function updateAccount(request, env, id) {
  const patch = await readJson(request);
  if ((patch.label !== undefined && (typeof patch.label !== 'string' || patch.label.length > 36)) ||
    (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') ||
    (patch.label === undefined && patch.enabled === undefined)) {
    throw new RequestError(400, '请输入最多 36 个字符的备注，或设置自动签到状态。');
  }
  const result = await env.DB.prepare('UPDATE accounts SET label = COALESCE(?, label), enabled = COALESCE(?, enabled) WHERE id = ?')
    .bind(patch.label?.trim() ?? null, patch.enabled === undefined ? null : Number(patch.enabled), id).run();
  if (!result.meta.changes) throw new RequestError(404, '找不到该账号。');
  return json({ ok: true });
}

async function runAccount(env, id, source, day, slot = day) {
  const at = Date.now();
  const runId = crypto.randomUUID();
  const row = await env.DB.prepare(`UPDATE accounts SET run_id = ?, locked_until = ?,
      cron_day = CASE WHEN ? = 'scheduled' THEN ? ELSE cron_day END
    WHERE id = ? AND locked_until <= ? AND (? = 'manual' OR (
      enabled = 1 AND needs_reauth = 0 AND cron_day IS NOT ? AND successful_day IS NOT ?
    )) RETURNING id, token_enc, roles, needs_reauth`)
    .bind(runId, at + runLock, source, slot, id, at, source, slot, day).first();
  if (!row) {
    if (source === 'scheduled') return null;
    const account = await env.DB.prepare('SELECT id FROM accounts WHERE id = ?').bind(id).first();
    if (!account) throw new RequestError(404, '找不到该账号。');
    throw new RequestError(409, '此账号正在签到，请稍等。');
  }

  let roles = JSON.parse(row.roles);
  let status = 'failed';
  let reauth = Boolean(row.needs_reauth);
  const details = [];
  try {
    if (reauth) throw new SklandError('通行证授权已失效，请重新扫码。', true);
    const session = await authorize(await unseal(row.token_enc, `account:${id}`, env));
    roles = await listRoles(session);
    if (!roles.length) details.push({ status: 'failed', message: '这个账号还没有绑定可签到的游戏角色。' });

    const processed = new Set();
    if (roles.length > roleBudget) {
      const previous = await env.DB.prepare(`SELECT details FROM sign_runs WHERE account_id = ? AND day = ? AND at >= ?`)
        .bind(id, day, at - 24 * 60 * 60 * 1000).all();
      for (const item of previous.results.flatMap(record => JSON.parse(record.details))) {
        if (item.status === 'signed' || item.status === 'already') processed.add(item.key);
      }
    }
    const next = roles.filter(role => !processed.has(role.key));
    for (const role of next.slice(0, roleBudget)) {
      const detail = { key: role.key, name: role.name, game: role.game };
      try {
        details.push({ ...detail, ...await signRole(session, role) });
      } catch (error) {
        if (error instanceof SklandError && error.reauth) throw error;
        details.push({ ...detail, status: 'failed', message: error instanceof SklandError ? error.message : '角色签到失败，请稍后重试。' });
      }
    }
    if (next.length > roleBudget) details.push({ status: 'deferred', message: '剩余角色会在下一轮自动签到中继续处理，也可以再点一次立即签到。' });
    const allDone = roles.length > 0 && next.length <= roleBudget && details.every(item => item.status !== 'failed');
    const madeProgress = processed.size || details.some(item => item.status === 'signed' || item.status === 'already');
    status = allDone ? 'success' : madeProgress ? 'partial' : 'failed';
  } catch (error) {
    const providerError = error instanceof SklandError;
    reauth ||= providerError && error.reauth;
    status = reauth ? 'reauth' : 'failed';
    details.push({ status, message: providerError ? error.message : '暂时无法读取账号凭证或执行签到。' });
  }

  const result = { id: runId, account_id: id, source, day, at, status, details };
  const [logged] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO sign_runs (id, account_id, source, day, at, status, details)
      SELECT ?, id, ?, ?, ?, ?, ? FROM accounts WHERE id = ? AND run_id = ?`)
      .bind(runId, source, day, at, status, JSON.stringify(details), id, runId),
    env.DB.prepare(`UPDATE accounts SET roles = ?, needs_reauth = ?, locked_until = 0, run_id = NULL,
        successful_day = CASE WHEN ? = 'success' THEN ? ELSE successful_day END,
        cron_day = CASE WHEN ? = 'scheduled' AND ? = 1 THEN NULL ELSE cron_day END
      WHERE id = ? AND run_id = ?`)
      .bind(JSON.stringify(roles), Number(reauth), status, day, source, Number(details.some(item => item.status === 'deferred') && details.some(item => item.status === 'signed' || item.status === 'already')), id, runId),
  ]);
  if (!logged.meta.changes) {
    if (source === 'manual') throw new RequestError(409, '账号状态已更新，请刷新面板。');
    return null;
  }
  return result;
}

function queueNotifications(ctx, env, result) {
  if (result) ctx?.waitUntil(sendSignNotifications(env, result).catch(() => console.warn('Could not process sign notification.')));
}

async function scheduled(controller, env, ctx) {
  if (!encryptionReady(env)) throw new Error('Missing credential encryption key');
  const at = controller.scheduledTime;
  const account = await nextScheduledAccount(env.DB, at);
  if (account) {
    queueNotifications(ctx, env, await runAccount(env, account.id, 'scheduled', dayInChina(at), account.slot));
  }
  if (chinaMinute(at) === 120) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM scans WHERE expires_at <= ?').bind(Date.now()),
      env.DB.prepare('DELETE FROM sign_runs WHERE at < ?').bind(at - 30 * 24 * 60 * 60 * 1000),
    ]);
  }
}

async function api(request, env, url, ctx) {
  if (!trustedOrigin(url)) throw new RequestError(403, '请通过 HTTPS 访问管理面板。');
  if (!encryptionReady(env)) throw new RequestError(503, '加密密钥尚未配置，请检查部署配置。');
  const { pathname } = url;
  const method = request.method;
  if (method !== 'GET' && request.headers.get('Origin') !== url.origin) throw new RequestError(403, '请从管理面板发起请求。');

  const auth = await readAuth(env.DB);
  const mode = loginMode(auth);
  if (mode === 'password' && !passwordReady(env)) throw new RequestError(503, '首次登录所需的管理员密码尚未配置。');
  const owner = readSession(request, url, env, auth);
  if (pathname === '/api/session' && method === 'GET') {
    const result = { authenticated: Boolean(owner), mode };
    if (owner && url.searchParams.get('include') === 'dashboard') result.dashboard = await dashboard(env);
    return json(result);
  }
  if (pathname === '/api/session' && method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
    if (!(await env.LOGIN_LIMIT.limit({ key: `login:${ip}` })).success) throw new RequestError(429, '登录尝试过于频繁，请一分钟后重试。');
    const { password, code } = await readJson(request);
    if (mode === 'totp') {
      await verifyTotpLogin(env, auth, code);
    } else if (!verifyPassword(password, env.ADMIN_PASSWORD)) {
      throw new RequestError(401, '管理员密码不正确。');
    }
    return json({ authenticated: true, mode }, 200, { 'Set-Cookie': sessionCookie(url, env, auth) });
  }
  if (!owner) throw new RequestError(401, '请先登录管理面板。');
  if (pathname === '/api/session' && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM scans WHERE owner = ?').bind(owner).run();
    return json({ authenticated: false, mode }, 200, { 'Set-Cookie': sessionCookie(url, env, auth, true) });
  }
  if (pathname === '/api/auth/totp' && method === 'GET') return json(authSettings(auth));
  if (pathname === '/api/auth/totp/setup' && method === 'POST') {
    if (mode === 'totp') throw new RequestError(409, '动态验证码已经启用。');
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
    if (!(await env.LOGIN_LIMIT.limit({ key: `totp-setup:${ip}` })).success) throw new RequestError(429, '绑定尝试过于频繁，请稍后重试。');
    const { password } = await readJson(request);
    if (!verifyPassword(password, env.ADMIN_PASSWORD)) throw new RequestError(422, '当前管理员密码不正确。');
    return json(await startTotpSetup(env, auth, owner, url.hostname), 201);
  }
  if (pathname === '/api/auth/totp/confirm' && method === 'POST') {
    const { id, code } = await readJson(request);
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new RequestError(400, '绑定信息无效。');
    const updated = await confirmTotpSetup(env, auth, owner, id, code);
    return json(authSettings(updated), 200, { 'Set-Cookie': sessionCookie(url, env, updated) });
  }
  const pendingSetup = pathname.match(/^\/api\/auth\/totp\/setup\/([a-f0-9-]{36})$/);
  if (pendingSetup && method === 'DELETE') {
    await cancelTotpSetup(env.DB, owner, pendingSetup[1]);
    return json({ ok: true });
  }
  if (pathname === '/api/dashboard' && method === 'GET') return json(await dashboard(env));
  if (pathname === '/api/schedule' && method === 'GET') return json(describeSchedule(await readSchedule(env.DB)));
  if (pathname === '/api/schedule' && method === 'PUT') {
    const { time } = await readJson(request);
    const minutes = parseTime(time);
    if (minutes === null) throw new RequestError(400, '请输入 00:00 至 23:59 之间的时间。');
    return json(await saveSchedule(env.DB, minutes));
  }
  if (pathname === '/api/notifications' && method === 'GET') return json({ channels: await listNotifications(env.DB) });
  const notification = pathname.match(/^\/api\/notifications\/([a-z]+)(\/test)?$/);
  if (notification && hasProvider(notification[1])) {
    const [, provider, test] = notification;
    if (test && method === 'POST') return json(await testNotification(env, provider, owner));
    if (!test && method === 'PUT') return json(await saveNotification(env, provider, await readJson(request)));
    if (!test && method === 'DELETE') {
      await removeNotification(env.DB, provider);
      return json({ ok: true });
    }
  }
  if (pathname === '/api/scans' && method === 'POST') return openScan(env, owner);
  const scan = pathname.match(new RegExp(`^/api/scans/(${scanIdPattern})$`));
  if (scan && method === 'POST') return pollScan(env, owner, scan[1]);
  if (scan && method === 'DELETE') {
    await deleteScan(env, owner, scan[1]);
    return json({ ok: true });
  }
  const account = pathname.match(new RegExp(`^/api/accounts/(${accountIdPattern})(/sign)?$`));
  if (account?.[2] && method === 'POST') {
    const result = await runAccount(env, account[1], 'manual', dayInChina(Date.now()));
    queueNotifications(ctx, env, result);
    return json(result);
  }
  if (account && !account[2] && method === 'PATCH') return updateAccount(request, env, account[1]);
  if (account && !account[2] && method === 'DELETE') {
    const now = Date.now();
    const result = await env.DB.prepare('DELETE FROM accounts WHERE id = ? AND locked_until <= ?').bind(account[1], now).run();
    if (!result.meta.changes) throw new RequestError(409, '账号不存在或正在签到。');
    return json({ ok: true });
  }
  throw new RequestError(404, '未找到接口。');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, url, ctx);
    } catch (error) {
      if (error instanceof RequestError || error instanceof AuthError || error instanceof NotificationError) return json({ error: error.message }, error.status);
      if (error instanceof SklandError) return json({ error: error.message }, 502);
      return json({ error: '服务暂时不可用，请检查 Worker 和 D1 配置。' }, 500);
    }
  },
  scheduled,
};
