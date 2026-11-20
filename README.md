# magpie-quwork

把 **QuWork（qurvis）** 的模型额度接成 magpie 的可路由供应商。

> 一句话：**一个 `llm_token` 就能调模型；平台 `token` 只影响额度显示与续期。**

---

## 1. 它做什么

| 钩子 | 行为 |
|---|---|
| `config` | 把 provider 的 `baseURL` 指向模型平面 `https://llm.quwork.cn/v1` |
| `auth.loader` | 把任何 `/chat/completions` 请求改写到模型平面，鉴权换成 `Bearer <llmToken>`，按 `bodyMode` 补客户端形态（见 §2.5） |
| `auth.usage` | 有平台 `token` → 读 `/api/user/self` 显示积分；只有 `llmToken` → 给一条说明窗（不伪造额度） |
| `auth.methods` | **数组**（magpie 直接 `map` 它），四项：① 手机号 + 短信验证码（**真登录**）② 浏览器登录（读本机客户端会话）③ 粘贴 `llm_token` ④ 粘贴 `llm_token` + 平台 `token` |
| `provider.models` | live `GET /v1/models` → 失败回落内置的 10 个权威模型 |

> ⚠ 形状踩过的坑：`auth.methods` 返回**对象或函数**会让真机装载直接炸
> （`magpie: (auth.methods ?? []).map is not a function`）。它必须是
> `Array<{type:"oauth", label, labels?, prompts?: Array<{type,key,message,placeholder?}>}>`。
> `auth.usage` / `auth.loader` / `provider.models` 则必须是**函数**，且
> `usage`/`loader` 的第一参数是 `getAuth`。`tests/shape.test.mjs` 钉住这些。

## 2. 两个 base（**别混用**）

```
模型平面  https://llm.quwork.cn/v1      ← /v1/chat/completions、/v1/models（Bearer llmToken）
平台 API  https://llm.rrzu.com         ← /api/user/self、/api/user/refresh（Bearer token）
```

真源：客户端缓存 `%APPDATA%\qurwork-desktop\qurwork-model-config-cache.json`
里 `provider.baseURL = https://llm.quwork.cn/v1`；平台接口见
`register-machine/docs/quwork/README.md §3.1`。

早期把两者当成同一个 host 会让 chat 打到平台 API 上 —— 所以代码里它们叫
`MODEL_BASE_URL` / `PLATFORM_BASE_URL`，各用各的。

### 2.5 请求形态（对齐客户端，见 `docs/CLIENT-REVERSE.md` §1.3 / §1.4）

**头**（调用方已设则不覆盖）：

```
Authorization: Bearer <llmToken>
X-QurWork-Env: prod            # dev 环境时为 dev
X-QurWork-Version: 1.7.5
User-Agent: pi/1.5.0 (win32; node/v<运行时真实版本>; x64)
Accept: application/json
```

⚠ **不发** `traceparent` / `x-request-id` / `session_id` 类头 —— 客户端对模型平面
请求是 `sendSessionAffinityHeaders: "withhold"`（§1.3）。多带一个反而更像「不是客户端」。

**body**（`bodyMode: "client-shape"`，默认）：

| 字段 | 处理 |
|---|---|
| `stream` | **强制 `true`**（客户端写死流式，§1.5） |
| `stream_options` | 缺省补 `{ include_usage: true }`；显式给的尊重 |
| `thinking` | **仅 deepseek 系**（`deepseek-flash` / `deepseek-v4-pro`）缺省注入 `{type:"enabled"}`；`reasoning_effort:"off"` 时是 `{type:"disabled"}`；已经给了就不覆盖 |
| `reasoning_effort` | **仅 deepseek 系**缺省补 `"high"`；其它模型不动 |
| `messages` / `tools` / `tool_choice` / `max_tokens` | **一个字不动**（`max_tokens` 不裁剪、不补默认） |

`bodyMode: "passthrough"` → 完全不调 `shapeBody`，**逐字节原样发**（连 `stream` 都不补）。

> `thinking` 是最容易漏的那个字段：只按「OpenAI 标准参数」写 body 会把它丢掉，
> 于是请求长得不像客户端（`docs/CLIENT-REVERSE.md` §1.4 末条）。

## 3. 凭据

