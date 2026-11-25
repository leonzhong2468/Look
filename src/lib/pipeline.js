// ============================================================
//  流水线：图片处理（走豆包图像生成）→ 提示词 → 视频生成 → 回收 → 人工验收
//  并发执行：一个任务绑一个账号，多账号可同时跑多个任务；账号紧张时排队等空闲号
// ============================================================
const fs = require('fs');
const path = require('path');
const { Driver } = require('./driver');
const promptLib = require('./prompt');
const fitLib = require('./fit');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }
function safeName(s) {
  let n = String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'task';
  // Windows 设备名（CON/PRN/AUX/NUL/COM1…）不能当文件名，否则写文件直接 EPERM
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(n)) n = '_' + n;
  return n;
}

class Pipeline {
  /**
   * @param {object} host {
   *   store, log, emit, accounts, setActive, ensureView, view,
   *   waitDownload, fetchToFile, localImage, config, getRotation, setRotation, badge
   * }
   */
  constructor(host) {
    this.host = host;
    // 并发执行：taskId -> { cancel, accId }。一个账号同时只绑一个任务，
    // 账号够就多任务并行跑，账号紧张时任务在队列里等空闲账号。
    this.runs = new Map();
    // 定时兜底：账号额度跨天恢复、用户中途加号后，排队任务能自动被捞起来
    setInterval(() => { try { this.tick(); } catch (e) {} }, 15000);
  }

  isCancelled(t) {
    const r = t && this.runs.get(t.id);
    return !!(r && r.cancel);
  }

  /** 是否还有任务在跑（自检等需要独占页面的操作用它判断） */
  isBusy() { return this.runs.size > 0; }

  log(t, msg) {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
    this.host.log(line);
    if (t) {
      t.logs = t.logs || [];
      t.logs.push(line);
      if (t.logs.length > 300) t.logs = t.logs.slice(-300);
      this.host.emit('task:update', this.pub(t));
    }
  }

  pub(t) {
    const { _drv, ...rest } = t;
    return { ...rest };
  }

  update(t, patch) {
    Object.assign(t, patch);
    this.host.store.save();
    this.host.emit('task:update', this.pub(t));
  }

  step(t, step, text) {
    this.update(t, { step, stepText: text });
    this.log(t, `▶ ${text}`);
  }

  // ---------- 账号轮转 ----------
  // 账号今天是否还有视频额度（额度用完的会被记在 accounts.json 的 quotaDate 上）
  quotaOk(a) {
    if (!a) return false;
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return a.quotaDate !== today;
  }

  // ---------- 队列 ----------
  enqueue(id) {
    const t = this.host.store.get(id);
    if (!t) return false;
    t.status = 'queued';
    t.error = '';
    t.autoRetry = 0;   // 手动启动/继续：自动续跑计数清零
    t.step = 'wait';
    t.stepText = '排队中';
    this.host.store.save();
    this.host.emit('task:update', this.pub(t));
    this.tick();
    return true;
  }

  cancel(id) {
    const run = this.runs.get(id);
    if (run) {
      run.cancel = true;
      this.log(this.host.store.get(id), '用户请求取消，当前步骤结束后停止');
    } else {
      const t = this.host.store.get(id);
      if (t && t.status === 'queued') this.update(t, { status: 'paused', stepText: '已取消排队' });
    }
  }

  /**
   * 并发调度：排队任务 × 空闲账号。
   * - 尽量一个任务绑一个账号，互不干扰，各自盯各自的产物回收；
   * - 账号够 → 多任务同时跑；账号全忙 → 任务留在队列；
   * - 任一任务结束、账号额度跨天恢复、用户新加账号 → 自动续跑队首。
   */
  tick() {
    const queued = this.host.store.all().filter(t => t.status === 'queued');
    if (!queued.length) return;
    let started = 0;
    for (const t of queued) {
      if (this.runs.has(t.id)) continue;
      const acc = this.allocAccount(t);
      if (!acc) continue;   // 账号全忙或额度都没恢复 → 留在队列，下一轮再试
      this.startRun(t, acc);
      started++;
    }
    if (started) this.host.log(`调度：本轮启动 ${started} 个任务，当前并行 ${this.runs.size} 个`);
  }

  /** 给一个排队任务分配空闲账号；分不到返回 null（任务继续排队） */
  allocAccount(t) {
    const all = (this.host.accounts() || []).filter(a => !a.pending);
    if (!all.length) return null;
    const busy = new Set();
    for (const r of this.runs.values()) if (r.accId) busy.add(r.accId);
    const free = all.filter(a => !busy.has(a.id));
    if (!free.length) return null;
    // 1) 优先沿用这个任务上次的号（对比验收方便）：空闲且今天还有额度
    const prev = t.accountId ? free.find(a => a.id === t.accountId) : null;
    if (prev && this.quotaOk(prev) && !t.forceSwitchAccount) return prev;
    // 2) 空闲 + 今天还有额度的号里轮转挑一个；空闲的号额度也都用完 → 继续排队等恢复
    const usable = free.filter(a => this.quotaOk(a));
    if (!usable.length) return null;
    let idx = Number(this.host.getRotation() || 0);
    idx = (idx + 1) % usable.length;
    this.host.setRotation(idx);
    return usable[idx];
  }

  startRun(t, acc) {
    const run = { cancel: false, accId: acc.id };
    this.runs.set(t.id, run);
    (async () => {
      try {
        // 电商视频走完整流水线；其他视频只把创作要求交给 AI 出图 / 出片
        if (t.params && t.params.mode === 'other') await this.runOtherTask(t, acc);
        else await this.runTask(t, acc);
      } catch (e) {
        this.host.log('任务异常: ' + (e && e.stack || e));
        const msg = String(e && e.message || e);
        if (e && e.requeue && !run.cancel) {
          // 换号重跑：不判失败，直接重新排队，tick 会挑一个空闲账号接着跑（已处理的图片复用）
          this.update(t, { status: 'queued', error: '', stepText: '换个有额度的账号重跑…' });
          this.log(t, msg);
        } else if (!run.cancel && /新对话打开失败|输入框没有出现|输入框点不进去|页面没有任何生成迹象|消息没发出去|图像验证/.test(msg)
          && Number(t.autoRetry || 0) < 2) {
          // 弹窗/页面异常打断类失败（常驻流程，不是一次性的）：关掉弹窗后自动重新排队续跑，
          // 已处理好的图片会复用，不重复消耗额度。最多自动续跑 2 次，超过才真正判失败。
          const tries = Number(t.autoRetry || 0) + 1;
          this.update(t, {
            status: 'queued', error: '', autoRetry: tries,
            stepText: `页面被弹窗/异常打断，已自动续跑（第 ${tries} 次）`
          });
          this.log(t, `任务被页面异常打断（${msg.slice(0, 80)}），关闭弹窗后自动续跑（第 ${tries} 次）`);
        } else if (!run.cancel) {
          this.update(t, {
            status: 'failed',
            error: msg.slice(0, 400),
            stepText: '失败：' + msg.slice(0, 120)
          });
        } else {
          this.update(t, { status: 'paused', stepText: '已取消' });
        }
      } finally {
        this.runs.delete(t.id);
        // 这轮跑完了可能有账号空出来 → 立刻试着捞起排队的任务
        setTimeout(() => { try { this.tick(); } catch (e) {} }, 800);
      }
    })();
  }

  // ---------- 平台适配 ----------
  /** 这个账号属于哪个平台（豆包内置 / 用户自己加的平台） */
  providerOf(acc) {
    try {
      if (this.host.providerOf) return this.host.providerOf(acc) || {};
    } catch (e) {}
    return { id: 'doubao', name: '豆包', kind: 'doubao' };
  }

  /** 这个账号应该打开的对话页地址 */
  chatUrlFor(acc) {
    const p = this.providerOf(acc);
    return p.chatUrl || p.loginUrl || this.host.config.chatUrl;
  }

  /** 按平台挑驱动：豆包走深度适配，其余平台走通用驱动（选择器在 gen-agent.js 调） */
  makeDriver(view, acc) {
    const prov = this.providerOf(acc);
    const opts = {
      log: (m) => this.host.log(`[${acc.label}] ${m}`),
      anchors: this.host.config.anchors,
      accountId: acc.id,
      provider: prov
    };
    if (prov.kind === 'generic') {
      try {
        const { GenericDriver } = require('./generic-agent');
        return new GenericDriver(view, opts);
      } catch (e) {
        this.host.log('通用驱动加载失败，回退豆包驱动: ' + e.message);
      }
    }
    return new Driver(view, opts);
  }

