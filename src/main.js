// ============================================================
//  Look v1.0 · 视频生成 + AI 多开 · 视图池架构
//  作者：Leon
//  新增：任务队列（图片处理→提示词→视频生成→回收→验收）+ 账号轮转
//  核心思路继承自 doubao-video-multi:
//    单窗口 + WebContentsView 常驻视图池, 切号=显隐切换(毫秒级,不丢状态)
//  在其基础上修复/增强:
//    1. userData 重定向到本目录(E盘), 不再写 C 盘 AppData
//    2. GPU 硬件加速默认开启(兼容模式可选), 不再全局禁用
//    3. 渲染进程崩溃自动重建视图; 加载失败自动重试并标记状态
//    4. 掉线检测改用强凭证 Cookie(不再用 DOM 文本正则, 避免误报)
//    5. 缩放快捷键真正作用于豆包页面(原版只作用于主窗口, 无效)
//    6. 新增下载处理: 生成的视频/图片自动保存并可一键打开
//    7. 权限请求白名单; 关窗最小化到托盘(可关); 单实例锁
//    8. 登录监控防重入、定时器必清; 昵称提取只在登录成功时执行一次
// ============================================================
const { app, BrowserWindow, WebContentsView, ipcMain, Menu, session, shell, Tray, nativeImage, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const EXT = require('./lib/ext');

// ---------- 路径与日志 ----------
const APP_DIR = __dirname;
// 便携版：数据放 exe 同级目录；开发态：放项目目录
// 可用环境变量 DOUBAO_FLOW_DATA 指定数据目录（调试/多实例测试用）
const DATA_DIR = process.env.DOUBAO_FLOW_DATA || (app.isPackaged ? path.dirname(process.execPath) : APP_DIR);
const USER_DIR = path.join(DATA_DIR, 'userdata');
const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads');
const LOG_FILE = path.join(DATA_DIR, 'app-run.log');
app.setPath('userData', USER_DIR);
try { app.setPath('crashDumps', path.join(USER_DIR, 'crashes')); } catch (e) {}

// ---------- 上次被强杀 / 断电后的缓存自愈 ----------
// 强杀后 userdata 里的 GPUCache / Dawn 缓存会留下半截文件，Chromium 下次启动读到
// "Invalid file version or magic" 会把渲染进程直接搞崩 —— 现象就是「进程在跑、没窗口、一片白」。
// 这一步在「建窗口之前」做：这时缓存文件还没被本进程打开，删得掉；只清缓存，
// Cookies / Local Storage / Preferences 一律不动，登录态不受影响。
const DIRTY_FLAG = path.join(USER_DIR, '_running.flag');
(function bootCacheGuard() {
  try {
    const dirty = fs.existsSync(DIRTY_FLAG);
    if (dirty) {
      const caches = ['GPUCache', 'Code Cache', 'ShaderCache', 'GrShaderCache',
                      'DawnWebGPUCache', 'DawnGraphiteCache', 'old_DawnGraphiteCache_000',
                      'Cache', 'Service Worker'];
      let cleaned = 0;
      for (const name of caches) {
        const target = path.join(USER_DIR, name);
        if (!fs.existsSync(target)) continue;
        try { fs.rmSync(target, { recursive: true, force: true }); cleaned++; } catch (e) {}
      }
      log('上次未正常退出：已清理 ' + cleaned + ' 个缓存目录（登录态保留）');
    }
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(DIRTY_FLAG, String(Date.now()));
    app.on('will-quit', () => { try { fs.unlinkSync(DIRTY_FLAG); } catch (e) {} });
  } catch (e) {
    log('缓存自愈失败: ' + e.message);
  }
})();

// 中文目录下 loadFile('index.html') 会拼出带反斜杠的 file URL（file:///D://中文//...//index.html），
// Chromium 解析不了，直接 ERR_FAILED 白屏。统一用 pathToFileURL 生成规范 file:// 地址，
// 放在纯英文目录、中文目录、带空格目录都能量到同一个页面。
let profileRecovered = false;

function loadPage(win, ...segs) {
  const file = path.join(__dirname, ...segs);
  const url = pathToFileURL(file).toString();
  return win.loadURL(url).catch(async (e) => {
    log('loadPage 失败: ' + file + ' → ' + e.message);
    // 常见的两种：① 程序已经开着一个（档案被占用）② 上次强杀后档案卡住。
    // 先重试一次；还不行就问用户，别默默白屏。
    await new Promise((r) => setTimeout(r, 800));
    try {
      await win.loadURL(url);
      log('重试加载成功');
      return;
    } catch (e2) {
      log('重试仍失败: ' + e2.message);
    }
    if (segs[0] !== 'index.html' || !fs.existsSync(file) || profileRecovered) return;
    profileRecovered = true;
    let choice = 1;
    try {
      choice = dialog.showMessageBoxSync(win, {
        type: 'error',
        title: '启动失败',
        message: '界面没能加载出来',
        detail: '常见原因：\n· 程序已经开着一个了（看任务栏和托盘，关掉再开）\n· 上次被强杀 / 直接关机，浏览器档案卡住了\n\n如果确认没有第二个窗口，选「重置档案并重启」；账号需要重新扫码登录。',
        buttons: ['重置档案并重启', '退出'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
    } catch (e3) {}
    if (choice === 0) recoverProfile('用户选择重置档案');
    else app.exit(0);
  });
}

// 把坏掉的 userData 改名留档（不删，方便排查），然后自动重启
function recoverProfile(reason) {
  const mark = path.join(DATA_DIR, '_profile_reset.json');
  let info = { count: 0, last: 0, reason: '' };
  try { info = Object.assign(info, JSON.parse(fs.readFileSync(mark, 'utf8'))); } catch (e) {}
  const now = Date.now();
  // 一小时内连续两次重置说明不是档案问题（比如磁盘/杀软），别再循环重启
  if (info.count >= 2 && now - info.last < 3600 * 1000) {
    log('档案已连续重置失败，停止自动恢复：' + reason);
    try { dialog.showErrorBox('启动失败', '程序档案连续修复失败，请双击「环境检测与修复.bat」选「一键修复」，或联系作者。'); } catch (e) {}
    return;
  }
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bak = path.join(DATA_DIR, 'userdata.损坏备份-' + stamp);
    if (fs.existsSync(USER_DIR)) fs.renameSync(USER_DIR, bak);
    fs.writeFileSync(mark, JSON.stringify({ count: (info.count || 0) + 1, last: now, reason: String(reason || ''), backup: bak }), 'utf-8');
    log('已重置档案（原因：' + reason + '），备份在 ' + bak + '，即将自动重启');
    app.relaunch();
    app.exit(0);
  } catch (e) {
    log('档案重置失败: ' + e.message);
    try { dialog.showErrorBox('启动失败', '无法重置程序档案：' + e.message + '\n请把整个程序目录移到 D 盘根目录后重试，或联系作者。'); } catch (e2) {}
  }
}

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch (e) {}
}
try {
  const st = fs.statSync(LOG_FILE);
  if (st.size > 1024 * 1024) fs.unlinkSync(LOG_FILE); // 超过 1MB 重新开始
} catch (e) {}
log('=== v3 启动 ===');

// ---------- 偏好设置(先于 ready 读取, 因为兼容模式要提前决定) ----------
const PREFS_FILE = path.join(USER_DIR, 'prefs.json');
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8')); } catch (e) { return {}; }
}
let prefs = Object.assign({ closeToTray: true, winBounds: null }, loadPrefs());
function savePrefs() {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf-8');
  } catch (e) { log('savePrefs 失败: ' + e.message); }
}

// 关键：Windows 上 Chromium 会做「窗口遮挡判定」（CalculateNativeWinOcclusion），
// 被其他窗口盖住或挪到屏幕外的窗口会被判成 occluded → 页面 visibilityState 变成 hidden
// → 豆包输入框退化成不可交互的副本，表现为「图和字都进去了，回车/发送完全没反应」。
// 后台执行窗口天生就在屏幕外，所以必须关掉这个判定。
try {
  const feat = 'CalculateNativeWinOcclusion';
  const cur = app.commandLine.getSwitchValue('disable-features');
  app.commandLine.appendSwitch('disable-features', cur ? `${cur},${feat}` : feat);
  log('已关闭窗口遮挡判定（后台窗口保持 visible）');
} catch (e) {}

