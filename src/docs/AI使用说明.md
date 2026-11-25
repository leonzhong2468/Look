# AI 使用说明 · 交付给 AI 的项目说明书

> **这份文档是写给 AI 看的，不是写给人看的。**
> 用户遇到问题时，会把这份文档 + 一张截图发给你。你读完这一份，就应该能定位问题、改代码、告诉他怎么验证。

---

## 0. 你（AI）现在要做的事

用户可能只发给你一句话，比如「打不开了」「卡在生成视频一直不动」「白底图出来是黑的」。
请按这个顺序做：

1. **先判断是不是环境问题**（90% 的「打不开 / 白屏 / 闪退」是环境问题，不是代码问题）
   → 让用户跑程序目录里的 `环境检测与修复.bat`，把窗口里的输出发给你。
2. **再要日志**：程序目录下 `app-run.log` 的最后 30 行。
3. **再看截图**，确认卡在哪一步（步骤条是高亮在第几步）。
4. 只有确认是代码问题，才动代码。改完必须告诉用户「关掉程序 → 重新打开」。
5. 不要一上来就重写整个文件。**改最小的一块，让用户重启验证。**

---

## 1. 项目身份

| 项 | 值 |
|---|---|
| 软件名 | Look |
| 版本 | 1.0.0 |
| 作者 | Leon |
| 形态 | Electron 43 桌面程序，**免安装绿色版**（解压即用，不写注册表） |
| 授权 | MIT，源码完全公开、可改、可二次分发 |
| 生成模型 | 豆包 **Seedance**（走用户自己的豆包账号，不调用任何第三方厂商 API） |
| 联网 | 只有程序自己在做网页操作；**没有中转服务器，没有数据上报** |

**这个软件不是「AI 套壳」**：它是一个本地浏览器多开 + 网页自动化工具。
所有图片 / 视频都是用户自己的豆包账号在豆包网页上生成的，程序只负责：多账号并行、自动打字、自动点按、自动把成品收回来。

---

## 2. 目录结构（交付包里你能改的东西）

```
Look/
├─ Look.exe      ← 主程序（Electron 壳）
├─ 启动（备用）.bat                    ← 双击启动的兜底方式
├─ 环境检测与修复.bat                  ← 环境体检 + 一键修复
├─ app-run.log                        ← 运行日志（出问题先看这个）
├─ userdata/                          ← 账号、配置、登录态（**别删，删了要重新扫码**）
├─ files/<任务id>/                    ← 任务工作目录：白底图、提示词/脚本 txt、成品 mp4、失败截图
├─ downloads/<账号id>/                ← 平台导出的原始文件（成品会转存到 files/）
├─ 文档/                              ← 你正在读的这份 + 使用说明 + 接手说明 + 免责声明
├─ tools/                             ← 环境检测脚本本体
└─ resources/app/                     ← ★ 全部源码，明文，可改
   ├─ main.js              主进程：窗口、WebContentsView 视图池、账号、托盘、登录监控、保活、全部 IPC 注册
   ├─ preload.js           contextBridge 暴露的 window.api（渲染层唯一入口）
   ├─ index.html           渲染层骨架（左 rail + 列表面板 + 主舞台三栏）
   ├─ style.css            设计 token（明/暗两套）+ 全部样式
   ├─ renderer.js          视图路由、面板渲染、舞台渲染、弹层、toast、主题
   ├─ task-ui.js           新建任务弹层 + 任务详情（步骤条、参数、提示词、产出区）
   ├─ app.ico / app-icon.png  程序图标（自绘，无任何厂商元素）
   ├─ docs/                文档源文件
   ├─ skills/seedance-prompt/  Seedance 提示词写作方法（人/AI 都能读的参考资料）
   │  ├─ SKILL.md                          字节跳动官方 skill（v2.0.0，Apache-2.0）
   │  ├─ OVERRIDE.md                       本项目自己的标准，冲突时以它为准
   │  ├─ references/prompt-writing-principles.md  官方原则：结构顺序/分镜时序/运镜/约束词
   │  ├─ references/third-party-craft.md   第三方技法融合记录（来源 / 许可 / 署名 / 注入点）
   │  └─ references/video-formats.md       形态库（**由代码生成**，改代码后重跑脚本）
   ├─ _refs/                  第三方仓库原文留档（不参与运行，只在改技法时查证）
   ├─ _t/                     开发期自检脚本（不参与运行，需要 Node.js）
   │  ├─ cover.js                 69 个全类目样本回归：不许有商品掉进「通用商品」
   │  ├─ check-prompt.js          252 组抽样 + 30 组全形态矩阵 + 极端输入，0 错误才算改完
   │  └─ gen-formats-doc.js       把 lib/formats.js 渲染成 video-formats.md
   └─ lib/
      ├─ ext.js            ★ 任务流水线的 IPC 装配层：tasks:create/start/cancel/approve/…、自检、文档打开
      ├─ pipeline.js       ★ 任务执行引擎：电商 runTask() / 其他视频 runOtherTask()
      ├─ driver.js         豆包深度适配驱动（找输入框、传图、点发送、等出片、下载）
      ├─ page-agent.js     注入豆包页面的探针（window.__DB）：元素查找 / 可见性判定 / 取最后一条回复原文
      ├─ generic-agent.js  通用平台驱动（非豆包平台用，方法名与 driver.js 完全一致）
      ├─ gen-agent.js      注入任意 AI 网页的通用探针（window.__GEN）：输入框 / 发送 / 上传 / 结果
      ├─ prompt.js         ★ 提示词引擎：Seedance 三层骨架 + 14 形态带货脚本 + 「其他视频」请求组装
      ├─ craft.js          第三方技法（参考图身份锁 / 相机缺陷词 / 设备年代词 / 运镜景别词表 / 各形态技法与避坑），按需注入
      ├─ product.js        商品理解（按品类给场景/光线/动作链）
      ├─ product-forms.js  14 种商品形态的真实动作链
      ├─ formats.js        ★ 形态引擎：14 种视频形态打分、18 个生活母题、54 条真实麻烦、品类兜底（CAT_HINTS / CAT_OVERRIDES / REFINE）
      ├─ fit.js            白底主图归一化（裁主体 → 补纯白画布，纯 nativeImage 实现）
      ├─ providers.js      ★ AI 平台注册表（内置豆包 + 用户自加平台）
      └─ store.js          tasks.json 持久化（重启后把「运行中」标成中断）
```

