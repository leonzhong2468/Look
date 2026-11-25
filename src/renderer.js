// ============================================================
//  界面骨架：导航 / 面板 / 舞台 / 账号 / 平台 / 设置 / 关于
//  （任务相关逻辑在 task-ui.js）
// ============================================================
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const state = {
  view: 'board',
  tasks: [],
  accounts: [],
  providers: [],
  taskId: '',
  accountId: '',
  live: false,        // 主舞台是否被账号页面占着
  liveFrom: 'board',  // 从哪一页进的账号页面：board=工作台、accounts=账号矩阵
  prefs: {},
  info: null,
  keyword: ''
};

// ---------- 通用 UI ----------
function toast(msg, type) {
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(12px)';
    setTimeout(() => el.remove(), 260);
  }, 3600);
}

// 通用弹层
function dialog(opts) {
  const { title = '提示', sub = '', body = '', hint = '', buttons = [{ label: '知道了', primary: true }], onClose } = opts || {};
  $('dlgTitle').textContent = title;
  $('dlgSub').textContent = sub;
  $('dlgBody').innerHTML = body;
  $('dlgHint').textContent = hint;
  const btns = $('dlgBtns');
  btns.innerHTML = '';
  buttons.forEach((b) => {
    const el = document.createElement('button');
    el.className = 'btn ' + (b.primary ? 'primary' : 'ghost') + (b.danger ? ' danger' : '');
    el.textContent = b.label;
    el.addEventListener('click', async () => {
      let keep = false;
      if (b.onClick) keep = (await b.onClick()) === false;
      if (!keep) closeDialog();
    });
    btns.appendChild(el);
  });
  $('maskDialog').classList.remove('hidden');
  dialog._onClose = onClose || null;
  return $('dlgBody');
}
function closeDialog() {
  $('maskDialog').classList.add('hidden');
  if (dialog._onClose) { const f = dialog._onClose; dialog._onClose = null; f(); }
}

// ---------- 主题 ----------
function applyTheme(name) {
  document.body.dataset.theme = name === 'light' ? 'light' : 'dark';
  const btn = $('btnTheme');
  btn.innerHTML = '<svg><use href="#' + (name === 'light' ? 'i-sun' : 'i-moon') + '"/></svg>';
  btn.title = name === 'light' ? '切到深色' : '切到浅色';
}
async function toggleTheme() {
  const next = document.body.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  state.prefs.theme = next;
  try { await api.prefsSet({ theme: next }); } catch (e) {}
}

// ---------- 导航 ----------
const VIEW_META = {
  board: { title: '任务', sub: 'TASKS', action: 'new' },
  accounts: { title: '账号矩阵', sub: 'ACCOUNTS', action: 'account' },
  platforms: { title: 'AI 平台', sub: 'PROVIDERS', action: 'provider' },
  outputs: { title: '产出库', sub: 'OUTPUTS', action: 'none' },
  settings: { title: '设置', sub: 'SETTINGS', action: 'none' },
  about: { title: '关于', sub: 'ABOUT', action: 'none' }
};

