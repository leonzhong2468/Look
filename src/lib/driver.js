// ============================================================
//  豆包页面驱动层
//  铁律：每一步都校验结果，不校验就不算成功。
//        - 输入框必须真的拿到焦点，文本必须真的写进去
//        - 图片必须真的出现缩略图
//        - 提交必须真的看到「生成中」或输入框被清空
//  任何一步不成立：停下来、截图、报清楚原因，而不是干等
// ============================================================
const fs = require('fs');
const path = require('path');
const { clipboard } = require('electron');

const AGENT_SRC = fs.readFileSync(path.join(__dirname, 'page-agent.js'), 'utf-8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DEFAULT_ANCHORS = {
  imageSkill: ['图像生成', '图片生成', 'AI 生图', '生成图片'],
  videoSkill: ['视频生成', 'AI 视频', '生成视频', '视频'],
  moreSkill: ['更多技能', '更多', '技能'],
  upload: ['上传图片', '上传', '添加图片', '添加附件', '+'],
  generate: ['生成', '开始生成', '立即生成'],
  download: ['下载'],
  send: ['发送', '生成'],
  newChat: ['新对话', '新会话'],
  ratio: ['9:16'],
  duration: ['15s', '15秒', '15 秒']
};

class Driver {
  constructor(view, opts = {}) {
    this.view = view;
    this.wc = view.webContents;
    this.log = opts.log || (() => {});
    this.anchors = Object.assign({}, DEFAULT_ANCHORS, opts.anchors || {});
    this._attached = false;
    this.accId = opts.accountId || '';
  }

  get alive() {
    try { return this.wc && !this.wc.isDestroyed(); } catch (e) { return false; }
  }

  async inject() {
    if (!this.alive) return false;
    try {
      await this.wc.executeJavaScript(AGENT_SRC, true);
      return true;
    } catch (e) { return false; }
  }

