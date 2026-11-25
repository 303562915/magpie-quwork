# AGENTS.md —— 给后续维护者的入口

> 人类请读 [README](./README.md)。这份只回答两件事：
> **你在改哪一块、以及忘了哪一条会静默出错。**

---

## 零、先读这条：不要重启 magpie

`127.0.0.1:3425` 这个网关就是 `magpie-windows-amd64` 进程本身。停它一次，
所有模型请求立刻全断（DSH、agent 会话、正在跑的对话全部中断）。

改完怎么生效：
1. 改代码 → node --test 全绿
2. git commit + 打 tag + git push（github:Practice019/magpie-quwork）
3. 用户在 magpie 界面点「更新」→ 热加载，不重启

永远不要：Stop-Process / Start-Process 任何 magpie*、
手改 plugins/node_modules/**、手改 plugin-providers.json（运行中进程会覆盖它）。

验证下发内容用字节数，不要用 .Length（那是字符数，中文 3 字节/字）。

### 发现 magpie 重启了，先别怪人

它自己会升级：`settings.json` 的 `updateEvery`（默认 360 分钟）到点就去 GitHub
看新版，下载成 `magpie-windows-amd64.exe.new`，替换后重启自己。升级日志会写：

```
%LOCALAPPDATA%\magpie\logs\app.log
  magpie <版本> started (app, pid …)
  update: … .exe.new goes on without its GitHub build attestation checked
```

判断顺序：
1. 先看 `app.log` 里有没有 `update:` 与新的 `started` 行 —— 有 = 自更新，与本项目无关
2. 再看版本号有没有变（升级前 0.1.4501 → 升级后 0.1.4624）
3. 两者都不成立，才怀疑有人手工重启

**要关掉自动升级**：在 magpie 设置界面改（不要手改 `settings.json` —— 运行中的进程会覆盖它）：
把「自动检查更新」关掉，或把 `updateEvery` 设为 0。

---

## 一、目录地图

| 路径 | 负责什么 |
|---|---|
| `index.mjs` | 只做「组装」：`config` / `auth.{methods,loader,usage,checkin,import,options}` / `provider.models`；面板服务的**模块级具名导出** `QuWorkPage` 也在这里（钩子对象里放 `server()` 永远不会被调用） |
| `server.mjs` | 面板本地 HTTP 服务（默认 4392；端口取 `options.port` → `$PAGESVC_PORT` → 随机口） |
| `src/hooks/loader.mjs` | 请求代理：把 `/chat/completions` 改写到模型平面，鉴权换成 `Bearer <llmToken>` |
| `src/hooks/models.mjs` | 模型目录：**只读缓存**，未命中才拉一次（模块级单飞） |
| `src/hooks/usage.mjs` | 额度卡片（有平台 token 才读得到积分；只有 llmToken 时只给说明窗） |
| `src/login.mjs` / `src/browser-login.mjs` / `src/browser-profile.mjs` | 手机号+短信登录 / 浏览器登录轮询 / 从浏览器 profile 读凭据 |
| `src/refresh.mjs` / `src/token-life.mjs` | 平台 token 续期（loader 旁路 `void` 调用，不阻塞请求） |
| `src/cache.mjs` | 磁盘缓存的**唯一**读写入口（`quwork-models-cache.json` / `quwork-usage-cache.json`） |
| `src/importer.mjs` / `src/paste-import.mjs` | `auth.import`（供应商页的「从文件导入」）/ 登录弹窗里的「粘贴导入」 |
| `page/` | `gateway.html`（沙盒入口，必须加载 `_magpie/bridge.js`）+ `index.html`/`assets/`（真页面） |
| `src/wechat-bind.mjs` | 微信**扫码绑定门户**：账号池快照 / 占位锁 / 会话 / 平台签发 state（`/api/oauth/wechat/url`） |
| `src/bind-pages.mjs` | 门户 HTML（落地页 / 出码页 / 没号页 / 出错页）——只显示编号，不显示手机号 |
| `src/qr.mjs` | 零依赖二维码编码器 + PNG（字节模式，版本 1~10，ECC L/M/Q/H） |
| `tests/` | `node --test`，纯本地、无真实网络 |

## 二、改哪块该读什么

| 你在改 | 先读 | 做完的判据 |
|---|---|---|
| 登录（短信 / 浏览器 / 粘贴） | `src/login.mjs`、`src/browser-login.mjs`、`index.mjs` 的 `makeMethods` | `node --test tests/login*.test.mjs tests/browser-login.test.mjs` 绿 |
| 请求转发 / body 形态 | `src/hooks/loader.mjs`、`src/body-shape.mjs` | `tests/loader.test.mjs`、`tests/body-shape.test.mjs` 绿 |
| 额度 / 签到 | `src/hooks/usage.mjs`、`src/invite.mjs` | `tests/usage.test.mjs`、`tests/t32-checkin-options.test.mjs` 绿 |
| 模型目录 / 缓存 | `src/hooks/models.mjs`、`src/cache.mjs` | `tests/models*.test.mjs`、`tests/t39-cache.test.mjs` 绿 |
| 面板 | `server.mjs`、`page/` | `tests/page.test.mjs` 绿 + 打开面板时零上游请求 |
| 扫码绑定门户 | `src/wechat-bind.mjs`、`src/bind-pages.mjs`、`src/qr.mjs`、`server.mjs` 的 `/bind*` 段 | `tests/wechat-bind.test.mjs` 绿 + 打开 `/bind` 零上游 |
| 导入 | `src/importer.mjs`、`src/paste-import.mjs` | `tests/importer.test.mjs`、`tests/paste-import.test.mjs` 绿 |

## 三、会静默出错的坑（症状 → 判据 → 出处）

| # | 症状 | 判据 | 出处 |
|---|---|---|---|
| 1 | 供应商的 API 地址一直是空的，请求却能发 | `config` 钩子**必须原地改入参**；返回新对象会被宿主丢弃（`host.js` L1567-1571 只读入参） | `index.mjs:83-98` |
| 2 | `magpie: (auth.methods ?? []).map is not a function` | `auth.methods` 必须是**数组**，不能是对象/函数 | `index.mjs:116-122` |
| 3 | 界面上多了/少了开关，或开关拨了不显示 | `auth.options` 是严格 schema（key 必须 `^[a-z0-9_-]{1,40}$`、≤16 项、`label` 必填）；**只有布尔**能画成开关；camelCase 的 key 会被**整项跳过**（不报错也不显示） | `index.mjs:43-59`、`index.mjs:546-566` |
| 4 | 开关拨了完全没反应 | 不能在**工厂期**读 `input.magpie.option(...)` 就当成常量：值要在真正生产行为的地方用 `input.magpie.option(provider, key)` 读（`index.mjs:602-624`）——`QuWorkPage` 就是这样再读一次才传给面板的（`index.mjs:704-716`） | `index.mjs:602-624`、`index.mjs:704-716` |
| 5 | 打开面板就打出一批上游请求 | 面板首页**零上游**：HTML/JS 是静态文件，平台调用只在用户点按钮之后 | `server.mjs:10-12` |
| 6 | magpie 一重启，每个账号各打一次 `/models` | 模型目录**只读缓存**；未命中才拉，且整个 provider 只拉一次（模块级 `inFlight` Map 去重，失败不写缓存） | `src/hooks/models.mjs:10-24`、`:216`、`:269` |
| 7 | 额度区整块变成一句错误、或好号被排到队尾 | 成功时**不写 `error`**（它会替代整个窗口）；不伪造 `used: 100`；说明性窗口一律 `aside: true` | `src/hooks/usage.mjs:26-30` |
| 8 | 发验证码一直失败，误以为「滑块是硬门槛」 | 发码必须 **form-urlencoded**；服务端不强校验滑块；频率限制是**正常业务回执**，要原样给用户 | `src/login.mjs:5-22` |
| 9 | 明明签到了，卡片却显示失败 | `auth.checkin` 的 `outcome` 只能是 `claimed/done/ineligible/inactive/captcha/failed`；`{ok,message}` 会被判 failed | `index.mjs:419-420`、`index.mjs:439-452` |
| 10 | 供应商页里没有「从文件导入」这一行 | 必须导出 `auth.import` 与 `auth.importFrom`，返回值与登录结果**同形** | `src/importer.mjs:3-15`、`index.mjs:668-675` |
| 11 | 缓存文件读不出来、或结构越改越复杂 | 缓存只有两层（按 baseUrl / 按账号），不加 `version` 之类包装；读坏当没有缓存，写失败不抛 | `src/cache.mjs:12-28` |
| 12 | 浏览器登录永远超时 | 轮询要比**整份凭据**（token 可能不变），不能只比 token 字符串 | `index.mjs:325-352` |
| 13 | 一次粘多条只存进去 1 个 | 宿主一次登录只保存一个账号；第 2..N 条必须自己走 `client.auth.set` | `src/paste-import.mjs:24-31`、`index.mjs:641-643` |
| 14 | quwork 的积分明明有，卡片却说要补平台 token | 两个 token 用途**严格分离**：`llmToken` 调模型、`token` 读积分；`token` 可能是落盘的 `token` 或 magpie 存的 `refresh`，两个都要认 | `src/hooks/usage.mjs:5-13`、`:189-191`、`:206-216` |
| 15 | 平台接口偶尔被判风控 | 平台接口**不带** `X-QurWork-*`（带了会被当成桌面客户端走另一条风控）；那两个头只给模型平面 | `src/hooks/loader.mjs:20-29`、`src/hooks/usage.mjs:219-222` |
| 16 | 门户里扫进来就显示「绑定成功」，对方什么都没做 | 出码前必须实测 `/api/user/self`；只看快照会把「早就绑过」的号发出去（真机复现：快照为空时 43 个号全被当可分配） | `src/wechat-bind.mjs` 的 `allocate()` |
| 17 | 门户绑到了**别的**账号 | 授权地址的 `state` 必须来自 `GET /api/oauth/wechat/url`（Bearer = 该号 token）；自己 `newState()` 造出来的只适合「粘 code 回来自己绑」 | `src/wechat-bind.mjs` 的 `fetchAuthorizeUrl()`、`src/wechat.mjs` 头部注释 |
| 18 | 印出来的固定码扫了打不开 | `/bind/qr.png` 里的地址取「`publicBaseUrl` → `x-forwarded-*` → Host」；反代后没配 `QUWORK_BIND_PUBLIC_URL` 会拼成内网地址 | `server.mjs` 的 `requestOrigin()` |
| 19 | 反代一切就绪后 `/bind/api/pool`、`/bind/api/sync` 对全网开放 | 反代后 `remoteAddress` 也是 127.0.0.1，所以「本机」判定必须**排除带 `x-forwarded-*` 的请求**；否则 `sync` 成了拿你 token 打平台的放大入口 | `src/wechat-bind.mjs` `authorize()`、`tests/wechat-bind.test.mjs §18` |
| 20 | 一个脚本连点几下，别人再扫就全是「暂时没有可绑定账号」 | `/bind/go` 一次占一个号 **5 分钟**（`SESSION_TTL_MS = 5 * 60 * 1000`；过期先原地续码，续满 6 次才释放），必须按 IP 节流（默认 3 秒；`allocateWindowMs: 0` 关掉，仅供测试） | `server.mjs` 的 `allowAllocate()`、`tests/wechat-bind.test.mjs §22` |
| 21 | 门户页面上的按钮跳到面板首页，或轮询 404 | 页面里的链接一律**绝对路径**（`<mount>/bind/go`）；`/bind` 的基准目录是 `/`，相对 `href="go"` 会变成 `/go` | `src/bind-pages.mjs` 的 `pathOf()`、`tests/wechat-bind.test.mjs §21` |
| 22 | 随便打开一条公网网页，你的账号池就被读走 / sync 被打满 | 整站是 `ACAO: *`（file: 面板必须），管理接口必须**另发** CORS（只认 null / 回环 Origin）；只靠回环 IP 判「本机」在反代下没用 | `server.mjs` 的 `adminCorsHeaders()`、`src/wechat-bind.mjs` `authorize()`、`tests §23` |
| 23 | 持一个 session 就能无限打 `/api/user/self` | `/bind/api/check` 按「IP+session」1 秒一次节流（`checkWindowMs`；被挡时回 `{status:"pending",throttled:true}`，不改页面文案） | `server.mjs` 的 `allowCheck()` |

## 四、测试入口

- 全量：`npm test`（= `node --test`）。测试不碰真实网络，需要上游就注入 `fetchImpl`。
- 单文件：`node --test tests/<name>.test.mjs`。
- 真机验证只在必要时做、限 1~3 次（每次都是真实上游请求）。