**关键：源码没有加密、没有 asar 打包，改 `resources/app/` 下的文件，关掉程序重开就生效。**

---

## 3. 架构（读完这一段你就懂它的骨架）

### 3.1 单窗口 + 视图池

不是「开一堆窗口」，而是**一个主窗口 + N 个 `WebContentsView`**：

- 每个账号对应一个 `WebContentsView`，每个 view 挂在自己的 `persist:<账号id>` session 分区里 → **登录态互相隔离，天然多开**。
- 切账号 = 把 view 从主窗口 `removeChildView` / `addChildView`，**毫秒级，页面状态不丢**（不重新加载）。
- 任务执行时，把 view 从主窗口挪到**离屏的后台窗口**（`ensureWorkerWin()`），主窗口继续给你看界面，互不抢焦点。
- 用户点「看页面」= `takeoverView()`，把正在跑的 view 借到主窗口看；看完 `releaseView()` 还回去。

```
mainWindow
 ├─ 渲染层（界面本身）
 └─ contentView
     └─ WebContentsView(账号A)  ← 由 viewPool 管理，可移交给 workerWin
workerWin（离屏窗口，屏幕外，visible 但不可见）
 └─ contentView
     └─ WebContentsView(账号B)  ← 跑任务时在这里
```

### 3.2 平台注册表（「多开管理器」能管别的 AI 的原因）

`lib/providers.js` 维护一份平台表，存在 `userdata/providers.json`：

- `kind: 'doubao'` → 用 `lib/driver.js`（深度适配：认得豆包的图像/视频面板、下载按钮）
- `kind: 'generic'` → 用 `lib/generic-agent.js` + `gen-agent.js`（通用适配：只靠「输入框/发送/上传/结果」四件事）

用户可以在界面「AI 平台」页里自己加 WorkBuddy、DeepSeek、通义、Kimi……只要填**名字 + 对话页地址**。
判断登录态用 `cookieDomains`，不写死 `.doubao.com`。

**所以「埋线」的含义是：这个壳可以变成任意 AI 的多开管理器，改的是数据（providers.json），不是代码。**

### 3.3 两种任务模式

`params.mode` 决定走哪条流水线：

