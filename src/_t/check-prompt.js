// ============================================================
//  提示词自检：把生成器的边界情况全跑一遍，任何一个不合格就退出码 1。
//
//  查什么：
//   1. 占位符残留（{sell1} {endbit} …）—— 会把花括号原样发给豆包
//   2. 小节缺失（固定参数 / 主线 / 时间轴 / 分镜纪律 / 真实感 / 声音 / 约束 / 画质）
//   3. 镜头数与片长不匹配（15s 应 8 镜、10s 6 镜、5s 4 镜）
//   4. 百分比不覆盖 0-100、不递增
//   5. AI 代写任务书编号跳号、缺关键段
//   6. 其他视频四类请求缺规格/纪律
//   7. 第三方技法注入（死键、漏配设备感、身份锁、台词开关）
//   8. 全形态矩阵（14 形态 + 自由构想）× 开关，以及极端输入
//
//  用法：node _t/check-prompt.js [--verbose]
// ============================================================
const P = require('../lib/prompt');

const VERBOSE = process.argv.includes('--verbose');

// 20 个品类各取一件典型商品（含最容易认错的几个）
const SAMPLES = [
  { name: '保温杯', category: '杯壶', sellingPoints: '24小时保温，单手开盖', audience: '通勤上班族' },
  { name: '婴儿睡袋', category: '母婴', sellingPoints: '防踢被，恒温，可拆袖', audience: '0-2岁宝宝家长' },
  { name: '无线蓝牙耳机', category: '数码', sellingPoints: '主动降噪，续航36小时', audience: '通勤地铁族' },
  { name: '吸尘器', category: '家电', sellingPoints: '吸力大，轻量', audience: '有宠物的家庭' },
  { name: '洗面奶', category: '美妆', sellingPoints: '温和不紧绷，控油' },
  { name: '美缝剂', category: '家居', sellingPoints: '防水防霉，好施工' },
  { name: '手机散热背夹', category: '数码', sellingPoints: '降温快，不挡手' },
  { name: '鱼缸过滤器', category: '宠物', sellingPoints: '静音，三层过滤' },
  { name: '渔线轮', category: '运动户外', sellingPoints: '顺滑，刹车稳' },
  { name: '泳装', category: '运动户外', sellingPoints: '显瘦，速干' },
  { name: '车贴', category: '汽车用品', sellingPoints: '防水，不留胶' },
  { name: '纹身贴', category: '美妆', sellingPoints: '持久，易贴' },
  { name: '冰箱贴', category: '家居', sellingPoints: '磁力强，好看' },
  { name: '不粘锅', category: '厨具', sellingPoints: '不粘，少油' },
  { name: '坚果礼盒', category: '食品', sellingPoints: '新鲜，独立包装' },
  { name: '瑜伽垫', category: '运动', sellingPoints: '防滑，加厚' },
  { name: '项链', category: '珠宝', sellingPoints: '不掉色，显气质' },
  { name: '近视眼镜', category: '眼镜', sellingPoints: '轻，防蓝光' },
  { name: '积木', category: '玩具', sellingPoints: '安全材质，好拼' },
  { name: '猫窝', category: '宠物', sellingPoints: '可拆洗，保暖' },
  { name: '（无信息商品）', category: '', sellingPoints: '' }
];

const MUST_HAVE = [
  '【固定参数】', '【本条主线】', '【创作要求】', '【商品识别】', '【参考素材】',
  '【时间轴分镜】', '【分镜纪律】', '【真实感清单】', '【声音设计】', '【约束条件】', '【画质风格】'
];

const DUR_SHOTS = { 15: 8, 10: 6, 5: 4 };
const errs = [];
const warns = [];
function fail(msg) { errs.push(msg); }

