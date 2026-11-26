import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Miniflare } from 'miniflare';
import worker from '../src/index.js';
import { describeSchedule, nextScheduledAccount, parseTime, saveSchedule } from '../src/schedule.js';

const emulator = new Miniflare({ workers: [{ config: {
  name: 'test', compatibilityDate: '2026-11-25', env: { DB: { type: 'd1', id: 'test-db' } },
  manifest: { mainModule: 'index.js', modules: { 'index.js': {
    type: 'esm', contents: 'export default { fetch() { return new Response() } }',
  } } },
} }] });
const db = await emulator.getD1Database('DB');
for (const migration of ['0001_initial', '0002_notifications', '0003_schedule_and_channels', '0004_admin_totp', '0005_schedule_index', '0006_totp_digits']) {
  const sql = await readFile(new URL(`../migrations/${migration}.sql`, import.meta.url), 'utf8');
  if (migration === '0003_schedule_and_channels') {
    await db.prepare("INSERT INTO notification_settings (provider, secret_enc, enabled, result_mode, include_manual, revision, last_at, last_status, last_message, last_kind) VALUES ('qmsg', 'legacy-ciphertext', 1, 'failures', 0, 'legacy', 5, 'accepted', 'legacy-result', 'test')").run();
  }
  await db.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
}
const migrated = await db.prepare("SELECT * FROM notification_settings WHERE provider = 'qmsg'").first();
assert.equal(migrated.secret_enc, 'legacy-ciphertext');
assert.equal(migrated.last_message, 'legacy-result');
assert.equal(migrated.extra_enc, null);
await db.prepare("DELETE FROM notification_settings WHERE provider = 'qmsg'").run();
const env = { DB: db, ADMIN_PASSWORD: randomBytes(32).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'), LOGIN_LIMIT: { limit: async () => ({ success: true }) } };
const base = 'https://dash.test';
const pendingWork = [];
const ctx = { waitUntil: promise => pendingWork.push(promise) };
const drainWork = () => Promise.all(pendingWork.splice(0));
const request = (path, method = 'GET', cookie, body, origin = base) => worker.fetch(new Request(base + '/api' + path, { method,
  headers: { Origin: origin, ...(cookie && { Cookie: cookie }), ...(body && { 'Content-Type': 'application/json' }) },
  ...(body && { body: JSON.stringify(body) }),
}), env, ctx);
const getBody = async (response, status = 200) => {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
};
const signIn = async () => {
  const response = await request('/session', 'POST', null, { password: env.ADMIN_PASSWORD });
  assert.match(response.headers.get('Set-Cookie'), /^__Host-skyland-admin=.*HttpOnly; SameSite=Strict; .*Secure$/);
  await getBody(response);
  return response.headers.get('Set-Cookie').split(';')[0];
};

const oldFetch = globalThis.fetch;
let approved = false;
let rejectPush = false;
const pushes = [];
let tokenValue = 'a-test-only-token';
let tokenRejected = false;
let signCount = 0;
let exchanges = 0;
let scanCount = 0;
const observed = [];
const mock = value => Response.json(value);

try {
  globalThis.fetch = async (url, options) => {
    url = new URL(url);
    observed.push(url.pathname);
    assert.equal(options.redirect, 'manual');
    const payload = options.body instanceof URLSearchParams ? Object.fromEntries(options.body) : options.body ? JSON.parse(options.body) : null;
    if (url.hostname === 'api.telegram.org') {
      assert.equal(url.pathname, '/bot12345:fake-telegram-token/sendMessage');
      assert.equal(payload.chat_id, '-10012345');
      pushes.push({ provider: 'telegram' });
      return mock({ ok: true });
    }
    if (url.hostname === 'api.day.app') {
      assert.equal(url.pathname, '/push');
      assert.equal(payload.device_key, 'device-test');
      pushes.push({ provider: 'bark' });
      return mock({ code: 200 });
    }
    if (url.hostname === 'qyapi.weixin.qq.com') {
      assert.equal(url.searchParams.get('key'), 'wecom-test');
      assert.equal(payload.msgtype, 'text');
      pushes.push({ provider: 'wecom' });
      return mock({ errcode: 0 });
    }
    if (url.hostname === 'open.feishu.cn') {
      assert.equal(url.pathname, '/open-apis/bot/v2/hook/mock-feishu-hook');
      if (payload.timestamp) assert.equal(payload.sign, createHmac('sha256', `${payload.timestamp}\nSEC-test-signature`).digest('base64'));
      pushes.push({ provider: 'feishu', signed: Boolean(payload.timestamp) });
      return mock({ StatusCode: 0 });
    }
    if (url.hostname === 'discord.com') {
      assert.equal(url.searchParams.get('wait'), 'true');
      assert.deepEqual(payload.allowed_mentions, { parse: [] });
      pushes.push({ provider: 'discord' });
      return mock({ id: '1' });
    }
    if (url.hostname === 'api.pushover.net') {
      assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      assert.equal(payload.token, 'a'.repeat(30));
      assert.equal(payload.user, 'b'.repeat(30));
      pushes.push({ provider: 'pushover' });
      return mock({ status: 1 });
    }
    if (url.hostname === 'www.pushplus.plus') {
      assert.equal(payload.token, 'mock-pushplus-key');
      pushes.push({ provider: 'pushplus', title: payload.title, text: payload.content });
      return mock({ code: rejectPush ? 903 : 200 });
    }
    if (url.hostname === '123.push.ft07.com') {
      assert.equal(url.pathname, '/send/sctp123t-test-example.send');
      pushes.push({ provider: 'serverchan', title: payload.title, text: payload.desp });
      return mock({ code: 0 });
    }
    if (url.hostname === 'qmsg.zendee.cn') {
      assert.equal(url.pathname, '/v3/jsend/mock-qmsg-key');
      pushes.push({ provider: 'qmsg', title: '', text: payload.msg });
      return mock({ success: true });
    }
    if (url.pathname.endsWith('/gen_scan/login')) {
      scanCount++;
      return mock({ status: 0, data: { scanId: `test-only-scan-${scanCount}`, scanUrl: `hypergryph://scan/?id=${scanCount}` } });
    }
    if (url.pathname.endsWith('/scan_status')) return mock(approved ? { status: 0, data: { scanCode: 'approved-code' } } : { status: 100, msg: '未扫码' });
    if (url.pathname.endsWith('/token_by_scan_code')) {
      exchanges++;
      assert.equal(payload.scanCode, 'approved-code');
      return mock({ status: 0, data: { token: tokenValue } });
    }
    if (url.pathname.endsWith('/grant')) {
      assert.equal(payload.token, tokenValue);
      return mock(tokenRejected ? { status: 1, msg: 'Token 已过期' } : { status: 0, data: { code: 'test-only-grant', uid: 'test-uid' } });
    }
    if (url.pathname.endsWith('/generate_cred_by_code')) return mock({ code: 0, data: { userId: 'test-account', cred: 'test-cred', token: 'test-sign-key' } });
    assert.equal(options.headers.cred, 'test-cred');
    const { platform, timestamp, dId, vName, sign } = options.headers;
    const expected = createHmac('sha256', 'test-sign-key').update(url.pathname + (options.body ?? '') + timestamp + JSON.stringify({ platform, timestamp, dId, vName })).digest('hex');
    assert.equal(sign, createHash('md5').update(expected).digest('hex'));
    if (url.pathname.endsWith('/binding')) return mock({ code: 0, data: { list: [
      { appCode: 'arknights', bindingList: [{ uid: '100', gameId: 1, nickName: '测试博士', channelName: '官服' }] },
      { appCode: 'endfield', bindingList: [{ roles: [{ roleId: '200', serverId: '1', nickname: '测试管理员' }] }] },
    ] } });
    if (url.pathname === '/api/v1/game/attendance') {
      signCount++;
      assert.deepEqual(payload, { gameId: 1, uid: '100' });
      return mock({ code: 0, data: { awards: [{ count: 3, resource: { name: '奖励' } }] } });
    }
    if (url.pathname === '/web/v1/game/endfield/attendance') {
      signCount++;
      assert.equal(options.headers['sk-game-role'], '3_200_1');
      return mock({ code: 10001, message: '今日已签到' });
    }
    assert.fail('Unexpected provider call');
  };

  await getBody(await request('/dashboard'), 401);
  await getBody(await request('/notifications'), 401);
  await getBody(await request('/schedule'), 401);
  await getBody(await request('/session', 'POST', null, { password: 'wrong' }), 401);
  assert.deepEqual(await getBody(await request('/session?include=dashboard')), { authenticated: false, mode: 'password' });
  const cookie = await signIn();
  assert.deepEqual((await getBody(await request('/session?include=dashboard', 'GET', cookie))).dashboard,
    await getBody(await request('/dashboard', 'GET', cookie)));
  assert.deepEqual(await getBody(await request('/session', 'GET', cookie)), { authenticated: true, mode: 'password' });
  assert.equal((await getBody(await request('/schedule', 'GET', cookie))).time, '07:00');
  await getBody(await request('/schedule', 'PUT', cookie, { time: '24:00' }), 400);
  await getBody(await request('/schedule', 'PUT', cookie, { time: '17:23' }, 'https://other.test'), 403);
  const scheduleSaved = await getBody(await request('/schedule', 'PUT', cookie, { time: '17:23' }));
  assert.equal(scheduleSaved.time, '17:23');
  assert(scheduleSaved.next_at > Date.now());
  assert.equal((await getBody(await request('/dashboard', 'GET', cookie))).schedule.time, '17:23');
  assert.equal(parseTime('00:00'), 0);
  assert.equal(parseTime('23:59'), 1439);
  assert.equal(parseTime('07:2'), null);
  const afterToday = Date.parse('2026-11-26T10:00:00Z');
  const savedAfterToday = await saveSchedule(db, parseTime('17:00'), afterToday);
  assert.equal(savedAfterToday.next_at, Date.parse('2026-11-27T09:00:00Z'));
  await db.prepare("INSERT INTO accounts (id, token_enc, roles, updated_at) VALUES ('clock-fixture', 'fixture', '[]', 0)").run();
  async function candidate(minute, at, startsAt = 0) {
    await db.prepare('UPDATE daily_schedule SET minute_of_day = ?, starts_at = ?').bind(minute, startsAt).run();
    return nextScheduledAccount(db, Date.parse(at));
  }
  const midnightWindow = await candidate(1439, '2026-11-26T16:01:00Z');
  assert.deepEqual(midnightWindow, { id: 'clock-fixture', slot: '2026-11-26' });
  await db.prepare("UPDATE accounts SET cron_day = '2026-11-26' WHERE id = 'clock-fixture'").run();
  assert.equal(await candidate(1439, '2026-11-26T16:01:00Z'), null);
  assert.equal((await candidate(420, '2026-11-26T23:00:42Z')).slot, '2026-11-27');
  assert.equal(await candidate(420, '2026-11-26T22:59:00Z'), null);
  assert.equal((await candidate(420, '2026-11-27T01:59:59Z')).slot, '2026-11-27');
  assert.equal(await candidate(420, '2026-11-27T02:00:00Z'), null);
  assert.equal(await candidate(420, '2026-11-26T23:00:00Z', Date.parse('2026-11-27T23:00:00Z')), null);
  await db.prepare("DELETE FROM accounts WHERE id = 'clock-fixture'").run();
  assert.equal(describeSchedule({ minute_of_day: 420, starts_at: 0 }, Date.parse('2026-11-26T23:00:00Z')).next_at, Date.parse('2026-11-27T23:00:00Z'));
  await db.prepare('UPDATE daily_schedule SET minute_of_day = 0, starts_at = 0 WHERE id = 1').run();
  assert.deepEqual(await getBody(await request('/session', 'GET', cookie + 'tampered')), { authenticated: false, mode: 'password' });
  await getBody(await request('/scans', 'POST', cookie, null, 'https://other.test'), 403);
  const otherCookie = await signIn();
  const scan = await getBody(await request('/scans', 'POST', cookie), 201);
  assert.match(scan.qr, /^data:image\/svg\+xml,/);
  const scanRecord = await db.prepare('SELECT scan_id_enc FROM scans').first();
  assert(!scanRecord.scan_id_enc.includes('test-only-scan'));
  const poll = owner => request(`/scans/${scan.id}`, 'POST', owner);
  assert.equal((await getBody(await poll(otherCookie))).state, 'expired');
  assert.equal((await getBody(await poll(cookie))).state, 'pending');
  assert.equal(exchanges, 0);
  assert.equal((await getBody(await request('/dashboard', 'GET', cookie))).accounts.length, 0);
  await db.prepare('UPDATE scans SET poll_after = 0').run();
  approved = true;
  const completed = await getBody(await poll(cookie));
  assert.equal(completed.state, 'connected');
  assert.equal(exchanges, 1);
  assert.equal((await getBody(await poll(cookie))).state, 'expired');
  const { accounts: [account] } = await getBody(await request('/dashboard', 'GET', cookie));
  assert.equal(account.id, completed.accountId);
  assert.equal(account.roles.length, 2);
  assert.equal(account.token_enc, undefined);
  const stored = await db.prepare('SELECT token_enc FROM accounts').first();
  assert(!stored.token_enc.includes(tokenValue));

  assert.deepEqual(await getBody(await request('/notifications', 'GET', cookie)), { channels: [] });
  const policy = { enabled: true, result_mode: 'failures', include_manual: false };
  await getBody(await request('/notifications/pushplus', 'PUT', cookie, policy), 400);
  await getBody(await request('/notifications/serverchan', 'PUT', cookie, { ...policy, secret: 'wrong' }), 400);
  const pushplus = await getBody(await request('/notifications/pushplus', 'PUT', cookie, { ...policy, secret: 'mock-pushplus-key' }));
  assert.equal(pushplus.secret_enc, undefined);
  const secret = await db.prepare('SELECT secret_enc FROM notification_settings').first();
  assert(!secret.secret_enc.includes('mock-pushplus-key'));
  const testPush = await getBody(await request('/notifications/pushplus/test', 'POST', cookie));
  assert.equal(testPush.status, 'accepted');
  assert.match(pushes[0].title, /推送测试/);
  assert.equal((await getBody(await request('/notifications', 'GET', cookie))).channels[0].last_kind, 'test');
  assert.equal(pushes.length, 1);

  const accountPath = `/accounts/${account.id}`;
  await getBody(await request(accountPath, 'PATCH', cookie, { label: '常用账号', enabled: false }));
  await worker.scheduled({ scheduledTime: Date.now() }, env);
  assert.equal(signCount, 0);
  const result = await getBody(await request(accountPath + '/sign', 'POST', cookie));
  assert.equal(result.status, 'success');
  assert.deepEqual(result.details.map(detail => detail.status), ['signed', 'already']);
  await drainWork();
  assert.equal(signCount, 2);
  assert.equal(pushes.length, 1);
  assert.equal((await getBody(await request('/dashboard', 'GET', cookie))).runs.length, 1);

  tokenRejected = true;
  assert.equal((await getBody(await request(accountPath + '/sign', 'POST', cookie))).status, 'reauth');
  await drainWork();
  assert.equal(pushes.length, 1);
  tokenRejected = false;
  tokenValue = 'a-new-test-only-token';
  const renewal = await getBody(await request('/scans', 'POST', cookie), 201);
  assert.equal((await getBody(await request(`/scans/${renewal.id}`, 'POST', cookie))).accountId, account.id);
  const after = await getBody(await request('/dashboard', 'GET', cookie));
  assert.equal(after.accounts.length, 1);
  assert.equal(after.accounts[0].label, '常用账号');
  assert.equal(after.accounts[0].enabled, 0);
  assert.equal(after.accounts[0].needs_reauth, 0);
  assert.equal(after.runs.length, 2);
  await getBody(await request(accountPath, 'PATCH', cookie, { enabled: true }));
  await getBody(await request('/notifications/pushplus', 'PUT', cookie, { ...policy, result_mode: 'all' }));
  await getBody(await request('/notifications/serverchan', 'PUT', cookie, { ...policy, result_mode: 'all', secret: 'sctp123t-test-example' }));
  await getBody(await request('/notifications/qmsg', 'PUT', cookie, { ...policy, secret: 'mock-qmsg-key' }));
  rejectPush = true;
  const localToday = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  const tomorrow = Date.parse(localToday + 'T00:00:00+08:00') + 86_400_000;
  await worker.scheduled({ scheduledTime: tomorrow - 60_000 }, env, ctx);
  await drainWork();
  assert.equal(signCount, 2);
  assert.equal(pushes.length, 1);
  await worker.scheduled({ scheduledTime: tomorrow }, env, ctx);
  await drainWork();
  await worker.scheduled({ scheduledTime: tomorrow }, env, ctx);
  await drainWork();
  assert.deepEqual(pushes.map(p => p.provider).sort(), ['pushplus', 'pushplus', 'serverchan']);
  assert(pushes.filter(p => !p.title.includes('测试')).every(p => p.text.includes('明日方舟 1/1') && p.text.includes('终末地 1/1')));
  assert(!JSON.stringify(pushes).includes('测试博士'));
  const { channels } = await getBody(await request('/notifications', 'GET', cookie));
  assert.equal(channels.find(c => c.provider === 'pushplus').last_status, 'failed');
  assert.equal(channels.find(c => c.provider === 'serverchan').last_status, 'accepted');
  assert.equal(channels.find(c => c.provider === 'qmsg').last_status, null);
  assert.equal(signCount, 4);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM sign_runs WHERE source = 'scheduled'").first()).count, 1);
  await getBody(await request('/notifications/serverchan', 'DELETE', cookie));
  await getBody(await request('/notifications/pushplus', 'PUT', cookie, { ...policy, enabled: false }));
  tokenRejected = true;
  await worker.scheduled({ scheduledTime: tomorrow + 86_400_000 }, env, ctx);
  await drainWork();
  assert.equal(pushes.at(-1).provider, 'qmsg');
  assert.equal(pushes.length, 4);
  assert.match(pushes.at(-1).text, /需重新授权/);
  await getBody(await request('/notifications/telegram', 'PUT', cookie, { ...policy, secret: '12345:fake-telegram-token' }), 400);
  await getBody(await request('/notifications/wecom', 'PUT', cookie, { ...policy, secret: 'https://example.com/?key=wecom-test' }), 400);
  const newProviders = {
    telegram: { secret: '12345:fake-telegram-token', extra: '-10012345' },
    bark: { secret: 'https://api.day.app/device-test' },
    wecom: { secret: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=wecom-test' },
    feishu: { secret: 'https://open.feishu.cn/open-apis/bot/v2/hook/mock-feishu-hook', extra: 'SEC-test-signature' },
    discord: { secret: 'https://discord.com/api/v10/webhooks/12345/webhook-fake' },
    pushover: { secret: 'a'.repeat(30), extra: 'b'.repeat(30) },
  };
  for (const [name, credentials] of Object.entries(newProviders)) {
    const row = await getBody(await request(`/notifications/${name}`, 'PUT', cookie, { ...policy, enabled: false, ...credentials }));
    assert.equal(row.secret_enc, undefined);
    assert.equal(row.extra_enc, undefined);
    assert.equal(row.has_extra, Number(Boolean(credentials.extra)));
    await getBody(await request(`/notifications/${name}`, 'PUT', cookie, { ...policy, enabled: false }));
    assert.equal((await getBody(await request(`/notifications/${name}/test`, 'POST', cookie))).status, 'accepted');
    assert.equal(pushes.at(-1).provider, name);
  }
  assert(pushes.find(p => p.provider === 'feishu').signed);
  const cleared = await getBody(await request('/notifications/feishu', 'PUT', cookie, { ...policy, enabled: false, clear_extra: true }));
  assert.equal(cleared.last_status, null);
  assert.equal(cleared.has_extra, 0);
  await getBody(await request('/notifications/feishu/test', 'POST', cookie));
  assert(!pushes.at(-1).signed);
  await getBody(await request(accountPath, 'DELETE', cookie));
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM sign_runs').first()).count, 0);
  await getBody(await request('/session', 'DELETE', cookie));
  console.log(`Integration checks passed (${observed.length} mocked provider requests; D1 uses workerd).`);
} finally {
  globalThis.fetch = oldFetch;
  await emulator.dispose();
}