  async js(expr) {
    if (!this.alive) throw new Error('页面已关闭');
    await this.inject();
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

  // ---------- 调试通道（真实键鼠 + 文本输入都走它，比 sendInputEvent 可靠） ----------
  async _attachDebugger() {
    if (this._attached) return true;
    if (!this.alive) return false;
    try { this.wc.debugger.attach('1.3'); } catch (e) { /* 已附加 */ }
    this._attached = true;
    try { await this.wc.debugger.sendCommand('DOM.enable'); } catch (e) {}
    try { await this.wc.debugger.sendCommand('Page.enable'); } catch (e) {}
    return true;
  }

  async cdp(method, params) {
    if (!(await this._attachDebugger())) throw new Error('调试通道不可用');
    return this.wc.debugger.sendCommand(method, params || {});
  }

  // ---------- 鼠标 ----------
  async clickAt(x, y) {
    if (!this.alive) return false;
    x = Math.round(x); y = Math.round(y);
    try { this.wc.focus(); } catch (e) {}
    try {
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
      await sleep(40);
      await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await sleep(60);
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleep(140);
      return true;
    } catch (e) {
      // 兜底：Electron 原生事件
      try {
        this.wc.sendInputEvent({ type: 'mouseMove', x, y });
        await sleep(50);
        this.wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        await sleep(40);
        this.wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await sleep(120);
        return true;
      } catch (e2) { return false; }
    }
  }

  async rects(text, opts = {}) {
    const json = JSON.stringify(text);
    const o = JSON.stringify(Object.assign({ exact: true, max: 8 }, opts));
    return await this.js(`(window.__DB ? __DB.rects(${json}, ${o}) : [])`);
  }

  async clickText(text, opts = {}) {
    const r = await this.rects(text, opts);
    if (!r || !r.length) return null;
    const t = r[0];
    await this.clickAt(t.x, t.y);
    return t;
  }

  async clickAny(candidates, opts = {}) {
    for (const c of candidates) {
      const t = await this.clickText(c, opts);
      if (t) { this.log('点击锚点命中: ' + c + ` (${t.x},${t.y})`); return { key: c, rect: t }; }
    }
    return null;
  }

  /**
   * 页面在后台（视图被挪走/窗口被挡）时，Chromium 会把页面判为隐藏，
   * 输入框会降级成不可交互的副本。这里用调试协议把它强行拉回 active。
   */
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

  /**
   * 页面被判成 hidden / 焦点丢了之后的现场抢救：
   * 强制 lifecycle=active + 焦点模拟 + 把焦点重新点回输入框。
   * 「图和字都进去了、回车和发送都没反应」基本都是这个原因。
   */
  async rescue() {
    this.log('页面可能失去交互能力，执行一次强制激活');
    try { this.wc.setBackgroundThrottling(false); } catch (e) {}
    try { await this.cdp('Page.setWebLifecycleState', { state: 'active' }); } catch (e) {}
    try { await this.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
    await sleep(350);
    try { this.wc.focus(); } catch (e) {}
    try { await this.focusEditor(); } catch (e) {}
    let vis = '';
    try { vis = await this.js('document.visibilityState'); } catch (e) {}
    this.log('强制激活完成（visibilityState=' + vis + '）');
    return vis === 'visible';
  }

  /**
   * 首次登录 / 风控弹图像验证时，页面会完全没反应（输入框点不进去、发送也发不出）。
   * 这里不判失败：停下来等用户手动过验证，过完立刻返回，由流水线从第一步重跑。
   * @returns {ok, waited} waited 为等待秒数，0 表示没有验证
   */
  async waitVerify({ timeoutMs = 15 * 60 * 1000, onTick = null } = {}) {
    const probe = () => this.js('(window.__DB ? __DB.verifyBlock() : null)').catch(() => null);
    let vb = await probe();
    if (!vb || !vb.on) return { ok: true, waited: 0 };

    const t0 = Date.now();
    this.log(`检测到图像验证（${vb.sample || '验证弹层'}），已暂停，等待手动完成`);
    while (Date.now() - t0 < timeoutMs) {
      await sleep(2500);
      const secs = Math.round((Date.now() - t0) / 1000);
      if (onTick) { try { onTick(secs); } catch (e) {} }
      vb = await probe();
      if (!vb || !vb.on) {
        await sleep(1200); // 等弹层彻底收起
        this.log(`图像验证已通过（等待 ${secs}s）`);
        return { ok: true, waited: secs };
      }
    }
    return { ok: false, waited: Math.round((Date.now() - t0) / 1000), err: '图像验证超时未完成' };
  }

  /**
   * 验证闸门：页面弹出图像验证时，就在这里暂停等用户人工过验证（最多 20 分钟），
   * 过完自动返回、调用方继续原流程——任务不失败、不重跑。
   * 检测到弹层时先回调 onVerifyBlocked（pipeline 用它把页面调到前台、更新看板文案），
   * 验证通过后回调 onVerifyPassed（pipeline 用它把页面退回后台、更新看板文案）。
   * 没弹验证时只花一次探测的成本，直接返回 false。
   */
  async gateVerify({ timeoutMs = 20 * 60 * 1000 } = {}) {
    const vb = await this.js('(window.__DB ? __DB.verifyBlock() : null)').catch(() => null);
    if (!vb || !vb.on) return false;
    if (typeof this.onVerifyBlocked === 'function') {
      try { this.onVerifyBlocked(vb); } catch (e) {}
    } else {
      this.log(`[${this.accId}] 检测到图像验证弹层，等待手动完成`);
    }
    const r = await this.waitVerify({ timeoutMs });
    if (!r.ok) {
      const e = new Error('图像验证一直没完成：请在豆包页面手动过验证');
      e.verify = true;
      throw e;
    }
    if (typeof this.onVerifyPassed === 'function') {
      try { this.onVerifyPassed(r); } catch (e) {}
    }
    return true;
  }

  // ---------- 文本输入（三级兜底 + 校验） ----------
  async focusEditor() {
    const info = await this.js('(window.__DB ? __DB.composer() : null)');
    if (!info) return null;
    for (let i = 0; i < 3; i++) {
      await this.clickAt(info.x, info.y);
      await sleep(150);
      if (await this.js('(window.__DB ? __DB.isEditorFocused() : false)')) return info;
      await this.js('(window.__DB ? __DB.focusComposer() : false)');
      await sleep(120);
      if (await this.js('(window.__DB ? __DB.isEditorFocused() : false)')) return info;
      await sleep(200);
    }
    return null;
  }

  /** 把文本写进输入框，返回 {ok, len} */
  async enterText(text) {
    if (!this.alive) throw new Error('页面已关闭');
    const text0 = String(text || '');
    if (!text0) return { ok: false, err: '文本为空' };

    // 验证闸门：弹层一挡输入框根本点不进去，先等用户过完验证再输入（过完自动继续）
    await this.gateVerify();

    let f = await this.focusEditor();
    if (!f) {
      // 先试试是不是弹窗挡住了输入框，再走强制激活
      await this.dismissPopups();
      f = await this.focusEditor();
    }
    if (!f) {
      // 输入框点不进去：先强制激活一次再试（后台窗口/页面被判 hidden 时的典型症状）
      await this.rescue();
      f = await this.focusEditor();
    }
    if (!f) {
      return { ok: false, err: '输入框点不进去（窗口被最小化或页面处于不可交互状态）' };
    }

    const lenNow = () => this.js('(window.__DB ? __DB.editorText().length : 0)');

    // 1) CDP 直接插入（最接近真人输入，ProseMirror 正常处理）
    try { await this.cdp('Input.insertText', { text: text0 }); await sleep(280); } catch (e) {}
    let len = await lenNow();

    // 2) execCommand 兜底
    if (!len) {
      await this.js(`(window.__DB ? __DB.execInsert(${JSON.stringify(text0)}) : false)`);
      await sleep(280);
      len = await lenNow();
    }

    // 3) 系统剪贴板兜底
    if (!len) {
      let prev = '';
      try { prev = clipboard.readText(); } catch (e) {}
      try {
        clipboard.writeText(text0);
        await this.js('(window.__DB ? __DB.focusComposer() : false)');
        this.wc.paste();
        await sleep(450);
        len = await lenNow();
      } catch (e) {
        this.log('剪贴板粘贴失败: ' + e.message);
      } finally {
        setTimeout(() => { try { clipboard.writeText(prev || ''); } catch (e) {} }, 600);
      }
    }

    if (!len) return { ok: false, err: '文本没有写进输入框（三种方式都失败）' };

    const got = await this.js('(window.__DB ? __DB.editorText() : "")');
    const want = text0.replace(/\s+/g, '').slice(0, 12);
    const ok = String(got || '').replace(/\s+/g, '').includes(want);
    if (!ok) return { ok: false, err: '写入内容与预期不一致', sample: String(got).slice(0, 40) };
    // 记住「这句话是我们自己说的」，供 needsConfirm 排除自我触发
    await this.js(`(window.__DB ? __DB.markSaid(${JSON.stringify(text0)}) : 0)`).catch(() => 0);
    return { ok: true, len };
  }

  // 兼容老调用
  async pasteText(text) {
    const r = await this.enterText(text);
    return r.ok;
  }

  // ---------- 提交 ----------
  async pressEnter() {
    const base = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    try {
      await this.cdp('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown', text: '\r', unmodifiedText: '\r' }, base));
      await sleep(60);
      await this.cdp('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
    } catch (e) {
      this.log('回车发送失败: ' + e.message);
      this.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      this.wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }
    return true;
  }

  /**
   * 判断「真的发出去了」：出现生成中标志，或输入框里的内容已经没了
   * 注意：ProseMirror 清空后 innerText 是 "\n"，长度 1，不能用 === 0 判断
   */
  async submitEvidence(fingerprint) {
    const p = await this.probe();
    if (p && (p.busy || []).length) return { ok: true, by: 'busy', busy: p.busy };
    if (fingerprint) {
      const now = String(await this.js('(window.__DB ? __DB.editorText() : "")')).replace(/\s+/g, '');
      const fp = String(fingerprint).replace(/\s+/g, '');
      if (fp && !now.includes(fp)) return { ok: true, by: 'cleared' };
      if (!now) return { ok: true, by: 'empty' };
    } else if (p && p.editorLen === 0) {
      return { ok: true, by: 'empty' };
    }
    return { ok: false };
  }

  async waitEvidence(fingerprint, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const ev = await this.submitEvidence(fingerprint);
      if (ev.ok) return ev;
      await sleep(350);
    }
    return { ok: false };
  }

