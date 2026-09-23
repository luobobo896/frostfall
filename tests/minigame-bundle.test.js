// 小游戏包（移植第 2 步）：**打包产物本身**也要有能失败的检查。
// 这份用例跑的是 `npm run minigame` 的同一套东西，只是搬进 npm test，免得改动内核之后
// 「包还能不能用」没人管（打包器第一版就有个缓存 bug，正是这一类的）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installFakeWx } from '../tools/fake-wx.mjs';

/**
 * 打包产物写进**本进程的临时目录**：`npm test` 并发跑多个测试文件，两个都往同一个 dist 写会互相踩
 * （实测：单跑绿、整包偶发红）。`FF_MINIGAME_OUT` 就是给这件事留的口子。
 */
const OUT = mkdtempSync(join(tmpdir(), 'ff-mini-bundle-'));
process.env.FF_MINIGAME_OUT = OUT;
const BUNDLE = join(OUT, 'game.js');

test('小游戏包：假 wx 下能加载、内核与源码逐字段等价、主包没混进界面模块', async () => {
  await import('../tools/build-minigame.mjs');   // 顶层 await：import 返回时包已经打好了
  const fake = installFakeWx();
  try {
    const require = createRequire(import.meta.url);
    require(BUNDLE);
    const api = globalThis.__frostfallMiniGame;
    assert.ok(api, '打包产物的入口要挂出来（小游戏里挂 GameGlobal，这里挂 globalThis）');

    const info = api.selfCheck();
    assert.equal(info.miniGame, true, '有 wx、没有 document → 认得出是小游戏环境');
    assert.equal(info.storage, true, '存储要能往返（小游戏走 wx.getStorageSync/setStorageSync）');
    // 假 wx 的默认视口是 667×375（手机横屏的**逻辑像素**，= §14.3 的设计画布尺寸）
    assert.equal(info.view.width, 667, '视口走 wx.getWindowInfo（逻辑像素）');

    // 等价性：同一局（同种子、同人数、同秒数）包里的内核 == 源码的内核
    const { createMatch, describe, update } = await import('../src/match.js');
    const { TICK_STEP } = await import('../src/data.js');
    const opts = { mapId: 'map_01', difficulty: 'normal', heroId: 'hero_warrior', seed: 11, players: 4 };
    const m = createMatch(opts);
    for (let i = 0; i < Math.round(90 / TICK_STEP); i += 1) update(m, TICK_STEP);
    assert.deepEqual(api.bootSession({ ...opts, seconds: 90 }), describe(m),
      '打包后的内核必须与源码逐字段一致（打包器改坏了的话这里会红）');

    // 主包里不许有界面模块：小游戏没有 DOM，ui/main/render 那一层得等第 3 步换 Canvas
    const text = await readFile(BUNDLE, 'utf8');
    const mods = [...text.matchAll(/__def\("([^"]+)"/g)].map((x) => x[1]);
    // render.js / hud-model.js 允许进主包（纯 Canvas 与纯逻辑，大厅缩略图就复用 render.js）；
    // DOM 那一层（ui.js / main.js / 摇杆 / 引导）不许进来。
    const ui = mods.filter((id) => /(^|\/)(ui|main|joystick|tutorial)\.js$/.test(id));
    assert.deepEqual(ui, [], `主包里混进了界面模块：${ui.join('、')}`);
    for (const call of ['getElementById', 'querySelector', 'innerHTML', 'classList']) {
      assert.ok(!text.includes(call), `主包里出现了界面专用的 DOM 调用：${call}`);
    }
  } finally { fake.uninstall(); }
});