// ---------- 1. 本地模板 ----------
let n = 0;
for (const s of SAMPLES) {
  for (const variant of [0, 1, 2, 3]) {
    for (const duration of [15, 10, 5]) {
      const tag = `${s.name} / v${variant} / ${duration}s`;
      let r;
      try {
        r = P.buildPrompt({ ...s, duration, ratio: '9:16', variant });
      } catch (e) {
        fail(`${tag} 抛错：${e.message}`);
        continue;
      }
      n++;
      const txt = r.full;

      // 占位符
      const left = txt.match(/\{[a-zA-Z0-9_]+\}/g);
      if (left) fail(`${tag} 残留占位符 ${[...new Set(left)].join(' ')}`);

      // 小节齐全
      for (const k of MUST_HAVE) if (!txt.includes(k)) fail(`${tag} 缺小节 ${k}`);

      // 镜头数
      const want = DUR_SHOTS[duration];
      const got = r.meta.beats.length;
      if (got !== want) fail(`${tag} 镜头数 ${got}，应为 ${want}`);

      // 百分比：首段 0%、末段 100%、严格递增
      const pcts = (txt.match(/^(\d+%-(\d+)%)/gm) || []);
      const nums = pcts.map(x => x.match(/^(\d+%)-(\d+)%/).slice(1, 3).map(v => parseInt(v, 10)));
      if (nums.length !== want) fail(`${tag} 分镜行 ${nums.length} 条，应为 ${want}`);
      else {
        if (nums[0][0] !== 0) fail(`${tag} 首段不是从 0% 起（${nums[0][0]}%）`);
        if (nums[nums.length - 1][1] !== 100) fail(`${tag} 末段不是到 100%（${nums[nums.length - 1][1]}%）`);
        for (let i = 1; i < nums.length; i++) {
          if (nums[i][0] !== nums[i - 1][1]) fail(`${tag} 第 ${i + 1} 段与上一段不连续（${nums[i - 1][1]}% → ${nums[i][0]}%）`);
        }
      }

      // 每镜时长要与片长自洽
      const m = txt.match(/每镜约 ([\d.]+) 秒/);
      if (!m) fail(`${tag} 没写每镜时长`);
      else {
        const per = parseFloat(m[1]);
        if (Math.abs(per * want - duration) > 0.6) fail(`${tag} 每镜 ${per}s × ${want} 镜 ≠ ${duration}s`);
      }

      // 空段 / 连续空行
      if (/\n{3,}/.test(txt)) fail(`${tag} 出现连续空行`);
      if (/。{2,}|，，|；；/.test(txt)) fail(`${tag} 标点重复`);

      // 卖点必须落进正文
      if (s.sellingPoints) {
        const first = s.sellingPoints.split(/[，,]/)[0];
        if (!txt.includes(first)) warns.push(`${tag} 正文没出现首条卖点「${first}」`);
      }

      if (VERBOSE && n === 1) {
        console.log('--- 样例（' + tag + '）---');
        console.log(txt.split('\n').slice(0, 40).join('\n'));
        console.log('…\n');
      }
    }
  }
}

// ---------- 2. 分镜脚本 / 混剪素材 ----------
for (const s of SAMPLES) {
  for (const variant of [0, 1, 2, 3]) {
    for (const duration of [15, 10, 5]) {
      const tag = `script ${s.name} / v${variant} / ${duration}s`;
      try {
        const r = P.buildScript({ ...s, duration, variant });
        const left = r.text.match(/\{[a-zA-Z0-9_]+\}/g);
        if (left) fail(`${tag} 残留占位符 ${[...new Set(left)].join(' ')}`);
        const lines = (r.text.match(/^S\d+　/gm) || []).length;
        if (lines !== DUR_SHOTS[duration]) fail(`${tag} 镜头 ${lines} 条，应为 ${DUR_SHOTS[duration]}`);
      } catch (e) { fail(`${tag} 抛错：${e.message}`); }
    }
    const tagC = `clips ${s.name} / v${variant}`;
    try {
      const cs = P.buildClips({ ...s, duration: 15, variant });
      if (cs.length !== 8) fail(`${tagC} 素材 ${cs.length} 条，应为 8`);
      for (const c of cs) {
        const left = c.text.match(/\{[a-zA-Z0-9_]+\}/g);
        if (left) fail(`${tagC} ${c.id} 残留占位符 ${[...new Set(left)].join(' ')}`);
      }
    } catch (e) { fail(`${tagC} 抛错：${e.message}`); }
  }
}

