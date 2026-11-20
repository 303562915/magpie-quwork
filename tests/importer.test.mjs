// importer.test.mjs —— T-33：`auth.import`（「从文件导入」按钮）
//
// # 为什么需要这个文件
//
// 真机核对「添加提供商」时发现：loomy / officeace / codearts 都有「从文件导入」，
// **只有 quwork 没有** —— 因为 `auth` 里压根没写 `importFrom` / `import`。
// magpie 看不到这个键就干脆不画那一行（不是报错，是静默缺失，最难发现的那种）。
//
// 这里把三件事钉死：
//
//	① 插件真的暴露了钩子（`auth.importFrom` 非空 + `auth.import` 可调）
//	② 返回形状与一次正常登录同形（`{type:"success", access, refresh, expires,
//	   accountId, metadata}`），否则 magpie 存不成账号
//	③ 宽容解析 + 去重 + 100 条上限都按契约来
//
// ⚠ 全部离线：只碰临时目录里的 `plugin-auth.json`，零网络。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { QuWorkAuthPlugin } from "../index.mjs"
import { makeImportHook, IMPORT_FROM, IMPORT_MOST } from "../src/importer.mjs"

const json = (value) => JSON.stringify(value)

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "quwork-import-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 造一个隔离的钩子（不经过插件入口，用于逐条规则的单测）。 */
function hook(dir) {
  return makeImportHook({ configDir: dir, log: { warn() {} } })
}

/** 造一条独立的账号行（token 唯一，可以同批导入）。 */
const row = (n, over = {}) => ({ llmToken: `sk-batch-${n}`, ...over })

// ═══ ① 钩子本身 ═══════════════════════════════════════════════════════

test("T33-1) 单对象 {llmToken} → success，accountId 非空；入口真的暴露了 importFrom", async (t) => {
  const dir = tempDir(t)
  // 走**插件入口**，确认 `auth.import` / `auth.importFrom` 挂对了地方
  // （挂在返回对象顶层等于没写 —— 宿主读的是 `auth.importFrom`）。
  const plugin = await QuWorkAuthPlugin({ directory: dir }, {})

  assert.equal(typeof plugin.auth.import, "function", "auth.import 必须是函数")
  assert.equal(plugin.auth.importFrom, IMPORT_FROM)
  assert.match(plugin.auth.importFrom, /QuWork.*JSON/)
  assert.equal(plugin.auth.provider, "quwork", "钩子必须挂在 quwork 的 auth 上")

  const results = await plugin.auth.import([json({ llmToken: "sk-single-1234" })])

  assert.equal(results.length, 1)
  const [first] = results
  assert.equal(first.type, "success")
  assert.equal(first.access, "sk-single-1234")
  assert.ok(first.accountId, "accountId 不能为空串（会让卡片退化成随机键）")
  assert.equal(first.accountId, "llm_token:sk-singl")
  // 没有可选字段时 metadata 里不该留空串
  assert.deepEqual(first.metadata, {})
  assert.equal(first.refresh, "")
  assert.equal(first.expires, 0)
})

// ═══ ② 三种外层形状 ═══════════════════════════════════════════════════

test("T33-2) JSON 数组 3 条 → 3 个 success，且 token 各自独立", async (t) => {
  const dir = tempDir(t)
  const results = await hook(dir).import([json([row(1), row(2), row(3)])])

  assert.deepEqual(
    results.map((r) => r.type),
    ["success", "success", "success"],
  )
  assert.deepEqual(
    results.map((r) => r.access),
    ["sk-batch-1", "sk-batch-2", "sk-batch-3"],
  )
})

test("T33-3) NDJSON 3 行 → 3 个 success", async (t) => {
  const dir = tempDir(t)
  const text = [json(row(4)), "", `  ${json(row(5))}`, json(row(6))].join("\n")

  const results = await hook(dir).import([text])

  assert.deepEqual(
    results.map((r) => r.type),
    ["success", "success", "success"],
  )
  assert.deepEqual(
    results.map((r) => r.access),
    ["sk-batch-4", "sk-batch-5", "sk-batch-6"],
  )
})

test("T33-4) NDJSON 中间坏行 → 其余 success，坏行单独一条 failed", async (t) => {
  const dir = tempDir(t)
  const text = [json(row(7)), "this line is not json", json(row(8))].join("\n")

  const results = await hook(dir).import([text])

  assert.equal(results.length, 3)
  assert.deepEqual(
    results.map((r) => r.type),
    ["success", "failed", "success"],
  )
  const bad = results[1]
  assert.deepEqual(Object.keys(bad), ["type", "error"], "failed 项只带 type/error")
  assert.match(bad.error, /^文件 1 第 2 条：/)
  assert.match(bad.error, /不是合法的 JSON/)
})

