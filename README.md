# 森空岛签到管理 · Cloudflare Workers

在自己的 Cloudflare 账号部署后，用森空岛 App 扫码授权，即可同步《明日方舟》和《明日方舟：终末地》的角色，手动或定时签到，并将结果推送到你选择的渠道。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/smathsp/skyland-workers-dashboard)

## 一键部署

1. 点击上方按钮，登录 Cloudflare，按提示连接 GitHub 或 GitLab，选择保存项目副本的位置和 Worker 名称。
2. 为 `DB` 选择新建 D1 数据库。保留构建命令 `npm run build` 和部署命令 `npm run deploy`。向导会将 D1 绑定到 Worker，部署脚本会在发布前建表并执行后续迁移。
3. 在向导的 **Secrets** 栏填入下面两个独立的值并妥善保存，然后点击部署。游戏账号在部署后扫码绑定。
4. 打开部署成功页给出的 Worker 地址，用 `ADMIN_PASSWORD` 登录。点击「扫码添加账号」，用森空岛 App 扫码并确认。看到自己的角色后，可点「立即签到」查看结果。

| Secret | 填写方法 |
| --- | --- |
| `ADMIN_PASSWORD` | 用密码管理器生成管理员密码，建议 32 个随机字符，支持 24–256 个字符。 |
| `ENCRYPTION_KEY` | 用支持自定义字符集的密码生成器，字符集填 `0123456789abcdef`，长度设为 **64**。也可在本机运行 `openssl rand -hex 32`。它用于加密保存凭证，升级时请沿用原值。 |

