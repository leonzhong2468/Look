// ============================================================
//  扩展层：任务存储 / IPC / 下载路由 / 界面模式 / 流水线装配
//  由 main.js 在完成自身函数定义后调用 create(deps) 装配
// ============================================================
const fs = require('fs');
const path = require('path');
const { ipcMain, shell, session, dialog, app } = require('electron');
const { pathToFileURL } = require('url');
const { Store } = require('./store');
const { Pipeline } = require('./pipeline');
const { DEFAULT_ANCHORS } = require('./driver');

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }
function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function create(deps) {
  const {
    app, USER_DIR, DOWNLOAD_DIR, log,
    loadAccounts, saveAccounts, setActiveAccount, createViewForAccount, viewPool, badges,
    pushToRenderer, getActiveId, getContentBounds,
    leaseView, releaseView, takeoverView, isLeased, getAutoId, setAutoId, ensureWorkerWin,
    leasedIds
  } = deps;

  const TASKS_DIR = path.join(USER_DIR, 'tasks');
  const store = new Store(TASKS_DIR);

  // ---------- 配置 ----------
  const CONFIG_FILE = path.join(USER_DIR, 'config.json');
  const DEFAULT_CONFIG = {
    chatUrl: 'https://www.doubao.com/chat/',
    imageMode: 'doubao',
    anchors: {},
    autoSwitchToBoard: true,
    keepBoardFront: true // 任务看板留在前台，豆包页面挪到窗口外后台执行
  };
  let config = { ...DEFAULT_CONFIG };
  try {
    ensureDir(USER_DIR);
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    config = { ...DEFAULT_CONFIG, ...raw, anchors: { ...(raw.anchors || {}) } };
  } catch (e) {
    try { ensureDir(USER_DIR); fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8'); } catch (e2) {}
  }

  // ---------- 下载等待器 ----------
  const downloadWaiters = new Map(); // accountId -> [ {dir, resolve, timer, path} ]

  function pickDownloadPath(accountId, filename) {
    const arr = downloadWaiters.get(accountId);
    if (!arr || !arr.length) return null;
    const w = arr[0];
    ensureDir(w.dir);
    let base = filename || ('dl-' + Date.now());
    let p = path.join(w.dir, base);
    let i = 1;
    while (fs.existsSync(p)) {
      const ext = path.extname(base), stem = path.basename(base, ext);
      p = path.join(w.dir, `${stem}(${i})${ext}`);
      i++;
    }
    w.path = p;
    return p;
  }

  function onDownloadDone(accountId, savePath, state) {
    const arr = downloadWaiters.get(accountId);
    if (!arr || !arr.length) return;
    const w = arr[0];
    if (state === 'completed') {
      arr.shift();
      clearTimeout(w.timer);
      w.resolve({ path: savePath });
    } else if (state === 'interrupted') {
      arr.shift();
      clearTimeout(w.timer);
      w.resolve(null);
    }
  }

  function waitDownload(accountId, dir, timeoutMs) {
    let w = null;
    const p = new Promise((resolve) => {
      w = { dir, resolve, timer: null, path: null };
      w.timer = setTimeout(() => {
        const arr = downloadWaiters.get(accountId) || [];
        const i = arr.indexOf(w);
        if (i >= 0) arr.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const arr = downloadWaiters.get(accountId) || [];
      arr.push(w);
      downloadWaiters.set(accountId, arr);
    });
    // 允许提前撤销（比如压根没点到下载按钮），避免占着队列吞掉下一次下载
    p.cancel = () => {
      try {
        clearTimeout(w.timer);
        const arr = downloadWaiters.get(accountId) || [];
        const i = arr.indexOf(w);
        if (i >= 0) arr.splice(i, 1);
        w.resolve(null);
      } catch (e) {}
    };
    return p;
  }

  /** 页面最近请求过的视频地址（播放器点不开时的兜底） */
  function recentMp4(accountId, maxAgeMs = 3 * 60 * 1000) {
    try {
      const ses = session.fromPartition('persist:' + accountId);
      const arr = (ses.__mp4 || []).filter(x => Date.now() - x.at < maxAgeMs);
      return arr.length ? arr[arr.length - 1].url : null;
    } catch (e) { return null; }
  }

  /**
   * 扫目录找「这次之后才落盘」的内容文件。
   * 用途：豆包的下载有时不经过等待器（点了下载，40 秒后才真正开始写盘，
   * 等待器已经超时退出），文件就静静躺在 downloads\账号 里 —— 这时候只能靠扫目录捡回来。
   * @param {string[]} dirs 额外目录（任务目录等）
   * @param {number} sinceMs 只认这个时间点之后修改过的文件
   * @returns {{path:string,mtime:number,size:number}[]} 按时间倒序
   */
  function findRecentDownload(accountId, dirs, sinceMs, kind) {
    const out = [];
    const isVid = kind === 'video';
    const re = isVid ? /\.(mp4|mov|webm|m4v)$/i : /\.(png|jpe?g|webp|gif)$/i;
    const min = isVid ? 200 * 1024 : 8 * 1024;
    const roots = (dirs || []).filter(Boolean);
    try { roots.push(path.join(DOWNLOAD_DIR, accountId || '_通用')); } catch (e) {}
    try { roots.push(DOWNLOAD_DIR); } catch (e) {}
    const seen = new Set();
    for (const d of roots) {
      let list = [];
      try { list = fs.readdirSync(d); } catch (e) { continue; }
      for (const f of list) {
        if (!re.test(f)) continue;
        const p = path.join(d, f);
        if (seen.has(p)) continue;
        seen.add(p);
        try {
          const st = fs.statSync(p);
          if (!st.isFile() || st.size < min) continue;
          if (st.mtimeMs < sinceMs) continue;
          out.push({ path: p, mtime: st.mtimeMs, size: st.size });
        } catch (e) {}
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  async function fetchToFile(accountId, url, outPath) {
    try {
      const ses = session.fromPartition('persist:' + accountId);
      const res = await ses.fetch(url);
      if (!res.ok) return false;
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(outPath, buf);
      return true;
    } catch (e) { log('fetchToFile 失败: ' + e.message); return false; }
  }

  // ---------- 界面模式：任务看板 / 豆包页面 ----------
  // 页面平时挂在「后台执行窗口」里跑（离屏、不抢焦点），主窗口只显示看板。
  // 只有用户主动点「显示豆包页面」时，才把那个页面挪到主窗口里来。
  let uiMode = 'tasks';
  function setUiMode(mode) {
    uiMode = (mode === 'doubao') ? 'doubao' : 'tasks';
    const win = deps.mainWindow();
    if (!win) return uiMode;
    if (uiMode === 'tasks') {
      // 先把主窗口上挂着的页面摘掉（不管是哪个号）
      deps.detachView();
      // 正在跑任务的号：页面必须回到后台窗口，不能就这么摘掉变 hidden
      const auto = getAutoId();
      if (auto && isLeased(auto)) leaseView(auto, { mode: 'worker' });
      return uiMode;
    }
    // 优先看流水线正在跑的那个号（这才是用户想看的页面）
    const id = getAutoId() || getActiveId();
    if (!id) return uiMode;
    if (isLeased(id)) {
      // 用户明确要看正在跑的页面：接管到前台，同时提醒会打断任务
      takeoverView(id);
      const acc = loadAccounts().find(a => a.id === id);
      pushToRenderer('task:toast', {
        text: '已把「' + (acc ? acc.label : '豆包') + '」页面调到前台，手动操作可能打断正在执行的任务'
      });
    } else {
      setActiveAccount(id);
    }
    return uiMode;
  }

  // ---------- 账号 ----------
  function accountsForPipeline() {
    const today = todayKey();
    return loadAccounts().map(a => ({
      ...a,
      badge: a.pending ? 'pending'
        : (a.quotaDate === today ? 'quota' : (badges.get(a.id) || 'online'))
    }));
  }

  const todayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // 记下「这个号今天的视频额度用完了」，选中账号时自动跳过它（第二天自动恢复）
  function markQuota(accountId, note) {
    const list = loadAccounts();
    const a = list.find(x => x.id === accountId);
    if (!a) return false;
    a.quotaDate = todayKey();
    a.quotaNote = note || '今日视频额度已用完';
    try { saveAccounts(list); } catch (e) {}
    pushToRenderer('accounts:changed', { id: accountId, quota: a.quotaNote });
    log(`[账号] ${a.label || accountId} 标记为今日额度用完`);
    return true;
  }

  function getRotation() {
    return Number(deps.getPrefs().rotationIndex || 0);
  }  function setRotation(n) {
    deps.getPrefs().rotationIndex = n;
    deps.savePrefs();
  }

  async function ensureView(accountId) {
    if (!viewPool.has(accountId)) {
      const acc = loadAccounts().find(a => a.id === accountId);
      if (!acc) throw new Error('账号不存在');
      viewPool.set(accountId, createViewForAccount(acc));
      await new Promise(r => setTimeout(r, 1200));
    }
    return viewPool.get(accountId);
  }

  function viewOf(accountId) { return viewPool.get(accountId); }

  // ---------- 流水线 ----------
  const pipeline = new Pipeline({
    store,
    // 平台查询：任务绑的账号属于哪个 AI 平台（豆包 / 用户自己加的）
    providerOf: (acc) => {
      try { return deps.providerOf ? deps.providerOf(acc) : null; } catch (e) { return null; }
    },
    log: (m) => log('[流水线] ' + m),
    emit: (ch, payload) => {
      pushToRenderer(ch, payload);
      if (ch === 'task:update' && payload && config.autoSwitchToBoard && uiMode === 'doubao' &&
        ['review', 'failed', 'done'].indexOf(payload.status) >= 0) {
        setUiMode('tasks');
        pushToRenderer('ui:mode', { mode: 'tasks' });
      }
    },
    accounts: accountsForPipeline,
    markQuota,
    // 任务开始：把该账号页面「租」给后台执行窗口。
    // 注意：这里不再切换主窗口的显示账号——用户在看什么就看什么，互不干扰。
    setActive: (id) => {
      setAutoId(id);
      try { leaseView(id, { mode: 'worker' }); } catch (e) { log('转入后台执行失败: ' + e.message); }
      pushToRenderer('active:changed', { id, background: true });
    },
    releaseAccount: (id) => {
      try { releaseView(id); } catch (e) {}
      pushToRenderer('active:changed', { id, background: false });
    },
    // 需要人来过验证：把正在跑的页面摆到主窗口（这是唯一会「占屏」的时机，且必须让人看到）
    showAuto: (id) => {
      const ok = takeoverView(id);
      if (ok) {
        uiMode = 'doubao';
        pushToRenderer('ui:mode', { mode: 'doubao' });
      }
      return ok;
    },
    hideAuto: () => {
      const id = getAutoId();
      if (id) {
        if (isLeased(id)) leaseView(id, { mode: 'worker' });
        else deps.detachView(id);
      }
      uiMode = 'tasks';
      pushToRenderer('ui:mode', { mode: 'tasks' });
    },
    ensureView,
    getAutoId: () => getAutoId(),
    // 关键：绝不再把主窗口 pop 到前台抢用户焦点。
    // 页面在后台执行窗口里，只要那个窗口是 shown 的，页面就一直 visible。
    ensureWindow: () => {
      try {
        const w = ensureWorkerWin();
        if (w) { try { w.webContents.setBackgroundThrottling(false); } catch (e) {} }
      } catch (e) { log('后台窗口就绪失败: ' + e.message); return false; }
      return true;
    },
    view: viewOf,
    waitDownload,
    fetchToFile,
    recentMp4,
    findRecentDownload,
    downloadDir: () => DOWNLOAD_DIR,
    config: {
      chatUrl: config.chatUrl,
      anchors: { ...DEFAULT_ANCHORS, ...(config.anchors || {}) }
    },
    getRotation,
    setRotation
  });

  function pubTask(t) {
    const { _drv, ...rest } = t;
    const dir = path.join(TASKS_DIR, 'files', t.id);
    return {
      ...rest,
      dir,
      thumb: (t.images && t.images[0])
        ? (t.images[0].processed || t.images[0].src)
        : null,
      videoUrl: t.video ? pathToFileURL(t.video).href : null,
      imageUrl: t.image ? pathToFileURL(t.image).href : null,
      outputs: (t.outputs || []).map(o => ({ ...o, url: fileUrl(o.path) })),
      promptFileUrl: t.promptFile ? pathToFileURL(t.promptFile).href : null,
      scriptFileUrl: t.scriptFile ? pathToFileURL(t.scriptFile).href : null,
      clipsFileUrl: t.clipsFile ? pathToFileURL(t.clipsFile).href : null
    };
  }

  function fileUrl(p) { return p ? pathToFileURL(p).href : null; }

  // ---------- IPC ----------
  ipcMain.handle('tasks:list', () => store.all().map(pubTask));

  ipcMain.handle('tasks:create', (e, payload) => {
    const params = payload.params || {};
    const imgs = payload.images || [];
    const isOther = params.mode === 'other';
    if (!imgs.length && !isOther) return { ok: false, err: '请先选择产品图片' };
    if (isOther && !String(params.prompt || '').trim() && !imgs.length) {
      return { ok: false, err: '其他视频请写一段画面描述（或上传参考图）' };
    }
    const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const dir = store.taskDir(id);
    const inDir = ensureDir(path.join(dir, 'input'));
    const images = [];
    imgs.forEach((src, i) => {
      try {
        const ext = path.extname(src) || '.png';
        const dst = path.join(inDir, `${String(i + 1).padStart(2, '0')}${ext}`);
        fs.copyFileSync(src, dst);
        images.push({ src: dst, origName: path.basename(src), status: 'pending' });
      } catch (err) { log('复制图片失败: ' + err.message); }
    });
    if (!images.length) return { ok: false, err: '图片复制失败' };

    const OTHER_NAME = { t2i: '文生图', t2v: '文生视频', i2i: '参考图生图', i2v: '参考图生视频' };
    const otherKind = OTHER_NAME[params.videoKind] ? params.videoKind : 't2v';
    const autoName = String(params.name || '').trim()
      || (isOther ? (String(params.prompt || '').trim().slice(0, 18) || OTHER_NAME[otherKind])
                  : '未命名商品');

    const task = {
      id,
      mode: isOther ? 'other' : 'ecom',
      title: autoName + ' · ' + stamp(),
      params: {
        // 模式：ecom=电商视频（完整流水线）；other=其他视频（直接把创作要求交给 AI）
        mode: isOther ? 'other' : 'ecom',
        videoKind: isOther ? otherKind : '',
        prompt: isOther ? String(params.prompt || '').slice(0, 4000) : '',
        name: autoName,
        category: params.category || '',
        sellingPoints: params.sellingPoints || '',
        audience: params.audience || '',
        scene: params.scene || '',
        logoText: params.logoText || '',
        extra: params.extra || '',
        duration: Number(params.duration || 15),
        ratio: params.ratio || '9:16',
        // 提示词来源：local=本地模板（默认）；doubao=先让豆包写一版再出片
        promptMode: params.promptMode === 'doubao' ? 'doubao' : 'local',
        // 视频形态：空=自动匹配；否则强制指定（见 lib/formats.js 的 FORMATS.key）
        formatKey: typeof params.formatKey === 'string' ? params.formatKey.slice(0, 32) : '',
        // 用户可在新建任务时勾选：不出现字幕 / 不出现台词（勾上=true 表示不要）
        noText: params.noText !== false,
        noVoice: params.noVoice !== false,
        // 是否连背景人声也不要（默认 false = 保留听不清内容的现场人声）
        noAmbient: params.noAmbient === true,
        // 其他视频：是否按 Seedance 规范补全镜头结构（默认 true）
        expand: isOther ? params.expand !== false : true
      },
      images,
      status: 'draft',
      step: 'wait',
      stepText: '待开始',
      prompt: '',
      video: '',
      logs: [],
      createdAt: Date.now(),
      accountId: '',
      accountLabel: ''
    };
    store.add(task);
    pushToRenderer('task:update', pubTask(task));
    return { ok: true, task: pubTask(task) };
  });

  ipcMain.handle('tasks:start', (e, id) => ({ ok: pipeline.enqueue(id) }));
  ipcMain.handle('tasks:cancel', (e, id) => { pipeline.cancel(id); return { ok: true }; });
  ipcMain.handle('tasks:rerunVideo', async (e, id, fix) => ({ ok: await pipeline.rerunVideo(id, fix) }));
  ipcMain.handle('tasks:approve', (e, id) => {
    const t = store.get(id);
    if (!t) return { ok: false };
    t.status = 'done';
    t.stepText = '已通过验收';
    t.approvedAt = Date.now();
    store.save();
    pushToRenderer('task:update', pubTask(t));
    return { ok: true };
  });
  ipcMain.handle('tasks:delete', (e, id) => {
    const t = store.get(id);
    if (t && t.status === 'running') return { ok: false, err: '任务正在运行，先取消再删除' };
    store.remove(id);
    try { fs.rmSync(path.join(TASKS_DIR, 'files', id), { recursive: true, force: true }); } catch (err) {}
    pushToRenderer('task:removed', { id });
    return { ok: true };
  });
  ipcMain.handle('tasks:openFolder', (e, id) => {
    const d = path.join(TASKS_DIR, 'files', id);
    ensureDir(d);
    shell.openPath(d);
    return true;
  });
  ipcMain.handle('tasks:reveal', (e, p) => {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
    return true;
  });
  // 「看豆包页面」精准定位：切到这个任务绑定的账号页面，而不是上次看的那个号。
  // - 任务正在后台执行（页面被租用）→ 临时调到主窗口给用户看，自动化不受影响
  //   （鼠标/输入走 CDP，页面挂在哪个窗口都能正常干活）；用户切走时 attachToMain
  //   会自动把它送回后台执行窗口。
  // - 任务没在跑 → 直接切到该账号页面（随便看，不影响任何东西）。
  ipcMain.handle('tasks:showPage', (e, id) => {
    const t = store.get(id);
    if (!t) return { ok: false, err: '任务不存在' };
    const accId = t.accountId;
    if (!accId) return { ok: false, err: '任务还没分配账号（先点「开始执行」）' };
    const acc = loadAccounts().find(a => a.id === accId);
    if (!acc) return { ok: false, err: '该任务的账号已不存在' };
    const running = isLeased(accId);
    try {
      if (running) {
        if (!takeoverView(accId)) return { ok: false, err: '页面调不到前台，请稍后再试' };
        pushToRenderer('task:toast', {
          text: '已定位到任务账号「' + acc.label + '」（正在后台执行，切走会自动回后台）'
        });
      } else {
        setActiveAccount(accId);
      }
      uiMode = 'doubao';
      pushToRenderer('ui:mode', { mode: 'doubao' });
    } catch (err) {
      return { ok: false, err: String(err && err.message || err) };
    }
    log('看板「看豆包页面」→ 已定位任务账号: ' + acc.label + (running ? '（执行中，临时调到前台）' : ''));
    return { ok: true, account: acc.label, running };
  });
  ipcMain.handle('tasks:readPrompt', (e, id) => {
    const t = store.get(id);
    return t ? t.prompt : '';
  });

  ipcMain.handle('files:pickImages', async () => {
    const win = deps.mainWindow();
    const r = await dialog.showOpenDialog(win, {
      title: '选择产品图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    });
    if (r.canceled) return [];
    return r.filePaths;
  });

  // ---------- 页面自检：登录后跑一次，定位哪一步的按钮对不上 ----------
  ipcMain.handle('diag:run', async () => {
    const { Driver } = require('./driver');
    if (pipeline.isBusy()) {
      return { ok: false, steps: [{ name: '自检', ok: false, msg: '任务正在后台执行，等它跑完再自检（自检会抢页面）' }] };
    }
    const list = accountsForPipeline();
    if (!list.length) return { ok: false, steps: [{ name: '账号', ok: false, msg: '还没有账号，先在「账号」页添加并扫码登录' }] };
    const acc = list.find(a => !a.pending) || list[0];
    const steps = [];
    const add = (name, ok, msg) => steps.push({ name, ok, msg });
    add('使用账号', true, acc.label);

    try {
      await ensureView(acc.id);
      setActiveAccount(acc.id);
      setUiMode('doubao');
      pushToRenderer('ui:mode', { mode: 'doubao' });
      pushToRenderer('active:changed', { id: acc.id });
      await new Promise(r => setTimeout(r, 1200));
      const view = viewOf(acc.id);
      const drv = new Driver(view, { log: (m) => log('[自检] ' + m), anchors: { ...DEFAULT_ANCHORS, ...(config.anchors || {}) }, accountId: acc.id });

      const okChat = await drv.openNewChat(config.chatUrl);
      add('打开对话页', !!okChat, okChat ? '输入框已就绪' : '输入框未出现（网络或页面结构变化）');

      const needLogin = await drv.needsLogin();
      add('登录状态', !needLogin, needLogin ? '页面仍是登录入口，请扫码登录后重跑自检' : '已登录');
      if (needLogin) return finish(steps, drv);

      const comp = await drv.js('(window.__DB ? __DB.composer() : null)');
      add('输入框定位', !!comp, comp ? `坐标 (${comp.x},${comp.y})` : '未找到可编辑区');

      const imgHit = await drv.openSkill('image');
      add('「图像生成」入口', !!imgHit, imgHit ? `命中「${imgHit.key}」` : '未找到：请在 config.json 的 anchors.imageSkill 里补按钮文字');
      if (imgHit) {
        await new Promise(r => setTimeout(r, 1200));
        let n = await drv.js('(window.__DB ? __DB.fileInputs().length : 0)');
        if (!n) {
          await drv.clickAny(Object.assign([], (config.anchors.upload || DEFAULT_ANCHORS.upload)), { exact: false });
          await new Promise(r => setTimeout(r, 1200));
          n = await drv.js('(window.__DB ? __DB.fileInputs().length : 0)');
        }
        add('图片上传入口', n > 0, n > 0 ? `发现 ${n} 个 file input` : '未发现上传入口：请在 anchors.upload 里补按钮文字');
      }

      const vidHit = await drv.openSkill('video');
      add('「视频生成」入口', !!vidHit, vidHit ? `命中「${vidHit.key}」` : '未找到：请在 anchors.videoSkill 里补按钮文字');
      if (vidHit) {
        await new Promise(r => setTimeout(r, 1500));
        const opts = await drv.js('(window.__DB ? __DB.clickables() : [])');
        const texts = (opts || []).map(o => o.t);
        const has916 = texts.some(t => /9\s*[:：]\s*16/.test(t));
        add('画幅 9:16 选项', has916, has916 ? '找到 9:16' : '没找到 9:16（可能叫「竖屏」或默认竖屏）');
        const has15 = texts.some(t => /15\s*(s|秒)/i.test(t));
        add('15 秒时长选项', has15, has15 ? '找到 15 秒' : '没找到 15 秒：平台可能只支持 5/10 秒，建议在新建任务里选 10 秒并按分段素材生成');
      }
      return finish(steps, drv);
    } catch (e) {
      add('自检异常', false, e.message);
      return finish(steps, null);
    }

    function finish(stp, drv) {
      const file = path.join(USER_DIR, 'diag-' + Date.now() + '.json');
      const detail = {
        time: new Date().toISOString(),
        account: acc && acc.label,
        steps: stp,
        anchors: config.anchors || {},
        defaults: DEFAULT_ANCHORS
      };
      try { fs.writeFileSync(file, JSON.stringify(detail, null, 2), 'utf-8'); } catch (e) {}
      log('[自检] 结果: ' + stp.map(s => (s.ok ? '✔' : '✘') + s.name).join(' '));
      return { ok: stp.every(s => s.ok), steps: stp, file };
    }
  });
  ipcMain.handle('diag:openFolder', () => { shell.openPath(USER_DIR); return true; });

  // ---------- 打开内置文档（docs/*.md）+ 环境检测脚本 ----------
  function findDoc(name) {
    const appRoot = path.join(__dirname, '..');
    const base = path.dirname(process.execPath);
    const cands = [
      path.join(base, '文档', name),
      path.join(base, 'docs', name),
      path.join(appRoot, 'docs', name)
    ];
    for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
    return null;
  }
  ipcMain.handle('docs:open', (e, name) => {
    const p = findDoc(String(name || ''));
    if (!p) return { ok: false, err: '文档不存在：可在程序目录的「文档」文件夹里找' };
    shell.openPath(p);
    return { ok: true, path: p };
  });
  ipcMain.handle('docs:reveal', () => {
    const p = findDoc('AI使用说明.md') || findDoc('使用说明.md');
    if (p) shell.showItemInFolder(p);
    else shell.openPath(path.join(__dirname, '..', 'docs'));
    return true;
  });
  ipcMain.handle('tools:doctor', () => {
    const base = path.dirname(process.execPath);
    const cands = ['环境检测与修复.bat', 'tools/环境检测与修复.bat', '环境检测.bat'];
    for (const c of cands) {
      const p = path.join(base, c);
      if (fs.existsSync(p)) { shell.openPath(p); return { ok: true, path: p }; }
    }
    return { ok: false, err: '没找到「环境检测与修复.bat」，请在程序目录里手动运行' };
  });

  ipcMain.handle('ui:setMode', (e, mode) => setUiMode(mode));
  ipcMain.handle('ui:getMode', () => uiMode);

  // ---------- 图像验证看门狗（常驻，写进流程不是一次性的） ----------
  // 每 6 秒扫一遍正在后台执行的账号页面：谁弹了图像验证，立刻把那个页面
  // 强制调到主窗口正面让人处理（这是唯一会占屏的时机），并提示对应任务在等验证。
  setInterval(() => {
    try {
      if (uiMode === 'doubao') return;   // 用户已经在前台看某个页面了
      const ids = leasedIds ? leasedIds() : [];
      if (!ids.length) return;
      for (const id of ids) {
        const v = viewPool.get(id);
        if (!v || v.webContents.isDestroyed()) continue;
        v.webContents.executeJavaScript('(window.__DB ? __DB.verifyBlock() : null)').then((vb) => {
          if (!vb || !vb.on) return;
          const ok = takeoverView(id);
          if (ok) {
            uiMode = 'doubao';
            pushToRenderer('ui:mode', { mode: 'doubao' });
            const acc = loadAccounts().find(a => a.id === id) || {};
            pushToRenderer('task:toast', {
              text: `「${acc.label || '豆包'}」页面弹出图像验证，已强制调到前台，请完成验证`
            });
            log('看门狗：' + id + ' 弹出图像验证，页面已调到前台');
          }
        }).catch(() => {});
      }
    } catch (e) {}
  }, 6000).unref();

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    tasksDir: TASKS_DIR,
    configFile: CONFIG_FILE,
    config
  }));
  ipcMain.handle('app:openConfig', () => { shell.openPath(CONFIG_FILE); return true; });

  return {
    store, pipeline, config, setUiMode, isTasksMode: () => uiMode === 'tasks',
    pickDownloadPath, onDownloadDone, waitDownload, fetchToFile, recentMp4, findRecentDownload, pubTask, fileUrl,
    accountsForPipeline
  };
}

module.exports = { create };
