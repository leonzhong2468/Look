#!/usr/bin/env node
// ============================================================
//  把 lib/formats.js 里的形态库渲染成文档
//
//  用法（在 resources/app 目录下）：
//    node _t/gen-formats-doc.js > skills/seedance-prompt/references/video-formats.md
//
//  为什么要有这个脚本：形态库是代码，文档是给人的说明。
//  两处各写一遍必然漂移，最后 AI 按文档写完发现代码里没这条。
//  所以文档只允许由这里生成 —— 别手改 video-formats.md。
// ============================================================
const F = require('../lib/formats');

function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const L = [];
const push = (...xs) => L.push(...xs);
const re = r => (r && r.source ? r.source : String(r));

// ---------- 抬头 ----------
push('# 视频形态库（由 `lib/formats.js` 自动生成，请勿手改）');
push('');
push(`> 生成时间：${ts()}　｜　改形态请改代码后重跑 \`node _t/gen-formats-doc.js\`。`);
push('');
push('这一层解决的问题：**同一条提示词套所有商品，出来全是白底产品展示片**。');
push('现在先判断「这件商品在真实生活里怎么被用到」，再决定用什么拍法。');
push('');

// ---------- 1. 形态 ----------
push(`## 1. ${F.FORMATS.length} 种视频形态`);
push('');
push('| key | 形态 | 能量 | 有人声 | 适用品类 | 一句话逻辑 |');
push('|---|---|---|---|---|---|');
for (const f of F.FORMATS) {
  push(`| \`${f.key}\` | ${f.name} | ${f.energy} | ${f.voice ? '是' : '否'} | ${(f.cats || []).join('/')} | ${f.why} |`);
}
push('');
push('每种形态自带 8 个节拍的动作、机位语言（`CAMERA_SETS` 三套）、相机身份（`LOOKS`）、真实感清单、声音方案和禁忌。');
push('');

// ---------- 2. 品类优先级 ----------
push('## 2. 品类 → 形态优先级（`CAT_ORDER`）');
push('');
push('| 品类 | 首选顺序 |');
push('|---|---|');
for (const cat of Object.keys(F.CAT_ORDER)) {
  push(`| ${cat} | ${(F.CAT_ORDER[cat] || []).join(' > ')} |`);
}
push('');
push('打分公式：品类位次（12/10/8/6）+ 形态适配该品类（+3）+ 关键词命中（+5）+ 卖点加权（`BOOST`）− 错配压制（`AVOID`，−25）+ 品类微调（`TUNE`）。取 top3，按 `variant` 轮换（重抽自动换形态）。');
push('');

// ---------- 3. 全类目兜底 ----------
push('## 3. 全类目兜底（`CAT_HINTS`）');
push('');
push('`lib/product.js` 的形态库认不出来时，按商品名兜底推品类，保证任意商品都有像样的拍法：');
push('');
push('| 命中词 | 品类 |');
push('|---|---|');
for (const h of F.CAT_HINTS) push(`| \`${re(h.re)}\` | ${h.cat} |`);
push('');
push('### 3.1 语义覆写（`CAT_OVERRIDES`，先于兜底生效）');
push('');
push('商品库按关键词分类，偶尔会认错「这件东西怎么被使用」。先按用途改正，再走兜底：');
push('');
push('| 命中词 | 附加条件 | 改判为 | 为什么 |');
push('|---|---|---|---|');
for (const o of F.CAT_OVERRIDES) {
  const cond = [o.only ? `原判为 ${o.only}` : '', o.and ? `且命中 \`${re(o.and)}\`` : ''].filter(Boolean).join('；') || '—';
  push(`| \`${re(o.re)}\` | ${cond} | ${o.cat} | ${o.why} |`);
}
push('');
push('贴纸类单独按用途分（同时命中时取下表第一个）：`车贴|车身贴|拉花` → car；`纹身贴|身体贴|临时贴` → beauty；`冰箱贴|墙贴|壁画` → home。');
push('');
push('### 3.2 商品级纠偏（`REFINE`，优先级高于上面所有规则）');
push('');
push('这几类商品的场景/尺寸/动作是单独写的，命中后整段覆盖商品库的判断（否则会出现「睡袋要穿帐杆」这种错）：');
push('');
push('| 命中词 | 改判为 | 这件商品真实遇到的麻烦 | 纠偏后的场景 |');
push('|---|---|---|---|');
for (const r of F.REFINE) {
  const patch = r.patch || {};
  const tr = patch.trouble && patch.trouble.name ? patch.trouble.name : '-';
  const to = patch.catLabel || patch.formLabel
    ? [patch.catLabel || '（原品类）', patch.formLabel || '（原形态）'].join(' · ')
    : '（不改品类）';
  push(`| \`${re(r.test)}\` | ${to} | ${tr} | ${patch.scene || '-'} |`);
}
push('');
push('只写 `trouble` 的条目（积木、猫窝、近视镜…）不改品类，只把「这件商品会演什么麻烦」换掉：');
push('品类兜底麻烦是大类共用的，玩具档位写的是「娃闹着要人陪」，落到拼图上就偏了。');
push('');

