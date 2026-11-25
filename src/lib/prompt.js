// ============================================================
//  提示词引擎：按 Seedance 公式生成 9:16 竖屏分阶段带货提示词
//  三层骨架（固定参数 / 时间轴分镜 / 约束与规格）+ 一致性锁
//  商品理解交给 lib/product.js：不同形态用不同的真实动作链，
//  不再拿一套模板套所有商品。
// ============================================================
const productLib = require('./product');
const FMT = require('./formats');
// 第三方 Seedance 技法（LearnPrompt / dexhunter，按需注入，见 lib/craft.js）
const CRAFT = require('./craft');

// ---------- 用户原文消毒 ----------
// 用户可能在卖点/补充要求里写「{sku} 三个颜色」这种带花括号的内容，
// 它会被原样发给模型，还会被当成「没替换的占位符」——自检报错、模型也以为那里该填变量。
// 换成全角括号：视觉上不变，语义上不再是占位符。
const deBrace = (s) => String(s == null ? '' : s).replace(/\{([a-zA-Z0-9_]{1,24})\}/g, '｛$1｝');
const TEXT_KEYS = ['name', 'category', 'sellingPoints', 'audience', 'scene', 'logoText', 'extra', 'rerunFix', 'prompt'];
function sanitizeInput(input = {}) {
  const out = { ...input };
  for (const k of TEXT_KEYS) if (typeof out[k] === 'string') out[k] = deBrace(out[k]);
  return out;
}

// ---------- 品类预设：场景、光线、人物、细节与兜底动作 ----------
const PRESETS = [
  {
    key: 'drinkware',
    match: /杯|保温|水壶|茶壶|咖啡|马克|吸管|焖烧/,
    scene: '原木桌面，旁有干净亚麻布与窗边自然光',
    light: '左前 45° 窗光柔光，光位全片固定',
    prop: '亚麻布、木质杯垫',
    person: { age: '28-35 岁', dress: '浅色针织衫，袖口自然挽起' },
    s3: '杯口螺纹、内胆拉丝与盖子密封圈的材质细节',
    s4: '工具手旋开杯盖并完整取下，放在桌面一旁，再旋紧复位，展示密封与开合手感',
    s6: '角色先把杯盖完整取下放在桌面，再双手捧杯低头啜饮一口，热气升起；喝水时杯口是敞开的，杯盖不在杯上也不在手里',
    s7: '杯子放回桌面，杯口热气与窗边光斑形成安静氛围',
    usage: '要开盖才能喝的，先完整取下盖子放到桌面同一位置再喝（喝的时候杯上、手上都没有盖子）'
  },
  {
    key: 'kitchen',
    match: /锅|刀|菜板|餐具|碗|盘|厨房|削|刨|搅拌|破壁/,
    scene: '浅色石英石厨房台面，背景有隐约的瓷砖墙',
    light: '顶部柔光箱 + 右侧侧逆光勾边，全片固定',
    prop: '砧板、食材、干净餐布',
    person: { age: '30-40 岁', dress: '米色围裙，内搭白衬衫' },
    s3: '刀口/锅体涂层/手柄接缝的纹理与反光',
    s4: '工具手握持手柄，做一次按压或开合动作',
    s6: '角色在台面前用它处理食材，动作利落，商品始终在画面中心；如需开盖/掀盖，先完整打开再操作',
    s7: '处理好的食材整齐摆放，商品静置于台面一侧',
    usage: '厨具先就位再操作（砧板放稳、锅具上灶），带盖的先完整打开再操作'
  },
  {
    key: 'digital',
    match: /耳机|手机|充电|键盘|音箱|相机|电脑|数据线|电源|支架|麦克风/,
    scene: '深灰哑光桌面，背景极简，无杂物',
    light: '左前 45° 柔光 + 背部冷色轮廓光，全片固定',
    prop: '桌面、线材质感垫布',
    person: { age: '25-35 岁', dress: '灰色卫衣或深色衬衫' },
    s3: '外壳喷砂颗粒、接缝与接口的金属质感',
    s4: '工具手拿起并放回，展示握持与重量感',
    s6: '角色按真实方式使用设备（耳机就戴到耳朵或头上，手机就单手握持），佩戴时设备尺寸必须与真人身体一致，绝不为了「看清商品」把它画大',
    s7: '设备静置于桌面，指示灯或充电触点微亮，氛围安静',
    pose: '完整呈现于画面中央（按产品真实摆放姿态出现，不竖立、不倒置、不悬空）',
    usage: '按真实操作顺序：耳机盒先开盖再取放耳机，插头要插到底、拔到位；不出现「没开盒就拿出耳机」「耳机悬空显示」这类逻辑错误'
  },
  {
    key: 'apparel',
    match: /衣|裤|鞋|袜|帽|包|外套|裙|卫衣|T恤|背包/,
    scene: '浅米色室内空间，背景干净留白',
    light: '大面积窗光从左前方铺开，柔和低对比，全片固定',
    prop: '衣架、木质凳面',
    person: { age: '25-32 岁', dress: '与商品同色系的基础款搭配' },
    s3: '面料织纹、缝线与五金的微距细节',
    s4: '工具手提拎衣身或按压鞋面，展示版型与回弹',
    s6: '角色穿着商品自然走动两步或转身，动作幅度小',
    s7: '角色侧身停住，商品占据画面主体，背景柔和虚化',
    usage: '服饰先穿好、拉链扣好再展示活动；鞋先穿上脚再走动'
  },
  {
    key: 'beauty',
    match: /精华|面霜|口红|香水|洗发|面膜|水乳|粉底|眼霜|身体乳/,
    scene: '白色浴室台面或浅色大理石台面，配一支干花',
    light: '左前 45° 柔光，瓶身留一道细长高光，全片固定',
    prop: '干花、玻璃托盘、水痕',
    person: { age: '25-35 岁', dress: '白色棉质衬衫，头发自然挽起' },
    s3: '瓶身玻璃折射、泵头与瓶盖的接缝细节',
    s4: '工具手按压泵头一次，膏体或雾状质感可见',
    s6: '角色在面部或手部试用，动作轻缓，瓶身在画面前景清晰',
    s7: '产品摆回台面，旁边有使用后的痕迹，光线干净通透',
    usage: '先开盖再取用，用完盖回；按压类先按压再展示质地'
  },
  {
    key: 'food',
    match: /零食|坚果|饼干|咖啡豆|茶包|食品|糖果|牛肉|麦片|果干/,
    scene: '浅木餐桌，配亚麻餐垫与一只素色盘子',
    light: '窗边侧光，左侧补一块反光板，全片固定',
    prop: '餐盘、木勺、亚麻餐垫',
    person: { age: '25-35 岁', dress: '浅色家居服' },
    s3: '颗粒断面、包装材质与封口的微距细节',
    s4: '工具手撕开封口或倒出一份，展示分量',
    s6: '角色取食并放入口中，表情自然，商品在画面前景',
    s7: '盘中剩余一份，包装立于一侧，氛围温暖',
    usage: '先拆封再取食，取食动作干净利落，不出现「隔着包装吃」'
  },
  {
    key: 'home',
    match: /灯|枕|收纳|地毯|毛巾|家具|床|椅|沙发|置物|香薰/,
    scene: '浅色客厅或卧室一角，背景留白、无杂物',
    light: '窗光斜入 + 室内暖色辅助光，全片固定',
    prop: '木质边几、毛毯、素色墙面',
    person: { age: '28-38 岁', dress: '宽松家居服' },
    s3: '面料纤维、编织纹理与金属/木质部件的质感',
    s4: '工具手按压或展开商品，展示结构变化',
    s6: '角色在真实空间里使用它，动作自然，商品在画面中心',
    s7: '空间恢复整洁，商品成为画面视觉重心，光线柔和',
    usage: '先展开或组装到位再使用，用完复位'
  },
  {
    key: 'tool',
    match: /工具|电钻|扳手|螺丝|户外|露营|照明|手电|折叠|车载/,
    scene: '深灰工作台或户外木质桌面，背景简洁',
    light: '左前硬朗侧光 + 右后轮廓光，全片固定',
    prop: '木料、螺丝盒、粗布',
    person: { age: '30-45 岁', dress: '深色工装外套' },
    s3: '金属加工纹、橡胶握把颗粒与刻度细节',
    s4: '工具手完成一次按压/旋转/开合，展示机械结构',
    s6: '角色在实际场景中使用它，动作干脆，商品不被手掌遮挡',
    s7: '完成任务后商品放回台面，旁边留有使用痕迹',
    usage: '工具先到位再启动，用完归位；带安全锁的先解锁再操作'
  },
  {
    key: 'maternal',
    match: /婴儿|奶瓶|宝宝|童|孕妇|辅食/,
    scene: '浅色婴儿房一角，背景柔和无杂物',
    light: '大面积散射柔光，低对比，全片固定',
    prop: '棉质包被、木质玩具',
    person: { age: '28-35 岁', dress: '浅色家居服，动作轻柔' },
    s3: '材质安全细节、刻度与密封结构',
    s4: '工具手拧开或按压，展示结构与容量',
    s6: '角色抱着或照看宝宝使用商品，动作缓慢轻柔',
    s7: '商品静置于柔软织物上，画面安静温暖',
    usage: '母婴用品先拆封或清洁到位再给婴儿使用，动作始终轻柔'
  },
  {
    key: 'default',
    match: /.*/,
    scene: '纯白影棚 + 极简浅灰台面，无道具无场景干扰',
    light: '左前 45° 柔光箱，全片光位固定不变',
    prop: '浅灰台面、极简背景',
    person: { age: '25-35 岁', dress: '纯色基础款，不抢商品' },
    s3: '材质表面、接缝与标识的微距细节',
    s4: '工具手拿起并放回，做一次开合或按压',
    s6: '角色自然使用商品，商品始终位于画面中心',
    s7: '使用结束，商品回到画面中心，环境氛围自然',
    usage: '要开盖的先完整打开，要拆封的先拆开，要安装的先装到位'
  }
];

