# QuWork 桌面端 v1.7.5 — 客户端逆向（模型平面）

> **目标**：把「QuWork 客户端怎么调模型」问清楚 —— 请求形态、token 生命周期、模型路由。
> **取证源**：本机安装的 `QuWork-1.7.5-win-x64`（只读）+ `resources/app.asar` 解包到 `_quwork_app_extract`（新建目录，未污染安装目录）+ 本机 AppData 缓存/配置/日志（只读）+ `.qurwork-desktop-dsh` 下 DSH harness home（只读）。
> **证据等级**：📖 源码（读代码/配置得出，未跑客户端）· 📄 运行落盘（本机实际生成的文件，反映真机状态）· **(推断)**（代码推导缺一环直接证据）· ❓未验证（必须抓包）
> **零改动**：未修改安装目录、未运行客户端、未改动任何 AppData 文件。

## 0.0 关键结论速览（先看这 8 条，细节在下面各节）

1. **模型平面不归 Electron 主进程管** —— 真正发 HTTP 的是内嵌的 **DSH 运行时**（`@deepseek-ai/dsh 0.2.2-rc.1`，`dsh-runtime/package.json:3-6`），
   经 `@earendil-works/pi-ai 1.5.0` 的 `openai-completions` 适配器出站（`dsh-runtime/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:198`）。
   主进程只负责**把 token 和模型表写进配置文件**。
2. **`Authorization` 用的是 `llm_token`**（经 `QURIVS_LLM_API_KEY` 这个 credential ref 间接注入），**不是**平台 `token`。
   宿主还把**同一个 `llm_token`** 同时写进 `DEEPSEEK_API_KEY`（`dist-electron/main/dsh/credentials-store.js:20-21`）。
   本机落盘可直接看到两把 ref 是**同一个 sk- 开头的字符串**（`C:\Users\21877\.qurwork-desktop-dsh\.dsh\.credentials.yaml`）。
3. **请求恒为流式**：`stream: true` 写死（`openai-completions.js:561`），且默认带 `stream_options: { include_usage: true }`（`:568-570`）。
4. **`X-QurWork-Env` / `X-QurWork-Version` 是 provider 级静态头**，由主进程按 app 环境注入（`dist-electron/main/dsh/model-injection-service.js:35-40`），
   **不在** 请求时动态计算；本机实际值 `prod` / `1.7.5`（`.qurwork-desktop-dsh\.dsh\profiles\web\cordis.patch.yml`）。
5. **UA 不是 QuWork 的**，是 pi-ai 自己拼的：`pi/1.5.0 (win32; node/vXX; x64)`（`pi-ai/dist/utils/identity.js` `formatUserAgent()` + `version.js`）。
6. **续期只续 `token`，不续 `llm_token`** —— `GET /api/user/refresh` 响应只有 `{token, expire}`，刷新逻辑**整体替换** session 但不带 `llmToken`
   （`dist-electron/main/auth/account-service.js:661-666`）。`llm_token` 的寿命由服务端说了算。
7. **401 重试只发生在平台 API 层**（`requestProtected` 对 401 刷新一次 token 后重放，`account-service.js:605-632`）；
   **模型平面 401 不刷新、不清 session**，直接报成 `INVALID_CREDENTIAL` 错误（`dsh-llm-pi-ai/lib/index.js:1934` 附近的 `MISSING_CREDENTIAL` 分支映射）。
8. **用户选的 `deepseek-flash` 就是发到上游的 `model` 字段**，**不是** 映射成别的 id；只有选「组合档」（极致/均衡/经济）时才有服务端配的虚拟模型，
   而虚拟模型**最终会落到组内 `fallback` 候选的真实 id**（`qurwork-model-router/1.0.2/dist/index.mjs` `resolveCallConfig`）。

---

## ① 请求形态

### 1.1 出站链路（谁在发）

```
QuWork 主进程 (Electron 34)
  ├─ account-service          ← 平台 API（llm.rrzu.com），Bearer <token>
  ├─ model-injection-service  ← 只写配置：settings.yaml + .credentials.yaml + profiles/web/cordis.patch.yml
  └─ 启动 dsh 运行时（dsh-runtime/，@deepseek-ai/dsh 0.2.2-rc.1）
        ├─ 插件 qurwork:model-router (1.0.2)      ← 虚拟模型（组合档）→ 真实 model id
        └─ 插件 @deepseek-ai/dsh-llm-pi-ai (0.2.2-rc.1)
              └─ @earendil-works/pi-ai (1.5.0) openai-completions
                    └─ POST https://llm.quwork.cn/v1/chat/completions   ◀── 真出站点
```

