// paste-import.test.mjs 「登录弹窗里的导入按钮」：从粘贴的文本导入 QuWork 账号。
//
// 断言全部来自宿主源码（host-acc034d984c6.js）：
//   2822  oauth 方法的 authorize 必须返回带 callback 的对象
//   2853  callback() → keptAs → save 落盘
//   1346-1370  client.auth.set 是插件写账号的正规通道（写完发 {event:"auth"}）
//   2758-2763  save() 写的 body 是 {type:"oauth", refresh, access, expires, ...extra}

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { QuWorkAuthPlugin } from "../index.mjs"
import { makePasteImportMethod, PASTE_LABEL, authBodyOf, nextAccountKey } from "../src/paste-import.mjs"

function tempDir() {
  return mkdtempSync(join(tmpdir(), "quwork-paste-"))
}

function fakeClient() {
  /** @type {Array<{key: string, body: any}>} */
  const writes = []
  /** @type {any[]} */
  const toasts = []
  const client = {
    auth: {
      set: async ({ path, body }) => {
        writes.push({ key: path.id, body })
      },
    },
    tui: { showToast: (o) => toasts.push(o) },
  }
  return { writes, toasts, client }
}

const quiet = { warn() {} }

test("登录弹窗里多了一项：从文件导入（粘贴 JSON / NDJSON）", async () => {
  const p = await QuWorkAuthPlugin({}, {})
  const method = p.auth.methods.find((m) => String(m.label).includes("从文件导入"))
  assert.ok(method, "auth.methods 里必须有「从文件导入」")
  assert.equal(method.label, PASTE_LABEL)
  assert.equal(method.type, "oauth", "必须是 oauth（api 凭证不触发额度/签到钩子）")
  assert.equal(method.labels.en, "import from text (JSON / NDJSON)")
  assert.equal(method.prompts[0].type, "text")
  assert.equal(method.prompts[0].key, "text")
  assert.equal(typeof method.authorize, "function")
})

test("粘贴单个账号 JSON：callback 返回 success，写盘 body 与宿主 save() 同构", async () => {
  const dir = tempDir()
  const { writes, client } = fakeClient()
  const method = makePasteImportMethod({ configDir: dir, client, log: quiet })

  const started = await method.authorize({
    text: JSON.stringify({ llmToken: "sk-aaa", token: "pt-1", phone: "13800000000", uid: "u1" }),
  })
  assert.equal(typeof started.callback, "function", "oauth 方法必须给 callback")
  assert.equal(started.opened, true)

  const r = await started.callback()
  assert.equal(r.type, "success")
  assert.equal(r.access, "sk-aaa", "access 必须是 llmToken（loader 拿它调模型）")
  assert.equal(r.refresh, "pt-1", "平台 token 放 refresh")
  assert.ok(r.accountId, "accountId 绝不能为空")

  assert.equal(writes.length, 1)
  assert.match(writes[0].key, /^quwork#\d+$/)
  assert.deepEqual(writes[0].body, authBodyOf(r))
  assert.equal(writes[0].body.type, "oauth")
})

test("粘贴 NDJSON 两行：两条都导入（第 1 条给宿主，第 2 条自己写）", async () => {
  const dir = tempDir()
  const { writes, client } = fakeClient()
  const method = makePasteImportMethod({ configDir: dir, client, log: quiet })

  const text = [JSON.stringify({ llmToken: "sk-b" }), JSON.stringify({ llmToken: "sk-c" })].join("\n")
  const started = await method.authorize({ text })
  const r = await started.callback()

  assert.equal(r.type, "success")
  assert.equal(r.access, "sk-b")
  assert.deepEqual(writes.map((w) => w.body.access), ["sk-b", "sk-c"])
  assert.notEqual(writes[0].key, writes[1].key, "两个号不能抢同一个账号键")
})

test("坏行只失败那一行：好行照样导入，提示里带「第 2 条」", async () => {
  const dir = tempDir()
  const { writes, toasts, client } = fakeClient()
  const method = makePasteImportMethod({ configDir: dir, client, log: quiet })

  const text = `${JSON.stringify({ llmToken: "sk-d" })}\n{ 这一行不是 JSON`
  const started = await method.authorize({ text })
  const r = await started.callback()

  assert.equal(r.type, "success")
  assert.equal(writes.length, 1)
  assert.match(toasts.at(-1)?.message ?? "", /第 2 条/)
})

test("已经在 magpie 里的 llmToken 不重复导入", async () => {
  const dir = tempDir()
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({ quwork: { type: "oauth", access: "sk-e", llmToken: "sk-e" } }))
  const { writes, client } = fakeClient()
  const method = makePasteImportMethod({ configDir: dir, client, log: quiet })

  const started = await method.authorize({ text: JSON.stringify({ llmToken: "sk-e" }) })
  const r = await started.callback()

  assert.equal(r.type, "failed")
  assert.match(r.error, /已存在/)
  assert.equal(writes.length, 0)
})

test("单次上限 100 条：超出的明说，不静默丢", async () => {
  const dir = tempDir()
  const { writes, toasts, client } = fakeClient()
  const method = makePasteImportMethod({ configDir: dir, client, log: quiet })

  const items = Array.from({ length: 101 }, (_, i) => ({ llmToken: `sk-${i}` }))
  const started = await method.authorize({ text: JSON.stringify(items) })
  const r = await started.callback()

  assert.equal(r.type, "success")
  assert.equal(writes.length, 100)
  assert.match(toasts.at(-1)?.message ?? "", /超出单次 100 条上限/)
})

test("空输入 / 认不出的内容返回 failed 而不是抛异常", async () => {
  const dir = tempDir()
  const { client } = fakeClient()
  const method = makePasteImportMethod({ configDir: dir, client, log: quiet })

  const empty = await method.authorize({ text: "" })
  assert.equal(empty.type, "failed")

  const started = await method.authorize({ text: "hello world" })
  const r = await started.callback()
  assert.equal(r.type, "failed")
  assert.ok(r.error)
})

test("nextAccountKey 从 quwork#1 起，跳过已占用的键", () => {
  const taken = new Set(["quwork", "quwork#1"])
  const key = nextAccountKey("quwork", taken)
  assert.equal(key, "quwork#2")
  assert.equal(taken.has(key), true)
})
