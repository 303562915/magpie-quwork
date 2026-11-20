// index.mjs 插件入口 —— 只做「组装」。
//
// # magpie 怎么认插件
//
// 入口模块的**每个具名导出**都会被当成独立插件调用。所以这里只导出一个插件
// 函数（本插件没有页面服务，不需要第二个导出）。
//
// # 钩子集合（与 magpie-loomy 同构）
//
//	config            给宿主看的供应商配置
//	auth.methods      登录方式（本上游是**粘贴 token**，见下）
//	auth.loader       请求代理（改写 URL / 鉴权）
//	auth.usage        额度卡片
//	provider.models   模型目录
//
// # 刻意不实现
//
//	auth.refresh   续期由 loader 的旁路完成（`src/refresh.mjs`），没有独立 refresh token
//	auth.checkin   签到强制绑微信（§7），做了也拿不到
//	auth.import    批量导入是面板的能力；T-03 之后如有需要再加
//
// # 为什么登录方式是「粘贴」
//
// 注册链路卡在阿里云滑块（§1），本插件自动化不了；而 `llmToken` 与会话解耦、
// 可长期使用（§4.3）。所以最诚实的交互是：让用户/上游脚本把 token 贴进来。

import { DEFAULT_BODY_MODE, DEFAULT_MODEL_ID, MODEL_BASE_URL, PLATFORM_BASE_URL, PROVIDER } from "./src/constants.mjs"
import { makeLoaderHook } from "./src/hooks/loader.mjs"
import { makeModelsHook } from "./src/hooks/models.mjs"
import { makeUsageHook } from "./src/hooks/usage.mjs"
import { makeRefresher } from "./src/refresh.mjs"
import { upsertAccount } from "./src/auth-store.mjs"
import { PHONE_RE, CODE_RE, deviceIdentifierFrom, sendVerifyCode, loginWithCode, isCodeError } from "./src/login.mjs"
import { readLocalCredential, pollForNewCredential } from "./src/browser-login.mjs"
import { makeLaunchLoginSource } from "./src/launch-client.mjs"
import { defaultOpenExternal } from "./src/open-url.mjs"
import { compact, accountIdOf } from "./src/identity.mjs"

/** `config` 钩子：只描述供应商本身，不发请求。 */
function makeConfigHook(opts = {}) {
  return (provider) => {
    const prior = provider ?? {}
    return {
      ...prior,
      name: prior.name || "QuWork",
      baseURL: opts.modelBaseUrl || MODEL_BASE_URL,
      options: {
        ...(prior.options ?? {}),
        baseURL: opts.modelBaseUrl || MODEL_BASE_URL,
      },
    }
  }
}

/**
 * `auth.methods`：**数组**，每项一种登录方式（真实契约，实测自 magpie-loomy 的装载结果）。
 *
 * # 真机报错（这条注释就是防止再犯的）
 *
 *	magpie: (auth.methods ?? []).map is not a function
 *
 * magpie 直接把 `auth.methods` 当数组 `map`。返回对象/函数都会炸。
 *
 * # 三项（按现实可行性排序）
 *
 *	① 手机号 + 短信验证码  —— 真登录。⚠ 发码要过阿里云滑块（服务端强校验），
 *	                          没票据时会在 `instructions` 里如实告知走 ②
 *	② 浏览器登录（读取本机客户端会话）—— 最现实的路径：客户端登录一次即可
 *	③ 粘贴 llm_token        —— 最后兜底，任何情况下都能用
 *
 * # 契约（host 源码语义）
 *
 *	{ type: "oauth", label, labels?, prompts?, authorize(inputs, {signal}), callback(code?, {signal}) }
 *
 *	`authorize` → { method: "code", callback, instructions? }（method==="code" 时
 *	               magpie 会问用户输入验证码，填完调 `callback(code, …)`）
 *	`callback`  → { type: "success", access, refresh, expires, accountId?, metadata? }
 *	              ⚠ `access` 必须是 **llm_token**（loader 拿它调模型）；
 *	                 平台 `token` 放 `refresh`（magpie 的 keptAs 看到它就保留）
 *
 * @param {{platformBaseUrl?: string, configDir?: string, log?: any,
 *   fetchImpl?: typeof fetch, readLocal?: () => any}} [opts]
 * @returns {Array<object>}
 */
