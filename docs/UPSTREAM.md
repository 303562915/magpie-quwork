# QuWork 上游实测：模型平面 + 平台平面

> 实测时间：2026-11-20 02:28–02:33（Asia/Shanghai）　客户端：`D:\software\QuWork-1.7.5-win-x64`（未运行、未登录，`qurwork-desktop.sqlite` 4 KB 空库）
> 方法：**只发无副作用请求**（无鉴权 / 假 Bearer 的 GET 与 POST），每次间隔 ≥1.2 s，共 38 个 HTTP 请求，原始响应落盘 `out/net.ndjson` / `out/net2.ndjson` / `out/cdn.ndjson` / `out/noheader.ndjson` / `out/dev.ndjson`（脚本 `D:\UserData\Documents\deepseek-harness\default-workspace\quwork-probe\probe.mjs`、`probe2.mjs`）。
> **没有注册账号、没有发短信、没有碰滑块、没有修改 `register-machine` 的任何文件。**

| 标记 | 含义 |
|---|---|
| ✅ 实测 | 真发过请求，本文件里的响应片段都是从落盘文件抄的 |
| 📖 源码/配置 | 从 `app.asar` 或客户端缓存/远程配置读到，未发请求验证 |
| ❓ 未验证 | 拿不到凭据，需真 token 才能验；附验证方法 |

---

## 0. 一句话结论

**QuWork 是「两个平面、两个 host、两套网关实现」**：

| 平面 | host | 网关 | 证据 |
|---|---|---|---|
| **模型平面** | `https://llm.quwork.cn/v1` | **new-api**（fork） | ✅ 响应头 `x-new-api-version: v0.0.0` + 错误 `type:"new_api_error"` |
| **平台平面** | `https://llm.rrzu.com/api` | **one-api**（fork） | ✅ 错误 `type:"one_api_error"`、`x-oneapi-request-id`，无 `x-new-api-version` |

- 两个 host **不是同一套部署的镜像**（DNS 不同、根页面不同、平台 401 文案中英不同、网关实现不同），但**两者都能路由 `/v1/*` 与 `/api/*`**——只是谁是谁的正式入口不同：模型=quwork.cn（配置里的 `baseURL`），平台=rrzu.com（配置里的 `apiBaseUrl`）。
- 无凭据时**全部 401**，形状见 §2.1 / §2.2；`/v1/me`、`/v1/usage` **404**（不存在）。
- 📖 `app.asar`（230.9 MB）字节级检索：`llm.quwork.cn` 命中 **2** 次、`llm.rrzu.com` 命中 **8** 次、`qurvis-desktop-model-config` **8** 次、`deepseek-flash` **24** 次，`new_api_error` / `one_api_error` **0** 次（说明两个错误串是服务端生成的，客户端只透传）。
- **任何响应都没有 `x-ratelimit-*` / `retry-after` / 额度头**（✅ 38 次全查）——插件不能靠响应头做限流/额度判断。

---

## 1. 端点表（全部无副作用实测）

> `q` = `https://llm.quwork.cn`，`p` = `https://llm.rrzu.com`。所有请求都带 `X-QurWork-Env: prod`、`X-QurWork-Version: 1.7.5`（实测这两个头**不参与鉴权**，见 §5）。