// ---------- 3. AI 代写任务书 ----------
for (const s of SAMPLES.slice(0, 8)) {
  for (const duration of [15, 10, 5]) {
    for (const imageCount of [0, 1, 3]) {
      const tag = `brief ${s.name} / ${duration}s / ${imageCount}图`;
      let b;
      try {
        b = P.buildDoubaoBrief({ ...s, duration, imageCount, formatKey: '', variant: 0 });
      } catch (e) { fail(`${tag} 抛错：${e.message}`); continue; }

      const left = b.match(/\{[a-zA-Z0-9_]+\}/g);
      if (left) fail(`${tag} 残留占位符 ${[...new Set(left)].join(' ')}`);
      for (const k of ['【参考素材】', '【商品】', '【需求表】', '【硬性要求】', '【真实感清单】', '【输出格式】']) {
        if (!b.includes(k)) fail(`${tag} 缺 ${k}`);
      }
      // 编号必须 1..14 连续不跳号（只看【硬性要求】那一段，候选形态列表也是 1. 开头）
      const seg = b.split('【硬性要求】')[1] || '';
      const reqSeg = seg.split('【真实感清单】')[0];
      const nums = (reqSeg.match(/^(\d+)\. /gm) || []).map(x => parseInt(x, 10));
      if (nums.length !== 14) fail(`${tag} 硬性要求 ${nums.length} 条，应为 14 条`);
      for (let i = 0; i < nums.length; i++) {
        if (nums[i] !== i + 1) { fail(`${tag} 编号跳号：第 ${i + 1} 条写成 ${nums[i]}`); break; }
      }
      // 镜头数要求与本地一致
      const want = DUR_SHOTS[duration];
      if (!new RegExp(`镜头数：${want} 个`).test(b)) fail(`${tag} 镜头数要求不是 ${want} 个`);
      // 参考图说明
      if (imageCount > 0 && !b.includes('@图片1')) fail(`${tag} 有图却没提 @图片1`);
      if (imageCount === 0 && b.includes('我上传了')) fail(`${tag} 无图却写了「我上传了」`);
    }
  }
}

// ---------- 4. 其他视频出口 ----------
for (const kind of Object.keys(P.OTHER_KINDS)) {
  for (const expand of [true, false]) {
    for (const ratio of ['9:16', '16:9', '1:1']) {
      const tag = `other ${kind} / expand=${expand} / ${ratio}`;
      let r;
      try {
        r = P.buildOtherRequest({ videoKind: kind, prompt: '一只猫在窗台上打哈欠', duration: 10, ratio, expand });
      } catch (e) { fail(`${tag} 抛错：${e.message}`); continue; }
      if (!r.request.includes('一只猫在窗台上打哈欠')) fail(`${tag} 丢失用户原话`);
      if (!r.request.includes('【执行纪律】')) fail(`${tag} 缺执行纪律`);
      if (r.out === 'video' && expand && !r.request.includes('【镜头结构】')) fail(`${tag} 缺镜头结构`);
      if (r.out === 'image' && expand && !r.request.includes('【构图】')) fail(`${tag} 缺构图段`);
      if (!expand && r.request.includes('【镜头结构】')) fail(`${tag} 关了补全却仍有镜头结构`);
      const left = r.request.match(/\{[a-zA-Z0-9_]+\}/g);
      if (left) fail(`${tag} 残留占位符 ${[...new Set(left)].join(' ')}`);
    }
  }
}

// ---------- 5. 参考图张数文案 ----------
for (const [count, should] of [[1, false], [3, true]]) {
  const t = P.buildPrompt({ name: '保温杯', duration: 15, imageCount: count }).full;
  if (t.includes('@图片2 起') !== should) fail(`imageCount=${count} 时多图说明 ${should ? '缺失' : '多余'}`);
}

// ---------- 6. 用途一致性：本地模板与 AI 任务书不能各说一套 ----------
// 这一条挡的是真出过的事：睡袋的 p.purpose 被纠偏成「婴儿睡袋」，
// 但 AI 任务书走了另一条取数路径、拿到「户外搭建」——同一条任务两种用法说明。
const TRAPS = [
  { name: '婴儿睡袋', bad: /户外搭建|先搭好|支起来|打地钉/ },
  { name: '鱼缸过滤器', bad: /喂食|猫粮|狗粮/ },
  { name: '渔线轮', bad: /冲奶粉|奶瓶|辅食/ },
  { name: '冰箱贴', bad: /贴在皮肤|贴在车身|撕下背胶/ },
  { name: '洗面奶', bad: /装水|容器|锅/ }
];
const purposeLine = (t) => (String(t).split('\n').find(l => l.includes('它是做什么的')) || '');
// 「不是户外露营装备」这类否定句是在纠偏，不算跑偏，比对前先摘掉
const stripNeg = (x) => x
  .replace(/（\s*不是[^（）]*?）/g, '')
  .replace(/[；;]?\s*不是[^；;。]*/g, '')
  .trim();
