// ============================================================
//  任务界面：新建任务（电商 / 其他）/ 任务详情看板
//  依赖 renderer.js 暴露的全局：$ esc state toast dialog api
// ============================================================

let _createMode = 'ecom';
let _createKind = 't2v';
let _ecomImages = [];
let _otherImages = [];

// ---------- 新建任务 ----------
function openCreate() {
  resetCreate();
  $('maskCreate').classList.remove('hidden');
  setTimeout(() => { try { $('fName').focus(); } catch (e) {} }, 60);
}
function closeCreate() { $('maskCreate').classList.add('hidden'); }

function resetCreate() {
  _createMode = 'ecom';
  _createKind = 't2v';
  _ecomImages = [];
  _otherImages = [];
  ['fName', 'fCategory', 'fAudience', 'fSelling', 'fScene', 'fLogo', 'fExtra', 'fPrompt', 'fOtherExtra'].forEach((id) => {
    const el = $(id); if (el) el.value = '';
  });
  $('fDuration').value = '15';
  $('fRatio').value = '9:16';
  $('fOtherDuration').value = '10';
  $('fFormat').value = '';
  $('fPromptMode').value = 'local';
  $('fNoText').checked = true;
  $('fNoVoice').checked = true;
  $('fNoAmbient').checked = false;
  $('fExpand').checked = true;
  $('thumbs').innerHTML = '';
  $('thumbsOther').innerHTML = '';
  $('createHint').textContent = '创建后会立即开始；中途可随时取消，页面留在你手上。';
  document.querySelectorAll('#modeSwitch .ms-item').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'ecom'));
  document.querySelectorAll('#kindGrid .kind').forEach((b) => b.classList.toggle('active', b.dataset.kind === 't2v'));
  $('paneEcom').classList.remove('hidden');
  $('paneOther').classList.add('hidden');
  $('createSub').textContent = 'NEW TASK';
  updateRefDrop();
}

function setCreateMode(mode) {
  _createMode = mode === 'other' ? 'other' : 'ecom';
  document.querySelectorAll('#modeSwitch .ms-item').forEach((b) => b.classList.toggle('active', b.dataset.mode === _createMode));
  $('paneEcom').classList.toggle('hidden', _createMode !== 'ecom');
  $('paneOther').classList.toggle('hidden', _createMode !== 'other');
  $('createSub').textContent = _createMode === 'ecom' ? 'ECOM · 电商视频' : 'CUSTOM · 其他视频';
  $('createHint').textContent = _createMode === 'ecom'
    ? '图片会先过一遍白底主图，再按形态和片长做分镜片子。'
    : '把你的描述原样交给 AI；参考类记得传图。';
  updateRefDrop();
}

function setCreateKind(kind) {
  _createKind = kind;
  document.querySelectorAll('#kindGrid .kind').forEach((b) => b.classList.toggle('active', b.dataset.kind === _createKind));
  updateRefDrop();
}

function needRef() { return _createKind === 'i2i' || _createKind === 'i2v'; }

function updateRefDrop() {
  const need = needRef();
  const isVideo = _createKind === 't2v' || _createKind === 'i2v';
  $('refDropTitle').textContent = need ? '拖入参考图（必须）' : '拖入参考图（可选）';
  $('refDropSub').textContent = need
    ? '用这张图当主体 / 首帧，AI 按你的描述重新生成'
    : '不传也能做：纯文字出片';
  $('fOtherDuration').parentElement.style.opacity = isVideo ? '1' : '.45';
  $('fOtherDuration').disabled = !isVideo;
}

// 图片选择与预览
async function pickFor(target) {
  const files = await api.pickImages();
  if (!files || !files.length) return;
  addImages(target, files);
}
function addImages(target, files) {
  const arr = target === 'ecom' ? _ecomImages : _otherImages;
  files.forEach((f) => {
    if (arr.length >= 8) return;
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(f)) return;
    arr.push(f);
  });
  renderThumbs(target);
}
function renderThumbs(target) {
  const arr = target === 'ecom' ? _ecomImages : _otherImages;
  const box = $(target === 'ecom' ? 'thumbs' : 'thumbsOther');
  box.innerHTML = '';
  arr.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.innerHTML = '<img src="' + api.toFileUrl(p) + '" alt="">';
    const b = document.createElement('button');
    b.textContent = '×';
    b.title = '移除';
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      arr.splice(i, 1);
      renderThumbs(target);
    });
    d.appendChild(b);
    box.appendChild(d);
  });
}

