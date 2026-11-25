// ============================================================
//  第三方 Seedance 技法库（提炼自公开仓库，2026-11-25）
//
//  来源与许可（详见 skills/seedance-prompt/references/third-party-craft.md）：
//   - LearnPrompt/awesome-seedance —— 模板策展 CC BY 4.0，代码 MIT
//     提炼 handheld-ugc-vlog / pov-continuous-take / ugc-creator-review /
//     product-commercial-shotlist / fashion-lookbook / food-asmr /
//     process-transformation-montage / character-reference-lock
//   - dexhunter/seedance2-skill —— MIT
//     提炼 @引用语法、高级运镜术语、景别词汇、避坑清单
//
//  设计原则：这是"按需注入的技法"，不是新的硬禁令。
//  每条只在形态/开关匹配时才写进提示词，避免把所有规则堆到每一条片子上。
//  原文留档在 _refs/，本文件只保留提炼后的可执行规则。
// ============================================================

/** 参考图身份锁：继承什么、不继承什么、跨镜保持什么 */
const REF_LOCK = {
  inherit: '形态、比例、颜色、Logo、材质、包装文字、配件数量（逐项核对，全片一致）',
  notInherit: '原图的背景、摆位、光线、拍摄角度、构图、画面里的其它文字——只把 @图片1 当商品样本，不要照着它的摆位摆拍',
  crossShot: '商品在转身、被手遮挡、快速运动之后仍然是同一件，不换款、不换色、不增减部件',
  ban: '不出现第二个同款、不把几件商品的特征平均或互换'
};

/** 相机缺陷词：按形态能量给"像真机拍的"质感，而不是一句笼统的"真实感" */
const CAMERA_FLAWS = {
  handheld: '轻微手持抖动、对焦呼吸（短暂失焦再对上）、曝光随环境轻微浮动、构图允许缓慢漂移；明确不要电子防抖、不要电影级稳定镜头、不要磨皮滤镜',
  pov: '摄像机固定在胸前或头部高度，只随身体动作移动；画面里不出现摄像机本身；边缘有轻微广角畸变、走路有上下起伏、快速转头有运动模糊；左右手各拿什么先说清楚，不凭空多出第三只手',
  fast: '机位跟着动作走，每一拍都有明确变化，不做长时间静止空镜',
  // 慢形态（美食 ASMR / 电影感广告）不能套 fast 那句「机位跟着动作走」——会和「稳定、敢留白」自相矛盾
  slow: '机位以稳为主，允许极缓慢的推近和一点呼吸感；不抖不晃，但也别做成三脚架上的产品片——光源方向全片不动，靠光影和材质变化撑住画面'
};

/** 设备年代词：点名机型比空喊"真实"更能带出光学质感 */
const GEAR_ERA = {
  ugc: '手机随手拍或胸挂运动相机质感',
  street: '手机随手拍质感',
  interview: '手持手机 + 领夹麦的现场感',
  roomtour: '手机边走边拍的居家漫游感',
  cinematic: '变形宽银幕镜头 + 体积光 + 可控浅景深的高级广告质感',
  food: '微距镜头 + 浅景深，蒸汽和油光要拍出来',
  pov: '胸挂运动相机或手机广角，视角高度就是眼睛的高度',
  ootd: '手机竖拍 + 自然光，版型和面料质感要看得清',
  test: '手机实拍 + 固定机位，测试过程不靠剪辑遮掩',
  beforeafter: '固定三脚架机位，前后两段用同一焦段、同一构图',
  pet: '贴着地面拍，机位和宠物同高，允许它自己走开再回来',
  travel: '手机随手拍质感，允许一点点手抖',
  tutorial: '手机俯拍桌面或固定机位，步骤和手部动作看得清',
  skit: '手机固定机位或手持跟拍，像朋友帮忙举着拍的'
};

/** 设备年代词按能量兜底：自由构想等临时形态没有 key，也要能定位设备 */
const GEAR_BY_ENERGY = {
  handheld: '手机随手拍或胸挂运动相机质感',
  fast: '手机手持跟拍，允许轻微晃动',
  slow: '手机固定机位 + 自然光，景深浅一点'
};

/** 取设备感：先按形态 key，取不到再按能量兜底（free / 以后新增的临时形态都靠这条） */
function gearOf(format = {}) {
  return GEAR_ERA[format.key] || GEAR_BY_ENERGY[format.energy] || '';
}

/** 高级运镜术语表：让机位描述更精确，仅作词表，不强制每条都用 */
const ADV_MOVES = [
  '推近 / 后拉', '左摇 / 右摇', '跟拍', '环绕', '低角度仰拍', '俯拍 / 鸟瞰',
  '一镜到底', '快速摇镜', '希区柯克变焦', '机械臂跟随'
];
const SHOT_SIZES = ['极致特写', '面部特写', '中近景', '中景', '全景', '建立镜头'];