```jsonc
// <magpie 配置目录>/plugin-auth.json
{
  "quwork": {
    "type": "oauth",
    "access": "llm_token_xxx",   // = llmToken（magpie 只读 access）
    "llmToken": "llm_token_xxx", // 模型 token：能调模型
    "token": "platform_xxx",     // 可选：平台 token，用于积分显示与续期
    "expire": 1800000000,        // 可选：平台 token 过期时间（秒）；缺失按 2 小时
    "uid": "u-1",                // 可选
    "phone": "138****0000"       // 可选
  },
  "quwork#1": { "...": "第二个账号依次用 quwork#1、quwork#2 ……" }
}
```

- 重复导入同一个 `llmToken`（或同 `uid`）**不会**产生重复条目
- `access` 恒等于 `llmToken`；续期只覆盖 `token`/`expire`，**绝不动** `llmToken`

## 4. 模型

默认 10 个（客户端缓存的权威列表）：

`kimi-k2.7-code`、`glm-5.2`、`qwen3.7-plus`、`MiniMax-M2.5`、`kimi-k2.6`、
`glm-5.3-flash`、`deepseek-flash`、`deepseek-v4-pro`、`qwen3.8-max`、`qwen3.8-flash`

默认模型（客户端口径）：`deepseek-flash`。

`deepseek-flash` / `deepseek-v4-pro` 在客户端配置里还带 `compat`
（`maxTokensField: "max_tokens"`、`supportsReasoningEffort: true`、
`thinkingFormat: "deepseek"`）。**本插件不硬编码这些** —— 它们属于客户端运行时，
写进 hook 只会让「请求看起来不像客户端」。需要时由调用方自己带字段。

## 5. 续期

- `expire` 缺失 → 按 **2 小时**算（客户端 `DEFAULT_ACCESS_TOKEN_TTL_MS`）
- 剩余 **< 1 小时** 才续（`ACCESS_TOKEN_REFRESH_WINDOW_MS`）
- **60 秒内最多一次**（本插件自加，防止并发请求互相把 token 换废）
- 失败只 `log.warn`，不写盘、不影响对话请求

## 6. 限制与未验证项

| # | 项 | 状态 |
|---|---|---|
| 1 | `/v1/models` 是否真的存在 | ❓ 文档只列了 chat；拿不到就回内置表 |
| 2 | `/api/user/self` 的响应字段名 | ❓ 无实测样本；按 `points/quota/balance/score` 宽容解析，认不出就说认不出 |
| 3 | `refresh` 后旧 token 是否作废 | ❓ 未验证（§7 验证清单第 2 条） |
| 4 | `llm_token` 能否打平台 API | ❓ 推测不能（用途分离）——所以只有 `llmToken` 时显示「额度未知」 |
| 5 | 注册链路 | ⚠ 发码要过阿里云滑块（§1），本插件不自动化 |

## 7. 登录（四项，按现实可行性排序）

```bash
magpie plugin install D:\project_GIT\magpie-plugins\magpie-quwork
magpie plugin login quwork        # 选登录方式
```

| # | 方式 | 说明 |
|---|---|---|
| ① | **手机号 + 短信验证码** | 真登录（登录即注册）。发码用 **form-urlencoded**、**不需要滑块票据**（服务端没强校验，旧报告的「滑块是硬门槛」是拿 JSON 打出来的误判）。有频率限制：连发会回「验证码发送过于频繁，请稍后再试」 |
| ② | **打开 QuWork 客户端登录（自动抓取）** | 点一下就**启动 QuWork 桌面客户端**（不是开网页），然后在 3 分钟内每 3 秒轮询本机凭据；读到**与进入时不同的新** `llm_token` 自动完成登录。找不到客户端才退化成浏览器打开网页 |
| ③④ | 粘贴 `llm_token`（± 平台 token） | 最后兜底，任何情况下都能用 |

> 为什么必须是客户端：`llm_token` 只有 QuWork **桌面客户端**会写进
> `%APPDATA%\qurwork-desktop\qurwork-desktop.sqlite` 的 `auth_session.session_json`
> 或 `%USERPROFILE%\.qurwork-desktop-dsh\.dsh\.credentials.yaml` 的 `QURIVS_LLM_API_KEY`。
> 用浏览器打开网页**不会**写这两处 ⇒ 轮询永远抓不到。
>
> 客户端查找顺序：`options.clientPath` → `%LOCALAPPDATA%\Programs\QuWork\QuWork.exe`
> → `%PROGRAMFILES%\QuWork\QuWork.exe` → 已知安装位置
> `D:\software\QuWork-1.7.5-win-x64\QuWork-1.7.5-win-x64.exe` → 注册表卸载项 `DisplayIcon`。