默认每天北京时间 **07:00** 开始签到。可在「定时设置」修改时间，关闭面板后仍会执行。授权到期时，用同一森空岛账号重新扫码即可保留备注和历史记录。[Cloudflare 官方部署按钮说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

## 命令行部署

需要 Cloudflare 账号、Node.js 22.18+（22 系列）或 24.12+，以及 npm。以下命令从项目根目录运行。

1. 安装依赖、登录 Cloudflare 并创建 D1。

   ```sh
   npm ci
   npx wrangler login
   npx wrangler d1 create skyland-accounts
   ```

2. 将创建结果里的 `database_id` 填入 `wrangler.toml`，替换全零占位值。保持 D1 的 `binding` 为 `DB`。
3. 首次部署时生成两个独立的随机值，并写入项目内的 `.dev.vars`。下面的命令会创建该文件。如果已部署过，请保留现有的 `ENCRYPTION_KEY`，它用于解密已保存的凭证。

   ```sh
   ( umask 077; set -C; printf 'ADMIN_PASSWORD=%s\nENCRYPTION_KEY=%s\n' \
     "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" > .dev.vars )
   ```

4. 初始化远程数据库并发布 Worker。Wrangler 会输出访问地址。打开该地址，用 `.dev.vars` 里的 `ADMIN_PASSWORD` 登录。

   ```sh
   npx wrangler d1 migrations apply DB --remote
   npm run deploy -- --secrets-file .dev.vars
   ```

更新已有部署时，先运行 `npx wrangler d1 migrations apply DB --remote`，然后运行 `npm run deploy`，继续使用已有的 D1 和线上 Secrets。使用自定义生产配置时，两条命令都带上同一个 `--config` 参数。

## 动态验证码登录

1. 打开「登录安全」，用当前管理员密码确认。在支持 TOTP 的验证器中添加账号并扫码，也可以导入「复制验证器配置链接」得到的 `otpauth://` 链接。
2. 手动添加时，选择基于时间的验证码。新绑定使用 **SHA-1、6 位、30 秒**。输入验证器显示的验证码，点击「验证并启用」。
3. 此后用动态验证码登录。每组验证码只能使用一次，刚完成绑定时请等待下一组再测试登录。

升级前已启用的 **8 位**绑定继续有效，无需重新扫码。

如无法访问原验证器，部署者可通过 Cloudflare D1 控制台重置管理员登录方式。先在 Worker 配置一个临时的 `ADMIN_PASSWORD`，再在生产 D1 控制台执行以下 SQL，随后登录面板重新绑定。

```sql
UPDATE admin_auth SET generation = generation + 1, totp_secret_enc = NULL,
  enabled_at = NULL, last_step = -1, short_window = -1, short_attempts = 0,
  day_window = -1, day_attempts = 0, pending_id = NULL, pending_owner = NULL,
  pending_secret_enc = NULL, pending_expires_at = 0, pending_attempts = 0
WHERE id = 1;
```

## 本地验证

生成 `.dev.vars` 后运行下列命令，然后打开 `http://localhost:8787`。本地数据库与远程 D1 独立。

```sh
npm ci
npx wrangler d1 migrations apply DB --local
npm run check
npm test
npm run dev
```

`npm test` 在临时 D1 中验证动态验证码登录、扫码绑定、角色同步、签到、跨天定时窗口和九个推送渠道。测试使用模拟的鹰角和推送响应。

`npm run dev` 的扫码接口会连接真实的鹰角服务。App 确认后账号会存入本地数据库。点击「立即签到」会向森空岛提交真实签到。

## 消息推送

登录后进入「消息推送」。可配置 Server 酱³、PushPlus、Qmsg、Telegram、Bark、企业微信、飞书 / Lark、Discord 或 Pushover。每个渠道的配置表单会列出需要的凭证，可点击「凭证获取说明」。Telegram 还需接收会话的 Chat ID，Pushover 还需 User Key，启用了签名校验的飞书机器人还需填写签名密钥。

保存后点击「发送测试」，并在对应接收端确认消息。每个渠道可选择推送全部结果或仅失败，默认推送自动签到结果。需要手动签到也发消息时，可在该渠道中勾选。通知摘要包含游戏与签到数量，详细奖励仍可在面板查看。

D1 中的推送凭证使用 Worker Secret 加密。推送是否被服务商受理有独立状态，签到记录仍反映森空岛的实际签到结果。

## 定时与存储

- 默认每天北京时间 07:00 开始。你可以在「定时设置」修改每日开始时间，修改从下一次设定时间生效。Cloudflare 每分钟检查一次，最多在开始后三小时内逐个处理账号，当天已成功的账号会跳过。失败可在面板手动重试。
- D1 保存账号角色、签到记录和使用 AES-256-GCM 加密的通行证凭证。密钥由 Worker Secret 提供。账号被移除后，其凭证和面板记录也会从当前 D1 数据中删除。面板显示最新 30 次结果，记录在约 30 天后清理。
- 扫码和签到使用社区项目已采用的客户端接口。Cloudflare 出口、鹰角接口和账号具体状态会影响实际结果，请部署后用自己的账号完成首次扫码，并在面板确认一次手动签到。

## 来源与许可

- 感谢 **YueHen14/skyland-auto-sign** 的维护者和贡献者。该 Python 实现整理了两款游戏的角色解析、签到请求、奖励解析，并提供 Server 酱³、PushPlus 和 Qmsg 的实现参考。[上游参考版本](https://github.com/YueHen14/skyland-auto-sign/tree/b0358f15806cd24f17253796a2826789f309a6f0) · [贡献者](https://github.com/YueHen14/skyland-auto-sign/graphs/contributors)
- 上游仓库介绍注明源自 **FancyCabbage/skyland-auto-sign**。本仓库保留上游 MIT 许可全文及原署名 **Copyright (c) 2023 xxyz30**。[Gitee 项目](https://gitee.com/FancyCabbage/skyland-auto-sign) · [许可证](LICENSE) · [第三方依赖声明](frontend/public/THIRD-PARTY-NOTICES.txt)
- **ikexing-cn/skland-bot** 的资料提供了扫码授权流程参考。**xiaoyulejia/skyland-auto-sign-CFworker** 提供了 Workers 部署参考。各参考项目的许可应以各自仓库为准。[扫码项目](https://github.com/ikexing-cn/skland-bot) · [Workers 参考项目](https://github.com/xiaoyulejia/skyland-auto-sign-CFworker)
- 本仓库的适配工作包括 Workers 和 D1 存储、Vue 管理面板、可配置的定时与九个推送渠道、动态验证码登录和集成测试。

- [Cloudflare Workers Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare D1 Worker API](https://developers.cloudflare.com/d1/worker-api/)
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