if (prefs.compatGpu) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  log('兼容模式: 已禁用 GPU');
}

// ---------- 全局常量 ----------
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const DOUBAO_URL = 'https://www.doubao.com/chat/';
const APP_NAME = 'Look';

// 界面几何：左侧导航 60 + 列表面板 240 = 300，顶部标题栏 48。
// 内嵌的账号页面（WebContentsView）从 (300, 48) 开始，不会盖住顶栏和左栏。
const SIDEBAR_WIDTH = 300;
const HEADER_H = 48;
const PALETTE = ['#4F86F7', '#00B578', '#FF7D00', '#E16531', '#7261A3', '#2BA6A0', '#D22E45', '#5B8C5A'];

// 登录凭证特征: 强凭证(登录后才会出现) 与 匿名/埋点 key
const AUTH_RE = /sessionid|session_tt|uid_tt|user_tt|user_ticket|login_uid|auth_token|user_token|passport_auth|sid_tt|sso_|store-region/i;
const ANON_RE = /ttwid|s_v_web_id|msToken|bd_ticket|__tea|tea_|flow_|logid|ab_|monitor|rum|perf|gid|vid|csrf|publish|i18next/i;

// 豆包客户端安装包（exe/apk/安装器）——页面上到处都是「下载豆包」条幅，
// 误点一次就会把 7MB 的 exe 下回来当处理图，还会把系统浏览器打开。
// 这里做三处硬拦截：请求层 cancel、下载层 preventDefault、弹窗层 deny。
const JUNK_URL_RE = /doubao_client|webdaoliu|installer|doubao\.com\/download|\.(exe|msi|msix|apk|dmg|pkg|crx|deb|rpm)(\?|$)/i;
const JUNK_HOST_RE = /^(lf9-apk\.ugapk\.cn|.*\.ugapk\.cn)$/i;
const JUNK_NAME_RE = /doubao_client|webdaoliu|installer|setup|_client_|doubao.*\.(exe|msi|apk)$/i;
function isJunkUrl(u) {
  const s = String(u || '');
  if (!s) return false;
  if (JUNK_URL_RE.test(s)) return true;
  try { if (JUNK_HOST_RE.test(new URL(s).hostname)) return true; } catch (e) {}
  return false;
}
function isJunkName(n) { return JUNK_NAME_RE.test(String(n || '')); }

// ---------- 运行状态 ----------
let mainWindow = null;
let tray = null;
let activeAccountId = null;
const viewPool = new Map();          // accountId -> WebContentsView (常驻不销毁)
// 后台执行窗口：任务运行时，豆包页面挂在这个离屏窗口里跑，主窗口只显示任务看板。
// 这样用户在界面里点来点去（切账号、切标签、点任务）都不会把正在生成的页面切走。
// 页面一旦被切走就成了 hidden，输入框会退化成不可交互副本，生成会中断。
let workerWin = null;
let attachedViewId = null;           // 当前挂在主窗口上的视图（没挂则为 null）
const leases = new Map();            // accountId -> { since } 由流水线占用中的账号页面
let autoAccountId = null;            // 流水线当前正在使用的账号
const WORKER_W = 1360, WORKER_H = 980;
const badges = new Map();            // accountId -> 'online'|'pending'|'offline'|'loadfail'
const monitors = new Map();          // accountId -> {timer,diag,done}
const nameAttempts = new Map();      // accountId -> 昵称识别已尝试次数
const forceQuitting = { value: false };
let ext = null;                      // 任务流水线扩展（在函数定义完成后装配）

// ---------- AI 平台注册表（多开管理器的埋线） ----------
const { ProviderStore } = require('./lib/providers');
const providerStore = new ProviderStore(path.join(USER_DIR, 'providers.json'));
function providerOf(account) {
  return providerStore.get(account && account.providerId) || providerStore.get('doubao') || { id: 'doubao', name: '豆包', kind: 'doubao', chatUrl: DOUBAO_URL, cookieDomains: ['.doubao.com'] };
}

// ---------- 账号持久化 ----------
const accountsFile = () => path.join(USER_DIR, 'accounts.json');
function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(accountsFile(), 'utf-8') || '[]'); } catch (e) { return []; }
}
function saveAccounts(list) {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(accountsFile(), JSON.stringify(list, null, 2), 'utf-8');
  } catch (e) { log('saveAccounts 失败: ' + e.message); }
}

// ---------- 视图几何 ----------
function getContentBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return { x: SIDEBAR_WIDTH, y: HEADER_H, width: 900, height: 600 };
  const b = mainWindow.getContentBounds();
  return {
    x: SIDEBAR_WIDTH,
    y: HEADER_H,
    width: Math.max(400, b.width - SIDEBAR_WIDTH),
    height: Math.max(300, b.height - HEADER_H)
  };
}

// ---------- 后台执行窗口 ----------
// 关键点：
//  1) 窗口必须 show()（哪怕是屏幕外），Chromium 才认为页面 visible；
//     show:false 的窗口里页面是 hidden，豆包输入框会变成不可交互副本。
//  2) focusable:false + showInactive，永远不会抢用户的键盘焦点。
//  3) 屏幕外座标用负值，窗口在 Alt-Tab / 任务栏里都看不到。
function ensureWorkerWin() {
  if (workerWin && !workerWin.isDestroyed()) return workerWin;
  workerWin = new BrowserWindow({
    x: -WORKER_W - 240, y: -240,
    width: WORKER_W, height: WORKER_H,
    show: false, frame: false, skipTaskbar: true, focusable: false,
    resizable: false, minimizable: false, maximizable: false,
    hasShadow: false, backgroundColor: '#111111',
    title: '后台执行',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
    }
  });
  try { workerWin.webContents.setBackgroundThrottling(false); } catch (e) {}
  // 双重保险：万一系统仍把它当成「可交互区域」，也不让它挡用户点东西
  try { workerWin.setIgnoreMouseEvents(true); } catch (e) {}
  try { workerWin.setOpacity(0.01); } catch (e) {}
  workerWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:#111"></body>')).catch(() => {});
  workerWin.once('ready-to-show', () => {
    try { workerWin.showInactive(); } catch (e) {}
    log('后台执行窗口已就绪（离屏运行，不抢焦点）');
  });
  workerWin.on('closed', () => { workerWin = null; });
  return workerWin;
}

function workerBounds() { return { x: 0, y: 0, width: WORKER_W, height: WORKER_H }; }

// 把某个账号的页面挂到主窗口（用户要看的时候）
function attachToMain(id) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const view = viewPool.get(id);
  if (!view || view.webContents.isDestroyed()) return false;
  if (attachedViewId === id) { try { view.setBounds(getContentBounds()); } catch (e) {} return true; }
  if (attachedViewId && viewPool.has(attachedViewId)) {
    // 切走时：如果之前那个页面正被任务占用（用户是临时调出来看的），
    // 必须送回后台执行窗口，不能就这么摘下来变 hidden——会把正在跑的任务卡死。
    if (leases.has(attachedViewId)) {
      try { leaseView(attachedViewId, { mode: 'worker' }); } catch (e) {
        try { mainWindow.contentView.removeChildView(viewPool.get(attachedViewId)); } catch (e2) {}
      }
    } else {
      try { mainWindow.contentView.removeChildView(viewPool.get(attachedViewId)); } catch (e) {}
    }
  }
  try { workerWin && !workerWin.isDestroyed() && workerWin.contentView.removeChildView(view); } catch (e) {}
  try { mainWindow.contentView.addChildView(view); } catch (e) { return false; }
  try { view.setBounds(getContentBounds()); } catch (e) {}
  attachedViewId = id;
  return true;
}

function detachFromMain(id) {
  const view = viewPool.get(id || attachedViewId);
  if (!view) { attachedViewId = null; return; }
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view); } catch (e) {}
  if (!id || attachedViewId === id) attachedViewId = null;
}