登录成功后 magpie 存下：`access = llm_token`（调模型用）、`refresh = 平台 token`（额度与续期）、`expires`（毫秒）。

> 发码端点：`POST https://llm.rrzu.com/api/sendVerifyCode`，`content-type: application/x-www-form-urlencoded`，body `phone=…&type=login`。
> 登录端点：`POST https://llm.rrzu.com/api/user/client/login`，json `{phone, verification_code, platform:"qurvis", device_identifier, device_uuid:""}`。
> `device_identifier` = `sha256("quwork-sha256-v1:" + MachineGuid|SMBIOS-UUID)`（全 0/全 F 来源跳过）。

验证模型能通：

```bash
curl https://llm.quwork.cn/v1/chat/completions \
  -H "Authorization: Bearer <llm_token>" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"ping"}]}'
```

## 7.5 迁移：清理已脏的 `plugin-auth.json`（**手工操作，插件不会自动跑**）

早期版本登录后写成了这样（真机截图）：

```jsonc
"quwork#pjcsg3": {
  "type": "oauth",
  "accountId": "",                              // ← 空 ⇒ 卡片显示 Signed in (pjcsg3)
  "access": "sk-…",
  "metadata": { "uid": "", "phone": "", "token": "" }   // ← 空串等于没写
  // expires 整个缺失
}
```

现在登录会正确写入 `accountId` / `metadata` / `expires`，但**旧条目不会自动修**。两种清理方式：

**A. 最简单 —— 删掉重新登录**

在 magpie 里删掉该 QuWork 账号，再 `magpie plugin login quwork` 走一遍。

**B. 手工改 JSON**（<magpie 配置目录>/plugin-auth.json）

```jsonc
"quwork#pjcsg3": {
  "type": "oauth",
  "access": "sk-…",            // 保持不动
  "llmToken": "sk-…",          // 保持不动
  "accountId": "13800000000",  // ① 填手机号（或任何你想要的名字，**不能是空串**）
  "metadata": {                // ② 只留非空值；全空的 metadata 直接删掉这个键
    "nickname": "13800000000",
    "phone": "13800000000"
  }                            // ③ 没有平台 token 就别写 "token" 键
}
```

判断标准（贴进去前自查）：

- `accountId` 是**非空字符串**；
- `metadata` 里**没有任何** `""` 值（全是空就整个删掉）；
- 有平台 token 才写 `token`，否则卡片会一直显示「额度未知」。

## 8. 开发

```bash
cd D:\project_GIT\magpie-plugins\magpie-quwork
node --test            # 全绿（当前 86 条）
node -e "import('./index.mjs').then(m=>console.log(Object.keys(m)))"
# → [ 'QuWorkAuthPlugin', '_internal' ]
```

> ⚠ `node --test tests`（目录作参数）在 Node 24 下会被当成**入口模块**，报
> `Cannot find module ...\tests`。用 `node --test` 自动发现，或
> `node --test "tests/*.test.mjs"`。

### 目录

```
index.mjs                  组装（config / auth.methods / auth.loader / auth.usage / provider.models）
src/constants.mjs          两个 base、路径、10 个模型、TTL、客户端 UA
src/identity.mjs           accountId 兜底链 + metadata 紧凑化（compact）
src/auth-store.mjs         plugin-auth.json 读写（多账号、去重、空值不覆盖旧值）
src/login.mjs              手机号+短信登录（form 发码 / json 登录 / device_identifier）
src/browser-login.mjs      读本机客户端会话（sqlite session_json / credentials.yaml）
src/body-shape.mjs         客户端形态：stream / stream_options / deepseek 的 thinking
src/hooks/loader.mjs       请求代理（改 URL、换鉴权、补头、按 bodyMode 塑形、旁路续期）
src/hooks/models.mjs       live 目录 → 失败回落
src/hooks/usage.mjs        积分 / 说明窗（带账号名）
src/refresh.mjs            续期（2h 兜底 / <1h 触发 / 60s 节流）
tests/*.test.mjs           86 条
```

## 9. 出处

协议真源：`D:\project_GIT\register-machine\docs\quwork\README.md`
（端点、token 语义、续期规则、证据分级）。模型表真源：客户端缓存
`qurwork-model-config-cache.json`。代码注释里以 `§x.y` 标注对应小节。