| # | 方法 | 路径 | host | 鉴权 | 无凭据 / 假凭据返回 | 备注 |
|---|---|---|---|---|---|---|
| 1 | GET | `/v1/models` | q | 无 | **401** `{"error":{"code":"","message":"Invalid token (request id: …)","type":"new_api_error"}}` | ✅ 124 B；**不看有没有给 key** |
| 2 | GET | `/v1/models` | q | 假 `Bearer sk-fake…` | **401** 同上（逐字节同形，仅 request id 不同） | ✅ 无鉴权与假鉴权**不可区分** |
| 3 | POST | `/v1/chat/completions` | q | 无 | **401** `{"error":{"code":"","message":"Invalid token …","type":"new_api_error"}}` | ✅ 124 B |
| 4 | POST | `/v1/chat/completions` | q | 假 Bearer | **401** 同上 | ✅ OpenAI 风格 `{error:{…}}` 成立 |
| 5 | GET | `/v1/me` | q | 假 Bearer | **404** `{"error":{"message":"Invalid URL (GET /v1/me)","type":"invalid_request_error","param":"","code":""}}` | ✅ 端点不存在 |
| 6 | GET | `/v1/usage` | q | 假 Bearer | **404** `…"Invalid URL (GET /v1/usage)"…` | ✅ 端点不存在 |
| 7 | GET | `/v1/models/deepseek-flash` | q | 假 Bearer | **401** `Invalid token … new_api_error` | ✅ 路由存在但鉴权前置 ⇒ **无法判定**该端点是否实现（❓） |
| 8 | GET | `/`（站点根） | q | 无 | **200** 2236 B HTML（QuWork 品牌页，含 `logo.png`、`/lib/theme.js` 注释） | ✅ 与 p 的根页不同 |
| 9 | GET | `/api/user/self` | q | 无 | **401** `{"message":"Unauthorized, not logged in and no access token provided","success":false}` | ✅ **英文**文案；说明 q 也挂了平台 API |
| 10 | GET | `/v1/models` | p | 无 | **401** `{"error":{"message":"请提供请求API-Key (request id: …)","type":"one_api_error"}}` | ✅ 105 B；**能区分「没给 key」** |
| 11 | GET | `/v1/models` | p | 假 Bearer | **401** `{"error":{"message":"API-Key无效 (request id: …)","type":"one_api_error"}}` | ✅ 102 B；**能区分「key 无效」** |
| 12 | POST | `/v1/chat/completions` | p | 无 | **401** `请提供请求API-Key … one_api_error` | ✅ |
| 13 | POST | `/v1/chat/completions` | p | 假 Bearer | **401** `API-Key无效 … one_api_error` | ✅ |
| 14 | GET | `/v1/me` | p | 假 Bearer | **404** `Invalid URL (GET /v1/me)` | ✅ 不存在 |
| 15 | GET | `/v1/usage` | p | 假 Bearer | **404** `Invalid URL (GET /v1/usage)` | ✅ 不存在 |
| 16 | GET | `/v1/models/deepseek-chat` | p | 假 Bearer | **401** `API-Key无效 … one_api_error` | ✅ 与 q 同形，鉴权前置 |
| 17 | GET | `/v1/models/deepseek-flash` | p | 假 Bearer | **401** `API-Key无效 … one_api_error` | ✅ |
| 18 | POST | `/v1/embeddings` | p | 假 Bearer | **401** `API-Key无效 … one_api_error` | 路由存在（❓ 是否真支持 embeddings） |
| 19 | GET | `/api/user/self` | p | 无 | **401** `{"message":"无权进行此操作，未登录且未提供有效的认证信息","success":false}` | ✅ 52 B，**中文** |
| 20 | GET | `/api/user/self` | p | 假 Bearer | **401** 同上（52 B） | ✅ 假 token 与无 token **文案完全相同** |
| 21 | GET | `/api/user/daily-reward/status` | p | 无 | **401** 同上 | ✅ |
| 22 | GET | `/api/user/invite/summary` | p | 无 | **401** 同上 | ✅ |
| 23 | GET | `/api/user/refresh` | p | 无 | **401** 同上 | ✅ 续期失败分支就是这条 |
| 24 | GET | `/api/user/refresh` | p | 假 Bearer | **401** 同上 | ✅ 与「过期」不可区分 |
| 25 | GET | `/`（站点根） | p | 无 | **200** 1277 B HTML（另一套前端，Inter 字体 + cdnjs） | ✅ 与 q 不同 |
| 26 | GET | `/v1/models` | q | 无，**且不带 `X-QurWork-*`** | **401** 124 B，与 #1 同形 | ✅ 头不参与鉴权（§5 对照） |
| 27 | GET | `/v1/models` | p | 无，**且不带 `X-QurWork-*`** | **401** 104 B `请提供请求API-Key … one_api_error` | ✅ 同上 |
| 28 | GET | `/api/user/self` | p | 无，**且不带 `X-QurWork-*`** | **401** 52 B，与 #19 逐字节相同 | ✅ 同上 |
| 29 | GET | `…/qurvis-desktop-app-config.json` | CDN | 无 | **200** 6326 B | ✅ 权益配置；**里面没有模型字段** |
| 30 | GET | `…/quwork-desktop-api-endpoint-config.json` | CDN | 无 | **200** 166 B `{"schemaVersion":1,"apiBaseUrl":{"dev":"https://dev-llm.rrzuji.com","test":"https://dev-llm.rrzuji.com","prod":"https://llm.rrzu.com"}}` | ✅ 平台 base 的权威来源 |
| 31 | GET | `…/qurvis-desktop-model-config.json` | CDN | 无 | **200** 4675 B（`schemaVersion:1`，`version:8`） | ✅ **模型 id 的权威来源** |
| 32 | GET | `…/qurvis-desktop-model-routing-config.json` | CDN | 无 | **200** 11508 B（`version:12`） | ✅ 客户端侧自动选模权重 |
| 33 | GET | `…/qurvis-desktop-api-endpoint-config.json` | CDN | 无 | **404** `NoSuchKey`（OSS） | ✅ 文件名是 `quwork-` 不是 `qurvis-` |
| 34 | GET | `…/quwork-desktop-model-config.json` | CDN | 无 | **404** `NoSuchKey` | ✅ 同上 |
| 35 | GET | `/v1/models` | dev | 无 | **401** 105 B `请提供请求API-Key … one_api_error` | ✅ 与生产 rrzu 同形 |
| 36 | GET | `/api/user/self` | dev | 无 | **401** 52 B 中文 `success:false` | ✅ 与生产 rrzu 同形 |