证据：`dist-electron/main/main.js:974-976`（`new ModelInjectionService(... getLlmToken: () => accountService?.getLlmToken())`）、
`dsh-runtime/package.json:3-6`、`.qurwork-desktop-dsh\.dsh\profiles\web\cordis.patch.yml`（`llm-pi-ai` 条目 + `qurwork:model-router` 条目）。

### 1.2 URL 与路径拼接

| 项 | 值 | 证据 |
|---|---|---|
| provider baseURL | `https://llm.quwork.cn/v1` | `C:\Users\21877\AppData\Roaming\qurwork-desktop\qurwork-model-config-cache.json`（`providers[0].baseURL`）；落盘后同值见 `cordis.patch.yml` |
| 路径拼法 | `new OpenAI({ baseURL })` → SDK 内部 `POST {baseURL}/chat/completions` | `pi-ai/dist/api/openai-completions.js:542-548`（`createClient` 把 `model.baseUrl` 作为 `baseURL`）、`:198`（`client.chat.completions.create(...)`） |
| 实际完整 URL | `https://llm.quwork.cn/v1/chat/completions` | 由上面两项推出；本机日志未打印该 URL（模型平面不打 request log）**(推断)** |
| 另一条 DeepSeek 兼容口 | `https://llm.quwork.cn`（**去掉 `/v1`**） | `dist-electron/main/dsh/model-config.js:19`（`STRIP_DEEPSEEK_BASE_URL_V1 = true`）、`:319-328`（`resolveDeepSeekBaseUrl`）；落盘见 `cordis.patch.yml` 的 `llm-deepseek: baseURL: https://llm.quwork.cn` |

> 注意：`/v1` 只在 `qurwork` provider 的 baseURL 里；`llm-deepseek` 那条是**故意去掉 `/v1`** 的另一个 provider（走 pi-ai 的 `deepseek` 兼容分支）。
> 宿主把**同一个 llm_token** 同时喂给两边（`credentials-store.js:20-21`）。

### 1.3 请求头逐个列出

| 头 | 取值 | 何时带 | 证据 |
|---|---|---|---|
| `Authorization` | `Bearer <llm_token>` | **恒带**（SDK 用 `apiKey` 组头） | `pi-ai/dist/api/openai-completions.js:542-548`（`new OpenAI({ apiKey, ... })`）；`apiKey` 来源：**见 §2.1** |
| `Content-Type` | `application/json` | 恒带（SDK 默认） | OpenAI SDK 行为 **(推断)**（pi-ai 未显式设置该头） |
| `User-Agent` | `pi/1.5.0 (win32; node/<process.version>; x64)` | **恒带**（pi-ai identity 默认 `detailed`） | `pi-ai/dist/utils/identity.js:43-45`（`` `${product} (${process.platform}; ${runtime}; ${process.arch})` ``）+ `:41-42`（`short` 模式才是裸 `pi`）；`pi-ai/dist/utils/version.js:2`（`PI_AI_VERSION = "1.5.0"`）；`pi-ai/dist/api/openai-completions.js:517`（`{...getIdentityHeaders(model, identity), ...model.headers}`） |
| `X-QurWork-Env` | `prod` | **恒带**（provider 级配置） | `dist-electron/main/dsh/model-config.js:10`（常量 `QURWORK_ENV_HEADER`）；注入 `model-injection-service.js:35-40`；实际值见 `.qurwork-desktop-dsh\.dsh\profiles\web\cordis.patch.yml`（`headers: { X-QurWork-Env: prod, X-QurWork-Version: 1.7.5 }`） |
| `X-QurWork-Version` | `1.7.5` | **恒带** | `model-config.js:11`；同上注入点；`appVersion` 来源 `main.js` 创建 injection 时传入 |
| `Accept` | 未显式设置 | SDK 默认 | **(推断)** OpenAI SDK 不发 `Accept` 或以 `*/*` |
| `traceparent` / `X-Request-Id` / `session_id` 类 | **不发** | `sendSessionAffinityHeaders` 对 openai-completions 默认 `withhold` | `dsh-llm-pi-ai/lib/index.js:421`、`:463`（`sendSessionAffinityHeaders: "withhold"`）；`openai-completions.js:526-537`（只有 compat 开启才发） |
| 任何 `X-QurWork-*` 其它头 | **没有** | — | 全量 grep `X-QurWork` 只有 Env / Version 两个（`model-config.js:10-11`） |

**两条链路的头不一样，别混**：

| 链路 | 头 |
|---|---|
| **模型平面**（上表） | `Authorization: Bearer <llm_token>` + `X-QurWork-Env` + `X-QurWork-Version` + pi-ai UA |
| **平台 API**（`llm.rrzu.com/api/...`） | `Authorization: Bearer <token>` + `X-QurWork-Env` + `X-QurWork-Version` + `Cache-Control: no-cache`/`Pragma: no-cache`（仅 GET）  → `dist-electron/main/network/api-request-service.js:103-115` |