  /** 图像验证联动：挡到了就把页面摆到前台，过了再退回后台 */
  bindVerify(drv, t) {
    drv.onVerifyBlocked = () => {
      const showId = t.accountId;
      let shown = false;
      try { if (showId && this.host.showAuto) shown = this.host.showAuto(showId); } catch (e) {}
      this.log(t, '检测到图像验证，任务已暂停等待（' + (shown ? '页面已调到前台，' : '')
        + '请在页面完成验证，完成后自动继续任务）');
      this.update(t, { stepText: shown ? '等待图像验证 · 页面已调到前台，请完成验证' : '等待图像验证 · 请在页面完成验证' });
    };
    drv.onVerifyPassed = (r) => {
      try { if (this.host.hideAuto) this.host.hideAuto(); } catch (e) {}
      this.log(t, `图像验证已通过（等待 ${r && r.waited || 0}s），自动继续任务`);
      this.update(t, { stepText: '图像验证已通过，继续执行' });
    };
  }

  /** 从探针结果里挑视频条目（成片卡片懒渲染，重试时用） */
  _videoItems(probe) {
    try {
      const list = (probe && (probe.media || probe.items)) || [];
      const vids = list.filter(x => x && (x.kind === 'video' || /\.mp4|video\//i.test(x.src || '')));
      return vids.length ? vids : list;
    } catch (e) { return []; }
  }

  // ---------- 主流程 ----------
  async runTask(t, acc) {
    if (!acc) throw new Error('没有可用账号：请先在「账号」页登录至少一个豆包账号');
    const prev = t.accountId ? (this.host.accounts() || []).find(a => a.id === t.accountId) : null;
    if (prev && prev.id !== acc.id) {
      this.log(t, `「${prev.label}」额度用完或正被其他任务占用，改用：${acc.label}`);
    }
    t.forceSwitchAccount = false;

    const dir = this.host.store.taskDir(t.id);
    const shotDir = ensureDir(path.join(dir, 'shots'));
    this.update(t, {
      status: 'running', accountId: acc.id, accountLabel: acc.label,
      startedAt: t.startedAt || Date.now(), error: ''
    });
    this.log(t, `任务开始：${t.title} ｜ 账号：${acc.label}`);

    this.host.setActive(acc.id);
    await this.host.ensureView(acc.id);
    await sleep(800);
    const view = this.host.view(acc.id);
    if (!view) throw new Error('账号页面未就绪，请点一下左侧该账号再试');
    this._chatUrl = this.chatUrlFor(acc);
    const drv = this.makeDriver(view, acc);
    t._drv = drv;

    // 验证闸门联动：driver 在等待/输入前检测到图像验证弹层时触发这里——
    // 把页面调到主窗口正面让人处理，并更新看板文案；验证通过后页面退回后台。
    drv.onVerifyBlocked = () => {
      const showId = t.accountId;
      let shown = false;
      try { if (showId && this.host.showAuto) shown = this.host.showAuto(showId); } catch (e) {}
      this.log(t, '检测到图像验证，任务已暂停等待（' + (shown ? '页面已调到前台，' : '')
        + '请在豆包页面完成验证，完成后自动继续任务）');
      this.update(t, {
        stepText: shown ? '等待图像验证 · 页面已调到前台，请完成验证' : '等待图像验证 · 请在豆包页面完成验证'
      });
    };
    drv.onVerifyPassed = (r) => {
      try { if (this.host.hideAuto) this.host.hideAuto(); } catch (e) {}
      this.log(t, `图像验证已通过（等待 ${r && r.waited || 0}s），自动继续任务`);
      this.update(t, { stepText: '图像验证已通过，继续执行' });
    };

    // 豆包页面允许在后台跑：任务看板留在前台，页面被挪到窗口外也能正常输入
    try {
      const vis = await drv.prepare();
      if (vis === 'hidden') this.log(t, '提示：豆包页面仍在后台，若输入失败会明确报错，届时把窗口还原即可');
    } catch (e) {}

    // 首次登录会弹图像验证：先等它过完，再从第一步开始
    await this.waitHumanVerify(drv, t);

    const fail = async (msg) => {
      const f = path.join(shotDir, `fail_${Date.now()}.png`);
      await drv.shot(f);
      this.log(t, '已保存失败截图: ' + f);
      throw new Error(msg);
    };

    try {
      // 1) 新对话
      this.step(t, 'image', '打开新对话');
      const okChat = await drv.openNewChat((this._chatUrl || this.host.config.chatUrl));
      if (!okChat) await fail('新对话打开失败：输入框没有出现，可能是网络或页面结构变化');
      if (await drv.needsLogin()) await fail(`账号「${acc.label}」未登录，请点左侧该账号登录后重试`);
      if (await this.waitHumanVerify(drv, t)) {
        // 验证过程可能把对话窗口弄乱，重新开一个干净的
        await drv.openNewChat((this._chatUrl || this.host.config.chatUrl));
        await sleep(600);
      }

      // 2) 图片处理（已有处理图则复用，避免重跑任务时重复消耗额度）
      const imgs = (t.images || []).filter(i => i.src);
      if (!imgs.length) throw new Error('任务没有图片');
      // 复用前必须校验文件真的是图片：旧版本可能把安装包下回来存成了 _white_1.png，
      // 直接复用会让视频步骤拿一个 exe 去上传，白等一轮。
      const reuse = imgs.every(i => i.processed && fs.existsSync(i.processed) && this.verifyMedia(i.processed, 'image'));
      if (reuse) {
        this.log(t, '复用已处理图片，跳过图片步骤');
        this.update(t, { step: 'prompt' });
      } else {
        const stale = imgs.filter(i => i.processed && !this.verifyMedia(i.processed, 'image'));
        if (stale.length) this.log(t, `发现 ${stale.length} 张处理图无效（不是图片文件），重新处理`);
        // 多张图：先尝试在同一个对话里把全部原图一起发给豆包、让它一次全部处理出来；
        // 批量不成功会自动回退到「逐张处理」的老路径（已保存好的不重复烧额度）。
        let batched = false;
        if (imgs.length > 1) {
          batched = await this.processImagesBatch(t, drv, acc, imgs, dir, shotDir);
        }
        if (!batched) {
          for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i];
            if (this.isCancelled(t)) throw new Error('用户取消');
            // 批量路径可能已经处理好了其中几张：有效的处理图直接沿用
            if (img.processed && fs.existsSync(img.processed) && this.verifyMedia(img.processed, 'image')) continue;
            this.step(t, 'image', `图片处理 ${i + 1}/${imgs.length}`);
            const out = await this.processOneImage(t, drv, acc, img, i, dir, shotDir);
            imgs[i].processed = out;
            imgs[i].status = 'done';
            this.update(t, { images: imgs });
          }
        }
      }

      // 3) 提示词（每次运行都重写；重抽时换一套变体，保证是一条新片子）
      //    两种来源：local=本地模板立刻生成；doubao=让豆包先写一版，再拿它这段去出片。
      const variant = Number(t.params.variant) || 0;
      const inParams = {
        name: t.params.name, category: t.params.category,
        sellingPoints: t.params.sellingPoints, audience: t.params.audience,
        scene: t.params.scene, duration: t.params.duration || 15,
        ratio: t.params.ratio || '9:16', logoText: t.params.logoText,
        extra: t.params.extra, variant,
        // 形态与字幕/台词开关：跟着任务参数走，重抽也保持一致
        formatKey: t.params.formatKey || '',
        noText: t.params.noText !== false,
        noVoice: t.params.noVoice !== false,
        noAmbient: t.params.noAmbient === true,
        rerunFix: (t.params.rerunFix || '').trim(),
        // 参考图张数：提示词里要写清 @图片1 是基准、其余是同款的其他角度
        imageCount: (Array.isArray(imgs) ? imgs : []).filter(i => i && i.processed).length
      };
      const promptMode = t.params.promptMode === 'doubao' ? 'doubao' : 'local';
      const baseName = safeName(t.params.name);
      const modeTag = promptMode === 'doubao' ? '_豆包版' : '';
      const promptFile = path.join(dir, variant > 0
        ? `${baseName}_视频提示词_第${variant + 1}版${modeTag}.txt`
        : `${baseName}_视频提示词${modeTag}.txt`);

      // 本地规划始终跑一遍：商品识别、镜头数、时长这些 meta 验收时要看，
      // 豆包版也靠它拿「这是什么、真实怎么用」，避免豆包按名字乱猜。
      const local = promptLib.buildPrompt(inParams);
      let built = null;

      if (promptMode === 'doubao') {
        this.step(t, 'prompt', 'AI 代写提示词（先让它写脚本，再出片）');
        this.log(t, '提示词来源：AI 代写（不穿帮 / 卖点与人群的要求和本地模板一致）');
        const txt = await this.promptByDoubao(t, drv, acc, imgs.map(i => i.processed), inParams);
        if (txt) built = { full: txt, meta: { ...local.meta, by: 'doubao' } };
        else this.log(t, '回退到本地模板生成提示词（不影响出片）');
      }
      if (!built) {
        this.step(t, 'prompt', '读取商品名 · 生成脚本与提示词');
        built = local;
      }
      // 重抽修正要求：只作用于这一版，直接写进提示词正文，出片请求里也会带上
      if (inParams.rerunFix) {
        built = { ...built, full: built.full + '\n\n【本次重抽修正要求 · 最高优先级】\n' + inParams.rerunFix + '\n（只作用于本次生成的这一版）' };
        this.log(t, '提示词已附加本次修正要求');
      }
      fs.writeFileSync(promptFile, built.full, 'utf-8');

      // 人看的分镜脚本：和提示词同一套动作链，验收时对照着看
      const script = promptLib.buildScript(inParams);
      const scriptFile = path.join(dir, variant > 0
        ? `${baseName}_分镜脚本_第${variant + 1}版.txt`
        : `${baseName}_分镜脚本.txt`);
      fs.writeFileSync(scriptFile, script.text, 'utf-8');

      const clips = promptLib.buildClips(inParams);
      const clipsFile = path.join(dir, `${baseName}_分段素材提示词.txt`);
      fs.writeFileSync(clipsFile, clips.map(c => `【${c.id} · ${c.dur}】\n${c.text}`).join('\n\n'), 'utf-8');
      this.update(t, { prompt: built.full, promptFile, clipsFile, scriptFile, promptMeta: built.meta });

      const pm = built.meta.product || {};
      this.log(t, `商品识别：${pm.cat || '通用'} · ${pm.form || ''}${pm.core ? `（${pm.core}）` : ''}`);
      if (pm.steps && pm.steps.length) this.log(t, `真实动作链：${pm.steps.join(' → ')}`);
      this.log(t, `提示词已生成：${built.meta.beats.length} 个镜头 / ${built.meta.duration}s / ${built.meta.ratio}`
        + `（${built.meta.by === 'doubao' ? 'AI 代写' : (built.meta.variantTag || '标准版')}${variant > 0 ? ` · 第 ${variant + 1} 版` : ''}）`);

      // 4) 视频生成：把全部处理图一起传给豆包当参考，让它通盘参考出片
      this.step(t, 'video', '准备视频生成参数');
      const refImgs = imgs.map(i => i.processed)
        .filter(p => p && fs.existsSync(p) && this.verifyMedia(p, 'image'));
      if (!refImgs.length) throw new Error('没有可用的处理图，无法生成视频');
      const videoPath = await this.generateVideo(t, drv, acc, refImgs, dir, shotDir, fail);

      // 5) 待验收
      this.update(t, {
        status: 'review', video: videoPath, step: 'review',
        stepText: '已生成，等你验收', finishedAt: Date.now()
      });
      this.syncVideos(t, dir);
      this.log(t, '视频已回收，等待人工验收');
      this.host.emit('task:toast', { text: `任务「${t.title}」视频已生成`, taskId: t.id });
    } finally {
      delete t._drv;
      this.host.store.save();
      // 任务结束：把页面从后台执行窗口摘下来，账号释放给用户
      if (acc && this.host.releaseAccount) {
        try { this.host.releaseAccount(acc.id); } catch (e) {}
      }
    }
  }

