import { createHash, createHmac } from 'node:crypto';

const passport = 'https://as.hypergryph.com';
const skland = 'https://zonai.skland.com';
const appCode = '4ca99fa6b56cc2ba';
const alreadySigned = new Set(['请勿重复签到！', '请勿重复签到', '今日已签到', '今天已经签到了']);
const credentialError = /(?:token|凭证).*(?:无效|过期|失效|错误)|未登录|请重新登录|登录.*(?:过期|失效)|(?:expired|invalid).*(?:token|credential)/i;

export class SklandError extends Error {
  constructor(message, reauth = false) {
    super(message);
    this.reauth = reauth;
  }
}

async function request(path, origin, options = {}) {
  let response;
  try {
    response = await fetch(new URL(path, origin), { ...options, redirect: 'manual', signal: AbortSignal.timeout(8000) });
  } catch {
    throw new SklandError('森空岛连接超时或暂时不可达，请稍后重试。');
  }
  if (response.status === 401) throw new SklandError('森空岛授权已失效，请重新扫码。', true);
  if (!response.ok) throw new SklandError(`森空岛暂时无法处理请求（HTTP ${response.status}）。`);
  const json = await response.json().catch(() => null);
  if (!json || typeof json !== 'object') throw new SklandError('森空岛返回了无法识别的数据。');
  return json;
}

function post(path, origin, body) {
  return request(path, origin, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function startScan() {
  const result = await post('/general/v1/gen_scan/login', passport, { appCode });
  const { scanId, scanUrl } = result.data ?? {};
  if (result.status !== 0 || !isText(scanId) || !isText(scanUrl) || !scanUrl.startsWith('hypergryph://')) {
    throw new SklandError('鹰角暂时无法生成登录二维码，请稍后重试。');
  }
  return { scanId, scanUrl };
}

export async function scanStatus(scanId) {
  const result = await request(`/general/v1/scan_status?scanId=${encodeURIComponent(scanId)}`, passport);
  if (result.status === 0 && isText(result.data?.scanCode)) return { state: 'approved', code: result.data.scanCode };
  const message = result.msg ?? '';
  if (/过期|失效|取消|拒绝/.test(message)) return { state: 'expired' };
  if (result.status === 100 || /确认|已扫码|请扫码/.test(message)) return { state: 'pending' };
  throw new SklandError('鹰角暂时无法读取扫码结果，请重新生成二维码。');
}

export async function tokenFromScan(code) {
  const result = await post('/user/auth/v1/token_by_scan_code', passport, { scanCode: code, appCode });
  if (result.status !== 0 || !isText(result.data?.token)) throw new SklandError('扫码授权未完成，请重新生成二维码。');
  return result.data.token;
}

export async function authorize(token) {
  const grant = await post('/user/oauth2/v2/grant', passport, { appCode, token, type: 0 });
  if (grant.status !== 0 || !isText(grant.data?.code)) {
    const expired = credentialError.test(grant.msg ?? '');
    throw new SklandError(expired ? '通行证授权已失效，请重新扫码。' : '鹰角暂时无法兑换森空岛授权。', expired);
  }
  const response = await post('/web/v1/user/auth/generate_cred_by_code', skland, { code: grant.data.code, kind: 1 });
  if (response.code !== 0 || !isText(response.data?.cred) || !isText(response.data?.token)) {
    throw new SklandError('森空岛暂时无法建立会话，请稍后重试。');
  }
  const identity = response.data.userId ?? grant.data.uid;
  if ((!isText(identity) && typeof identity !== 'number') || !String(identity)) throw new SklandError('森空岛未返回账号标识。');
  return { ...response.data, identity: String(identity) };
}

function signed(path, session, body = '', headers = {}, method = 'GET') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signatureHeaders = { platform: '3', timestamp, dId: '', vName: '1.0.0' };
  const parsed = new URL(path, skland);
  const signatureBody = method === 'GET' ? parsed.search.slice(1) : body;
  const message = parsed.pathname + signatureBody + timestamp + JSON.stringify(signatureHeaders);
  const hmac = createHmac('sha256', session.token).update(message).digest('hex');
  const sign = createHash('md5').update(hmac).digest('hex');
  return request(path, skland, {
    method,
    headers: { ...signatureHeaders, sign, cred: session.cred, ...headers },
    ...(body && { body }),
  });
}

const clip = value => String(value ?? '').slice(0, 120);

export async function listRoles(session) {
  const response = await signed('/api/v1/game/player/binding', session);
  if (response.code !== 0 || !Array.isArray(response.data?.list)) {
    if (credentialError.test(response.message ?? '')) throw new SklandError('森空岛授权已失效，请重新扫码。', true);
    throw new SklandError('森空岛暂时无法同步角色，请稍后重试。');
  }
  const roles = new Map();
  for (const game of response.data.list) {
    for (const binding of Array.isArray(game?.bindingList) ? game.bindingList : []) {
      const channel = clip(binding?.channelName);
      if (game.appCode === 'arknights' && binding?.uid != null) {
        const uid = clip(binding.uid);
        const gameId = binding.gameId ?? 1;
        const key = `arknights:${gameId}:${uid}`;
        roles.set(key, { key, game: 'arknights', gameId, uid, name: clip(binding.nickName) || '明日方舟角色', channel });
      }
      if (game.appCode === 'endfield') {
        for (const role of Array.isArray(binding?.roles) ? binding.roles : []) {
          if (role?.roleId == null || role?.serverId == null) continue;
          const id = clip(role.roleId);
          const server = clip(role.serverId);
          const key = `endfield:${server}:${id}`;
          roles.set(key, { key, game: 'endfield', id, server, name: clip(role.nickname) || '终末地角色', channel });
        }
      }
    }
  }
  return [...roles.values()];
}

export async function signRole(session, role) {
  const arknights = role.game === 'arknights';
  const path = arknights ? '/api/v1/game/attendance' : '/web/v1/game/endfield/attendance';
  const body = arknights ? JSON.stringify({ gameId: role.gameId, uid: role.uid }) : '';
  const headers = { 'Content-Type': 'application/json' };
  if (!arknights) headers['sk-game-role'] = `3_${role.id}_${role.server}`;
  const result = await signed(path, session, body, headers, 'POST');
  if (result.code !== 0) {
    if (alreadySigned.has(result.message)) return { status: 'already', awards: [] };
    if (credentialError.test(result.message ?? '')) throw new SklandError('森空岛授权已失效，请重新扫码。', true);
    const code = Number.isInteger(result.code) ? `（${result.code}）` : '';
    throw new SklandError(`森空岛未能完成该角色的签到${code}。`);
  }
  const data = result.data ?? {};
  const resources = arknights
    ? (data.awards ?? []).map(item => ({ name: item.resource?.name, count: item.count }))
    : (data.awardIds ?? []).map(item => data.resourceInfoMap?.[String(item.id)]);
  const awards = resources.filter(item => isText(item?.name)).map(item => `${clip(item.name)} × ${Number(item.count) || 1}`);
  return { status: 'signed', awards };
}
