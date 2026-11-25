// ============================================================
//  通用页面探针（注入到任意 AI 网页里执行）
//  目标：不依赖具体站点结构，尽量找到「输入框 / 发送按钮 / 上传入口 /
//  新生成的结果」四样东西，让通用平台也能被多开管理器托管。
//  站点结构特殊时，只改这个文件即可（不影响豆包的深度适配）。
// ============================================================
(function () {
  if (window.__GEN && window.__GEN.v === 4) return;

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 10) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.05) return false;
    return r.bottom > 0 && r.top < innerHeight + 200;
  }

  function rectOf(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), left: r.left, top: r.top };
  }

  function textOf(el) {
    return String((el && (el.innerText || el.textContent || el.getAttribute('aria-label') || el.title)) || '').replace(/\s+/g, ' ').trim();
  }

  // ---------- 输入框 ----------
  function composer() {
    const list = [];
    document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]').forEach(function (el) {
      if (!visible(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 120) return;
      const st = getComputedStyle(el);
      if (el.tagName === 'TEXTAREA' && el.readOnly) return;
      if (st.pointerEvents === 'none') return;
      list.push({ el: el, r: r, score: r.top + r.width * 0.05 + (el.tagName === 'TEXTAREA' ? 40 : 0) });
    });
    if (!list.length) return null;
    list.sort(function (a, b) { return b.score - a.score; });
    const it = list[0];
    return { x: Math.round(it.r.left + it.r.width / 2), y: Math.round(it.r.top + it.r.height / 2), w: Math.round(it.r.width), h: Math.round(it.r.height), tag: it.el.tagName };
  }

  function composerValue() {
    const c = composer();
    if (!c) return '';
    const el = document.activeElement;
    if (el && (el.tagName === 'TEXTAREA' || el.isContentEditable)) return (el.value !== undefined ? el.value : el.innerText) || '';
    return '';
  }

  // ---------- 发送按钮 ----------
  var SEND_RE = /^(发送|发送消息|提交|生成|生成视频|生成图片|开始生成|send|submit|generate|run)$/i;
  function sendBtn() {
    const c = composer();
    if (!c) return null;
    const cands = [];
    document.querySelectorAll('button, [role="button"], a[role="button"]').forEach(function (el) {
      if (!visible(el)) return;
      const t = textOf(el) || textOf(el.querySelector('svg title'));
      const aria = String(el.getAttribute('aria-label') || '');
      if (!SEND_RE.test(t) && !SEND_RE.test(aria)) return;
      const r = el.getBoundingClientRect();
      // 优先离输入框近、在输入框右侧/下方的按钮
      const dist = Math.abs((r.top + r.height / 2) - c.y) + Math.abs((r.left + r.width / 2) - c.x) * 0.6;
      if (dist > 420) return;
      cands.push({ el: el, r: r, d: dist });
    });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return a.d - b.d; });
    const r = cands[0].r;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  }

  // ---------- 文件上传 ----------
  function fileInputs() {
    var out = [];
    document.querySelectorAll('input[type=file]').forEach(function (el) {
      var r = el.getBoundingClientRect();
      out.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) });
    });
    return out;
  }

  function uploadEntry() {
    var RE = /(上传|添加图片|添加附件|图片|附件|upload|attach|image|photo)/i;
    var c = composer();
    var best = null;
    document.querySelectorAll('button, [role="button"], label, [aria-label]').forEach(function (el) {
      if (!visible(el)) return;
      var t = textOf(el) + ' ' + String(el.getAttribute('aria-label') || '');
      if (!RE.test(t)) return;
      if (/下载|download|客户端/i.test(t)) return;
      var r = el.getBoundingClientRect();
      var d = c ? Math.abs(r.top - c.y) + Math.abs(r.left - c.x) : 0;
      if (d > 500) return;
      if (!best || d < best.d) best = { r: r, d: d };
    });
    if (!best) return null;
    var r = best.r;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  }

  // ---------- 结果媒体 ----------
  function media(kind) {
    var out = [];
    var sel = kind === 'video' ? 'video' : 'img';
    document.querySelectorAll(sel).forEach(function (el) {
      if (!visible(el)) return;
      var r = el.getBoundingClientRect();
      if (r.width < 96 || r.height < 96) return;
      var src = el.currentSrc || el.src || '';
      if (!src) {
        var s = el.querySelector && el.querySelector('source');
        if (s) src = s.src || '';
      }
      if (!src) return;
      if (kind !== 'video' && /(logo|avatar|icon|emoji|sprite)/i.test(src)) return;
      var item = {
        src: src, kind: kind === 'video' ? 'video' : 'image',
        x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width), h: Math.round(r.height),
        vw: kind === 'video' ? (el.videoWidth || 0) : (el.naturalWidth || 0),
        dur: kind === 'video' ? (isFinite(el.duration) ? el.duration : 0) : 0
      };
      out.push(item);
    });
    return out;
  }

  // ---------- 文本 ----------
  function bodyText() {
    return String(document.body ? document.body.innerText : '');
  }

  // marker 之后的文字（用来从整页文本里切出「这一问之后 AI 说的话」）
  function textAfter(marker) {
    var t = bodyText();
    if (!marker) return t.slice(-4000);
    var i = t.lastIndexOf(marker);
    if (i < 0) return t.slice(-4000);
    return t.slice(i + marker.length);
  }

  function tail(n) { return bodyText().slice(-(n || 600)); }

  // ---------- 登录 / 验证 / 确认 ----------
  function needsLogin() {
    if (composer()) return false;
    var href = location.href;
    if (/login|signin|sign-in|passport|auth/i.test(href)) return true;
    return !!document.querySelector('input[type=password]');
  }

  function verifyBlock() {
    var t = bodyText().slice(0, 6000);
    var kw = /(请完成.{0,6}验证|安全验证|人机验证|拖动滑块|滑动验证|点击.{0,8}验证|verify you are human|captcha|unusual traffic)/i;
    var hit = kw.test(t);
    var frame = document.querySelector('iframe[src*="captcha"], iframe[src*="verify"], [class*="captcha"], [id*="captcha"], [class*="slider-verify"]');
    if (hit || frame) return { on: true, kind: 'image', hint: (t.match(kw) || [''])[0] };
    return null;
  }

  var CONFIRM_RE = /^(确认|确认生成|同意|继续|确定|confirm|continue)$/i;
  function confirmBtn() {
    var cands = [];
    document.querySelectorAll('button, [role="button"]').forEach(function (el) {
      if (!visible(el)) return;
      var t = textOf(el);
      if (!CONFIRM_RE.test(t)) return;
      var r = el.getBoundingClientRect();
      if (r.top < 80) return;               // 顶部导航里的「确定」不算
      cands.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) });
    });
    return cands.length ? cands[cands.length - 1] : null;
  }

  function needsConfirm() {
    return !!confirmBtn();
  }

  // ---------- 弹窗 ----------
  function closeButtons() {
    var out = [];
    document.querySelectorAll('[aria-label*="关闭"], [aria-label*="close"], button[class*="close"], .modal [class*="close"], [role="dialog"] button').forEach(function (el) {
      if (!visible(el)) return;
      var r = el.getBoundingClientRect();
      if (r.width > 80) return;             // 关闭按钮一般很小
      var t = textOf(el);
      if (/^(取消|关闭|×|x|✕|我知道了|下次再说)$/i.test(t) || /关闭|close/i.test(String(el.getAttribute('aria-label') || ''))) {
        out.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      }
    });
    return out;
  }

  function busyHints() {
    var t = bodyText().slice(-1200);
    var out = [];
    if (/(生成中|正在生成|排队中|处理中|请稍候|generating|processing)/i.test(t)) out.push({ t: 'busy', x: 0, y: 0 });
    return out;
  }

  window.__GEN = {
    v: 4,
    composer: composer,
    composerValue: composerValue,
    sendBtn: sendBtn,
    fileInputs: fileInputs,
    uploadEntry: uploadEntry,
    media: media,
    bodyText: bodyText,
    textAfter: textAfter,
    tail: tail,
    needsLogin: needsLogin,
    verifyBlock: verifyBlock,
    confirmBtn: confirmBtn,
    needsConfirm: needsConfirm,
    closeButtons: closeButtons,
    busyHints: busyHints,
    clickables: function () {
      var out = [];
      document.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"]').forEach(function (el) {
        if (!visible(el)) return;
        var t = textOf(el);
        if (t && t.length < 24) out.push({ t: t, x: 0, y: 0 });
      });
      return out;
    }
  };
})();