// ═══ ③ 逐条校验 ═══════════════════════════════════════════════════════

test("T33-5) 缺 llmToken → failed，error 含「缺少 llmToken」", async (t) => {
  const dir = tempDir(t)
  // `access` 空串 / `llm_token` 全是空白 / 只剩 phone：都不能算有 llmToken
  const results = await hook(dir).import([
    json([
      { access: "   ", phone: "15000000000" },
      { llm_token: "", uid: "6415" },
      { platform: "quwork", token: "eyJhbGciOi.platform" },
    ]),
  ])

  assert.equal(results.length, 3)
  for (const [index, result] of results.entries()) {
    assert.equal(result.type, "failed", `第 ${index + 1} 条应当是 failed`)
    assert.match(result.error, /缺少 llmToken/)
    assert.match(result.error, new RegExp(`^文件 1 第 ${index + 1} 条：`))
  }
})

test("T33-6) 已存在的 llmToken → failed，error 含「已存在」与已有 key；同批次重复也拒", async (t) => {
  const dir = tempDir(t)
  // 宿主里已有的账号（magpie 自己写的格式：access 镜像 llmToken）
  writeFileSync(
    join(dir, "plugin-auth.json"),
    json({
      quwork: { type: "oauth", access: "sk-dup-1", llmToken: "sk-dup-1", accountId: "15000000001" },
      "quwork#1": { type: "oauth", access: "sk-dup-2", llmToken: "sk-dup-2" },
      // 别的 provider 不该影响我们的去重
      "other#1": { type: "oauth", access: "sk-dup-3", llmToken: "sk-dup-3" },
    }),
    "utf8",
  )

  const results = await hook(dir).import([
    json([row(0, { llmToken: "sk-dup-1" }), row(0, { llmToken: "sk-dup-2" }), row(0, { llmToken: "sk-dup-3" })]),
  ])

  assert.deepEqual(
    results.map((r) => r.type),
    ["failed", "failed", "success"],
    "前两个是已有账号，第三个是别的 provider 的 token（该收下）",
  )
  assert.match(results[0].error, /已存在/)
  assert.match(results[0].error, /key=quwork/)
  assert.match(results[1].error, /已存在/)
  assert.match(results[1].error, /key=quwork#1/)

  // 同批次内重复：第二条被拒，不影响第一条
  const batch = await hook(tempDir(t)).import([json([row(9), row(9)])])
  assert.deepEqual(
    batch.map((r) => r.type),
    ["success", "failed"],
  )
  assert.match(batch[1].error, /已存在/)
})

// ═══ ④ 单位、字段优先级与上限 ═════════════════════════════════════════

test("T33-7) expire 秒级 → expires = 秒 × 1000（毫秒原样保留）", async (t) => {
  const dir = tempDir(t)
  const seconds = 1797702136
  const millis = 1797702136000

  const [fromSeconds, fromMillis, noExpire] = await hook(dir).import([
    json([
      { llmToken: "sk-exp-s", token: "eyJhbGciOi.platform", expire: seconds },
      { llmToken: "sk-exp-ms", expires: millis },
      { llmToken: "sk-exp-none" },
    ]),
  ])

  assert.equal(fromSeconds.type, "success")
  assert.equal(fromSeconds.expires, seconds * 1000)
  assert.equal(fromSeconds.refresh, "eyJhbGciOi.platform", "平台 token 落到 refresh")
  assert.equal(fromMillis.expires, millis)
  assert.equal(noExpire.expires, 0, "没有过期时间 = 0（不会过期、不要续期）")
})

test("T33-8) 超过 100 条 → 100 条成功 + 1 条 failed 说明剩余未处理", async (t) => {
  const dir = tempDir(t)
  const total = IMPORT_MOST + 5
  const rows = Array.from({ length: total }, (_, i) => row(1000 + i))

  const results = await hook(dir).import([json(rows)])

  assert.equal(IMPORT_MOST, 100)
  assert.equal(results.length, IMPORT_MOST + 1, "100 条结果 + 1 条截断说明")
  assert.equal(results.slice(0, IMPORT_MOST).every((r) => r.type === "success"), true)
  assert.equal(results.filter((r) => r.type === "success").length, IMPORT_MOST)

  const notice = results.at(-1)
  assert.equal(notice.type, "failed")
  assert.match(notice.error, /还有 5 条/)
  assert.match(notice.error, /100 条上限/)
})