### 1.4 body 逐字段（含默认值）

来源：`pi-ai/dist/api/openai-completions.js:550-738`（`buildParams`）与 `:654-665`（`thinkingFormat === "deepseek"` 分支）。
模型级 compat 来自远程配置 / 落盘配置（`deepseek-flash` 与 `deepseek-v4-pro` 声明了 compat，其余模型没有）。

| 字段 | 取值 / 默认 | 条件 | 证据 |
|---|---|---|---|
| `model` | **真实模型 id**（见 §3） | 恒带 | `:559` |
| `messages` | 转换后的对话数组（含 system 作为对话内消息） | 恒带 | `:554-560` |
| `stream` | **`true`，写死** | 恒带 | `:561` |
| `stream_options` | `{ include_usage: true }` | 默认带（compat 未声明 `supportsUsageInStreaming:false`） | `:568-570` |
| `store` | `false` | 仅当 compat `supportsStore` 为真（`deepseek-flash`/`deepseek-v4-pro` **显式 false** → 不发） | `:571-573`；远程配置 `compat.supportsStore:false` |
| `max_tokens` | 请求给多少就多少；未给则不带 | `compat.maxTokensField === 'max_tokens'`（`deepseek-*` 显式声明） | `:574-582`、`:1264` |
| `max_completion_tokens` | — | 仅当 compat 声明 `max_completion_tokens`（`deepseek-*` 不是） | `:580` |
| `temperature` | 调用方传入才带 | 有值才带 | `:583-585` |
| `tools` | 工具数组 | 有工具/有工具历史才带（有历史但无工具时发 `[]`） | `:586-595` |
| `tool_choice` | 调用方指定才带 | 条件 | `:599-601` |
| `thinking` | `{ type: 'enabled' }` 或 `{ type: 'disabled' }` | **仅** `thinkingFormat === 'deepseek'` 且 `model.reasoning` 为真（`deepseek-flash` / `deepseek-v4-pro`） | `:654-660` |
| `reasoning_effort` | `'high'`（默认）/ `off`/`low`/`max`（映射后） | 同上（`supportsReasoningEffort:true`）；`off` 时不发 `reasoning_effort` 只发 `thinking.disabled` | `:661-664`；默认值来自路由插件 `DEEPSEEK_DEFAULT_REASONING_EFFORT = 'high'`（`qurwork-model-router/1.0.2/dist/index.mjs`） |
| `enable_thinking` | — | 仅 `thinkingFormat === 'qwen'` | `:618-626` |
| `chat_template_kwargs` | — | 仅 `qwen-chat-template` / `chat-template` | `:627-638` |
| `prompt_cache_key` / `prompt_cache_retention` | — | 仅 openai 官方域或 `cacheRetention=long`（QuWork 用默认 `none`） | `:557`、`:562-566`、`:781-789` → **(推断)** 不发 |
| `priority` | — | `compat.vllmPriority` 有值才带 | `:602-604` |
| 采样参数（如 `top_p`） | — | `resolveSamplingParams()` 返回才合并 | `:734-737` |

**`thinking` 的真实形态（最容易踩的点）**：`deepseek-flash` 默认 `reasoning_effort: 'high'` → body 里是
`"thinking": {"type": "enabled"}`, `"reasoning_effort": "high"`；
用户把思考档关了 → `"thinking": {"type": "disabled"}` 且**无** `reasoning_effort`。
如果只按「OpenAI 标准参数」写，`thinking` 这个字段会被漏掉。

### 1.5 是否强制流式 / SSE 解析在哪

- **强制**：`stream: true` 是常量，没有非流式分支（`openai-completions.js:561`）。
- **SSE 解析**：不在 QuWork，也不在 DSH —— 在 **OpenAI 官方 SDK**（`import OpenAI from "openai"`，`openai-completions.js:1`）里把 SSE 拆成 chunk，
  pi-ai 再消费 `for await (const chunk of openaiStream)`（`:339`），把 `delta.content` / `delta.reasoning_content|reasoning|thinking...` /
  `delta.tool_calls` / `finish_reason` 映射成自己的事件流（`:380-478`）。
- **收尾判定**：`finish_reason` 缺失且 compat 声明 `supportsFinishReason` → 直接抛 `Stream ended without finish_reason`（`:474-476`）。
- **空闲看门狗**：`streamIdleTimeoutMs` 默认 **300000 ms（5 分钟）**（`dsh-llm-pi-ai/lib/index.js:944`、`:1130`），超时抛 `LLM_STREAM_IDLE_TIMEOUT`（`:2051`）。

---

## ② token 生命周期

### 2.1 `llm_token` 存在哪（三层，逐个说清）

