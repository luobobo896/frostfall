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

## 5. 第 3 步（未做）：界面从 DOM 换到 Canvas

这是**唯一的大头**，也是**发布前的硬阻塞**。官方那套 `minigame-adapter` 只解决 canvas/WebGL/音频等 API，
**不会提供 DOM 与 CSS 布局**，所以：

* 11 个界面（大厅 / TD HUD / 防守 HUD / 商店 / 背包 / 结算 / 设置 / 暂停 / 引导 / 建造轮盘 / 塔面板）
  现在是 HTML + CSS，得改成 Canvas 绘制；
* 连带的还有：**触摸输入**（`pointerdown/move/up` → 全局 `wx.onTouchStart/Move/End`，含双击缩放与双指缩放）、
  **文字排版**（`ctx.fillText` + 自己量宽）、**安全区与胶囊避让**、以及 §1.9.2 那些热区/拇指弧验收线要重新量；
* 现在的 `render.js` 已经是纯 Canvas（只依赖 `canvas.getContext('2d')`），**战场那一块可以原样复用**，
  要重写的是外围的 HUD 与面板。

**建议的做法**：先只做**大厅一屏**（地图卡 / 模式 / 英雄 / 开始按钮），在小游戏里跑起来看观感，
确认这条路值不值，再决定另外 10 个界面怎么切。别一上来全量重写。

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
npm run minigame      # 打包 + 假 wx 本地验收（等价性 / 模块清单 / 存储）
npm test              # 265 项，含 tests/minigame-bundle.test.js（打包产物本身也有检查）
npm run smoke         # 378 条真浏览器断言（界面那一层仍然按浏览器验）
```