function makeMethods(opts = {}) {
  const platformBaseUrl = String(opts.platformBaseUrl ?? "").trim() || PLATFORM_BASE_URL
  const log = opts.log ?? console
  const fetchImpl = opts.fetchImpl
  const readLocal = typeof opts.readLocal === "function" ? opts.readLocal : () => readLocalCredential()
  const configDir = String(opts.configDir ?? "").trim()

  // ── 打开登录入口（客户端优先 / 网页兜底）+ 轮询参数（都可注入）──
  const launchLoginSource = makeLaunchLoginSource({
    clientPath: opts.clientPath,
    exists: opts.exists,
    spawnImpl: opts.spawn,
    readRegistry: opts.readRegistry,
    openExternal: typeof opts.openExternal === "function" ? opts.openExternal : defaultOpenExternal,
    log,
  })
  const pollMs = Number.isFinite(opts.pollMs) ? Number(opts.pollMs) : 180_000
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) ? Number(opts.pollIntervalMs) : 3000
  /** @type {((ms: number) => Promise<void>) | undefined} */
  const sleep = typeof opts.sleep === "function" ? opts.sleep : undefined
  /** @type {(() => number) | undefined} */
  const now = typeof opts.now === "function" ? opts.now : undefined

  /** 一次发码会话里暂存的信息（按 phone 索引；进程内有效）。 */
  const pending = new Map()

  /**
   * 把「登录成功」统一翻译成 magpie 的 success 形状。
   *
   * ⚠ `access` 必须是 **llm_token**（loader 拿它调模型）
   * ⚠ `refresh` 必须**存在**（哪怕空串）：magpie 的 keptAs 见到 refresh 就保留凭据
   * ⚠ `expires` 是**毫秒**（上游 `expire` 是秒，要 ×1000）；**没有就不写这个键**
   * ⚠ `accountId` **绝不允许空串**（空串 ⇒ 卡片退化成 `Signed in (pjcsg3)`）
   * ⚠ `metadata` 只放非空值（空串等于没写，还会让「有 token 吗」失真）
   *
   * @param {{llmToken: string, token?: string, expire?: number}} r
   * @param {string} [accountIdHint] 已知的账号名（手机号等）
   * @param {{uid?: string, phone?: string}} [extra]
   */
  const successOf = (r, accountIdHint, extra = {}) => {
    const phone = String(extra.phone ?? accountIdHint ?? "").trim()
    const uid = String(extra.uid ?? "").trim()
    const rawExpire = Number(r?.expire)
    const expiresMs = Number.isFinite(rawExpire) && rawExpire > 0 ? (rawExpire < 1e11 ? rawExpire * 1000 : rawExpire) : 0

    return {
      type: "success",
      access: r.llmToken,
      refresh: r.token ?? "",
      ...(expiresMs > 0 ? { expires: expiresMs } : {}),
      accountId: accountIdOf({ phone, uid, llmToken: r.llmToken }),
      metadata: compact({ uid, phone, nickname: phone, token: r.token }),
    }
  }

  /** 顺便把凭据写进 plugin-auth.json（失败不影响登录成功本身）。 */
  const persist = (r, phone) => {
    if (!configDir) return
    try {
      upsertAccount(configDir, {
        llmToken: r.llmToken,
        token: r.token || undefined,
        expire: r.expire || undefined,
        phone,
        uid: phone,
      })
    } catch (e) {
      log?.warn?.(`quwork: 保存凭据失败（登录仍然成功）: ${String(e?.message ?? e).slice(0, 160)}`)
    }
  }

  /* ── ① 手机号 + 短信验证码 ───────────────────────────────────────── */

  const smsMethod = {
    type: "oauth",
    label: "手机号 + 短信验证码",
    labels: { en: "phone + SMS code" },
    // ⚠ 同时挂在方法上：magpie 两种取法都见过（从 authorize 返回值取，或直接读方法）
    callback: smsCallback,
    prompts: [
      {
        type: "text",
        key: "phone",
        message: "手机号（中国大陆 11 位）",
        placeholder: "13800000000",
        validate: (v) => (PHONE_RE.test(String(v ?? "").trim()) ? null : "手机号格式不对"),
      },
    ],
    /**
     * 发码。⚠ 必须**立刻**返回（magpie 靠返回值判断下一步问什么）。
     *
     * 真机实测（2026-11-20）：**form-urlencoded** 提交、**不带** `aliyun_captcha`
     * —— 服务端没强校验，滑块只是前端 UX。旧报告拿 JSON 打才失败。
     *
     * @param {any} inputs
     */
    async authorize(inputs = {}) {
      const phone = String(inputs?.phone ?? "").trim()
      if (!PHONE_RE.test(phone)) return { type: "failed", error: "手机号格式不对" }

      const sent = await sendVerifyCode({ platformBaseUrl, phone, fetchImpl })
      if (!sent.ok) {
        // 频率限制是**正常业务回执**（"验证码发送过于频繁，请稍后再试"），原样交给用户
        return {
          type: "failed",
          error: sent.rateLimited ? `发送验证码失败：${sent.error}（稍后再试）` : `发送验证码失败：${sent.error}`,
        }
      }

      pending.set(phone, { deviceIdentifier: deviceIdentifierFrom() })
      return {
        method: "code",
        callback: smsCallback,
        instructions: `验证码已发送到 ${phone}`,
      }
    },
  }

  /**
   * 填完验证码后调这里（`method === "code"` 时 magpie 会把 code 传进来）。
   *
   * @param {string} [code]
   */
  async function smsCallback(code) {
    const phone = String(pending.keys().next().value ?? "").trim()
    if (!phone) return { type: "failed", error: "登录会话已失效，请重新发起" }

    const value = String(code ?? "").trim()
    // 格式先自己挡：4~8 位数字（省一次无用的上游请求）
    if (!CODE_RE.test(value)) return { type: "failed", error: "验证码格式不对（4~8 位数字）" }

    const one = pending.get(phone) ?? { deviceIdentifier: deviceIdentifierFrom() }
    const r = await loginWithCode({
      platformBaseUrl,
      phone,
      code: value,
      deviceIdentifier: one.deviceIdentifier,
      fetchImpl,
    })
    if (!r.ok) {
      // 验证码错允许重试（不清 pending）
      return { type: "failed", error: isCodeError(r.error) ? `验证码错误或已过期：${r.error}` : r.error }
    }
    if (!r.llmToken) {
      return { type: "failed", error: "登录成功但没有 llm_token，请改用「浏览器登录（读取本机客户端）」" }
    }
    pending.delete(phone)

    const uid = String(r.user?.id ?? r.user?.uid ?? "")
    persist(r, phone)
    return successOf(r, phone, { uid, phone })
  }

  /* ── ② 打开登录入口（QuWork 客户端优先）+ 轮询抓取 ──────────────── */

  const browserMethod = {
    type: "oauth",
    label: "打开 QuWork 客户端登录（自动抓取）",
    labels: { en: "launch QuWork client and capture the session" },
    // 同 sms：方法级也挂一份（两种取法都兼容）
    callback: browserCallback,
    /**
     * 点一下就打开**能产生凭据的那个东西**：
     *
     *	① QuWork 桌面客户端（`llm_token` 只有它会写进 sqlite / credentials.yaml）
     *	② 找不到客户端才退化成网页登录页
     *
     * ⚠ 立刻返回（谁都不等）；真正的等待在 `callback` 里的轮询。
     */
    async authorize(inputs, { signal } = {}) {
      const how = await launchLoginSource()
      // 客户端场景**不给 url**：给了 magpie 会再开一个网页，用户会以为要登录两次
      return {
        url: how?.kind === "browser" ? String(how.target ?? "") : "",
        method: "other",
        callback: browserCallback,
        instructions:
          how?.kind === "client"
            ? "已启动 QuWork 客户端，请在客户端里完成登录（手机号 / 微信），登录完成后这里会自动继续"
            : "已在浏览器打开登录页，完成后这里会自动继续",
      }
    },
  }

  /**
   * 轮询抓取新凭据。
   *
   * # 为什么先快照基准
   *
   * 本机可能**已经**有上次登录留下的旧凭据。不比对的话第一次读就「成功」，
   * 用户拿到的其实是旧账号。所以进入时快照旧值，只接受 ≠ 旧值
   * （旧值本来为空则任意非空都算新）。
   */
  async function browserCallback(_input, { signal } = {}) {
    let baseline = ""
    try {
      const first = readLocal()
      baseline = String(first?.llmToken ?? "").trim()
    } catch {
      baseline = ""
    }

    const polled = await pollForNewCredential({
      readLocal,
      baseline,
      signal,
      pollMs: pollMs,
      pollIntervalMs: pollIntervalMs,
      sleep,
      now,
    })
    if (!polled.ok) return { type: "failed", error: polled.error }

    const local = polled.cred
    const r = { llmToken: local.llmToken, token: local.token ?? "", expire: local.expire ?? 0 }
    const uid = String(local.uid ?? "").trim()
    const phone = String(local.phone ?? "").trim()
    persist(r, phone)
    return successOf(r, phone, { uid, phone })
  }

  /* ── ③ 粘贴（最后兜底）────────────────────────────────────────── */

  const LLM_PROMPT = {
    type: "password",
    key: "llmToken",
    message: "llm_token（sk- 开头，用于调模型）",
    placeholder: "sk-...",
  }
  const PLATFORM_PROMPT = {
    type: "password",
    key: "token",
    message: "平台 token（可选，用于显示积分与续期）",
    placeholder: "留空则只调模型",
  }

  const pasteMethods = [
    {
      type: "oauth",
      label: "粘贴 llm_token",
      labels: { en: "paste llm_token" },
      prompts: [LLM_PROMPT],
      async authorize(inputs = {}) {
        const llmToken = String(inputs?.llmToken ?? "").trim()
        if (!llmToken) return { type: "failed", error: "缺少模型 token（llm_token）" }
        persist({ llmToken, token: "", expire: 0 }, "")
        return successOf({ llmToken, token: "", expire: 0 }, "")
      },
    },
    {
      type: "oauth",
      label: "粘贴 llm_token + 平台 token",
      labels: { en: "paste llm_token + platform token" },
      prompts: [LLM_PROMPT, PLATFORM_PROMPT],
      async authorize(inputs = {}) {
        const llmToken = String(inputs?.llmToken ?? "").trim()
        if (!llmToken) return { type: "failed", error: "缺少模型 token（llm_token）" }
        const token = String(inputs?.token ?? "").trim()
        persist({ llmToken, token, expire: 0 }, "")
        return successOf({ llmToken, token, expire: 0 }, "")
      },
    },
  ]

  return [smsMethod, browserMethod, ...pasteMethods]
}