function setView(view) {
  state.view = view;
  if (view !== 'accounts') leaveLivePage();
  document.querySelectorAll('.rail-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  const meta = VIEW_META[view] || VIEW_META.board;
  $('panelTitle').textContent = meta.title;
  $('panelSub').textContent = meta.sub;
  const act = $('btnPanelAction');
  if (meta.action === 'none') act.classList.add('hidden');
  else {
    act.classList.remove('hidden');
    act.innerHTML = '<svg><use href="#i-plus"/></svg>';
    act.title = meta.action === 'new' ? '新建任务' : meta.action === 'account' ? '添加账号' : '添加平台';
  }
  ['board', 'accounts', 'platforms', 'outputs', 'settings', 'about'].forEach((v) => {
    const el = $('view' + v.charAt(0).toUpperCase() + v.slice(1));
    if (el) el.classList.add('hidden');
  });
  $('viewBoardEmpty').classList.toggle('hidden', view !== 'board' || !!state.taskId);
  $('viewTask').classList.toggle('hidden', view !== 'board' || !state.taskId);
  const stageView = { accounts: 'viewAccounts', platforms: 'viewPlatforms', outputs: 'viewOutputs', settings: 'viewSettings', about: 'viewAbout' }[view];
  if (stageView) $(stageView).classList.remove('hidden');
  renderPanel();
  renderStage();
}

// ---------- 面板 ----------
function renderPanel() {
  const body = $('panelBody');
  const v = state.view;
  if (v === 'board') return renderPanelTasks(body);
  if (v === 'accounts') return renderPanelAccounts(body);
  if (v === 'platforms') return renderPanelProviders(body);
  if (v === 'outputs') return renderPanelOutputs(body);
  if (v === 'settings') return renderPanelSettings(body);
  if (v === 'about') return renderPanelAbout(body);
}

function renderPanelTasks(body) {
  body.innerHTML = '';
  const add = document.createElement('button');
  add.className = 'btn primary panel-top-btn';
  add.style.cssText = 'width:100%;margin-bottom:10px;';
  add.innerHTML = '<svg><use href="#i-plus"/></svg>新建任务';
  add.addEventListener('click', () => openCreate());
  body.appendChild(add);

  const groups = [
    { key: 'running', label: '运行中', test: (t) => t.status === 'running' || t.status === 'queued' },
    { key: 'review', label: '待验收', test: (t) => t.status === 'review' || t.status === 'done' },
    { key: 'paused', label: '暂停 / 待续', test: (t) => t.status === 'paused' || t.status === 'draft' },
    { key: 'failed', label: '失败', test: (t) => t.status === 'failed' }
  ];
  const total = state.tasks.length;
  if (!total) {
    body.innerHTML += '<div class="empty"><svg><use href="#i-layers"/></svg><b>还没有任务</b><p>点「新建任务」，拖一张<br>产品图进来</p></div>';
    return;
  }
  groups.forEach((g) => {
    const list = state.tasks.filter(g.test);
    if (!list.length) return;
    const head = document.createElement('div');
    head.className = 'pgroup';
    head.innerHTML = '<span>' + g.label + '</span><span class="pg-count">' + list.length + '</span>';
    body.appendChild(head);
    list.forEach((t) => body.appendChild(taskCardEl(t)));
  });
}

function taskCardEl(t) {
  const el = document.createElement('div');
  el.className = 'tcard' + (t.id === state.taskId ? ' active' : '');
  const st = t.status || 'draft';
  const thumb = t.thumb
    ? '<img src="' + esc(api.toFileUrl(t.thumb)) + '" alt="">'
    : '<svg><use href="#' + (t.mode === 'other' ? 'i-sparkle' : 'i-image') + '"/></svg>';
  const label = st === 'running' ? (t.stepText || '执行中')
    : st === 'queued' ? '排队中'
    : st === 'review' ? '待验收'
    : st === 'done' ? '已完成'
    : st === 'failed' ? (t.error ? '失败' : '失败')
    : st === 'paused' ? '已暂停' : '待开始';
  const kind = t.mode === 'other' ? (t.params && t.params.videoKind ? kindName(t.params.videoKind) : '其他视频') : '电商视频';
  el.innerHTML =
    '<div class="tcard-thumb">' + thumb + '</div>' +
    '<div class="tcard-main">' +
      '<div class="tcard-title">' + esc((t.params && t.params.name) || t.title || '未命名') + '</div>' +
      '<div class="tcard-meta"><i class="tcard-dot ' + st + '"></i><span>' + esc(label) + '</span><span>·</span><span>' + esc(kind) + '</span></div>' +
    '</div>';
  el.addEventListener('click', () => selectTask(t.id));
  return el;
}

function renderPanelAccounts(body) {
  body.innerHTML = '';
  const add = document.createElement('button');
  add.className = 'btn primary panel-top-btn';
  add.style.cssText = 'width:100%;margin-bottom:10px;';
  add.innerHTML = '<svg><use href="#i-plus"/></svg>添加账号';
  add.addEventListener('click', addAccountFlow);
  body.appendChild(add);

  if (!state.accounts.length) {
    // 注意：这里不能用 body.innerHTML += ，会把上面两个按钮重建、监听一起丢掉
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<svg><use href="#i-users"/></svg><b>还没有账号</b><p>点「添加账号」→ 扫码登录<br>同平台可加多个号并行跑</p>';
    body.appendChild(empty);
    return;
  }
  const byProv = {};
  state.accounts.forEach((a) => {
    const k = a.providerName || '豆包';
    (byProv[k] = byProv[k] || []).push(a);
  });
  Object.keys(byProv).forEach((k) => {
    const head = document.createElement('div');
    head.className = 'pgroup';
    head.innerHTML = '<span>' + esc(k) + '</span><span class="pg-count">' + byProv[k].length + '</span>';
    body.appendChild(head);
    byProv[k].forEach((a) => body.appendChild(accRowEl(a)));
  });
}

function accRowEl(a) {
  const el = document.createElement('div');
  el.className = 'accrow' + (a.id === state.accountId ? ' active' : '');
  const initial = String(a.label || '?').trim().slice(0, 1) || '?';
  const badge = a.badge || 'online';
  const badgeText = { online: '在线', offline: '掉线', pending: '待登录', quota: '额度用完', loadfail: '加载失败' }[badge] || badge;
  el.innerHTML =
    '<div class="acc-ava" style="background:' + esc(a.color || '#4F86F7') + '">' + esc(initial) + '</div>' +
    '<div class="acc-main">' +
      '<div class="acc-name">' + esc(a.label) + '</div>' +
      '<div class="acc-sub"><i class="acc-badge ' + badge + '"></i>' + esc(badgeText) +
        (a.quotaNote ? '<span>· ' + esc(a.quotaNote) + '</span>' : '') + '</div>' +
    '</div>' +
    '<button class="acc-del" title="删除账号"><svg><use href="#i-trash"/></svg></button>';
  el.addEventListener('click', (ev) => {
    if (ev.target.closest('.acc-del')) return;
    openAccount(a.id);
  });
  el.querySelector('.acc-del').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const ok = await confirmBox('删除账号', '确定删除「' + a.label + '」吗？<br><span style="color:var(--t3)">只会清掉本机保存的登录态，不会影响平台上的账号。</span>');
    if (!ok) return;
    await api.accountsDelete(a.id);
    toast('已删除「' + a.label + '」', 'ok');
    refreshAccounts();
  });
  return el;
}

function renderPanelProviders(body) {
  body.innerHTML = '';
  const add = document.createElement('button');
  add.className = 'btn primary';
  add.style.cssText = 'width:100%;margin-bottom:10px;';
  add.innerHTML = '<svg><use href="#i-plus"/></svg>添加 AI 平台';
  add.addEventListener('click', () => openProviderForm(null));
  body.appendChild(add);

  state.providers.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'prow';
    el.innerHTML =
      '<div class="prow-ico"><svg><use href="#i-layers"/></svg></div>' +
      '<div class="prow-main"><div class="prow-name">' + esc(p.name) + '</div>' +
      '<div class="prow-sub">' + (p.builtin ? '内置深度适配' : (p.kind === 'generic' ? '通用适配' : '自定义')) + '</div></div>';
    el.addEventListener('click', () => {
      setView('platforms');
      setTimeout(() => {
        const card = document.querySelector('[data-prov="' + p.id + '"]');
        if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 30);
    });
    body.appendChild(el);
  });
}

