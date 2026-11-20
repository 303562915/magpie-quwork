// auth-store.test.mjs 多账号键规则与幂等去重。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { authPath, listAccounts, readAll, upsertAccount, updatePlatformToken, nextKey } from "../src/auth-store.mjs"

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "quwork-auth-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("第一个账号用 `quwork`，之后是 `quwork#1`、`quwork#2`…", (t) => {
  const dir = tempDir(t)
  assert.equal(upsertAccount(dir, { llmToken: "a" }).key, "quwork")
  assert.equal(upsertAccount(dir, { llmToken: "b" }).key, "quwork#1")
  assert.equal(upsertAccount(dir, { llmToken: "c" }).key, "quwork#2")

  assert.deepEqual(listAccounts(dir).map((a) => a.key).sort(), ["quwork", "quwork#1", "quwork#2"])
})

test("重复导入同一个 llmToken 不产生重复条目（幂等）", (t) => {
  const dir = tempDir(t)
  const first = upsertAccount(dir, { llmToken: "same", token: "t1" })
  const second = upsertAccount(dir, { llmToken: "same", token: "t2" })

  assert.equal(first.key, second.key)
  assert.equal(second.created, false)
  assert.equal(listAccounts(dir).length, 1)
  assert.equal(readAll(dir)[first.key].token, "t2", "重复导入应更新，而不是新增")
})

test("同 uid 视为同一账号（即使 llmToken 换了 —— 重新登录会换 token）", (t) => {
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: "old", uid: "u-1" })
  const again = upsertAccount(dir, { llmToken: "new", uid: "u-1" })

  assert.equal(again.key, "quwork")
  assert.equal(listAccounts(dir).length, 1)
  assert.equal(readAll(dir)["quwork"].llmToken, "new")
})

test("access 恒等于 llmToken（magpie 只读 access）", (t) => {
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: "tok" })
  const entry = readAll(dir)["quwork"]
  assert.equal(entry.access, "tok")
  assert.equal(entry.llmToken, "tok")
  assert.equal(entry.type, "oauth")
})

test("updatePlatformToken 只改 token/expire，别的一律保留", (t) => {
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: "llm", token: "old", expire: 1, uid: "u-9", phone: "138****0000" })

  const r = updatePlatformToken(dir, "llm", { token: "new", expire: 99 })
  assert.equal(r.ok, true)

  const entry = readAll(dir)["quwork"]
  assert.equal(entry.token, "new")
  assert.equal(entry.expire, 99)
  assert.equal(entry.llmToken, "llm")
  assert.equal(entry.access, "llm")
  assert.equal(entry.uid, "u-9")
  assert.equal(entry.phone, "138****0000")
})

test("找不到 llmToken 时 updatePlatformToken 不创建新条目", (t) => {
  const dir = tempDir(t)
  const r = updatePlatformToken(dir, "missing", { token: "x" })
  assert.equal(r.ok, false)
  assert.equal(listAccounts(dir).length, 0)
})

test("写盘是合法 JSON 且在 `<configDir>/plugin-auth.json`", (t) => {
  const dir = tempDir(t)
  upsertAccount(dir, { llmToken: "a" })
  const raw = JSON.parse(readFileSync(authPath(dir), "utf8"))
  assert.equal(raw["quwork"].llmToken, "a")
  assert.equal(authPath(dir), join(dir, "plugin-auth.json"))
})

test("nextKey 跳过已被其它供应商占用的键？——不跳过，只认自己的前缀", () => {
  // magpie 的键是 `<provider>#<n>`，别的供应商的键不会撞。
  assert.equal(nextKey({ loomy: {} }), "quwork")
  assert.equal(nextKey({ quwork: {}, "quwork#1": {} }), "quwork#2")
})
