# 第三方 Seedance 技法（提炼自公开仓库）

> 本文件记录"融合了什么、从哪里来、怎么用"，不是运行时读取的文档。
> 运行时代码在 `lib/craft.js`；原文留档在 `_refs/`（不参与打包运行）。

## 来源与许可

| 来源 | 许可 | 原文留档 |
|---|---|---|
| `LearnPrompt/awesome-seedance` | 模板策展 **CC BY 4.0**，仓库代码 MIT，prompt 与媒体归原作者 | `_refs/learnprompt-templates/`（8 份模板） |
| `dexhunter/seedance2-skill` | **MIT** | `_refs/dexhunter/SKILL-zh.md` |

融合方式：只提炼可执行的规则与词汇，不复制整段提示词原文；所有条目按需注入，见 `lib/craft.js`。

## LearnPrompt 模板 → 本项目落地

| 模板 | 提炼出的规则 | 注入位置 |
|---|---|---|
| `character-reference-lock` | 参考图分三类写：必须继承（形态/比例/颜色/Logo/材质/包装文字/配件数）、不得继承（背景/摆位/光线/角度/构图/其它文字）、跨镜保持（转身/遮挡/快动后仍是同一件） | `buildPrompt`【参考素材】；`buildDoubaoBrief` 补充段 |
| `handheld-ugc-vlog` | 用"相机缺陷"换真实感：手持抖动、对焦呼吸、曝光浮动、构图漂移；点名设备年代；明确关掉防抖与磨皮；不要手持真实感 + 4K 电影布光混用 | `craft.js` CAMERA_FLAWS / GEAR_ERA / pitfallsFor |
| `pov-continuous-take` | 第一人称：声明机位高度、只随身体动、摄像机不入画、左右手分工；开场第一帧已在动作中；硬切点与一镜到底段显式声明 | `FORMAT_CRAFT.pov` |
| `ugc-creator-review` | 人与商品各锁一条；台词焊在对应那一拍；每拍最多一句、八词以内（仅在允许台词时） | `FORMAT_CRAFT.ugc` |
| `product-commercial-shotlist` | 广告感靠光线立住；微距点名具体材质；结尾 hero frame；风格词集中放最后；不混用 UGC 纹理 | `FORMAT_CRAFT.cinematic` |
| `fashion-lookbook` | 服装逐件点名且逐场一致；每场一个景别/地点/动作；慢动作只留高潮镜头 | `FORMAT_CRAFT.ootd` |
| `food-asmr` | 每拍一个食物可见变化 + 对应的一个声音，声音按动作顺序；每拍一件餐具；食物与餐具全片一致 | `FORMAT_CRAFT.food` |
| `process-transformation-montage` | 先写不变量（机位/布局/尺寸），再按空间顺序写变化；结尾留一个还在动的小细节 | `FORMAT_CRAFT.beforeafter` / `tutorial` |

## dexhunter skill → 本项目落地

| 原文内容 | 提炼出的规则 | 注入位置 |
|---|---|---|
| @引用语法 | 每个引用说清用途；本项目只传商品图，故强化为"继承/不继承/跨镜"三段锁 | 【参考素材】 |
| 运镜语言 | 高级运镜术语表（推拉/摇/跟拍/环绕/低角度仰拍/俯拍/一镜到底/快速摇镜/希区柯克变焦/机械臂跟随）作为词表提示，不强制每条都用 | 【真实感清单】/ 任务书 |
| 景别词汇 | 极致特写/面部特写/中近景/中景/全景/建立镜头 | 同上 |
| 避坑清单 | 手持真实感 ≠ 电影布光；数码变焦不当转场；长台词伤口型；美食中途不变菜 | `pitfallsFor()` |

## 设计约束

- 这些是**技法建议**，不覆盖 OVERRIDE.md §1–§9 的硬规则（形态优先、镜头数跟片长走、分镜纪律、真实比例、使用逻辑）。
- **不写死分镜**：任务书只给技法与避坑，开场方式、人物时机、结构安排仍由 AI 灵活决定。
- **台词类技法受 `noVoice` 控制**：本地模板里那半句「每拍最多一句脱口的话」、任务书里那句「台词焊在对应那一拍上」，
  都只在允许人声时才出现；默认不出台词时改为「情绪靠动作和反应演出来」，避免与声音方案打架。
- **注入点三处 + 脚本对齐**：`buildPrompt()`【参考素材】/【真实感清单】、`buildDoubaoBrief()` 技法补充段；
  `buildScript()` 补一行「设备感」，保证人工验收时脚本与提示词描述的是同一套拍法。
- **改了形态名要跟技法表**：`FORMAT_CRAFT` / `GEAR_ERA` 按形态 `key` 索引，改名后会变成死键——
  代码不报错、规则静默失效。`node _t/check-prompt.js` 第 7 段专门挡这个。