/** 按形态附加的专属技法（只在匹配形态时注入） */
const FORMAT_CRAFT = {
  pov: [
    '第一帧就已经在动作进行中（例如手已举起、线已拉出），不要空镜或静止等待',
    '如果分镜里有硬切，必须明确写出切点；被标为一镜到底的那一段中途不得切镜'
  ],
  ugc: [
    '把人、商品各自锁成一条：主播的样貌服装一条，商品的外观配件另一条，两条都不能漂',
    { voiceOnly: true, t: '每拍最多一句随口说的话，焊在这一拍的动作上；台词短、口语化，不念参数、不喊口号' }
  ],
  food: [
    '每一拍同时给出"食物发生了什么可见变化"和"对应的那一个声音"（切开→刀声、下锅→滋啦声、端起→碗碟轻碰），声音按动作顺序排列',
    '每一拍只出现一件餐具，特写对准食物本身；手和餐具全片一致，不出现筷子变多、刀具变形'
  ],
  ootd: [
    '把上衣、下装、鞋、包逐件点名，并写明每一件在每一场都完全一致；主角单独锁一行，不用"同一套衣服"笼统带过',
    '每场只给一个景别、一个地点、一个动作；慢动作只留给最后的高潮镜头，不要全程慢放'
  ],
  beforeafter: [
    '先写不变量（机位、角度、焦距、布局、商品尺寸不动），再按空间顺序写变化（从左到右、由下到上），每一步给一个看得见的状态差',
    '结尾不要完全静止，留一个还在动的小细节'
  ],
  tutorial: [
    '步骤按真实操作顺序排，每步只做一个动作；上一步的完成态不要提前出现在这一步的画面里',
    '只留手和商品，不露正脸也能讲清楚（除非形态本身需要口播）'
  ],
  cinematic: [
    '广告感先靠光线立住：开片就写明商业广告的光位与质感，之后每一镜都沿用这套光逻辑',
    '每个微距或慢镜必须点名拍的是哪一处材质（例如杯壁的水珠、布料的织纹），不写泛泛的"细节特写"',
    '结尾留一帧稳定的主视觉（商品居中、背景还在动）；风格修饰词集中放在最后，不穿插在镜头中间'
  ],
  interview: [
    '被采访者与商品各锁一条；路人的反应要具体到一个动作或一句短话，不写"大家都很喜欢"',
    { voiceOnly: true, t: '同期声短句焊在对应那一拍上，不单独堆一段对白' }
  ],
  skit: [
    '笑点必须落在一个看得见的动作或道具上；镜头和物理规律保持正经，荒诞感来自反差而不是夸张表演'
  ],
  pet: [
    '商品和宠物各锁一条；宠物只按它自己的习性行动，不强行按住、不让它做人的动作',
    '全片只出现一只宠物，收尾靠它自己靠近镜头'
  ],
  travel: [
    '每一场给一个地点、一个时间点、一个动作；转场靠硬切，不要叠化或转场光效',
    '风、衣物、头发的轻微运动要一直存在，避免旅拍变成明信片摆拍'
  ],
  street: [
    '路人只做背景，不与主角发生需要精确配合的交互（对抛、击掌、碰杯特写都不要写）',
    '街景招牌和屏幕里的文字用景深虚化或角度避开'
  ],
  test: [
    '极限测试一次只测一个点（承重、防水、跌落任选其一），测试前后商品外观一致，不出现测试中换了一个新商品'
  ],
  roomtour: [
    '镜头走过真实的家，商品自然出现在它该在的位置；每停一处只讲一个使用动作，不要逐个展示配件'
  ]
};

/** 避坑清单：只在对应条件成立时追加，避免通用堆砌 */
function pitfallsFor(input, format, allowVoice) {
  const out = [];
  const energy = format && format.energy;
  if (energy === 'handheld') {
    out.push('不要在同一条片子里同时要求手持真实感和 4K 电影级布光——那是两套光逻辑，混在一起会变成塑料感');
  }
  if (format && format.key === 'cinematic') {
    out.push('不要混用高级广告光感和手机 UGC 纹理；也不要一拍里叠两种物理特效（液体、烟雾、粉末各占一镜）');
  }
  if (format && (format.key === 'pov' || format.key === 'ugc')) {
    out.push(allowVoice
      ? '不要用数码变焦当转场；不要用长台词拖慢节奏，每句控制在八个词以内'
      : '不要用数码变焦当转场');
  }
  if (format && format.key === 'food') {
    out.push('不要让食物中途变成另一道菜；配料表和餐具全片一致');
  }
  return out;
}