CDN 前缀：`https://img1.rrzuji.cn/qurvis-package/latest`（✅ 全部 200/404 都是这个前缀下的实测）。

> 口径说明：表里 36 行是**端点级**清单；实际发出 **38 个请求**（同一端点在两轮脚本里各打过一次，如 `p/v1/chat/completions` 打了 2 次）。每个请求的原始响应逐条在 `out/*.ndjson`。

### 1.1 curl（可逐条复跑）

```bash
Q=https://llm.quwork.cn; P=https://llm.rrzu.com
FAKE=sk-fake-000000000000000000000000000000000000000000000000

curl -sS -i $Q/v1/models | head -20                                  # ① 401 new_api_error
curl -sS -i $Q/v1/models -H "authorization: Bearer $FAKE" | head -20 # ② 同上（不可区分）
curl -sS -i -X POST $Q/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":4}'
curl -sS $Q/v1/me  -H "authorization: Bearer $FAKE"                   # 404 Invalid URL
curl -sS $Q/v1/usage -H "authorization: Bearer $FAKE"                 # 404 Invalid URL

curl -sS $P/v1/models                                                 # 401 请提供请求API-Key
curl -sS $P/v1/models -H "authorization: Bearer $FAKE"                # 401 API-Key无效
curl -sS -X POST $P/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":4}'

curl -sS $P/api/user/self                                             # 401 中文 success:false
curl -sS $P/api/user/daily-reward/status
curl -sS $P/api/user/invite/summary
curl -sS $P/api/user/refresh
curl -sS $P/api/user/refresh -H "authorization: Bearer $FAKE"         # 与上一条同文案

curl -sS https://img1.rrzuji.cn/qurvis-package/latest/qurvis-desktop-model-config.json
curl -sS https://img1.rrzuji.cn/qurvis-package/latest/quwork-desktop-api-endpoint-config.json
```

---

## 2. 错误形状（插件判错分支直接照这个写）

### 2.1 模型平面（两种，取决于 host）

```json
// llm.quwork.cn（new-api）— 无 key 与坏 key 都是这一条
{"error":{"code":"","message":"Invalid token (request id: 2026111918295964114038585488ae6P8T5chBn)","type":"new_api_error"}}
```
```json
// llm.rrzu.com（one-api）— 分两条
{"error":{"message":"请提供请求API-Key (request id: 2026112002284664735074439979963)","type":"one_api_error"}}
{"error":{"message":"API-Key无效 (request id: 2026112002284795770228439593917)","type":"one_api_error"}}
```
```json
// 路径不存在时的统一形状（两个 host 一致）
{"error":{"message":"Invalid URL (GET /v1/me)","type":"invalid_request_error","param":"","code":""}}
```

### 2.2 平台平面（`llm.rrzu.com/api/*`）

```json
{"message":"无权进行此操作，未登录且未提供有效的认证信息","success":false}
```
`llm.quwork.cn/api/*` 的同一路径是另一套文案（同一个平台 API 的英文构建）：
```json
{"message":"Unauthorized, not logged in and no access token provided","success":false}
```

### 2.3 判据表