| 层 | 位置 | 内容 | 证据 |
|---|---|---|---|
| **① 真实来源（主）** | `%APPDATA%\qurwork-desktop\qurwork-desktop.sqlite` → 表 `auth_session` → 行 `id=1` → 列 `session_json`（TEXT） | `{"accessToken":"<token>","llmToken":"<llm_token>","expiresAt":…,"createdAt":…,"updatedAt":…}`，`schema_version=2` | DDL：`dist-electron/main/database/migrations.js:28-40`；读写：`dist-electron/main/auth/auth-session-repository.js:9`、`:25-29`；结构校验 `:35-46`（`llmToken` 允许缺省） |
| **② 落盘快照（DSH 用）** | `C:\Users\21877\.qurwork-desktop-dsh\.dsh\.credentials.yaml` | `version: 1` / `refs: { QURIVS_LLM_API_KEY: <llm_token>, DEEPSEEK_API_KEY: <同一个 llm_token> }` / `records: {...}` | 写入：`dist-electron/main/dsh/credentials-store.js:14-31`（`:20-21` 两个 ref 都写 token）；路径：`:67-72` + `dist-electron/main/config/app-paths.js:7`（`dshHome = <home>/<dshHomeDirectoryName>`）；📄 本机实文件已确认两把 ref 同值 |
| **③ 内存** | `AccountService.session.llmToken` | 由登录响应的 `data.llm_token` 拷贝 | `dist-electron/main/auth/account-service.js:539-548`（`:544` `...(data.llm_token ? { llmToken: data.llm_token } : {})`）、读取 `:100-103` |

> **`llm_token` 不在 Electron `safeStorage` 里，也没加密** —— sqlite 那一列是**明文 JSON**（`session_json TEXT`，`migrations.js:36`），
> 上一版 `encrypted_blob BLOB` 列在 migration 13 被 **DROP** 掉了（`migrations.js:28-40`，`DROP TABLE IF EXISTS auth_session` 后重建）。
> ⇒ **任何人拿到这个 sqlite 或 `.credentials.yaml` 就等于拿到 llm_token。**

### 2.2 注入链路（从登录到第一次出站）

```
POST /api/user/client/login  → { token, llm_token, expire, user }
  → AcceptLoginData: session = { accessToken: token, expiresAt, llmToken: llm_token }
       dist-electron/main/auth/account-service.js:539-548
  → repository.save() 写 sqlite（明文）
  → publish(snapshot) → onSessionReady(reason)
       dist-electron/main/main.js:881-890
  → modelInjectionService.sync(reason)
       dist-electron/main/dsh/model-injection-service.js:27-59
          ├─ llmToken = getLlmToken()                       (:29，来自 accountService.getLlmToken())
          ├─ settings = mapRemoteModelConfigToDsh(...)      (:34)
          ├─ provider.headers = { X-QurWork-Env, X-QurWork-Version }   (:35-40)
          ├─ signature = sha256(llmToken ⊕ JSON(settings))    (:41、:76-78)
          └─ configSync.sync(harnessHome, { llmToken, settings })
               dist-electron/main/dsh/config-sync.js:51-77
                  ├─ 写 settings.yaml（模型表 + 默认模型 + deepseek baseURL）
                  ├─ 写 profiles/web/cordis.patch.yml（运行时热加载源）
                  └─ credentialsStore.setModelTokens(harnessHome, llmToken)   (:70)
                       → .credentials.yaml 的 QURIVS_LLM_API_KEY + DEEPSEEK_API_KEY
  → DSH 启动时 llm-pi-ai 通过 ctx.credentials 解析 apiKeyEnv=QURIVS_LLM_API_KEY → apiKey
       dsh-llm-pi-ai/lib/index.js:863-870（`harnessApiKeyAuth` 的 resolve → `{ auth: { apiKey: credential.key } }`）
  → pi-ai: new OpenAI({ apiKey }) → Authorization: Bearer <llm_token>
       pi-ai/dist/api/openai-completions.js:542-548
```

**重注入的触发条件**（三条，都要知道）：

| 触发 | 条件 | 证据 |
|---|---|---|
| 登录/会话就绪 | `onSessionReady(reason)` | `main.js:881-890` |
| DSH 启动/重启 | `beforeStart` / `beforeLightRestart` 调 `sync('runtime-start' \| 'light-restart', …)` | `main.js:1168-1219` |
| 手动同步模型配置 | `modelManagementService` → `sync('manual', …)` | `dist-electron/main/dsh/model-management-service.js:30` |

**幂等/跳过条件**：`signature` 不变 **且** 磁盘配置当前（`isModelConfigCurrent` 比较 providers / defaultModel / deepseek / credentials 三处）
→ 直接跳过写入（`model-injection-service.js:41-49`；`config-sync.js:22-44`）。

