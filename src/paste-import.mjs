// paste-import.mjs —— 登录弹窗里的第 5 个按钮：「从文件导入（粘贴 JSON / NDJSON）」。
//
// # 为什么要它
//
// QuWork 的账号只能靠贴 `llm_token` 一条一条来，而「从文件导入账号…」在供应商
// 详情页的最底下（账号一多就翻不到）。做成一个**登录方式**之后，导入入口就回到
// 「用哪种方式登录 QuWork?」这个弹窗里。
//
// # 为什么是 `type: "oauth"`（读宿主源码确认，不是猜）
//
// 真源：`C:\Users\21877\.cache\magpie\plugin-host\host-acc034d984c6.js`
//
//	2480-2488  methods()：只投影 type / label / labels / keyless / keyAsked / placeholder
//	2496-2498  keyAsked()：api + prompts + authorize ⇒ 宿主不再额外问 key
//	2963-2978  apiKey()：api 方法的返回值必须含 `key`，save() 写成 `{type:"api", key}`
//	2814       oauth 方法：authorize(inputs, {signal})
//	2822       oauth 方法**必须**返回带 `callback()` 的对象，否则宿主报
//	           「gave nothing to finish it with」
//	2849-2858  callback() 必须是 `{type:"success", …}`，再经 keptAs → save 落盘
//
// QuWork 的账号卡（额度 / 签到）读的是 `auth.access` + `auth.refresh`
// （见 `src/hooks/usage.mjs`、`src/refresh.mjs`），所以必须是 oauth 形状：
//
//	authorize(inputs) → { url: "", opened: true, instructions, callback }
//	callback()        → { type: "success", access: llmToken, refresh: 平台 token, … }
//
// # 一次粘很多条（宿主一次登录只保存一个）
//
//	① 第 1 条返回给宿主，由它按正常登录落盘；
//	② 其余每条走 `client.auth.set`（host.js:1346-1370，宿主写完会发 `{event:"auth"}`
//	   ⇒ 面板自动刷新，不用重启）。
//
// 键用 `quwork#<n>`，与 `src/auth-store.mjs` 的 `nextKey()` 同一套编号。

import { collectResults, IMPORT_MOST } from "./importer.mjs"
import { isMine, readAll } from "./auth-store.mjs"
import { PROVIDER } from "./constants.mjs"

/** 按钮文案。 */
export const PASTE_LABEL = "从文件导入（粘贴 JSON / NDJSON）"

/** 多语言文案（宿主 `byLang`，host.js:2464-2475）。 */
export const PASTE_LABELS = Object.freeze({ en: "import from text (JSON / NDJSON)" })

/** 输入框标题。 */
export const PASTE_MESSAGE = "账号内容（单对象 / 数组 / 每行一个对象的 NDJSON）"

/** 输入框标题的多语言版本。 */
export const PASTE_MESSAGES = Object.freeze({
  en: "account text (one object, an array, or an object per line)",
})

/**
 * 宿主 `save()` 写进 `plugin-auth.json` 的 body（host.js:2758-2763 的同构实现）。
 *
 * ⚠ 形状必须与宿主一致：`{type:"oauth", refresh, access, expires, ...extra}`。
 * 多一个少一个字段，同一个号会被 settle()（host.js:1302-1328）当成两个号。
 *
 * @param {any} result
 * @returns {object}
 */
export function authBodyOf(result) {
  const { type: _type, provider: _provider, refresh, access, expires, ...extra } = result ?? {}
  return { type: "oauth", refresh, access, expires, ...extra }
}

/**
 * 分配一个没被占用的账号键：`quwork` → `quwork#1` → `quwork#2` …
 *
 * 与 `src/auth-store.mjs` 的 `nextKey()` 同一套编号（数值后缀），只是这里**跳过**
 * 裸 `quwork`：在登录作用域里写裸 provider id 会被宿主 `keyFor()`（host.js:1229-1232）
 * 改写成「本次登录的键」，多出来的号就会全挤在同一个位置上。
 *
 * @param {string} provider
 * @param {Set<string>} taken 已被占用的键（会被就地更新）
 * @returns {string}
 */
export function nextAccountKey(provider, taken) {
  for (let i = 1; i < 100_000; i += 1) {
    const key = `${provider}#${i}`
    if (!taken.has(key)) {
      taken.add(key)
      return key
    }
  }
  const key = `${provider}#${Date.now()}`
  taken.add(key)
  return key
}

/** 当前 `plugin-auth.json` 里本插件已占用的账号键。 */
function takenKeys(configDir) {
  const taken = new Set()
  for (const key of Object.keys(readAll(configDir))) {
    if (isMine(key)) taken.add(key)
  }
  return taken
}

/**
 * 把已通过校验的账号逐条写进 `plugin-auth.json`（via 宿主的 client.auth.set）。
 *
 * @param {{client?: any, provider: string, configDir?: string, successes: any[]}} opts
 * @returns {Promise<{written: string[], errors: string[]}>}
 */