| 场景 | 判据 | 实测 |
|---|---|---|
| 模型平面：没给 key | quwork.cn → `type:"new_api_error"`（**分不出**）；rrzu → message 含 `请提供` | ✅ ①⑩ |
| 模型平面：key 无效/过期 | rrzu → message 含 `API-Key无效`；quwork.cn → 只有 `Invalid token` | ✅ ②⑪ |
| 模型平面：路径不存在 | 404 + `type:"invalid_request_error"` + `Invalid URL (GET /v1/…)` | ✅ ⑤⑥⑭⑮ |
| 平台平面：无 token / token 坏 | **401 + `success:false`**（两者文案完全一致 ⇒ **不能用文案区分「没带」和「过期」**） | ✅ ⑲⑳㉓㉔ |
| 额度/限流 | **无任何响应头线索**，只能靠正文报错 | ✅ §4 |

> ⚠ 对插件最要紧的一条：**平台平面的 401 不区分「没带 token」与「token 过期」**。所以 refresh 失败分支只能按「401 ⇒ 需要重新登录」处理，不能指望响应告诉你是不是真过期。

---

## 3. 两个 host 是不是镜像？——**不是**

| 维度 | `llm.quwork.cn` | `llm.rrzu.com` | 判据 |
|---|---|---|---|
| DNS | `106.15.74.32` | `203.107.86.177`（CNAME `prx881fn10n93s4f.aliyunddos1020.com`） | ✅ `Resolve-DnsName` |
| 网关实现 | `x-new-api-version: v0.0.0` + `new_api_error` | 只有 `x-oneapi-request-id` + `one_api_error` | ✅ 响应头/正文 |
| 站点根 | 2236 B QuWork 品牌页 | 1277 B 另一套前端 | ✅ ⑧㉕ |
| 平台 401 文案 | 英文 | 中文 | ✅ ⑨⑲ |
| 共同点 | `server: istio-envoy`、`acw_tc` cookie（阿里云 WAF）、`strict-transport-security: max-age=15724800`、`req-arrive-time` / `req-cost-time` / `resp-start-time` | 同 | ✅ |

**结论**：两者是**同族但不同的部署**（new-api vs one-api），都同时挂了 `/v1/*` 与 `/api/*`。
⇒ 插件**不能**把「打 quwork.cn 拿到 401」当成「rrzu 也被拒」，反之亦然；`llm_token` 在哪个 host 有效必须先各自验一次（❓ 见 §7-U1）。

---

## 4. 速率限制 / 额度线索：**没有**

33 个响应里，`x-ratelimit-*`、`retry-after`、`x-quota-*`、`anthropic-ratelimit-*` **一个都没有**（逐条 grep 响应头集合，命中 0）。实际出现的头只有：`server`、`date`、`content-type`、`content-encoding`、`content-length` / `transfer-encoding`、`vary`、`set-cookie: acw_tc=…`、`strict-transport-security`、`x-envoy-upstream-service-time`、`req-arrive-time`、`req-cost-time`、`resp-start-time`、`x-oneapi-request-id`、（仅 quwork.cn）`x-new-api-version`。

⇒ 限流/额度只能从**正文报错**或**登录后的平台 API**（`/api/user/self` 里应带额度字段，❓ 未验证）拿。

---

## 5. 请求头：`X-QurWork-*` 不参与鉴权（✅ 实测）

对照组：同一路径「带 / 不带」`X-QurWork-Env: prod` + `X-QurWork-Version: 1.7.5` 各打一次——返回**同形同码**。

```json
// 带这两个头 → llm.quwork.cn/v1/models  401 124 B
{"error":{"code":"","message":"Invalid token (request id: 2026111918295964114038585488ae6P8T5chBn)","type":"new_api_error"}}
// 不带这两个头 → llm.quwork.cn/v1/models  401 124 B
{"error":{"code":"","message":"Invalid token (request id: 2026111918341247229478085488ae6S2mTj4xk)","type":"new_api_error"}}
```
```json
// 带 → llm.rrzu.com/v1/models  401 105 B ；不带 → 401 104 B（只差 request id 长度）
{"error":{"message":"请提供请求API-Key (request id: 202611200234143745274932533077)","type":"one_api_error"}}
```
```json
// 带 → llm.rrzu.com/api/user/self  401 52 B ；不带 → 401 52 B，逐字节相同
{"message":"无权进行此操作，未登录且未提供有效的认证信息","success":false}
```
⇒ 这两个头**不是鉴权因子**，只可能用于统计/灰度。插件可带可不带。

---