**凭据清理**：访问被撤销时 `onAccessRevoked` → `modelInjectionService.clearCredential()` →
`credentialsStore.clearModelTokens()` 删掉 `QURIVS_LLM_API_KEY` / `DEEPSEEK_API_KEY` / `QURWORK_WEB_SEARCH_API_KEY`（`main.js:891-894`；`credentials-store.js:43-59`）。

### 2.3 何时刷新

| 常量 | 值 | 证据 |
|---|---|---|
| `DEFAULT_ACCESS_TOKEN_TTL_MS` | 2 小时（`expire` 缺失时的兜底） | `dist-electron/main/auth/account-service.js:4`、`:764-768` |
| `ACCESS_TOKEN_REFRESH_WINDOW_MS` | 1 小时（剩余不足 1 小时就续） | `:3`、`:793-797` |
| `ACCOUNT_TOKEN_CHECK_INTERVAL_MS` | 10 分钟（后台巡检） | `dist-electron/main/auth/account-token-refresh-scheduler.js`（`AccountTokenRefreshScheduler`，`main.js:896-897` 启动） |
| `STARTUP_AUTH_REFRESH_TIMEOUT_MS` | 10 秒 | `account-service.js:6`、`:53` |

判定：`isRefreshDue(session, minimumValidityMs) = expiresAt === undefined || expiresAt <= now + minValidity`（`account-service.js:746-749`）。

**⚠ 关键**：**刷新只换 `accessToken`**，`refreshAccessToken()` 构造新 session 时**不带 `llmToken` 字段覆盖**，即沿用旧值（展开 `...session`）：

```js
this.session = { ...session, accessToken: response.data.token, expiresAt: resolveExpiresAt(...), updatedAt: now }
```
（`account-service.js:661-666`）

- 也就是说：`llm_token` **完全不参与续期**，只会在**下一次登录响应里带 `llm_token` 时**才被替换（`:544`）。
- ❓ **服务端是否会在 llm_token 过期时把它塞进 refresh 响应**：客户端代码里 refresh 只取 `data.token`
  （`account-service.js:653`、`:663` `accessToken: response.data.token`），构造新 session 时用 `...session` 展开旧值
  ⇒ **即使服务端顺手给了 `llm_token`，客户端也不会读、不会更新 `.credentials.yaml`**（代码层铁证：refresh 路径无任何 `llmToken` 赋值）。
- ❓ llm_token 的真实 TTL：客户端无任何 TTL 字段（`session` 里只有 `accessToken` 的 `expiresAt`），**只能抓包/实测**。

### 2.4 401 时怎么重试（两条链分开看）

**平台 API（有 401 重试）**：`requestProtected(request, generation)`（`account-service.js:605-632`）

```
1) token = ensureValidAccessToken()           // 快到期先续
2) request(token)
3) 401 → refreshAccessToken() → 用新 token 重放一次
4) 再 401 → clearSession()（清 sqlite + publish unauthenticated + onAccessRevoked → 清 DSH 凭据）
```
并发保护：`refreshPromise` 单飞（`:643-688`），`generation` 计数器防串号（`:691`、`:551-554`）。

**模型平面（没有 401 重试）**：
- pi-ai 的通用重试只对 `408/409/429/>=500`，**401 不在列表里**（`pi-ai/dist/utils/provider-retry.js` 的 `isRetryableProviderError`），且必须有 `x-should-retry: true` 才会覆盖。
- DSH 层把鉴权失败映射成凭据错误码：`INVALID_CREDENTIAL_CODE`（`dsh-llm-pi-ai/lib/index.js:2` 导入、`:2415` 抛出）
  与 `MISSING_CREDENTIAL`（`:1934` 的 `error.code === "MISSING_CREDENTIAL"` 分支）。
  消息分类表在同文件 `:1467-1474`：`429`/`rate.?limit` → `RATE_LIMIT`；`5xx` → `SERVER`；`timeout` → `TIMEOUT`；**401/403 不在可重试集合内**。
- ⇒ **模型平面 401 = 立刻失败**，不会自动去 `/api/user/refresh`。要恢复只能重登（或等宿主重刷配置）。
  **(推断)**：客户端 UI 层可能把 `INVALID_CREDENTIAL` 转成「重新登录」提示，但**没有任何自动续期代码路径**。

### 2.5 关联键：`QURIVS_LLM_API_KEY` 这个名字的坑

- provider 的 `apiKeyEnv` 字段值叫 **`QURIVS_LLM_API_KEY`**（不是 `QURWORK_LLM_API_KEY`），常量 `QURIVS_LLM_API_KEY`（`model-config.js:5`）。
- 这个 ref **同时被两个 provider 用**：`qurwork`（`model-config.js:244`）和 `llm-deepseek`（`DEEPSEEK_API_KEY` 独立 ref，但**值是同一个 token**）。
- `config-sync.js` 判定「托管 provider」的依据就是 `apiKeyEnv === QURIVS_LLM_API_KEY`（`config-sync.js:247-252`）——
  凡是这个值就被视为「我管的」，每次同步**先删后写**（`:235-246`）。