  /**
   * 额度用完 → 标记这个号、把任务重新排队，让下一个有额度的号接着跑。
   * 图片是复用的，不会重复消耗图片额度。
   */
  async switchForQuota(t, acc) {
    this.host.markQuota && this.host.markQuota(acc.id, '今日视频生成额度已用完');
    this.log(t, `账号「${acc.label}」今日视频额度已用完，已标记（明天自动恢复）`);
    const others = (this.host.accounts() || [])
      .filter(a => !a.pending && a.id !== acc.id && this.quotaOk(a));
    const tries = Number(t.quotaRetry || 0);
    if (others.length && tries < 3) {
      this.update(t, { quotaRetry: tries + 1, forceSwitchAccount: true });
      const e = new Error(`换号重跑：${acc.label} 额度用完 → ${others[0].label}`);
      e.requeue = true;
      throw e;
    }
    throw new Error(`账号「${acc.label}」今日视频生成额度已用完；其他可用账号也都用完了，明天再跑或再加一个号`);
  }

  /**
   * 首次登录 / 风控会弹图像验证（滑块、点选图块）。遮罩一挡，输入框点不进去、
   * 发送也发不出去，表现就是「已提交但页面毫无反应」。
   * 处理原则：不判失败 → 停下等用户手动过验证 → 过了从第一步重新处理。
   * @returns 等待秒数，0 表示页面没有验证
   */
  async waitHumanVerify(drv, t) {
    const vb = await drv.js('(window.__DB ? __DB.verifyBlock() : null)').catch(() => null);
    if (!vb || !vb.on) return 0;

    // 验证必须由人来点：把这个账号的页面从后台窗口搬到主窗口正面，
    // 否则用户根本看不到弹层在哪（其他时候页面一律在后台，不打扰干活）。
    const showId = t.accountId || this.host.getAutoId && this.host.getAutoId();
    let shown = false;
    try {
      if (showId && this.host.showAuto) shown = this.host.showAuto(showId);
    } catch (e) {}
    this.log(t, '检测到图像验证，任务已暂停等待（' + (shown ? '页面已调到前台，' : '') + '请在豆包页面按提示完成验证，完成后自动从第一步重跑）');
    this.update(t, {
      stepText: shown ? '等待图像验证 · 页面已调到前台，请完成验证' : '等待图像验证 · 请在豆包页面完成验证'
    });

    let lastTick = 0;
    const r = await drv.waitVerify({
      timeoutMs: 20 * 60 * 1000,
      onTick: (secs) => {
        if (secs - lastTick < 5) return;
        lastTick = secs;
        this.update(t, { stepText: `等待图像验证 · 已等 ${secs}s（完成后自动从第一步重跑）` });
      }
    });
    // 验证过了：页面立刻退回后台窗口，别再占着屏幕
    try { if (shown && this.host.hideAuto) this.host.hideAuto(); } catch (e) {}
    if (!r.ok) throw new Error('图像验证一直没完成：请在豆包页面手动过验证后点「继续执行」');

    // 验证期间页面状态被打断，已处理的东西不再可信，清干净从第一步重来
    const done = (t.images || []).some(i => i.processed && fs.existsSync(i.processed));
    if (!done) {
      const imgs = (t.images || []).map(i => ({ ...i, processed: '', status: 'pending' }));
      this.update(t, { images: imgs, step: 'image', stepText: '图像验证已通过，从第一步重新开始' });
      this.log(t, `图像验证已通过（等待 ${r.waited}s），从第一步重新处理`);
    } else {
      // 图片已经处理过了：沿用它，从当前步骤继续，别再烧一次图片额度
      this.update(t, { stepText: '图像验证已通过，继续执行' });
      this.log(t, `图像验证已通过（等待 ${r.waited}s），沿用已处理的图片继续`);
    }
    return r.waited || 1;
  }