// 流水线占用：把页面挪到后台窗口，用户点任何地方都不会打断
function leaseView(id, meta) {
  const view = viewPool.get(id);
  if (!view) return false;
  const wasShown = (attachedViewId === id);
  if (wasShown) detachFromMain(id);
  const w = ensureWorkerWin();
  try { w.contentView.addChildView(view); } catch (e) { log('挂到后台窗口失败: ' + e.message); }
  try { view.webContents.setBackgroundThrottling(false); } catch (e) {}
  leases.set(id, Object.assign({ since: Date.now() }, meta || {}));
  // 多个任务并发时，各账号视图在后台窗口里竖向平铺（每层一个完整页面），
  // 避免全部叠在同一个位置互相盖住；窗口高度随层数自动加高（窗口在屏幕外，不影响使用）。
  let bounds = workerBounds();
  const k = leases.size;   // 本次挂进来的是第 k 层
  if (k > 1) {
    try {
      w.setSize(WORKER_W, WORKER_H * k);
      const h = (w.getContentSize() || [])[1] || 0;
      if (h >= WORKER_H * k) bounds = { x: 0, y: (k - 1) * WORKER_H, width: WORKER_W, height: WORKER_H };
    } catch (e) {}
  }
  try { view.setBounds(bounds); } catch (e) {}
  if (wasShown) {
    // 用户正在看这个号 → 页面转入后台，界面切回看板并提示一下
    pushToRenderer('ui:mode', { mode: 'tasks' });
    pushToRenderer('view:locked', {
      id, label: (loadAccounts().find(a => a.id === id) || {}).label,
      msg: '页面已转入后台执行，避免操作打断生成'
    });
  }
  log('页面转入后台执行: ' + id + '（不占屏幕、不抢焦点）');
  // 保险：个别显卡/多屏环境下离屏窗口会被判成「不可见」，页面进 hidden 后
  // 豆包输入框会变成不可交互副本（表现为「图传上去了、提示词写不进」）。
  // 这里查一次真实可见性，真被判隐藏就把窗口挪到屏幕内、几乎全透明。
  setTimeout(() => {
    try {
      if (!view.webContents.isDestroyed()) {
        view.webContents.executeJavaScript('document.visibilityState').then((st) => {
          if (st === 'visible') return;
          const ww = ensureWorkerWin();
          try { ww.setPosition(0, 0); } catch (e) {}
          try { ww.setOpacity(0.02); } catch (e) {}
          try { ww.setAlwaysOnTop(false); } catch (e) {}
          log('后台窗口被判为不可见，已切换到「屏内近乎透明」模式: ' + id);
        }).catch(() => {});
      }
    } catch (e) {}
  }, 1500);
  return true;
}

// 流水线用完：从后台窗口摘下（页面保留，随时可看）
function releaseView(id) {
  const view = viewPool.get(id);
  leases.delete(id);
  if (autoAccountId === id) autoAccountId = null;
  if (!view) return;
  try { if (workerWin && !workerWin.isDestroyed()) workerWin.contentView.removeChildView(view); } catch (e) {}
  try { if (mainWindow && !mainWindow.isDestroyed() && attachedViewId !== id) mainWindow.contentView.removeChildView(view); } catch (e) {}
}

// 需要人工过验证 / 用户主动查看时，把正在跑的页面摆到主窗口
function takeoverView(id) {
  const view = viewPool.get(id);
  if (!view) return false;
  const ok = attachToMain(id);
  if (ok && mainWindow && !mainWindow.isDestroyed()) {
    try { if (mainWindow.isMinimized()) mainWindow.restore(); } catch (e) {}
    try { mainWindow.show(); mainWindow.focus(); } catch (e) {}
  }
  return ok;
}

function isLeased(id) { return leases.has(id); }

// ---------- 会话级钩子(下载/权限), 每个分区只挂一次 ----------
function ensureSessionHooks(accountId) {
  const key = 'persist:' + accountId;
  let ses;
  try { ses = session.fromPartition(key); } catch (e) { return; }
  if (!ses || ses.__hooksDone) return;
  ses.__hooksDone = true;

  // 记录本分区内出现过的"用户信息类"接口(含 Worker 发起的请求), 供昵称识别重放
  ses.__apiLog = [];
  try {
    ses.webRequest.onCompleted({ urls: ['*://*.doubao.com/*'] }, (details) => {
      try {
        if (details.method !== 'GET') return;
        const pathOnly = details.url.split('?')[0];
        const low = details.url.toLowerCase();
        const interesting = low.indexOf('/user') >= 0 || low.indexOf('userinfo') >= 0 ||
          low.indexOf('user_info') >= 0 || low.indexOf('/account') >= 0 ||
          low.indexOf('passport') >= 0 && low.indexOf('info') >= 0;
        const junk = ['beat', 'heartbeat', 'track', 'monitor', 'report', '/log'].some(j => low.indexOf(j) >= 0);
        if (interesting && !junk && ses.__apiLog.length < 60) {
          if (ses.__apiLog.indexOf(details.url) < 0) ses.__apiLog.push(details.url);
        }
      } catch (e) {}
    });
  } catch (e) { log('webRequest 钩子失败: ' + e.message); }

  // 【硬限制】豆包客户端安装包：不管从哪条路发起（条幅、登录弹窗、新窗口、直链），一律掐掉。
  // 以前点错一下就把 7MB 的 exe 下回来当处理图，还顺带把系统浏览器打开。
  try {
    ses.webRequest.onBeforeRequest((details, cb) => {
      if (isJunkUrl(details.url)) {
        log('已拦截豆包客户端请求: ' + String(details.url).slice(0, 90));
        cb({ cancel: true });
        return;
      }
      // 顺手记下页面请求过的视频地址：成片播放器点不开时，可以直接按这个地址抓
      try {
        if (/\.mp4(\?|$)|\/video\/tos|mime_type=video|vdl\.doubao|video_id=/i.test(details.url)) {
          ses.__mp4 = ses.__mp4 || [];
          if (!ses.__mp4.some(x => x.url === details.url)) {
            ses.__mp4.push({ url: details.url, at: Date.now() });
            if (ses.__mp4.length > 10) ses.__mp4.shift();
          }
        }
      } catch (e) {}
      cb({});
    });
  } catch (e) { log('webRequest 拦截钩子失败: ' + e.message); }

  // 光看 URL 猜视频不够准（成片地址经常是 v.doubao.com/xxx 这种没有 .mp4 字样的），
  // 这里再看响应头：Content-Type 是 video/* 的一律记下来，points 给「播放器点不开时直连抓取」用。
  try {
    ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, cb) => {
      try {
        const h = details.responseHeaders || {};
        let ct = '';
        for (const k of Object.keys(h)) {
          if (k.toLowerCase() === 'content-type') {
            const v = h[k];
            ct = String(Array.isArray(v) ? v[0] : (v || '')).toLowerCase();
            break;
          }
        }
        if (ct.indexOf('video/') === 0) {
          ses.__mp4 = ses.__mp4 || [];
          if (!ses.__mp4.some(x => x.url === details.url)) {
            ses.__mp4.push({ url: details.url, at: Date.now(), ct });
            if (ses.__mp4.length > 12) ses.__mp4.shift();
            log('记录视频地址(' + ct + '): ' + String(details.url).slice(0, 100));
          }
        }
      } catch (e) {}
      try { cb({}); } catch (e) {}
    });
  } catch (e) { log('响应头钩子失败: ' + e.message); }

  // 下载: 自动存到 程序目录\downloads\账号ID\；若任务正在等下载则直接落到任务目录
  ses.on('will-download', (event, item) => {
    let savePath = null;
    // 只接「内容文件」。豆包页面上到处都是「下载豆包客户端」的条幅，
    // 点错一下就会把 7MB 的安装包下回来当成处理图（曾把 exe 存成 _white_1.png）。
    const junkRe = /\.(exe|msi|msix|zip|rar|7z|dmg|pkg|apk|crx|deb|rpm)($|\?)/i;
    const fname0 = String(item.getFilename() || '');
    if (junkRe.test(fname0) || isJunkName(fname0)) {
      try { event.preventDefault(); } catch (e) {}
      log('已拦截非内容类下载（安装包/压缩包）: ' + fname0);
      // 通知等待方「这次没拿到文件」，让它立刻换下一种抓取方式，别干等超时
      if (ext) { try { ext.onDownloadDone(accountId, null, 'interrupted'); } catch (err) {} }
      return;
    }
    try {
      const base = item.getFilename() || ('file-' + Date.now());
      const routed = ext ? ext.pickDownloadPath(accountId, base) : null;
      if (routed) {
        savePath = routed;
      } else {
        const dir = path.join(DOWNLOAD_DIR, accountId);
        fs.mkdirSync(dir, { recursive: true });
        savePath = path.join(dir, base);
        let i = 1;
        while (fs.existsSync(savePath)) {
          const extn = path.extname(base), stem = path.basename(base, extn);
          savePath = path.join(dir, stem + '(' + i + ')' + extn); i++;
        }
      }
      item.setSavePath(savePath);
      log('下载开始: ' + base + ' -> ' + savePath);
    } catch (e) { log('下载设置失败: ' + e.message); }
    item.once('done', (e2, state) => {
      if (ext) { try { ext.onDownloadDone(accountId, savePath, state); } catch (err) {} }
      if (state === 'completed') {
        log('下载完成: ' + item.getSavePath());
        pushToRenderer('download:done', { file: path.basename(item.getSavePath()), dir: path.dirname(item.getSavePath()) });
        if (tray) { tray.displayBalloon && tray.displayBalloon({ title: '下载完成', content: path.basename(item.getSavePath()) }); }
      } else if (state === 'interrupted') {
        log('下载中断: ' + item.getFilename());
      }
    });
  });

  // 权限白名单: 常用放行, 其余拒绝(避免页面权限弹窗卡死)
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const allow = ['media', 'clipboard-sanitized-write', 'notification', 'fullscreen', 'pointerLock', 'clipboard-read'];
    callback(allow.indexOf(permission) >= 0);
  });
}

