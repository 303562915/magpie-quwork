// src/bind-pages.mjs 微信绑定门户的 HTML（纯函数：给数据、出字符串，方便测试）。
//
// # 三条硬规则
//
//	① 页面上**绝不出现**手机号、平台 token、账号 key —— 打开页面的是陌生人；
//	② 手机优先（扫码进来的一定是微信内置浏览器），二维码要大、要能对着屏幕直接扫；
//
// ⚠ 页面里**不能**教用户「长按识别 / 相册识别」：那条路会让微信在自己的内置浏览器里
//   去开 `open.weixin.qq.com/connect/qrconnect`，实测无效。必须让**另一台设备**用微信
//   「扫一扫」直接扫屏幕上这张码。文案见 `goPage()` 的红色提示。
//	③ 任何分支都给一页能看懂的 HTML，不要 500 白屏（扫码的人不知道你在修东西）。

/** HTML 转义（页面里所有外部字符串都必须过一遍）。 */
export function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * 门户的路径前缀（magpie 可能以带前缀的代理路径打开面板，例如
 * `/_magpie/plugin/<hash>/_magpie/service`）。空字符串 = 直接挂在根上。
 *
 * ⚠ 页面里的链接与轮询**一律用绝对路径**（`<mount>/bind/go`），不要写相对路径：
 * `/bind` 这一页的基准目录是 `/`，`href="go"` 会被解析成 `/go` —— 直接掉回面板 HTML，
 * 而 `/bind/go/`（带尾斜杠）下 `api/check` 又会变成 `/bind/go/api/check`。
 *
 * @param {string} mount
 * @param {string} sub 形如 `/bind/go`
 * @returns {string}
 */
function pathOf(mount, sub) {
  const m = String(mount ?? "").replace(/\/+$/, "")
  return `${m}${sub}`
}

/**
 * 门户页面里通用的「轮询 + 自动续码」脚本。
 *
 * # 为什么抽出来
 *
 * 出码页（`/bind/go`）和阵列页（`/bind/wall`）面对的是同一件事：
 * 一张码 3 分钟就会作废，但**会话可以续**。两边必须用同一套：
 * 拿 `{status, qr, qrUrl, ttlMs, renewed}` 解释成「换图 / 收工 / 放弃」。
 *
 * @returns {string} 内联脚本（已被 layout 放进 `<script>`）
 */
function pollScript() {
  return `
/**
 * 轮询一个会话，直到 bound / expired / 超时。
 *   onBound(label)   绑定成功
 *   onRenew(info)    服务端给了新码（info.qr / info.qrUrl / info.ttlMs）
 *   onGone(message)  这个会话没救了
 */
window.__bindPoll = function (opts) {
  var sid = opts.session;
  var checkUrl = opts.checkUrl;
  var interval = opts.interval || 3000;
  var hardStop = Date.now() + (opts.maxWait || 1800000);
  var onBound = opts.onBound || function () {};
  var onRenew = opts.onRenew || function () {};
  var onGone = opts.onGone || function () {};
  var lastRenew = 0;
  var timer = setInterval(function () {
    if (Date.now() > hardStop) { clearInterval(timer); onGone("等待超时"); return; }
    fetch(checkUrl + "?session=" + encodeURIComponent(sid), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.status === "bound") { clearInterval(timer); onBound(j.label || ""); return; }
        if (j.status === "expired") { clearInterval(timer); onGone(j.message || "已失效"); return; }
        // ⚠ 服务端每次轮询都可能发现「已过期」并续一张新码；只在 renewed 时换图，
        //   否则会把同一张图每 3 秒重设一遍（浏览器 flash + 浪费时间）
        if (j.qr && j.renewed && j.qr !== lastRenew) { lastRenew = j.qr; onRenew(j); }
      })
      .catch(function () {});
  }, interval);
  return function stop() { clearInterval(timer); };
};
`
}