  /**
   * 豆包有个习惯：先给方案/分镜，再问「确认后我再开始生成」。
   * 这里在等待期间盯着页面，一旦出现这种追问就自动回一句「直接开始」。
   * @returns 'busy' 已在生成 | 'confirmed' 已代确认 | 'none' 没出现追问
   */
  async autoConfirm(drv, t, kind, waitMs = 35000) {
    const t0 = Date.now();
    let confirmed = false;
    while (Date.now() - t0 < waitMs) {
      const p = await drv.probe().catch(() => null);
      if (p && (p.busy || []).length) return confirmed ? 'confirmed' : 'busy';
      // 豆包下线了原模型时会列选项让人回数字，这里直接代答，别让流程干等
      const picked = await drv.pickModelIfAsked().catch(() => null);
      if (picked && picked.ok) { confirmed = true; await sleep(1500); continue; }
      if (!confirmed && await drv.needsConfirm()) {
        // 读到豆包的话后稍等一下，让它把这一轮说完；顶在半截发，豆包经常不认
        await sleep(2600);
        // 授权/版权确认卡带「确认生成」按钮：点按钮最稳，回文字它不认
        if (await drv.clickConfirmButton().catch(() => false)) {
          confirmed = true;
          this.log(t, '豆包在等确认，已代点「确认」按钮');
          await sleep(2000);
          continue;
        }
        const msg = kind === 'video'
          ? '确认，直接开始生成视频。不用再给我看分镜，也不用再问我要不要生成。'
          : '确认，直接开始处理图片。不用再问我。';
        const q = String(await drv.js('(window.__DB ? (__DB.lastMsg()||{}).t : "")').catch(() => '') || '');
        const et = await drv.enterText(msg);
        if (!et.ok) {
          this.log(t, '检测到豆包在等确认，但确认语没写进输入框：' + (et.err || ''));
          return 'none';
        }
        const sub = await drv.submit(msg);
        await drv.js(`(window.__DB ? __DB.markAnswered(${JSON.stringify(q)}) : 0)`).catch(() => 0);
        this.log(t, sub.ok ? '豆包在等确认，已自动回复「直接开始生成」' : '自动确认没发出去，请在页面上手动点一下');
        confirmed = true;
      }
      await sleep(1500);
    }
    return confirmed ? 'confirmed' : 'none';
  }

  // ---------- 单张图处理 ----------
  async processOneImage(t, drv, acc, img, idx, dir, shotDir) {
    const base = safeName(t.params.name || path.basename(img.src, path.extname(img.src)));
    const fail = async (msg) => {
      const f = path.join(shotDir, `fail_img${idx}_${Date.now()}.png`);
      await drv.shot(f);
      this.log(t, '失败截图: ' + f);
      throw new Error(msg);
    };

    // 每张图单独开一个新对话，避免上下文串味
    await drv.openNewChat((this._chatUrl || this.host.config.chatUrl));
    if (await drv.needsLogin()) await fail(`账号「${acc.label}」未登录：请点左侧该账号扫码登录后点「继续执行」`);

    // 图片处理走普通对话（用户要求：不调用技能面板，直接在对话里把目标讲清楚）
    await drv.ensureChatMode();
    await sleep(600);

    // 上传：必须看到缩略图才算成功
    const up = await drv.uploadFiles([img.src]);
    if (!up.ok) await fail('原图上传失败：' + (up.err || ''));
    this.log(t, `原图已上传（输入区缩略图 ${up.thumbs} 张）`);

    // 指令：写进去必须校验；前面加一句「直接执行」，避免它先反问我
    const instr = '【直接执行】请直接编辑我发的这张图并输出一张新图片（图生图），不要询问确认，不要只给文字方案或操作步骤。\n\n'
      + promptLib.buildImagePrompt({ logoText: t.params.logoText });
    const et = await drv.enterText(instr);
    if (!et.ok) await fail('处理指令没写进输入框：' + (et.err || '') + (et.sample ? `（输入框当前内容：${et.sample}）` : ''));
    this.log(t, `处理指令已写入（${et.len} 字）`);

    // 提交：必须看到「生成中」或输入框清空
    const sub = await drv.submit(instr);
    if (!sub.ok) await fail('处理指令没发出去：' + (sub.err || '回车与按钮都无效，页面可能卡住'));
    const cf = await this.autoConfirm(drv, t, 'image', 20000);
    if (cf === 'confirmed') this.log(t, '已代你确认，开始处理');

    const res = await drv.waitResult('image', {
      timeout: 8 * 60 * 1000,
      confirmReply: '确认，直接开始处理这张图并输出新图片，不要再问我。',
      confirmGraceMs: cf === 'confirmed' ? 60000 : 0,
      onTick: ({ secs, probe }) => {
        this.update(t, { stepText: `图片处理 ${idx + 1} · 已等待 ${secs}s` });
      },
      cancelled: () => this.isCancelled(t)
    });
    if (!res.ok && res.verify) {
      await this.waitHumanVerify(drv, t);
      const e = new Error('图像验证打断了图片步骤，已过验证，从第一步重跑');
      e.requeue = true;
      throw e;
    }
    if (!res.ok) {
      const tail = (res.reply || '').replace(/\s+/g, ' ').slice(-160);
      if (tail) this.log(t, '豆包最后回的是：' + tail);
      await fail('图片处理失败：' + (res.err || '没有识别到结果图'));
    }

    const target = res.items[res.items.length - 1];
    const out = path.join(dir, `${base}_white_${idx + 1}.png`);
    const saved = await this.grab(drv, t, acc, target, out, 'image');
    if (!saved) await fail('识别到图片但保存失败（下载按钮和直连都失败）');
    this.log(t, '处理图已保存: ' + path.basename(saved));

    // 归一化：豆包出图的主体常偏小，这里本地裁白边后放大到画布 86%，并保证长边 ≥2000
    return await this.fitProcessed(t, saved, out);
  }

  /**
   * 处理图归一化（processOneImage 与批量路径共用）：
   * 豆包出图的主体常偏小，本地裁白边后放大到画布 86%，长边 ≥2000。
   * 归一化失败不影响主流程，返回最合适的可用路径。
   */
  async fitProcessed(t, saved, out) {
    try {
      const fitPath = out.replace(/\.png$/i, '_fit.png');
      const fit = fitLib.normalizeWhite(saved, fitPath, { target: 0.86, minSide: 2000 });
      if (fit.ok && !fit.skipped) {
        this.log(t, `主体占比 ${(fit.before * 100).toFixed(0)}% → ${(fit.after * 100).toFixed(0)}%，已输出 ${fit.size}px 方图`);
        return fitPath;
      }
      if (fit.ok && fit.skipped) {
        this.log(t, `主体占比 ${(fit.before * 100).toFixed(0)}%，已在合理区间，保持原图`);
        return saved;
      }
      this.log(t, '未做归一化：' + (fit.err || '未知原因'));
    } catch (e) {
      this.log(t, '归一化失败（不影响主流程）：' + e.message);
    }
    return saved;
  }

