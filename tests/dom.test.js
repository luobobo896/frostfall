// HUD 接线校验：ui.js 里 $('id') 抓取的每个 id 都必须在 index.html 里存在。
// 浏览器里这类拼写错误只会在运行时静默失败，静态检查能提前拦住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const ui = await readFile(new URL('src/ui.js', root), 'utf8');
const css = await readFile(new URL('src/styles.css', root), 'utf8');
const main = await readFile(new URL('src/main.js', root), 'utf8');

/**
 * §155：**静态文案里的数字要和数据表对得上**。
 * 面板上的句子是写死的（「提前开波 +3木」「药品背包共 3 格」…），而它是从 `data.js` 抄来的——
 * 数据一改、文案就变成假话，而且**没有任何检查会红**（对照 §115 的「假选项」是同一类毛病）。
 * 这里不把文案改成动态的（句子是给人读的，改价时该有人重新读一遍），而是让数据一变就红。
 */
test('§155 静态文案里的数字与数据表对账（改了数据不更新文案就红）', async () => {
  const D = await import('../src/data.js');
  const M = await import('../src/match.js');
  const has = (text, s) => assert.ok(text.includes(s), `文案里找不到「${s}」`);

  has(html, `提前开波 +${D.ECONOMY.earlyWaveLumber}木`);                       // §5.5.1 提前开波的木材奖励
  has(html, `修城 ${D.DEFENSE_RULES.repairGold} 金`);                          // §2.6 修城价钱
  has(html, `药品背包共 ${D.POTION_BAG_SLOTS} 格`);                            // §5.5.3 药品 3 格
  has(html, `读条 ${D.SHOP_CAST_SEC} 秒`);                                     // §5.5 波次中补给读条
  has(html, `第 0 / ${D.WAVES.length} 波`);                                    // §8.1 首发 12 波
  has(html, `攒够 ${D.EQUIP_CRAFT.need} 件同部位同品质`);                      // §5.4 合成 3 件
  const step = D.SHOP_ITEMS.find((i) => i.type === 'potion')?.priceStepPct ?? 0;
  has(html, `涨价 ${Math.round(step * 100)}%`);                                // §5.5 同种涨价 +20%
  has(html, `冷却 ${D.DEFENSE_RULES.teleportCooldownSec} 秒`);                  // §2.6 小地图那行的「回城冷却」（§167 顺手补上）

  // 动态那几处（不写死数字，所以只能对「读的常数」）：修塔的价钱在 UI 与内核之间只留一个定义
  // 注意别只查 `ui.includes('TOWER_REPAIR_GOLD')`——import 那一行也算「包含」，于是标签写回字面量
  // 照样绿（第一版就是这么写的，变异测试当场戳穿）。要查的是**那一行标签**读的是不是常数。
  const labelLine = (needle) => ui.split('\n').find((l) => l.includes(needle)) ?? '';
  assert.match(labelLine('el.btnRepairTower.textContent'), /TOWER_REPAIR_GOLD/,
    `修塔那颗按钮的价钱要读内核常数，实际：${labelLine('el.btnRepairTower.textContent').trim()}`);
  assert.match(labelLine('el.btnRepair.textContent'), /DEFENSE_RULES\.repairGold/,
    `修城的价钱要读 DEFENSE_RULES，实际：${labelLine('el.btnRepair.textContent').trim()}`);
  assert.match(labelLine('el.btnRepair.textContent'), /DEFENSE_RULES\.repairPct/,
    `修城的回血比例要读 DEFENSE_RULES，实际：${labelLine('el.btnRepair.textContent').trim()}`);
  // 内核那边也只许有一份：`repairTower()` 里再冒出字面量 60 就说明又抄了一遍
  const matchSrc = await readFile(new URL('src/match.js', root), 'utf8');
  const body = matchSrc.slice(matchSrc.indexOf('export function repairTower('), matchSrc.indexOf('\n}', matchSrc.indexOf('export function repairTower(')));
  assert.ok(body.includes('TOWER_REPAIR_GOLD'), `repairTower 要用 TOWER_REPAIR_GOLD，实际：${body.split('\n').slice(0, 6).join(' ')}`);
  assert.ok(!/\b60\b/.test(body), 'repairTower 里还有字面量 60（又抄了一份价钱）');
  assert.equal(typeof M.TOWER_REPAIR_GOLD, 'number');
});

