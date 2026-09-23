# 微信小游戏移植（M0.5 原型 → 小游戏包）

> 这份文件回答两件事：**现在的代码能不能发布到微信小游戏**，以及**已经做到了哪一步**。
> 数字都能复跑：`npm run minigame`（打包 + 本地验收）、`npm test`、`npm run smoke`。

## 1. 一句话结论

**还不能发布**。差的是「界面那一层」：小游戏**没有 DOM**，而大厅 / HUD / 结算 / 商店这些界面现在是
`index.html` + `styles.css` + `ui.js` 的 DOM+CSS，得改成 Canvas 绘制（第 3 步）。
**平台差异与打包这两层已经做完了**（第 1、2 步），内核那一大半已经能在小游戏环境里跑。

## 2. 官方规则（核实过的那几条）

网上流传的「小游戏限制」清单里有过时数据，以下是**从官方文档现查**的（2026-09 核对）：

| 项 | 现行规则 | 来源 |
|---|---|---|
| 代码包体积 | **主包 ≤ 4M；主包 + 分包合计 ≤ 30M；单个分包不限制大小** | [代码包](https://developers.weixin.qq.com/minigame/dev/guide/base-ability/code-package.html)、[分包加载](https://developers.weixin.qq.com/minigame/dev/guide/base-ability/subPackage/useSubPackage.html) |
| 网络 | 服务器域名**必须经过 ICP 备案**；`wx.request` / `wx.connectSocket` 的域名要在公众平台后台配成合法域名 | [网络](https://developers.weixin.qq.com/minigame/dev/guide/base-ability/network.html) |
| 上线前置 | 小程序 / 小游戏需要**备案**；类目与资质以公众平台「开放的服务类目」为准（游戏类目涉及主体与经营范围，含内购还要版号等） | [备案指引](https://developers.weixin.qq.com/miniprogram/product/record_guidelines.html)、[开放的服务类目](https://developers.weixin.qq.com/miniprogram/product/material/) |

对照一下社区那份 `weixin-game-skill`（`skill.md` v1.0.0，单 commit，`author: community`）：
它对的地方是无 DOM / `wx.createCanvas` / `wx.setStorageSync` / 全局触摸 / 主包 4MB；
**它过时的地方是「分包合计 20MB、单分包 2MB」**——现行是 30MB / 单分包不限。
另外它没写：`wx.getSystemInfoSync` 已不推荐（用 `wx.getWindowInfo`）、`wx.onShow/onHide` 生命周期、
音频要用户手势后播、域名备案与合法域名白名单。**结论：它当入门检查单可以，当规则不行。**

## 3. 第 1 步（已完成）：平台适配层 `src/platform.js`

把「浏览器专有 API」收进一个文件，业务代码只调这一层；浏览器与小游戏各一套实现，
Node（单元测试）走内存/空实现。**没有能力时一律安静失败**，不让一次点击把界面打断。

| 能力 | 浏览器 | 小游戏 | 谁在用 |
|---|---|---|---|
| 存储 | `localStorage` | `wx.getStorageSync/setStorageSync/removeStorageSync` | `profile.js` / `save.js` / `settings.js` / `net.js` |
| HTTP | `fetch` | `wx.request` | `main.js`（建房那一发） |
| WebSocket | `new WebSocket` | `wx.connectSocket` | `net.js`（统一成 `onOpen/onMessage/onClose/send/close` 一种形状） |
| 音频上下文 | `new AudioContext()` | `wx.createWebAudioContext()` | `audio.js` |
| 视口 / 像素比 | `innerWidth / innerHeight / devicePixelRatio` | `wx.getWindowInfo()` | `render.js` |
| 前后台 | `visibilitychange` + `pagehide` | `wx.onHide` | `main.js`（存档时机） |
| 触觉 | 无（安静跳过） | `wx.vibrateShort` | `feedback.js` |

**没覆盖**：DOM 与指针事件——那是第 3 步，见下。

## 4. 第 2 步（已完成）：小游戏包与打包器

```bash
npm run build:minigame   # 产出 dist/minigame/{game.js,game.json,project.config.json}
npm run minigame         # 先打包再跑本地验收（假 wx）
```

* **打包器**：`tools/build-minigame.mjs`，零依赖。把 ESM 源码按模块图打成一个 `game.js`
  （小游戏跑的是 `game.js` + CommonJS `require`，不是浏览器的 `<script type=module>`）。
  它顺手做两件事：**循环依赖检测**（打完才发现 undefined 就晚了）与**体积报告**。
* **入口**：`src/minigame/game.js`——建立 `selfCheck()`（认出小游戏环境 + 存储往返）与
  `bootSession()`（无头跑一局内核）。第 3 步的渲染循环会挂在这里。
* **配置**：`minigame/game.json`（横屏、关闭状态栏）与 `minigame/project.config.json`
  （`compileType: "game"`，`appid` 留空等你填）。
* **当前主包**：6 个模块（`data` / `core` / `match` / `defense` / `platform` / 入口），
  **约 172 KB**，占 4MB 主包上限的 **4.2%**。界面模块**故意不在里面**（见下一条检查）。

**本地验收**（`npm run minigame`，没有微信开发者工具也能跑）：

1. 假 `wx` 下入口能加载、`selfCheck()` 认出小游戏环境、存储往返成功；
2. **等价性**：同一局（同种子 / 同人数 / 同秒数）用包里的内核跑与用源码跑，`describe()` **逐字段相同**；
3. **主包里没有界面模块**：模块清单里不许出现 `ui/main/render/hud-model/joystick/tutorial`，
   也不许出现 `getElementById` / `querySelector` / `innerHTML` / `classList` 这类界面专用调用。

## 5. 第 3 步（进行中）：界面从 DOM 换到 Canvas

这是**唯一的大头**，也是**发布前的硬阻塞**。官方那套 `minigame-adapter` 只解决 canvas/WebGL/音频等 API，
**不会提供 DOM 与 CSS 布局**，所以：

* 11 个界面（大厅 / TD HUD / 防守 HUD / 商店 / 背包 / 结算 / 设置 / 暂停 / 引导 / 建造轮盘 / 塔面板）
  现在是 HTML + CSS，得改成 Canvas 绘制；
* 连带的还有：**触摸输入**（`pointerdown/move/up` → 全局 `wx.onTouchStart/Move/End`，含双击缩放与双指缩放）、
  **文字排版**（`ctx.fillText` + 自己量宽）、**安全区与胶囊避让**、以及 §1.9.2 那些热区/拇指弧验收线要重新量；
* 现在的 `render.js` 已经是纯 Canvas（只依赖 `canvas.getContext('2d')`），**战场那一块可以原样复用**，
  要重写的是外围的 HUD 与面板。

**建议的做法**：先只做**大厅一屏**，在小游戏里跑起来看观感，确认这条路值不值，再决定另外 10 个界面怎么切。

### 5.1 大厅一屏（已完成 · 2026-09-23）

![小游戏大厅样张](testing/screenshots/minigame-lobby.png)

* `src/minigame/lobby.js`：**纯 Canvas、零 DOM**，写成纯函数——`layoutLobby(w,h,model)` 算布局、
  `drawLobby(ctx,model,L)` 画一帧、`hitTestLobby(L,x,y)` 命中测试、`applyLobbyAction(model,action,档案)`
  改模型（含解锁校验）。于是它能被 Node 用例直接测（记录型 ctx），也能在浏览器里截图看观感。
* 内容与浏览器大厅对齐：模式 / 难度 / 时长 / 英雄 4 张卡 / 地图卡（复用 `render.js` 的俯视缩略图，
  带星级、路线数、「未解锁」标记）/ 档案行（人物等级 · 声望 · 可玩地图数）。
* 布局以 **667×375（§14.3 设计画布）为基准等比缩放并居中**，所以真机 812×375 这类更宽的屏直接居中多留白；
  所有可点元素 **≥44×44**（§1.9.2），并且**避开右上角胶囊区**。
* 输入走 `platform.onTouch`（小游戏 = 全局 `wx.onTouchStart`）。
* **「单人开局」是真的能进局的**（战场见 5.2）。写大厅那一版时它还是灰的、按钮上写着「第 4 步接入」——
  与其摆一个点了没反应的假按钮，不如把这件事写在脸上（口径见 STATUS §3.1 第 2 条：不给玩家假选项）。

**怎么复跑**：`npm run minigame`（打包 + 假 wx 验收，含「大厅真的画出来了」与「触摸能选中」两条）
· `npm run minigame:preview`（本机 Chrome 出样张，就是上面那张图）· `npm test`（7 条大厅用例：
热区 ≥44、互不重叠、避开胶囊、命中与画法同源、切模式换图、锁图不给选、提示文案不溢出）。

### 5.2 战场（已完成 · 2026-09-23）：大厅点「单人开局」真的能进局

![小游戏战场样张](testing/screenshots/minigame-battle.png)

* 战场**直接复用浏览器版的 `render.js`**（它本来就是纯 Canvas）：`createRenderer(canvas, { size })`
  多了一个 `size()` 口子——小游戏的 canvas 没有 `clientWidth/clientHeight`（那不是 DOM）。
* `src/minigame/battle.js`：外面这一圈 HUD（顶部状态条 + 底部动作行）用 Canvas 重画，
  与 `lobby.js` 同一套四件套（布局 / 绘制 / 命中 / 动作）。
* **现在能玩的**：点塔位 → 建造面板选塔种（5.2.1）、点已建的塔 → 塔面板升级/出售/优先级/修塔（5.2.1）、
  底部一排快捷改默认塔种、点「开波」提前开打、点技能键放技能、点「回大厅」退回去；
  结算出来之后「开波」变成「再开一局」。
* **还没搬过来的**（浏览器版有）：暂停与倍速、拖动与双指缩放、
  **防守模式**（跟随相机 + 摇杆 + 另一套 HUD）、新手引导条，以及结局面板还缺的细节
  （掉落清单 / 伤害占比 / 「继续上局」这类出口）。
  防守那一格现在**明写着还没接**：大厅切到防守时「单人开局」会给出理由，而不是开一局 TD 糊弄过去。
  剩下这几屏按玩家每局都会走一遍的顺序：**结算完善 → 设置 + 暂停/倍速 → 防守 HUD（含摇杆）→ 引导条**。

### 5.2.1 建造与塔面板（已完成 · 2026-09-23）

![小游戏塔面板样张](testing/screenshots/minigame-tower.png)

点空塔位弹**建造面板**（四种塔两列排，买不起的灰掉），点已建的塔弹**塔面板**：

* 读数一行：`Lv2 · 伤害 18.0 · 攻速 1.50 · 射程 5.0 · 对空 · 普通 · 克中甲 ×1.50`（克制提示与浏览器版同一个出口 `attackHint`）；
* **升级**（写着下一级价格，满级写「已满级」）、**出售**（两步确认，显示返还金额）、
  **四档优先级**（最靠前 / 最强 / 最弱 / 空中优先，当前那档高亮）、**修塔**（只在 5★/6★ 攻城图、塔受伤时才出现）、关闭；
* 两处都不给假选项：买不起的塔与满级/买不起的升级按钮都是灰的，点弹层空白处 = 关闭。

**为什么不做轮盘**：浏览器版是「点塔位 → 绕触点画一圈轮盘」，拇指得精确瞄准；小游戏屏更小、手指更粗，
所以先给两步式（点塔位 → 面板里选/操作）。**这是暂定方案**，真机手感确认后如果轮盘更顺手再换——
换的时候这一层的四件套（布局 / 绘制 / 命中 / 动作）不用动。

### 5.2.2 商店与背包（已完成 · 2026-09-23）

![小游戏商店样张](testing/screenshots/minigame-shop.png)

底部那排把四个塔种快捷键换成了 **商店 / 背包 / 药品**（建塔改成「点塔位弹面板」之后，塔种快捷键
就成了同一个决定的第二个入口，删掉它让位给真正缺的三个）：

* **商店**：8 件商品两列排（药品 / 增益 / 技能书各带价格，秘传书还带木材），
  **撤柜的两件（群体治疗符、回城卷轴）写在行上**（§3.1 #20 的口径：撤柜也要说清为什么），
  买不起 / 已买满 / 药品格满都会灰掉并写明原因；波次中下单的 3 秒读条进度写在标题里。
* **背包**：已装备 3 格 + 最近掉落（一屏放 6 件，其余在标题里写总数），点一件进**物品详情**——
  穿上 / 强化 +N（带金币）/ 出售（两步确认 + 返还金额，紫装以上带木材加成）；凑够 3 件同部位同品质时
  出现**一键合成**（同样两步确认）。
* **药品键**：底部直接显示 `药品 N/3`，点一下就用（冷却中或没药会说一句）。

返现比例、木材加成、药品格数这些数**都从内核取**（`EQUIP_SELL_REFUND` / `TOWER_SELL_REFUND` /
`EQUIP_SELL_BONUS_LUMBER` / `POTION_BAG_SLOTS`）——第一版我手写了 0.5，而内核是 0.7，
差一点就把「出售返还」写成假数字。

### 5.3 复跑

```bash
npm run minigame          # 打包 + 假 wx 验收（含「大厅画出来了 / 触摸能选中」6 条）
npm run minigame:preview  # 出上面两张样张
npm test                  # 277 项：大厅 7 条 + 战场 5 条（含「在假 wx 里真的能打起来」）
```

## 6. 发布前还差什么（非代码，都要你那边办）

| 项 | 谁来做 | 说明 |
|---|---|---|
| 小游戏 AppID | 你 | 填进 `minigame/project.config.json` 的 `appid` |
| 小程序备案 | 你 | 官方备案指引（上面链接） |
| 类目与资质 | 你 | 公众平台「开放的服务类目」；游戏类目涉及主体与经营范围，含内购涉及版号 |
| 联机服务器 | 你（部署） | 要 **wss + 已备案域名**，并在后台配成 socket 合法域名；现在的 `ws://127.0.0.1` 只在本机开发用 |
| 真机验收 | 你（微信开发者工具 + 真机） | 帧率 / 内存 / 音频解锁 / 触摸手感 / 安全区，本地没有真机与开发者工具 |

## 7. 现在能跑通的命令

```bash
npm run minigame      # 打包 + 假 wx 本地验收（等价性 / 模块清单 / 大厅画出来了 / 触摸能选中）
npm run minigame:preview  # 本机 Chrome 出大厅样张（docs/testing/screenshots/minigame-lobby.png）
npm test              # 272 项，含打包产物与大厅那一屏的检查
npm run smoke         # 378 条真浏览器断言（浏览器那一侧的界面仍然按浏览器验）
```