/** 所有门户页面共用的样式（内联，不依赖外部资源）。 */
const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 28px 18px 48px; min-height: 100vh;
  font: 16px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  background: #f6f7f9; color: #16181d;
  display: flex; flex-direction: column; align-items: center; gap: 18px;
}
.card {
  width: 100%; max-width: 420px; background: #fff; border-radius: 18px;
  padding: 24px 20px; box-shadow: 0 10px 30px rgba(16, 24, 40, .08);
}
h1 { font-size: 20px; margin: 0 0 6px; }
p { margin: 8px 0; color: #4b5563; font-size: 14px; }
.qr { display: block; width: 100%; max-width: 320px; margin: 14px auto; image-rendering: pixelated; border-radius: 8px; }
.badge {
  display: inline-block; padding: 3px 10px; border-radius: 999px;
  background: #eef2ff; color: #4338ca; font-size: 12px; font-weight: 600;
}
.big { font-size: 17px; color: #111827; font-weight: 600; }
.alert {
  margin: 14px 0; padding: 12px 14px; border-radius: 12px;
  background: #fff1f2; border: 1px solid #fecdd3; color: #9f1239;
  font-size: 15px; font-weight: 700; line-height: 1.5; text-align: center;
}
.alert small { display: block; margin-top: 6px; font-size: 13px; font-weight: 500; color: #b91c1c; }
.btn {
  display: block; width: 100%; margin-top: 14px; padding: 13px 16px;
  border-radius: 12px; border: 0; background: #07c160; color: #fff;
  font-size: 16px; font-weight: 600; text-align: center; text-decoration: none;
}
.btn.secondary { background: #eef1f5; color: #111827; }
.hint { font-size: 13px; color: #6b7280; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
.state { display: none; }
.state.on { display: block; }
.ok { color: #07c160; font-weight: 700; }
.warn { color: #b45309; }
.timer { font-variant-numeric: tabular-nums; }
footer { color: #9ca3af; font-size: 12px; }

/* ── 阵列页（/bind/wall）：一屏多个待绑定账号 ── */
.card.wide { max-width: 980px; }
.grid {
  display: grid; gap: 12px; margin: 14px 0;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
}
.cell {
  border: 1px solid #e5e7eb; border-radius: 14px; padding: 10px;
  display: flex; flex-direction: column; gap: 8px; align-items: center;
  transition: opacity .2s, border-color .2s;
}
.cell-head { display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 6px; }
.cell-head .timer { font-size: 13px; color: #6b7280; }
.qr-sm { width: 100%; max-width: 130px; height: auto; image-rendering: pixelated; border-radius: 6px; }
.cell-note { margin: 0; font-size: 12px; color: #4b5563; text-align: center; }
.cell-link {
  display: block; width: 100%; text-align: center; font-size: 12px; padding: 5px 6px;
  border-radius: 8px; background: #eef1f5; color: #111827; text-decoration: none;
}
.cell.is-done { border-color: #07c160; background: #f0fdf4; }
.cell.is-done .cell-note { color: #07c160; font-weight: 800; font-size: 15px; }
.done-banner {
  display: none; margin: 6px 0 14px; padding: 14px 16px; border-radius: 14px;
  background: #07c160; color: #fff; text-align: center; font-size: 18px; font-weight: 800;
}
.done-banner.on { display: block; }
.cell.is-gone { opacity: .45; }
@media (prefers-color-scheme: dark) {
  .cell { border-color: #2a303c; }
  .cell-note { color: #9ca3af; }
  .cell.is-done { background: #0f2419; }
}
@media (prefers-color-scheme: dark) {
  body { background: #0f1115; color: #e5e7eb; }
  .card { background: #171a21; box-shadow: none; }
  p { color: #9ca3af; }
  .big { color: #f9fafb; }
  .btn.secondary { background: #232833; color: #e5e7eb; }
  .badge { background: #1e2433; color: #a5b4fc; }
}
`

/**
 * 页面骨架。
 *
 * @param {{title: string, body: string, script?: string}} opts
 * @returns {string}
 */
function layout(opts) {
  const script = opts.script ? `<script>${opts.script}</script>` : ""
  // 非微信内置浏览器访问时，顶部直接挂一条提示：这类访问扫码链路走不通
  const notWeChat = opts.notWeChat
    ? `<div class="alert" style="max-width:980px;margin:0 auto 14px">你现在<b>不是从微信里</b>打开本页<small>微信「扫一扫」扫码才会跳「确认登录」；直接点链接/用浏览器打开，绑不成</small></div>`
    : ""
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(opts.title)}</title>
<style>${CSS}</style>
</head>
<body>
${notWeChat}
${opts.body}
<footer>微信扫码绑定</footer>
${script}
</body>
</html>`
}

/**
 * 落地页：固定二维码指向的就是它（`/bind/go` 会自动分配，这里给个说明 + 按钮）。
 *
 * @param {{total?: number, available?: number, bound?: number, mount?: string}} opts
 * @returns {string}
 */
export function landingPage(opts = {}) {
  const total = Number(opts.total) || 0
  const available = Number(opts.available) || 0
  const bound = Number(opts.bound) || 0
  const go = pathOf(opts.mount, "/bind/go")
  const wall = pathOf(opts.mount, "/bind/wall")

  const body = `
<div class="card">
  <span class="badge">微信绑定</span>
  <h1>帮我们绑一个账号</h1>
  <p>点下面的按钮，页面会分给你一个<strong>还没绑定微信</strong>的账号，再用微信扫它给的码、点「确认登录」就完成了。</p>
  <div class="alert">必须用微信「扫一扫」直接扫码<small>相册选图 / 长按识别 打开的一律无效</small></div>
  <p class="hint">每个账号只会分给一个人；分到之后 10 分钟内有效，过期会自动换新码；没人扫的账号会自动回到池子里。</p>
  <a class="btn" href="${esc(go)}">开始绑定</a>
  <a class="btn secondary" href="${esc(wall)}">看全部待绑定账号（群里发这个也行）</a>
  <p class="hint">当前可分配 <strong>${available}</strong> 个 · 已绑定 <strong>${bound}</strong> / 共 ${total} 个</p>
</div>`
  return layout({ title: "微信绑定", body, notWeChat: opts.notWeChat })
}

/**
 * 阵列页：一屏排开若干「待绑定账号 #X」卡片，每张卡片一个专属码 + 倒计时。
 *
 * # 给谁用
 *
 * 发到群里：谁想帮就扫其中**任意一张**；扫了哪张，那个号就归他，其它卡片照常在。
 * 每张卡片独立续码（3 分钟过期 → 服务端换新码 → 卡片原地换图），互不影响。
 *
 * @param {{mount?: string, cards?: Array<{sessionId: string, label: string, qrDataUri: string,
 *   ttlMs: number}>, maxWaitMs?: number, pollMs?: number, remainNote?: string}} opts
 * @returns {string}
 */
export function wallPage(opts = {}) {
  const mount = String(opts.mount ?? "")
  const checkUrl = pathOf(mount, "/bind/api/check")
  const go = pathOf(mount, "/bind/go")
  const wall = pathOf(mount, "/bind/wall")
  const pollMs = Math.max(1000, Number(opts.pollMs) || 3000)
  const maxWaitMs = Math.max(180_000, Number(opts.maxWaitMs) || 30 * 60 * 1000)
  const cards = Array.isArray(opts.cards) ? opts.cards : []

  if (cards.length === 0) {
    const body = `
<div class="card">
  <span class="badge">暂时没有空位</span>
  <h1>现在没有可绑定的账号</h1>
  <p>所有账号要么已经绑好了，要么正被其他人扫着（占位 5 分钟）。请过几分钟刷新本页。</p>
  <a class="btn" href="${esc(wall)}">刷新</a>
  <p class="hint">如果你就是管理员、想立刻把被占住的号放回来：在面板「扫码绑定 → 释放所有占位」点一下，或在本机执行 <code>POST ${esc(pathOf(mount, "/bind/api/release"))}</code>。</p>
</div>`
    return layout({ title: "暂时没有空位", body })
  }

  const grid = cards
    .map(
      (c, i) => `<div class="cell" id="cell-${i}">
        <div class="cell-head"><span class="badge">待绑定 ${esc(c.label)}</span><span class="timer" id="left-${i}">--:--</span></div>
        <img class="qr-sm" id="qr-${i}" src="${esc(c.qrDataUri)}" alt="微信扫码绑定 ${esc(c.label)}">
        ${c.url ? `<a class="cell-link" href="${esc(c.url)}" target="_blank" rel="noreferrer">打开链接</a>` : ""}
        <p class="cell-note" id="note-${i}">用微信扫一扫${c.url ? "（或点上面的链接）" : ""}</p>
      </div>`,
    )
    .join("")

  const meta = JSON.stringify(
    cards.map((c, i) => ({ i, session: String(c.sessionId ?? ""), ttl: Math.max(0, Number(c.ttlMs) || 0) })),
  ).replace(/</g, "\\u003c")

  const body = `
<div class="card wide">
  <span class="badge">共 ${cards.length} 个待绑定账号</span>
  <h1>随便挑一个扫，帮我们绑一个号</h1>
  <div class="alert">必须用微信「扫一扫」直接扫下面任意一张<small>相册选图 / 长按识别 无效；扫完在微信里点「确认登录」</small></div>
  <p class="hint">每张码有效期 10 分钟，过期会自己换新码；扫成功的那一格会变「已绑定」，别的格子照常可用。</p>
  <div class="done-banner" id="done-banner">已绑定 ✓</div>
  <div class="grid">${grid}</div>
  <p class="hint"><a href="${esc(wall)}">刷新本页</a> · <a href="${esc(go)}">只给我一个号</a></p>
  ${opts.remainNote ? `<p class="hint">${esc(opts.remainNote)}</p>` : ""}
</div>`

  const script = `
(function () {
  var cards = ${meta};
  var checkUrl = ${JSON.stringify(checkUrl).replace(/</g, "\\u003c")};
  var reassignUrl = ${JSON.stringify(pathOf(mount, "/bind/api/reassign")).replace(/</g, "\\u003c")};
  var interval = ${pollMs};
  var maxWait = ${maxWaitMs};
  var deadline = [];
  function tick() {
    for (var k = 0; k < cards.length; k += 1) {
      var el = document.getElementById("left-" + k);
      if (!el || !deadline[k]) continue;
      var s = Math.max(0, Math.round((deadline[k] - Date.now()) / 1000));
      el.textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    }
  }
  /** 这一格的号被收回（5 分钟没人扫）→ 立刻要一个新号，页面不用刷新。 */
  function reassign(k) {
    fetch(reassignUrl + "?n=1", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var card = j && j.cards && j.cards[0];
        if (!card) {
          var note = document.getElementById("note-" + k);
          if (note) note.textContent = "池子里暂时没有空号，等会儿刷新本页";
          return;
        }
        cards[k] = { i: k, session: card.sessionId, ttl: card.ttlMs };
        var img = document.getElementById("qr-" + k);
        if (img) { img.src = card.qrDataUri; img.style.opacity = "1"; }
        var head = document.querySelector("#cell-" + k + " .badge");
        if (head) head.textContent = "待绑定 " + card.label;
        var cell = document.getElementById("cell-" + k);
        if (cell) cell.classList.remove("is-gone", "is-done");
        var note = document.getElementById("note-" + k);
        if (note) note.textContent = "换了个新号，用微信扫这张";
        deadline[k] = Date.now() + card.ttl;
        watch(k, card.sessionId);
      })
      .catch(function () {});
  }

  /** 绑定成功的「看得见 + 听得见」反馈：阵列页 6 格时很容易看漏哪一格成了。 */
  function celebrate(label) {
    var banner = document.getElementById("done-banner");
    if (banner) {
      banner.textContent = "已绑定 ✓ " + (label ? label + " 绑定成功" : "谢谢！");
      banner.className = "done-banner on";
      setTimeout(function () { banner.className = "done-banner"; }, 8000);
    }
    document.title = "✓ 已绑定 " + (label || "");
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880; gain.gain.value = 0.08;
      osc.start(); osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.12);
      osc.stop(ctx.currentTime + 0.3);
    } catch (e) {}
    if (navigator.vibrate) { try { navigator.vibrate([80, 60, 120]); } catch (e) {} }
  }

  /** 每格独立轮询：状态可能是 bound / 换新码(renewed) / 失效（号已收回）。 */
  function watch(k, session) {
    var started = Date.now();
    var lastQr = "";
    var timer = setInterval(function () {
      if (Date.now() - started > maxWait) { clearInterval(timer); return; }
      fetch(checkUrl + "?session=" + encodeURIComponent(session), { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var note = document.getElementById("note-" + k);
          var img = document.getElementById("qr-" + k);
          var cell = document.getElementById("cell-" + k);
          if (j.status === "bound") {
            clearInterval(timer);
            if (cell) cell.classList.add("is-done");
            if (note) note.innerHTML = '<span class="ok">已绑定 ✓</span>';
            if (img) img.style.opacity = ".15";
            deadline[k] = 0;
            celebrate(j.label || "");
            return;
          }
          if (j.status === "expired") {
            clearInterval(timer);
            if (note) note.textContent = "这个号 10 分钟没人扫，已作废，正在换新号…";
            reassign(k);
            return;
          }
          if (j.remainingMs === 0 && !j.qr && note) {
            note.textContent = "正在换新码…";
          }
          if (j.qr && j.renewed && j.qr !== lastQr) {
            lastQr = j.qr;
            if (img) img.src = j.qr;
            deadline[k] = Date.now() + (j.ttlMs || 0);
            if (note) note.textContent = "换新码了，重新扫这张";
          }
        })
        .catch(function () {});
    }, interval);
  }
  cards.forEach(function (c, k) {
    deadline[k] = Date.now() + c.ttl;
    if (c.session) watch(k, c.session);
  });
  tick();
  setInterval(tick, 1000);
})();
`
  return layout({ title: "待绑定账号", body, script, notWeChat: opts.notWeChat })
}

/**
 * 出码页：这个账号专属的授权二维码 + 轮询。
 *
 * @param {{sessionId: string, label: string, qrDataUri: string, authorizeUrl: string,
 *   ttlMs: number, mount?: string, maxWaitMs?: number, pollMs?: number}} opts
 *   `maxWaitMs`：页面**最长等多久**（默认 5 分钟）。它可以比占位 TTL 长 —— 占位到期后
 *   服务端会重新给「同一个号」出一次码，我们只续期，不需要用户重新扫固定码。
 *   `pollMs`：轮询间隔（默认 3 秒；测试会调小）。
 * @returns {string}
 */
export function goPage(opts) {
  const go = pathOf(opts.mount, "/bind/go")
  const checkUrl = pathOf(opts.mount, "/bind/api/check")
  const pollMs = Math.max(1000, Number(opts.pollMs) || 3000)
  const maxWaitMs = Math.max(90_000, Number(opts.maxWaitMs) || 5 * 60 * 1000)
  const body = `
<div class="card">
  <span class="badge">待绑定账号 ${esc(opts.label)}</span>
  <h1>用微信扫这个码</h1>
  <img class="qr" id="qr" src="${esc(opts.qrDataUri)}" alt="微信扫码绑定">
  <div class="alert">
    必须用<b>另一台手机</b>的微信「<b>扫一扫</b>」<br>直接扫上面这张二维码
    <small>从相册选图 / 长按识别 打开的<strong>无效</strong>，扫了也不会跳「确认登录」</small>
  </div>
  <p class="big">扫完在微信里点「<span class="ok">确认登录</span>」</p>
  <p class="hint">如果身边只有这一台手机：用<strong>电脑</strong>打开 <code>${esc(go)}</code>，再用手机微信扫电脑屏幕上的那张码。</p>
  <p class="hint">剩余时间 <span class="timer" id="left">--:--</span>；<strong>过期会自动换一张新码</strong>，本页不用关。</p>
  <p class="hint" id="poll">正在等待确认…</p>
  <a class="btn" id="done" style="display:none" href="${esc(go)}">再帮我们绑一个</a>
  <div id="live" style="display:none;margin-top:14px">
    <p class="big" id="live-title">这张码换了新的一张，请再扫一次</p>
    <img class="qr" id="live-qr" alt="新的微信扫码绑定二维码">
    <p class="hint"><a id="live-link" href="#" target="_blank" rel="noreferrer">在微信里点这里打开新授权页</a></p>
  </div>
  <p class="hint" id="again" style="display:none">这次的码太久没人扫，已失效。<a href="${esc(go)}">点这里重新开始</a></p>
</div>`
  // ⚠ sessionId 拼进内联脚本时必须把 `<` 转义掉（今天它只可能是 hex，但别赌来源）
  const sidJs = JSON.stringify(String(opts?.sessionId ?? "")).replace(/</g, "\\u003c")
  const script = `
(function () {
  var sid = ${sidJs};
  var checkUrl = ${JSON.stringify(checkUrl).replace(/</g, "\\u003c")};
  var maxWait = ${maxWaitMs};
  var interval = ${pollMs};
  var deadline = Date.now() + (Number(${JSON.stringify(Number(opts.ttlMs) || 0)}) || 0);
  var hardStop = Date.now() + maxWait;
  var left = document.getElementById("left");
  var poll = document.getElementById("poll");
  var qr = document.getElementById("qr");
  function setTtl(ms) { if (ms > 0) deadline = Date.now() + ms; }
  function tick() {
    var s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    left.textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }
  tick();
  var timer = setInterval(tick, 1000);
  /**
   * 轮询。服务端可能回这几种：
   *   bound        → 绑定成功，收工
   *   pending      → 继续等；若带了新的 \`qr\`（码过期后服务端重新签发）就原地换图 + 重新计时
   *   expired      → 占位太久没人扫，整个流程作废，给「重新开始」
   */
  var loop = setInterval(function () {
    if (Date.now() > hardStop) {
      clearInterval(loop); clearInterval(timer);
      poll.textContent = "等待超时";
      document.getElementById("again").style.display = "block";
      return;
    }
    fetch(checkUrl + "?session=" + encodeURIComponent(sid), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.status === "bound") {
          clearInterval(loop); clearInterval(timer);
          poll.innerHTML = '<span class="ok">绑定成功 ✓ 谢谢！</span>';
          qr.style.display = "none";
          document.getElementById("done").style.display = "block";
          document.title = "✓ 绑定成功";
          try {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            var osc = ctx.createOscillator(), gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.frequency.value = 880; gain.gain.value = 0.08;
            osc.start(); osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.12);
            osc.stop(ctx.currentTime + 0.3);
          } catch (e) {}
          if (navigator.vibrate) { try { navigator.vibrate([80, 60, 120]); } catch (e) {} }
          document.getElementById("live").style.display = "none";
        } else if (j.status === "expired") {
          clearInterval(loop); clearInterval(timer);
          poll.textContent = "这次的码已经失效";
          qr.style.opacity = ".25";
          document.getElementById("live").style.display = "none";
          document.getElementById("again").style.display = "block";
        } else {
          if (j.qr) {
            // 旧码已经作废：把新码放大显示（同一台手机也能看到，长按无效，需要用另一台设备扫）
            document.getElementById("live-qr").src = j.qr;
            if (j.qrUrl) document.getElementById("live-link").href = j.qrUrl;
            document.getElementById("live").style.display = "block";
            document.getElementById("live-title").textContent =
              "号已确认是你的，这张新码有效 " + Math.round((j.ttlMs || 0) / 1000) + " 秒";
            setTtl(j.ttlMs || 0);
            poll.textContent = "已自动换新码，请用微信扫上面这张新的";
          } else if (j.message) {
            poll.textContent = "等待中…（" + j.message + "）";
          }
        }
      })
      .catch(function () {});
  }, interval);
})();
`
  return layout({ title: `绑定账号 ${opts.label ?? ""}`, body, script, notWeChat: opts.notWeChat })
}

/**
 * 池子里没有可分配账号。
 *
 * @param {{mount?: string}} [opts]
 * @returns {string}
 */
export function noAccountPage(opts = {}) {
  const go = pathOf(opts.mount, "/bind/go")
  const body = `
<div class="card">
  <span class="badge">暂时没有空位</span>
  <h1>现在没有可绑定的账号</h1>
  <p>所有账号要么已经绑好了，要么正被其他人扫着。请过几分钟再扫一次这个二维码。</p>
  <a class="btn" href="${esc(go)}">再试一次</a>
</div>`
  return layout({ title: "暂时没有空位", body })
}

/**
 * 出错页（上游取不到授权码等）。
 *
 * @param {string} message
 * @param {{mount?: string}} [opts]
 * @returns {string}
 */
export function errorPage(message, opts = {}) {
  const go = pathOf(opts.mount, "/bind/go")
  const body = `
<div class="card">
  <span class="badge">稍后再试</span>
  <h1>这次没拿到二维码</h1>
  <p class="warn">${esc(message || "平台暂时没有响应")}</p>
  <p class="hint">这不是你的问题，过一会儿再扫一次这个二维码就行。</p>
  <a class="btn" href="${esc(go)}">重试</a>
</div>`
  return layout({ title: "稍后再试", body })
}