## 6. 模型 id 清单（可直接粘进 `DEFAULT_MODELS`）

来源：`https://img1.rrzuji.cn/qurvis-package/latest/qurvis-desktop-model-config.json`（✅ 200 / 4675 B / `schemaVersion:1` / `version:8` / `updatedAt:2026-11-04`），与本机缓存 `%APPDATA%\qurwork-desktop\qurwork-model-config-cache.json`（📖 3666 B）逐字段一致。

```json
{"key":"qurvis-desktop-model-config","schemaVersion":1,"version":8,"updatedAt":"2026-11-04T00:00:00Z","enabled":true,
 "defaultModel":{"providerId":"deepseek-official","modelId":"deepseek-flash"},
 "providers":[{"id":"qurwork","displayName":"QuWork","api":"openai-completions","baseURL":"https://llm.quwork.cn/v1","models":[ … 10 个 … ]}]}
```

| # | `id`（请求时用这个） | 显示名 | contextWindow | maxTokens | 图像 | sort |
|---:|---|---|---:|---:|---|---:|
| 1 | `deepseek-flash` | DeepSeek-V4.1-Flash | 1000000 | 384000 | ✅ | 1 |
| 2 | `deepseek-v4-pro` | DeepSeek-V4-Pro 正式版 | 1000000 | 384000 | ❌ | 2 |
| 3 | `qwen3.8-flash` | Qwen3.8-Flash | 1000000 | 128000 | ✅ | 3 |
| 4 | `glm-5.3-flash` | GLM-5.3 Flash | 1000000 | 128000 | ✅ | 4 |
| 5 | `qwen3.7-plus` | Qwen3.7-Plus | 1000000 | 128000 | ✅ | 5 |
| 6 | `MiniMax-M2.5` | MiniMax-M2.5 | 1000000 | 32768 | ❌ | 5 |
| 7 | `kimi-k2.6` | Kimi-K2.6 | 1000000 | 262144 | ✅ | 6 |
| 8 | `kimi-k2.7-code` | Kimi-K2.7-Code | 1000000 | 128000 | ❌ | 6 |
| 9 | `glm-5.2` | GLM-5.2 | 1000000 | 128000 | ❌ | 7 |
| 10 | `qwen3.8-max` | Qwen3.8-Max | 1000000 | 128000 | ❌ | 8 |

- **provider 只有一个**：`qurwork` / `openai-completions` / `baseURL=https://llm.quwork.cn/v1`。默认模型 `deepseek-flash`（注意 `defaultModel.providerId` 写的是 `deepseek-official`，但 providers 里没有这个 id —— 📖 这是配置自身的**不一致**，插件别照抄 providerId）。
- 另有 `qurvis-desktop-model-routing-config.json`（✅ 200 / 11508 B / `version:12`）：三组 `extreme`(极致) / `balanced`(均衡) / `economy`(经济)，每组 `candidates[]` 带 `modelId`、`weight`、`routing.timeWeights{peak,off-peak}`、`keywordWeights`、`sessionTitleTimeWeights`、`imageTimeWeights`。**这是客户端自己按「时段+关键词」挑模型的权重表**，不是服务端的模型别名表——插件若要做「同等能力」的模型列表，以 §6 的 10 个 id 为准即可。
- ⚠ `qurvis-desktop-app-config.json`（6326 B）**没有任何模型字段**（顶层只有 `appAvailability` / `share` / `loginWhitelist` / `dailyReward` / `invite` / `contentCreation` 等）。与模型相关的 base 只有两个，且都是别的服务：`share.baseUrl`、`contentCreation.baseUrl{prod:"https://agent-web.rrzu.com/"}`。

---

### 6.1 与 `src/constants.mjs` 的交叉核对（✅ 一致）

插件里已有的 `DEFAULT_MODELS`（10 条）与本报告 §6 的 CDN `version:8` 表**逐字段一致**（id / contextWindow / maxTokens / supportsImage 全对得上），`MODEL_BASE_URL = https://llm.quwork.cn/v1`、`PLATFORM_BASE_URL = https://llm.rrzu.com` 也与实测一致。**本轮不需要改常量；只补 `docs/UPSTREAM.md` 这份证据。**
`MODEL_BASE_URL_DEV` / `PLATFORM_BASE_URL_DEV`（`https://dev-llm.rrzuji.com`）也补测了：错误形状与生产 rrzu **同形**（one-api 构建，见端点表 #35/#36 与 U9）。