// ---------- 页面内脚本 ----------
const WEBDRIVER_PATCH = "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});";

// 昵称识别: 重放主进程记录到的用户信息接口(cands 由外部传入) + DOM 兜底策略
const DETECT_NAME_SCRIPT = `(async (cands) => {
  try {
  const clean = (s)=>String(s||'').replace(/\\s+/g,' ').trim();
  const bodyTxt = (document.body && document.body.innerText) || '';
  if (/扫码登录|手机号登录|验证码登录|^登录$/.test(bodyTxt)) return {name:'',source:'login-page'};
  const BAD = /(登录|退出|注册|下载|更多|最近|对话|工作|关于|设置|帮助|反馈|搜索|首页|返回|收起|展开|取消|确定|删除|重命名|新建|热门|推荐|免费|会员|升级|签到|消息|通知|历史|收藏|资料|我的|编辑|分享|复制|清空|全部|加载|暂无|PPT|图像|视频|研究|播客|录音|转写|文档|表格|代码|翻译|创作|技能|云盘|项目|置顶|深度思考|联网|豆包|助手|模型|默认)/i;
  const JUNK = /^(success|succeeded|failed|failure|fail|ok|okay|true|false|null|none|unknown|yes|no|0|1)$/i;
  const isName = (t)=>{
    t = clean(t);
    if (!t || t.length<1 || t.length>15) return false;
    if (BAD.test(t)) return false;
    if (JUNK.test(t)) return false;
    if (/^[0-9.-]+$/.test(t)) return false;
    return true;
  };

  // ---- 策略0(最可靠): 重放用户信息接口并深挖昵称字段 ----
  const NAME_KEY_RE = /^(nick|nickname|user_?name|display_?name|screen_?name|platform_screen_?name)$/i;
  function digName(obj, depth){
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    let generic = null;
    for (const k of Object.keys(obj)){
      let v;
      try { v = obj[k]; } catch(e){ continue; }
      if (v == null) continue;
      if (typeof v === 'string'){
        if (NAME_KEY_RE.test(k) && isName(v)) return clean(v);
        if (!generic && /^name$/i.test(k) && isName(v)) generic = clean(v);
      } else if (typeof v === 'object'){
        const r = digName(v, depth+1);
        if (r) return r;
      }
    }
    return generic;
  }
  async function tryUrl(u){
    try {
      const r = await fetch(u, { credentials:'include', headers:{'accept':'application/json'} });
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      if (ct.indexOf('json') < 0) return null;
      const j = await r.json();
      const root = (j && typeof j === 'object') ? (j.data || j.result || j.user || j) : null;
      const n = digName(root, 0);
      if (n) return { name:n, source:'api-replay:' + u.slice(0,90) };
    } catch(e){}
    return null;
  }
  // ---- 策略0a(首选): 豆包已知的用户信息接口, 直接带凭证重放 ----
  try {
    const known = [
      'https://www.doubao.com/passport/account/info/v2/?language=zh_cn',
      'https://www.doubao.com/passport/account/info/v2/'
    ];
    for (const u of known){
      const hit = await tryUrl(u);
      if (hit) return hit;
    }
  } catch(e){}

  // ---- 策略0b: 主进程记录到的其他候选接口 ----
  try {
    // 候选列表来自主进程 webRequest 记录(能覆盖 Web Worker 内的请求)
    const urls = Array.isArray(cands) ? cands : [];
    const seen = new Set();
    for (const u of urls){
      if (seen.has(u)) continue;
      seen.add(u);
      const hit = await tryUrl(u);
      if (hit) return hit;
    }
  } catch(e){}

  // ---- 策略1: 退出登录容器 ----
  let logoutEl = null;
  [...document.querySelectorAll('*')].forEach(el=>{
    if (el.children.length===0 && /^退出登录$/.test(clean(el.textContent))) logoutEl = el;
  });
  if (logoutEl) {
    let c = logoutEl;
    for (let i=0;i<4 && c.parentElement;i++) c = c.parentElement;
    const found = [];
    c.querySelectorAll('*').forEach(el=>{
      if (el.children.length>0) return;
      const t = clean(el.textContent || el.getAttribute('alt') || '');
      if (isName(t) && !/^退出登录$|^设置$|^更多$/.test(t)) found.push(t);
    });
    if (found.length) return {name:found[0], source:'logout-container'};
  }
  // ---- 策略2: localStorage 用户信息字段 ----
  try {
    for (let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      if (!/user|account|profile|passport/i.test(k)) continue;
      const v = localStorage.getItem(k);
      if (!v || v.length>8000) continue;
      try {
        const obj = JSON.parse(v);
        const cand = obj && (obj.nick || obj.nickname || obj.name || obj.user_name || obj.userName || (obj.data && (obj.data.nick||obj.data.name)));
        if (typeof cand === 'string' && isName(cand)) return {name:cand.trim(), source:'localStorage:'+k};
      } catch(e2) {}
    }
  } catch(e) {}
  // ---- 策略3: 左下角头像 alt ----
  const w = window.innerWidth, h = window.innerHeight;
  const imgs = [...document.querySelectorAll('img')]
    .map(i=>({el:i, r:i.getBoundingClientRect()}))
    .filter(a=>a.r.width>20 && a.r.left<w*0.5 && a.r.top>h*0.5);
  for (const a of imgs){
    const t = clean(a.el.alt || a.el.getAttribute('aria-label') || '');
    if (isName(t)) return {name:t, source:'avatar-alt'};
  }
  return {name:'', source:'none'};
  } catch(err){
    return {name:'', source:'exception:' + ((err && err.message) || String(err)).slice(0,120)};
  }
})`;

