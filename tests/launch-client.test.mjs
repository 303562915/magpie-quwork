// launch-client.test.mjs 「打开登录入口」优先启动 QuWork **客户端**（网页只是退路）。
//
// # 为什么（真机复核）
//
// `llm_token` 只有 QuWork 桌面客户端会写进 sqlite / `.credentials.yaml`。
// 用系统浏览器打开网页不会写这两处 ⇒ 轮询永远抓不到。

import { test } from "node:test"
import assert from "node:assert/strict"

import { makeLaunchLoginSource, clientCandidates, WEB_LOGIN_URL } from "../src/launch-client.mjs"

const FAKE_EXE = "C:\\fake\\QuWork.exe"

test("命中 exe 路径（注入 exists）→ {kind:\"client\"}，spawn 一次且参数是该 exe", async () => {
  /** @type {Array<{cmd: string, argv: any[]}>} */
  const spawned = []
  const launch = makeLaunchLoginSource({
    clientPath: FAKE_EXE,
    exists: (p) => p === FAKE_EXE,
    readRegistry: () => "",
    spawnImpl: (cmd, argv) => {
      spawned.push({ cmd, argv })
      return { unref() {}, on() {} }
    },
    log: { warn() {} },
  })

  const how = await launch()

  assert.equal(how.kind, "client")
  assert.equal(how.target, FAKE_EXE)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].cmd, FAKE_EXE)
  assert.deepEqual(spawned[0].argv, [])
})

test("找不到 exe → {kind:\"browser\"}，target 是网页登录页", async () => {
  /** @type {string[]} */
  const opened = []
  const launch = makeLaunchLoginSource({
    exists: () => false,
    readRegistry: () => "",
    openExternal: async (u) => opened.push(String(u)),
    log: { warn() {} },
  })

  const how = await launch()

  assert.equal(how.kind, "browser")
  assert.equal(how.target, WEB_LOGIN_URL)
  assert.equal(opened[0], WEB_LOGIN_URL)
})

test("clientCandidates：显式路径优先，且包含本机已知位置", () => {
  const list = clientCandidates({ clientPath: "X:\\custom.exe", env: { LOCALAPPDATA: "C:\\LAD", PROGRAMFILES: "C:\\PF" } })
  assert.equal(list[0], "X:\\custom.exe")
  assert.ok(list.some((p) => p.includes("QuWork-1.7.5-win-x64")), "已知安装位置要留一条")
})

test("启动失败（spawn 抛错）→ 仍返回可用结果（browser 退路），只 warn", async () => {
  /** @type {string[]} */
  const warns = []
  const launch = makeLaunchLoginSource({
    clientPath: FAKE_EXE,
    exists: () => true,
    readRegistry: () => "",
    spawnImpl: () => {
      throw new Error("spawn denied")
    },
    openExternal: async () => {},
    log: { warn: (m) => warns.push(String(m)) },
  })

  const how = await launch()
  assert.equal(how.kind, "browser")
  assert.ok(warns.length > 0)
})