function renderPanelOutputs(body) {
  body.innerHTML = '';
  const outs = collectOutputs();
  if (!outs.length) {
    body.innerHTML = '<div class="empty"><svg><use href="#i-folder"/></svg><b>还没有产出</b><p>任务完成后，成片会自动收进这里。</p></div>';
    return;
  }
  outs.slice(0, 60).forEach((o) => {
    const el = document.createElement('div');
    el.className = 'tcard';
    el.innerHTML =
      '<div class="tcard-thumb"><svg><use href="#' + (o.kind === 'video' ? 'i-video' : 'i-image') + '"/></svg></div>' +
      '<div class="tcard-main"><div class="tcard-title">' + esc(o.label) + '</div>' +
      '<div class="tcard-meta"><span>' + esc(o.time) + '</span></div></div>';
    el.addEventListener('click', () => api.taskReveal(o.path));
    body.appendChild(el);
  });
}

function renderPanelSettings(body) {
  body.innerHTML = '';
  const items = [
    { icon: 'i-pulse', title: '页面自检', desc: '检查登录态与页面按钮', run: runDiag },
    { icon: 'i-settings', title: '打开配置文件', desc: 'config.json / 锚点', run: () => api.openConfig() },
    { icon: 'i-folder', title: '打开数据目录', desc: '任务、账号、产出', run: () => api.diagOpenFolder() },
    { icon: 'i-download', title: '打开下载目录', desc: '平台原文件', run: () => api.openDownloads() }
  ];
  items.forEach((it) => {
    const el = document.createElement('div');
    el.className = 'tcard';
    el.innerHTML =
      '<div class="tcard-thumb"><svg><use href="#' + it.icon + '"/></svg></div>' +
      '<div class="tcard-main"><div class="tcard-title">' + it.title + '</div>' +
      '<div class="tcard-meta"><span>' + it.desc + '</span></div></div>';
    el.addEventListener('click', it.run);
    body.appendChild(el);
  });
}

function renderPanelAbout(body) {
  body.innerHTML = '';
  const items = [
    { icon: 'i-help', title: 'AI 使用说明', desc: '把问题交给你的 AI 修', run: openAiGuide },
    { icon: 'i-shield', title: '免责声明', desc: '使用前请读一遍', run: openDisclaimer }
  ];
  items.forEach((it) => {
    const el = document.createElement('div');
    el.className = 'tcard';
    el.innerHTML =
      '<div class="tcard-thumb"><svg><use href="#' + it.icon + '"/></svg></div>' +
      '<div class="tcard-main"><div class="tcard-title">' + it.title + '</div>' +
      '<div class="tcard-meta"><span>' + it.desc + '</span></div></div>';
    el.addEventListener('click', it.run);
    body.appendChild(el);
  });
}

// ---------- 舞台 ----------
function renderStage() {
  const v = state.view;
  if (v === 'board') {
    if (state.taskId) renderTaskDetail(state.taskId);
    else renderHeroStats();
  } else if (v === 'accounts') renderAccountsStage();
  else if (v === 'platforms') renderPlatformsStage();
  else if (v === 'outputs') renderOutputsStage();
  else if (v === 'settings') renderSettingsStage();
  else if (v === 'about') renderAboutStage();
}

function renderHeroStats() {
  const done = state.tasks.filter((t) => t.status === 'done' || t.status === 'review').length;
  const running = state.tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;
  const outs = collectOutputs().length;
  $('heroStats').innerHTML =
    '<div class="hstat"><b>' + state.accounts.filter((a) => a.badge !== 'pending').length + '</b><span>已登录账号</span></div>' +
    '<div class="hstat"><b>' + running + '</b><span>运行中</span></div>' +
    '<div class="hstat"><b>' + done + '</b><span>已完成任务</span></div>' +
    '<div class="hstat"><b>' + outs + '</b><span>产出文件</span></div>';
}

// ---- 账号舞台 ----
function renderAccountsStage() {
  const box = $('viewAccounts');
  const accs = state.accounts;
  box.innerHTML =
    '<div class="card">' +
      '<div class="card-head"><h3><svg><use href="#i-users"/></svg>账号矩阵</h3><span class="ch-sub">' + accs.length + ' 个账号</span></div>' +
      '<div class="card-body">' +
        (accs.length ? '<div class="agrid">' + accs.map(accCardHtml).join('') + '</div>'
          : '<div class="empty"><svg><use href="#i-users"/></svg><b>还没有账号</b><p>点下面按钮，会打开登录页，扫码即可。<br>同一个平台可以加多个号：号越多，能同时跑的片子越多。</p><button class="btn primary" id="btnAddAcc2" style="margin-top:14px">添加账号</button></div>') +
      '</div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-head"><h3><svg><use href="#i-help"/></svg>怎么用</h3></div>' +
      '<div class="card-body"><ol class="about-list">' +
        '<li>点「添加账号」→ 在右侧页面里扫码登录 → 检测到登录后自动转为正式账号。</li>' +
        '<li>账号卡片上会显示在线状态；掉线会标红，点一下重新登录即可。</li>' +
        '<li>新建任务后，流水线会自动挑一个空闲账号；额度用完会自动换下一个。</li>' +
        '<li>想手动看某个号在干什么：点账号卡片，右侧会切到它的页面。</li>' +
      '</ol></div>' +
    '</div>';

  const b = $('btnAddAcc2');
  if (b) b.addEventListener('click', addAccountFlow);
  box.querySelectorAll('[data-acc]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-delacc]')) return;
      openAccount(el.dataset.acc);
    });
  });
  box.querySelectorAll('[data-delacc]').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const a = accs.find((x) => x.id === el.dataset.delacc);
      if (!a) return;
      const ok = await confirmBox('删除账号', '确定删除「' + a.label + '」吗？');
      if (!ok) return;
      await api.accountsDelete(a.id);
      refreshAccounts();
      toast('已删除', 'ok');
    });
  });
}