// 对默认名("账号 N")的账号尝试自动识别昵称并改名; force=true 时无视默认名限制
async function tryAutoRename(accountId, force) {
  const list = loadAccounts();
  const acc = list.find(a => a.id === accountId);
  if (!acc || acc.pending) return;
  if (!force && !/^账号\s*\d+$/.test(acc.label)) return;  const v = viewPool.get(accountId);
  if (!v || v.webContents.isDestroyed()) return;
  await new Promise(r => setTimeout(r, 3000));
  try {
    if (!v || v.webContents.isDestroyed()) return;
    // 候选: 主进程 webRequest 记录到的用户信息类接口(含 Worker 请求)
    let cands = [];
    try {
      const ses = session.fromPartition('persist:' + accountId);
      if (ses && Array.isArray(ses.__apiLog)) cands = ses.__apiLog.slice();
    } catch (e) {}
    const script = '(' + DETECT_NAME_SCRIPT + ')(' + JSON.stringify(cands) + ');';
    const res = await v.webContents.executeJavaScript(script, true).catch((err) => {
      return { __rejected: true, msg: ((err && err.message) || String(err)).slice(0, 200), stack: ((err && err.stack) || '').slice(0, 400) };
    });
    if (res && res.__rejected) {
      log('识别脚本REJECT: ' + res.msg + ' | stack: ' + res.stack);
      return;
    }
    const name = res && res.name ? String(res.name).trim() : '';
    if (!name) {
      const n = (nameAttempts.get(accountId) || 0) + 1;
      nameAttempts.set(accountId, n);
      log('昵称识别为空: ' + accountId + ' source=' + (res && res.source) + ' | 候选数=' + cands.length +
        (cands.length ? ' | 首个=' + String(cands[0]).slice(0, 90) : '') +
        ' | 尝试次数=' + n);
      // 未成功则安排重试(接口数据稍后才完整), 最多 20 次 × 10 秒
      if (n < 20 && !force) {
        setTimeout(() => { tryAutoRename(accountId, false); }, 10000);
      }
      // 首次失败时打印候选数(重试由上方定时器负责)
      if (n === 1 && cands.length === 0) {
        log('提示: ' + accountId + ' 暂无候选接口, 页面可能尚未发起用户信息请求');
      }
      return;
    }
    nameAttempts.delete(accountId);
    const list2 = loadAccounts();
    const acc2 = list2.find(a => a.id === accountId);
    if (!acc2 || acc2.label === name) return;
    const wasDefault = /^账号\s*\d+$/.test(acc2.label);
    acc2.label = name;
    saveAccounts(list2);
    log('昵称识别成功: ' + name + ' (' + accountId + ') source=' + res.source + (wasDefault ? ' [自动]' : ' [手动触发]'));
    pushToRenderer('account:ready', { id: accountId, label: name });
  } catch (e) { log('昵称识别异常: ' + e.message); }
}

// ---------- 视图池 ----------
function markBadge(id, st) {
  badges.set(id, st);
  pushToRenderer('badge:update', { id, status: st });
}

function createViewForAccount(account) {
  const prov = providerOf(account);
  // 每个平台用自己的登录页/对话页；豆包仍是内置深度适配，其余平台走通用驱动
  const startUrl = prov.chatUrl || prov.loginUrl || DOUBAO_URL;
  ensureSessionHooks(account.id);
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:' + account.id,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  view.__retries = 0;
  const wc = view.webContents;
  // 后台执行时页面不能降级：否则豆包输入框会变成不可交互的副本
  try { wc.setBackgroundThrottling(false); } catch (e) {}

  wc.setUserAgent(CHROME_UA);

  // webdriver 补丁在 dom-ready 打(比 did-start-loading 更稳)
  wc.on('dom-ready', () => {
    wc.executeJavaScript(WEBDRIVER_PATCH, true).catch(() => {});
  });

  // 崩溃自愈: 渲染进程崩溃后自动重建同分区视图
  wc.on('render-process-gone', (e, detail) => {
    log('渲染进程退出: ' + account.id + ' reason=' + detail.reason);
    setTimeout(() => recreateView(account.id), 800);
  });

  // 加载失败: 自动重试 3 次, 之后标记 loadfail 由用户点击重试
  wc.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return; // -3=ABORTED(跳转被打断,忽略)
    log('加载失败: ' + account.id + ' code=' + code + ' url=' + url);
    if (view.__retries < 3) {
      view.__retries++;
      setTimeout(() => {
        try { if (!wc.isDestroyed()) wc.loadURL(startUrl); } catch (err) {}
      }, 1200 * view.__retries);
    } else {
      markBadge(account.id, 'loadfail');
    }
  });
  wc.on('did-finish-load', () => {
    view.__retries = 0;
    const acc = loadAccounts().find(a => a.id === account.id);
    if (acc && acc.pending) markBadge(account.id, 'pending');
    else if (badges.get(account.id) !== 'offline') markBadge(account.id, 'online');
    // 已登录但仍是默认名的账号: 页面每次加载完自动尝试识别昵称
    if (acc && !acc.pending) setTimeout(() => tryAutoRename(account.id, false), 1000);
  });

  // 弹窗一律交给系统浏览器；但「下载豆包客户端」这类链接直接丢掉，不打开浏览器
  wc.setWindowOpenHandler(({ url }) => {
    if (isJunkUrl(url)) {
      log('已拦截豆包客户端下载弹窗: ' + String(url).slice(0, 90));
      return { action: 'deny' };
    }
    log('拦截新窗口: ' + url);
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.loadURL(startUrl).then(() => {
    log('视图加载完成: ' + account.label + '（' + prov.name + '）');
  }).catch((e) => log('视图加载失败: ' + account.label + ' ' + e.message));
  return view;
}

// 崩溃/异常后的重建: 保持分区不变, 若是当前激活视图则重新挂载
function recreateView(accountId) {
  const acc = loadAccounts().find(a => a.id === accountId);
  if (!acc) return;
  const old = viewPool.get(accountId);
  const lease = leases.get(accountId);
  const wasAttached = (attachedViewId === accountId);
  if (old) {
    try { mainWindow.contentView.removeChildView(old); } catch (e) {}
    try { if (workerWin && !workerWin.isDestroyed()) workerWin.contentView.removeChildView(old); } catch (e) {}
    try { if (!old.webContents.isDestroyed()) old.webContents.close(); } catch (e) {}
    viewPool.delete(accountId);
    if (wasAttached) attachedViewId = null;
  }
  const nv = createViewForAccount(acc);
  viewPool.set(accountId, nv);
  if (lease) {
    // 崩溃前正在后台跑任务 → 重建后仍放回后台窗口，任务可以接着跑
    try { ensureWorkerWin().contentView.addChildView(nv); nv.setBounds(workerBounds()); } catch (e) {}
  } else if (wasAttached && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.addChildView(nv);
    nv.setBounds(getContentBounds());
    attachedViewId = accountId;
  }
  log('视图已重建: ' + accountId + (lease ? '（后台执行中）' : ''));
}

// ---------- 切号核心 ----------
// 说明：这里的「激活」只影响用户在主窗口里看到哪一个页面。
// 正在后台跑任务的账号，页面被 lease 占用，不允许被切到前台，
// 否则用户随手点两下就会把生成中的页面变成 hidden，任务直接卡死。
function setActiveAccount(id) {
  const account = loadAccounts().find(a => a.id === id);
  if (!account) return false;

  if (leases.has(id) && leases.get(id).mode !== 'main') {
    activeAccountId = id;
    prefs.lastActiveId = id;
    savePrefs();
    log('该账号页面正在后台执行任务，保持后台: ' + account.label);
    pushToRenderer('view:locked', {
      id, label: account.label,
      msg: '「' + account.label + '」正在后台执行任务，页面不会切到前台（免得打断生成）'
    });
    return true;
  }

  if (!viewPool.has(id)) {
    viewPool.set(id, createViewForAccount(account));
    log('视图池新建: ' + account.label);
  }
  activeAccountId = id;
  attachToMain(id);
  prefs.lastActiveId = id;
  savePrefs();
  log('切换账号: ' + account.label + ' (池=' + viewPool.size + ')');

  // 兜底: 已登录但仍是默认名的账号, 切过去后给一次识别机会
  if (!account.pending && /^账号\s*\d+$/.test(account.label)) {
    setTimeout(() => tryAutoRename(id, false), 4000);
  }
  return true;
}

function getActiveView() {
  if (!activeAccountId) return null;
  const v = viewPool.get(activeAccountId);
  return (v && !v.webContents.isDestroyed()) ? v : null;
}

// ---------- 登录监控 ----------
function clearMonitor(id) {
  const m = monitors.get(id);
  if (m) {
    if (m.timer) clearInterval(m.timer);
    if (m.diag) clearInterval(m.diag);
    monitors.delete(id);
  }
}

async function checkStrongCookie(accountId) {
  try {
    const cookies = await session.fromPartition('persist:' + accountId).cookies.get({ domain: '.doubao.com' });
    return cookies.some(c => !ANON_RE.test(c.name) && AUTH_RE.test(c.name));
  } catch (e) { return false; }
}

function startLoginMonitor(accountId) {
  if (monitors.has(accountId)) return; // 防重入
  const m = { timer: null, diag: null, done: false };
  monitors.set(accountId, m);

  const getViewWC = () => {
    const v = viewPool.get(accountId);
    return (v && !v.webContents.isDestroyed()) ? v.webContents : null;
  };

  const finish = async (how) => {
    if (m.done) return;
    m.done = true;
    clearMonitor(accountId);
    const list = loadAccounts();
    const acc = list.find(a => a.id === accountId);
    if (!acc) return;

    if (how === 'success') {
      acc.pending = false;
      acc.addedAt = Date.now();
      saveAccounts(list);
      markBadge(accountId, 'online');
      pushToRenderer('account:ready', { id: accountId, label: acc.label });
      // 登录成功后自动识别昵称(走统一的多策略识别)
      setTimeout(() => tryAutoRename(accountId, false), 2000);
    } else {
      markBadge(accountId, 'pending');
      pushToRenderer('account:login-timeout', { id: accountId });
    }
  };

  const pollAll = async () => {
    if (m.done) return;
    const hasAuth = await checkStrongCookie(accountId);
    if (hasAuth) {
      log('登录成功(强凭证cookie): ' + accountId);
      finish('success');
    }
  };

  const wc = getViewWC();
  if (wc) {
    wc.on('did-navigate', pollAll);
    wc.on('did-navigate-in-page', pollAll);
    wc.once('did-finish-load', () => {
      setTimeout(() => {
        if (!m.done) {
          pollAll();
          m.timer = setInterval(pollAll, 2000);
        }
      }, 2500);
    });
    // 诊断日志: 每 10 秒一条, 仅登录期
    m.diag = setInterval(async () => {
      const w2 = getViewWC();
      if (!w2) return;
      try {
        const u = w2.getURL();
        log('[登录诊断] ' + accountId + ' url=' + u.slice(0, 90));
      } catch (e) {}
    }, 10000);
  }
  // 5 分钟超时(保持待登录状态, 用户可继续扫码或删除)
  setTimeout(() => { if (!m.done) finish('timeout'); }, 5 * 60 * 1000);
}

// 点添加账号: 新建视图, 直接在视图里扫码, 检测到凭证自动转正
function startLoginInView(providerId) {
  return new Promise((resolve) => {
    const tempId = 'acct-' + Date.now();
    const prov = providerStore.get(providerId || 'doubao');
    const accounts = loadAccounts();
    // 编号取现有"账号 N"的最大值+1, 避免并发添加时重名
    let maxN = 0;
    accounts.forEach(a => {
      const m = /^账号\s*(\d+)$/.exec(a.label);
      if (m) { const n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
    });
    const account = {
      id: tempId,
      label: (prov.id === 'doubao' ? '账号 ' : prov.name + ' ') + (maxN + 1),
      providerId: prov.id,
      color: PALETTE[accounts.length % PALETTE.length],
      note: '',
      addedAt: Date.now(),
      pending: true
    };
    accounts.push(account);
    saveAccounts(accounts);
    markBadge(tempId, 'pending');
    setActiveAccount(tempId);
    log('视图内登录开始: ' + tempId + '（平台：' + prov.name + '）');
    startLoginMonitor(tempId);
    resolve({ id: tempId, label: account.label });
  });
}

// ---------- 保活/掉线检测(强凭证版, 每 45 秒) ----------
function startKeepAlive() {
  setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const accounts = loadAccounts();
    for (const acc of accounts) {
      if (acc.pending) continue;
      const has = await checkStrongCookie(acc.id);
      const cur = badges.get(acc.id) || 'online';
      if (!has && cur !== 'offline') {
        markBadge(acc.id, 'offline');
        log('检测到掉线(凭证消失): ' + acc.label);
        const list = loadAccounts();
        const a = list.find(x => x.id === acc.id);
        if (a) { a.pending = true; saveAccounts(list); }
        pushToRenderer('account:logout', { id: acc.id, label: acc.label });
      } else if (has && cur === 'offline') {
        // 凭证又回来了(用户在同一视图重新登录)
        const list = loadAccounts();
        const a = list.find(x => x.id === acc.id);
        if (a) { a.pending = false; saveAccounts(list); }
        markBadge(acc.id, 'online');
        pushToRenderer('account:ready', { id: acc.id, label: a ? a.label : acc.label });
      }
    }
  }, 45000);
}