---

## ③ 模型路由与 `model` 字段映射

### 3.1 模型清单（真实 id，可直接作为 `DEFAULT_MODELS`）

来源：`qurwork-model-config-cache.json`（远程配置 v8，10 个模型）+ 落盘 `cordis.patch.yml`（DSH 视角，10 个同 id）。

| # | id（发给上游的 `model`） | 显示名 | 默认 | contextWindow | maxTokens | 图 | sort | 证据 |
|---|---|---|---|---|---|---|---|---|
| 1 | `deepseek-flash` | DeepSeek-V4.1-Flash | ★默认（`agent-default-model.model`） | 1000000 | 384000 | ✓ | 1 | `qurwork-model-config-cache.json`；`cordis.patch.yml`（`agent-default-model: { provider: deepseek-official, model: deepseek-flash }`） |
| 2 | `deepseek-v4-pro` | DeepSeek-V4-Pro 正式版 | | 1000000 | 384000 | | 2 | 同上 |
| 3 | `qwen3.8-flash` | Qwen3.8-Flash | | 1000000 | 128000 | ✓ | 3 | 同上 |
| 4 | `glm-5.3-flash` | GLM-5.3 Flash | | 1000000 | 128000 | ✓ | 4 | 同上 |
| 5 | `qwen3.7-plus` | Qwen3.7-Plus | | 1000000 | 128000 | ✓ | 5 | 同上 |
| 6 | `MiniMax-M2.5` | MiniMax-M2.5 | | 1000000 | **32768** | | 5 | 同上 |
| 7 | `kimi-k2.7-code` | Kimi-K2.7-Code | | 1000000 | 128000 | | 6 | 同上 |
| 8 | `kimi-k2.6` | Kimi-K2.6 | | 1000000 | **262144** | ✓ | 6 | 同上 |
| 9 | `glm-5.2` | GLM-5.2 | | 1000000 | 128000 | | 7 | 同上 |
| 10 | `qwen3.8-max` | Qwen3.8-Max | | 1000000 | 128000 | | 8 | 同上 |

**默认模型的真实 id**：`deepseek-flash`（不是 `deepseek-official/deepseek-flash` 里的 provider 部分 —— 那是 DSH 内部 **provider id**，**不进 body**）。
证据：`cordis.patch.yml` 的 `agent-default-model: { provider: deepseek-official, model: deepseek-flash }`；
`model-config.js:266-280`（默认模型选择逻辑，`preferred?.providerId === DEEPSEEK_PROVIDER_ID` 分支）。

**另外 3 个「虚拟模型」（组合档，provider id 仍是 `qurwork`，id 是组名）**：

| 虚拟 id | 显示名 | 候选真实 id（含权重） | 证据 |
|---|---|---|---|
| `extreme` | 极致 | `kimi-k2.7-code`(0) / `qwen3.8-max`(50, fallback) / `deepseek-v4-pro`(50) / `deepseek-flash`(0) / `qwen3.8-flash`(0) | `qurwork-model-routing-config-cache.json` → `groups[0]` |
| `balanced` | 均衡 | `deepseek-flash`(50, fallback) / `qwen3.7-plus`(50) / `qwen3.8-flash`(0) | `groups[1]` |
| `economy` | 经济 | `qwen3.8-flash`(50, fallback) / `glm-5.3-flash`(50) / `deepseek-flash`(50) | `groups[2]` |

> 这 3 个只在 **DSH 的模型列表**里出现（`ctx.llm.listModels` 前置拼接，`qurwork-model-router/1.0.2/dist/index.mjs` 的 `listModels` 覆写），
> 它们的 `modelInfo` 里 `contextWindow = min(候选的 contextWindow)`、`defaultMaxTokens = min(候选的 maxTokens)`。

### 3.2 「用户选 deepseek-flash 时，实际发出去的 `model` 是什么」

**答案：就是 `deepseek-flash`，一个字节都不改。**

- `qurwork-model-router` 的 `resolveCallConfig` / `prepareCall` 只对 **`groups.get(model)` 命中**的调用做替换；
  `deepseek-flash` 不是组名（组名只有 `extreme`/`balanced`/`economy`）⇒ 走 `originalResolveCallConfig` 原样透传
  （`qurwork-model-router/1.0.2/dist/index.mjs`：`const group = callConfig.provider === PROVIDER ? groups.get(String(callConfig.model)) : undefined; if (!group) { … return originalResolveCallConfig(...) }`）。
- 然后 pi-ai `buildParams` 里 `model: model.id`（`openai-completions.js:559`）—— `model.id` 就是 DSH 传给适配器的那个 id。
  ⇒ body 里 `model` = `deepseek-flash`。