// 拖放
function bindDrop(elId, target) {
  const el = $(elId);
  if (!el) return;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.thumb')) return;
    pickFor(target);
  });
  ['dragenter', 'dragover'].forEach((ev) => el.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation(); el.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => el.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    if (ev === 'dragleave' && el.contains(e.relatedTarget)) return;
    el.classList.remove('over');
  }));
  el.addEventListener('drop', (e) => {
    const files = [];
    const list = (e.dataTransfer && e.dataTransfer.files) || [];
    for (const f of list) {
      const p = api.getFilePath(f);
      if (p) files.push(p);
    }
    if (files.length) addImages(target, files);
  });
}

// 创建
async function doCreate() {
  const btn = $('btnCreate');
  const noText = $('fNoText').checked;
  const noVoice = $('fNoVoice').checked;
  const noAmbient = $('fNoAmbient').checked;

  let payload;
  if (_createMode === 'ecom') {
    if (!_ecomImages.length) { toast('先拖一张产品图进来', 'err'); return; }
    const name = $('fName').value.trim();
    if (!name) { toast('商品名要填一下', 'err'); $('fName').focus(); return; }
    payload = {
      images: _ecomImages.slice(),
      params: {
        mode: 'ecom',
        name,
        category: $('fCategory').value.trim(),
        sellingPoints: $('fSelling').value.trim(),
        audience: $('fAudience').value.trim(),
        scene: $('fScene').value.trim(),
        logoText: $('fLogo').value.trim(),
        extra: $('fExtra').value.trim(),
        duration: Number($('fDuration').value) || 15,
        ratio: '9:16',
        formatKey: $('fFormat').value,
        promptMode: $('fPromptMode').value === 'doubao' ? 'doubao' : 'local',
        noText, noVoice, noAmbient
      }
    };
  } else {
    const prompt = $('fPrompt').value.trim();
    if (!prompt) { toast('写一句画面描述吧', 'err'); $('fPrompt').focus(); return; }
    if (needRef() && !_otherImages.length) { toast('这个模式需要一张参考图', 'err'); return; }
    payload = {
      images: _otherImages.slice(),
      params: {
        mode: 'other',
        videoKind: _createKind,
        prompt,
        extra: $('fOtherExtra').value.trim(),
        ratio: $('fRatio').value,
        duration: Number($('fOtherDuration').value) || 10,
        expand: $('fExpand').checked,
        noText, noVoice, noAmbient
      }
    };
  }

  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    const r = await api.taskCreate(payload);
    if (!r || !r.ok) { toast((r && r.err) || '创建失败', 'err'); return; }
    toast('任务已创建，开始执行', 'ok');
    closeCreate();
    state.taskId = r.task.id;
    setView('board');
    renderPanel();
    renderStage();
    await api.taskStart(r.task.id);
    await refreshTasks();
  } catch (e) {
    toast('创建失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '创建并开始';
  }
}

// ---------- 任务详情 ----------
const ECOM_STEPS = [
  { key: 'image', name: '① 白底主图' },
  { key: 'prompt', name: '② 提示词' },
  { key: 'video', name: '③ 视频生成' },
  { key: 'review', name: '④ 验收' }
];
const OTHER_STEPS = [
  { key: 'open', name: '① 打开对话' },
  { key: 'upload', name: '② 参考图' },
  { key: 'send', name: '③ 发请求' },
  { key: 'wait', name: '④ 生成' },
  { key: 'done', name: '⑤ 回收' }
];

const STATUS_TEXT = {
  draft: ['待开始', ''], queued: ['排队中', 'amber'], running: ['执行中', 'accent'],
  review: ['待验收', 'violet'], done: ['已完成', 'green'], failed: ['失败', 'rose'], paused: ['已暂停', '']
};