// ---------- 删除账号(含分区清理三连兜底 + 待清扫机制) ----------
async function deleteAccountDeep(id) {
  // 1. 清监控与视图(释放句柄)
  clearMonitor(id);
  leases.delete(id);
  if (autoAccountId === id) autoAccountId = null;
  if (viewPool.has(id)) {
    try { mainWindow.contentView.removeChildView(viewPool.get(id)); } catch (e) {}
    try { if (workerWin && !workerWin.isDestroyed()) workerWin.contentView.removeChildView(viewPool.get(id)); } catch (e) {}
    try { viewPool.get(id).webContents.close(); } catch (e) {}
    viewPool.delete(id);
    if (activeAccountId === id) activeAccountId = null;
    if (attachedViewId === id) attachedViewId = null;
  }
  // 2. 清内存态 session 数据
  try {
    const ses = session.fromPartition('persist:' + id);
    await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
    await ses.clearCache();
  } catch (e) { log('session 清理失败: ' + e.message); }
  await new Promise(r => setTimeout(r, 250));

  // 3. 删分区目录: fs.rmSync → PowerShell .NET → cmd rmdir
  const partDir = path.join(USER_DIR, 'Partitions', id);
  if (!fs.existsSync(partDir)) { log('分区目录不存在: ' + id); return; }
  let cleaned = false;
  try {
    fs.rmSync(partDir, { recursive: true, force: true });
    cleaned = !fs.existsSync(partDir);
  } catch (e1) { log('rmSync 失败: ' + e1.message); }
  if (!cleaned) {
    try {
      const psScript = "$t='" + partDir.replace(/\\/g, '\\\\') + "'; if (Test-Path -LiteralPath $t) { [System.IO.Directory]::Delete($t, $true) }";
      require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], { stdio: 'ignore', timeout: 10000 });
      cleaned = !fs.existsSync(partDir);
    } catch (e2) {}
  }
  if (!cleaned) {
    try {
      require('child_process').execFileSync('cmd.exe', ['/c', 'rmdir', '/S', '/Q', partDir], { stdio: 'ignore', timeout: 10000 });
      cleaned = !fs.existsSync(partDir);
    } catch (e3) {}
  }
  if (!cleaned) {
    log('三种删除均失败, 记入待清扫: ' + id);
    try {
      const pendFile = path.join(USER_DIR, 'pending-cleanup.json');
      let pend = [];
      if (fs.existsSync(pendFile)) pend = JSON.parse(fs.readFileSync(pendFile, 'utf-8') || '[]');
      if (pend.indexOf(id) < 0) pend.push(id);
      fs.writeFileSync(pendFile, JSON.stringify(pend, null, 2));
    } catch (e4) {}
  } else {
    log('分区已清除: ' + id);
  }
  // 4. 顺带清掉该账号的下载目录(若有)
  const dlDir = path.join(DOWNLOAD_DIR, id);
  try {
    if (fs.existsSync(dlDir)) {
      const left = fs.readdirSync(dlDir);
      if (left.length === 0) {
        fs.rmdirSync(dlDir);
        log('已清理空下载目录: ' + id);
      } else {
        log('下载目录有文件, 保留待用户处理: ' + dlDir + ' (' + left.length + ' 项)');
      }
    }
  } catch (e5) {}
}