// 重抽变体：每点一次「重抽视频」就顺延一套（光线 / 场景 / 人物 / 运镜 / 收尾都变），
// 目的不是换汤不换药，而是真的换一条片子，方便你挑一条能用的。
const VARIANTS = [
  {
    key: 'A', tag: '标准版',
    lightSuffix: '', sceneSuffix: '', dress: '',
    stageMoves: [
      '0.3 秒快推到位：起幅从局部或全貌起手都行，推进要有速度感',
      '顺势推进或拉出，把商品和环境交代清楚',
      '跟焦快切：焦点由虚到实，一次到位',
      '低角度快速跟随，动作连贯不断档'
    ]
  },
  {
    key: 'B', tag: '逆光版',
    lightSuffix: '，右后 45° 再加一支逆光勾边，主体边缘有细亮边',
    sceneSuffix: '，背景远处有半开百叶窗投下的条状光斑',
    dress: '浅灰针织开衫',
    stageMoves: [
      '从虚焦猛地拉实：0.4 秒内从一片光晕里拉出局部特写',
      '快速横移 + 跟焦，掠过表面高光后拉出全貌',
      '近景侧向快推，压出前后层次',
      '中景快速环绕约 30°，动作连贯'
    ]
  },
  {
    key: 'C', tag: '俯拍版',
    lightSuffix: '，顶部加一支柔光、底部加白色反光板补暗部',
    sceneSuffix: '，桌面铺一块浅米色粗纺布',
    dress: '深灰衬衫，袖口挽到小臂',
    stageMoves: [
      '俯角 0.4 秒俯冲下压，从上方直接砸到局部',
      '快速升高拉出，从局部升到俯拍全貌',
      '俯拍微距快切，焦点在细节上停住',
      '俯拍中景快速升高后拉，跟住人物动作'
    ]
  },
  {
    key: 'D', tag: '低机位版',
    lightSuffix: '，侧后硬光勾轮廓、正面柔光提亮',
    sceneSuffix: '，背景是一面干净的浅色墙，带柔和投影',
    dress: '米白棉麻衬衫',
    stageMoves: [
      '贴地快推 0.3 秒到位，画面上缘只露出局部',
      '低机位快速后拉，一下露出完整形态',
      '低机位微距快切，光带扫过细节',
      '低机位中景快速拉远，跟住人物'
    ]
  }
];

function pickVariant(seed) {
  const n = Math.abs(parseInt(seed, 10) || 0);
  return VARIANTS[n % VARIANTS.length];
}

// 真实尺寸锚点（形态库里没写的品类用它兜底）
const SIZES = {
  drinkware: '保温杯/马克杯实际高约 20-26cm、直径 6-8cm：单手握持时杯身高度约等于一只手掌长，绝不高于小臂；双手捧杯时两只手掌能完整包住杯身',
  kitchen: '家用锅具直径 24-32cm、深 8-12cm；碗盘直径 15-25cm；刀具全长 25-33cm；摆在台面上时不超过成人两个手掌宽',
  digital: '耳机盒约 5-7cm、可单手完全包住；单只 TWS 耳机约 3cm；手机长约 15-16cm（约一只手掌长）；头戴耳机耳罩直径 7-9cm；键盘长 30-45cm；任何设备都不能比人的头更大',
  apparel: '服装按真人尺码贴合身体；鞋长约 24-30cm；帽子头围 55-60cm；包袋可单肩或手提，不出现装不下人的巨型包',
  beauty: '护肤品瓶 30-100ml、高约 8-15cm，可单手握住；口红约 8cm；面膜约一张脸大小；刷具不超过手掌长',
  food: '按真实食物体积出现，与餐具、手掌的比例一致；不出现比脸还大的单颗水果或一整块肉',
  home: '按家居品实际尺寸出现：抱枕 45-50cm、台灯高 40-60cm、地毯 120×160cm 以上、收纳盒可双手抱住；与桌面、沙发、人体的比例一致',
  appliance: '按家电实际尺寸出现：桌面小家电高 20-35cm、立式家电高 1.1-1.3m（到成人腰部）、扫地机直径 32-35cm；绝不出现比人还高的家电',
  sports: '按运动器材实际尺寸：瑜伽垫 183×61cm（略短于身高）、哑铃单只 25-35cm、帐篷高约 1.1m；与人体比例一致',
  pet: '按宠物体型定尺寸：猫窝直径 40-50cm、狗窝按犬种、牵引绳织带宽 1.5-2.5cm；商品必须放得下真实体型的宠物',
  jewelry: '项链链长 40-45cm、吊坠 1-3cm；戒指内径 1.6-1.8cm；手镯内径 5.5-6cm；全部按贴在皮肤上的真实比例，绝不放大成手链粗的链子',
  eyewear: '镜框总宽 13-14cm（与成人脸宽一致）、镜腿长 14-15cm；戴上后镜框边缘不超出脸的轮廓',
  office: 'A5 本 21×14cm、A4 本 29×21cm、笔长 13-15cm；摆在桌面上不超过成人两个手掌',
  toy: '单块积木 2-3cm、手办高 10-25cm、拼图成品不超过成人两个手掌；与手部比例一致',
  car: '车载支架宽 6-9cm、脚垫按车型、记录仪约 10cm；安装位置不影响驾驶视线',
  health: '按摩仪/筋膜枪长 20-25cm、可单手握持；血压计袖带按成人上臂围；贴身处不与皮肤穿插',
  garden: '花盆口径 15-25cm、高 15-20cm；园艺铲长 25-30cm；与手掌、阳台栏杆比例一致',
  tool: '五金工具按实际规格：握柄长 10-15cm 贴合手掌、整机可单手握持或双手操作，不出现握不住的巨型工具',
  maternal: '母婴用品按实际尺寸：奶瓶高约 20cm、可单手握住；婴儿车长约 80-100cm；纸尿裤、口水巾与婴儿身体比例一致',
  default: '按现实同类商品的真实尺寸出现，与手、人体、桌面等参照物的比例一致'
};

// 新类目没有专属预设时，借用最接近的那套（光位/人物/收尾都可复用）
const PRESET_ALIAS = {
  appliance: 'home', sports: 'tool', pet: 'home', garden: 'home', toy: 'home',
  jewelry: 'beauty', eyewear: 'beauty', health: 'beauty',
  office: 'digital', car: 'digital'
};

// 15 秒 8 镜基准节拍 —— 电商短视频节奏：钩子开场 → 揭示 → 卖点快切 → 使用 → 结果 → 定格
// 不再「先平铺直叙展示产品全貌」：前 1.6 秒必须抛出一个视觉爆点，先抓住人再讲产品。
const BEATS = [
  { id: 'S1', t: [0.0, 1.6], shot: '极端特写', move: '0.3 秒快推到位的推镜', act: '开场爆点：先抛结果/反差/悬念，具体怎么开由这件商品的特点决定', light: '高对比侧逆光，边缘压一道硬高光', land: '第一帧就有抓人的看点', who: 'hook' },
  { id: 'S2', t: [1.6, 3.2], shot: '中景', move: '快速拉出（0.4 秒完成）', act: '揭示：拉出全貌，刚才那个局部原来就是这件商品', light: '主光扫过正面，高光位置稳定', land: '商品完整入画，占画面高度 60%-70%', who: 'none' },
  { id: 'S3', t: [3.2, 5.2], shot: '微距', move: '跟焦快切，焦点由虚到实', act: '卖点一：材质与工艺的真实细节，快推到位', light: '窄光带扫过表面形成质感高光', land: '落点在卖点对应的结构（纹理/接缝/按键/材质）', who: 'none' },
  { id: 'S4', t: [5.2, 7.2], shot: '近景', move: '固定机位，动作驱动画面', act: '卖点二：手部一次干脆的操作（开/合/按/拉/擦）', light: '手部投影方向与主光一致', land: '动作完成的那一瞬间', who: 'hand' },
  { id: 'S5', t: [7.2, 9.4], shot: '中景', move: '低角度快速跟随', act: '卖点三：人物直接入画使用，动作带速度感', light: '人物边缘有柔和轮廓光', land: '使用动作与商品的接触点', who: 'person' },
  { id: 'S6', t: [9.4, 11.4], shot: '近景 / 中景 交替', move: '两个机位硬切', act: '连续使用 2-3 个连贯动作，节奏推到最紧', light: '光位不变，明暗关系稳定', land: '动作连贯、不跳步', who: 'person' },
  { id: 'S7', t: [11.4, 13.6], shot: '中景', move: '轻微推近', act: '结果呈现：用完之后的实际效果 / 前后对比', light: '环境光均匀，无突变', land: '效果一眼可见', who: 'person' },
  { id: 'S8', t: [13.6, 15.0], shot: '中景', move: '稳定定格 0.8 秒', act: '商品回到画面中心定格收尾', light: '与 S1 同光位同色温', land: '最后半秒画面稳定不抖', who: 'none' }
];

// 混剪 8 条独立素材（平台限时长时降级用）
const CLIPS = [
  { id: 'C1', dur: '2s', shot: '极端特写', move: '快推', act: '钩子：结果/反差/悬念先抛出来', who: 'hook' },
  { id: 'C2', dur: '2s', shot: '中景', move: '快速拉出', act: '揭示全貌，商品完整入画', who: 'none' },
  { id: 'C3', dur: '2s', shot: '微距', move: '跟焦快切', act: '材质与工艺细节', who: 'none' },
  { id: 'C4', dur: '2s', shot: '近景', move: '固定 + 动作驱动', act: '一次干脆的功能操作', who: 'hand' },
  { id: 'C5', dur: '2s', shot: '全景', move: '低角度跟随', act: '场景里使用，人物入画', who: 'person' },
  { id: 'C6', dur: '3s', shot: '中景', move: '多机位硬切', act: '连续使用动作，节奏最快的一段', who: 'person' },
  { id: 'C7', dur: '2s', shot: '近景', move: '轻微推近', act: '使用结果 / 前后对比', who: 'person' },
  { id: 'C8', dur: '2s', shot: '中景', move: '拉远定格', act: '商品定格收尾', who: 'none' }
];