function renderTaskDetail(id) {
  const t = state.tasks.find((x) => x.id === id);
  const box = $('viewTask');
  if (!t) {
    box.innerHTML = '<div class="empty"><svg><use href="#i-layers"/></svg><b>任务不存在</b><p>它可能已经被删掉了。</p></div>';
    return;
  }
  box.classList.remove('hidden');
  $('viewBoardEmpty').classList.add('hidden');

  const st = t.status || 'draft';
  const [stText, stCls] = STATUS_TEXT[st] || [st, ''];
  const isOther = t.mode === 'other' || (t.params && t.params.mode === 'other');
  const steps = isOther ? OTHER_STEPS : ECOM_STEPS;
  const curIdx = Math.max(0, steps.findIndex((s) => s.key === t.step));
  const doneAll = st === 'review' || st === 'done';

  const stepHtml = steps.map((s, i) => {
    const cls = doneAll ? 'done' : (i < curIdx ? 'done' : (i === curIdx && st === 'running' ? 'now' : ''));
    return '<div class="step ' + cls + '"><b>' + s.name + '</b></div>';
  }).join('');

  const kindLabel = isOther ? kindName(t.params && t.params.videoKind) : '电商视频';
  const fmtName = (() => {
    if (isOther) return kindLabel;
    const k = t.params && t.params.formatKey;
    if (!k) return '自动匹配';
    if (k === 'free') return 'AI 自由构想';
    return ({ street: '街拍漫游', pov: '第一人称', ugc: '手持实测', skit: '情景段子', interview: '街头采访', ootd: '穿搭型录', food: '美食 ASMR', test: '硬核实测', beforeafter: '前后对比', roomtour: '居家漫游', cinematic: '电影感', pet: '萌宠主角', travel: '旅拍', tutorial: '教程三步' })[k] || k;
  })();

  const media = mediaHtml(t);
  const outputs = (t.outputs || []);

  box.innerHTML =
    '<div class="task-hero">' +
      '<div class="th-top">' +
        '<div>' +
          '<div class="th-title">' + esc(t.params && t.params.name || t.title) + '</div>' +
          '<div class="th-meta">' +
            '<span class="chip ' + stCls + '">' + stText + '</span>' +
            '<span class="chip accent">' + esc(kindLabel) + '</span>' +
            (isOther ? '' : '<span class="chip">' + esc(fmtName) + '</span>') +
            '<span class="chip mono">' + esc(t.accountLabel || '未分配账号') + '</span>' +
            '<span class="chip">' + esc(fmtTime(t.createdAt)) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="steps">' + stepHtml + '</div>' +
      (t.stepText ? '<div class="hint" style="margin-top:10px">' + esc(t.stepText) + (t.error ? ' · <span style="color:var(--rose)">' + esc(t.error) + '</span>' : '') + '</div>' : '') +
      '<div class="btn-row" style="margin-top:14px" id="taskActions"></div>' +
    '</div>' +

    '<div class="card">' +
      '<div class="card-head"><h3><svg><use href="#i-' + (isOther ? 'sparkle' : 'image') + '"/></svg>产出</h3>' +
        '<span class="ch-sub">' + (outputs.length || (t.video ? 1 : 0)) + ' FILES</span></div>' +
      '<div class="card-body">' + media + '</div>' +
    '</div>' +

    (isOther ? otherInfoCard(t) : ecomInfoCard(t)) +

    '<div class="card">' +
      '<div class="card-head"><h3><svg><use href="#i-clock"/></svg>运行日志</h3>' +
        '<button class="btn sm" id="btnCopyLog">复制</button></div>' +
      '<div class="card-body"><div class="log-box" id="logBox">' +
        ((t.logs || []).slice(-120).map((l) => '<div>' + esc(l) + '</div>').join('') || '<div class="hint">还没有日志</div>') +
      '</div></div>' +
    '</div>';

  buildActions(t, isOther);

  const cp = $('btnCopyLog');
  if (cp) cp.addEventListener('click', () => {
    navigator.clipboard.writeText((t.logs || []).join('\n')).then(() => toast('日志已复制', 'ok')).catch(() => {});
  });
  const lb = $('logBox');
  if (lb) lb.scrollTop = lb.scrollHeight;
}

