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

  const body = `
<div class="card">
  <span class="badge">微信绑定</span>
  <h1>帮我们绑一个账号</h1>
  <p>点下面的按钮，页面会分给你一个<strong>还没绑定微信</strong>的账号，再用微信扫它给的码、点「确认登录」就完成了。</p>
  <div class="alert">必须用微信「扫一扫」直接扫码<small>相册选图 / 长按识别 打开的一律无效</small></div>
  <p class="hint">每个账号只会分给一个人；分到之后 1 分半内有效，超时要重新扫；被占用的账号会自动回到池子里。</p>
  <a class="btn" href="${esc(go)}">开始绑定</a>
  <p class="hint">当前可分配 <strong>${available}</strong> 个 · 已绑定 <strong>${bound}</strong> / 共 ${total} 个</p>
</div>`
  return layout({ title: "微信绑定", body })
}

/**
 * 出码页：这个账号专属的授权二维码 + 轮询。
 *
 * @param {{sessionId: string, label: string, qrDataUri: string, authorizeUrl: string,
 *   ttlMs: number, mount?: string}} opts
 * @returns {string}
 */
export function goPage(opts) {
  const ttlSec = Math.max(0, Math.round((Number(opts.ttlMs) || 0) / 1000))
  const go = pathOf(opts.mount, "/bind/go")
  const checkUrl = pathOf(opts.mount, "/bind/api/check")
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
  <p class="hint">剩余时间 <span class="timer" id="left">--:--</span>，超时请重新扫码。</p>
  <p class="hint" id="poll">正在等待确认…</p>
  <a class="btn" id="done" style="display:none" href="${esc(go)}">再帮我们绑一个</a>
  <p class="hint" id="again" style="display:none">二维码已过期。<a href="${esc(go)}">点这里换一个</a></p>
</div>`
  // ⚠ sessionId 拼进内联脚本时必须把 `<` 转义掉（今天它只可能是 hex，但别赌来源）
  const sidJs = JSON.stringify(String(opts?.sessionId ?? "")).replace(/</g, "\\u003c")
  const script = `
(function () {
  var sid = ${sidJs};
  var checkUrl = ${JSON.stringify(checkUrl).replace(/</g, "\\u003c")};
  var deadline = Date.now() + ${Math.max(0, Number(opts.ttlMs) || 0)};
  var left = document.getElementById("left");
  var poll = document.getElementById("poll");
  var qr = document.getElementById("qr");
  function tick() {
    var s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    left.textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }
  tick();
  var timer = setInterval(tick, 1000);
  var tries = 0;
  var loop = setInterval(function () {
    tries += 1;
    if (tries > 45) { clearInterval(loop); clearInterval(timer); return; }
    fetch(checkUrl + "?session=" + encodeURIComponent(sid), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.status === "bound") {
          clearInterval(loop); clearInterval(timer);
          poll.innerHTML = '<span class="ok">绑定成功 ✓ 谢谢！</span>';
          qr.style.display = "none";
          document.getElementById("done").style.display = "block";
        } else if (j.status === "expired") {
          clearInterval(loop); clearInterval(timer);
          poll.textContent = "二维码已过期";
          qr.style.opacity = ".25";
          document.getElementById("again").style.display = "block";
        } else if (j.message) {
          poll.textContent = "等待中…（" + j.message + "）";
        }
      })
      .catch(function () {});
  }, 3000);
})();
`
  return layout({ title: `绑定账号 ${opts.label ?? ""}`, body, script })
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