  /**
   * 多张原图：在同一个对话里一起发给豆包，让它一次把所有图全部处理出来。
   * 结果按上传顺序取最后 n 张结果图，与原图一一对应保存 + 归一化。
   * 任何一步不成立都返回 false，由调用方回退「逐张处理」的路径；
   * 但图像验证打断 / 用户取消会原样向上抛（不能当成「批量失败」吞掉）。
   */
  async processImagesBatch(t, drv, acc, imgs, dir, shotDir) {
    const n = imgs.length;
    const base = safeName(t.params.name);
    try {
      this.step(t, 'image', `批量处理 ${n} 张图（一个对话一起发给豆包）`);
      await drv.openNewChat((this._chatUrl || this.host.config.chatUrl));
      if (await drv.needsLogin()) throw new Error(`账号「${acc.label}」未登录`);
      await drv.ensureChatMode();
      await sleep(600);

      const up = await drv.uploadFiles(imgs.map(i => i.src));
      if (!up.ok) throw new Error('原图批量上传失败：' + (up.err || ''));
      this.log(t, `已把 ${n} 张原图一起上传（输入区缩略图 ${up.thumbs} 张）`);
      const got = Number(up.fresh || up.thumbs || 0);
      if (got && got < n) throw new Error(`只传上了 ${got} 张（要 ${n} 张），豆包可能不支持一次带这么多图`);

      const instr = '【直接执行】请把我发的这 ' + n + ' 张图全部处理并输出新图片（图生图），不要询问确认，不要只给文字方案或操作步骤。\n'
        + '【数量与对应】按上传顺序一一处理：第 1 张图对应输出第 1 张结果，第 2 张对应第 2 张……一共输出 ' + n + ' 张结果图。\n'
        + '【重要】每张结果都是一张独立的完整图片，不要把多张结果拼成一张拼图，也不要遗漏任何一张。\n\n'
        + '每张图的处理要求都相同：\n' + promptLib.buildImagePrompt({ logoText: t.params.logoText });
      const et = await drv.enterText(instr);
      if (!et.ok) throw new Error('处理指令没写进输入框：' + (et.err || ''));
      this.log(t, `批量处理指令已写入（${et.len} 字）`);
      const sub = await drv.submit(instr);
      if (!sub.ok) throw new Error('处理指令没发出去：' + (sub.err || ''));

      const cf = await this.autoConfirm(drv, t, 'image', 20000);
      if (cf === 'confirmed') this.log(t, '已代你确认，开始处理');

      const res = await drv.waitResult('image', {
        timeout: 12 * 60 * 1000,
        confirmReply: '确认，直接开始处理这些图并输出新图片，不要再问我。',
        confirmGraceMs: cf === 'confirmed' ? 60000 : 0,
        onTick: ({ secs }) => this.update(t, { stepText: `批量处理 ${n} 张图 · 已等待 ${secs}s` }),
        cancelled: () => this.isCancelled(t)
      });
      if (!res.ok && res.verify) {
        await this.waitHumanVerify(drv, t);
        const e = new Error('图像验证打断了批量图片步骤，已过验证，从第一步重跑');
        e.requeue = true;
        throw e;
      }
      if (!res.ok) throw new Error('批量图片处理失败：' + (res.err || '没有识别到结果图'));
      if (res.items.length < n) throw new Error(`结果数量不够（要 ${n} 张，只识别到 ${res.items.length} 张）`);

      // 结果图一定出现在我们上传的原图之后：取最后 n 张，按顺序与原图一一对应
      const outs = res.items.slice(-n);
      for (let i = 0; i < n; i++) {
        const out = path.join(dir, `${base}_white_${i + 1}.png`);
        const saved = await this.grab(drv, t, acc, outs[i], out, 'image');
        if (!saved || !this.verifyMedia(saved, 'image')) throw new Error(`第 ${i + 1} 张结果图保存失败`);
        const finalPath = await this.fitProcessed(t, saved, out);
        imgs[i].processed = finalPath;
        imgs[i].status = 'done';
        this.update(t, { images: imgs });
        this.log(t, `第 ${i + 1}/${n} 张处理图已保存: ` + path.basename(finalPath));
      }
      this.log(t, `批量处理完成：${n} 张图已在同一个对话里全部处理并回收`);
      return true;
    } catch (e) {
      if (e && e.requeue) throw e;
      if (/用户取消/.test(String(e && e.message || e))) throw e;
      this.log(t, '多图一起处理没有成功（' + String(e && e.message || e).slice(0, 120) + '），改回逐张处理兜底');
      return false;
    }
  }

  /**
   * 让豆包自己写一版视频提示词（任务参数 promptMode=doubao 时才走）。
   * 约束和本地模板是同一套（镜头数按片长 / 前 3 秒亮货 / 不穿帮 / 卖点落到动作 / 人群场景贴合），
   * 只是分镜正文由它写；写完原样取回，再拿这段去出片。
   * imagePath 可以是一张图，也可以是全部处理图的列表（多图任务一起传给豆包参考）。
   * 任何一步失败都返回 ''，由调用方回退本地模板 —— 提示词环节不能把整个任务卡死。
   */
  async promptByDoubao(t, drv, acc, imagePath, inParams, opts = {}) {
    const brief = promptLib.buildDoubaoBrief(inParams);
    try {
      if (!opts.skipNewChat) {
        await drv.openNewChat((this._chatUrl || this.host.config.chatUrl));
        if (await drv.needsLogin()) throw new Error(`账号「${acc.label}」未登录`);
        await drv.ensureChatMode();
        await sleep(500);
      }
      if (!opts.skipUpload) {
        const refs = (Array.isArray(imagePath) ? imagePath : [imagePath])
          .filter(p => p && this.verifyMedia(p, 'image')).slice(0, 6);
        if (refs.length) {
          const up = await drv.uploadFiles(refs).catch(() => ({ ok: false }));
          if (up && up.ok) {
            this.log(t, refs.length > 1
              ? `已上传 ${refs.length} 张处理图给豆包参考，它会照着真实产品写`
              : '参考图已上传，豆包会照着真实产品写');
            await sleep(1200);           // 等缩略图落位，别让文字和图抢输入区
          }
        }
      }
      const et = await drv.enterText(brief);
      if (!et.ok) throw new Error('写不进输入框：' + (et.err || ''));
      const sub = await drv.submit(brief);
      if (!sub.ok) throw new Error('请求没发出去：' + (sub.err || ''));
      this.log(t, '已把写作要求发给豆包，等它写完…');

      let lastTick = 0;
      const raw = await drv.waitAiText({
        timeoutMs: 240000,
        minLen: 150,
        stableMs: 7000,
        onTick: ({ secs, len }) => {
          if (secs - lastTick < 5) return;   // update 会落盘，别每秒都写
          lastTick = secs;
          this.update(t, { stepText: `豆包正在写提示词 · ${secs}s · 已收到 ${len} 字` });
        },
        cancelled: () => this.isCancelled(t)
      });
      const txt = promptLib.cleanDoubaoPrompt(raw);
      if (!promptLib.isUsableDoubaoPrompt(txt)) {
        this.log(t, '豆包写回来的不像提示词：' + String(raw || '').replace(/\s+/g, ' ').slice(0, 90));
        return '';
      }
      this.log(t, `豆包版提示词已取回（${txt.length} 字，${(txt.match(/镜头\s*\d+/g) || []).length} 个镜头标记）`);
      return txt;
    } catch (e) {
      this.log(t, 'AI 代写提示词失败：' + e.message);
      return '';
    }
  }