function mediaHtml(t) {
  const items = [];
  if (t.video) items.push({ kind: 'video', url: t.videoUrl, path: t.video });
  if (t.image) items.push({ kind: 'image', url: t.imageUrl, path: t.image });
  (t.outputs || []).forEach((o) => {
    if (!items.some((x) => x.path === o.path)) items.push({ kind: o.kind, url: o.url, path: o.path, label: o.label });
  });

  if (!items.length) {
    return '<div class="media-box"><div class="media-empty">' +
      (t.status === 'running' ? '正在生成，出片后自动出现在这里' : '还没有产出<br>点上面的「开始执行」') +
      '</div></div>';
  }
  const latest = items[items.length - 1];
  const main = latest.kind === 'video'
    ? '<video src="' + esc(latest.url) + '" controls preload="metadata"></video>'
    : '<img src="' + esc(latest.url) + '" alt="">';

  const others = items.slice(0, -1).reverse().slice(0, 6).map((o) =>
    '<div class="ocard" data-open="' + esc(o.path) + '" style="cursor:pointer">' +
      '<div class="ocard-media" style="height:96px">' +
        (o.kind === 'video' ? '<video src="' + esc(o.url) + '" muted preload="metadata"></video>' : '<img src="' + esc(o.url) + '" alt="">') +
      '</div>' +
      '<div class="ocard-info"><b>' + esc(o.label || (o.kind === 'video' ? '视频' : '图片')) + '</b><span>点开文件夹</span></div>' +
    '</div>').join('');

  return '<div class="media-wrap">' +
      '<div class="media-box">' + main + '</div>' +
      '<div class="media-side">' +
        '<dl class="kv">' +
          '<dt>文件</dt><dd style="user-select:text">' + esc(String(latest.path || '').split(/[\\/]/).pop()) + '</dd>' +
          '<dt>类型</dt><dd>' + (latest.kind === 'video' ? '视频 mp4' : '图片') + '</dd>' +
          (t.effectiveDuration ? '<dt>实际时长</dt><dd>' + t.effectiveDuration + ' 秒</dd>' : '') +
          (t.effectiveSize ? '<dt>分辨率</dt><dd>' + esc(t.effectiveSize) + '</dd>' : '') +
        '</dl>' +
        '<div class="btn-row" style="margin-top:12px">' +
          '<button class="btn sm" data-open="' + esc(latest.path) + '"><svg><use href="#i-folder"/></svg>所在文件夹</button>' +
          (latest.kind === 'video' ? '<button class="btn sm" id="btnPlay">播放</button>' : '') +
        '</div>' +
        (others ? '<div class="pgrid" style="margin-top:14px;grid-template-columns:1fr 1fr">' + others + '</div>' : '') +
      '</div>' +
    '</div>';
}

function ecomInfoCard(t) {
  const p = t.params || {};
  const rows = [
    ['品类', p.category || '-'],
    ['人群', p.audience || '-'],
    ['卖点', p.sellingPoints || '-'],
    ['场景', p.scene || '-'],
    ['补充', p.extra || '-'],
    ['提示词', p.promptMode === 'doubao' ? 'AI 代写' : '本地模板'],
    ['字幕 / 台词', (p.noText !== false ? '不出字幕' : '允许字幕') + ' / ' + (p.noVoice !== false ? '不出台词' : '允许台词')]
  ];
  return '<div class="card">' +
    '<div class="card-head"><h3><svg><use href="#i-image"/></svg>任务参数</h3>' +
      '<span class="ch-sub">' + esc(p.duration || 15) + 'S · ' + esc(p.ratio || '9:16') + '</span></div>' +
    '<div class="card-body">' +
      '<dl class="kv">' + rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>').join('') + '</dl>' +
      (t.prompt ? '<div class="card-head" style="border:0;background:none;padding:14px 0 8px"><h3><svg><use href="#i-copy"/></svg>提示词</h3>' +
        '<button class="btn sm" id="btnCopyPrompt">复制</button></div><div class="prompt-box">' + esc(t.prompt) + '</div>' : '') +
    '</div>' +
  '</div>';
}

function otherInfoCard(t) {
  const p = t.params || {};
  const rows = [
    ['类型', kindName(p.videoKind)],
    ['画幅', p.ratio || '9:16'],
    ['时长', (Number(p.duration) || 10) + ' 秒'],
    ['字幕 / 台词', (p.noText !== false ? '不出字幕' : '允许字幕') + ' / ' + (p.noVoice !== false ? '不出台词' : '允许台词')],
    ['补充', p.extra || '-']
  ];
  return '<div class="card">' +
    '<div class="card-head"><h3><svg><use href="#i-sparkle"/></svg>创作要求</h3><span class="ch-sub">PROMPT</span></div>' +
    '<div class="card-body">' +
      '<dl class="kv">' + rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>').join('') + '</dl>' +
      '<div class="prompt-box" style="margin-top:12px">' + esc(p.prompt || '（未填写）') + '</div>' +
      (t.prompt ? '<div class="card-head" style="border:0;background:none;padding:14px 0 8px"><h3><svg><use href="#i-copy"/></svg>发给 AI 的完整请求</h3>' +
        '<button class="btn sm" id="btnCopyPrompt">复制</button></div><div class="prompt-box">' + esc(t.prompt) + '</div>' : '') +
    '</div>' +
  '</div>';
}