const purposeCore = (t) => {
  let x = purposeLine(t).replace(/^.*它是做什么的：/, '').trim();
  // 任务书会在句尾补一句括注，提示词不补；比较前把句尾括注逐层去掉
  while (/（[^（）]*）\s*$/.test(x)) x = x.replace(/（[^（）]*）\s*$/, '').trim();
  return x;
};
for (const t of TRAPS) {
  const prompt = P.buildPrompt({ name: t.name, duration: 15 }).full;
  const brief = P.buildDoubaoBrief({ name: t.name, duration: 15 });
  const lp = purposeLine(prompt);
  const lb = purposeLine(brief);
  if (!lp) fail(`${t.name} 提示词缺「它是做什么的」`);
  if (!lb) fail(`${t.name} AI 任务书缺「它是做什么的」`);
  if (lp && t.bad.test(stripNeg(lp))) fail(`${t.name} 提示词用途跑偏：${lp.slice(0, 46)}`);
  if (lb && t.bad.test(stripNeg(lb))) fail(`${t.name} AI 任务书用途跑偏：${lb.slice(0, 46)}`);
  if (lp && lb && purposeCore(prompt) !== purposeCore(brief)) {
    fail(`${t.name} 本地模板与 AI 任务书用途不一致\n      模板：${purposeCore(prompt).slice(0, 40)}\n      任务书：${purposeCore(brief).slice(0, 40)}`);
  }
}

// ---------- 7. 第三方技法注入（lib/craft.js）----------
// 这一组挡的是「规则存在但没接上线」：新增/改名形态后技法表悄悄失配，
// 代码不报错、提示词也照常生成，只是那几条真实感要求凭空消失了。
const CRAFT = require('../lib/craft');
const FMTKEYS = P.FORMATS.map(f => f.key);

// 7.1 技法表不能有死键（形态改了名，这里忘了跟，就等于没注入）
for (const k of Object.keys(CRAFT.FORMAT_CRAFT)) {
  if (!FMTKEYS.includes(k)) fail(`craft.js FORMAT_CRAFT.${k} 不是任何现有形态，规则已失效`);
}
for (const k of Object.keys(CRAFT.GEAR_ERA)) {
  if (!FMTKEYS.includes(k)) fail(`craft.js GEAR_ERA.${k} 不是任何现有形态，规则已失效`);
}

// 7.2 每个形态都要有专属技法，且相机质感/设备感都写得出
for (const f of P.FORMATS) {
  const lines = CRAFT.craftLines({}, f, false);
  if (!lines.some(l => l.includes('相机质感'))) fail(`形态 ${f.key}（${f.energy}）没有相机质感句`);
  if (!lines.some(l => l.includes('设备感'))) fail(`形态 ${f.key} 没配 GEAR_ERA，设备感缺失`);
  if (!CRAFT.FORMAT_CRAFT[f.key] || !CRAFT.FORMAT_CRAFT[f.key].length) fail(`形态 ${f.key} 没有 FORMAT_CRAFT 专属技法`);
}

// 7.3 身份锁四段必须整段出现（参考素材段被改写时最容易漏掉「不得继承」）
const LOCK_BITS = ['必须继承', '不得继承', '跨镜保持', '不出现第二个同款'];
for (const s of SAMPLES.slice(0, 12)) {
  const t = P.buildPrompt({ ...s, duration: 15 }).full;
  for (const b of LOCK_BITS) if (!t.includes(b)) fail(`${s.name} 提示词参考素材缺「${b}」`);
}

// 7.4 台词类技法必须跟着 noVoice 走，不能一边禁台词一边教怎么写台词
for (const s of SAMPLES.slice(0, 12)) {
  const off = P.buildPrompt({ ...s, duration: 15, noVoice: true }).full;
  if (off.includes('每拍最多一句随口说的话')) fail(`${s.name} noVoice=true 却注入了台词类技法`);
  const offB = String(P.buildDoubaoBrief({ ...s, duration: 15, noVoice: true }));
  if (/台词焊在/.test(offB)) fail(`${s.name} noVoice=true 任务书仍要求写台词`);
  const onB = String(P.buildDoubaoBrief({ ...s, duration: 15, noVoice: false }));
  if (!/【来自 Seedance 技法的补充要求】/.test(onB)) fail(`${s.name} 任务书缺第三方技法段`);
  // 允许台词时不能反过来禁掉台词
  if (/这条片子不要台词/.test(onB)) fail(`${s.name} noVoice=false 任务书却写了「不要台词」`);
}

