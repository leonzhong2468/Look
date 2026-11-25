// 页面内代理：注入到豆包页面，提供查找/探测/输入能力
// v14：新增 lastAiText()（取豆包最后一条回复的原文，保留换行，供「AI 代写提示词」读取）
(() => {
  if (window.__DB && window.__DB.v === 11) return;

  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const vis = e => {
    if (!e || !e.getBoundingClientRect) return false;
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < -400 || r.top > innerHeight + 800) return false;
    const st = getComputedStyle(e);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) return false;
    return true;
  };
  const area = e => { const r = e.getBoundingClientRect(); return r.width * r.height; };
  const rectInfo = e => {
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const ownText = e => {
    let s = '';
    for (const n of e.childNodes) if (n.nodeType === 3) s += n.textContent;
    return norm(s);
  };

  // 可编辑区候选：可见 + 可点 + 够大（排除侧栏搜索框、隐藏副本）
  function editors() {
    return [...document.querySelectorAll('div[contenteditable="true"], [contenteditable="plaintext-only"], textarea')]
      .filter(e => {
        if (!vis(e)) return false;
        if (getComputedStyle(e).pointerEvents === 'none') return false;
        const r = e.getBoundingClientRect();
        if (r.width < 220) return false;
        // 排除左侧栏（x 很小的）
        if (r.x + r.width / 2 < 300) return false;
        return true;
      })
      .sort((a, b) => area(b) - area(a));
  }

  const DB = {
    v: 14,
    norm,

    rects(text, opts) {
      opts = opts || {};
      const want = norm(text);
      if (!want) return [];
      const exact = opts.exact !== false;
      const max = opts.max || 10;
      const pool = document.querySelectorAll(opts.sel || 'button,[role=button],div,span,a,li,label,p');
      const found = [];
      for (const e of pool) {
        if (!vis(e)) continue;
        const own = ownText(e);
        const full = norm(e.innerText);
        const aria = norm(e.getAttribute('aria-label') || e.getAttribute('title') || '');
        const ok = exact
          ? (own === want || full === want || aria === want)
          : (own.includes(want) || full.includes(want) || aria.includes(want));
        if (!ok) continue;
        found.push({ el: e, ...rectInfo(e), a: area(e), tag: e.tagName, cls: String(e.className || '').slice(0, 60) });
      }
      found.sort((a, b) => a.a - b.a);
      return found.slice(0, max).map(({ el, ...rest }) => rest);
    },

    clickables() {
      const out = [];
      const seen = new Set();
      document.querySelectorAll('button,[role=button],a,li,[class*=item],[class*=chip]').forEach(e => {
        if (!vis(e)) return;
        const t = norm(e.innerText);
        if (!t || t.length > 24 || seen.has(t)) return;
        seen.add(t);
        out.push({ t, ...rectInfo(e) });
      });
      return out.slice(0, 120);
    },

    composer() {
      const c = editors();
      if (!c.length) return null;
      const e = c[0];
      return { ...rectInfo(e), tag: e.tagName, cls: String(e.className || '').slice(0, 80) };
    },

    // 输入区是否真的拿到了焦点
    isEditorFocused() {
      const c = editors();
      if (!c.length) return false;
      const e = c[0];
      const a = document.activeElement;
      return a === e || (e.contains && e.contains(a));
    },

    focusComposer() {
      const c = editors();
      if (!c.length) return false;
      const e = c[0];
      e.focus();
      try {
        const sel = window.getSelection();
        const r = document.createRange();
        r.selectNodeContents(e); r.collapse(false);
        sel.removeAllRanges(); sel.addRange(r);
      } catch (err) {}
      return true;
    },

    editorText() {
      const c = editors();
      if (!c.length) return '';
      const e = c[0];
      return e.tagName === 'TEXTAREA' ? (e.value || '') : (e.innerText || '');
    },

    // 兜底写入：execCommand 走浏览器原生输入链路，ProseMirror 能收到
    execInsert(text) {
      const c = editors();
      if (!c.length) return false;
      const e = c[0];
      e.focus();
      try {
        if (e.tagName === 'TEXTAREA') { e.value = text; e.dispatchEvent(new Event('input', { bubbles: true })); return true; }
        return document.execCommand('insertText', false, text);
      } catch (err) { return false; }
    },

    // 按 aria-label / 文本找按钮的真实中心点
    clickableByAria(names) {
      const want = names || [];
      const pool = [...document.querySelectorAll('button,[role=button],div[role=button],[aria-label]')];
      for (const w of want) {
        for (const e of pool) {
          if (!vis(e)) continue;
          const aria = norm(e.getAttribute('aria-label') || '');
          const txt = norm(e.innerText);
          if (aria === w || txt === w) return { ...rectInfo(e), tag: e.tagName, aria, disabled: !!e.disabled };
        }
      }
      return null;
    },

    // 输入区里已挂上的图片缩略图（上传成功的证据）
    thumbSrcs() {
      const c = editors();
      const cy = c.length ? c[0].getBoundingClientRect().y : innerHeight - 60;
      const out = [];
      document.querySelectorAll('img').forEach(e => {
        const src = e.currentSrc || e.src || '';
        if (!/^(blob:|data:image\/|https?:)/.test(src)) return;
        const r = e.getBoundingClientRect();
        if (r.width < 24 || r.height < 24) return;
        if (r.width > 120) return; // 结果大图不算
        if (r.y < cy - 320 || r.y > cy + 80) return;
        out.push(src.slice(0, 80));
      });
      return out;
    },

    // 输入区里的缩略图（上传成功的证据）
    inputThumbs() {
      const c = editors();
      const cy = c.length ? c[0].getBoundingClientRect().y : innerHeight - 60;
      const out = [];
      document.querySelectorAll('img').forEach(e => {
        const src = e.currentSrc || e.src || '';
        if (!/^(blob:|data:image\/|https?:)/.test(src)) return;
        const r = e.getBoundingClientRect();
        if (r.width < 24 || r.height < 24) return;
        if (r.width > 120) return; // 结果大图不算缩略图
        if (r.y < cy - 320 || r.y > cy + 80) return;
        out.push({ src: src.slice(0, 40), w: Math.round(r.width), y: Math.round(r.y) });
      });
      return out;
    },

    // 当前是否处于「图像生成 / 视频生成」技能模式
    // 只认输入框占位符和模型芯片，不能用「页面出现图像生成四个字」来判断（工具栏里永远有）
    modeInfo() {
      const ph = [...document.querySelectorAll('[data-placeholder]')]
        .map(e => e.getAttribute('data-placeholder') || '')
        .filter(Boolean);
      const txt = norm(document.body.innerText);
      const hasImgModel = /Seedream\s*[\d.]/i.test(txt);
      const hasVidModel = /Seedance\s*[\d.]/i.test(txt);
      return {
        placeholders: ph,
        image: ph.some(p => /描述你想要的图片/.test(p)) || hasImgModel,
        video: ph.some(p => /描述你想要的视频/.test(p)) || hasVidModel,
        models: { seedream: hasImgModel, seedance: hasVidModel },
        busy: this.busy()
      };
    },

    fileInputs() {
      return [...document.querySelectorAll('input[type=file]')].map((e, i) => {
        const r = e.getBoundingClientRect();
        return { i, accept: e.accept, multiple: e.multiple, hidden: r.width < 2 || r.height < 2, x: Math.round(r.x), y: Math.round(r.y) };
      });
    },

    // 广告/推广弹窗：找到弹层本体，再在其中定位「× / 下次再说 / 暂不」等关闭入口，返回坐标。
    // 豆包常弹「下载电脑版 使用完整功能」这类推广框，会把输入框盖住导致任务失败。
    popupClose() {
      const PROMO_RE = /(下载电脑版|使用完整功能|下载桌面版|桌面客户端|电脑版|立即下载|去下载|体验完整功能|每日签到|签到.{0,8}(免费|额度)|免费.{0,8}(用|领)|领取额度)/;
      // 只有「浮在页面上的遮罩层」才算弹窗（fixed/absolute + 高 z-index，或 dialog 语义），
      // 避免把正文里恰好提到「下载」的普通消息当成弹窗乱点。
      const isOverlay = (d) => {
        let cur = d;
        for (let i = 0; i < 6 && cur; i++) {
          if (cur.getAttribute && (cur.getAttribute('role') === 'dialog' || cur.getAttribute('aria-modal') === 'true')) return true;
          const cs = getComputedStyle(cur);
          if ((cs.position === 'fixed' || cs.position === 'absolute') && Number(cs.zIndex || 0) > 50) return true;
          if (/modal|dialog|mask|popup|overlay/i.test(String(cur.className || ''))) return true;
          cur = cur.parentElement;
        }
        return false;
      };
      const CLOSE_RE = /^(×|✕|⨯|x|X|关闭|下次再说|下次提醒我|暂不|暂不需要|以后再说|我知道了|不再提示|跳过)$/;
      // 1) 找含推广文案的最小弹层容器
      let host = null, hostArea = Infinity;
      document.querySelectorAll('[role=dialog], [aria-modal=true], div, section').forEach(d => {
        const st = getComputedStyle(d);
        if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0) return;
        const r = d.getBoundingClientRect();
        if (r.width < 260 || r.height < 140) return;
        if (!PROMO_RE.test((d.innerText || '').slice(0, 500))) return;
        if (!isOverlay(d)) return;
        const area = r.width * r.height;
        if (area < hostArea) { host = d; hostArea = area; }
      });
      if (!host) return null;
      const cands = [...host.querySelectorAll('button, [role=button], [aria-label], [title], span, div, svg, img')];
      // 2) 容器内找带关闭语义的元素（认文字/aria-label/title）
      for (const e of cands) {
        const label = (e.getAttribute && (e.getAttribute('aria-label') || e.getAttribute('title'))) || e.textContent || '';
        if (!label || label.length > 10 || !CLOSE_RE.test(label.trim())) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      // 3) 兜底：弹层右上角 60px 范围内点一个可见元素（× 常是无文字的图标）
      const hr = host.getBoundingClientRect();
      for (const e of cands) {
        const r = e.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        if (r.right > hr.right - 70 && r.top < hr.top + 70 && r.bottom > hr.top) {
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
      }
      return null;
    },

    // 输入框锚点：给「挑离输入框最近的文件 input」用，避免把文件塞进头像上传之类的无关 input
    composerPoint() {
      const c = editors();
      if (c.length) {
        const r = c[0].getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height) };
      }
      return { x: Math.round(innerWidth / 2), y: Math.round(innerHeight - 60) };
    },

    // 新版豆包首页：input[type=file] 平时不存在，要点输入框旁的「+ / 上传图片」才临时创建。
    // 这里找出输入框附近所有可点击的上传入口（图标按钮没有文字，所以连 aria-label/title 一起认）。
    uploadEntries() {
      const out = [];
      const c = editors();
      const cy = c.length ? c[0].getBoundingClientRect().y : innerHeight - 120;
      const seen = new Set();
      document.querySelectorAll('button, [role=button], [aria-label], [title], span, div').forEach(e => {
        if (out.length >= 10) return;
        const r = e.getBoundingClientRect();
        if (r.width < 10 || r.height < 10 || r.width > 140 || r.height > 140) return;
        if (r.y < cy - 300 || r.y > cy + 140) return;
        const txt = String(e.innerText || e.textContent || '').trim();
        const aria = String(e.getAttribute && (e.getAttribute('aria-label') || e.getAttribute('title')) || '').trim();
        const hit = /^(上传图片|上传文件|上传|添加图片|添加附件|\+|＋)$/.test(txt)
          || /上传图片|上传文件|添加图片|添加附件|上传/.test(aria);
        if (!hit) return;
        const key = Math.round(r.x) + ':' + Math.round(r.y);
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), t: (txt || aria).slice(0, 16) });
      });
      return out;
    },

    uploadViaDataTransfer(b64, name, mime) {
      const inputs = [...document.querySelectorAll('input[type=file]')];
      if (!inputs.length) return { ok: false, err: 'no-file-input' };
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], name, { type: mime || 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = inputs.find(e => (e.accept || '').includes('image')) || inputs[0];
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, count: input.files.length, accept: input.accept };
    },

    bodyText(n) { return norm(document.body.innerText).slice(0, n || 400); },
    bodyRaw(n) { return document.body.innerText.slice(0, n || 4000); },
    hasText(t) { return norm(document.body.innerText).includes(norm(t)); },

    busy() {
      const words = ['生成中', '正在生成', '正在生成图片', '正在生成视频', '停止生成', '停止回答',
        '正在思考', '上传中', '正在上传', '排队中', '生成图片中'];
      const txt = norm(document.body.innerText);
      const out = words.filter(w => txt.includes(w));
      // 更稳的信号：页面上出现「停止生成」按钮
      const stop = [...document.querySelectorAll('[aria-label],button')]
        .some(e => vis(e) && /停止/.test(e.getAttribute('aria-label') || e.innerText || ''));
      if (stop) out.push('停止按钮');
      return out;
    },

    // 探测生成结果（按自然尺寸判断，避免缩放后的卡片被漏掉）
    probe() {
      const comp = this.composer();
      const compBottom = comp ? comp.y : innerHeight;
      const images = [];
      const covers = [];
      // 只认「豆包发来的消息」里的图：这样既排除输入区缩略图，也排除我们自己发出去的原图
      const recvCount = document.querySelectorAll('[data-testid="receive_message"]').length;
      document.querySelectorAll('img').forEach((e, i) => {
        const nw = e.naturalWidth || 0, nh = e.naturalHeight || 0;
        if (nw < 400 || nh < 400) return;
        const r = e.getBoundingClientRect();
        if (r.width < 40) return;
        if (!vis(e)) return;
        const src = e.currentSrc || e.src || '';
        if (/^data:image\/svg/i.test(src)) return; // 占位 SVG 不算
        if (recvCount > 0) {
          if (!e.closest('[data-testid="receive_message"]')) return;
        } else if (r.y < compBottom - 80 && r.y + r.height > compBottom - 80) {
          return; // 老页面没有收发标记时，退回按位置过滤输入区
        }
        // 视频结果的封面图（class 带 cover-）：chat 里成片就是这样呈现的，不是 <video>
        const cls = typeof e.className === 'string' ? e.className : '';
        const item = { i, src, nw, nh, w: Math.round(r.width), h: Math.round(r.height), ...rectInfo(e) };
        if (/cover-/i.test(cls)) { covers.push(item); return; }
        images.push(item);
      });
      const videos = [];
      document.querySelectorAll('video').forEach((e, i) => {
        if (!vis(e)) return;
        const vw = e.videoWidth || 0;
        videos.push({ i, src: e.currentSrc || e.src || '', dur: e.duration || 0, vw, w: Math.round(e.getBoundingClientRect().width), ready: e.readyState, ...rectInfo(e) });
      });
      // 下载入口只在结果卡片里找，别被顶部「下载豆包客户端」条幅骗走
      const dl = this.downloadInMessage();
      return { images, covers, videos, download: dl, busy: this.busy(), compBottom, editorLen: this.editorText().length };
    },

    /**
     * 只在「豆包发来的消息卡片」里找下载入口，并且必须通过客户端条幅过滤。
     * 全页搜「下载」会命中顶部的「下载豆包客户端」条幅——点下去会下一个 7MB 的 exe。
     * v9：找不到就返回空数组（让上层改走直连抓取），绝不退回全页乱点。
     */
    downloadInMessage() {
      const out = [];
      const seen = new Set();
      // 这些词说明是「下载豆包客户端 / App / 安装包」，不是内容下载
      const bad = /豆包|客户端|电脑版|桌面版|安装|下载安装|app|windows|mac|安卓|ios|手机|exe|电脑/i;
      // 顶部/侧栏区域（条幅常驻在这里），不在这些范围内点
      const headerLimit = Math.max(110, innerHeight * 0.12);
      const ok = (e) => {
        if (!e || seen.has(e)) return false;
        if (!vis(e)) return false;
        const r = e.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return false;
        if (r.width > 420 || r.height > 160) return false;      // 大块容器不要
        if (r.y + r.height / 2 < headerLimit) return false;      // 顶部条幅区
        if (r.x < 310) return false;                            // 左侧栏
        const t = norm(ownText(e) + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || ''));
        if (bad.test(t)) return false;
        return true;
      };
      const push = (e) => {
        if (!ok(e)) return;
        seen.add(e);
        out.push({
          ...rectInfo(e), a: area(e),
          aria: norm(e.getAttribute('aria-label') || e.getAttribute('title') || ''),
          cls: String(e.className || '').slice(0, 50)
        });
      };
      const scan = (root) => {
        if (!root) return;
        root.querySelectorAll('button,[role=button],a,div,span,i,svg').forEach(e => {
          const own = ownText(e);
          const aria = norm(e.getAttribute('aria-label') || e.getAttribute('title') || '');
          if (!/下载|保存|download/i.test(own + ' ' + aria)) return;
          // 自身或任一祖先带客户端文案，一律排除
          let p = e, guard = 0;
          while (p && guard++ < 6) {
            const own2 = norm(ownText(p) + ' ' + (p.getAttribute && p.getAttribute('aria-label') || ''));
            if (bad.test(own2)) return;
            p = p.parentElement;
          }
          push(e);
        });
      };
      const msgs = [...document.querySelectorAll('[data-testid="receive_message"]')];
      if (msgs.length) {
        scan(msgs[msgs.length - 1]);       // 优先最后一条消息（最新结果）
        if (!out.length) msgs.forEach(scan);
      }
      // 播放器工具栏里的下载（点开成片后出现）：限制在页面下半部
      if (!out.length) {
        document.querySelectorAll('video').forEach(v => {
          const box = v.closest('div');
          if (box) scan(box.parentElement || box);
        });
      }
      out.sort((a, b) => a.a - b.a);
      return out.slice(0, 6);
    },

    /** 最新一个视频封面卡片的坐标（点它才会加载真实 mp4） */
    videoCover() {
      const p = this.probe();
      return (p.covers || []).slice(-1)[0] || null;
    },

    /**
     * 把最新的视频封面滚进视口再返回它的坐标。
     * 成片卡片是懒渲染的：不滚进视口里，坐标要么在屏幕外、要么根本没渲染，
     * 点下去自然什么都不会发生（以前就卡在「点开视频卡片后播放器还没加载出来」）。
     */
    focusCover() {
      const pick = () => [...document.querySelectorAll('img')]
        .filter(e => /cover-/i.test(String(e.className || '')) && e.closest('[data-testid="receive_message"]'))
        .slice(-1)[0] || null;
      let el = pick();
      if (!el) { this.scrollBottom(true); el = pick(); }
      if (!el) return null;
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      const r = el.getBoundingClientRect();
      return {
        ...rectInfo(el), w: Math.round(r.width), h: Math.round(r.height),
        src: el.currentSrc || el.src || '',
        inView: r.top >= 0 && r.bottom <= innerHeight && r.width > 40
      };
    },

    // 播放器里的视频（点开封面后右侧出现）
    playerVideo() {
      const out = [];
      document.querySelectorAll('video').forEach(e => {
        const vw = e.videoWidth || 0;
        const w = Math.round(e.getBoundingClientRect().width);
        if (vw > 0 && w >= 180) out.push({ src: e.currentSrc || e.src || '', dur: e.duration || 0, vw, w });
      });
      return out;
    },

    lastImages() {
      const p = this.probe();
      return p.images.slice(-3);
    },

    // 结果图是懒加载的：不在视口里就一直是占位 SVG。只滚它，不滚整页
    pendingResults() {
      const out = [];
      document.querySelectorAll('img').forEach(e => {
        const src = e.currentSrc || e.src || '';
        if (!/^data:image\/svg/i.test(src)) return;
        const r = e.getBoundingClientRect();
        if (r.width < 120 || r.height < 120) return;
        out.push({ y: Math.round(r.y), w: Math.round(r.width) });
      });
      return out;
    },

    revealPending() {
      const els = [...document.querySelectorAll('img')].filter(e => {
        const src = e.currentSrc || e.src || '';
        if (!/^data:image\/svg/i.test(src)) return false;
        const r = e.getBoundingClientRect();
        return r.width >= 120 && r.height >= 120;
      });
      if (!els.length) return 0;
      // 只把最后一个（最新结果）滚进视口，触发真实加载
      const el = els[els.length - 1];
      try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) { el.scrollIntoView(); }
      return els.length;
    },

    textLen() { return norm(document.body.innerText).length; },

    // 视频面板上的档位芯片，例如「自动 · 10s」「9:16」「1080p」
    videoChips() {
      const out = [];
      const seen = new Set();
      [...document.querySelectorAll('div,span,button')].forEach(e => {
        const t = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 26) return;
        const hit = /^自动/.test(t) || /\d+\s*s$/i.test(t) || /^(9:16|16:9|1:1|3:4|4:3)$/.test(t) || /^\d{3,4}p$/i.test(t);
        if (!hit) return;
        const r = e.getBoundingClientRect();
        if (r.width < 20 || r.height < 10) return;
        const key = t + '@' + Math.round(r.x);
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ t, ...rectInfo(e) });
      });
      return out;
    },

    // 豆包会先出分镜再问「确认后我再开始生成视频」，这里识别这种追问
    lastReply() { return norm(document.body.innerText).slice(-900); },

    /**
     * 豆包最后一条回复的**原文**（保留换行）。
     * 「AI 代写提示词」要把这段文本原样拿回来再发给它生成视频，
     * 压成一行会毁掉分镜结构，所以这里不能走 norm。
     */
    lastAiText() {
      const els = [...document.querySelectorAll('[data-testid="receive_message"]')];
      const el = els[els.length - 1];
      if (!el) return '';
      const JUNK = /^(复制|重新生成|点赞|点踩|分享|引用|编辑|朗读|收起|展开|更多)$/;
      const pick = (root) => {
        const blocks = [...root.querySelectorAll('[data-testid="message_text_content"]')];
        const arr = blocks.length ? blocks : [root];
        const parts = [];
        arr.forEach(b => {
          let s = String(b.innerText || '').replace(/\r/g, '');
          s = s.split('\n').filter(line => !JUNK.test(line.trim())).join('\n').trim();
          if (s) parts.push(s);
        });
        return parts.join('\n\n').trim();
      };
      let txt = pick(el);
      // 正文块还没渲染出来（流式输出中）就退回整条消息，但会带按钮文字，交给上层清洗
      if (!txt) txt = String(el.innerText || '').replace(/\r/g, '').trim();
      return txt.slice(0, 8000);
    },

    // 对话里的消息块（用户/助手都算），按 DOM 顺序排列
    msgList() {
      const els = [...document.querySelectorAll('[data-testid="message_text_content"]')];
      const out = [];
      els.forEach((e, i) => {
        const t = norm(e.innerText || '').replace(/\s+/g, ' ').trim();
        if (t) out.push({ i, t });
      });
      return out;
    },

    // 最后一条真实消息（避开整页 innerText 会把输入框草稿也算进去的问题）
    lastMsg() {
      const l = this.msgList();
      return l.length ? l[l.length - 1] : { i: -1, t: this.lastReply().replace(/\s+/g, ' ').trim() };
    },

    // 记录「我们自己代答过的话」，避免把自己的回复当成豆包在追问，导致无限自动应答
    said: [],
    markSaid(text) {
      const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!t) return this.said.length;
      if (!this.said.includes(t)) this.said.push(t);
      if (this.said.length > 12) this.said.shift();
      return this.said.length;
    },

    // 豆包已明确「接单」：「我将为你生成…，预计等待 10 分钟，生成好后我会发给你」
    // 这种状态下页面没有「生成中」标志，但确实在排队出片，不能当成卡住
    promised() {
      const t = (this.lastMsg() || {}).t || '';
      if (!t) return false;
      if ((this.said || []).some(s => s && (t === s || t.startsWith(s.slice(0, 14))))) return false;
      return /将为你生成|为你生成一条|预计等待|生成好后|正在生成|马上为你生成|正在排队|排队中|正在制作/.test(t);
    },

    // 已经答过的追问：同一句话 3 分钟内不再重复答（我们的回复可能因为页面忙而没发出去）
    answered: { t: '', at: 0 },
    markAnswered(q) {
      this.answered = { t: String(q || '').replace(/\s+/g, ' ').trim().slice(0, 80), at: Date.now() };
    },

    // 豆包已经说了「生成好了」：卡片就在这条消息下面，可能还没进视口而没渲染
    hasDoneClaim() {
      const t = (this.lastMsg() || {}).t || '';
      return /生成好了|已生成|已经生成|成片已|做好了/.test(t);
    },

    /** 把最后一条豆包消息滚进视口（只在它不在视口里时滚，不打扰用户翻看） */
    revealLastMsg() {
      const els = [...document.querySelectorAll('[data-testid="receive_message"]')];
      const el = els[els.length - 1];
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      if (r.top >= 0 && r.bottom <= innerHeight - 4) return 0;
      try { el.scrollIntoView({ block: 'end', behavior: 'instant' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
      return 1;
    },

    // 最后一条消息是不是我们自己发的（豆包还没回）
    lastIsMine() {
      const t = (this.lastMsg() || {}).t || '';
      if (!t) return false;
      return (this.said || []).some(s => s && t.startsWith(s.slice(0, 14)));
    },

    // 今日免费额度用完：豆包会给「今日视频生成免费额度已用完，开通订阅」这类提示
    // 只看最后一条消息，避免把历史记录里的旧提示当成现在没额度
    quotaExhausted() {
      const t = (this.lastMsg() || {}).t || '';
      if (!t) return false;
      return /额度已用完|免费额度已用完|次数已用完|今日.{0,10}额度.{0,8}(用完|不足)|已达.{0,6}上限|开通订阅畅享/.test(t);
    },

    /**
     * 首次登录 / 风控会弹图像验证（滑块、点选图块）。遮罩一挡，输入框点不进去、
     * 发送也发不出去，表现就是「已提交但页面毫无反应」。
     * 这里只认「弹层形态」的验证，避免把登录页的「获取验证码」误判。
     */
    verifyBlock() {
      const pats = /图像验证|图片验证|安全验证|人机验证|请完成验证|完成验证|拖动滑块|滑动验证|点击(符合|图中)|按顺序点击|请依次点击|验证码/;
      const overlayOf = e => {
        let cur = e;
        for (let i = 0; i < 6 && cur; i++) {
          if (cur.getAttribute && (cur.getAttribute('role') === 'dialog' || cur.getAttribute('aria-modal') === 'true')) return true;
          const cs = getComputedStyle(cur);
          if ((cs.position === 'fixed' || cs.position === 'absolute') && Number(cs.zIndex || 0) > 50) return true;
          if (/modal|dialog|mask|popup|overlay|verify|captcha/i.test(String(cur.className || ''))) return true;
          cur = cur.parentElement;
        }
        return false;
      };

      const hits = [];
      // 1) 明确的验证容器（iframe / class / id 命中）
      document.querySelectorAll(
        'iframe[src*="captcha"], iframe[src*="verify"], [class*="captcha"], [id*="captcha"], [class*="slide-verify"], [class*="slideVerify"], [class*="verify-box"], [class*="verifyBox"]'
      ).forEach(e => {
        if (!vis(e) || area(e) < 4000) return;
        hits.push(e);
      });

      // 2) 带验证文案的弹层
      if (!hits.length) {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const t = norm(n.nodeValue);
          if (!t || t.length > 30 || !pats.test(t)) continue;
          let box = n.parentElement;
          for (let i = 0; i < 5 && box; i++) {
            const r = box.getBoundingClientRect();
            if (r.width > 240 && r.height > 100 && vis(box) && overlayOf(box)) { hits.push(box); break; }
            box = box.parentElement;
          }
          if (hits.length) break;
        }
      }

      const on = hits.length > 0;
      return {
        on,
        n: hits.length,
        sample: on ? norm(hits[0].innerText || hits[0].className || '').slice(0, 50) : ''
      };
    },

    // 版权/授权确认卡上的「确认生成」按钮：这种追问必须点按钮，只回文字豆包不认。
    // 只认最后一条豆包消息里的按钮，避免误点页面其他地方的「确认」。
    confirmButton() {
      const cards = [...document.querySelectorAll('[data-testid=receive_message]')];
      if (!cards.length) return null;
      const card = cards[cards.length - 1];
      const t = norm(card.innerText || '');
      if (!/(确认生成|确认后.{0,8}(开始)?生成|请确认|授权|是否.{0,12}(生成|使用))/.test(t)) return null;
      const RE = /^(确认生成|同意并生成|同意并继续|确认，生成|开始生成|同意|确认|我已阅读并同意)$/;
      const btns = [...card.querySelectorAll('button, [role=button], span[class*=button], div[class*=button], a')];
      for (const b of btns) {
        const label = norm(b.innerText || (b.getAttribute && (b.getAttribute('aria-label') || b.getAttribute('title'))) || '');
        if (!label || label.length > 12 || !RE.test(label)) continue;
        const r = b.getBoundingClientRect();
        if (r.width < 30 || r.height < 16) continue;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      return null;
    },

    needsConfirm() {
      const m = this.lastMsg();
      const t = m.t || '';
      if (!t) return false;
      if (this.answered && this.answered.t && t.slice(0, 80) === this.answered.t
        && Date.now() - this.answered.at < 180000) return false;
      // 最后一条如果是我们自己刚说的，那不算豆包在追问
      if ((this.said || []).some(s => s && (t === s || t.startsWith(s.slice(0, 14))))) return false;
      if (/不用确认|不要再.{0,4}确认|无需确认/.test(t)) return false;
      const pats = [
        /确认后.{0,6}(再)?(开始)?生成/,
        /(要|需要)我(现在|就)?(开始)?生成/,
        /是否(要|需要|现在).{0,14}(生成|改用|切换|更换)/,
        /是否(改用|切换|更换)/,
        /(改用|切换为|换成).{0,16}模型/,
        /请(先)?确认/,
        /确认(一下|后).{0,12}(开始|生成)/
      ];
      return pats.some(p => p.test(t));
    },

    /**
     * 豆包遇到「seedance_2.5 不可用」时会列一排可执行模型，让用户回数字：
     *   「当前无法使用 seedance_2.5，请选择一个可执行模型继续：
     *     1. seedance_2.0_mini：支持 4-15 秒…
     *     2. seedance_2.0_fast：支持 4-15 秒…
     *     请直接回复 1 或 2」
     * 以前没人回，流程就干等到超时（用户还得手动打「1」）。
     */
    modelPrompt() {
      const m = this.lastMsg();
      const raw = norm(m && m.t || '');
      if (!raw) return { on: false, options: [] };
      if (!/无法使用|不可用|暂不支持|不支持.{0,10}模型|可执行模型|选择.{0,6}模型|换.{0,4}模型/i.test(raw)) {
        return { on: false, options: [] };
      }
      const options = [];
      const re = /(?:^|[\n\s])\s*([1-9])\s*[.、)．:：]\s*([A-Za-z][\w.\-]{2,40})/g;
      let mm;
      while ((mm = re.exec(raw))) {
        const n = Number(mm[1]);
        const id = mm[2].replace(/\s+/g, '');
        if (options.some(o => o.n === n)) continue;
        // 抓同一行里「支持 4-15 秒」这类时长信息
        const line = raw.slice(mm.index, mm.index + 120);
        const dm = line.match(/(\d+)\s*[-~到]\s*(\d+)\s*秒/);
        options.push({ n, id, maxSec: dm ? Number(dm[2]) : 0 });
      }
      return { on: options.length > 0, options, raw: raw.slice(0, 240) };
    },

    // 只滚动「已经接近底部」的容器，避免打断用户手动翻看
    scrollBottom(force) {
      const sc = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 200 && vis(e));
      let moved = 0;
      sc.forEach(e => {
        const nearBottom = e.scrollHeight - e.scrollTop - e.clientHeight < 160;
        if (force || nearBottom) { e.scrollTop = e.scrollHeight; moved++; }
      });
      if (force) window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
      return moved;
    },

    imgB64(src) {
      const img = [...document.querySelectorAll('img')].find(e => (e.currentSrc || e.src) === src);
      if (!img || !img.naturalWidth) return null;
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        return c.toDataURL('image/png').split(',')[1];
      } catch (e) { return null; }
    },

    needsLogin() {
      const txt = norm(document.body.innerText);
      if (txt.includes('使用豆包或飞书账号登录')) return true;
      const loginBtn = [...document.querySelectorAll('button,[role=button]')].some(e => vis(e) && norm(e.innerText) === '登录');
      const qr = [...document.querySelectorAll('canvas,img')].some(e => vis(e) && (e.getAttribute('aria-label') || '').includes('二维码'));
      return loginBtn || qr;
    }
  };

  window.__DB = DB;
})();