function sweepPendingCleanups() {
  try {
    const pendFile = path.join(USER_DIR, 'pending-cleanup.json');
    if (!fs.existsSync(pendFile)) return;
    const pend = JSON.parse(fs.readFileSync(pendFile, 'utf-8') || '[]');
    if (!pend.length) return;
    const remaining = [];
    for (const id of pend) {
      const p = path.join(USER_DIR, 'Partitions', id);
      if (fs.existsSync(p)) {
        try { fs.rmSync(p, { recursive: true, force: true }); log('启动清扫分区: ' + id); }
        catch (e) { remaining.push(id); }
      }
    }
    fs.writeFileSync(pendFile, JSON.stringify(remaining, null, 2));
  } catch (e) { log('sweepPendingCleanups 异常: ' + e.message); }
}

// ---------- 推送到渲染层 ----------
function pushToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------- 主窗口 ----------
function createMainWindow() {
  const b = prefs.winBounds || {};
  mainWindow = new BrowserWindow({
    width: b.width || 1500,
    height: b.height || 940,
    x: (typeof b.x === 'number') ? b.x : undefined,
    y: (typeof b.y === 'number') ? b.y : undefined,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0A0D11',
    title: APP_NAME,
    show: false,
    icon: path.join(APP_DIR, 'app.ico'),
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => { mainWindow.show(); });

  // 尺寸变化同步给当前挂着的视图
  const syncBounds = () => {
    if (ext && ext.isTasksMode()) return;
    if (attachedViewId && viewPool.has(attachedViewId)) {
      try { viewPool.get(attachedViewId).setBounds(getContentBounds()); } catch (e) {}
    }
  };
  mainWindow.on('resize', syncBounds);
  mainWindow.on('maximize', syncBounds);
  mainWindow.on('restore', syncBounds);
  mainWindow.on('enter-full-screen', syncBounds);
  mainWindow.on('leave-full-screen', syncBounds);

  // 记录窗口位置
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    prefs.winBounds = mainWindow.getBounds();
    savePrefs();
  };
  mainWindow.on('close', (e) => {
    saveBounds();
    if (prefs.closeToTray && !forceQuitting.value) {
      e.preventDefault();
      mainWindow.hide();
      if (tray) {
        try { tray.displayBalloon({ title: APP_NAME, content: '已最小化到托盘, 双击图标可恢复。' }); } catch (e2) {}
      }
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; activeAccountId = null; });
  loadPage(mainWindow, 'index.html');

  // 仅调试：LEON_SHOT=1 时等首页加载完自动存一张窗口截图（出厂不带这个环境变量就不会触发）
  if (process.env.LEON_SHOT === '1') {
    let shotTaken = false;
    const takeShot = async (why) => {
      if (shotTaken) return;
      shotTaken = true;
      await new Promise((r) => setTimeout(r, 2200));
      try {
        const img = await mainWindow.webContents.capturePage();
        const buf = img.toPNG();
        if (buf && buf.length) fs.writeFileSync(path.join(DATA_DIR, '_shot_main.png'), buf);
        log('窗口截图(' + why + ') 字节数=' + (buf ? buf.length : 0));
      } catch (e) { log('截图失败: ' + e.message); }
    };
    mainWindow.webContents.once('did-finish-load', () => takeShot('did-finish-load'));
    mainWindow.webContents.once('dom-ready', () => takeShot('dom-ready'));
    setTimeout(() => takeShot('fallback'), 8000);
  }

  // ---------- 仅调试：--shot 自动截取各视图（不带参数不会触发） ----------
  if (process.env.LEON_CAPTURE === '1') {
    log('截图模式已启用');
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    setTimeout(async () => {
      try {
        require('fs').writeFileSync(path.join(DATA_DIR, '_shot_marker.txt'), 'fired ' + new Date().toISOString());
        const wc = mainWindow.webContents;
        const views = ['board', 'accounts', 'platforms', 'outputs', 'settings', 'about'];
        for (const v of views) {
          await wc.executeJavaScript("window.App && window.App.setView('" + v + "')").catch(() => {});
          await delay(800);
          const img = await wc.capturePage();
          fs.writeFileSync(path.join(DATA_DIR, '_shot_' + v + '.png'), img.toPNG());
          log('已截图: ' + v);
        }
        await wc.executeJavaScript("window.App.setView('board');window.App.openCreate()").catch(() => {});
        await delay(700);
        let img2 = await wc.capturePage();
        fs.writeFileSync(path.join(DATA_DIR, '_shot_create_ecom.png'), img2.toPNG());
        await wc.executeJavaScript("document.querySelector('#modeSwitch .ms-item[data-mode=other]').click()").catch(() => {});
        await delay(700);
        img2 = await wc.capturePage();
        fs.writeFileSync(path.join(DATA_DIR, '_shot_create_other.png'), img2.toPNG());
        log('截图完成');
      } catch (e) { log('截图失败: ' + (e && e.message)); }
      setTimeout(() => { try { forceQuitting.value = true; app.exit(0); } catch (e) {} }, 400);
    }, 6000);
  }
}

// ---------- 缩放(作用于豆包页面本身) ----------
function zoomActive(delta) {
  const v = getActiveView();
  if (!v) return;
  let lvl = v.webContents.getZoomLevel();
  let next = delta === 0 ? 0 : Math.max(-4, Math.min(4, lvl + delta));
  v.webContents.setZoomLevel(next);
}

function reloadActiveView() {
  const v = getActiveView();
  if (!v) return;
  const acc = loadAccounts().find(a => a.id === activeAccountId);
  const prov = providerOf(acc);
  v.__retries = 0;
  v.webContents.loadURL(prov.chatUrl || prov.loginUrl || DOUBAO_URL).catch(() => {});
}

function selectByIndex(i) {
  const accounts = loadAccounts();
  if (i < 0 || i >= accounts.length) return;
  setActiveAccount(accounts[i].id);
  pushToRenderer('active:changed', { id: accounts[i].id });
}

// ---------- 应用菜单 ----------
function buildAppMenu() {
  const template = [
    {
      label: '文件(&F)',
      submenu: [
        { label: '添加账号', accelerator: 'CmdOrCtrl+N', click: () => pushToRenderer('menu:addAccount') },
        { label: '打开下载目录', click: () => { try { fs.mkdirSync(DOWNLOAD_DIR, { recursive: true }); } catch (e) {} openFolderSafe(DOWNLOAD_DIR); } },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Shift+Q', click: () => { forceQuitting.value = true; app.quit(); } }
      ]
    },
    {
      label: '编辑(&E)',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图(&V)',
      submenu: [
        { label: '重新加载当前页', accelerator: 'CmdOrCtrl+R', click: () => reloadActiveView() },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => zoomActive(+0.5) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => zoomActive(-0.5) },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => zoomActive(0) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '切换(&S)',
      submenu: (() => {
        const arr = [];
        for (let i = 1; i <= 9; i++) {
          arr.push({
            label: '第 ' + i + ' 个账号',
            accelerator: 'CmdOrCtrl+' + i,
            click: () => selectByIndex(i - 1)
          });
        }
        return arr;
      })()
    },
    {
      label: '帮助(&H)',
      submenu: [
        {
          label: '关于', click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: APP_NAME,
              detail: '视图池架构 · 单窗口毫秒级切号\n数据目录: ' + USER_DIR + '\n\n原理: 使用 Chromium 分区会话隔离各账号,\n不修改豆包官方程序。'
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- 托盘 ----------
function buildTray() {
  try {
    const icoPath = path.join(APP_DIR, 'app.ico');
    tray = new Tray(nativeImage.createFromPath(icoPath));
  } catch (e) {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip(APP_NAME);
  tray.on('double-click', () => ShowMain());
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const items = [];
  const accounts = loadAccounts();
  for (const acc of accounts.slice(0, 15)) {
    items.push({
      label: ((badges.get(acc.id) === 'offline' || acc.pending) ? '○ ' : '● ') + acc.label,
      click: () => {
        setActiveAccount(acc.id);
        ShowMain();
      }
    });
  }
  if (accounts.length) items.push({ type: 'separator' });
  items.push({ label: '显示主窗口', click: () => ShowMain() });
  items.push({
    label: '退出',
    click: () => { forceQuitting.value = true; app.quit(); }
  });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function ShowMain() {
  if (!mainWindow || mainWindow.isDestroyed()) { createMainWindow(); return; }
  mainWindow.show();
  mainWindow.focus();
}

// ---------- IPC ----------
ipcMain.handle('accounts:list', () => {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const accounts = loadAccounts();
  return accounts.map(a => {
    const prov = providerOf(a);
    return Object.assign({}, a, {
      providerId: a.providerId || 'doubao',
      providerName: prov.name,
      providerKind: prov.kind,
      badge: a.pending ? 'pending'
        : (a.quotaDate === today ? 'quota' : (badges.get(a.id) || 'online')),
      quotaNote: a.quotaDate === today ? (a.quotaNote || '今日视频额度已用完') : ''
    });
  });
});
// ---------- AI 平台注册表：内置豆包，其余平台用户自己加 ----------
ipcMain.handle('providers:list', () => providerStore.list().map(p => Object.assign({}, p)));
ipcMain.handle('providers:add', (e, input) => providerStore.add(input || {}));
ipcMain.handle('providers:update', (e, id, patch) => providerStore.update(id, patch || {}));
ipcMain.handle('providers:remove', (e, id) => providerStore.remove(id));

ipcMain.handle('accounts:add', async (e, providerId) => await startLoginInView(providerId));
ipcMain.handle('accounts:select', (e, id) => { setActiveAccount(id); return true; });
ipcMain.handle('accounts:rename', (e, payload) => {
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.id === payload.id);
  if (acc) { acc.label = String(payload.label).trim().slice(0, 20); saveAccounts(accounts); }
  return accounts;
});
ipcMain.handle('accounts:delete', async (e, id) => {
  const accounts = loadAccounts().filter(a => a.id !== id);
  saveAccounts(accounts);
  badges.delete(id);
  nameAttempts.delete(id);
  await deleteAccountDeep(id);
  rebuildTrayMenu();
  return accounts;
});
ipcMain.handle('accounts:detectName', async (e, id) => {
  const list = loadAccounts();
  const acc = list.find(a => a.id === id);
  if (!acc || acc.pending) return { ok: false, msg: '账号待登录' };
  const v = viewPool.get(id);
  if (!v || v.webContents.isDestroyed()) return { ok: false, msg: '请先切换到该账号(视图未加载)' };
  try {
    const res = await v.webContents.executeJavaScript(DETECT_NAME_SCRIPT, true);
    const name = res && res.name ? String(res.name).trim() : '';
    if (name) {
      acc.label = name;
      saveAccounts(list);
      pushToRenderer('account:ready', { id, label: name });
      return { ok: true, name };
    }
    return { ok: false, msg: '未能从页面识别到昵称(' + (res ? res.source : '?') + ')' };
  } catch (err) { return { ok: false, msg: err.message }; }
});
ipcMain.handle('prefs:get', () => prefs);
ipcMain.handle('prefs:set', (e, patch) => {
  prefs = Object.assign(prefs, patch || {});
  savePrefs();
  return prefs;
});
// 打开目录：以前用 shell.openExternal('file:///...')，Windows 上会抛
// 「Failed to open: 系统找不到指定的文件」而且没人 catch，结果就是点了毫无反应。
// 这里统一走 shell.openPath（内部走 ShellExecute，中文路径也认），失败再用 explorer.exe 兜一层。
function openFolderSafe(dir) {
  let d = dir;
  try {
    if (!d) d = DOWNLOAD_DIR;
    d = path.normalize(d);
    // 目录不存在就往上找一个存在的，别把浏览器的报错弹出来
    let guard = 0;
    while (d && !fs.existsSync(d) && guard++ < 8) {
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
    if (!d || !fs.existsSync(d)) { log('打开目录失败：路径不存在 ' + dir); return false; }
    let ret = null;
    try { ret = shell.openPath(d); } catch (e) { log('openPath 抛错: ' + e.message); }
    if (ret && typeof ret.then === 'function') {
      ret.then((err) => {
        if (err) {
          log('openPath 返回错误，改用 explorer: ' + err);
          try { require('child_process').spawn('explorer.exe', [d], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { log('explorer 也失败: ' + e.message); }
        }
      }).catch((err) => { log('openPath 失败: ' + (err && err.message)); });
    } else if (typeof ret === 'string' && ret) {
      log('openPath 返回错误，改用 explorer: ' + ret);
      try { require('child_process').spawn('explorer.exe', [d], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {}
    }
    log('已打开目录: ' + d);
    return true;
  } catch (e) { log('打开目录异常: ' + e.message); return false; }
}

ipcMain.handle('downloads:openFolder', (e, dir) => {
  try {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    // 优先打开调用方给的目录（比如这次下载实际落在哪），并且只允许开数据目录下的路径
    let target = DOWNLOAD_DIR;
    if (dir && typeof dir === 'string') {
      const abs = path.resolve(dir);
      const root = path.resolve(DATA_DIR);
      if (abs.toLowerCase().startsWith(root.toLowerCase()) && fs.existsSync(abs)) target = abs;
    }
    return openFolderSafe(target);
  } catch (err) { log('打开下载目录失败: ' + err.message); return false; }
});


// ---------- 装配任务流水线扩展 ----------
ext = EXT.create({
  app, USER_DIR, DOWNLOAD_DIR, log,
  providerOf, providerStore,
  loadAccounts, saveAccounts, setActiveAccount, createViewForAccount, viewPool, badges,
  pushToRenderer,
  mainWindow: () => mainWindow,
  getActiveId: () => activeAccountId,
  getContentBounds,
  getPrefs: () => prefs,
  savePrefs,
  // 后台执行相关
  leaseView, releaseView, takeoverView, isLeased, ensureWorkerWin,
  leasedIds: () => [...leases.keys()],
  detachView: (id) => detachFromMain(id),
  getAutoId: () => autoAccountId,
  setAutoId: (id) => {
    autoAccountId = id || null;
    // 记住「最近一次跑任务的号」，任务结束后用户点「看页面」看到的就是它
    if (id) { activeAccountId = id; prefs.lastActiveId = id; savePrefs(); }
  }
});
log('流水线扩展已装配');

// ---------- 单实例 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => ShowMain());
}

// ---------- 启动流程 ----------
app.whenReady().then(() => {
  log('app ready, userData=' + app.getPath('userData'));
  sweepPendingCleanups();
  buildAppMenu();
  buildTray();
  createMainWindow();
  startKeepAlive();
  // 后台执行窗口提前建好：第一个任务开始时不用等窗口创建
  setTimeout(() => { try { ensureWorkerWin(); } catch (e) { log('后台执行窗口预建失败: ' + e.message); } }, 600);
  setTimeout(bootWarmup, 800);
  setInterval(rebuildTrayMenu, 15000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}).catch((e) => log('whenReady 失败: ' + e.message));

// 启动预热: 恢复上次激活账号; 其余已登录账号后台建视图(全部在线+触发昵称识别)
function bootWarmup() {
  const accounts = loadAccounts();
  if (!accounts.length) return;
  let target = accounts.find(a => a.id === prefs.lastActiveId && !a.pending);
  if (!target) target = accounts.find(a => !a.pending);
  if (!target) target = accounts[0];
  try { setActiveAccount(target.id); } catch (e) { log('warmup 激活失败: ' + e.message); }

  const others = accounts.filter(a => a.id !== target.id && !a.pending);
  others.forEach((acc, i) => {
    setTimeout(() => {
      if (!viewPool.has(acc.id)) {
        viewPool.set(acc.id, createViewForAccount(acc));
        log('后台预热视图: ' + acc.label);
      }
    }, 2500 + i * 1500);
  });
}

app.on('window-all-closed', () => {
  log('所有窗口关闭, 退出');
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  log(forceQuitting.value ? '正常退出流程' : '收到退出请求(来源未标记)');
});

// 子进程(GPU/渲染器等)异常退出追踪
app.on('child-process-gone', (e, details) => {
  log('child-process-gone: type=' + details.type + ' reason=' + details.reason + ' exitCode=' + details.exitCode);
});

process.on('uncaughtException', (err) => log('uncaughtException: ' + err.message + '\n' + (err.stack || '')));
process.on('unhandledRejection', (err) => log('unhandledRejection: ' + String(err)));