test('index.html 里的 id 覆盖 ui.js 的所有 $() 查询', () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const wanted = [...ui.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = wanted.filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `index.html 缺少这些 id: ${missing.join(', ')}`);
  assert.ok(wanted.length > 20, '应该抓取到完整的 HUD 元素集合');
});

test('样式表覆盖 HUD 用到的主要类名，且热区符合 §1.9.2', () => {
  for (const cls of ['.btn', '.panel', '.skill', '.wheel', '.modal', '.item', '.toast']) {
    assert.ok(css.includes(cls), `styles.css 应定义 ${cls}`);
  }
  assert.match(css, /--touch:\s*48px/, '最小热区令牌应 ≥ 44px（§1.9.2）');
  assert.match(css, /--btn:\s*88px/, '主按钮直径应落在 76-88px（§1.9.2）');
});

// §14.3 稿 4：右侧日志面板在防守模式要让位。这条**必须由 CSS 表达**——
// 以前是在 renderDefense 里 `classList.add('hidden')` 且从不 remove，打完一局防守回到 TD，
// 日志面板整页都不会再出现（验证记录 §94）。静态检查能拦住「又写回老写法」。
test('§14.3 稿 4：日志面板的让位写在 CSS 里，不是每帧往元素上 add hidden', () => {
  assert.match(css, /#stage\.defense \.hud-right\s*\{[^}]*display:\s*none/, '样式表要有防守态的规则');
  assert.ok(!/log\.parentElement\?\.classList\.add\('hidden'\)/.test(ui),
    '别再往元素上加 hidden——只加不减的类名会永久留在元素上');
  assert.match(ui, /if \(m\.mode === 'defense'\) return renderDefense/, '防守分支还在');
});

// §94 同源：塔面板/建造轮盘是**页面级** DOM，`startMatch()` 只清 view.selectedSlot，
// 收不掉它们。所以「再开一局 / 回大厅」这两条路径必须显式收一次——
// 不然核心被打爆那一刻还开着的面板会挂进新局，而且写着上一局的数值（验证记录 §95）。
test('开新局前要收掉上一局的浮层（轮盘与塔面板）', () => {
  // §188：这条以前是「`restart:` 之后 160 字内必须出现那两句」——盯的是**排版**不是行为：
  // 一给 `restart` 补注释就红（本轮就是被自己加的 6 行说明绊倒的）。改成**抽出 handler 正文**再断言。
  const handlerBody = (name) => {
    const from = main.indexOf(`\n  ${name}:`);
    assert.ok(from > 0, `找不到 handlers.${name}`);
    const rest = main.slice(from + 1);
    const next = rest.search(/\n {2}[a-zA-Z_]+:/);
    return next === -1 ? rest : rest.slice(0, next);
  };
  for (const name of ['lobby', 'restart']) {
    const body = handlerBody(name);
    assert.match(body, /ui\.closeWheel\(\);/, `${name} 要收建造轮盘`);
    assert.match(body, /ui\.closeTower\(\);/, `${name} 要收塔面板`);
  }
});

// §10.1：**每一个会改对局的 handler 都必须有联机分支**。这条比「键盘别直接调内核」更根本：
// 「提前开波」当初就是整个 handler 没有 net 分支（§106），这条静态检查能当场抓住它。
test('联机：改对局的 handler 都有 net 分支（不是只改本地镜像）', () => {
  const start = main.indexOf('const handlers = {');
  const body = main.slice(start, main.indexOf('\n};', start));
  // 只做本地界面/设置、不碰对局的 handler：不需要 net 分支。
  // `lobby` / `restart` 曾经在这张白名单里——它们当然也改对局（重开/清局），漏掉的代价是
  // 联机局里点「回大厅」**整页死路**（§113）。改对局的 handler 一个都不许漏。
  // §131 起 `endless` 也在里面：它只翻一个界面标记（把结算面板让开），不碰对局——
  // 联机局的推进本来就由服务端负责，客户端这边没有 net 分支可写。
  // §154 起 `isDefense` 也在里面：它是**只读**查询（设置面板按模式决定摆哪几行），改不了对局——
  // 和 `getSettings` / `isOffline` 同一类。
  const LOCAL_ONLY = new Set(['getSettings', 'isOffline', 'isDefense', 'updateSetting', 'resetSettings',
    'replayTutorial', 'resume', 'endless']);
  const keys = [...body.matchAll(/^ {2}([a-zA-Z_]+):/gm)].map((m) => m[1]);
  assert.ok(keys.length > 15, `应该解析出完整的 handlers（拿到 ${keys.length} 个）`);
  // 逐个 handler 的正文里必须出现 net（`net ? … : …` / `if (net)` / `net.xxx(...)`）
  for (const k of keys) {
    if (LOCAL_ONLY.has(k)) continue;
    const from = body.indexOf(`\n  ${k}:`);
    const next = body.slice(from + 1).search(/\n {2}[a-zA-Z_]+:/);
    const seg = body.slice(from, next === -1 ? undefined : from + 1 + next);
    assert.ok(/\bnet\b/.test(seg), `handlers.${k} 没有联机分支（联机下只会改本地镜像，见 §106）`);
  }
});

// §10.1：联机下 UI 的每一次操作都必须走指令（服务端权威）。键盘快捷键曾经直接调内核
// （`castSkill(match, i)` / `reviveNow(match)`），联机按了只改本地镜像、下一份快照又打回原样。
test('联机：UI 与键盘都走同一条指令出口，不许直接调内核', async () => {
  const keyBlock = main.slice(main.indexOf("window.addEventListener('keydown'"),
    main.indexOf("window.addEventListener('keydown'") + 500);
  for (const direct of ['castSkill(match', 'reviveNow(match', 'startWaveEarly(match', 'orderMove(match', 'teleportHome(match', 'sellTower(match', 'upgradeTower(match']) {
    assert.ok(!keyBlock.includes(direct), `键盘里不许直接调 ${direct}（联机只改本地镜像）`);
  }
  // 提前开波那条曾经也是直接调内核（冒烟 §105 的指令批次抓到）
  const earlyBlock = main.slice(main.indexOf("getElementById('btnEarly').onclick"), main.indexOf("getElementById('btnEarly').onclick") + 300);
  assert.ok(!earlyBlock.includes('startWaveEarly(match'), '提前开波按钮要走 handlers.early()（有联机分支）');
});

/**
 * §174：**协议里的每个消息类型，两边都要有人用**。
 * `msg.chat` 曾经躺在那里：服务端零发送、客户端零处理、设计文档里也没有聊天这项——
 * 和早先删掉的 `price` 查询同样是「写了但没人用」（那种东西比缺东西更坏：读代码的人会以为有这条链路）。
 * 判据：每个 `msg.<type>` 必须（a）在服务端代码里被 `msg.<type>(` 发出去过，（b）在 net.js 里有 `case '<type>'`。
 */
test('§174 协议消息类型两边都有人用（发送方 + 处理方）', async () => {
  const proto = await readFile(new URL('src/protocol.js', root), 'utf8');
  const netSrc = await readFile(new URL('src/net.js', root), 'utf8');
  const serverDir = new URL('src/server/', root);
  const serverSrc = (await Promise.all(
    ['room.js', 'game-server.js', 'match-queue.js', 'ws.js'].map((f) => readFile(new URL(f, serverDir), 'utf8')),
  )).join('\n');
  const msgBlock = proto.slice(proto.indexOf('export const msg = {'), proto.indexOf('\n};', proto.indexOf('export const msg = {')));
  // 一条一条解析：**键名**（`events`）与**线上类型**（`'ev'`）可以不一样，处理方看的是线上类型
  const entries = msgBlock.split(/\n {2}(?=[a-zA-Z]+: )/).slice(1).map((chunk) => {
    const key = chunk.match(/^([a-zA-Z]+):/)?.[1];
    const wire = chunk.match(/\bt: '([a-z]+)'/)?.[1];
    return { key, wire };
  });
  assert.ok(entries.length >= 5, `应该解析出全部消息类型（拿到 ${entries.length} 条：${entries.map((e) => e.key).join('/')}）`);
  for (const { key, wire } of entries) {
    assert.ok(key && wire, `msg.${key} 要写清线上类型（t: '…'）`);
    assert.match(serverSrc, new RegExp(`msg\\.${key}\\(`), `msg.${key} 没有任何发送方（服务端代码里找不到 msg.${key}(）`);
    assert.match(netSrc, new RegExp(`case '${wire}':`), `客户端没有处理线上类型 '${wire}'（msg.${key}，net.js 里找不到 case '${wire}':）`);
  }
});

/**
 * §175：**没有「写了但没人用」的导出**（和 §174 那条同一个教训）。
 * `slotIndexAt` / `dropForExport` / `depthOf` 三个导出曾经零读者——源码里没有、用例里也没有。
 * 判据：每个 `export` 出来的函数/常量，在「它自己那份文件的别处」或「其它任何源码 / 工具 / 用例」
 * 里至少要出现一次（自己那一行是定义，不算读者）。
 */
test('§175 导出的东西都有人用（零读者的导出 = 写给想象中的调用方）', async () => {
  const srcDir = new URL('src/', root);
  const srcNames = (await readdir(srcDir)).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`);
  // `src/server/*.js` 也是源码（服务端）：漏掉它会把 room.js 用到的东西误判成零读者
  for (const f of await readdir(new URL('src/server/', root))) {
    if (f.endsWith('.js')) srcNames.push(`src/server/${f}`);
  }
  // `src/minigame/*.js` 同理（小游戏入口与大厅那一屏）：漏掉它会把 platform.js 的 onTouch 误判成零读者
  for (const f of await readdir(new URL('src/minigame/', root))) {
    if (f.endsWith('.js')) srcNames.push(`src/minigame/${f}`);
  }
  const corpora = [];
  /**
   * 注释里提到一个名字**不算读者**——第一版没剥注释，于是这条检查被它自己的说明文字喂饱了：
   * 变异测试把 `depthOf` 加回来，检查居然还是绿的（我在注释里正好写了这个名字）。
   */
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const p of srcNames) corpora.push([p, strip(await readFile(new URL(p, root), 'utf8'))]);
  for (const dir of ['tools/', 'tests/']) {
    for (const f of await readdir(new URL(dir, root))) {
      if (f.endsWith('.js') || f.endsWith('.mjs')) corpora.push([dir + f, strip(await readFile(new URL(dir + f, root), 'utf8'))]);
    }
  }
  const dead = [];
  for (const [p, text] of corpora) {
    if (!p.startsWith('src/')) continue;
    for (const m of text.matchAll(/^export (?:function|const|class|async function) ([A-Za-z_][A-Za-z0-9_]*)/gm)) {
      const name = m[1];
      let readers = 0;
      for (const [q, other] of corpora) {
        const hits = [...other.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
        readers += q === p ? Math.max(0, hits - 1) : hits;   // 同文件里那一次是定义本身
      }
      if (readers === 0) dead.push(`${p} → ${name}`);
    }
  }
  assert.deepEqual(dead, [], `这些导出没有任何读者（源码 / 工具 / 用例里都找不到）：\n${dead.join('\n')}`);
});

/**
 * §177：开局参数的默认值只能有一份（`data.js` 的 `normalizeChoice`）。
 * 以前这里手抄了一份 `params.get('map') ?? 'map_01'`，而 `?map=def_02` 那种「模式没带」的链接
 * 就把非法组合直接送进 `createMatch`——抛在模块顶层，整页白屏，而且脏值还会写回档案。
 */
/**
 * §206：**日志面板是 innerHTML 拼的**——`e.text` 直接插进去，所以「日志里出现玩家能控制的字符串」
 * 就等于一个 XSS 口子。今天的文案全是内核/服务端自己造的（塔名、怪名、轮次…），但
 * 「X 加入了房间 / X 掉线」正是最可能新增的一行（§122 那次就是 `?name=<img onerror>` 在别人页面上执行）。
 * 这条把规矩钉在源码上：插 `e.text` 时必须过 `esc(`。反证：去掉 `esc(` → 红。
 */
test('§206 日志面板插 innerHTML 前必须转义（§122 的规矩，最容易新增的那一行）', () => {
  const from = ui.indexOf('function renderLog(');
  assert.ok(from > 0, '找不到 renderLog');
  const body = ui.slice(from, ui.indexOf('\n  }', from));
  assert.match(body, /innerHTML/, 'renderLog 应该是拼 innerHTML 的那一处');
  assert.match(body, /\besc\(\s*e\.text\s*\)/, '`e.text` 必须过 `esc(`——日志里迟早会出现玩家名字');
});

test('§177 开局参数一律过 choiceFrom，不在入口手抄默认值', () => {
  // 用 ok(...) 而不是 match(...)：失败时不要把整个 main.js 打进失败信息里
  assert.ok(/const choice = choiceFrom\(params, lastChoice\)/.test(main),
    'main.js 的 choice 应该由 data.js 的 choiceFrom（URL + 档案合成 + 归一化）给');
  assert.ok(/import \{[^}]*choiceFrom[^}]*\} from '\.\/data\.js'/.test(main), 'choiceFrom 应从 data.js 导入');
  for (const k of ['mode', 'map', 'difficulty', 'hero', 'length']) {
    assert.ok(!new RegExp(`params\\.get\\('${k}'\\) \\?\\? '[a-z_0-9]+'`).test(main),
      `${k} 的默认值该由 choiceFrom 给，不要在 main.js 里再抄一份`);
  }
});