- **如果是选虚拟组**（例如 UI 里选「极致」）：`resolveCallConfig` 会把 provider/model 换成 **组内 `fallback` 候选**再解析一次，
  但返回值里又**把 `provider`/`model` 改回 `qurwork`/`group.id`**（这是给上层看的）；真正出站那次在 `prepareCall().stream()` 里用
  `selected.modelId`（**sticky 或路由命中**的真实 id）重新 `originalPrepareCall`（同文件 `stream: async function*` 分支）。
  ⇒ 虚拟组最终出站的 `model` = **某一个候选真实 id**（如 `qwen3.8-max`），**永远不是** `extreme` 这种组名。

### 3.3 路由策略（决定虚拟组落到哪个真实模型）

| 维度 | 规则 | 证据 |
|---|---|---|
| 图片请求 | 先过滤掉不支持图的候选（`supportsImage`） | `index.mjs` `route()`：`candidates.filter(c => !image || c.supportsImage)` |
| 会话粘性 | 同一 session + 同一条最新 user 消息 → 复用上次候选（`sticky`，上限 256 条） | 同文件 `sticky`/`MAX_STICKY_ROUTES = 256` |
| 会话标题 | `purpose === 'session-title'` 走 `sessionTitleCandidateId` / `sessionTitleTimeWeights` | 同文件 `route()` 的 `options.purpose === 'session-title'` 分支 |
| 关键词 | 命中关键词规则时用 `keywordWeights`（如 `extreme` 组里 24 个编程词 → `kimi-k2-7-code:100`） | `qurwork-model-routing-config-cache.json` → `keywordRules[0]` |
| 时段 | 高峰 = 周一~周五 09:00-12:00 / 14:00-18:00（Asia/Shanghai），节假日排除表 37 天；其余为 off-peak | 同上 `timeRules` |
| 兜底 | 上述都没命中 → 按 `weight` 加权；仍为 0 → 组内 `fallback: true` 候选 | `index.mjs` `route()` 尾部 |
| 权重哈希种子 | `FNV-1a(sessionId ⊕ latestUserMsgId ⊕ groupId ⊕ rule…)` → 稳定但不可预测 | `weightedCandidate()` |

**`maxTokens` 会被组内最小值夹**：`groupMaxTokens = min(候选 maxTokens)`，`options.maxTokens` 未给时直接用它、给了就取 min
（`index.mjs` `groupMaxTokens` / `:Math.min(callConfig.maxTokens, maxTokens)`）。

### 3.4 思考档位（`reasoningEffort`）的客户端改写

路由插件对 **`deepseek-flash` / `deepseek-v4-pro`** 做了两条特殊处理（`index.mjs`）：

1. **默认档强制 `high`**：`DEEPSEEK_DEFAULT_REASONING_EFFORT = 'high'`，模型没声明 `reasoning.defaultEffort` 时补上。
2. **非法档位静默剔除**：请求里的 `reasoningEffort` 不在该模型声明的 `reasoningEfforts` 里 → **删掉该字段**（`withSupportedReasoningEffort`）。
   ⇒ 用户/上层传了 `medium` 而配置只声明 `off/low/high/max` 时，body 里**根本没有** `reasoning_effort`。

> 这条对做 2API 很重要：**`deepseek-flash` 不显式给档位时，客户端会自作主张发 `high`**。

---

## ④ 不确定项

### 4.1 有代码/落盘证据的（可直接用）

1. `Authorization` 的凭证 = **`llm_token`**（经 `QURIVS_LLM_API_KEY` → `.credentials.yaml` → `options.apiKey`）。
2. 出站 URL = `https://llm.quwork.cn/v1/chat/completions`，空路径拼接来自 `new OpenAI({baseURL})`。
3. 恒 `stream: true` + 默认 `stream_options.include_usage = true`。
4. `X-QurWork-Env` / `X-QurWork-Version` 是 provider 静态头（`prod` / `1.7.5`）。
5. UA 是 `pi/<pi-ai 版本> (win32; node/<ver>; x64)`，**不是** QuWork/Electron。
6. 10 个真实模型 id + 3 个虚拟组 id（`extreme`/`balanced`/`economy`）。
7. 选真实模型 → body `model` 原样 = 该 id；选虚拟组 → body `model` = 候选真实 id。
8. `deepseek-flash` / `deepseek-v4-pro` 默认 `reasoning_effort: high` + `thinking: {type: 'enabled'}`。
9. 刷新只换 `accessToken`，**不换 `llmToken`**；模型平面 401 **不自动续期**。
10. `session_json` 明文存 sqlite；`.credentials.yaml` 明文存 llm_token。

### 4.2 推断项（合理但未抓包）