---

## 7. 对插件的直接结论

| 关注点 | 结论 | 依据 |
|---|---|---|
| models hook 打哪里 | `https://llm.quwork.cn/v1/models`，`Authorization: Bearer <llm_token>` | ✅ 配置 baseURL + 路由表 |
| models hook 的回落判据 | **401 + `type:"new_api_error"`** ⇒ 凭据不可用；**404 + `invalid_request_error`** ⇒ 路径错（不该发生）；**200 + `object:"list"`** ⇒ 正常 | ✅ §2.1 |
| 平台 hook 打哪里 | `https://llm.rrzu.com/api`（`apiBaseUrl`，来自 `quwork-desktop-api-endpoint-config.json`） | ✅ 配置 |
| 平台 401 判据 | `status===401 && body.success===false` ⇒ 登录失效（**文案不可用于细分原因**） | ✅ ⑲⑳ |
| refresh 失败分支 | `GET /api/user/refresh` 无 token / 假 token 都是同一条 401 ⇒ 只能判「需重登」 | ✅ ㉓㉔ |
| 额度/限流 | **不能用响应头**；要么读 `/api/user/self` 的额度字段（需 token，❓），要么按调用次数在本地记 | ✅ §4 |
| 两个 host 的关系 | 不能互作镜像兜底；模型平面只认 quwork.cn | ✅ §3 |

---

## 8. 未验证项（明确列出，附验证方法）

| # | 问题 | 为什么没验 | 怎么验 |
|---|---|---|---|
| U1 | `llm_token` 在 `llm.quwork.cn` 与 `llm.rrzu.com` 分别是否有效 | 本机无任何真实 token（`qurwork-desktop.sqlite` 4 KB 空库，未登录） | 拿真 `llm_token` 各打一次 `GET /v1/models`：200 ⇒ 该 host 认；401 `Invalid token` ⇒ 不认 |
| U2 | `/v1/models/{id}` 是否真实现 | 两个 host 都先鉴权后路由（401 而非 404） | 带真 token 打 `GET /v1/models/deepseek-flash`，看 200（返回单模型 JSON）还是 404 |
| U3 | `/v1/embeddings` 是否可用 | 同上（401） | 带真 token POST 一次，`model` 用 `text-embedding-3-small` 与 `qwen3.8-flash` 各一次 |
| U4 | 平台 API 的额度字段名 | 需要 token | 带真 token `GET /api/user/self`，把 `data` 全字段摘出来 |
| U5 | `llm_token` 能否打平台 API（两 token 是否通用） | 需要 token | 用 `llm_token` 打 `/api/user/self`，401 ⇒ 不通用 |
| U6 | 真限流阈值与 `Retry-After` | 无 token 打不到限流层 | 带真 token 串行 1 s 间隔连发 20 次，记录首次 429 与响应头 |
| U7 | 流式响应（SSE）的确切事件与 `usage` | 需要 token | `stream:true` 发一次，落盘原始 SSE |
| U8 | `defaultModel.providerId="deepseek-official"` 与 providers 只有 `qurwork` 的不一致是否有第二套配置 | 只找到这一份（`quwork-desktop-model-config.json` 404） | 换 `dev`/`test` CDN（`img-t1.rrzuji.cn/qurvis-package-test/lastest`）再拉一次比对 |
| U9 | ~~测试环境错误形状~~ → ✅ 已补测 | — | `dev-llm.rrzuji.com` 与生产**同形**：`/v1/models` → 401 `请提供请求API-Key … one_api_error`（105 B，无 `x-new-api-version`）；`/api/user/self` → 401 `{"message":"无权进行此操作，未登录且未提供有效的认证信息","success":false}`（52 B）。⇒ dev 是 **one-api** 构建，插件的 `*_DEV` 常量可用 |

---

## 9. 刻意没做的事

| 没做 | 原因 |
|---|---|
| 发短信 / 登录 / 注册 | 需要阿里云滑块 + 真实手机号，且会产生真实副作用 |
| 带真 token 的探测 | 本机没有登录过（空 sqlite），手上无 token |
| 打 `POST /api/user/daily-reward/claim` 等写接口 | 有副作用 |
| 修改 `register-machine/tools/quwork-probe.mjs` | 任务明确禁止 |
| 贴完整 `request id` 之外的服务端标识 | 无敏感信息可贴；`sk-fake…` 是自造的假 key |