  // ---------- 视频生成 ----------
  // imagePaths：全部处理图的列表（多图任务全部传给豆包一起参考；单图任务就是一张）
  async generateVideo(t, drv, acc, imagePaths, dir, shotDir, fail) {
    await drv.openNewChat((this._chatUrl || this.host.config.chatUrl));
    if (await drv.needsLogin()) await fail(`账号「${acc.label}」未登录：请点左侧该账号扫码登录后点「继续执行」`);
    await drv.ensureChatMode();
    await sleep(600);

    // 说明：视频生成本走普通对话通道。
    // 「视频生成」技能面板里的输入框在自动化下点不开（隐藏且不可点击），
    // 而在对话里发「首帧图 + 提示词」同样会调用 Seedance 出片，且成功率更高。
    const wantRatio = t.params.ratio || '9:16';
    // 时长不再写进提示词，交给豆包用它单条允许的最长时长
    if (!t.prompt) {
      const inParams = {
        name: t.params.name, category: t.params.category,
        sellingPoints: t.params.sellingPoints, audience: t.params.audience,
        scene: t.params.scene, duration: Number(t.params.duration) || 15, ratio: wantRatio,
        logoText: t.params.logoText, extra: t.params.extra,
        variant: Number(t.params.variant) || 0,
        formatKey: t.params.formatKey || '',
        noText: t.params.noText !== false,
        noVoice: t.params.noVoice !== false,
        noAmbient: t.params.noAmbient === true,
        rerunFix: (t.params.rerunFix || '').trim(),
        imageCount: (Array.isArray(imagePaths) ? imagePaths : [imagePaths]).filter(Boolean).length
      };
      // 重抽时提示词被清空了：AI 代写模式下重新让它写一版，写完的对话就是当前这个新对话
      if (t.params.promptMode === 'doubao') {
        const txt = await this.promptByDoubao(t, drv, acc, null, inParams, { skipNewChat: true, skipUpload: true });
        t.prompt = txt || promptLib.buildPrompt(inParams).full;
        if (!txt) this.log(t, '（重抽时豆包没写出提示词，已用本地模板）');
      } else {
        t.prompt = promptLib.buildPrompt(inParams).full;
      }
      if (inParams.rerunFix) {
        t.prompt += '\n\n【本次重抽修正要求 · 最高优先级】\n' + inParams.rerunFix + '\n（只作用于本次生成的这一版）';
        this.log(t, '提示词已附加本次修正要求');
      }
      this.update(t, { prompt: t.prompt });
    }

    // 上传前先确认参考图真的是图片：之前把「豆包客户端安装包」当处理图上传过，
    // 结果是上传卡住、发送按钮一直禁用，最后报「请求没发出去」，白等十几分钟。
    const refs = (Array.isArray(imagePaths) ? imagePaths : [imagePaths])
      .filter(p => p && fs.existsSync(p) && this.verifyMedia(p, 'image'));
    if (!refs.length) {
      await fail('处理图不是有效图片，请重试图片处理后再生成视频');
    }
    // 豆包单条消息带图太多容易触发风控/上传卡顿，这里封顶 6 张
    const refList = refs.slice(0, 6);
    if (refs.length > refList.length) this.log(t, `处理图共 ${refs.length} 张，单次最多带 6 张，已取前 6 张`);
    const up = await drv.uploadFiles(refList);
    if (!up.ok) await fail('首帧图上传失败：' + (up.err || ''));
    this.log(t, refList.length > 1
      ? `已上传 ${refList.length} 张处理图一起给豆包参考（缩略图 ${up.thumbs} 张）`
      : `首帧图已上传（输入区缩略图 ${up.thumbs} 张）`);

    // 视频环节豆包极容易先出分镜再问确认，所以前面直接写死「立刻生成」
    // 多图任务：明确告诉豆包这批图都是同一个产品，让它通盘参考、每镜对得上真实外观
    const multiNote = refList.length > 1
      ? `【参考图】本次同时上传了 ${refList.length} 张同一产品的处理图（不同角度/画面）：请通盘参考这批图来生成视频——开场选最适合抓眼球的一张，其余镜头的产品外观、颜色、材质、细节都必须与这些参考图一致，不要凭空编造产品样子。\n\n`
      : '';
    const request = '【直接执行】立刻开始生成视频：不要输出分镜表格，也不要用文字描述镜头，直接调用视频生成能力并输出成片。\n'
      + '【不要询问】不要问我任何问题，不要征求我同意，不要问我用哪个模型、要不要换模型、要不要改时长。\n'
      + '【时长】直接用你当前可用档位里最长的那一档生成，8 段按比例铺满整条片子；即使最长档位比你预想的短，也直接用最长档位开做，不要停下来确认。\n\n'
      + multiNote + t.prompt;
    const et = await drv.enterText(request);
    if (!et.ok) await fail('视频提示词没写进输入框：' + (et.err || ''));
    this.log(t, `视频提示词已写入（${et.len} 字）`);

    const sub = await drv.submit(request);
    if (!sub.ok) await fail('视频请求没发出去：' + (sub.err || ''));
    this.log(t, '视频请求已发出，等待豆包开始生成…');

    // 它要是又停下来问「确认后我再开始」，这里自动替你回「确认，直接开始」
    const cf = await this.autoConfirm(drv, t, 'video', 45000);
    if (cf === 'confirmed') this.log(t, '豆包在等确认，已自动确认并开始生成');
    else if (cf === 'none') this.log(t, '暂未看到生成迹象，继续观察页面…');

    let res = await drv.waitResult('video', {
      timeout: 20 * 60 * 1000,
      idleAbortMs: 90000,
      confirmReply: '确认，直接用你当前能用的最高档位生成整条成片，8 段按比例铺满，不要再问我。',
      confirmGraceMs: cf === 'confirmed' ? 60000 : 0,
      onTick: ({ secs }) => this.update(t, { stepText: `视频生成中 · 已等待 ${secs}s` }),
      cancelled: () => this.isCancelled(t)
    });

    // 被图像验证挡住：等用户过验证，再重新排队继续（图片复用，不重复烧额度）
    if (!res.ok && res.verify) {
      await this.waitHumanVerify(drv, t);
      const e = new Error('图像验证打断了视频步骤，已过验证，重新排队继续');
      e.requeue = true;
      throw e;
    }

    // 额度用完：立刻换号重跑（图片沿用，不重复处理），别让它卡在等待里
    if (!res.ok && res.quota) await this.switchForQuota(t, acc);

    // 豆包有时会先回一大段文字（分镜/建议/换模型），实际没出片。
    // 这时催它一次「别写字，直接出片」，只催一次，避免死循环。
    // 注意：如果它说的是「已经生成好了」，那说明是识别环节的问题，不能重发（会白烧一次额度）。
    const saidDone = /生成好了|已生成|已经生成|成片已/.test(res.reply || '');
    if (!res.ok && !this.isCancelled(t) && !saidDone
      && /中途停了|没有任何生成迹象|没有回应/.test(res.err || '')) {
      this.log(t, '豆包只回了文字没出片，自动催一次「直接出片」');
      const nudge = '别写文字，别给方案，直接调用视频生成，用你当前最长档位把成片做出来。';
      const e2 = await drv.enterText(nudge).catch(() => ({ ok: false }));
      if (e2.ok) {
        await drv.submit(nudge).catch(() => null);
        await this.autoConfirm(drv, t, 'video', 30000);
        res = await drv.waitResult('video', {
          timeout: 20 * 60 * 1000,
          idleAbortMs: 90000,
          confirmReply: '确认，直接开始生成，不要再问我。',
          onTick: ({ secs }) => this.update(t, { stepText: `视频生成中（第 2 次）· 已等待 ${secs}s` }),
          cancelled: () => this.isCancelled(t)
        });
      }
    }
    if (!res.ok && res.quota) await this.switchForQuota(t, acc);
    if (!res.ok) {
      const tail = (res.reply || '').replace(/\s+/g, ' ').slice(-160);
      if (tail) this.log(t, '豆包最后回的是：' + tail);
      await fail('视频生成失败：' + (res.err || '没有识别到视频') + '；页面已保留，可手动查看');
    }

    const target = res.items[res.items.length - 1];
    // 记录平台真实产出规格，便于你判断是否要调整时长/清晰度
    const out = path.join(dir, `${safeName(t.params.name)}_视频_${Date.now()}.mp4`);
    this._media = null;
    const saved = await this.grab(drv, t, acc, target, out, 'video');
    if (!saved) {
      // 成片卡片是懒渲染的，第一次点不到很常见：滚到底、等它渲染出来，再抓一次
      this.log(t, '第一次没抓到成片，把页面滚到底重试一次');
      try {
        await drv.js('(window.__DB ? __DB.scrollBottom(true) : 0)').catch(() => 0);
        await sleep(3000);
        const again = await drv.probe().catch(() => null);
        const t2 = again ? this._videoItems(again).slice(-1)[0] || target : target;
        const saved2 = await this.grab(drv, t, acc, t2, out, 'video');
        if (saved2) {
          this.log(t, '视频已保存: ' + path.basename(saved2));
          const m2 = this._media || {};
          if (m2.dur) this.update(t, { effectiveDuration: Math.round(m2.dur * 10) / 10, effectiveSize: m2.vw ? `${m2.vw}p` : '' });
          this.update(t, { video: saved2 });
          this.syncVideos(t, dir);
          return saved2;
        }
      } catch (e) { this.log(t, '重试抓取失败: ' + e.message); }
      await fail('视频已出现但没抓下来：页面下载可能卡住了。成片可能已在「下载目录」里（右上角【文件】→打开下载目录），也可以直接右键任务重抽');
    }
    this.log(t, '视频已保存: ' + path.basename(saved));

    const m = this._media || {};
    const realDur = Math.round(Number(m.dur || target.dur || 0) * 10) / 10;
    const realVw = m.vw || target.vw || 0;
    if (realDur) {
      this.update(t, { effectiveDuration: realDur, effectiveSize: realVw ? `${realVw}p` : '' });
      this.log(t, `平台实际出片 ${realDur} 秒${realVw ? ` / ${realVw}px` : ''}（已用满该账号当前可用档位）`);
    }
    return saved;
  }