function accCardHtml(a) {
  const badge = a.badge || 'online';
  const map = { online: ['在线', 'green'], offline: ['掉线', 'rose'], pending: ['待登录', 'amber'], quota: ['额度用完', 'violet'], loadfail: ['加载失败', 'rose'] };
  const [txt, cls] = map[badge] || [badge, ''];
  return '<div class="pcard" data-acc="' + esc(a.id) + '" style="cursor:pointer">' +
    '<div class="pcard-top">' +
      '<div class="acc-ava" style="background:' + esc(a.color || '#4F86F7') + '">' + esc(String(a.label || '?').slice(0, 1)) + '</div>' +
      '<div><div class="pcard-name">' + esc(a.label) + '</div><div class="pcard-vendor">' + esc(a.providerName || '豆包') + '</div></div>' +
    '</div>' +
    '<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">' +
      '<span class="chip ' + cls + '"><i class="acc-badge ' + badge + '"></i>' + txt + '</span>' +
      (a.quotaNote ? '<span class="chip" style="max-width:150px;overflow:hidden;text-overflow:ellipsis">' + esc(a.quotaNote) + '</span>' : '') +
    '</div>' +
    '<div class="pcard-actions">' +
      '<button class="btn sm" data-open="' + esc(a.id) + '">打开页面</button>' +
      '<button class="btn sm danger" data-delacc="' + esc(a.id) + '">删除</button>' +
    '</div>' +
  '</div>';
}

// ---- 平台舞台 ----
function renderPlatformsStage() {
  const box = $('viewPlatforms');
  box.innerHTML =
    '<div class="card">' +
      '<div class="card-head"><h3><svg><use href="#i-layers"/></svg>AI 平台</h3>' +
        '<button class="btn sm" id="btnAddProv2"><svg><use href="#i-plus"/></svg>添加平台</button></div>' +
      '<div class="card-body">' +
        '<div class="hint" style="margin-bottom:14px;">内置豆包做了深度适配（图像 / 视频面板、成片回收都调过）。' +
        '其他平台只要能在网页上登录、能对话，就能加成多开平台：填个名字和对话页地址就行。' +
        '遇到结构特殊的站点，让 AI 帮你改 <b>lib/gen-agent.js</b> 里的选择器。</div>' +
        '<div class="pgrid">' + state.providers.map(provCardHtml).join('') + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-head"><h3><svg><use href="#i-help"/></svg>能加哪些平台</h3></div>' +
      '<div class="card-body"><ol class="about-list">' +
        '<li><b>豆包</b> —— 内置，免费图片 / 视频（Seedance）。</li>' +
        '<li><b>WorkBuddy / DeepSeek / 通义 / Kimi / 智谱</b> —— 填对话页地址即可，走通用驱动。</li>' +
        '<li>只做「能网页登录」的平台：登录态存在本机独立分区，互不串号。</li>' +
        '<li>同一个平台可以加多个账号，每个账号一个独立浏览器分区。</li>' +
      '</ol></div>' +
    '</div>';

  $('btnAddProv2').addEventListener('click', () => openProviderForm(null));
  box.querySelectorAll('[data-prov]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return;
      const p = state.providers.find((x) => x.id === el.dataset.prov);
      if (p) openProviderDetail(p);
    });
  });
}

function provCardHtml(p) {
  return '<div class="pcard prow" data-prov="' + esc(p.id) + '">' +
    '<div class="prow-ico"><svg><use href="#i-' + (p.kind === 'doubao' ? 'bolt' : 'layers') + '"/></svg></div>' +
    '<div class="prow-main">' +
      '<div class="prow-name">' + esc(p.name) +
        '<span class="prow-vendor">' + esc(p.vendor || (p.builtin ? '内置' : '自定义')) + '</span>' +
        (p.builtin ? '<span class="chip accent" style="margin-left:2px">内置</span>' : '') +
      '</div>' +
      '<div class="prow-note">' + esc(p.note || (p.kind === 'doubao' ? '深度适配 · 图片 / 视频全流程' : '通用适配 · 对话页即可')) + '</div>' +
      '<div class="prow-url">' + esc(p.chatUrl || '') + '</div>' +
    '</div>' +
    '<div class="prow-actions">' +
      (p.builtin ? '' :
        '<button class="btn sm" data-edit="' + esc(p.id) + '">编辑</button>' +
        '<button class="btn sm danger" data-delprov="' + esc(p.id) + '">删除</button>') +
      '<button class="btn sm" data-addacc="' + esc(p.id) + '">加账号</button>' +
    '</div>' +
  '</div>';
}

// ---- 产出库 ----
function collectOutputs() {
  const list = [];
  state.tasks.forEach((t) => {
    (t.outputs || []).forEach((o) => {
      list.push({ path: o.path, kind: o.kind, url: o.url, label: (t.params && t.params.name || '产出') + ' · ' + (o.label || ''), at: o.at || 0, time: fmtTime(o.at) });
    });
    if (t.video && !(t.outputs || []).some((o) => o.path === t.video)) {
      list.push({ path: t.video, kind: 'video', url: t.videoUrl, label: (t.params && t.params.name || '成片'), at: t.finishedAt || t.createdAt || 0, time: fmtTime(t.finishedAt || t.createdAt) });
    }
  });
  return list.sort((a, b) => (b.at || 0) - (a.at || 0));
}