| mode | 场景 | 入口函数 | 步骤条 |
|---|---|---|---|
| `ecom`（默认） | 电商产品图 → 白底主图 → 提示词 → 分镜带货片（4/6/8 镜按片长）→ 回收 → 人工验收 | `pipeline.runTask()` | ① 白底主图 ② 提示词 ③ 视频生成 ④ 验收 |
| `other` | 文生图 / 文生视频 / 参考图生图 / 参考图生视频 | `pipeline.runOtherTask()` | ① 打开对话 ② 参考图 ③ 发请求 ④ 生成 ⑤ 回收 |

### 3.4 两种模式的数据流

**电商（ecom）**

```
产品图(jpg/png)
  → 上传到豆包，要求「纯白底主图，商品不变形」
  → 收回主图，lib/fit.js 归一化（裁主体 + 补纯白，防豆包留白过多）
  → lib/prompt.js 按品类/形态/片长生成 4/6/8 镜分镜提示词（含主线、一致性锁、约束、规格）
  → 把提示词发给豆包，等视频生成
  → 回收 mp4 到 files/<任务id>/
  → 状态置 review（待验收），用户人工看完点「通过」→ done
```

**其他视频（other）**

```
prompt（+ 参考图，i2i/i2v 必需）
  → 新开一个对话
  → 校验登录态（掉线直接报错，不硬跑）
  → 上传参考图（如需要）
  → lib/prompt.js buildOtherRequest() 组装请求：本次任务 / 我要的画面 / 补充要求 / 规格 /
     镜头结构（8 拍百分比）+ 约束条件 + 画质风格 / 执行纪律。
     后三段受 params.expand 控制（界面「按 Seedance 规范补全镜头结构」，默认开）：
     开 = 补齐结构让模型按百分比分镜出片；关 = 原样发用户那句话（极简请求）。
  → 自动确认豆包的「确认生成」弹窗
  → 等结果（图片 png 或视频 mp4）；只回文字不产出 → 催一次
  → 下载回收 → outputs[] → done
```

### 3.5 三个「不要出现」的勾选项

`noText` / `noVoice` / `noAmbient` 三个开关会写进提示词的「约束」段：

- `noText`：画面里不出现任何字幕、文字、水印
- `noVoice`：不出现台词 / 口播（人物可以动，但不说话）
- `noAmbient`：连背景人声也不要（只留环境音/音乐）

默认三个都勾上（豆包默认爱加字幕和口播，不勾就会被塞进去）。

---

## 4. 数据与文件位置

| 文件 | 内容 | 能删吗 |
|---|---|---|
| `userdata/accounts.json` | 账号列表（id / 名称 / 所属平台 / 颜色） | 删了要重新加账号 |
| `userdata/providers.json` | 用户自加的 AI 平台 | 删了自加平台消失（豆包是内置的，删不掉） |
| `userdata/prefs.json` | 窗口位置、关窗是否最小化托盘等 | 可以删，会重建 |
| `userdata/config.json` | 页面锚点覆盖（自检后可能需要） | 可以删 |
| `userdata/tasks.json` | 任务队列与历史 | 删了历史任务消失 |
| `userdata/Partitions/<账号id>/` | 该账号的浏览器分区（**登录态在这里**） | 删了等于退出登录 |
| `files/<任务id>/` | 任务工作目录：白底图、提示词/脚本、成品（点「打开文件夹」就是这里） | 该任务的产物全丢 |
| `downloads/<账号id>/` | 平台导出的原始文件 | 可以删 |
| `app-run.log` | 日志 | 可以删，会自动重建 |

---

## 5. IPC 接口清单（渲染层 → 主进程）

全部通过 `preload.js` 的 `window.api.*` 暴露，`contextIsolation: true`，渲染层没有 Node 权限。

```
账号    accountsList / accountsAdd(providerId) / accountsRename / accountsDelete / accountsSelect
        accountsDetectName
平台    providersList / providerAdd / providerUpdate / providerRemove
任务    tasksList / taskCreate(payload) / taskStart(id) / taskCancel(id) / taskRerunVideo(id,fix)
        taskApprove(id) / taskDelete(id) / taskOpenFolder(id) / taskReveal(path) / taskShowPage(id)
        taskReadPrompt(id)
偏好    prefsGet / prefsSet(patch)
文件    pickImages / openDownloads / getFilePath(file) / toFileUrl(path)
自检    diagRun / diagOpenFolder / toolsDoctor
文档    docsOpen(name) / docsReveal
其他    setMode / getMode / appInfo / openConfig
推送    onTaskUpdate / onTaskRemoved / onTaskToast / onAccountReady / onAccountLogout
        onBadgeUpdate / onActiveChanged / onDownloadDone / onViewLocked / onUiMode
```