/**
 * 供应商插件。
 *
 * @param {{client?: any, directory?: string}} [input] `directory` = magpie 配置目录
 * @param {object} [options] plugins.json 里这一项的 options（`baseUrl` / `platformBaseUrl`）
 * @returns {Promise<object>}
 */
export const QuWorkAuthPlugin = async (input = {}, options = {}) => {
  const configDir = String(input?.directory ?? options?.configDir ?? "").trim()
  const modelBaseUrl = String(options?.baseUrl ?? "").trim() || MODEL_BASE_URL
  const platformBaseUrl = String(options?.platformBaseUrl ?? "").trim() || PLATFORM_BASE_URL
  // body 形态：默认 client-shape（补 stream/thinking）；passthrough = 逐字节原样
  const bodyMode = String(options?.bodyMode ?? "").trim() || DEFAULT_BODY_MODE

  const log = input?.client?.app?.log
    ? { warn: (m) => input.client.app.log({ body: { service: PROVIDER, level: "warn", message: m } }) }
    : (options?.log ?? console)

  // 续期器：loader 每条对话请求后 `void` 调一次（节流 60s，失败只 log）
  const refresh = makeRefresher({ configDir, log, platformBaseUrl })

  return {
    config: makeConfigHook({ modelBaseUrl }),
    auth: {
      provider: PROVIDER,
      methods: makeMethods({
        platformBaseUrl,
        configDir,
        log,
        // 测试/排障注入点（生产不传 = 用全局 fetch 与本机读取）
        fetchImpl: typeof options?.fetchImpl === "function" ? options.fetchImpl : undefined,
        readLocal: typeof options?.readLocal === "function" ? options.readLocal : undefined,
        // 打开登录入口 / 轮询：全部可注入（生产不传 = 真启动客户端、真轮询 3 分钟）
        clientPath: options?.clientPath,
        openExternal: typeof options?.openExternal === "function" ? options.openExternal : undefined,
        exists: typeof options?.exists === "function" ? options.exists : undefined,
        spawn: typeof options?.spawn === "function" ? options.spawn : undefined,
        readRegistry: typeof options?.readRegistry === "function" ? options.readRegistry : undefined,
        pollMs: options?.pollMs,
        pollIntervalMs: options?.pollIntervalMs,
        sleep: typeof options?.sleep === "function" ? options.sleep : undefined,
        now: typeof options?.now === "function" ? options.now : undefined,
      }),
      loader: makeLoaderHook({ modelBaseUrl, log, refresh, bodyMode }),
      usage: makeUsageHook({ platformBaseUrl, log }),
    },
    provider: {
      id: PROVIDER,
      models: makeModelsHook({ modelBaseUrl, log }),
    },
  }
}

/**
 * 测试与排障用的内部引用。
 *
 * ⚠ 挂在一个对象上，不要散着导出 —— 入口的每个具名导出都会被当成插件调用。
 */
export const _internal = {
  PROVIDER,
  MODEL_BASE_URL,
  PLATFORM_BASE_URL,
  DEFAULT_MODEL_ID,
  makeConfigHook,
  makeMethods,
  makeLoaderHook,
  makeModelsHook,
  makeUsageHook,
  makeRefresher,
}