// 开场钩子：先按「形态」精确匹配（不同形态的爆点完全不一样），再按品类兜底。
// 一个通用的「手按压材质」放到吸尘器上就是错的，所以这里按形态分开写。
const HOOK_FORM_RULES = [
  { re: /earphone|headphone/i, text: '耳机戴上的一瞬间外界噪音被「抽走」：画面从嘈杂抖动变成安静稳定，可让桌上的水杯被低频震出涟漪；只拍戴上的动作和这个效果，不拍全貌' },
  { re: /appliance-vacuum|appliance-robot/i, text: '吸口贴着地面高速掠过，一把碎屑和毛发瞬间被吸走，地面留下一道干净的边界；只拍吸口与碎屑，不拍整机' },
  { re: /appliance-fan/i, text: '一档启动，桌面的纸片、头发、窗帘瞬间被吹动、朝一个方向倒；只拍风的效果和局部扇叶' },
  { re: /appliance-humidifier/i, text: '细密水雾喷出，在侧逆光里变成一束看得见的白雾，落在绿植或手背上；只拍雾，不拍整机' },
  { re: /appliance-heater/i, text: '加热片瞬间变红，镜头贴近能看到热浪扭曲空气；只拍热与光' },
  { re: /appliance-iron/i, text: '高温蒸汽「哧」地喷出，一件皱衣服在一秒内被熨平一段；只拍褶皱消失的瞬间' },
  { re: /phone|digital-laptop/i, text: '暗处屏幕突然点亮，光打在桌面和手上，画面只有屏幕的光与内容；只拍点亮的一瞬' },
  { re: /powerbank/i, text: '插上的一瞬间，手机电量数字开始往上跳、指示灯亮起；只拍接口与电量变化' },
  { re: /keyboard/i, text: '手指高速连打，键帽快速回弹、声音干脆；画面只拍键帽与指尖' },
  { re: /home-rug|home-bedding|home-pillow|cloth-top|sports-mat/i, text: '一只手掌用力按进材质里、压出明显凹陷，松手瞬间材质快速回弹、纹理恢复原状；只拍这一小块，看不到全貌' },
  { re: /home-curtain/i, text: '厚重窗帘被一把拉开，光「刷」地灌进房间，灰尘在光柱里漂浮；只拍光与布料' },
  { re: /home-clean|kitchen-tableware|maternal-food/i, text: '一半脏、一半干净的同框特写：脏污那一侧被一下带过，抬起来时留下一条干净的分界线，对比强烈' },
  { re: /beauty-lip/i, text: '一支口红在唇上划过去，颜色一下就出来了；或者在手背上一道试色，边缘清晰、质地看得见；只拍唇或手背那一小块' },
  { re: /beauty-/i, text: '指腹抹开一小块膏体或精华，皮肤上留下光泽，质地拉丝或化开；只拍手背或脸颊局部，不拍整瓶' },
  { re: /knife/i, text: '刀刃落下去，食材被一次切开、断面平整，刀身反光一闪；只拍刀与食材接触的那一下' },
  { re: /kitchen-appliance/i, text: '出锅或出杯的一瞬间：炸篮拉出来热气「呼」地涌上来、表皮还在响，或杯壁里液体高速打转；只拍这个瞬间' },
  { re: /cup-|food-drink/i, text: '液体被倾倒、切开、拉丝或热气升腾的极近特写，质感与温度拉满，看不到容器全貌' },
  { re: /shoes/i, text: '鞋踩进去的那一下：脚落地、鞋底抓地、系带收紧，鞋型在脚上撑起来；只拍脚与鞋' },
  { re: /bag/i, text: '手把包拎起来，肩带挂上肩，包身自然垂下来、不塌不变形；只拍手、肩与包' },
  { re: /jewelry|eyewear|home-vase|home-aroma/i, text: '极近特写下光线快速扫过表面，金属、镜面或玻璃的反光一闪而过，只看到光泽与纹理' },
  // 下面几条是「大类里混着不同东西」的补丁：零食不是液体、积木不是承重件、猫窝不是坐上去试的
  { re: /food-pack|food-nut|food-snack|food-jar/i, text: '封口被撕开的一瞬间，抓一把倒进盘子或手心，颗粒碰撞的声音先出来，断面和油光在侧光里很亮；只拍手与颗粒，看不到整箱' },
  { re: /pet-bed|pet-mat/i, text: '猫（狗）先在纸箱或地板上转两圈，绕着新窝闻一遍，最后一屁股摊进去、压出一块凹陷；只拍它进去的那一下' },
  { re: /toy-block|toy-puzzle/i, text: '一把零件摊开铺满桌面，手指飞快拼上几块，「咔」一声扣紧成型；只拍手与零件，看不到包装盒' },
  { re: /toy-figure/i, text: '手办从盒子里拿出来，摆到桌面上，镜头贴近转半圈，涂装、发丝和配件在光下一样样显出来；只拍本体' },
  { re: /home-magnet/i, text: '一只手把一张照片随手吸到冰箱门上，「嗒」地贴住、轻轻一拨不掉；门面上已经贴了几张，只拍手与门面' },
  { re: /home-shower/i, text: '一开阀，水柱打在肩背或地面上，水花立刻溅开、有力道，镜头贴着水柱看；只拍水与人的肩背局部' },
  { re: /appliance-filter|aquarium|fish-tank/i, text: '一缸浑水对着光，过滤器启动后水流带起细泡，几分钟过去能看见缸底；只拍水、气泡与水流方向' },
  { re: /home-furniture|maternal-stroller|sports-outdoor/i, text: '重物或整个人一下压到它上面，结构稳稳撑住、没有塌陷变形，随后快速弹回原状；只拍受力那一瞬' }
];

const HOOKS = {
  soft: '一只手掌用力按进材质里、压出明显凹陷，松手瞬间材质快速回弹、纹理恢复原状；全程极近特写，看不到商品全貌',
  tech: '一个动作触发、效果立刻出现（运转、出风、发光、加热、吸附），画面只拍这个效果本身，不拍商品全貌',
  clean: '一半脏、一半干净的同框特写：脏污一侧被一下带过，抬起来的瞬间留下一条干净分界线，对比强烈',
  food: '液体被倾倒、切开、拉丝或热气升腾的极近特写，质感与温度拉满，看不到容器全貌',
  shine: '极近特写下光线快速扫过表面，金属/镜面/皮革的反光一闪而过，只看到光泽与纹理，看不到整体',
  default: '商品被快速抛起接住 / 猛地抽走 / 被水冲到的一瞬间，有明确的速度感与冲击力，只拍到局部'
};
const HOOK_CATS = {
  soft: ['home', 'apparel', 'pet', 'toy', 'maternal', 'sports'],
  tech: ['digital', 'appliance', 'car', 'tool', 'office'],
  clean: ['beauty', 'kitchen', 'garden', 'health'],
  food: ['food', 'drinkware'],
  shine: ['jewelry', 'eyewear']
};
function pickHook(p) {
  const form = (p && p.form) || '';
  if (form) {
    for (const r of HOOK_FORM_RULES) {
      if (r.re.test(form)) return { key: 'form', text: r.text };
    }
  }
  const cat = (p && p.cat) || '';
  for (const k of Object.keys(HOOK_CATS)) {
    if (HOOK_CATS[k].indexOf(cat) >= 0) return { key: k, text: HOOKS[k] };
  }
  return { key: 'default', text: HOOKS.default };
}

function presetOf(key) {
  const k = PRESET_ALIAS[key] || key;
  return PRESETS.find(p => p.key === k) || PRESETS[PRESETS.length - 1];
}

function pickPreset(category, name) {
  return presetOf(productLib.analyze({ name, category }).cat);
}

function scaleBeats(beats, duration) {
  const base = 15;
  const k = duration / base;
  return beats.map(b => ({ ...b, t: [Number((b.t[0] * k).toFixed(1)), Number((b.t[1] * k).toFixed(1))] }));
}

function fmtRange(a, b) {
  const f = n => (Number.isInteger(n) ? n.toFixed(1) : String(n));
  return `${f(a)}-${f(b)}s`;
}

// 片长决定镜头数：15 秒给满 8 拍；10 秒压成 6 拍；5 秒压成 4 拍。
// 8 拍硬塞进 5 秒 = 每镜 0.6 秒，AI 视频里根本切不出来，写进提示词只会让模型乱跳。
// 压缩不是「丢段落」：同一组里的动作与落点合并成一句，卖点一条都不少。
const FLOW_PLAN = {
  8: [[0], [1], [2], [3], [4], [5], [6], [7]],
  6: [[0], [1], [2, 3], [4], [5, 6], [7]],
  4: [[0], [1, 2], [3, 4, 5], [6, 7]]
};
const STAGE_SHORT = {
  '开场钩子': '钩子', '交代场景': '场景', '卖点一': '卖点一', '卖点二': '卖点二',
  '卖点三': '卖点三', '情节推进': '推进', '结果兑现': '结果', '定格收尾': '收尾'
};
const STAGE_NAMES = ['开场钩子', '交代场景', '卖点一', '卖点二', '卖点三', '情节推进', '结果兑现', '定格收尾'];

/**
 * 按片长把 8 拍压成 4/6/8 镜，返回每一镜的完整描述。
 * @returns {{t0:number,t1:number,pct:string,name:string,act:string,land:string,camIdx:number}[]}
 */
function shapeFlow(duration, filledActs, cams, lands) {
  const beats = scaleBeats(BEATS.slice(), duration);
  const n = duration >= 12 ? 8 : (duration >= 8 ? 6 : 4);
  const plan = FLOW_PLAN[n];
  return plan.map((group) => {
    const head = beats[group[0]];
    const tail = beats[group[group.length - 1]];
    const name = group.map(i => STAGE_SHORT[STAGE_NAMES[i]] || STAGE_NAMES[i]).join(' + ');
    const act = group
      .map(i => String((filledActs || [])[i] || '').replace(/[。；;\s]+$/, ''))
      .filter(Boolean)
      .join('；');
    return {
      t0: head.t[0],
      t1: tail.t[1],
      pct: `${Math.round((head.t[0] / duration) * 100)}%-${Math.round((tail.t[1] / duration) * 100)}%`,
      name,
      act,
      land: lands[group[group.length - 1]],
      camIdx: group[0]
    };
  });
}

// 把商品理解的结果整理成「拍摄时该怎么做」的四段动作
function buildPlan(input, V) {
  // 商品库分类 + 语义纠偏（泳装/清洁剂/服饰鞋包这几类容易误判）
  const p = FMT.refineProduct(productLib.analyze(input), input);
  // 品类兜底：商品库认不出来的会给 default，正文就写成「通用商品 · 通用商品」，
  // 场景/尺寸也走通用档。这里用 CAT_HINTS 再推一次，兜不住才认 default。
  // （以前漏了这一步：CAT_HINTS 只在选形态时起作用，正文却是通用商品，两处打架）
  const guess = FMT.catOf(input, p);
  if (guess && guess !== p.cat) {
    const keepPatch = !!p.refined;   // refine 过的字段是专门为这个商品写的，别动
    p.cat = guess;
    p.catLabel = FMT.CAT_LABEL[guess] || p.catLabel;
    if (!keepPatch) {
      // 旧形态属于另一个品类（睡袋被当成帐篷那种），场景/尺寸/动作全部作废，交给品类 preset
      for (const k of ['form', 'scene', 'prop', 'person', 'detail', 'hand', 'use', 'end', 'size', 'pose', 'ban', 'steps', 'light']) delete p[k];
      p.formLabel = FMT.CAT_FORM[guess] || p.catLabel;
    }
  }
  const refined = !!p.refined;
  const preset = presetOf(p.cat);
  const scene = String(input.scene || '').trim() || p.scene || preset.scene;
  // 纠偏过的品类场景/光线是专门写的，不再叠加通用变体后缀，免得「海边」被加上「百叶窗光斑」
  const light = p.light || (preset.light + (refined ? '' : (V.lightSuffix || '')));
  const sceneFull = scene + (refined ? '' : (V.sceneSuffix || ''));
  const size = p.size || SIZES[p.cat] || SIZES.default;
  const pose = p.pose || preset.pose || '完整立在画面中央，真实摆放姿态';
  const detail = p.detail || preset.s3;
  const hand = p.hand || preset.s4;
  const use = p.use || preset.s6;
  const end = p.end || preset.s7;
  const steps = (p.steps && p.steps.length) ? p.steps : [];
  const usage = steps.length
    ? '动作顺序必须是：' + steps.join(' → ') + '（不能跳步、不能颠倒）'
    : (preset.usage || '');
  const person = p.person || preset.person;
  const dress = (refined ? ((person && person.dress) || '') : (V.dress || (person && person.dress) || '')).trim();
  // 这个品类真实会遇到的小麻烦：形态正文（情景段子开场）要引用它，
  // 不引用的话睡袋的开场会写成「满地宠物毛 / 瓶盖拧不开」这种跟商品无关的举例。
  const trouble = (() => {
    try {
      const c = FMT.conceive(input, input.variant);
      return {
        trouble_name: c.trouble.name,
        trouble_setup: c.trouble.setup,
        trouble_turn: c.trouble.turn,
        trouble_after: c.trouble.after
      };
    } catch (e) { return {}; }
  })();
  return { p, preset, sceneFull, light, size, pose, detail, hand, use, end, steps, usage, person, dress, refined, trouble };
}

