// identity.mjs 账号身份的**唯一来源**：`accountId` 兜底链 + `metadata` 紧凑化。
//
// # 真机症状（这个模块存在的理由）
//
// 登录落盘后 magpie 卡片显示成 `Signed in (pjcsg3)` —— 因为写进去的是：
//
//	"quwork#pjcsg3": {"type":"oauth", "access":"sk-…",
//	                  "accountId":"", "metadata":{"uid":"","phone":"","token":""}}
//
// 空串 `accountId` 让 magpie 回落到「随机键后缀」；空串 metadata 让「有 token 吗」
// 这类判断失真。所以这里只做两件事：
//
//	① 算出一个**绝不为空**的账号名；
//	② 把对象里的空值删掉（空串 = 没写）。

/**
 * 删掉 `undefined` / `null` / `""` 的键（其它值一律保留，包括 `0` / `false`）。
 *
 * @param {Record<string, any>} [obj]
 * @returns {Record<string, any>}
 */
export function compact(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {}
  /** @type {Record<string, any>} */
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue
    out[k] = v
  }
  return out
}

/**
 * 账号名兜底链：`phone → uid → llmToken → "llm_token:<前8位>" → label → "quwork-account"`。
 *
 * ⚠ **永不返回空串** —— 空串会让 magpie 卡片退化成「随机键后缀」。
 *
 * @param {{phone?: string, uid?: string, llmToken?: string, label?: string}} [input]
 * @returns {string}
 */
export function accountIdOf(input = {}) {
  const pick = (v) => String(v ?? "").trim()

  const phone = pick(input.phone)
  if (phone) return phone

  const uid = pick(input.uid)
  if (uid) return uid

  const llmToken = pick(input.llmToken)
  if (llmToken) return `llm_token:${llmToken.slice(0, 8)}`

  const label = pick(input.label)
  if (label) return label

  return "quwork-account"
}