// ---------- 4. 生活母题 ----------
push('## 4. 自由构想：生活母题（`MOTIFS`）');
push('');
push('「不套模板」模式先挑一个生活场景，再按卖点挑一件真实会发生的小麻烦。');
push('');
for (const m of F.MOTIFS) {
  push(`### ${m.name}（\`${m.key}\`）`);
  push('');
  push(`- 适用品类：${(m.cats || []).join(' / ')}`);
  push(`- 开场：${m.open}`);
  push(`- 环境：${m.where}`);
  push(`- 人物：${m.who}`);
  push(`- 商品出场：${m.use}`);
  push(`- 收尾：${m.close}`);
  push('');
}

// ---------- 5. 麻烦库 ----------
push('## 5. 真实小麻烦库（`TROUBLE` / `TROUBLE_BY_CAT`）');
push('');
push('| 命中卖点词 | 麻烦 | 它怎么解决 | 收尾 |');
push('|---|---|---|---|');
for (const t of F.TROUBLE) {
  // `$^` 是「永不命中」的万能兜底条目，只在 TROUBLE_BY_CAT 指过来时用到，不进「命中词」表
  if (re(t.re) === '$^') continue;
  push(`| \`${re(t.re)}\` | ${t.name} | ${t.turn} | ${t.after} |`);
}
push('');
push('**每个品类都有兜底麻烦**（卖点词一个都没命中时用），不会掉进通用场景：');
push('');
push('| 品类 | 兜底麻烦 |');
push('|---|---|');
for (const cat of Object.keys(F.TROUBLE_BY_CAT)) push(`| ${cat} | ${F.TROUBLE_BY_CAT[cat]} |`);
push('');

// ---------- 6. 麻烦 → 场景 ----------
push('## 6. 麻烦 → 场景搭配（`TROUBLE_MOTIF`）');
push('');
push('脏只能在厨房/客厅，没电只能在路上/工位。先定麻烦，再在它能发生的场景里选：');
push('');
push('| 麻烦 | 可发生的场景 |');
push('|---|---|');
for (const name of Object.keys(F.TROUBLE_MOTIF)) push(`| ${name} | ${(F.TROUBLE_MOTIF[name] || []).join(' / ')} |`);
push('');

// ---------- 7. 商品级偏好 ----------
push('## 7. 商品级场景偏好（`MOTIF_PREFER`，优先级最高）');
push('');
push('| 命中词 | 固定场景 |');
push('|---|---|');
for (const x of F.MOTIF_PREFER) push(`| \`${re(x.re)}\` | ${(x.motifs || []).join(' / ')} |`);
push('');

// ---------- 8. 定格收尾细节 ----------
push('## 8. 定格收尾细节（`END_BIT`）');
push('');
push('最后 0.8 秒定格时"还在动的小细节"按品类取，写死一个通用部件会在别的品类上落到根本不存在的结构上（婴儿睡袋收在"滚轮/指示灯"就是这么来的）：');
push('');
push('| 品类 | 收尾细节 |');
push('|---|---|');
for (const cat of Object.keys(F.END_BIT)) push(`| ${cat === 'default' ? '（兜底）' : cat} | ${F.END_BIT[cat]} |`);
push('');

// ---------- 9. 用途判定 ----------
push('## 9. 用途判定（`PURPOSE_HINTS`）');
push('');
push('提示词里的「它是做什么的」判错，模型就会按错误用法拍：睡袋被当成帐篷、花洒被当成水龙头、');
push('鱼缸过滤器被当成喂食器。优先级是 `REFINE.purpose`（商品级覆写）→ 名字匹配下表 → 卖点兜底。');
push('');
push('| 命中词 | 用法说明 |');
push('|---|---|');
for (const x of F.PURPOSE_HINTS) push(`| \`${re(x.re)}\` | ${x.what} |`);
push('');
push('卖点只作最后兜底：`杯|壶|保温` 这类宽词会命中任意商品卖点里的“保温”，');
push('所以第一轮只拿「商品名 + 品类 + 形态标签」判，判不出来才把卖点加进来再判一次。');

process.stdout.write(L.join('\n') + '\n');