/**
 * 生成完整提示词（发给豆包的那一份）
 * @param {object} input {name, category, sellingPoints, audience, scene, duration, ratio, logoText, extra, variant}
 */
function buildPrompt(input = {}) {
  input = sanitizeInput(input);
  const V = pickVariant(input.variant);
  const duration = Number(input.duration) || 15;
  const ratio = input.ratio || '9:16';
  const selling = (input.sellingPoints || '').trim();
  const audience = (input.audience || '').trim();
  const sceneIn = (input.scene || '').trim();
  const keepText = (input.logoText || '').trim();
  const extra = (input.extra || '').trim();
  // 用户的勾选项（不再写死）：不出现字幕 / 不出现台词
  const noText = input.noText !== false;      // 默认不出字幕
  const noVoice = input.noVoice !== false;    // 默认不出台词（界面勾选项可放开）
  const { p, preset, sceneFull, light, size, pose, detail, hand, use, end, steps, usage, person, dress, trouble } = buildPlan(input, V);

  const goods = p.core || p.name || '商品';
  const sellsLines = (p.sells || []).map(s => s.v);
  const sellParts = selling ? selling.split(/[，,；;、\n]+/).map(s => s.trim()).filter(Boolean) : [];
  const sell1 = sellParts[0] || sellsLines[0] || '';
  const sell2 = sellParts[1] || sellsLines[1] || sell1;
  const sell3 = sellParts[2] || sellsLines[2] || sell2;

  // 形态（导演层）：同一件商品每次重抽换一种叙事路子，避免八条片子一个样
  const format = FMT.pickFormat(input, input.variant);
  const cams = FMT.cameraOf(format);
  const acts = format.acts || [];
  const ctx = {
    goods, name: p.name || goods, sell1, sell2, sell3,
    detail, hand, use, end, scene: sceneIn || sceneFull, light,
    cast: person ? `${person.age}，穿${dress}` : '真实日常穿着的主角',
    size, prop: p.prop || preset.prop || '',
    endbit: (() => { try { return FMT.endbitOf(p.cat); } catch (e) { return '光影移动'; } })(),
    ...trouble
  };
  const fillAct = (i) => FMT.fill(acts[i] || '', ctx).replace(/[。；;\s]+$/, '');
  const allowVoice = !!format.voice && !noVoice;
  // 镜头数跟片长走：15 秒 8 镜、10 秒 6 镜、5 秒 4 镜（5 秒塞 8 镜＝每镜 0.6 秒，切不出来）
  const lands = [
    '第一帧就有让人停下来的看点',
    '一眼看懂：这是什么地方、谁在用、用的是什么',
    '第一条卖点被一个可见的细节证明',
    '第二条卖点落在一次真实的操作上',
    '第三条卖点/核心体验在动作里成立',
    '情节往前走一步（有人加入、场景变化、出现反转）',
    '结果清楚可见，不用解释',
    '最后半秒画面稳定、主体清晰'
  ];
  const flow = shapeFlow(duration, acts.map((_, i) => fillAct(i)), cams, lands);
  // 开场钩子：形态精确匹配到这件商品时（耳机、吸尘器、窗帘、地毯…），
  // 用它写的专属爆点覆盖形态的通用开场——那条比「一次干脆的操作」具体得多。
  // 没精确匹配就保留形态自己的开场（段子形态此时已按品类填入了真实麻烦）。
  const hook = (() => { try { return pickHook(p); } catch (e) { return { key: '', text: '' }; } })();
  if (hook.key === 'form' && hook.text) flow[0].act = hook.text;
  // 每镜实际时长：按压缩后的镜数算，别再写死 1.6-2 秒
  const perShot = (duration / flow.length).toFixed(1);
  // 这条片子一句话讲什么 —— 分镜写多了容易拍成素材堆，先给一句主线锚住
  const storyline = [
    `${format.name}`,
    sell1 ? `用一个可见的动作证明「${sell1}」` : '把商品真实用起来',
    `最后让 ${p.name} 和使用后的结果同时留在画面里`
  ].join('，');

  const lines = [];

  // 结构：固定参数 → 创作要求 → 商品识别 → 参考素材 → 形态 → 时间轴 → 真实感 → 声音 → 约束 → 画质
  lines.push('【固定参数】');
  lines.push(`时长：${duration} 秒 / ${flow.length} 个镜头（平台若只支持固定档位，就用最接近且不短于它的档位，百分比段按整条片长等比铺满，不砍段落、不截断）`);
  lines.push(`比例：${ratio}（${/9:16|3:4|4:5/.test(ratio) ? '竖屏' : '横屏'}）`);
  lines.push('画面大小：1080p');
  lines.push(`相机身份（放在提示词最前，权重最高）：${FMT.lookOf(format)}`);
  lines.push(`画风：真实拍摄${format.energy === 'slow' ? '，电影级质感，光影讲究，允许留白' : format.energy === 'handheld' ? '，手机/手持实拍质感，允许轻微抖动与对焦呼吸' : '，实拍商业质感，节奏利落'}，不做塑料感 3D、不做过度磨皮`);
  lines.push(`视频形态：${format.name}（${format.tag}）—— 不是产品展示片，是带场景、有人物、有情节的短视频`);
  lines.push('');
  lines.push(`【本条主线】${storyline}。所有分镜都为这条主线服务，跟主线无关的镜头一律删掉。`);
  lines.push('');

  const audFinal = audience || p.audience;
  const reqLines = [];
  reqLines.push(`· 商品：${p.name}（画面里必须一眼看出是这一件，不能按名字里的修饰词乱猜）`);
  if (audFinal) reqLines.push(`· 目标人群：${audFinal}。人物的年龄、气质、服装、所处环境都要贴合这群人。`);
  if (sceneIn) reqLines.push(`· 指定场景：${sceneIn}。全片就在这个场景（或它的内外两个机位）里，不额外加无关地点。`);
  else reqLines.push(`· 场景：${sceneFull}（未指定时按商品类型自动匹配，并补足真实生活痕迹）`);
  reqLines.push(`· 时长与节奏：${duration} 秒，拆成 ${flow.length} 个镜头，每镜约 ${perShot} 秒；开场要有抓人的爆点，先抛效果、先演冲突、还是先给氛围由形态决定；人物什么时候入画跟着叙事走。`);
  if (selling) reqLines.push(`· 必须让人看到的卖点：${selling}。每一条都要落到具体动作、场景或材质细节上，不能靠文字表达（对应哪一镜见下面的时间轴）。`);
  const keepClean = keepText.replace(/[「」“”"']/g, '').trim();
  if (keepText) reqLines.push(`· 必须保留的本体文字：「${keepClean}」——位置、大小、字体、颜色与 @图片1 完全一致，一个字都不改、不模糊、不被手或道具遮住。`);
  if (extra) reqLines.push(`· 补充要求：${extra}。这条是硬性约束，优先级高于下面的默认风格；与默认风格冲突时以这条为准。`);
  lines.push('【创作要求】（来自需求表，必须逐条体现在画面里）');
  lines.push(...reqLines);
  lines.push('');

  // 用途识别：冷门商品（车贴/纹身贴/被子/地毯…）最容易按名字乱猜，这里直接写清楚它怎么用
  // REFINE 里能直接给 purpose（例如婴儿睡袋不能被写成露营装备），优先用它
  const purpose = p.purpose || (() => { try { return FMT.purposeOf(input, p); } catch (e) { return ''; } })();
  lines.push('【商品识别】（按这条理解画面里到底是什么、是做什么用的，不要按名字里的修饰词乱猜）');
  lines.push(`· 商品：${p.name}`);
  lines.push(`· 品类与形态：${p.catLabel} · ${p.formLabel}`);
  if (purpose) lines.push(`· 它是做什么的：${purpose}`);
  lines.push(`· 真实尺寸：${size}`);
  if (steps.length) lines.push(`· 真实使用顺序：${steps.join(' → ')}`);
  lines.push('');

  lines.push('【参考素材】');
  // 身份锁：必须继承 / 不得继承 / 跨镜保持（提炼自 LearnPrompt 的 reference identity lock）
  for (const l of CRAFT.refLockLines()) lines.push(l);
  if ((Number(input.imageCount) || 1) > 1) {
    lines.push('@图片2 起：同一件商品的其他角度 / 细节实拍。多图之间只是角度差别，不是多件商品——不要把不同图里的包装、配件、颜色拼成图里没有的东西。');
  }
  lines.push('');

  lines.push(`【本条片子的形态：${format.name}】`);
  lines.push(`为什么用这个形态：${FMT.whyOf(format, ctx)}。`);
  lines.push(`世界与光线：${format.world}。`);
  if (person) lines.push(`人物设定：${person.age}，穿${dress}；表情和动作自然真实，不演、不看镜头（除非形态本身是口播采访类）。`);
  lines.push(`镜头语言：${format.energy === 'slow' ? '稳定、缓慢、敢留白，一个镜头只做一件事' : format.energy === 'handheld' ? '手持跟拍为主，允许一次失焦再对上，像朋友随手拍的' : '机位跟着动作走，硬切衔接，拒绝匀速平铺'}。`);
  lines.push('');

  lines.push(`【时间轴分镜】${flow.length} 个镜头、每镜约 ${perShot} 秒，硬切衔接；全片不许出现「静止摆拍的空镜」，也不许变成产品目录式的逐个展示`);
  for (let i = 0; i < flow.length; i++) {
    const f = flow[i];
    const cam = cams[f.camIdx] || cams[cams.length - 1];
    lines.push(`${f.pct}（${f.name}）：${cam.shot}｜${cam.move}。${f.act}。落点：${f.land}。`);
  }
  lines.push('');
  lines.push('【节奏参考】以上百分比是参考节奏，可以按这条片子的叙事微调；硬要求只有两条：每一镜都有动作或变化，观众随时知道自己在看什么。');
  lines.push('');
  lines.push('【分镜纪律】（不满足就会出废镜，逐条自检）');
  lines.push('· 商品或它的使用结果必须在前 3 秒内出现（可以是局部特写），不要等到中段才亮货。');
  lines.push('· 每镜只承担一个主动作；相邻两镜至少在景别 / 机位角度 / 人物关系里变一项，不许连续两镜同景别同机位。');
  lines.push('· 一个动作链只在一镜里完整发生：前一镜不得提前出现动作完成后的状态（前一镜已拆开包装、后一镜又拍拆包装＝穿帮）。');
  lines.push('· 禁四类拍不出来的写法：①两个主体精确配合的交互（对抛、击掌、碰杯特写）②心理描写（"犹豫""意识到""想起了"）③否定式动作（"没接住""不理他"）④一镜内三步以上的手部动作链。遇到就换成"实际发生的画面"，或拆成两镜。');
  if (allowVoice) lines.push('· 有人声的镜头：情绪按「触发 → 身体先反应 → 面部克制」三拍写，不写"他很惊讶""很满意"这类终态词。');
  lines.push('· 最后两镜里给一次自然的行动引导动作（手指向画面下方、把商品递向镜头），不做口播喊话、不出现"点击下方"字样。');
  if (!allowVoice && !(input.noAmbient === true)) {
    lines.push('· 街道、店内、菜市场、地铁这类公共场景必须有真实人声底噪（别人在说话、远处有人喊），但听不清内容，不许发展成能听懂的对话。');
  }
  lines.push('');

  lines.push('【真实感清单】（这一条片子像不像真的，主要看这些）');
  for (const r of (format.reality || [])) lines.push(`· ${r}`);
  // 第三方技法则按形态能量/key 注入，不堆到每条片子（见 lib/craft.js）
  for (const c of CRAFT.craftLines(input, format, allowVoice)) lines.push(c);
  lines.push('· 场景里允许出现与商品无关的生活细节（杂物、植物、路过的影子），但不得遮挡主体。');
  lines.push('· 光线不追求完美均匀：窗边亮、角落暗、逆光时主体边缘过曝一点，都是允许的。');
  lines.push('');

  lines.push('【声音设计】');
  const soundBase = (() => {
    let s = String(format.sound || '').replace(/[，,；;]?\s*(全片)?无对白[。]?$/, '').replace(/[，,；;。]$/, '');
    if (!allowVoice) {
      // 用户勾了「不出现台词」：把形态自带的「同期人声对白」从声音方案里摘掉，
      // 否则会出现「同期人声对白 + 全片无人声台词」这种自相矛盾的写法。
      s = s.replace(/^同期人声对白（[^）]*）\s*[+＋]\s*/, '')
           .replace(/[+＋]\s*同期人声对白（[^）]*）/g, '')
           .replace(/同期人声对白（[^）]*）/g, '')
           .replace(/^[+＋、，,\s]+/, '')
           .replace(/[+＋、，,\s]+$/, '');
    }
    return s;
  })();
  // 环境人声单独一层：街道、店内、邻居家本来就有人说话。用户可以不要"台词"，
  // 但真实场景里没有一点点人声反而假。只有显式勾了「连背景人声也不要」才全禁。
  const noAmbient = input.noAmbient === true;
  const ambientSrc = (() => { try { return FMT.ambientOf(format); } catch (e) { return ''; } })();
  if (allowVoice) {
    lines.push(`${soundBase}。人声要求：口语、短句、像随口说的，一镜不超过一句；不念参数、不念价格、不喊口号、不出现"最"字类绝对化用语。`);
    if (!noAmbient && ambientSrc) lines.push(`· 背景人声：${ambientSrc}——可以有人在小声说话、远处有人喊，真实、断断续续，但不抢主体。`);
  } else if (noAmbient) {
    lines.push(`${soundBase}。全片无人声：没有台词、没有口播、没有旁白，连背景人声也不要，只保留环境音与音效。`);
  } else {
    lines.push(`${soundBase}。全片没有清晰可懂的台词：无口播、无旁白、无对白台词。`);
    if (ambientSrc) lines.push(`· 背景人声要保留：${ambientSrc}——真实存在、断断续续、听不清具体内容，只当环境音用，不许变成能听懂的对话。`);
  }
  lines.push('');

  lines.push('【约束条件】');
  lines.push(`· 真实比例优先：${size}。商品在画面里的大小必须符合现实——与手同框时不超过手掌/小臂应有的比例，与人同框时不能比人的头、上半身还大；桌面、椅子、餐具等参照物尺寸正常。商品单独出镜时可以特写占满画面，但那只是镜头贴近，不代表实物被放大。`);
  lines.push('· 商品与 @图片1 严格一致：形态、比例、颜色、Logo、材质、包装文字、配件数量都不变，不换款、不换色、不增减图案。');
  if (keepClean) lines.push(`· 本体文字必须保留：「${keepClean}」逐字原样出现，不得改写、不得简写、不得模糊、不得被手或道具挡住。`);
  lines.push('· 人体结构正常：五指完整、不与商品穿插，面部稳定不变形，同一人物全片发型与服装不变，动作自然流畅、不僵硬。');
  if (usage) lines.push(`· 使用逻辑成立：${usage}。`);
  if (p.ban) lines.push(`· 本形态专属禁忌：${p.ban}。`);
  const fmtBan = noText ? format.ban : String(format.ban || '').replace(/画面内不出现任何可读文字|画面内无可读文字|不出现可读文字/g, '允许出现简洁字幕，但不得遮挡商品与人物动作');
  lines.push(`· 本条形态的禁忌：${fmtBan}。`);
  if (extra) lines.push(`· 额外硬性要求（优先级最高）：${extra}。`);
  lines.push('· 同一场景内的连续性：背景、道具数量、光源方向、色温保持稳定；快切只换机位，不改变空间关系，拆下的部件留在原位。');
  lines.push('· 画面无卡顿、无闪烁、无跳帧；商品不悬空、不变形、不出现第二个同款。');
  lines.push(noText
    ? '· 画面内不出现任何可读文字：无字幕、无标题、无卖点字、无价格、无水印、无贴纸（商品自带的 Logo 与包装印字除外；街景招牌、屏幕内容用景深虚化或角度避开）。'
    : '· 允许出现简洁字幕：只在需要强调的位置出现 1-2 行短句，字体干净、位置避开商品主体与人物面部；不出现价格、促销角标、平台水印。');
  lines.push('');
  lines.push(`【画质风格】${format.energy === 'slow' ? '电影级实拍质感，层次丰富，光影有方向感，色彩克制' : '真实拍摄质感，细节清晰，色彩通透，允许硬切、遮挡转场、轻微手持感'}；不加花哨特效、不加转场光效${noText ? '、不加任何字幕贴片' : '；字幕只做干净的短句，不做花字与贴片包装'}。`);

  if (sellsLines.length) {
    lines.push('');
    lines.push('【卖点的画面化写法（画面里不出现这些文字，只出现这些画面）】');
    for (const s of sellsLines.slice(0, 3)) lines.push(`· ${s}`);
  }

  return {
    full: lines.join('\n'),
    meta: {
      preset: p.cat, duration, ratio, name: p.name, beats: flow,
      variant: V.key, variantTag: V.tag,
      format: { key: format.key, name: format.name, tag: format.tag, voice: !!format.voice },
      product: { cat: p.catLabel, form: p.formLabel, core: p.core, confidence: p.confidence, worn: !!p.worn, steps }
    }
  };
}


/** 人看的分镜脚本（和提示词同一套动作逻辑，方便验收时对照） */
function buildScript(input = {}) {
  input = sanitizeInput(input);
  const V = pickVariant(input.variant);
  const duration = Number(input.duration) || 15;
  const ratio = input.ratio || '9:16';
  const { p, sceneFull, light, size, detail, hand, use, end, pose, steps, person, dress, trouble } = buildPlan(input, V);
  const goods = p.core || p.name;
  const format = FMT.pickFormat(input, input.variant);
  const cams = FMT.cameraOf(format);
  const selling = (input.sellingPoints || '').trim();
  const sellParts = selling ? selling.split(/[，,；;、\n]+/).map(s => s.trim()).filter(Boolean) : [];
  const sell1 = sellParts[0] || (p.sells && p.sells[0] && p.sells[0].v) || '';
  const sell2 = sellParts[1] || (p.sells && p.sells[1] && p.sells[1].v) || sell1;
  const sell3 = sellParts[2] || (p.sells && p.sells[2] && p.sells[2].v) || sell2;
  const sceneIn = (input.scene || '').trim();
  const ctx = {
    goods, name: p.name || goods, sell1, sell2, sell3,
    detail, hand, use, end, scene: sceneIn || sceneFull, light,
    cast: person ? `${person.age}，穿${dress}` : '真实日常穿着的主角',
    size, prop: p.prop || '',
    // 收尾细节按品类取（睡袋不能收在「滚轮指示灯」上）
    endbit: (() => { try { return FMT.endbitOf(p.cat); } catch (e) { return '光影移动'; } })(),
    ...trouble
  };
  // 脚本必须和提示词用同一套节拍：15s→8 镜、10s→6 镜、5s→4 镜
  const filledActs = (format.acts || []).map(t => FMT.fill(t, ctx));
  const flow = shapeFlow(duration, filledActs, cams, ['', '', '', '', '', '', '', '']);
  // 与提示词同一套开场钩子，验收时才对得上
  const hookS = (() => { try { return pickHook(p); } catch (e) { return { key: '' }; } })();
  if (hookS.key === 'form' && hookS.text) flow[0].act = hookS.text;

  const out = [];
  out.push(`【视频脚本】${p.name}`);
  out.push(`品类形态：${p.catLabel} · ${p.formLabel}　｜　${duration}s　｜　${ratio} 竖屏`);
  const noTextS = input.noText !== false;
  const noVoiceS = input.noVoice !== false;
  const voiceS = !!format.voice && !noVoiceS;
  out.push(`视频形态：${format.name}（${format.tag}）${voiceS ? ' · 有同期人声' : ' · 无台词'}`);
  out.push(`相机身份：${FMT.lookOf(format)}`);
  const ambS = input.noAmbient === true ? '无人声' : '保留听不清内容的背景人声';
  out.push(`字幕：${noTextS ? '不出现字幕/文字' : '允许简洁字幕'}　｜　台词：${voiceS ? '允许口语短句' : `无清晰台词（${ambS}）`}`);
  out.push(`为什么这样拍：${FMT.whyOf(format, ctx)}`);
  out.push(`真实尺寸：${size}`);
  if (steps.length) out.push(`动作逻辑：${steps.join(' → ')}`);
  if (sceneIn) out.push(`指定场景：${sceneIn}`);
  if (String(input.audience || '').trim()) out.push(`目标人群：${String(input.audience).trim()}`);
  if (selling) out.push(`卖点：${selling}`);
  if (String(input.logoText || '').trim()) out.push(`必须保留的本体文字：${String(input.logoText).trim()}`);
  if (String(input.extra || '').trim()) out.push(`补充要求：${String(input.extra).trim()}`);
  out.push('');
  out.push(`叙事线（${format.name}）：${flow.map(f => f.name).join(' → ')}`);
  out.push(`世界：${format.world}`);
  out.push('');
  for (let i = 0; i < flow.length; i++) {
    const b = flow[i];
    const cam = cams[b.camIdx] || cams[cams.length - 1];
    out.push(`S${i + 1}　${fmtRange(b.t0, b.t1)}　${cam.shot}｜${cam.move}`);
    out.push(`　　${b.name}：${b.act}`);
  }
  out.push('');
  out.push(`声音：${format.sound}`);
  out.push(`真实感：${(format.reality || []).join('；')}`);
  // 提示词里写了「设备感」，脚本这边也要对得上，验收时才不会一边手机随手拍、一边电影布光
  const gearS = CRAFT.gearOf(format);
  if (gearS) out.push(`设备感：${gearS}`);
  out.push(`禁忌：${format.ban}`);
  if (p.ban) out.push(`本形态专属禁忌：${p.ban}`);
  if (p.sells && p.sells.length) out.push('卖点画面化：' + p.sells.slice(0, 2).map(s => s.v).join('；'));
  return { text: out.join('\n'), meta: { product: p, format: { key: format.key, name: format.name } } };
}


/** 降级：8 条独立素材提示词（每条可单次生成） */
function buildClips(input = {}) {
  input = sanitizeInput(input);
  const V = pickVariant(input.variant);
  const ratio = input.ratio || '9:16';
  const { p, preset, sceneFull, light, size, detail, hand, use, end, person, dress, trouble } = buildPlan(input, V);
  const format = FMT.pickFormat(input, input.variant);
  const cams = FMT.cameraOf(format);
  const selling = (input.sellingPoints || '').trim();
  const sellParts = selling ? selling.split(/[，,；;、\n]+/).map(s => s.trim()).filter(Boolean) : [];
  const sell1 = sellParts[0] || (p.sells && p.sells[0] && p.sells[0].v) || '';
  const sell2 = sellParts[1] || (p.sells && p.sells[1] && p.sells[1].v) || sell1;
  const sell3 = sellParts[2] || (p.sells && p.sells[2] && p.sells[2].v) || sell2;
  const ctx = {
    goods: p.core || p.name, name: p.name, sell1, sell2, sell3,
    detail, hand, use, end, scene: (input.scene || '').trim() || sceneFull, light,
    cast: person ? `${person.age}，穿${dress}` : '真实日常穿着的主角',
    size, prop: p.prop || preset.prop || '',
    endbit: (() => { try { return FMT.endbitOf(p.cat); } catch (e) { return '光影移动'; } })(),
    ...trouble
  };
  const lock = `【一致性锁】商品必须与 @图片1 的形态、比例、颜色、Logo、材质、包装文字、配件数量 100% 严格一致，不得变形改款换色。`;
  const noTextC = input.noText !== false;
  const voiceC = !!format.voice && input.noVoice === false;
  const ban = `【禁令】禁止穿模穿帮、肢体畸变、道具闪烁；${noTextC ? '画面内不出现任何可读文字、字幕、水印；' : '允许简洁字幕，但不得遮挡商品与人物动作；'}${voiceC ? '人声只说口语短句，不念参数不喊口号。' : (input.noAmbient === true ? '无对白、无背景人声。' : '没有清晰可懂的台词；背景人声可有但听不清内容。')}`;
  return (format.acts || []).map((tpl, i) => {
    const cam = cams[i] || cams[cams.length - 1];
    const who = /人物|主角|宠物/.test(tpl) ? `人物/宠物按形态需要入画（${ctx.cast}），反应自然。` : '';
    return {
      id: 'C' + (i + 1),
      dur: i === 6 ? '3s' : '2s',
      text: [
        `形态：${format.name}（第 ${i + 1}/${format.acts.length} 段，与整条片子同世界观）。`,
        `商品：${p.name}（${p.catLabel} · ${p.formLabel}，@图片1 为一致性参考）。`,
        `场景：${ctx.scene}。光线：${light}。`,
        `构图：${ratio} 竖屏，${cam.shot}，${cam.move}。`,
        `动作：${FMT.fill(tpl, ctx).replace(/[。；;\s]+$/, '')}。${who}`,
        `真实尺寸：${size}。`,
        `相机身份：${FMT.lookOf(format)}。风格：${format.energy === 'slow' ? '电影级实拍，光影克制' : '真实拍摄，允许手持质感'}；${format.sound}。`,
        lock, ban
      ].join('\n')
    };
  });
}


/** 图片处理指令（一步到位版：去字 + 白底 + 高清） */
function buildImagePrompt(input = {}) {
  const keep = (input.logoText || '').trim();
  const lines = [
    '请直接编辑我发的这张产品图（图生图），输出一张新的图片，不要只给文字方案、不要重新画一件产品。',
    '',
    '【尺寸与构图 · 最重要，先满足这条】',
    '- 保持原图里产品的相对大小与位置，不要缩小产品、不要重新构图、不要在四周加大片留白；',
    '- 产品最大外形在画面中的占比要达到 78%-88%（方图按高度算），四边留白均匀，每边不超过画布的 10%；',
    '- 如果原图产品本身拍得偏小，可以适度放大补足到上述占比，但不得拉伸变形、不得裁掉产品的任何部位；',
    '- 产品水平居中、垂直略偏上，底部只保留极淡的自然接触阴影，不加硬投影。',
    '',
    '【必须保留】',
    keep
      ? `- 产品本体上的印刷字样与 Logo（${keep} 必须逐字保留，字体、大小、位置都不改）；`
      : '- 产品本体上的印刷字样、Logo、型号、刻度，一个字都不改；',
    '- 外形轮廓、长宽比例、颜色（含渐变与金属质感）、材质、透光与反光特性、配件数量；',
    '- 原有拍摄角度与透视关系，不要换成另一个角度。',
    '',
    '【必须去掉】',
    '- 画面上所有叠加信息：价格、促销语、贴纸、角标、平台水印、店铺水印、装饰边框；',
    '- 用产品周围真实的材质与光影自然填补，填补处纹理连续，不留涂抹痕迹、不留模糊块、不留重复图案。',
    '',
    '【输出规格】',
    '- 纯白背景 #FFFFFF（RGB 255,255,255），无渐变、无纹理、无道具、无场景、无多余元素；',
    '- 1:1 方形，长边不小于 2000 像素，边缘干净，无白边、灰边、锯齿；',
    '- 画面内除产品本体原有印刷信息外，不出现任何新增文字。'
  ];
  return lines.join('\n');
}

/**
 * 「AI 代写提示词」用的任务书。
 * 约束和本地模板完全一致（镜头数按片长 / 开头是钩子 / 别穿帮 / 卖点落到动作上 / 人群场景贴合），
 * 区别只是：分镜正文由豆包自己写，本地不预设动作链。
 */
function buildDoubaoBrief(input = {}) {
  input = sanitizeInput(input);
  const duration = Number(input.duration) || 15;
  const ratio = input.ratio || '9:16';
  const selling = (input.sellingPoints || '').trim();
  const audience = (input.audience || '').trim();
  const sceneIn = (input.scene || '').trim();
  const keepText = (input.logoText || '').replace(/[「」“”"']/g, '').trim();
  const extra = (input.extra || '').trim();
  const rerunFix = (input.rerunFix || '').trim();
  const noText = input.noText !== false;
  const noVoice = input.noVoice !== false;

  let plan = null;
  try { plan = buildPlan(input, pickVariant(input.variant)); } catch (e) { plan = null; }
  const p = (plan && plan.p) || {};
  const audFinal = audience || p.audience || '';
  const ranked = (() => { try { return FMT.rankFormats(input).slice(0, 3); } catch (e) { return FMT.FORMATS.slice(0, 3); } })();
  // 镜头数与本地模板严格一致：15s→8 镜、10s→6 镜、5s→4 镜。
  // 两边不一致的话，同一件商品「AI 代写」和「本地模板」出来的片子结构会完全不同。
  const shotCount = duration >= 12 ? 8 : (duration >= 8 ? 6 : 4);
  const shots = `${shotCount} 个`;
  const per = duration / shotCount;
  const perRangeB = `${(per * 0.85).toFixed(1)}-${(per * 1.1).toFixed(1)}`;
  const allNames = FMT.FORMATS.map(f => f.name).join(' / ');
  const imgCount = Number(input.imageCount) || 0;

  const lines = [];
  lines.push('你是资深短视频导演，也是 Seedance 视频提示词工程师。请为下面这件商品设计一条真正适合它的短视频，并写出可直接用于视频生成的提示词。');
  lines.push('只输出提示词正文，不要解释、不要问我问题；这一轮只写文字，不要生成视频、不要调用视频生成。');
  lines.push('');
  lines.push('【最重要的一条】不要写成"产品展示片"。观众刷到一条白底/桌面摆拍、逐个展示细节的片子，3 秒就划走了。你要先判断这件商品适合用什么「视频形态」，再按这个形态写分镜。');
  lines.push('');
  lines.push('【可用形态】' + allNames + '。');
  lines.push('形态说明（择一，也可自创更合适的，但必须在第一行写清楚）：');
  lines.push('· 街拍漫游：把商品放进真实城市生活，路人视角、自然光、随手拍；适合穿搭、配饰、通勤随身物。');
  lines.push('· 第一人称实拍：POV 视角，从拿起、使用到放回，全程"我正在用"；适合数码、家电、工具、车载。');
  lines.push('· 手持实测：在家随手架着手机讲真实体验，允许抖、允许生活痕迹；适合家居、清洁、美妆、健康。');
  lines.push('· 情景段子：先演一个小麻烦，再用商品解决，带反转或笑点；适合清洁、厨房、母婴、宠物。');
  lines.push('· 街头采访：话筒伸向路人，真实反应+试用+改口；适合美妆、食品、新奇小物。');
  lines.push('· 穿搭型录：上身之后走两步、转个身，版型和垂坠自己说话；适合服饰、鞋包、珠宝、眼镜。');
  lines.push('· 美食 ASMR：下锅、切开、倒出、入口，靠声音和质感成交；适合食品、饮品、厨具。');
  lines.push('· 硬核实测：落水、承重、摔打、连续工作，用一次看得见的极限测试证明品质；适合工具、户外、耐用类。');
  lines.push('· 前后对比：一半脏一半干净同框，不用讲原理；适合清洁、收纳、改造。');
  lines.push('· 居家漫游：镜头走过一个真实的家，商品自然出现在它该在的位置；适合家居、家电、香氛。');
  lines.push('· 电影感广告：当商品卖的是感觉而不是功能，用光影和留白；适合香水、珠宝、高端数码。');
  lines.push('· 萌宠主角：让宠物当主角，它的真实反应就是使用证明；适合宠物用品、家居、玩具。');
  lines.push('· 旅拍场景：海边、山野、公路，商品是旅伴；适合泳装、防晒、户外、运动。');
  lines.push('· 教程三步：三步演示完，购买阻力就没了；适合美妆、厨具、工具、数码。');
  const wantedFmt = input.formatKey && input.formatKey !== 'free'
    ? FMT.FORMATS.find(f => f.key === input.formatKey) : null;
  if (wantedFmt) lines.push(`【本次指定形态】${wantedFmt.name}——用户在界面上已经选定，不要换别的形态，但要把它的逻辑用到位（${wantedFmt.why || ''}）。`);
  if (input.formatKey === 'free') {
    const c = FMT.conceive(input, input.variant);
    lines.push('【本次构想方向 · 参考骨架，可以改得更好】用户要的是"按这件商品现编一段真实生活"，不是套模板。引擎已经构想了一版：');
    lines.push(`· 生活场景：${c.motif.name}——${c.motif.where}`);
    lines.push(`· 人物：${c.motif.who}`);
    lines.push(`· 要被解决的小状况：${c.trouble.name}——${c.trouble.setup}`);
    lines.push(`· 商品出场：${c.motif.use}`);
    lines.push(`· 收尾：${c.motif.close}`);
    lines.push('如果你能想到更贴这件商品、更让人愿意看完的生活场景（数码博主日常、办公室、通勤、带娃、朋友聚会……都能用），就按你的写；但必须是"真实生活里真会发生的一段"，不要退回产品展示片。');
  }
  lines.push('');
  lines.push('【参考素材】');
  if (imgCount > 0) {
    lines.push(imgCount > 1
      ? `我上传了 ${imgCount} 张图：@图片1 是商品一致性基准，@图片2 起是同一件商品的其他角度 / 细节。多图之间只有角度差别，不是多件商品。`
      : '我上传了 1 张图：@图片1 就是这件商品，形态、比例、颜色、Logo、材质、包装文字、配件数量全片以它为准。');
    lines.push('成片构图不必和参考图一样，但画面里拍到的必须真的是这件商品——不能换款、换色、改结构、加减配件。');
  } else {
    lines.push('（这次没有参考图）商品外观按上面的商品名与品类理解，全程保持同一件东西，不许中途换款换色。');
  }
  lines.push('');
  lines.push('【商品】');
  lines.push(`· 商品名：${p.name || input.name || '（未填）'}`);
  if (p.catLabel) lines.push(`· 品类：${p.catLabel}${p.formLabel ? ' · ' + p.formLabel : ''}（画面里必须一眼看出是这一件，不要按名字里的修饰词乱猜）`);
  else if (input.category) lines.push(`· 品类：${input.category}`);
  const purposeB = p.purpose || (() => { try { return FMT.purposeOf(input, p); } catch (e) { return ''; } })();
  if (purposeB) lines.push(`· 它是做什么的：${purposeB}（画面必须按这个用法出现，别按名字瞎猜）`);
  if (plan && plan.size) lines.push(`· 真实尺寸感：${plan.size}`);
  if (plan && plan.steps && plan.steps.length) lines.push(`· 真实使用顺序：${plan.steps.join(' → ')}`);
  lines.push('');
  lines.push('【需求表】');
  if (audFinal) lines.push(`· 目标人群：${audFinal}（人物的年龄、气质、穿着、所处环境都要贴合这群人）`);
  if (selling) lines.push(`· 必须让人看到的卖点：${selling}（每条都要落到动作、场景或材质上，不能靠字幕或口播硬说）`);
  if (sceneIn) lines.push(`· 指定场景：${sceneIn}（全片就在这个场景或其内外机位，不额外加无关地点）`);
  if (keepText) lines.push(`· 必须保留的本体文字：${keepText}（位置、大小、字体、颜色与参考图完全一致，一个字都不改）`);
  if (extra) lines.push(`· 补充要求：${extra}（硬性约束，优先级高于下面的默认风格）`);
  if (rerunFix) lines.push(`· 本次重抽修正要求：${rerunFix}（**最高优先级**，这是上一版没拍好需要改的地方，所有镜头设计都要先满足它${wantedFmt ? '' : '；同时换一种与前几版不同的形态'}）`);
  lines.push(`· 时长与画幅：${duration} 秒 / ${ratio} 竖屏 / 1080p`);
  lines.push(`· 字幕：${noText ? '不出现任何字幕与画面文字' : '允许简洁字幕（1-2 行短句，不遮挡商品与人物面部）'}`);
  const noAmbB = input.noAmbient === true;
  lines.push(`· 台词：${noVoice
    ? (noAmbB ? '全片无台词、无口播，连背景人声也不要，只保留环境音与音效'
              : '不要清晰可懂的台词、口播、旁白；但街道/店内/邻居这类场景要保留听不清内容的背景人声，别把环境做成真空')
    : '按形态决定：口播/街采/段子/教程类可以说口语短句，其他形态不写台词'}`);
  lines.push('');
  lines.push('【本地判断的三个候选形态】（按这件商品的品类与卖点自动打分，优先从这三个里选；如果你认为有更合适的，可以换，但要说明理由）');
  ranked.forEach((f, i) => lines.push(`${i + 1}. ${f.name} —— ${f.why}`));
  lines.push('');
  // 第三方技法注入 AI 代写任务书：只给技法与避坑，不规定开场与结构（见 lib/craft.js）
  for (const c of CRAFT.briefLines(input, ranked, !noVoice)) lines.push(c);
  lines.push('');
  lines.push('【硬性要求】');
  lines.push(`1. 第一行必须是「【形态】形态名 —— 一句话说明为什么这个形态最适合这件商品和这群人」。`);
  lines.push(`2. 镜头数：${shots}，按「镜头 1 … 镜头 N」逐条写，每条一句话，写清「画面主体 + 具体动作 + 机位/运镜 + 光线 + 声音」，不要写"高级感""电影感"这类形容词充数。`);
  lines.push('3. 必须有真实世界：真实场景、真实人物、真实环境音。不要白底、不要影棚、不要产品原地转圈、不要逐个展示配件。');
  lines.push('4. 开场 3 秒必须有钩子：冲突、反差、悬念、结果先行、利益点，任选其一，由形态决定；不要用"大家好今天给大家介绍"这种开头。');
  lines.push('5. 卖点只能靠画面表达：每条卖点都要落到一个具体动作或材质细节（例：「24 小时保温」→ 拧开杯盖冒热气；「防滑」→ 手推杯身纹丝不动），不许用字幕、贴片代替。有几条卖点就安排几个镜头，并在该镜里写清它证明了哪一条。');
  lines.push(`6. 节奏跟着形态走：每镜 ${perRangeB} 秒、硬切为主；真实手持形态允许一次停顿和一次失焦；电影感形态可以慢，但必须每一镜都有信息。`);
  lines.push(noVoice
    ? '7. 全片不写台词、不写口播、不写人声，只写环境音与音效（用户已勾选"不出现台词"）。'
    : '7. 允许有台词：街采、段子、手持实测、教程这几类写 1-4 句口语短句（像真人随口说的，不念参数、不喊口号、不用"最"字）；其他形态写环境音与音效，不写人声。');
  lines.push('8. 严禁穿帮穿模：商品的结构、比例、颜色、logo、包装文字、配件数量必须与参考图一致；不许多出手指、不许出现第二件产品、不许道具或肢体穿透商品、握持方式要符合真实用法。');
  lines.push(noText
    ? '9. 画面里不出现任何可读文字（无字幕、无标题、无价格、无水印）；街景招牌、屏幕内容用景深或角度避开。'
    : '9. 允许简洁字幕：1-2 行短句，位置避开商品主体与人物面部；不出现价格、促销角标与水印。');
  lines.push('10. 收尾：最后一镜落在商品或使用结果上，画面稳定，不淡出到黑场；收尾方式由这条片子的内容决定，不必与开场呼应。');
  lines.push('11. 商品或它的使用结果必须在前 3 秒内出现（可以是局部）；中段不要靠空镜拖延。');
  lines.push('12. 分镜纪律：每镜只承担一个主动作；相邻两镜至少在景别/机位/人物关系里变一项；一个动作链只在一镜里完整发生，前后镜不得提前出现完成态。');
  lines.push('13. 禁四类拍不出来的写法：两个主体精确配合的交互、心理描写（"犹豫/意识到"）、否定式动作（"没接住"）、一镜内三步以上的手部动作链；遇到就换成实际发生的画面或拆成两镜。');
  lines.push('14. 最后两镜里给一次自然的行动引导动作（手指向画面下方或把商品递向镜头），不要写"点击下方"这类字样。');
  lines.push('');
  lines.push('【真实感清单】（这条片子像不像真的，主要看这些，逐条自检）');
  lines.push('· 光不完美：窗边亮、角落暗、逆光时主体边缘过曝一点，都正常；不要每一镜都打得均匀漂亮。');
  lines.push('· 场景有生活痕迹：允许与商品无关的杂物、植物、路过的影子，但不能遮挡主体。');
  lines.push('· 人有反应过程：先愣一下、再确认、再动手，不写"他很满意""她很惊讶"这种终态。');
  lines.push('· 动作有重量：拿起来有惯性、放下有反馈、液体有流动、布料有褶皱；不许漂浮。');
  lines.push('');
  lines.push('【一句话总要求】把它当成一条要投流的真人短视频来拍：有场景、有人、有事发生，看完记住这件东西解决了什么问题。除了上面列的底线，镜头设计、开场方式、人物出镜时机、结构安排都由你灵活决定。');
  lines.push('');
  lines.push('【输出格式】');
  lines.push('第 1 行：【形态】形态名 —— 为什么适合；');
  lines.push('第 2 行：【固定参数】时长 / 比例 / 画幅 / 画风；');
  lines.push('之后写【分镜】，逐条列出镜头 1..N，每条一行，写清 画面 + 动作 + 机位 + 光线 + 声音；');
  lines.push('最后写【声音】【一致性锁】【约束条件】各一段（一致性锁一句话：商品与 @图片1 的形态、比例、颜色、Logo、材质、包装文字、配件数量严格一致）。');
  lines.push('全文纯文本，不要用 markdown 代码块，不要加任何解释性开场白，不要给多套方案让我选。');
  return lines.join('\n');
}


/**
 * 清洗豆包写回来的提示词：去代码围栏、去开场客套、去「以下是提示词：」这类前缀。
 */
function cleanDoubaoPrompt(raw) {
  let t = String(raw || '').replace(/\r/g, '').trim();

  // 豆包很爱把正文包在 ``` 里，还常在围栏前加一句「好的，这是提示词：」——
  // 有围栏就只取围栏内的内容，否则再按首尾围栏剥。
  const fence = t.match(/```[a-zA-Z]*[ \t]*\n([\s\S]*?)\n?```/);
  if (fence && fence[1] && fence[1].trim().length > 80) t = fence[1].trim();
  else t = t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();

  // 去掉开场客套与「以下是/这是…提示词：」前缀（可能连着两三层）
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/^(好的|好|OK|ok|当然|没问题|收到)[，,。！!、：:\s]*/, '');
    t = t.replace(/^(以下是|下面是|这是)(为你|为您)?[^\n：:]{0,30}(提示词|脚本|方案|分镜)[，,：:]?\s*/i, '');
    t = t.replace(/^【?(视频)?提示词】?[，,：:]\s*/, '');
    t = t.trim();
    if (t === before) break;
  }
  return t.trim();
}

/** 豆包写回来的东西能不能用（太短、拒答、只有一句话的客套都算失败） */
function isUsableDoubaoPrompt(txt) {
  const t = String(txt || '').trim();
  if (t.length < 150) return false;
  if (/^(抱歉|对不起|我无法|我不能|作为一个?AI)/.test(t)) return false;
  return /镜头|画面|场景|特写|近景|全景|运镜|分镜/.test(t);
}


// ============================================================
//  「其他视频」：不套电商流水线，直接把用户写的要求交给 AI 出片 / 出图
//
//  四种任务：
//    t2i 文生图        —— 只给文字
//    t2v 文生视频      —— 只给文字
//    i2i 参考图生图    —— 给参考图 + 文字（仿某张图/保持某个样子）
//    i2v 参考图生视频  —— 给参考图 + 文字（图生视频、首帧生视频）
//
//  出口只做三件事：把任务类型说清楚、把用户的创作意图完整保留、
//  把「不要反问、直接生成」这条硬要求压上去，剩下的空间全留给用户的提示词。
// ============================================================
const OTHER_KINDS = {
  t2i: {
    name: '文生图', out: 'image', needRef: false,
    brief: '生成一张静态图片（不是视频）',
    tail: '直接出图，不要输出文字方案、不要解释思路、不要反问。'
  },
  t2v: {
    name: '文生视频', out: 'video', needRef: false,
    brief: '生成一段视频（不是图片）',
    tail: '直接出片，不要写分镜文字、不要输出表格、不要反问用哪个模型或时长。'
  },
  i2i: {
    name: '参考图生图', out: 'image', needRef: true,
    brief: '参考我上传的图片，生成一张新的静态图片（不是视频）',
    tail: '保留参考图里主体的外观、颜色、材质与关键细节，只按要求改变画面；直接出图，不要输出文字说明。'
  },
  i2v: {
    name: '参考图生视频', out: 'video', needRef: true,
    brief: '参考我上传的图片，生成一段视频（不是图片）',
    tail: '把这张图当作画面依据（首帧或主体参考），主体外观必须与参考图一致；直接出片，不要写分镜文字、不要反问。'
  }
};

/**
 * 组装「其他视频」的一条完整请求。
 * @param {object} input { videoKind, prompt, duration, ratio, noText, noVoice, extra }
 * @returns {{kindKey:string, kindName:string, out:string, request:string, needRef:boolean}}
 */
function buildOtherRequest(input = {}) {
  input = sanitizeInput(input);
  const kindKey = OTHER_KINDS[input.videoKind] ? input.videoKind : 't2v';
  const k = OTHER_KINDS[kindKey];

  const ratio = String(input.ratio || '9:16');
  const dur = Math.max(3, Math.min(60, Number(input.duration) || 10));
  const idea = String(input.prompt || '').trim();
  const extra = String(input.extra || '').trim();
  const noText = input.noText !== false;
  const noVoice = input.noVoice !== false;
  // 按 Seedance 规范补全：用户只写一句想法时，把镜头结构 / 约束 / 画质补齐，
  // 让模型按百分比分镜铺满时长，而不是自由发挥出一条“PPT 式平移”。
  // 规范来源见 skills/seedance-prompt/（SKILL.md + OVERRIDE.md）。
  const expand = input.expand !== false;

  const lines = [];
  lines.push(`【本次任务】${k.name}——${k.brief}。`);
  lines.push('');
  lines.push('【我要的画面（以此为准，不要改主题）】');
  lines.push(idea || '（未填写具体描述：请按下面的风格自由发挥一条完整作品）');
  if (extra) {
    lines.push('');
    lines.push('【补充要求】');
    lines.push(extra);
  }
  lines.push('');
  lines.push('【规格】');
  lines.push(`· 画幅：${ratio === '16:9' ? '横屏 16:9' : ratio === '1:1' ? '方形 1:1' : '竖屏 9:16'}`);
  if (k.needRef) {
    lines.push(k.out === 'video'
      ? '· 参考图：@图片1 就是这条片子的画面依据（当首帧用），主体外观、颜色、材质、场景关系以它为准'
      : '· 参考图：@图片1 就是参考依据，主体外观、颜色、材质、相对位置以它为准；改的只是我上面要求的那些');
  }
  lines.push(k.out === 'video'
    ? `· 时长：约 ${dur} 秒；用你当前可用的档位，不要为空档位停下来问我`
    : '· 尺寸：用你当前可用的最高清档位');
  if (k.out === 'video') {
    lines.push(noText
      ? '· 画面内不放字幕、不放可读文字、不放水印'
      : '· 允许极少量字幕，但不要遮挡主体');
    lines.push(noVoice
      ? '· 不要口播、不要旁白；保留真实环境音即可'
      : '· 可以有人声，但自然、短句，不念广告词');
  }
  lines.push('');
  if (expand) {
    if (k.out === 'video') {
      lines.push('【镜头结构】（8 拍，按百分比铺满全片，正文不要写死秒数）');
      lines.push('0%-11%（建立空间）：先给一个能站住脚的画面 —— 景别、光线、空间关系一眼看明白');
      lines.push('11%-21%（主体入场）：主体出现或动作开始，观众知道这条片子跟着谁走');
      lines.push('21%-35%（第一个细节）：最想让人看见的那处质感、纹理或局部，靠近拍');
      lines.push('35%-48%（动作推进一）：一次真实的位移或操作，动作在这拍里做完');
      lines.push('48%-63%（动作推进二）：环境或情绪往前走一步，画面不重复上一拍');
      lines.push('63%-76%（转折）：视角、景别或场景换一次，给观众一个新的看点');
      lines.push('76%-91%（结果落定）：动作的结果清楚可见，不用旁白解释');
      lines.push('91%-100%（定格收尾）：画面稳 0.8 秒，主体清晰、构图完整');
      lines.push('硬要求：每拍只做一件事；相邻两拍至少换一项（景别 / 机位 / 场景 / 动作）；任何一拍都不许是静止摆拍。');
      lines.push('');
      lines.push('【约束条件】');
      lines.push('· 主体外观全片一致：颜色、材质、比例、配件数量不跳变，不穿模、不多肢、手指五指正常');
      lines.push('· 运动连续：不跳帧、不突然加速、不变形；镜头运动只有一种主方向（推 / 拉 / 摇 / 跟，选一个）');
      lines.push(noText ? '· 画面里不出现任何可读文字：招牌、包装、屏幕、水印、字幕全部避开或用景深虚化' : '· 文字只允许极少量，且不遮挡主体');
      lines.push(noVoice ? '· 不出现口播、旁白、对白；保留真实环境音' : '· 人声自然、短句，不像广告口播');
      lines.push('· 真实物理：有重量、有惯性、落地有反馈；不做漂浮、不做塑料感 3D');
      lines.push('');
      lines.push('【画质风格】真实摄影质感，自然光为主，浅景深，轻微颗粒；不过度磨皮、不锐化过度');
    } else {
      lines.push('【构图】主体在画面里的位置与占比先定下来，视线/朝向留出空间；前景、中景、背景各放什么写清楚；边缘不切断主体关节');
      lines.push('');
      lines.push('【光线与材质】写清光源方向与色温（窗光 / 顶光 / 逆光）、高光落在哪、阴影有多硬；材质怎么反光、有没有纹理与颗粒');
      lines.push('');
      lines.push('【画面禁令】');
      lines.push('· 不出现任何可读文字、水印、logo、边框');
      lines.push('· 人体结构正常：手指五指、关节自然、不穿模、不多肢');
      lines.push('· 主体外观与描述一致：颜色、材质、比例不跑偏');
      lines.push('');
      lines.push('【画质风格】高分辨率、真实摄影质感，细节清晰；不过度磨皮、不做塑料感 3D');
    }
    lines.push('');
  }
  lines.push('【执行纪律】');
  lines.push(`· ${k.tail}`);
  lines.push('· 只输出最终成品，不要输出分镜表格、不要给多套方案让我选。');
  lines.push('· 不要问我任何问题（模型、时长、比例都已定好）。');

  return { kindKey, kindName: k.name, out: k.out, needRef: k.needRef, request: lines.join('\n') };
}

module.exports = {
  buildPrompt, buildScript, buildClips, buildImagePrompt,
  buildDoubaoBrief, cleanDoubaoPrompt, isUsableDoubaoPrompt,
  pickPreset, pickVariant, PRESETS, BEATS, CLIPS, VARIANTS, SIZES,
  FORMATS: FMT.FORMATS, rankFormats: FMT.rankFormats, pickFormat: FMT.pickFormat,
  buildOtherRequest, OTHER_KINDS
};