function renderOutputsStage() {
  const box = $('viewOutputs');
  const outs = collectOutputs();
  if (!outs.length) {
    box.innerHTML = '<div class="card"><div class="card-body"><div class="empty"><svg><use href="#i-folder"/></svg><b>还没有产出</b><p>任务完成后，成片会自动收进这里；也可以直接在任务详情里打开文件夹。</p></div></div></div>';
    return;
  }
  box.innerHTML = '<div class="card">' +
    '<div class="card-head"><h3><svg><use href="#i-folder"/></svg>产出库</h3><span class="ch-sub">' + outs.length + ' 个文件</span></div>' +
    '<div class="card-body"><div class="ogrid">' +
    outs.map((o) => '<div class="ocard" data-path="' + esc(o.path) + '">' +
      '<div class="ocard-media">' +
        (o.kind === 'video'
          ? '<video src="' + esc(o.url) + '" muted preload="metadata"></video>'
          : '<img src="' + esc(o.url) + '" alt="">') +
      '</div>' +
      '<div class="ocard-info"><b>' + esc(o.label) + '</b><span>' + esc(o.time) + '</span></div>' +
    '</div>').join('') +
    '</div></div></div>';
  box.querySelectorAll('[data-path]').forEach((el) => {
    el.addEventListener('click', () => api.taskReveal(el.dataset.path));
  });
}

// ---- 设置 ----
function renderSettingsStage() {
  const box = $('viewSettings');
  box.innerHTML =
    '<div class="card">' +
      '<div class="card-head"><h3><svg><use href="#i-settings"/></svg>通用</h3></div>' +
      '<div class="card-body">' +
        '<div class="setrow"><div class="sr-main"><b>关闭按钮最小化到托盘</b><p>关掉窗口但让流水线继续在后台跑</p></div>' +
          '<label class="switch"><input type="checkbox" id="swTray"><i></i></label></div>' +
        '<div class="setrow"><div class="sr-main"><b>任务完成后自动回到看板</b><p>执行完一条片子自动把页面切回任务详情</p></div>' +
          '<label class="switch"><input type="checkbox" id="swAutoBoard"><i></i></label></div>' +
      '</div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-head"><h3><svg><use href="#i-pulse"/></svg>环境与自检</h3>' +
        '<button class="btn sm" id="btnDiag2"><svg><use href="#i-play"/></svg>开始自检</button></div>' +
      '<div class="card-body"><div id="diagBox" class="hint">自检会占用一个账号的页面，跑一次大约 30 秒，能定位「登录态 / 输入框 / 图像入口 / 视频入口」哪一步对不上。</div>' +
        '<div class="setrow" style="margin-top:6px;border-top:1px solid var(--border);padding-top:12px">' +
          '<div class="sr-main"><b>环境检测与一键修复（独立程序）</b><p>程序打不开、白屏、卡住、账号老掉线时先跑它：查运行时文件、目录权限、残留进程、网络连通，并一键清缓存</p></div>' +
          '<button class="btn sm" id="btnDoctor">打开</button></div>' +
      '</div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-head"><h3><svg><use href="#i-folder"/></svg>目录</h3></div>' +
      '<div class="card-body">' +
        '<div class="setrow"><div class="sr-main"><b>数据目录</b><p id="dirUser">-</p></div><button class="btn sm" id="btnOpenUser">打开</button></div>' +
        '<div class="setrow"><div class="sr-main"><b>配置文件</b><p id="dirCfg">-</p></div><button class="btn sm" id="btnOpenCfg">打开</button></div>' +
        '<div class="setrow"><div class="sr-main"><b>下载目录</b><p>平台导出的原始文件</p></div><button class="btn sm" id="btnOpenDl">打开</button></div>' +
      '</div>' +
    '</div>';

  $('swTray').checked = !!state.prefs.closeToTray;
  $('swTray').addEventListener('change', async (e) => { state.prefs.closeToTray = e.target.checked; await api.prefsSet({ closeToTray: e.target.checked }); });
  $('swAutoBoard').checked = state.prefs.autoSwitchToBoard !== false;
  $('swAutoBoard').addEventListener('change', async (e) => { state.prefs.autoSwitchToBoard = e.target.checked; await api.prefsSet({ autoSwitchToBoard: e.target.checked }); });
  $('btnDiag2').addEventListener('click', runDiag);
  const bd = $('btnDoctor');
  if (bd) bd.addEventListener('click', async () => {
    const r = await api.toolsDoctor();
    if (r && r.ok) toast('已打开环境检测程序', 'ok');
    else toast((r && r.err) || '没找到检测程序', 'err');
  });
  $('btnOpenUser').addEventListener('click', () => api.diagOpenFolder());
  $('btnOpenCfg').addEventListener('click', () => api.openConfig());
  $('btnOpenDl').addEventListener('click', () => api.openDownloads());
  if (state.info) {
    $('dirUser').textContent = state.info.tasksDir ? String(state.info.tasksDir).replace(/[\\/]tasks$/, '') : '-';
    $('dirCfg').textContent = state.info.configFile || '-';
  }
}

async function runDiag() {
  const box = $('diagBox');
  if (box) box.innerHTML = '<div class="hint">正在自检，请稍等（会用掉一个账号的页面，约 30 秒）…</div>';
  setView('settings');
  try {
    const r = await api.diagRun();
    const html = (r.steps || []).map((s) =>
      '<div class="diag-row"><svg class="diag-ico ' + (s.ok ? 'ok' : 'bad') + '"><use href="#' + (s.ok ? 'i-check' : 'i-x') + '"/></svg>' +
      '<div class="diag-main"><b>' + esc(s.name) + '</b><p>' + esc(s.msg || '') + '</p></div></div>').join('');
    const el = $('diagBox');
    if (el) el.innerHTML = html || '<div class="hint">没有结果</div>';
    toast(r.ok ? '自检通过' : '自检有异常，看下面的清单', r.ok ? 'ok' : 'err');
  } catch (e) {
    const el = $('diagBox');
    if (el) el.innerHTML = '<div class="hint">自检失败：' + esc(e.message) + '</div>';
  }
}