`tasks:create` 的 payload：

```js
{
  mode: 'ecom' | 'other',
  images: ['D:/a.jpg', ...],      // ecom 必填；other 做 i2i/i2v 时必填
  name: '任务名',                  // 可空，other 模式会自动从 prompt 截取
  // ecom 专用
  formatKey, platform, count,
  // other 专用
  videoKind: 't2i'|'t2v'|'i2i'|'i2v',
  prompt: '画面描述',
  ratio: '9:16', duration: 10,
  noText: true, noVoice: true, noAmbient: true,
  extra: '补充要求'
}
```

---

## 6. 故障定位表（按现象查）

| 现象 | 最可能的原因 | 怎么修 |
|---|---|---|
| 双击 exe 什么都没发生 / 一闪就没 | ① exe 被杀软隔离了某个 dll ② `icudtl.dat` 缺失 ③ 环境变量 `ELECTRON_RUN_AS_NODE=1` 被注入（此时程序当 node 跑，不建窗口） | 跑 `环境检测与修复.bat`；确认根目录有 `icudtl.dat`、`resources.pak`、`*.dll`；在干净环境（去掉 ELECTRON_RUN_AS_NODE）启动 |
| 窗口打开但白屏 | ① `resources/app/index.html` / `style.css` 丢了 ② 上次强杀后 `userdata\GPUCache` 写坏（Chromium 日志会打 `Invalid file version or magic`），渲染进程一起来就崩 | 先看 `_electron.log`（用 `ELECTRON_ENABLE_LOGGING=1` 启动才有）；缓存坏了重开一次会自动清（`bootCacheGuard()`）；仍不行点弹窗「重置档案并重启」（`recoverProfile()`，会把坏档案改名留档）|
| 进程在跑、没有窗口、app-run.log 停在「流水线扩展已装配」 | `app.setPath('userData')` 之后卡在缓存清理，或主进程崩在删缓存上 | 删缓存必须在**建窗口之前**（`main.js` 顶部 `bootCacheGuard()`），别在 `whenReady` 里删 —— 会连 `app ready` 都打不出来 |
| 卡在「① 白底主图」不动 | 账号掉线 / 豆包改了图片入口锚点 / 图片太大 | 先跑「设置 → 开始自检」，它会逐项验证登录态、输入框、图像入口、视频入口 |
| 卡在「③ 视频生成」不动 | 豆包在等「确认生成」弹窗（额度/时长确认）；或队列排队中 | 点「看页面」看真实页面在等什么；`pipeline.autoConfirm()` 负责点确认，锚点变了要补 |
| 图/字都进去了但回车没反应 | Chromium 的**窗口遮挡判定**把离屏窗口判成 hidden，豆包输入框退化成只读副本 | 已经在 `main.js` 里关掉 `CalculateNativeWinOcclusion`；如果被改回去了，重新打开 |
| 白底图出来发灰 / 主体太大太小 | 豆包出图留白不稳定 | `lib/fit.js` 的 `WHITE` 阈值（默认 246）和画布比例 |
| 生成的视频有字幕/口播 | 提示词约束没生效，或豆包忽略了 | 确认三个勾选项已勾；`lib/prompt.js` 的约束段是硬约束，可以把措辞写得更强 |
| 账号频繁掉线 | 分区被清 / cookie 过期 / 同一账号在别处登录 | 重新扫码；`startKeepAlive()` 每 45 秒检查强凭证 cookie |
| 加了自定义平台但跑不动 | 该站点结构特殊，通用探针找不到输入框 | 只改 `lib/gen-agent.js` 里的选择器，别动豆包的 `driver.js` |
| 删账号后分区目录删不掉 | 文件被占用 | 已有三重兜底（rmSync → PowerShell → cmd rmdir）+ 待清扫机制，下次启动自动清 |
| 改了代码没生效 | 没重启 | 关掉程序再开；源码没有热重载 |

