import { createHmac } from 'node:crypto';

const plainKey = /^[A-Za-z0-9_-]+$/;
const serverChanKey = /^sctp(\d{1,20})t[A-Za-z0-9_-]+$/;
const telegramToken = /^\d{1,20}:[A-Za-z0-9_-]+$/;
const telegramChat = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const barkUrl = /^https:\/\/api\.day\.app\/([A-Za-z0-9_-]+)\/?$/;
const wecomUrl = /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=([A-Za-z0-9_-]+)$/;
const feishuUrl = /^https:\/\/open\.(?:feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/;
const discordUrl = /^https:\/\/(?:discord\.com|discordapp\.com)\/api(?:\/v\d{1,2})?\/webhooks\/(\d{1,24})\/([A-Za-z0-9_-]+)\/?$/;
const pushoverKey = /^[A-Za-z0-9]{30}$/;
const withTitle = (title, text) => `${title}\n${text}`;
const valueMatching = (pattern, value) => pattern.test(value) ? value : '';
const keyFrom = (pattern, value) => pattern.exec(value)?.[1] ?? valueMatching(plainKey, value);

export const providers = {
  serverchan: {
    normalize: value => valueMatching(serverChanKey, value),
    format: '请输入以 sctp 开头的 Server 酱³ SendKey。',
    request(token, title, text) {
      const [, uid] = serverChanKey.exec(token);
      return [`https://${uid}.push.ft07.com/send/${encodeURIComponent(token)}.send`, { title, desp: text }];
    },
    accepted: response => response?.code === 0,
  },
  pushplus: {
    normalize: value => valueMatching(plainKey, value),
    format: '请输入有效的 PushPlus Token。',
    request: (token, title, text) => ['https://www.pushplus.plus/send', { token, title, content: text, template: 'txt' }],
    accepted: response => response?.code === 200,
  },
  qmsg: {
    normalize: value => valueMatching(plainKey, value),
    format: '请输入有效的 Qmsg API Key。',
    request: (token, title, text) => [`https://qmsg.zendee.cn/v3/jsend/${encodeURIComponent(token)}`, { msg: withTitle(title, text) }],
    accepted: response => response?.success === true,
  },
  telegram: {
    normalize: value => valueMatching(telegramToken, value),
    format: '请输入有效的 Telegram Bot Token。',
    extra: { required: true, pattern: telegramChat, format: '请输入 Telegram Chat ID，可使用数字 ID 或公开频道的 @用户名。' },
    request: (token, title, text, chatId) => [`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: withTitle(title, text) }],
    accepted: response => response?.ok === true,
  },
  bark: {
    normalize: value => keyFrom(barkUrl, value),
    format: '请输入 Bark 设备 Key 或 api.day.app 的设备地址。',
    request: (token, title, text) => ['https://api.day.app/push', { device_key: token, title, body: text, group: '森空岛签到' }],
    accepted: response => response?.code === 200,
  },
  wecom: {
    normalize: value => keyFrom(wecomUrl, value),
    format: '请输入企业微信群机器人 Webhook 或其中的 key。',
    request: (key, title, text) => [`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`,
      { msgtype: 'text', text: { content: withTitle(title, text) } }],
    accepted: response => response?.errcode === 0,
  },
  feishu: {
    normalize: value => valueMatching(feishuUrl, value),
    format: '请输入飞书或 Lark 群自定义机器人 Webhook。',
    extra: { required: false, pattern: plainKey, format: '请输入有效的飞书机器人签名密钥。' },
    request(hook, title, text, secret) {
      const payload = { msg_type: 'text', content: { text: withTitle(title, text) } };
      if (secret) {
        payload.timestamp = String(Math.floor(Date.now() / 1000));
        payload.sign = createHmac('sha256', `${payload.timestamp}\n${secret}`).digest('base64');
      }
      return [hook, payload];
    },
    accepted: response => (response?.code ?? response?.StatusCode) === 0,
  },
  discord: {
    normalize(value) {
      const match = discordUrl.exec(value);
      return match ? `https://discord.com/api/webhooks/${match[1]}/${match[2]}` : '';
    },
    format: '请输入 Discord 频道的 Webhook 地址。',
    request: (hook, title, text) => [`${hook}?wait=true`, { content: withTitle(title, text).slice(0, 2000), allowed_mentions: { parse: [] } }],
    accepted: response => typeof response?.id === 'string',
  },
  pushover: {
    normalize: value => valueMatching(pushoverKey, value),
    format: '请输入 Pushover 的 30 位应用 Token。',
    extra: { required: true, pattern: pushoverKey, format: '请输入 Pushover 的 30 位 User Key。' },
    formEncoded: true,
    request: (token, title, text, user) => ['https://api.pushover.net/1/messages.json', { token, user, title, message: text.slice(0, 1024) }],
    accepted: response => response?.status === 1,
  },
};