  // ---------- 其他视频：文生图 / 文生视频 / 参考图生图 / 参考图生视频 ----------
  //
  //  这条线不走电商流水线（不处理图片、不套形态模板），
  //  只做一件事：把用户写的创作要求和参考图交给 AI，把成品收回来。
  //  豆包内置适配能直接跑；换成别的平台（通用驱动）走同一套流程。
  async runOtherTask(t, acc) {
    if (!acc) throw new Error('没有可用账号：请先在「账号」页登录至少一个账号');
    const dir = this.host.store.taskDir(t.id);
    const shotDir = ensureDir(path.join(dir, 'shots'));
    this.update(t, {
      status: 'running', accountId: acc.id, accountLabel: acc.label,
      startedAt: t.startedAt || Date.now(), error: ''
    });
    this.log(t, `任务开始：${t.title} ｜ 账号：${acc.label}`);

    this.host.setActive(acc.id);
    await this.host.ensureView(acc.id);
    await sleep(800);
    const view = this.host.view(acc.id);
    if (!view) throw new Error('账号页面未就绪，请点一下左侧该账号再试');
    this._chatUrl = this.chatUrlFor(acc);
    const drv = this.makeDriver(view, acc);
    t._drv = drv;
    this.bindVerify(drv, t);

    try { await drv.prepare(); } catch (e) {}
    await this.waitHumanVerify(drv, t);

    const req = promptLib.buildOtherRequest(t.params);
    this.log(t, `任务类型：${req.kindName}（${req.out === 'video' ? '出视频' : '出图片'}）`);

    const fail = async (msg) => {
      const f = path.join(shotDir, `fail_${Date.now()}.png`);
      try { await drv.shot(f); } catch (e) {}
      this.log(t, '已保存失败截图: ' + f);
      throw new Error(msg);
    };
    const chatUrl = () => (this._chatUrl || this.host.config.chatUrl);

    // 1) 新对话
    this.step(t, 'open', '打开新对话');
    const okChat = await drv.openNewChat(chatUrl());
    if (!okChat) await fail('新对话打开失败：输入框没有出现，可能是网络或页面结构变化');
    if (await drv.needsLogin()) await fail(`账号「${acc.label}」未登录，请点左侧该账号登录后重试`);
    if (await this.waitHumanVerify(drv, t)) {
      await drv.openNewChat(chatUrl());
      await sleep(600);
    }

    // 2) 参考图（参考类才必须，其余给了就一起当参考）
    const refs = (t.images || []).map(i => i.src)
      .filter(p2 => p2 && fs.existsSync(p2) && this.verifyMedia(p2, 'image'))
      .slice(0, 6);
    if (req.needRef && !refs.length) await fail('这个模式需要参考图：请重新建任务并上传图片');
    if (refs.length) {
      this.step(t, 'upload', `上传参考图 ${refs.length} 张`);
      const up = await drv.uploadFiles(refs);
      if (!up.ok) await fail('参考图上传失败：' + (up.err || ''));
      this.log(t, `参考图已上传（缩略图 ${up.thumbs} 张）`);
    }

    // 3) 发请求
    this.step(t, 'send', '发送生成请求');
    const et = await drv.enterText(req.request);
    if (!et.ok) await fail('提示词没写进输入框：' + (et.err || ''));
    this.log(t, `提示词已写入（${et.len} 字）`);
    const sub = await drv.submit(req.request);
    if (!sub.ok) await fail('请求没发出去：' + (sub.err || ''));
    this.log(t, '请求已发出，等待生成…');

    await this.autoConfirm(drv, t, req.out, 45000).catch(() => null);

    // 4) 等结果
    this.step(t, 'wait', req.out === 'video' ? '视频生成中' : '图片生成中');
    const waitOnce = () => drv.waitResult(req.out, {
      timeout: (req.out === 'video' ? 25 : 8) * 60 * 1000,
      idleAbortMs: 90000,
      confirmReply: '确认，直接开始生成，不要再问我。',
      onTick: ({ secs }) => this.update(t, { stepText: `${req.kindName}生成中 · 已等待 ${secs}s` }),
      cancelled: () => this.isCancelled(t)
    });

    let res = await waitOnce();

    if (!res.ok && res.verify) {
      await this.waitHumanVerify(drv, t);
      const e = new Error('图像验证打断了生成，已过验证，重新排队继续');
      e.requeue = true;
      throw e;
    }
    if (!res.ok && res.quota) await this.switchForQuota(t, acc);

    // 只回了文字没出东西：催一次「别写字，直接出」
    const saidDone = /生成好了|已生成|已经生成|做好了|已为你生成/.test(res.reply || '');
    if (!res.ok && !this.isCancelled(t) && !saidDone
      && /中途停了|没有任何生成迹象|没有回应/.test(res.err || '')) {
      this.log(t, 'AI 只回了文字没出成品，自动催一次「直接生成」');
      const nudge = req.out === 'video'
        ? '别写文字、别给方案，直接调用视频生成，把成片做出来。'
        : '别写文字、别给方案，直接生成图片。';
      const e2 = await drv.enterText(nudge).catch(() => ({ ok: false }));
      if (e2.ok) {
        await drv.submit(nudge).catch(() => null);
        await this.autoConfirm(drv, t, req.out, 30000).catch(() => null);
        res = await waitOnce();
      }
    }
    if (!res.ok && res.quota) await this.switchForQuota(t, acc);
    if (!res.ok) {
      const tail = (res.reply || '').replace(/\s+/g, ' ').slice(-160);
      if (tail) this.log(t, 'AI 最后回的是：' + tail);
      await fail(`${req.kindName}失败：` + (res.err || '没有识别到结果') + '；页面已保留，可手动查看');
    }

    // 5) 收回成品
    const target = res.items[res.items.length - 1];
    const outExt = req.out === 'video' ? '.mp4' : '.png';
    const out = path.join(dir, `${safeName(t.params.name)}_${req.kindName}_${Date.now()}${outExt}`);
    this._media = null;
    let saved = await this.grab(drv, t, acc, target, out, req.out);
    if (!saved) {
      this.log(t, '第一次没抓到成品，滚到底再试一次');
      try {
        await drv.js('(window.__DB ? __DB.scrollBottom(true) : 0)').catch(() => 0);
        await drv.js('(window.__GEN && __GEN.scrollBottom ? __GEN.scrollBottom() : 0)').catch(() => 0);
        await sleep(3000);
        const again = await drv.probe().catch(() => null);
        const t2 = again ? (this._videoItems(again).slice(-1)[0] || target) : target;
        saved = await this.grab(drv, t, acc, t2, out, req.out);
      } catch (e) { this.log(t, '重试抓取失败: ' + e.message); }
    }
    if (!saved) await fail(`${req.kindName}已出现但没抓下来：成片可能已在下载目录，也可以右键任务重试`);

    const outputs = (t.outputs || []).concat([{ path: saved, kind: req.out, at: Date.now(), label: req.kindName }]);
    this.update(t, {
      status: 'done', step: 'done', stepText: '完成',
      video: req.out === 'video' ? saved : (t.video || ''),
      image: req.out === 'image' ? saved : (t.image || ''),
      outputs
    });
    this.log(t, `${req.kindName}已保存：` + path.basename(saved));
    return saved;
  }

  /**
   * 把任务目录里历次生成的成片都登记到 t.videos（按文件时间排序），
   * 重抽后看板可以把各版本并列对比。扫描而不是追加，手动放进来的文件也能被看到。
   */
  syncVideos(t, dir) {
    try {
      const base = safeName(t.params.name) + '_视频_';
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.mp4') && f.startsWith(base))
        .map(f => {
          const p2 = path.join(dir, f);
          return { path: p2, at: fs.statSync(p2).mtimeMs };
        })
        .sort((a, b) => a.at - b.at)
        .map((f, i) => ({ path: f.path, at: f.at, v: i + 1 }));
      if (files.length) this.update(t, { videos: files });
    } catch (e) { /* 登记失败不影响任务 */ }
  }

  /**
   * 校验落盘的结果是不是「真货」：
   * 视频常见坑是把封面 JPEG 当 mp4 存下来（URL 同名、体积小、文件头是 FFD8）
   */
  verifyMedia(p, kind) {
    try {
      if (!p || !fs.existsSync(p)) return false;
      const st = fs.statSync(p);
      if (kind === 'video') {
        if (st.size < 200 * 1024) return false;
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        // FF D8 = JPEG，89 50 = PNG → 这是封面图，不是视频
        if (buf[0] === 0xFF && buf[1] === 0xD8) return false;
        if (buf[0] === 0x89 && buf[1] === 0x50) return false;
        return true;
      }
      // 图片必须真的是图片：只看体积会把「豆包客户端安装包」当成处理图放过去
      if (st.size < 8 * 1024) return false;
      const fd = fs.openSync(p, 'r');
      const head = Buffer.alloc(12);
      fs.readSync(fd, head, 0, 12, 0);
      fs.closeSync(fd);
      const isJpg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
      const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
      const isWebp = head.slice(0, 4).toString('ascii') === 'RIFF' && head.slice(8, 12).toString('ascii') === 'WEBP';
      const isGif = head.slice(0, 3).toString('ascii') === 'GIF';
      const isMZ = head[0] === 0x4D && head[1] === 0x5A;            // exe
      const isZip = head[0] === 0x50 && head[1] === 0x4B;           // zip/apk/docx
      if (isMZ || isZip) return false;
      return isJpg || isPng || isWebp || isGif;
    } catch (e) { return false; }
  }