  /**
   * 提交：优先回车（豆包真正认的提交方式），不行再点「发送/生成」按钮
   * @param {string} fingerprint 用来判断内容是否已从输入框消失
   */
  async submit(fingerprint) {
    // 发出去之前先确认页面是「可见」状态：hidden 时豆包会把输入框降级成不可交互副本，
    // 这时回车、点发送都毫无反应，但编辑器里的字还在（就是之前那个「请求没发出去」）。
    try {
      const vis = await this.js('document.visibilityState');
      if (vis && vis !== 'visible') await this.rescue();
    } catch (e) {}
    const txt = String(await this.js('(window.__DB ? __DB.editorText() : "")')).replace(/\s+/g, '');
    const fp = fingerprint || txt.slice(0, 12);

    await this.pressEnter();
    let ev = await this.waitEvidence(fp, 5000);
    if (ev.ok) { this.log(`已提交（${ev.by}）`); return ev; }

    // 按钮兜底：按 aria-label 找真实中心点，避免点到旁边的图标
    const btn = await this.js('(window.__DB ? __DB.clickableByAria(["发送", "生成", "开始生成", "立即生成"]) : null)');
    if (btn) {
      this.log(`回车没反应，改点「${btn.aria || '按钮'}」(${btn.x},${btn.y})`);
      await this.clickAt(btn.x, btn.y);
    } else {
      this.log('没找到发送按钮，继续观察页面');
    }
    ev = await this.waitEvidence(fp, 8000);
    if (ev.ok) { this.log(`已提交（${ev.by}）`); return ev; }

    // 还不行：多半是页面被判成 hidden / 焦点掉了（输入框里的字还在，但发不出去）。
    // 强制激活一次，把焦点点回输入框，再按一次回车。
    await this.rescue();
    const again = await this.focusEditor();
    if (again) {
      await this.pressEnter();
      ev = await this.waitEvidence(fp, 8000);
      if (ev.ok) { this.log(`已提交（${ev.by}，强制激活后）`); return ev; }
      const b2 = await this.js('(window.__DB ? __DB.clickableByAria(["发送", "生成", "开始生成", "立即生成"]) : null)');
      if (b2) {
        await this.clickAt(b2.x, b2.y);
        ev = await this.waitEvidence(fp, 8000);
        if (ev.ok) { this.log(`已提交（${ev.by}，强制激活后点按钮）`); return ev; }
      }
    }
    const still = String(await this.js('(window.__DB ? __DB.editorText() : "")')).replace(/\s+/g, '').length;
    const p2 = await this.probe().catch(() => null);
    return {
      ok: false,
      err: '回车和点击按钮之后，页面仍没有开始生成'
        + `（输入框仍留 ${still} 字，可见性正常=${p2 ? '是' : '未知'}）`
    };
  }

  // ---------- 文件上传（带缩略图校验） ----------
  async _setFilesNative(paths) {
    try {
      const doc = await this.cdp('DOM.getDocument', { depth: 2 });
      const res = await this.cdp('DOM.querySelectorAll', {
        nodeId: doc.root.nodeId, selector: 'input[type=file]'
      });
      const ids = (res && res.nodeIds) || [];
      if (!ids.length) return false;
      // 多个 input 时挑离输入框最近的那个，避免把文件塞进头像上传之类的无关 input
      let target = ids[0];
      try {
        const pt = await this.js('(window.__DB ? __DB.composerPoint() : null)');
        if (pt) {
          let bestD = Infinity;
          for (const nid of ids) {
            try {
              const bm = await this.cdp('DOM.getBoxModel', { nodeId: nid });
              if (!bm || !bm.model || !bm.model.content) continue;
              const q = bm.model.content;
              const d = Math.hypot((q[0] + q[4]) / 2 - pt.x, (q[1] + q[5]) / 2 - pt.y);
              if (d < bestD) { bestD = d; target = nid; }
            } catch (e) {}
          }
        }
      } catch (e) {}
      await this.cdp('DOM.setFileInputFiles', { files: paths, nodeId: target });
      return true;
    } catch (e) {
      this.log('原生上传失败: ' + e.message);
      return false;
    }
  }

  /**
   * 新版豆包首页：input[type=file] 平时不存在，要点输入框旁的「+ / 上传图片」才临时创建，
   * 且创建后立刻弹系统文件框。用 CDP 拦下系统框，入口一出现 input 就塞文件。
   */
  async _uploadViaIntercept(paths) {
    let intercepted = false;
    try {
      await this.cdp('Page.setInterceptFileChooserDialog', { enabled: true });
      intercepted = true;
    } catch (e) { this.log('无法拦截文件选择框: ' + e.message); }
    try {
      for (let round = 0; round < 3; round++) {
        await this._clickUploadEntry();
        for (let i = 0; i < 12; i++) {
          await sleep(200);
          const inputs = await this.js('(window.__DB ? __DB.fileInputs() : [])');
          if (inputs && inputs.length) {
            if (await this._setFilesNative(paths)) {
              await sleep(400);
              if (await this._fileCount()) return true;
            }
          }
        }
      }
      return false;
    } finally {
      if (intercepted) {
        try { await this.cdp('Page.setInterceptFileChooserDialog', { enabled: false }); } catch (e) {}
      }
    }
  }