/**
 * 本地模板注入块：只在形态/开关匹配时返回对应段落。
 * @param {object} input 任务参数
 * @param {object} format pickFormat() 选中的形态
 * @param {boolean} allowVoice 本条是否允许台词
 * @returns {string[]} 要 push 进提示词的行
 */
function craftLines(input = {}, format = {}, allowVoice = false) {
  const lines = [];
  const key = format.key || '';
  const energy = format.energy || '';

  // 快形态给"跟着动作走"，慢形态给"稳住别晃但也别死板"，手持形态给缺陷词
  const flaw = CAMERA_FLAWS[energy] || '';
  if (flaw) lines.push(`· 相机质感：${flaw}。`);

  const gear = gearOf(format);
  if (gear) lines.push(`· 设备感：${gear}。`);

  for (const item of (FORMAT_CRAFT[key] || [])) {
    // 台词类技法只在允许人声时写，避免和 noVoice 开关打架
    if (typeof item === 'object' && item.voiceOnly && !allowVoice) continue;
    lines.push(`· ${typeof item === 'object' ? item.t : item}。`);
  }

  if (input.expand !== false && (energy === 'fast' || key === 'cinematic')) {
    lines.push(`· 运镜用词可从这些里选，让机位描述更具体：${ADV_MOVES.join(' / ')}；景别：${SHOT_SIZES.join(' / ')}。每一拍仍只给一种主运镜。`);
  }

  for (const t of pitfallsFor(input, format, allowVoice)) lines.push(`· 避坑：${t}。`);
  return lines;
}

/** 参考图锁段落（替换原来那句泛泛的一致性说明） */
function refLockLines() {
  return [
    '@图片1：商品一致性基准（只把这张图当商品样本，不是构图模板）。',
    `· 必须继承：${REF_LOCK.inherit}。`,
    `· 不得继承：${REF_LOCK.notInherit}。`,
    `· 跨镜保持：${REF_LOCK.crossShot}。`,
    `· ${REF_LOCK.ban}。`
  ];
}

/**
 * AI 代写任务书注入块：用简短硬性要求把同样的技法交给豆包，
 * 不写死分镜内容，保持"开场和结构由 AI 灵活决定"的取向。
 */
function briefLines(input = {}, ranked = [], allowVoice = false) {
  const keys = ranked.map(f => f.key).filter(Boolean);
  const lines = [];
  lines.push('【来自 Seedance 技法的补充要求】');
  lines.push(`· 参考图只当商品样本：必须继承商品本身的形态、比例、颜色、Logo、材质、包装文字、配件数量；不得继承原图的背景、摆位、光线、角度、构图；商品在转身、遮挡、快速运动后仍是同一件。`);
  lines.push('· 微距/慢镜要写明拍的是哪一处具体材质（水珠、织纹、热气），不要泛泛写"细节特写"；同一拍里只叠一种物理特效。');
  lines.push(`· 运镜用词示例：${ADV_MOVES.join(' / ')}；景别：${SHOT_SIZES.join(' / ')}。每一拍只给一种主运镜，机位描述要具体到术语。`);
  lines.push('· 不要把"手持真实感"和"4K 电影级布光"写在同一条片子里；也不要用数码变焦当转场。');
  if (keys.includes('ugc') || keys.includes('pov') || keys.includes('interview')) {
    // 台词那半句只在允许人声时出现，否则会跟「台词：全片无台词」自相矛盾
    lines.push('· 若选手持/第一人称/街采：先点名设备或机位（手机随手拍 / 胸挂运动相机 / 手持手机+领夹麦），把抖动、对焦呼吸、曝光浮动写出来；人、商品、场景各自锁定'
      + (allowVoice ? '，台词焊在对应那一拍上、每拍最多一句。' : '；这条片子不要台词，情绪靠动作和反应演出来。'));
  }
  if (keys.includes('food')) {
    lines.push('· 若选美食 ASMR：每一拍同时给出食物的可见变化和对应的一个声音，声音按动作顺序排；每拍只出现一件餐具。');
  }
  if (keys.includes('beforeafter') || keys.includes('tutorial')) {
    lines.push('· 若选前后对比/教程：先写不变量（机位、布局、商品尺寸不动），再按空间顺序写变化，结尾留一个还在动的小细节。');
  }
  return lines;
}

module.exports = {
  REF_LOCK, CAMERA_FLAWS, GEAR_ERA, GEAR_BY_ENERGY, ADV_MOVES, SHOT_SIZES, FORMAT_CRAFT,
  craftLines, refLockLines, briefLines, pitfallsFor, gearOf
};