---

## 7. 扩展点（用户想加功能时改哪里）

| 想做的事 | 改哪里 | 注意 |
|---|---|---|
| 加一个 AI 平台 | **不用改代码**，界面「AI 平台 → 添加平台」 | 平台结构特殊才需要动代码 |
| 让某个平台也能跑视频 | `lib/gen-agent.js` 补选择器 | 方法名必须和 `driver.js` 一致（`openNewChat / typePrompt / send / waitResult / grab`） |
| 改提示词风格 | `lib/prompt.js`（分镜与约束）+ `skills/seedance-prompt/` | 三层骨架别拆：固定参数 / 时间轴分镜 / 约束与规格 |
| 调真实感 / 参考图锁 / 运镜用词 | `lib/craft.js`（`REF_LOCK` / `CAMERA_FLAWS` / `GEAR_ERA` / `FORMAT_CRAFT` / `pitfallsFor`） | 按形态 `key` 索引，改形态名要同步改这里；改完跑 `node _t/check-prompt.js` 第 7 段 |
| 加新的商品形态 | `lib/product-forms.js` | 一种形态 = 一条真实动作链，不要套模板 |
| 加新的视频形态（街拍/段子这类叙事路子） | `lib/formats.js` 的 `FORMATS`（打分 + 8 拍 acts + 机位/声音/禁忌），然后重生成文档 | 还得在 `lib/craft.js` 补 `FORMAT_CRAFT` / `GEAR_ERA`；改完必须跑 `node _t/cover.js` 和 `node _t/gen-formats-doc.js > skills/seedance-prompt/references/video-formats.md` |
| 某个商品被认错品类 | `lib/formats.js` 的 `CAT_OVERRIDES`（改判品类）或 `REFINE`（连场景/尺寸/动作一起改） | 加完跑 `node _t/cover.js`，确认「未识别品类 = 0」 |
| 加新的任务类型（比如「图生图去背景」） | `lib/prompt.js` 的 `OTHER_KINDS` + `lib/pipeline.js` 的 `runOtherTask` | `needRef` 决定是否强制上传参考图 |
| 改界面 | `index.html` / `style.css` / `renderer.js` / `task-ui.js` | 设计 token 在 `style.css` 顶部，明暗两套变量，别硬写颜色 |
| 加一个 IPC | `main.js`（或 `lib/ext.js`）`ipcMain.handle` + `preload.js` 暴露 + 渲染层调用 | 三处必须同步，缺一处就是 undefined |

---

## 8. 给 AI 的硬性规矩

1. **不许引入新的 npm 依赖。** 这个程序故意的：只用 Electron 自带能力 + 原生 fs/path。加依赖会让免安装包变大、被杀软误报。
2. **不许把数据发到外部服务器。** 用户买这个软件就是因为「全在自己电脑上」。
3. **不许打包成 asar。** 用户要能自己改 `resources/app/` 下的明文源码。
4. **不许改 `preload.js` 的 `contextIsolation` / 打开 `nodeIntegration`。** 这是安全底线。
5. **改 JS 之后必须 `node --check <文件>`**，语法错会让整个界面白屏。
6. **不要动 `userdata/` 里的真实账号数据**做测试；要测就新建一个测试账号。
7. **改完只说三句话**：改了哪个文件、为什么、用户怎么验证（重启 + 看哪一步）。别贴大段代码。
8. 拿不准就**先让用户跑自检 + 发日志**，不要猜着改。

---

## 9. 用户可以直接复制的一句话

> 这是我的程序「Look」（Electron，源码在 resources/app 下，明文可改）。
> 我遇到的问题是：**〔把现象写在这里，附截图〕**
> 日志最后几行是：**〔粘 app-run.log 末尾〕**
> 这是项目的 AI 使用说明：**〔把这份文档整份贴进来〕**
> 请帮我定位并给出改法。改哪个文件、改成什么，直接告诉我。

---

## 10. 许可与出处

- 本项目 MIT 开源，可自由修改、二次开发、商用集成，保留作者署名即可。
- 使用的提示词方法论参考 Seedance 官方写作公式，整理在 `skills/seedance-prompt/`。
- 不包含、不调用任何第三方厂商的模型或 API；所有生成能力来自用户自己的豆包账号。

作者：Leon。本项目按 MIT 许可开源，保留作者署名即可。