  /** 点输入框附近的上传入口（「+」图标 / 「上传图片」菜单项，含 aria-label / title 识别） */
  async _clickUploadEntry() {
    try {
      const entries = await this.js('(window.__DB ? __DB.uploadEntries() : [])');
      if (entries && entries.length) {
        const e = entries[0];
        this.log('点击上传入口: ' + (e.t || '+') + ` (${e.x},${e.y})`);
        await this.clickAt(e.x, e.y);
        return true;
      }
    } catch (e) {}
    // 探针没找到就退回文字锚点
    try { await this.clickAny(this.anchors.upload, { exact: false }); } catch (e) {}
    return false;
  }

  async _fileCount() {
    try {
      return await this.js('(() => { const i = document.querySelector("input[type=file]"); return i && i.files ? i.files.length : 0; })()');
    } catch (e) { return 0; }
  }

  async _thumbs() {
    try { return await this.js('(window.__DB ? __DB.thumbSrcs() : [])'); } catch (e) { return []; }
  }

  /** 上传并确认输入区真的出现了「新」缩略图（用 blob 源区分新旧，避免残留图误判） */
  async uploadFiles(paths) {
    if (!paths || !paths.length) return { ok: false, err: '没有文件' };
    const before = (await this._thumbs()) || [];

    let inputs = await this.js('(window.__DB ? __DB.fileInputs() : [])');
    if (!inputs || !inputs.length) {
      await this.clickAny(this.anchors.upload, { exact: false });
      await sleep(900);
      inputs = await this.js('(window.__DB ? __DB.fileInputs() : [])');
    }

    let ok = false;
    if (inputs && inputs.length) {
      ok = await this._setFilesNative(paths);
      if (ok) {
        await sleep(600);
        const n = await this._fileCount();
        if (!n) ok = false;
      }
      if (!ok) {
        for (const p of paths) {
          const b64 = fs.readFileSync(p).toString('base64');
          const name = path.basename(p);
          const ext = path.extname(p).toLowerCase();
          const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
          const r = await this.js(`(window.__DB ? __DB.uploadViaDataTransfer(${JSON.stringify(b64)}, ${JSON.stringify(name)}, ${JSON.stringify(mime)}) : {ok:false})`);
          if (!r || !r.ok) return { ok: false, err: '上传失败: ' + ((r && r.err) || 'unknown') };
          await sleep(600);
        }
      }
    } else {
      // 新版豆包首页：没有常驻 input，走「点上传入口 + 拦截文件选择框」
      ok = await this._uploadViaIntercept(paths);
      if (!ok) return { ok: false, err: '页面上找不到文件上传入口（input[type=file]）' };
    }

    // 关键：等到「新出现的缩略图」，等不到就是没传进去
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const now = (await this._thumbs()) || [];
      const fresh = now.filter(s => !before.includes(s));
      if (fresh.length) {
        await sleep(700);
        return { ok: true, thumbs: now.length, fresh: fresh.length };
      }
    }
    const now = (await this._thumbs()) || [];
    return { ok: false, err: `已选择文件，但输入区没有出现新的图片缩略图（前 ${before.length} 后 ${now.length}）` };
  }

  // ---------- 状态探测 ----------
  async probe() {
    return await this.js('(window.__DB ? __DB.probe() : null)');
  }

  async bodyText(n = 300) {
    try { return await this.js(`(window.__DB ? __DB.bodyText(${n}) : document.body.innerText.slice(0,${n}))`); } catch (e) { return ''; }
  }

  async needsLogin() {
    try { return await this.js('(window.__DB ? __DB.needsLogin() : false)'); } catch (e) { return false; }
  }

  /** 豆包是否在等我们确认（「确认后我再开始生成视频」） */
  async needsConfirm() {
    try { return await this.js('(window.__DB ? __DB.needsConfirm() : false)'); } catch (e) { return false; }
  }

  /** 最后一条豆包消息里有没有「确认生成」这类按钮（版权授权卡），有就直接点 */
  async clickConfirmButton() {
    let pt = null;
    try { pt = await this.js('(window.__DB ? __DB.confirmButton() : null)'); } catch (e) {}
    if (!pt) return false;
    try { await this.clickAt(pt.x, pt.y); } catch (e) { return false; }
    await sleep(600);
    this.log('已点击豆包追问卡片上的「确认」按钮');
    return true;
  }

  /**
   * 豆包提示「seedance_2.5 不可用，请选择一个可执行模型继续，回 1 或 2」时自动代答。
   * 选模型的原则：能力优先（pro/高版本 > fast > standard > mini > lite），
   * 其次看它支持的时长能不能盖住我们这条片子。
   */
  async pickModelIfAsked() {
    let mp = null;
    try { mp = await this.js('(window.__DB && __DB.modelPrompt) ? __DB.modelPrompt() : null'); } catch (e) { return null; }
    if (!mp || !mp.on || !(mp.options || []).length) return null;

    const rank = (id) => {
      const s = String(id || '').toLowerCase();
      let v = 0;
      if (/pro|ultra|max|master/.test(s)) v += 8;
      if (/2\.5|3\.0|3\.5|v3/.test(s)) v += 6;
      if (/fast|turbo|speed/.test(s)) v += 4;
      if (/standard|normal|plus|base/.test(s)) v += 3;
      if (/mini|small|nano/.test(s)) v += 1;
      if (/lite|tiny|flash/.test(s)) v += 0;
      if (/1\.0|1\.5|beta|test/.test(s)) v -= 2;
      return v;
    };
    const best = mp.options.slice().sort((a, b) =>
      rank(b.id) - rank(a.id) || (b.maxSec || 0) - (a.maxSec || 0) || a.n - b.n)[0];

    const txt = String(best.n);
    const et = await this.enterText(txt);
    if (!et.ok) { this.log('模型选项要回「' + txt + '」，但没写进输入框：' + (et.err || '')); return { ok: false }; }
    const sub = await this.submit(txt);
    await this.js(`(window.__DB && __DB.markAnswered ? __DB.markAnswered(${JSON.stringify(mp.raw || '')}) : 0)`).catch(() => 0);
    this.log(`豆包提示原模型不可用，已自动选择「${best.id}」（回复 ${txt}）${sub.ok ? '' : '，但没发出去'}`);
    return { ok: !!sub.ok, n: best.n, id: best.id };
  }

  async waitComposer(timeout = 30000) {
    const t0 = Date.now();
    let dismissed = false;
    while (Date.now() - t0 < timeout) {
      const c = await this.js('(window.__DB ? __DB.composer() : null)');
      if (c) return c;
      // 等了 5 秒还没有输入框：很可能是广告/推广弹窗把页面盖住了，试着关掉
      if (!dismissed && Date.now() - t0 > 5000) {
        dismissed = true;
        await this.dismissPopups();
      }
      await sleep(500);
    }
    return null;
  }

  /**
   * 识别并关闭豆包的广告/推广弹窗（「下载电脑版」这类会把输入框盖住）。
   * 逐个点关闭入口，最多 3 个；没有弹窗时一次探针就返回，开销可忽略。
   */
  async dismissPopups() {
    let closed = 0;
    for (let i = 0; i < 3; i++) {
      let pt = null;
      try { pt = await this.js('(window.__DB ? __DB.popupClose() : null)'); } catch (e) {}
      if (!pt) break;
      try { await this.clickAt(pt.x, pt.y); } catch (e) { break; }
      await sleep(800);
      closed++;
    }
    if (closed) this.log('已识别并关闭推广弹窗 × ' + closed);
    return closed;
  }

  // ---------- 会话 ----------
  async openNewChat(url) {
    if (!this.alive) throw new Error('页面已关闭');
    await this.wc.loadURL(url);
    await this.dismissPopups();   // 打开页面先清一次弹窗，别让广告盖住输入框
    const c = await this.waitComposer(40000);
    await sleep(1200);
    try {
      const p = await this.js('location.pathname');
      if (/\/chat\/[A-Za-z0-9_-]{8,}/.test(p || '')) {
        const hit = await this.clickAny(this.anchors.newChat, { exact: true });
        if (hit) { this.log('已点击「新对话」，重置会话'); await sleep(1600); }
        else {
          await this.pressKeyCombo('K', ['control', 'shift']);
          this.log('已用快捷键新建对话');
          await sleep(1600);
        }
      }
    } catch (e) {}
    return !!c;
  }

  async pressKeyCombo(key, modifiers) {
    const mods = (modifiers || []).map(m => m === 'control' ? 2 : m === 'shift' ? 8 : m === 'alt' ? 1 : 0).reduce((a, b) => a | b, 0);
    const code = key.toUpperCase();
    try {
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code: 'Key' + code, modifiers: mods, windowsVirtualKeyCode: code.charCodeAt(0) });
      await sleep(60);
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: 'Key' + code, modifiers: mods, windowsVirtualKeyCode: code.charCodeAt(0) });
    } catch (e) {
      this.wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
      this.wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
    }
    await sleep(600);
  }

  /**
   * 进入技能面板（图像生成 / 视频生成）
   * 点完必须校验：输入框占位符或模式标志对得上，才算成功
   */
  async openSkill(kind) {
    const cands = kind === 'video' ? this.anchors.videoSkill : this.anchors.imageSkill;
    const check = async () => {
      const m = await this.js('(window.__DB ? __DB.modeInfo() : null)');
      if (!m) return null;
      const hit = kind === 'video' ? m.video : m.image;
      return hit ? m : null;
    };

    for (let round = 0; round < 2; round++) {
      let hit = await this.clickAny(cands, { exact: true });
      if (!hit) {
        await this.clickAny(this.anchors.moreSkill, { exact: true });
        await sleep(800);
        hit = await this.clickAny(cands, { exact: false });
      }
      if (!hit) {
        await sleep(600);
        hit = await this.clickAny(cands, { exact: false });
      }
      if (!hit) continue;
      // 校验模式是否真的切过去了
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        const m = await check();
        if (m) { this.log(`已进入${kind === 'video' ? '视频' : '图像'}生成模式`); return { key: hit.key, mode: m }; }
      }
      this.log(`点了「${hit.key}」但页面没切到 ${kind} 模式，重试`);
    }
    return null;
  }

  /** 读视频面板当前的档位（比例/时长/分辨率），平台默认是「自动 · 10s」 */
  async videoParams() {
    let chips = [];
    try { chips = await this.js('(window.__DB ? __DB.videoChips() : [])'); } catch (e) {}
    let dur = null, ratio = null, res = null;
    for (const c of chips || []) {
      const md = /(\d+)\s*s/i.exec(c.t);
      if (md && !dur) dur = Number(md[1]);
      const mr = /(9:16|16:9|1:1|3:4|4:3)/.exec(c.t);
      if (mr && !ratio) ratio = mr[1];
      const mp = /(\d{3,4})\s*p/i.exec(c.t);
      if (mp && !res) res = Number(mp[1]);
    }
    return { dur, ratio, res, chips: (chips || []).map(c => c.t) };
  }

  /** 试着把视频档位切成指定比例（能点到就点，点不到就交给平台默认） */
  async setVideoRatio(ratio) {
    const chips = await this.js('(window.__DB ? __DB.videoChips() : [])');
    const chip = (chips || []).find(c => /^自动/.test(c.t)) || (chips || [])[0];
    if (!chip) return null;
    await this.clickAt(chip.x, chip.y);
    await sleep(900);
    const hit = await this.clickText(ratio, { exact: true, max: 6 });
    if (hit) { this.log(`视频比例已选 ${ratio}`); await sleep(500); }
    // 关掉可能还在的弹层
    try { await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); } catch (e) {}
    return hit ? ratio : null;
  }


  /** 若页面停在「图像生成 / 视频生成」技能面板，先退回普通对话 */
  async ensureChatMode() {
    try {
      const m = await this.js('(window.__DB ? __DB.modeInfo() : null)');
      if (m && (m.image || m.video)) {
        const hit = await this.clickAny(['对话'], { exact: true });
        await sleep(1400);
        this.log(hit ? '已切回普通对话' : '未找到「对话」入口，继续当前模式');
      }
    } catch (e) {}
    return true;
  }

  /** 在可选参数里挑一个（画幅、时长） */
  async pickOption(cands, { exact = false, preferMax = false } = {}) {
    for (const c of cands) {
      const t = await this.clickText(c, { exact, max: 6 });
      if (t) return { key: c, rect: t };
    }
    if (preferMax) {
      const opts = await this.js('(window.__DB ? __DB.clickables() : [])');
      const nums = (opts || []).filter(o => /^\d+\s*(s|秒)$/i.test(o.t)).map(o => ({ ...o, n: parseInt(o.t, 10) }));
      if (nums.length) {
        nums.sort((a, b) => b.n - a.n);
        await this.clickAt(nums[0].x, nums[0].y);
        return { key: nums[0].t, rect: nums[0] };
      }
    }
    return null;
  }

  /**
   * 等豆包把一段**文字**写完（用来读「AI 代写」的提示词，不涉及出图/出片）。
   * 判定：文本够长 + 页面不忙 + 内容连续 stableMs 没再变化。
   * @returns 提示词原文（保留换行）；超时返回已拿到的部分，空串表示没写出来
   */
  async waitAiText({ timeoutMs = 240000, minLen = 120, stableMs = 7000, onTick = null, cancelled = () => false } = {}) {
    const t0 = Date.now();
    let last = '';
    let lastChange = Date.now();
    let lastGate = 0;
    while (Date.now() - t0 < timeoutMs) {
      if (cancelled()) throw new Error('用户取消');
      if (!this.alive) throw new Error('页面已关闭');
      // 验证闸门：等待期间弹出验证就暂停等用户过完，再继续读豆包的回复
      // （不设闸门时会读到被验证弹层污染的半截文字，误判成「写得不像提示词」）
      const gsec = Math.round((Date.now() - t0) / 1000);
      if (gsec - lastGate >= 6) { lastGate = gsec; await this.gateVerify(); }
      const txt = String(await this.js('(window.__DB && __DB.lastAiText) ? __DB.lastAiText() : ""').catch(() => '') || '');
      if (txt !== last) { last = txt; lastChange = Date.now(); }
      const b = await this.js('(window.__DB ? __DB.busy() : [])').catch(() => []);
      const idle = Array.isArray(b) ? b.length === 0 : !b;
      if (onTick) onTick({ secs: Math.round((Date.now() - t0) / 1000), len: last.length, idle });
      if (idle && last.length >= minLen && Date.now() - lastChange > stableMs) return last;
      await sleep(1500);
    }
    return last;
  }

  /**
   * 等待生成完成
   * - 不再每轮回滚到底部打扰用户，只在“本来就在底部”时才跟随
   * - 提交后若长时间毫无生成迹象，提前失败，不干等到超时
   */
  async waitResult(kind, { timeout = 900000, onTick = null, cancelled = () => false, idleAbortMs = 45000, confirmReply = null, confirmGraceMs = 0 } = {}) {
    const t0 = Date.now();
    let lastSig = '';
    let stable = 0;
    let lastReport = 0;
    let sawBusy = false;
    let lastChange = Date.now();
    let lastTextLen = -1;
    // confirmGraceMs：刚在外面代答过一次，给它一段安静期，别连着刷同一句话
    let lastConfirm = Date.now() - 45000 + Math.max(0, confirmGraceMs);
    let lastModelCheck = 0;
    let lastGate = 0;
    while (Date.now() - t0 < timeout) {
      if (cancelled()) throw new Error('用户取消');
      if (!this.alive) throw new Error('页面已关闭');

      // 豆包把原模型下线了、列一排让用户回数字：自动挑一个能力最强的代答
      if (Date.now() - lastModelCheck > 9000) {
        lastModelCheck = Date.now();
        const picked = await this.pickModelIfAsked().catch(() => null);
        if (picked && picked.ok) { await sleep(2500); continue; }
      }

      // 豆包中途停下来问「是否改用可用模型 / 确认后我再开始」→ 自动替用户答一句
      if (confirmReply && Date.now() - lastConfirm > 45000) {
        const asked = await this.needsConfirm().catch(() => false);
        if (asked) {
          lastConfirm = Date.now();
          // 读到豆包的话后稍等一下，让它把这一轮说完；顶在半截发，豆包经常不认
          await sleep(2600);
          // 授权/版权确认卡带「确认生成」按钮：点按钮最稳，回文字它不认
          if (await this.clickConfirmButton().catch(() => false)) { await sleep(2000); continue; }
          const q = String(await this.js('(window.__DB ? (__DB.lastMsg()||{}).t : "")').catch(() => '') || '');
          const et = await this.enterText(confirmReply).catch(() => ({ ok: false }));
          if (et.ok) {
            const sub = await this.submit(confirmReply).catch(() => ({ ok: false }));
            await this.js(`(window.__DB ? __DB.markAnswered(${JSON.stringify(q)}) : 0)`).catch(() => 0);
            this.log(sub.ok ? '豆包在追问/等确认，已自动回复：直接按最长时长生成' : '自动回复确认失败');
          }
          await sleep(1200);
        }
      }

      let p = await this.probe();
      const secs = Math.round((Date.now() - t0) / 1000);

      // 验证闸门：等待结果期间弹出图像验证（比如提交触发的二次验证），暂停等用户
      // 过完再继续等结果——不失败、不重跑，生成中的请求也不受影响
      if (secs - lastGate >= 12) {
        lastGate = secs;
        await this.gateVerify();
      }

      // 额度用完了就别干等：立刻带着原因退出，让流水线换号或提示用户
      // 同时盯「消息发出去了但豆包一直没回应」（页面卡住 / 请求没到服务端）
      if (secs >= 12) {
        const st = await this.js('(window.__DB ? { q: __DB.quotaExhausted(), mine: __DB.lastIsMine() } : null)')
          .catch(() => null);
        if (st && st.q) {
          return { ok: false, secs, quota: true, err: '账号今日视频生成额度已用完（页面提示需开通订阅）' };
        }
        if (st && st.mine && !sawBusy && secs > 45) {
          return { ok: false, secs, err: '消息发出去后豆包一直没有回应（可能没到服务端或页面卡住）' };
        }
      }

      // 懒加载：没有结果时，先把占位图/最后一条消息滚进视口触发渲染，其余时候不动用户的滚动位置
      const hasResultNow = (p && ((p.images || []).some(i => i.nw >= 400) || this._videoItems(p).length));
      if (p && !hasResultNow) {
        try {
          const revealed = await this.js('(window.__DB ? __DB.revealPending() : 0)');
          const doneClaim = await this.js('(window.__DB ? __DB.hasDoneClaim() : false)').catch(() => false);
          const lastMsg = doneClaim ? await this.js('(window.__DB ? __DB.revealLastMsg() : 0)').catch(() => 0) : 0;
          if (revealed || lastMsg) { await sleep(1300); p = await this.probe(); }
          // 豆包已经说「生成好了」，就多给它一点时间把卡片渲染出来
          if (doneClaim) { lastChange = Date.now(); sawBusy = true; }
        } catch (e) {}
      }

      if (secs - lastReport >= 10) {
        lastReport = secs;
        if (onTick) onTick({ secs, probe: p });
        this.log(`[${this.accId}] 等待${kind === 'video' ? '视频' : '图片'} ${secs}s busy=${JSON.stringify(p && p.busy)}`);
      }

      if (p) {
        if ((p.busy || []).length) sawBusy = true;

        // 豆包只要「接单」了（「预计等待 10 分钟，生成好后发给你」），就当它在干活：
        // 页面上没有生成中标志也不算卡住，一直等到出片（上限由 timeout 兜住）
        const pr = await this.js('(window.__DB ? __DB.promised() : false)').catch(() => false);
        if (pr) {
          if (!sawBusy) this.log(`[${this.accId}] 豆包已接单，正在排队出片，继续等待`);
          sawBusy = true;
          lastChange = Date.now();
        }

        const items = kind === 'video'
          ? this._videoItems(p)
          : (p.images || []).filter(i => i.nw >= 400 && i.nh >= 400 && !/^blob:/i.test(i.src || ''));
        const sig = kind === 'video'
          ? items.map(v => `${v.src}|${Math.round(v.dur || 0)}|${v.nw || 0}`).join(',')
          : items.map(i => `${i.src}|${i.nw}x${i.nh}`).join(',');
        const busy = (p.busy || []).length > 0;

        // 页面还在变（文字在增长）就不算卡住
        const tl = await this.js('(window.__DB ? __DB.textLen() : 0)').catch(() => lastTextLen);
        if (tl !== lastTextLen) { lastTextLen = tl; lastChange = Date.now(); }
        if (sig !== lastSig) lastChange = Date.now();

        if (items.length && !busy && sig && sig === lastSig) {
          stable += 1;
          if (stable >= 2) return { ok: true, items, probe: p, secs };
        } else {
          stable = 0;
        }
        lastSig = sig;
      }

      // 早退：页面既不忙、也没有任何结果、内容还长时间不变
      // - 从没忙过 → 消息可能根本没发出去
      // - 忙过又停下来 → 生成被中断，或豆包只回了文字没出片
      const idleFor = Date.now() - lastChange;
      // 忙过之后停下来的判定更保守（图片/视频出片过程中文字可能长时间不变）
      const idleLimit = sawBusy ? Math.max(idleAbortMs * 2, 180000) : idleAbortMs;
      if (!lastSig && idleFor > idleLimit) {
        // 先排除「被图像验证挡住」：这种情况消息根本没进页面，等用户过验证即可
        const vb = await this.js('(window.__DB ? __DB.verifyBlock() : null)').catch(() => null);
        if (vb && vb.on) {
          return { ok: false, secs, verify: true, err: '页面弹出图像验证，消息没能发出去' };
        }
        const reply = await this.js('(window.__DB ? __DB.lastReply() : "")').catch(() => '');
        const tail = String(reply || '').slice(-400);
        if (tail) this.log(`[${this.accId}] 页面最后一段文字：${tail.replace(/\s+/g, ' ').slice(-160)}`);
        return {
          ok: false,
          secs,
          reply: tail,
          err: sawBusy
            ? '生成中途停了：页面已经没有「生成中」，但也没有出片（豆包大概率只回了文字或报错）'
            : '页面没有任何生成迹象，可能消息没发出去'
        };
      }
      await sleep(2500);
    }
    return { ok: false, err: '等待超时', secs: Math.round((Date.now() - t0) / 1000) };
  }

  /**
   * 视频结果的统一清单：
   * - 有的场景是真 <video>（视频生成面板里）
   * - 对话里成片是「封面图 + 点击播放」，DOM 里没有 <video>，只有 img.cover-*
   * 两种都算结果，封面图记为 kind:'cover'（点开才拿得到 mp4 地址）
   */
  _videoItems(p) {
    const out = [];
    (p.videos || []).forEach(v => { if (v.w > 120 || v.vw > 0) out.push({ ...v, kind: 'video' }); });
    (p.covers || []).forEach(c => { if (c.nw >= 300) out.push({ ...c, kind: 'cover', dur: 0, vw: 0 }); });
    return out;
  }

  /** 点开视频封面 → 右侧播放器加载出真实 mp4 → 读地址，再关掉播放器 */
  async openVideoSource(item, { waitMs = 24000 } = {}) {
    const click = async () => {
      // 先把封面滚进视口：成片卡片是懒渲染的，不滚进来坐标就是屏外的
      const f = await this.js('(window.__DB && __DB.focusCover) ? __DB.focusCover() : null').catch(() => null);
      await sleep(700);
      const c = await this.js('(window.__DB ? __DB.videoCover() : null)').catch(() => null);
      const usable = (x) => x && x.x && x.y > 30 && x.y < 900 && x.w > 40;
      const t = usable(c) ? c : (usable(f) ? f : item);
      if (!t || !t.x) return false;
      await this.clickAt(t.x, t.y);
      return true;
    };

    let v = (await this.js('(window.__DB ? __DB.playerVideo() : [])').catch(() => [])) || [];

    // 最多点三次：第一次可能只点灭了封面遮罩，第二次把播放器点出来，
    // 第三次处理「卡片还没滚进视口就被点」的情况
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!v.length || !v[0].src) await click();
      const t0 = Date.now();
      while (Date.now() - t0 < Math.round(waitMs / 3)) {
        v = (await this.js('(window.__DB ? __DB.playerVideo() : [])').catch(() => [])) || [];
        const hit = (v || []).find(x => x.src && /^https?:/i.test(x.src));
        if (hit) {
          const got = { src: hit.src, dur: hit.dur || 0, vw: hit.vw || 0 };
          await this.closePlayer();
          return got;
        }
        await sleep(700);
      }
      this.log(`点开视频卡片后播放器还没加载出来（第 ${attempt + 1} 次），再试一次`);
      await sleep(1200);
    }
    return null;
  }

  async closePlayer() {
    try {
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(80);
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(500);
    } catch (e) {}
    const left = await this.js('(window.__DB ? __DB.playerVideo() : [])').catch(() => []);
    // 只关心「大播放器」：对话里的成片小卡片（宽 200 左右）不算播放器
    const big = (left || []).filter(v => (v.w || 0) >= 300);
    if (big.length) {
      // 还有播放器：点右上角关闭
      const hit = await this.clickAny(['关闭'], { exact: false }).catch(() => null);
      if (!hit) this.log('视频播放器可能还开着，不影响后续（可手动关掉）');
      await sleep(600);
    }
    return true;
  }

  /** 点击结果卡片上的下载按钮（取离目标最近的） */
  async clickDownload(anchorRect) {
    // 只用「消息卡片里」的下载入口。找不到就返回 null 交给直连抓取，
    // 绝不再退回全页搜「下载」——那会点到顶部「下载豆包客户端」条幅，下回来一个 exe。
    //
    // 关键：豆包视频卡片上的工具条（下载/收藏…）是 hover 才出现的，
    // 不先把鼠标移到卡片上，永远扫不到下载入口（以前就是这样卡在「下载失败」）。
    const hover = async (x, y) => {
      try {
        await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', clickCount: 0 });
      } catch (e) {
        try { this.wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }); } catch (e2) {}
      }
    };
    if (anchorRect && anchorRect.x && anchorRect.y) {
      await hover(anchorRect.x, anchorRect.y);
      await sleep(600);
    }
    const scan = async () => {
      let c = [];
      try { c = await this.js('(window.__DB && __DB.downloadInMessage) ? __DB.downloadInMessage() : []'); } catch (e) {}
      return c || [];
    };
    let cands = await scan();
    // 中心没反应就再试卡片的右上/右下两个角（工具条常驻在这两个位置）
    if (!cands.length && anchorRect && anchorRect.x && anchorRect.y && anchorRect.w && anchorRect.h) {
      const halfW = anchorRect.w / 2, halfH = anchorRect.h / 2;
      const spots = [
        [anchorRect.x + halfW - 24, anchorRect.y - halfH + 22],
        [anchorRect.x + halfW - 24, anchorRect.y + halfH - 22],
        [anchorRect.x - halfW + 24, anchorRect.y + halfH - 22]
      ];
      for (const [sx, sy] of spots) {
        if (sy < 120) continue;                       // 别去顶部条幅区
        await hover(sx, sy);
        await sleep(450);
        cands = await scan();
        if (cands.length) break;
      }
    }
    if (!cands || !cands.length) return null;
    let best = cands[0], bestD = Infinity;
    if (anchorRect) {
      for (const d of cands) {
        const dist = Math.hypot(d.x - anchorRect.x, d.y - anchorRect.y);
        if (dist < bestD) { bestD = dist; best = d; }
      }
    }
    // 最后一道闸：坐标落在页面顶部条幅区直接放弃
    if (best.y < 110) { this.log('下载入口在顶部条幅区，已跳过（' + best.y + '）'); return null; }
    this.log(`点下载入口 (${best.x},${best.y}) ${best.aria || best.cls || ''}`.trim());
    await this.clickAt(best.x, best.y);
    return best;
  }
}

module.exports = { Driver, DEFAULT_ANCHORS };