  // ---------- 结果回收：先点下载，再直连抓取，最后 canvas 兜底 ----------
  async grab(drv, t, acc, target, outPath, kind) {
    const startedAt = Date.now() - 5000;   // 扫目录时认「本次操作之后落盘」的文件，留 5s 余量
    // 0) 视频在对话里只有封面图：点开播放器才能拿到真实 mp4 地址
    if (kind === 'video' && (!target || target.kind === 'cover' || !/\.mp4|video\//i.test(target.src || ''))) {
      try {
        const vs = await drv.openVideoSource(target);
        if (vs && vs.src) {
          this._media = { dur: Math.round(vs.dur * 10) / 10, vw: vs.vw };
          const ok = await this.host.fetchToFile(acc.id, vs.src, outPath);
          if (ok && this.verifyMedia(outPath, 'video')) {
            this.log(t, '已从播放器直连保存成片');
            return outPath;
          }
          this.log(t, '播放器地址保存失败，改试下载按钮');
        }
      } catch (e) { this.log(t, '点开播放器失败: ' + e.message); }

      // 播放器一直点不开时的兜底：页面刚才请求过的那个 mp4 地址，带 cookie 直接抓
      try {
        const u = this.host.recentMp4 ? this.host.recentMp4(acc.id) : null;
        if (u) {
          const ok = await this.host.fetchToFile(acc.id, u, outPath);
          if (ok && this.verifyMedia(outPath, 'video')) {
            this.log(t, '播放器没点开，已按页面请求过的视频地址保存成片（' + String(u).split('?')[0].slice(-40) + '）');
            return outPath;
          }
        }
      } catch (e) { this.log(t, '按视频地址兜底失败: ' + e.message); }
    }

    // 1) 图片：优先直连抓取（带账号 cookie），一次点击都不用，最快也最安全
    const urlOk = (kind === 'video')
      ? /\.mp4|video\/tos|vdl\.doubao|\/video\//i.test((target && target.src) || '')
      : /^https?:/i.test((target && target.src) || '');
    if (target && target.src && urlOk) {
      try {
        const ok = await this.host.fetchToFile(acc.id, target.src, outPath);
        if (ok && this.verifyMedia(outPath, kind)) {
          this.log(t, '已通过直连地址保存结果');
          return outPath;
        }
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e) {}
      } catch (e) { this.log(t, '直连抓取失败: ' + e.message); }
    }

    // 2) 兜底：点消息卡片里的下载按钮（只认卡片内入口，且下回来的必须真是图片/视频）
    let clickedOk = false;
    let clickAt = 0;
    try {
      const waited = kind === 'video' ? 75000 : 30000;
      const waiter = this.host.waitDownload(acc.id, path.dirname(outPath), waited);
      const clicked = await drv.clickDownload(target);
      clickAt = Date.now();
      if (!clicked) { try { waiter.cancel && waiter.cancel(); } catch (e) {} }
      if (clicked) {
        clickedOk = true;
        this.log(t, '已点击下载按钮，等待文件落盘…');
        const got = await waiter;
        if (got && got.path && fs.existsSync(got.path)) {
          try { fs.copyFileSync(got.path, outPath); } catch (e) {}
          if (this.verifyMedia(outPath, kind)) return outPath;
          if (this.verifyMedia(got.path, kind)) return got.path;
          // 下回来的不是图片/视频（很可能是安装包或封面图）：删掉，别污染任务目录
          this.log(t, '下载到的文件不是有效' + (kind === 'video' ? '视频' : '图片') + '，已丢弃');
          try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e) {}
          try { if (fs.existsSync(got.path) && !this.verifyMedia(got.path, kind)) fs.unlinkSync(got.path); } catch (e) {}
        } else {
          this.log(t, '下载没等到文件（可能被拦成安装包），换下一种方式');
        }
      }
    } catch (e) { this.log(t, '下载按钮方式失败: ' + e.message); }

    // 3) 扫目录捡文件：豆包的下载常常比「点击」晚几十秒才开始写盘，
    //    等待器早就超时了，文件却确实落在 任务目录 或 downloads\账号 里。
    //    点过下载就在「点击后 2 分钟内」持续轮询，命中就立刻收工，这是最接近人手动下载的路径。
    try {
      const waitMs = kind === 'video' ? 120000 : 45000;
      const deadline = clickedOk ? Math.max(clickAt + waitMs, Date.now() + 15000) : Date.now() + 1500;
      // 只认「这次点击之后」落盘的文件：否则会把同账号上一个任务刚下的成片误当成本次结果
      const since = clickedOk ? Math.max(startedAt, clickAt - 2000) : startedAt;
      let lastCount = 0;
      let hint = false;
      while (Date.now() < deadline) {
        const cands = this.host.findRecentDownload
          ? this.host.findRecentDownload(acc.id, [path.dirname(outPath)], since, kind)
          : [];
        lastCount = cands.length;
        for (const c of cands) {
          if (Date.now() - c.mtime < 1200) continue;      // 可能还在写盘，等下一轮
          if (!this.verifyMedia(c.path, kind)) continue;
          try { fs.copyFileSync(c.path, outPath); } catch (e) { continue; }
          if (this.verifyMedia(outPath, kind)) {
            this.log(t, '已从下载目录找回结果：' + path.basename(c.path));
            return outPath;
          }
        }
        if (!hint && clickedOk && Date.now() - clickAt > 20000) {
          hint = true;
          this.log(t, '文件还没落盘，继续等（豆包的下载经常比点击晚半分钟才开始）…');
        }
        await sleep(4000);
      }
      if (lastCount) this.log(t, `下载目录里有 ${lastCount} 个新文件，但都不是有效${kind === 'video' ? '视频' : '图片'}`);
    } catch (e) { this.log(t, '扫目录兜底失败: ' + e.message); }

    // 4) 页面内 canvas 转 base64（blob 地址兜底）
    if (kind === 'image' && target && target.src) {
      try {
        const b64 = await drv.js(`(window.__DB && window.__DB.imgB64 ? window.__DB.imgB64(${JSON.stringify(target.src)}) : null)`);
        if (b64) {
          fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
          this.log(t, '已通过页面 canvas 保存结果图');
          return outPath;
        }
      } catch (e) { this.log(t, 'canvas 兜底失败: ' + e.message); }
    }
    return null;
  }

  /** 只重跑视频步骤（验收不通过时用） */
  async rerunVideo(id, fix) {
    const t = this.host.store.get(id);
    if (!t) return false;
    if (t.status === 'running') return false;

    // 重抽 = 重新写提示词（顺延一套变体）+ 开新对话重新出片，旧视频和旧提示词都留着
    const next = (Number(t.params.variant) || 0) + 1;
    const V = promptLib.pickVariant(next);
    const byDoubao = t.params.promptMode === 'doubao';
    const fixText = String(fix || '').trim();
    this.update(t, {
      params: { ...t.params, variant: next, rerunFix: fixText },
      status: 'queued', video: '', prompt: '', error: '',
      step: 'video',
      stepText: byDoubao
        ? `重抽视频（第 ${next + 1} 版，提示词重新让豆包写${fixText ? ' · 含修正要求' : ''}）`
        : `重抽视频（第 ${next + 1} 版 · ${V.tag}，将重新生成提示词${fixText ? ' · 含修正要求' : ''}）`
    });
    this.log(t, byDoubao
      ? `已安排重抽：提示词重新让豆包写一版（第 ${next + 1} 版），旧视频保留在任务目录`
      : `已安排重抽：提示词换成「${V.tag}」，重新开对话出片（旧视频保留在任务目录）`);
    if (fixText) this.log(t, `本次重抽修正要求（只作用于这一版）：${fixText}`);
    // 复用同一账号，避免验收对比时换号
    this.tick();
    return true;
  }
}

module.exports = { Pipeline };