// ---- 关于 ----
function renderAboutStage() {
  const box = $('viewAbout');
  box.innerHTML =
    '<div class="card">' +
      '<div class="card-head"><h3><svg><use href="#i-heart"/></svg>关于</h3><span class="ch-sub">LOOK</span></div>' +
      '<div class="card-body">' +
        '<p class="about-lead">这是一个<b>完全跑在你自己电脑上</b>的 AI 视频工具：电商产品图 → 白底主图 → 分镜带货片；也可以直接写一段画面描述，让 AI 出图 / 出片。</p>' +
        '<ol class="about-list" style="margin-top:14px">' +
          '<li>视频模型：豆包免费额度（2026.11 为 Seedance 系列）</li>' +
          '<li>不调用其他厂商模型；多开平台由你自己添加</li>' +
          '<li>源码开放，可自行修改、二次开发</li>' +
        '</ol>' +
        '<div class="btn-row" style="margin-top:16px">' +
          '<button class="btn" id="btnAiGuide"><svg><use href="#i-help"/></svg>AI 使用说明</button>' +
          '<button class="btn" id="btnDisc"><svg><use href="#i-shield"/></svg>免责声明</button>' +
        '</div>' +
        '<p class="hint" style="margin-top:16px">本软件按 MIT 许可开源；使用中产生的费用（如平台用量）由你的账号自行承担。</p>' +
      '</div>' +
    '</div>';
  $('btnAiGuide').addEventListener('click', openAiGuide);
  $('btnDisc').addEventListener('click', openDisclaimer);
}

function openAiGuide() {
  dialog({
    title: 'AI 使用说明',
    sub: 'AI GUIDE',
    body:
      '<p class="about-lead">程序目录的「文档」里有 <b>AI使用说明.md</b>，它是写给 AI 看的：把它连同你的问题一起发给任意 AI（豆包、WorkBuddy、ChatGPT 都行），对方就能读懂这个项目并帮你改代码。</p>' +
      '<ol class="about-list" style="margin-top:12px">' +
        '<li>出问题先截图，把截图 + <b>AI使用说明.md</b> 一起发给 AI</li>' +
        '<li>说清楚「哪一步、什么现象、日志最后几行」</li>' +
        '<li>AI 改完文件后，重启本程序即可生效（源码不加密，都在 resources\\app 里）</li>' +
      '</ol>' +
      '<p class="hint" style="margin-top:12px">日志：程序目录下 <b>app-run.log</b>；配置与账号：<b>userdata</b> 目录。</p>',
    buttons: [
      { label: '打开 AI 使用说明', onClick: () => { api.docsOpen('AI使用说明.md'); return false; } },
      { label: '打开文档目录', onClick: () => { api.docsReveal(); return false; } },
      { label: '知道了', primary: true }
    ]
  });
}

function openDisclaimer() {
  dialog({
    title: '免责声明',
    sub: 'DISCLAIMER',
    body:
      '<ol class="about-list">' +
        '<li>本软件是<b>本地浏览器多开与自动化辅助工具</b>，不提供、不代理、不转售任何 AI 服务。</li>' +
        '<li>所有生成内容均由对应 AI 平台产出，版权与合规责任以该平台的服务条款为准。</li>' +
        '<li>请使用你自己合法拥有的账号，遵守平台用户协议；因违规使用导致的封号、限流等后果由使用者承担。</li>' +
        '<li>生成内容请勿用于虚假宣传、侵权、违法违规用途；商用前请自行确认素材与肖像授权。</li>' +
        '<li>软件按「现状」提供，作者不对生成结果、平台政策变化、数据丢失作任何担保。</li>' +
      '</ol>',
    buttons: [
      { label: '看完整版', onClick: () => { api.docsOpen('免责声明.md'); return false; } },
      { label: '我已知悉', primary: true }
    ]
  });
}

// ---------- 账号 / 平台动作 ----------
async function refreshAccounts() {
  try { state.accounts = await api.accountsList(); } catch (e) { state.accounts = []; }
  $('railAccCount').textContent = state.accounts.filter((a) => a.badge !== 'pending').length;
  $('railAccCount').classList.toggle('zero', !state.accounts.length);
  if (state.view === 'accounts') { renderPanel(); renderStage(); }
  else if (state.view === 'board') { renderPanel(); renderHeroStats(); }
  renderLiveStatus();
}

async function refreshProviders() {
  try { state.providers = await api.providersList(); } catch (e) { state.providers = []; }
  if (state.view === 'platforms') { renderPanel(); renderStage(); }
}

async function addAccountFlow(providerId) {
  let pid = providerId;
  if (!pid) {
    const def = state.providers.find((p) => p.id === 'doubao') || state.providers[0];
    pid = def ? def.id : 'doubao';
    // 多平台时让用户选一下
    if (state.providers.length > 1) {
      pid = await pickProvider();
      if (!pid) return;
    }
  }
  setView('accounts');
  const r = await api.accountsAdd(pid);
  if (r && r.id) {
    state.accountId = r.id;
    enterLivePage();
    toast('已打开登录页，扫码登录即可', 'ok');
    refreshAccounts();
  } else {
    toast('打开登录页失败', 'err');
  }
}

function pickProvider() {
  return new Promise((resolve) => {
    const body = '<div class="kindgrid" style="grid-template-columns:repeat(2,1fr)">' +
      state.providers.map((p) =>
        '<button class="kind" data-pick="' + esc(p.id) + '"><svg><use href="#i-' + (p.kind === 'doubao' ? 'bolt' : 'layers') + '"/></svg>' +
        '<b>' + esc(p.name) + '</b><i>' + esc(p.builtin ? '内置适配' : '通用适配') + '</i></button>').join('') +
      '</div>';
    const el = dialog({
      title: '选择平台', sub: 'ADD ACCOUNT', body,
      buttons: [{ label: '取消' }],
      onClose: () => resolve(null)
    });
    el.querySelectorAll('[data-pick]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.dataset.pick;
        dialog._onClose = null;
        closeDialog();
        resolve(id);
      });
    });
  });
}

