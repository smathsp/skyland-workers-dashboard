import { seal, unseal } from './security.js';
import { providers } from './notification-providers.js';

export class NotificationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function hasProvider(provider) {
  return Object.hasOwn(providers, provider);
}

const fields = 'provider, enabled, result_mode, include_manual, last_at, last_status, last_message, last_kind, (extra_enc IS NOT NULL) AS has_extra';
const scope = provider => `notifications:${provider}`;
const extraScope = provider => `notifications-extra:${provider}`;

export async function listNotifications(db) {
  const { results } = await db.prepare(`SELECT ${fields} FROM notification_settings ORDER BY provider`).all();
  return results;
}

export async function saveNotification(env, provider, body) {
  const { enabled, result_mode, include_manual, secret = '', extra = '', clear_extra = false } = body;
  if (typeof enabled !== 'boolean' || typeof include_manual !== 'boolean' || !['all', 'failures'].includes(result_mode) ||
    typeof secret !== 'string' || secret.length > 320 || typeof extra !== 'string' || extra.length > 256 ||
    typeof clear_extra !== 'boolean') throw new NotificationError(400, '请检查消息推送配置。');

  const config = providers[provider];
  const normalized = config.normalize(secret.trim());
  const secondary = extra.trim();
  if (secret.trim() && !normalized) throw new NotificationError(400, config.format);
  if (secondary && (!config.extra || !config.extra.pattern.test(secondary))) {
    throw new NotificationError(400, config.extra?.format ?? '这个渠道只需要一个凭证。');
  }
  if (clear_extra && (!config.extra || config.extra.required || secondary)) {
    throw new NotificationError(400, '请检查附加凭证设置。');
  }

  const current = await env.DB.prepare('SELECT secret_enc, extra_enc, revision FROM notification_settings WHERE provider = ?').bind(provider).first();
  if (!normalized && !current) throw new NotificationError(400, '请先填写这个渠道的推送凭证。');
  if (config.extra?.required && !secondary && !current?.extra_enc) throw new NotificationError(400, config.extra.format);
  const encrypted = normalized ? await seal(normalized, scope(provider), env) : current.secret_enc;
  let extraEncrypted = clear_extra ? null : current?.extra_enc ?? null;
  if (secondary) extraEncrypted = await seal(secondary, extraScope(provider), env);

  const settings = [encrypted, extraEncrypted, Number(enabled), result_mode, Number(include_manual), crypto.randomUUID()];
  let update;
  if (current) {
    const resetResult = normalized || secondary || clear_extra
      ? ', last_at = NULL, last_status = NULL, last_message = NULL, last_kind = NULL'
      : '';
    update = await env.DB.prepare(`UPDATE notification_settings SET secret_enc = ?, extra_enc = ?, enabled = ?,
      result_mode = ?, include_manual = ?, revision = ?${resetResult}
      WHERE provider = ? AND revision = ?`).bind(...settings, provider, current.revision).run();
  } else {
    update = await env.DB.prepare(`INSERT INTO notification_settings (provider, secret_enc, extra_enc, enabled, result_mode, include_manual, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider) DO NOTHING`).bind(provider, ...settings).run();
  }
  if (!update.meta.changes) throw new NotificationError(409, '配置已被修改，请刷新后重试。');
  return env.DB.prepare(`SELECT ${fields} FROM notification_settings WHERE provider = ?`).bind(provider).first();
}

export async function removeNotification(db, provider) {
  await db.prepare('DELETE FROM notification_settings WHERE provider = ?').bind(provider).run();
}

async function send(env, row, title, text, kind) {
  let outcome = { status: 'failed', message: '推送服务暂时不可达，请稍后重试。' };
  try {
    const token = await unseal(row.secret_enc, scope(row.provider), env);
    const extra = row.extra_enc ? await unseal(row.extra_enc, extraScope(row.provider), env) : '';
    const config = providers[row.provider];
    const [url, payload] = config.request(token, title, text, extra);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': config.formEncoded ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: config.formEncoded ? new URLSearchParams(payload) : JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      const data = await response.json().catch(() => null);
      outcome = config.accepted(data)
        ? { status: 'accepted', message: '推送服务已受理。' }
        : { status: 'failed', message: '推送服务未受理。请检查凭证、接收绑定和服务额度。' };
    } else {
      outcome = { status: 'failed', message: `推送服务拒绝请求（HTTP ${response.status}）。` };
    }
  } catch {
    // Provider URLs can contain credentials. Store the fixed diagnostic only.
  }
  const at = Date.now();
  await env.DB.prepare(`UPDATE notification_settings SET last_at = ?, last_status = ?, last_message = ?, last_kind = ?
    WHERE provider = ? AND revision = ? AND (last_at IS NULL OR last_at <= ?)`)
    .bind(at, outcome.status, outcome.message, kind, row.provider, row.revision, at).run();
  return { ...outcome, at };
}

export async function testNotification(env, provider, owner) {
  const row = await env.DB.prepare('SELECT provider, secret_enc, extra_enc, revision FROM notification_settings WHERE provider = ?').bind(provider).first();
  if (!row) throw new NotificationError(404, '请先保存这个渠道的配置。');
  if (!(await env.LOGIN_LIMIT.limit({ key: `push-test:${owner}` })).success) throw new NotificationError(429, '测试过于频繁，请一分钟后再试。');
  return send(env, row, '森空岛签到 · 推送测试', '这是一条测试消息。收到后即可确认接收渠道已连通。', 'test');
}

const names = { arknights: '明日方舟', endfield: '终末地' };
const resultLabels = { success: '已完成', partial: '部分完成', failed: '失败', reauth: '需重新授权' };

function summary(run) {
  const prefix = [`${run.day} · ${run.source === 'manual' ? '手动' : '自动'}签到 · ${resultLabels[run.status]}`];
  for (const game of Object.keys(names)) {
    const results = run.details.filter(detail => detail.game === game);
    if (!results.length) continue;
    const signed = results.filter(detail => ['signed', 'already'].includes(detail.status)).length;
    prefix.push(`${names[game]} ${signed}/${results.length} 个角色已签到`);
  }
  for (const detail of run.details) if (!detail.game && detail.message) prefix.push(detail.message);
  return prefix.join('\n');
}

export async function sendSignNotifications(env, run) {
  const { results } = await env.DB.prepare(`SELECT provider, secret_enc, extra_enc, revision FROM notification_settings
    WHERE enabled = 1 AND (? = 'scheduled' OR include_manual = 1) AND (result_mode = 'all' OR ? <> 'success')`)
    .bind(run.source, run.status).all();
  if (!results.length) return;
  const text = summary(run);
  const title = `森空岛签到 · ${resultLabels[run.status]}`;
  for (let start = 0; start < results.length; start += 5) {
    await Promise.allSettled(results.slice(start, start + 5).map(row => send(env, row, title, text, 'sign')));
  }
}