export async function writeAccounts(opts) {
  const provider = String(opts.provider ?? PROVIDER)
  const successes = Array.isArray(opts.successes) ? opts.successes : []
  /** @type {string[]} */
  const written = []
  /** @type {string[]} */
  const errors = []

  if (typeof opts.client?.auth?.set !== "function") {
    if (successes.length > 1) {
      errors.push(`当前宿主没有 client.auth.set，只导入了第 1 条（其余 ${successes.length - 1} 条未写入）`)
    }
    return { written, errors }
  }

  const taken = takenKeys(opts.configDir)
  for (const [index, result] of successes.entries()) {
    const key = nextAccountKey(provider, taken)
    try {
      await opts.client.auth.set({ path: { id: key }, body: authBodyOf(result) })
      written.push(key)
    } catch (e) {
      errors.push(`第 ${index + 1} 条：写入失败（${String(e?.message ?? e)}）`)
    }
  }
  return { written, errors }
}

/**
 * 导入本身：解析 → 逐条校验/去重 → 写盘。
 *
 * @param {{text: string, provider: string, configDir?: string, client?: any,
 *   log?: any, collect?: (texts: string[]) => Promise<any>}} opts
 * @returns {Promise<object>} 宿主 `callback()` 要的结果
 */
export async function importPastedText(opts) {
  const collect =
    typeof opts.collect === "function"
      ? opts.collect
      : (texts) => collectResults(texts, { configDir: opts.configDir })

  /** @type {any} */
  let got
  try {
    got = await collect([opts.text])
  } catch (e) {
    return { type: "failed", error: `导入失败：${String(e?.message ?? e)}` }
  }

  const results = Array.isArray(got) ? got : Array.isArray(got?.results) ? got.results : []
  const successes = results.filter((r) => r?.type === "success")
  const failures = results.filter((r) => r?.type !== "success")

  if (successes.length === 0) {
    const why = failures
      .map((f) => String(f?.error ?? "").trim())
      .filter(Boolean)
      .join("；")
    return { type: "failed", error: why || "没从粘贴的内容里认出账号（需要含 llmToken 的 JSON）" }
  }

  const { written, errors } = await writeAccounts({
    client: opts.client,
    provider: opts.provider,
    configDir: opts.configDir,
    successes,
  })

  const skipped = failures
    .map((f) => String(f?.error ?? "").trim())
    .filter(Boolean)
  const saved = written.length > 0 ? written.length : 1
  const message = [
    `已导入 ${saved} 个账号`,
    skipped.length > 0 ? `跳过 ${skipped.length} 条（${skipped.slice(0, 3).join("；")}）` : "",
    errors.length > 0 ? errors.slice(0, 3).join("；") : "",
  ]
    .filter(Boolean)
    .join("；")
  notify({ client: opts.client, log: opts.log, message, variant: skipped.length || errors.length ? "warning" : "info" })

  return successes[0]
}

function notify({ client, log, message, variant }) {
  try {
    client?.tui?.showToast?.({ title: PASTE_LABEL, message, variant })
  } catch {
    /* 没有 toast 通道就算了 */
  }
  try {
    log?.warn?.(`quwork: ${message}`)
  } catch {
    /* 日志失败不是业务失败 */
  }
}

/**
 * 构建登录弹窗里的导入 method。
 *
 * @param {{provider?: string, configDir?: string, client?: any, log?: any,
 *   collect?: (texts: string[]) => Promise<any>}} [opts]
 * @returns {object} `auth.methods` 的一项
 */
export function makePasteImportMethod(opts = {}) {
  const provider = String(opts.provider ?? PROVIDER)
  const configDir = String(opts.configDir ?? "").trim()
  const client = opts.client
  const log = opts.log ?? console

  return {
    type: "oauth",
    label: PASTE_LABEL,
    labels: { ...PASTE_LABELS },
    get prompts() {
      return [
        {
          type: "text",
          key: "text",
          message: PASTE_MESSAGE,
          messages: { ...PASTE_MESSAGES },
          validate: (v) => (String(v ?? "").trim() ? null : "请粘贴账号内容（JSON / 数组 / NDJSON）"),
        },
      ]
    },
    async authorize(inputs = {}) {
      const text = String(inputs?.text ?? "").trim()
      if (!text) return { type: "failed", error: "请粘贴账号内容（单对象 / 数组 / 每行一个对象的 NDJSON）" }

      return {
        url: "",
        opened: true,
        method: "auto",
        instructions: `正在导入账号…（单次最多 ${IMPORT_MOST} 条；导入后账号列表会自动刷新）`,
        async callback() {
          return importPastedText({ text, provider, configDir, client, log, collect: opts.collect })
        },
      }
    },
  }
}
