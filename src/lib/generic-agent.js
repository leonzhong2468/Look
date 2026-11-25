// ============================================================
//  通用平台驱动（generic driver）
//  给「非豆包」的 AI 网页用：不依赖站点私有结构，靠通用探针
//  （lib/gen-agent.js）找输入框 / 发送 / 上传 / 结果。
//
//  对外方法名与 lib/driver.js 完全一致，流水线不用改就能跑；
//  某个平台结构特殊时，优先改 gen-agent.js 里的选择器。
// ============================================================
const fs = require('fs');
const path = require('path');

const GEN_SRC = fs.readFileSync(path.join(__dirname, 'gen-agent.js'), 'utf-8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

class GenericDriver {
  constructor(view, opts = {}) {
    this.view = view;
    this.wc = view.webContents;
    this.log = opts.log || (() => {});
    this.accId = opts.accountId || '';
    this.provider = opts.provider || {};
    this._attached = false;
    this._injected = false;
    this._lastSent = '';
    this._mediaSig = new Set();
    this.onVerifyBlocked = null;
    this.onVerifyPassed = null;
  }

  get alive() {
    try { return this.wc && !this.wc.isDestroyed(); } catch (e) { return false; }
  }

  async inject() {
    if (!this.alive) return false;
    try {
      await this.wc.executeJavaScript(GEN_SRC, true);
      this._injected = true;
      return true;
    } catch (e) { return false; }
  }

  async js(expr) {
    if (!this.alive) throw new Error('页面已关闭');
    if (!this._injected) await this.inject();
    return this.wc.executeJavaScript(expr, true);
  }

  async shot(file) {
    if (!this.alive) return null;
    try {
      const img = await this.wc.capturePage();
      fs.writeFileSync(file, img.toPNG());
      return file;
    } catch (e) { return null; }
  }

  // ---------- 调试通道 ----------
  async _attachDebugger() {
    if (this._attached) return true;
    if (!this.alive) return false;
    try { this.wc.debugger.attach('1.3'); } catch (e) {}
    this._attached = true;
    try { await this.wc.debugger.sendCommand('DOM.enable'); } catch (e) {}
    try { await this.wc.debugger.sendCommand('Page.enable'); } catch (e) {}
    return true;
  }

  async cdp(method, params) {
    if (!(await this._attachDebugger())) throw new Error('调试通道不可用');
    return this.wc.debugger.sendCommand(method, params || {});
  }

  async clickAt(x, y) {
    if (!this.alive) return false;
    x = Math.round(x); y = Math.round(y);
    try { this.wc.focus(); } catch (e) {}
    try {
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
      await sleep(50);
      await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await sleep(60);
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleep(160);
      return true;
    } catch (e) {
      try {
        this.wc.sendInputEvent({ type: 'mouseMove', x, y });
        await sleep(50);
        this.wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        await sleep(40);
        this.wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await sleep(140);
        return true;
      } catch (e2) { return false; }
    }
  }

  async key(key, code, vk, modifiers = 0) {
    try {
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
      await sleep(70);
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
      return true;
    } catch (e) { return false; }
  }

  async prepare() {
    try { this.wc.setBackgroundThrottling(false); } catch (e) {}
    let vis = 'visible';
    try { vis = await this.js('document.visibilityState'); } catch (e) {}
    if (vis === 'hidden') {
      try { await this.cdp('Page.setWebLifecycleState', { state: 'active' }); } catch (e) {}
      try { await this.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
      await sleep(500);
      try { vis = await this.js('document.visibilityState'); } catch (e) {}
      this.log('页面原本在后台，已强制置为 active（' + vis + '）');
    }
    return vis;
  }

  async rescue() {
    this.log('页面可能失去交互能力，执行一次强制激活');
    try { await this.cdp('Page.setWebLifecycleState', { state: 'active' }); } catch (e) {}
    try { await this.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
    await sleep(300);
    try { this.wc.focus(); } catch (e) {}
    try { await this.focusEditor(); } catch (e) {}
    return true;
  }

  async focusEditor() {
    const c = await this.js('(window.__GEN ? __GEN.composer() : null)').catch(() => null);
    if (!c) return null;
    await this.clickAt(c.x, c.y);
    await sleep(250);
    return c;
  }

  async waitComposer(timeout = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const c = await this.js('(window.__GEN ? __GEN.composer() : null)').catch(() => null);
      if (c) return c;
      await sleep(600);
    }
    return null;
  }

  // ---------- 验证闸门 ----------
  async gateVerify({ timeoutMs = 20 * 60 * 1000 } = {}) {
    const vb = await this.js('(window.__GEN ? __GEN.verifyBlock() : null)').catch(() => null);
    if (!vb || !vb.on) return { ok: true, waited: 0 };
    if (this.onVerifyBlocked) { try { this.onVerifyBlocked(vb); } catch (e) {} }
    const r = await this.waitVerify({ timeoutMs, onTick: (secs) => this.log('等待人工验证 ' + secs + 's') });
    if (!r.ok) {
      const e = new Error('图像验证超时未完成');
      e.verify = true;
      throw e;
    }
    if (this.onVerifyPassed) { try { this.onVerifyPassed(r); } catch (e) {} }
    return r;
  }

  async waitVerify({ timeoutMs = 20 * 60 * 1000, onTick = null } = {}) {
    const t0 = Date.now();
    let last = 0;
    while (Date.now() - t0 < timeoutMs) {
      const vb = await this.js('(window.__GEN ? __GEN.verifyBlock() : null)').catch(() => null);
      if (!vb || !vb.on) {
        return { ok: true, waited: Math.round((Date.now() - t0) / 1000) };
      }
      const secs = Math.round((Date.now() - t0) / 1000);
      if (onTick && secs - last >= 5) { last = secs; onTick(secs); }
      await sleep(1500);
    }
    return { ok: false, waited: Math.round((Date.now() - t0) / 1000), err: '图像验证超时未完成' };
  }

  async needsLogin() {
    try { return await this.js('(window.__GEN ? __GEN.needsLogin() : false)'); } catch (e) { return false; }
  }

  async needsConfirm() {
    try { return await this.js('(window.__GEN ? __GEN.needsConfirm() : false)'); } catch (e) { return false; }
  }

  async clickConfirmButton() {
    const pt = await this.js('(window.__GEN ? __GEN.confirmBtn() : null)').catch(() => null);
    if (!pt) return false;
    await this.clickAt(pt.x, pt.y);
    await sleep(700);
    this.log('已点击页面上的「确认」按钮');
    return true;
  }

  async pickModelIfAsked() { return null; }

  async dismissPopups() {
    try {
      const list = await this.js('(window.__GEN ? __GEN.closeButtons() : [])').catch(() => []);
      if (list && list.length) {
        await this.clickAt(list[0].x, list[0].y);
        this.log('已关闭页面弹窗');
        return true;
      }
    } catch (e) {}
    return false;
  }

  // ---------- 打开对话 ----------
  async openNewChat(url) {
    if (!this.alive) return false;
    const target = url || (this.provider && this.provider.chatUrl);
    try {
      const cur = this.wc.getURL();
      if (target && cur && !cur.startsWith('about:')) {
        const same = cur.split('#')[0].split('?')[0] === String(target).split('#')[0].split('?')[0];
        if (same) {
          // 已经是这个对话页：优先点「新对话 / 新聊天」，找不到就刷新换一个干净的上下文
          const hit = await this.js(`(() => {
            const RE = /(新对话|新建对话|新聊天|新的聊天|new chat)/i;
            for (const el of document.querySelectorAll('button,[role="button"],a')) {
              const t = ((el.innerText||el.textContent||el.getAttribute('aria-label')||'')+'').trim();
              if (RE.test(t)) { const r = el.getBoundingClientRect(); if (r.width>10) return {x:r.left+r.width/2,y:r.top+r.height/2}; }
            }
            return null;
          })()`).catch(() => null);
          if (hit) {
            await this.clickAt(hit.x, hit.y);
            await sleep(1200);
          } else {
            await this.wc.reload();
            await sleep(1500);
          }
        } else {
          await this.wc.loadURL(target).catch(() => {});
          await sleep(1500);
        }
      } else if (target) {
        await this.wc.loadURL(target).catch(() => {});
        await sleep(1500);
      }
      const c = await this.waitComposer(30000);
      if (!c) {
        await sleep(1500);
        return !!(await this.waitComposer(12000));
      }
      return true;
    } catch (e) {
      this.log('打开对话失败: ' + e.message);
      return false;
    }
  }

  async ensureChatMode() { /* 通用平台没有技能面板，保持当前对话模式 */ }

  // ---------- 文本输入 ----------
  async enterText(text) {
    if (!this.alive) throw new Error('页面已关闭');
    const text0 = String(text || '');
    if (!text0) return { ok: false, err: '文本为空' };

    try { await this.gateVerify(); } catch (e) { return { ok: false, err: e.message, verify: true }; }

    let c = await this.waitComposer(15000);
    if (!c) { await this.dismissPopups(); await sleep(800); c = await this.waitComposer(10000); }
    if (!c) return { ok: false, err: '页面上找不到输入框' };

    await this.clickAt(c.x, c.y);
    await sleep(320);
    await this.key('a', 'KeyA', 65, 2);
    await sleep(120);
    await this.key('Backspace', 'Backspace', 8);
    await sleep(200);

    // 优先走调试协议的真实输入（contenteditable / textarea 都吃）
    try {
      await this.cdp('Input.insertText', { text: text0 });
    } catch (e) {
      try {
        const json = JSON.stringify(text0);
        await this.js(`(() => {
          const el = document.activeElement;
          if (!el) return false;
          if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') { el.value = ${json}; el.dispatchEvent(new Event('input', {bubbles:true})); return true; }
          if (el.isContentEditable) { document.execCommand('insertText', false, ${json}); return true; }
          return false;
        })()`);
      } catch (e2) { return { ok: false, err: '文本写不进去：' + e2.message }; }
    }
    await sleep(400);

    const got = await this.js('(window.__GEN ? __GEN.composerValue() : "")').catch(() => '');
    const need = Math.min(12, text0.length);
    let cur = String(got || '');
    if (cur.length < need) {
      // 再试一次：全选后逐段写入（有些编辑器要真的走按键才认）
      await this.clickAt(c.x, c.y);
      await sleep(200);
      await this.cdp('Input.insertText', { text: text0 }).catch(() => {});
      await sleep(600);
      cur = String(await this.js('(window.__GEN ? __GEN.composerValue() : "")').catch(() => '') || '');
    }
    this._lastSent = text0;
    if (cur.length < need) {
      return { ok: false, err: '输入框没有拿到文字', sample: cur.slice(0, 80) };
    }
    return { ok: true, len: cur.length };
  }

  async submit() {
    if (!this.alive) return { ok: false, err: '页面已关闭' };
    // 先记下当前页面里已有的媒体，等结果时只认「新出现的」
    try {
      const all = await this.js('[...(__GEN.media("image")||[]), ...(__GEN.media("video")||[])]').catch(() => []);
      this._mediaSig = new Set((all || []).map(x => x.src));
    } catch (e) {}

    const before = await this.js('(window.__GEN ? __GEN.composerValue() : "")').catch(() => '');
    const btn = await this.js('(window.__GEN ? __GEN.sendBtn() : null)').catch(() => null);
    if (btn) {
      await this.clickAt(btn.x, btn.y);
      await sleep(1200);
    } else {
      await this.key('Enter', 'Enter', 13);
      await sleep(1200);
    }
    const after = await this.js('(window.__GEN ? __GEN.composerValue() : "")').catch(() => '');
    const cleared = String(before || '').length > 0 && String(after || '').length < String(before || '').length * 0.5;
    if (!cleared && !btn) {
      // 回车没反应：再点一次发送按钮 / 再按一次
      const b2 = await this.js('(window.__GEN ? __GEN.sendBtn() : null)').catch(() => null);
      if (b2) await this.clickAt(b2.x, b2.y);
      else await this.key('Enter', 'Enter', 13);
      await sleep(1200);
    }
    return { ok: true, cleared };
  }

  async submitEvidence() { return true; }

  // ---------- 上传 ----------
  async _setFilesNative(paths) {
    try {
      const doc = await this.cdp('DOM.getDocument', { depth: 2 });
      const res = await this.cdp('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
      const ids = (res && res.nodeIds) || [];
      for (const nodeId of ids) {
        try {
          await this.cdp('DOM.setFileInputFiles', { files: paths, nodeId });
          return true;
        } catch (e) {}
      }
    } catch (e) {}
    return false;
  }

  async _clickUploadEntry() {
    const e = await this.js('(window.__GEN ? __GEN.uploadEntry() : null)').catch(() => null);
    if (!e) return false;
    await this.clickAt(e.x, e.y);
    await sleep(600);
    return true;
  }

  async uploadFiles(paths) {
    if (!paths || !paths.length) return { ok: false, err: '没有文件' };
    const n = paths.length;
    let inputs = await this.js('(window.__GEN ? __GEN.fileInputs() : [])').catch(() => []);
    let ok = false;
    if (inputs && inputs.length) {
      ok = await this._setFilesNative(paths);
    }
    if (!ok) {
      await this._clickUploadEntry();
      await sleep(500);
      ok = await this._setFilesNative(paths);
      if (!ok) {
        // 有些站点在点击「上传」后才把 input 挂上 DOM，再等一轮
        await sleep(1200);
        ok = await this._setFilesNative(paths);
      }
    }
    if (!ok) return { ok: false, err: '页面上找不到文件上传入口（input[type=file]）' };
    await sleep(1500);
    this.log(`已通过通用通道上传 ${n} 个文件（该平台未提供缩略图计数，按提交结果校验）`);
    return { ok: true, thumbs: n, fresh: n, generic: true };
  }

  // ---------- 等待文本 ----------
  async waitAiText({ timeoutMs = 240000, minLen = 120, stableMs = 7000, onTick = null, cancelled = () => false } = {}) {
    const t0 = Date.now();
    const needle = String(this._lastSent || '').trim().slice(-40);
    let last = '';
    let lastChange = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (cancelled()) throw new Error('用户取消');
      if (!this.alive) throw new Error('页面已关闭');
      const raw = String(await this.js(`(window.__GEN ? __GEN.textAfter(${JSON.stringify(needle)}) : "")`).catch(() => '') || '');
      const txt = raw.trim();
      if (txt && txt !== last) { last = txt; lastChange = Date.now(); }
      const secs = Math.round((Date.now() - t0) / 1000);
      if (onTick) { try { onTick({ secs, len: last.length }); } catch (e) {} }
      if (last.length >= minLen && Date.now() - lastChange >= stableMs) return last;
      await sleep(1500);
    }
    return last;
  }

  // ---------- 等待结果 ----------
  _newItems(list) {
    return (list || []).filter(x => x && x.src && !this._mediaSig.has(x.src));
  }

  async waitResult(kind, { timeout = 900000, onTick = null, cancelled = () => false, idleAbortMs = 45000 } = {}) {
    const t0 = Date.now();
    let idle = Date.now();
    let lastCount = 0;
    while (Date.now() - t0 < timeout) {
      if (cancelled()) throw new Error('用户取消');
      if (!this.alive) throw new Error('页面已关闭');
      const media = await this.js(`(window.__GEN ? __GEN.media(${JSON.stringify(kind)}) : [])`).catch(() => []);
      const fresh = this._newItems(media).filter(x => (kind === 'video' ? (x.w >= 120 && (x.dur > 0 || /\.mp4|video\//i.test(x.src))) : x.w >= 120));
      const secs = Math.round((Date.now() - t0) / 1000);
      if (onTick) { try { onTick({ secs, probe: { items: fresh } }); } catch (e) {} }

      // 视频：等它真的有可播地址（有的站点先放封面图，几秒后才挂 video）
      if (fresh.length) {
        if (kind !== 'video') {
          return { ok: true, items: fresh, reply: '' };
        }
        const playable = fresh.filter(x => x.dur > 0 || /^blob:|^https?:/i.test(x.src));
        if (playable.length) {
          await sleep(1200);
          return { ok: true, items: playable, reply: '' };
        }
      }
      if (fresh.length !== lastCount) { lastCount = fresh.length; idle = Date.now(); }

      const txt = String(await this.js('(window.__GEN ? __GEN.tail(1500) : "")').catch(() => '') || '');
      if (/(额度|次数|上限|配额|quota|limit reached)/i.test(txt)) {
        return { ok: false, err: '平台提示额度或次数不足', quota: true, reply: txt.slice(-300) };
      }
      if (/(验证|滑块|captcha)/i.test(txt)) {
        return { ok: false, err: '页面弹出了验证', verify: true, reply: txt.slice(-300) };
      }
      if (Date.now() - idle > idleAbortMs && !fresh.length) {
        return { ok: false, err: '页面没有任何生成迹象', reply: txt.slice(-300) };
      }
      await sleep(2500);
    }
    return { ok: false, err: '等待超时，没有出现结果' };
  }

  // ---------- 结果回收 ----------
  async probe() {
    const [body, media] = await Promise.all([
      this.js('(window.__GEN ? __GEN.tail(1200) : "")').catch(() => ''),
      this.js('[...(__GEN.media("image")||[]), ...(__GEN.media("video")||[])]').catch(() => [])
    ]);
    return { items: media || [], lastText: body || '', busy: [] };
  }

  async bodyText(n = 300) {
    try { return await this.js(`(window.__GEN ? __GEN.bodyText().slice(0,${n}) : "")`); } catch (e) { return ''; }
  }

  async openVideoSource(item) {
    if (!item) return null;
    if (item.src && /^https?:/i.test(item.src)) return { src: item.src, dur: item.dur || 0, vw: item.vw || 0 };
    await this.clickAt(item.x, item.y);
    await sleep(1500);
    const v = await this.js('(window.__GEN ? __GEN.media("video") : [])').catch(() => []);
    const hit = (v || []).filter(x => x.src && /^https?:/i.test(x.src)).sort((a, b) => b.w - a.w)[0];
    if (hit) return { src: hit.src, dur: hit.dur || 0, vw: hit.vw || 0 };
    return null;
  }

  async clickDownload(anchor) {
    if (!anchor) return false;
    await this.clickAt(anchor.x, anchor.y);   // 先把工具条 hover 出来
    await sleep(600);
    const hit = await this.js(`(() => {
      const target = ${JSON.stringify({ x: anchor.x, y: anchor.y })};
      let best = null;
      for (const el of document.querySelectorAll('a[download], button, [role="button"]')) {
        const t = ((el.innerText || el.textContent || el.getAttribute('aria-label') || '') + '').trim();
        if (!/下载|download/i.test(t)) continue;
        if (/客户端|client|app/i.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 6) continue;
        const d = Math.abs(r.left + r.width/2 - target.x) + Math.abs(r.top + r.height/2 - target.y);
        if (d > 460) continue;
        if (!best || d < best.d) best = { x: r.left + r.width/2, y: r.top + r.height/2, d };
      }
      return best ? { x: best.x, y: best.y } : null;
    })()`).catch(() => null);
    if (!hit) return false;
    await this.clickAt(hit.x, hit.y);
    this.log('已点击页面上的下载按钮');
    return true;
  }

  async closePlayer() {
    await this.key('Escape', 'Escape', 27);
    await sleep(400);
    return true;
  }
}

module.exports = { GenericDriver };