test('页面按横屏与小游戏视口声明（§14.1.1）', () => {
  assert.ok(html.includes('viewport-fit=cover'), '应适配刘海安全区');
  assert.ok(html.includes('./src/main.js'), '应加载入口模块');
  assert.ok(!html.includes('portrait'), '不做竖屏');
});

/**
 * §176：**用到的 class 都要有样式规则**。类名写错不会报错——元素只是「少了一点样式」，
 * 版式体检也未必红（少个字号/间距照样不溢出）。这条把两边对一遍：index.html / ui.js / main.js
 * 里出现的每一个 class，样式表里都要能查到 `.name`。
 * `profile-bar` 是例外：它是纯语义钩子（冒烟用 `#profileBar` 这个 id 查它），本来就没有样式。
 */
test('§176 用到的 class 都有样式规则（写错类名不会静默）', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const ruled = new Set([...strip(css).matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const sources = [['index.html', html], ['src/ui.js', ui], ['src/main.js', main]];
  const used = new Map();
  const isClass = (c) => /^[a-z][\w-]*$/.test(c);
  for (const [name, text] of sources) {
    const t = strip(text);
    for (const m of t.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (isClass(c) && !used.has(c)) used.set(c, name);
    for (const m of t.matchAll(/className\s*=\s*'([^']*)'/g)) for (const c of m[1].split(/\s+/)) if (isClass(c) && !used.has(c)) used.set(c, name);
    for (const m of t.matchAll(/classList\.(?:add|remove|toggle)\(\s*'([^']+)'/g)) if (isClass(m[1]) && !used.has(m[1])) used.set(m[1], name);
  }
  const ALLOW = new Set(['profile-bar']);   // 纯语义钩子（没有样式），见上面的注释
  const missing = [...used].filter(([c]) => !ruled.has(c) && !ALLOW.has(c)).map(([c, f]) => `${c}（${f}）`);
  assert.ok(used.size > 40, `应该扫到完整的 class 集合（拿到 ${used.size} 个）`);
  assert.deepEqual(missing, [], `这些 class 在样式表里没有规则（拼错了？）：\n${missing.join('\n')}`);
});