// ---------- 8. 全形态矩阵 + 极端输入 ----------
// 上面几段是抽样（20 个商品自动匹配形态），这一段强制走遍每一个形态，
// 因为「自动匹配」永远碰不到冷门形态——某个形态的技法/开关一坏，抽样是看不出来的。
const SECTIONS_FULL = ['【固定参数】', '【本条主线】', '【创作要求】', '【商品识别】', '【参考素材】',
  '【时间轴分镜】', '【分镜纪律】', '【真实感清单】', '【声音设计】', '【约束条件】', '【画质风格】'];
const ALL_KEYS = [...P.FORMATS.map(f => f.key), 'free'];
let nM = 0;
for (const key of ALL_KEYS) {
  for (const noVoice of [true, false]) {
    const tag = `形态 ${key} / noVoice=${noVoice}`;
    let r;
    try {
      r = P.buildPrompt({ name: '保温杯', category: '杯壶', sellingPoints: '24小时保温', duration: 15, formatKey: key, noVoice, imageCount: 1 });
    } catch (e) { fail(`${tag} 抛错：${e.message}`); continue; }
    nM++;
    const t = r.full;
    for (const s of SECTIONS_FULL) if (!t.includes(s)) fail(`${tag} 缺 ${s}`);
    // 技法必须真的进来（新增形态忘了配技法，就是这里报）
    if (!t.includes('相机质感')) fail(`${tag} 缺相机质感`);
    if (!t.includes('设备感')) fail(`${tag} 缺设备感（GEAR_ERA 或 GEAR_BY_ENERGY 没覆盖这个能量档）`);
    // 开关不能打架
    if (noVoice && /每拍最多一句|台词焊在|人声要求：口语/.test(t)) fail(`${tag} 禁台词却注入人声要求`);
    // 同一段里完全相同的条目重复出现
    const seen = new Set();
    for (const l of t.split('\n').map(x => x.trim()).filter(x => x.startsWith('· '))) {
      if (seen.has(l)) fail(`${tag} 重复条目：${l.slice(0, 26)}`);
      seen.add(l);
    }
  }
}

// 极端输入：空名 / 超长名 / 非 15-10-5 档 / 用户自己打了花括号 / 全开关放开
const EDGES = [
  { name: '', duration: 15 },
  { name: 'a'.repeat(80), duration: 5 },
  { name: '保温杯', duration: 3 },
  { name: '保温杯', duration: 60 },
  { name: '保温杯', duration: 8, ratio: '1:1' },
  { name: '保温杯', duration: 15, sellingPoints: '{sell1} 假占位 24小时保温' },
  { name: '保温杯', duration: 15, extra: 'logo 必须 {x} 不模糊' },
  { name: '保温杯', duration: 15, noText: false, noVoice: false, noAmbient: true }
];
for (const e of EDGES) {
  const tag = '极端输入 ' + JSON.stringify(e).slice(0, 52);
  try {
    const r = P.buildPrompt(e);
    if (!r.full || r.full.length < 300) fail(`${tag} 产出过短`);
    // 用户自己打的 {xxx} 也必须被化成全角，不能当成没替换的占位符发出去
    const left = r.full.match(/\{[a-zA-Z0-9_]+\}/g);
    if (left) fail(`${tag} 占位符残留 ${[...new Set(left)].join(' ')}`);
    const b = P.buildDoubaoBrief(e);
    if (typeof b !== 'string' || b.length < 300) fail(`${tag} 任务书过短`);
    if (/\{[a-zA-Z0-9_]+\}/.test(b)) fail(`${tag} 任务书占位符残留`);
    const sc = P.buildScript(e);
    if (!sc.text || sc.text.length < 200) fail(`${tag} 脚本过短`);
    const cl = P.buildClips(e);
    if (!Array.isArray(cl) || !cl.length) fail(`${tag} 混剪为空`);
  } catch (err) { fail(`${tag} 抛错：${err.message}`); }
}

// ---------- 汇总 ----------
console.log(`\n共检查 ${n} 组本地提示词 + ${nM} 组全形态矩阵 + ${EDGES.length} 组极端输入`);
console.log('（另含全部分镜脚本 / 混剪 / AI 任务书 / 其他视频 / 技法注入）');
if (warns.length) {
  console.log(`\n提醒 ${warns.length} 条（不阻断）：`);
  for (const w of warns.slice(0, 8)) console.log('  · ' + w);
}
if (errs.length) {
  console.log(`\n✗ 不合格 ${errs.length} 条：`);
  for (const e of errs.slice(0, 30)) console.log('  · ' + e);
  if (errs.length > 30) console.log(`  … 还有 ${errs.length - 30} 条`);
  process.exit(1);
}
console.log('\n✓ 全部通过');