| # | 推断 | 缺什么 |
|---|---|---|
| I1 | OpenAI SDK 不发 `Accept` / 用 `*/*`，且发 `Content-Type: application/json` | SDK 内部行为，未抓包 |
| I2 | `prompt_cache_key` / `prompt_cache_retention` 实际不出现在请求里（QuWork 未配 `cacheRetention`） | 依赖默认 `cacheRetention === 'none'` 的推导 |
| I3 | 模型平面的 401 在 UI 上表现为「重新登录」提示 | 只看到 `INVALID_CREDENTIAL` 映射到错误码，UI 文案未核 |

### 4.3 完全未验证（必须抓包/实测）

| # | 问题 | 验证方法 |
|---|---|---|
| U1 | `llm_token` 的真实 TTL、过期后 `/api/user/refresh` 是否**顺带下发新 llm_token**（客户端不读，但服务端可能给） | 抓 refresh 响应体全字段 |
| U2 | `https://llm.quwork.cn/v1/chat/completions` 对**裸 OpenAI 格式**（不带 `X-QurWork-*`、不带 `thinking`）是否接受 | 用同一个 llm_token 发两条：带/不带 `X-QurWork-Env`+`X-QurWork-Version`，对比 200/4xx |
| U3 | `thinking: {type: 'enabled'}` 缺省时上游是否等价于 disabled | 同一 prompt 传/不传 `thinking`，看 `reasoning_content` 是否出现 |
| U4 | 服务端是否校验 `X-QurWork-Version` 下限（旧版本被拒） | 改 `X-QurWork-Version: 1.0.0` 再发 |
| U5 | `llm-deepseek`（去掉 `/v1` 的 `https://llm.quwork.cn`）那条路是否真的被用上、和 `/v1` 那条的 body 差异 | 看 DSH 日志里是否同时出现两条 provider 的请求；或抓包比对 `baseURL` |

### 4.4 本次没覆盖

- `dsh-runtime` 里 **其它 LLM provider**（openrouter / anthropic / bedrock…）的实现。
- `qurwork-builtin` / `qurwork-dsh-bridge` 插件的协议（它们不是模型平面）。
- 微信 web-search 专属 provider（`QURWORK_WEB_SEARCH_API_KEY`，`model-config.js:9`）的请求形态。
- 本机 `%APPDATA%\qurwork-desktop` 的 Chromium 缓存（`Cache/`、`IndexedDB/` 等）—— 未解析。

---

## 附录 A：关键文件索引（复跑用）

| 用途 | 路径 |
|---|---|
| asar 解包根 | `D:\project_GIT\_quwork_app_extract`（由 `npx @electron/asar extract …` 生成，22 s） |
| 模型 id / provider 定义 | `_quwork_app_extract/dist-electron/main/dsh/model-config.js` |
| 注入（token → 配置） | `_quwork_app_extract/dist-electron/main/dsh/model-injection-service.js` |
| 凭据落盘 | `_quwork_app_extract/dist-electron/main/dsh/credentials-store.js` |
| 配置落盘 | `_quwork_app_extract/dist-electron/main/dsh/config-sync.js` |
| 路由配置 schema | `_quwork_app_extract/dist-electron/main/dsh/model-routing-config.js` |
| 虚拟模型插件 | `C:\Users\21877\AppData\Roaming\qurwork-desktop\dsh-plugins\installed\qurwork-model-router\1.0.2\dist\index.mjs` |
| OpenAI 兼容适配器 | `_quwork_app_extract/dsh-runtime/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js` |
| DSH 适配器（凭据/重试/看门狗） | `_quwork_app_extract/dsh-runtime/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js` |
| 平台 token 生命周期 | `_quwork_app_extract/dist-electron/main/auth/account-service.js` |
| 平台 API 请求头 | `_quwork_app_extract/dist-electron/main/network/api-request-service.js` |
| 运行态真实配置 | `C:\Users\21877\.qurwork-desktop-dsh\.dsh\profiles\web\cordis.patch.yml`、`.credentials.yaml` |
| 远程模型配置缓存 | `C:\Users\21877\AppData\Roaming\qurwork-desktop\qurwork-model-config-cache.json` |
| 远程路由配置缓存 | `C:\Users\21877\AppData\Roaming\qurwork-desktop\qurwork-model-routing-config-cache.json` |
| 平台 API base 缓存 | `C:\Users\21877\AppData\Roaming\qurwork-desktop\quwork-api-endpoint-config-cache.json`（`{"apiBaseUrl":"https://llm.rrzu.com"}`） |
| 运行日志 | `C:\Users\21877\AppData\Roaming\qurwork-desktop\logs\main-2026-11-20.log`（`dsh.model-config.load/sync` 显示 `modelCount: 10`、`version: 8`、`signature: d9520ec368f2`） |