function buildActions(t, isOther) {
  const box = $('taskActions');
  if (!box) return;
  box.innerHTML = '';
  const st = t.status || 'draft';

  const add = (label, icon, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'btn ' + (cls || '');
    b.innerHTML = '<svg><use href="#' + icon + '"/></svg>' + label;
    b.addEventListener('click', fn);
    box.appendChild(b);
    return b;
  };

  if (st === 'running' || st === 'queued') {
    add('取消任务', 'i-stop', 'danger', async () => {
      await api.taskCancel(t.id);
      toast('已请求取消');
    });
  } else if (st !== 'done' && st !== 'review') {
    add(st === 'draft' ? '开始执行' : '继续执行', 'i-play', 'primary', async () => {
      await api.taskStart(t.id);
      toast('已加入队列', 'ok');
    });
  }

  if (t.video || t.image) {
    add('看页面', 'i-eye', '', async () => {
      enterLivePage();
      const r = await api.taskShowPage(t.id);
      if (!r || !r.ok) { toast((r && r.err) || '页面打不开', 'err'); leaveLivePage(); }
    });
    add('打开文件夹', 'i-folder', '', () => api.taskOpenFolder(t.id));
  }

  if (!isOther && (st === 'review' || st === 'done')) {
    add('重抽一版', 'i-refresh', '', () => rerunDialog(t));
    if (st === 'review') {
      add('通过验收', 'i-check', 'primary', async () => {
        await api.taskApprove(t.id);
        toast('已通过验收', 'ok');
      });
    }
  }

  add('删除', 'i-trash', 'danger', async () => {
    const ok = await confirmBox('删除任务', '确定删除这个任务和它的文件吗？<br><span style="color:var(--rose)">文件会一起删掉，不可恢复。</span>');
    if (!ok) return;
    const r = await api.taskDelete(t.id);
    if (r && !r.ok) toast(r.err || '删除失败', 'err');
  });
}

function rerunDialog(t) {
  dialog({
    title: '重抽一版',
    sub: 'RERUN',
    body:
      '<label class="field">上一版哪里不满意？（会作为最高优先级要求）' +
      '<textarea id="rerunFix" rows="3" placeholder="例：镜头太快；产品没看清；场景太像广告片；想要更生活化一点"></textarea></label>' +
      '<div class="hint">重抽会自动换一种视频形态，图片沿用不重复烧额度。</div>',
    buttons: [
      { label: '取消' },
      {
        label: '开始重抽', primary: true, onClick: async () => {
          const fix = ($('rerunFix') && $('rerunFix').value.trim()) || '';
          const r = await api.taskRerunVideo(t.id, fix);
          if (r && r.ok) toast('已提交重抽', 'ok');
          else toast((r && r.err) || '重抽失败', 'err');
        }
      }
    ]
  });
}

// ---------- 事件绑定 ----------
document.addEventListener('DOMContentLoaded', () => {
  bindDrop('dropEcom', 'ecom');
  bindDrop('dropOther', 'other');

  document.querySelectorAll('#modeSwitch .ms-item').forEach((b) => {
    b.addEventListener('click', () => setCreateMode(b.dataset.mode));
  });
  document.querySelectorAll('#kindGrid .kind').forEach((b) => {
    b.addEventListener('click', () => setCreateKind(b.dataset.kind));
  });

  $('btnCloseCreate').addEventListener('click', closeCreate);
  $('btnCancelCreate').addEventListener('click', closeCreate);
  $('btnCreate').addEventListener('click', doCreate);
  $('maskCreate').addEventListener('click', (e) => { if (e.target === $('maskCreate')) closeCreate(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('maskCreate').classList.contains('hidden')) closeCreate();
      else if (!$('maskDialog').classList.contains('hidden')) closeDialog();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault();
      openCreate();
    }
  });

  // 任务详情里的动态按钮（复制 / 打开文件夹）
  document.addEventListener('click', (e) => {
    const openEl = e.target.closest('[data-open]');
    if (openEl) { api.taskReveal(openEl.dataset.open); return; }
    if (e.target.closest('#btnCopyPrompt')) {
      const t = state.tasks.find((x) => x.id === state.taskId);
      if (t && t.prompt) navigator.clipboard.writeText(t.prompt).then(() => toast('提示词已复制', 'ok')).catch(() => {});
    }
    if (e.target.closest('#btnPlay')) {
      const t = state.tasks.find((x) => x.id === state.taskId);
      if (t && t.video) api.taskReveal(t.video);
    }
  });
});