async function openAccount(id) {
  // 再点一次当前正在看的账号 = 回看板（用户不用再去右上角找返回）
  if (state.live && state.accountId === id) { backToBoard(); return; }
  state.accountId = id;
  setView('accounts');
  enterLivePage();
  try { await api.accountsSelect(id); } catch (e) {}
  renderPanel();
}

// 收起账号页面：回到「进来之前」那一页。
// 从账号矩阵点开的号，退回来还是账号矩阵（方便接着点下一个号）；
// 从工作台点「看页面」进去的，退回来才是工作台。
function backToBoard() {
  const from = state.liveFrom || 'board';
  leaveLivePage();
  setView(from === 'accounts' ? 'accounts' : 'board');
}

function enterLivePage() {
  // 只记第一次进页面时的位置，页面里再切号不改这个落点
  if (!state.live) state.liveFrom = state.view === 'accounts' ? 'accounts' : 'board';
  const backToAcc = state.liveFrom === 'accounts';
  state.live = true;
  document.body.classList.add('live-page');
  $('btnTogglePage').classList.add('on');
  $('togglePageTxt').textContent = backToAcc ? '返回账号' : '返回看板';
  const backBtnTxt = $('btnBackBoardTxt');
  if (backBtnTxt) backBtnTxt.textContent = backToAcc ? '返回账号列表' : '返回看板';
  const acc = state.accounts.find((a) => a.id === state.accountId);
  const hint = $('backHint');
  if (hint) {
    const name = acc ? '「' + acc.label + '」' : '账号页面';
    hint.textContent = backToAcc
      ? '正在看' + name + ' · 返回是账号列表 · Esc 也行'
      : '正在看' + name + ' · 再点一次该账号也能回来 · Esc 也行';
  }
}

function leaveLivePage() {
  const was = state.live;
  state.live = false;
  document.body.classList.remove('live-page');
  $('btnTogglePage').classList.remove('on');
  $('togglePageTxt').textContent = '看页面';
  const backBtnTxt = $('btnBackBoardTxt');
  if (backBtnTxt) backBtnTxt.textContent = '返回账号列表';
  if (was) api.setMode('tasks').catch(() => {});
}

async function togglePage() {
  if (state.live) {
    backToBoard();
    return;
  }
  // 看页面：优先当前任务绑的账号，其次当前选中的账号
  const t = state.tasks.find((x) => x.id === state.taskId);
  const id = (t && t.accountId) || state.accountId || (state.accounts[0] && state.accounts[0].id);
  if (!id) { toast('还没有账号，先去「账号矩阵」加一个'); setView('accounts'); return; }
  state.accountId = id;
  enterLivePage();
  try {
    const r = await api.taskShowPage(t && t.id ? t.id : '');
    if (!r || !r.ok) await api.setMode('doubao');
    if (r && r.ok && r.account) toast('正在看：' + r.account);
  } catch (e) {
    try { await api.setMode('doubao'); } catch (e2) {}
  }
}

// 平台编辑
function openProviderForm(p) {
  const isEdit = !!p;
  const body =
    '<div class="grid2">' +
      '<label class="field">平台名称 <span class="req">*</span><input id="pvName" placeholder="例：DeepSeek" value="' + esc(p ? p.name : '') + '"></label>' +
      '<label class="field">标识（小写字母/数字）<input id="pvId" placeholder="例：deepseek" value="' + esc(p ? p.id : '') + '"' + (isEdit ? ' readonly style="opacity:.6"' : '') + '></label>' +
    '</div>' +
    '<label class="field">对话页地址 <span class="req">*</span><input id="pvUrl" placeholder="https://chat.deepseek.com/" value="' + esc(p ? p.chatUrl : '') + '"></label>' +
    '<label class="field">备注（可留空）<input id="pvNote" placeholder="例：免费额度、适合长文" value="' + esc(p ? p.note : '') + '"></label>' +
    '<div class="hint">保存后回到「账号矩阵」点「加账号」，会打开这个地址让你登录。' +
    '<br>走的是通用驱动：自动找输入框、发送按钮和结果，绝大多数对话式 AI 都能直接用。</div>';
  dialog({
    title: isEdit ? '编辑平台' : '添加 AI 平台',
    sub: 'PROVIDER',
    body,
    buttons: [
      { label: '取消' },
      {
        label: '保存', primary: true, onClick: async () => {
          const name = $('pvName').value.trim();
          const id = $('pvId').value.trim().toLowerCase();
          const url = $('pvUrl').value.trim();
          const note = $('pvNote').value.trim();
          if (!name || !url) { toast('名称和地址都要填', 'err'); return false; }
          const r = isEdit
            ? await api.providerUpdate(p.id, { name, chatUrl: url, loginUrl: url, homeUrl: url, note })
            : await api.providerAdd({ id: id || name.toLowerCase().replace(/[^a-z0-9]/g, ''), name, chatUrl: url, loginUrl: url, homeUrl: url, note, kind: 'generic' });
          if (!r || !r.ok) { toast((r && r.err) || '保存失败', 'err'); return false; }
          toast('平台已保存', 'ok');
          await refreshProviders();
        }
      }
    ]
  });
}

function openProviderDetail(p) {
  dialog({
    title: p.name,
    sub: p.builtin ? 'BUILTIN' : 'PROVIDER',
    body:
      '<dl class="kv">' +
        '<dt>类型</dt><dd>' + (p.kind === 'doubao' ? '深度适配（内置）' : '通用适配') + '</dd>' +
        '<dt>对话页</dt><dd style="user-select:text">' + esc(p.chatUrl) + '</dd>' +
        '<dt>登录页</dt><dd style="user-select:text">' + esc(p.loginUrl || p.chatUrl) + '</dd>' +
        '<dt>备注</dt><dd>' + esc(p.note || '-') + '</dd>' +
      '</dl>',
    buttons: p.builtin
      ? [{ label: '加账号', primary: true, onClick: () => { addAccountFlow(p.id); } }, { label: '关闭' }]
      : [
        { label: '删除', danger: true, onClick: async () => { const ok = await confirmBox('删除平台', '确定删除「' + p.name + '」吗？已登录的账号会保留但无法再打开。'); if (ok) { await api.providerRemove(p.id); refreshProviders(); } } },
        { label: '编辑', onClick: () => { openProviderForm(p); } },
        { label: '加账号', primary: true, onClick: () => { addAccountFlow(p.id); } }
      ]
  });
}

function confirmBox(title, html) {
  return new Promise((resolve) => {
    dialog({
      title, sub: 'CONFIRM', body: '<p class="about-lead">' + html + '</p>',
      buttons: [
        { label: '取消', onClick: () => resolve(false) },
        { label: '确定', primary: true, onClick: () => resolve(true) }
      ],
      onClose: () => resolve(false)
    });
  });
}

// ---------- 任务选择 ----------
function selectTask(id) {
  state.taskId = id;
  leaveLivePage();
  if (state.view !== 'board') setView('board');
  else { renderPanel(); renderStage(); }
}

function kindName(k) {
  return { t2i: '文生图', t2v: '文生视频', i2i: '参考图生图', i2v: '参考生视频' }[k] || '其他视频';
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function renderLiveStatus() {
  const n = state.tasks.filter((t) => t.status === 'running').length;
  $('liveCount').textContent = n;
  $('liveStatus').classList.toggle('on', n > 0);
}

async function refreshTasks() {
  try { state.tasks = await api.tasksList(); } catch (e) { state.tasks = []; }
  renderLiveStatus();
  if (state.view === 'board') { renderPanel(); renderStage(); }
  else if (state.view === 'outputs') { renderPanel(); renderStage(); }
}

// ---------- 启动 ----------
async function boot() {
  try {
    state.prefs = await api.prefsGet();
    state.info = await api.appInfo();
    if (state.info && state.info.version) $('appVersion').textContent = 'v' + state.info.version;
  } catch (e) {}
  applyTheme(state.prefs.theme || 'dark');
  await refreshProviders();
  await refreshAccounts();
  await refreshTasks();

  // 导航
  document.querySelectorAll('.rail-item').forEach((b) => {
    b.addEventListener('click', () => setView(b.dataset.view));
  });
  document.querySelectorAll('.rail-item').forEach((b) => {
    const tip = b.dataset.tip;
    if (tip) b.title = tip;
  });

  $('btnPanelAction').addEventListener('click', () => {
    if (state.view === 'board') openCreate();
    else if (state.view === 'accounts') addAccountFlow();
    else if (state.view === 'platforms') openProviderForm(null);
  });

  $('btnTheme').addEventListener('click', toggleTheme);
  $('btnTogglePage').addEventListener('click', togglePage);
  $('btnBackBoard').addEventListener('click', backToBoard);
  // Esc 也能回看板（只在看账号页面时；别的页面 Esc 用于关弹窗）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('maskDialog') && !$('maskDialog').classList.contains('hidden')) return;
    if ($('maskCreate') && !$('maskCreate').classList.contains('hidden')) return;
    if (state.live) { e.preventDefault(); backToBoard(); }
  });
  $('avatarMe').addEventListener('click', () => setView('about'));
  $('btnHeroNew').addEventListener('click', () => openCreate());
  $('btnHeroAccounts').addEventListener('click', () => setView('accounts'));
  $('btnCloseDialog').addEventListener('click', closeDialog);
  $('maskDialog').addEventListener('click', (e) => { if (e.target === $('maskDialog')) closeDialog(); });

  const search = $('globalSearch');
  search.addEventListener('input', () => {
    state.keyword = search.value.trim().toLowerCase();
    if (state.view !== 'board') setView('board');
    else renderPanel();
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; state.keyword = ''; renderPanel(); } });

  // 主进程推送
  api.onTaskUpdate((t) => {
    const i = state.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.tasks[i] = t; else state.tasks.unshift(t);
    renderLiveStatus();
    if (state.view === 'board') {
      if (state.taskId === t.id) renderTaskDetail(t.id);
      renderPanel();
    }
  });
  api.onTaskRemoved((d) => {
    state.tasks = state.tasks.filter((x) => x.id !== d.id);
    if (state.taskId === d.id) { state.taskId = ''; }
    setView(state.view);
  });
  api.onTaskToast((d) => { if (d && d.text) toast(d.text); });
  api.onAccountsChanged(() => refreshAccounts());
  api.onAccountReady(() => refreshAccounts());
  api.onAccountLogout((d) => { toast('「' + (d.label || '账号') + '」掉线了，点一下重新登录', 'err'); refreshAccounts(); });
  api.onBadgeUpdate(() => refreshAccounts());
  api.onActiveChanged(() => {});
  api.onUiMode((d) => {
    if (d && d.mode === 'doubao') enterLivePage();
    else leaveLivePage();
  });
  api.onViewLocked((d) => { if (d && d.msg) toast(d.msg, 'err'); });
  api.onMenuAdd(() => addAccountFlow());

  setView('board');
}

window.App = {
  state, toast, dialog, closeDialog, esc, $,
  refreshTasks, refreshAccounts, setView, selectTask,
  // 这两个在 task-ui.js 里定义，用惰性引用避免脚本加载顺序问题
  openCreate: () => openCreate(),
  renderTaskDetail: (id) => renderTaskDetail(id)
};

// 等所有脚本（含 task-ui.js）就位再启动，避免跨文件引用过早
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { boot(); });
} else {
  boot();
}
