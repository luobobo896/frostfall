// 微信小游戏打包（移植第 2 步）：把 ESM 源码打成一个**小游戏主包**。
//
// 为什么需要：小游戏跑的是 `game.js` + CommonJS 的 `require`（不是浏览器那种 `<script type=module>`），
// 而我们整套源码是 ESM。零依赖原则下不值得为拉一个 bundler 进来——本仓库的模块风格是统一的
// （静态 import、具名 export、没有 default / 没有动态 import / 没有 `export *`），所以这里用
// 「按行识别 + 收集导出名」的转换就够了，并且在打包时顺手做两件事：
//   ① 循环依赖检测（打完才发现 undefined 就晚了）；
//   ② 体积报告（主包有 4MB 上限，见官方「代码包」文档）。
//
// 用法：node tools/build-minigame.mjs      → 产出 dist/minigame/{game.js,game.json,project.config.json}
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = 'src/minigame/game.js';
const OUT_DIR = join(ROOT, 'dist/minigame');

/** 把一条 import 语句换成 `const … = __req('…')`（支持跨行的花括号列表与 `as` 重命名）。 */
function transformImports(src) {
  const names = [];   // 本模块用到的导入名（供「用到了却没导入」这类排查）
  const out = src.replace(
    /^import\s+(?:(\*\s+as\s+[A-Za-z_$][\w$]*)|(\{[\s\S]*?\})|([A-Za-z_$][\w$]*))\s+from\s*['"]([^'"]+)['"];?/gm,
    (full, star, braces, dflt, spec) => {
      if (star) { const n = star.replace(/^\*\s+as\s+/, '').trim(); names.push(n); return `const ${n} = __req(${JSON.stringify(spec)});`; }
      if (braces) {
        const list = braces.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
          .map((s) => {
            const m = s.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
            if (!m) throw new Error(`看不懂的导入：${s}`);
            names.push(m[2] ?? m[1]);
            return m[2] ? `${m[1]}: ${m[2]}` : m[1];
          });
        return `const { ${list.join(', ')} } = __req(${JSON.stringify(spec)});`;
      }
      names.push(dflt);
      return `const ${dflt} = __req(${JSON.stringify(spec)}).default;`;
    },
  );
  // `import './side-effect.js'`（目前没有，但别让它静默漏掉）
  const side = out.replace(/^import\s*['"]([^'"]+)['"];?/gm, (full, spec) => `__req(${JSON.stringify(spec)});`);
  return { code: side, names };
}

/** 剥掉 `export `，并把导出名收集起来（打包器靠它生成模块的返回对象）。 */
function transformExports(src) {
  const exported = new Set();
  const code = src.replace(/^export\s+(\{[^}]*\}|(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/gm,
    (full, _all, fn, cls, v) => {
      if (full.startsWith('export {')) {
        for (const part of full.replace(/^export\s*\{|\}$/g, '').split(',')) {
          const m = part.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
          if (m) exported.add(m[2] ?? m[1]);
        }
        return '';   // `export { A, B }` 这一行本身不需要执行
      }
      exported.add(fn ?? cls ?? v);
      return full.replace(/^export\s+/, '');
    });
  // `export default` 我们一个都没有——真出现了要立刻报错，而不是悄悄少导出一个东西
  if (/^export\s+default/m.test(src)) throw new Error('这份源码里不该有 export default（打包器没实现它）');
  if (/^export\s+\*/m.test(src)) throw new Error('不支持 export *（请改成具名导出）');
  return { code, exported: [...exported] };
}

/** 收集模块图（深度优先），顺便报循环依赖。 */
async function collect(entry) {
  const modules = new Map();     // 绝对路径 → { code, exported, deps }
  const visiting = new Set();
  const cycles = [];

  const walk = async (file, stack = []) => {
    const abs = resolve(ROOT, file);
    // 顺序要紧：**先看是不是正在走的这条链**（那才是环），再看有没有走过。
    // 反过来写的话，父模块自己已经进 modules 了，A→B→A 会被当成「走过」静默返回，环永远报不出来。
    if (visiting.has(abs)) { cycles.push([...stack, file].join(' → ')); return; }
    if (modules.has(abs)) return;
    visiting.add(abs);
    const raw = await readFile(abs, 'utf8');
    const deps = [...raw.matchAll(/^import\s+(?:[\s\S]*?\s+from\s*)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    const { code: imported } = transformImports(raw);
    const { code, exported } = transformExports(imported);
    modules.set(abs, { code, exported, deps, file });
    for (const d of deps) {
      if (!d.startsWith('.')) throw new Error(`${file}: 只支持相对路径导入（遇到 ${d}）`);
      await walk(join(dirname(file), d), [...stack, file]);
    }
    visiting.delete(abs);
  };
  await walk(entry);
  if (cycles.length) throw new Error(`检测到循环依赖（打包后会出现 undefined）：\n${cycles.join('\n')}`);
  return modules;
}

function emit(modules, entry) {
  const parts = [
    '// 由 tools/build-minigame.mjs 生成，别手改（改源码后重跑 npm run build:minigame）',
    '(function () {',
    '  var __mods = {}; var __cache = {};',
    '  function __def(id, fn) { __mods[id] = fn; }',
    '  // 缓存的是**导出对象**本身（第一版缓存了外层包装，第二次 require 就拿到 {exports:…} 了——',
    '  // 表现是「同一个模块第一次用没事、第二次用全是 undefined」，打包后的 undefined 十有八九是这里错）',
    '  function __req(id) {',
    '    if (Object.prototype.hasOwnProperty.call(__cache, id)) return __cache[id];',
    '    if (!__mods[id]) throw new Error("模块没打包进来: " + id);',
    '    __cache[id] = {};   // 循环依赖时的占位',
    '    __cache[id] = __mods[id]() || __cache[id];',
    '    return __cache[id];',
    '  }',
  ];
  for (const [abs, mod] of modules) {
    const id = relative(ROOT, abs).split('\\').join('/');
    parts.push(`  __def(${JSON.stringify(id)}, function () {`);
    // 依赖用的是相对当前文件的写法（与源码一致），这里把「当前文件目录」拼回去
    const dir = dirname(id);
    const body = mod.code.replace(/__req\((['"])([^'"]+)\1\)/g, (full, q, spec) => {
      const resolved = spec.startsWith('.') ? join(dir, spec).split('\\').join('/') : spec;
      return `__req(${JSON.stringify(resolved)})`;
    });
    parts.push(body.split('\n').map((l) => `    ${l}`).join('\n'));
    parts.push(`    return { ${mod.exported.filter(Boolean).join(', ')} };`);
    parts.push('  });');
  }
  // 调试口：`__frostfallRequire('src/data.js')` 能看某个模块到底导出了什么（排「打包后 undefined」用）
  parts.push('  var __g = (typeof GameGlobal !== "undefined" ? GameGlobal : globalThis);');
  parts.push('  __g.__frostfallRequire = __req;');
  parts.push(`  var entry = __req(${JSON.stringify(entry)});`);
  parts.push('  if (typeof GameGlobal !== "undefined") GameGlobal.__frostfallMiniGame = entry;');
  parts.push('  else if (typeof globalThis !== "undefined") globalThis.__frostfallMiniGame = entry;');
  parts.push('})();');
  return parts.join('\n');
}

const modules = await collect(ENTRY);
const bundle = emit(modules, ENTRY);
await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, 'game.js'), bundle);
for (const f of ['game.json', 'project.config.json']) {
  await cp(join(ROOT, 'minigame', f), join(OUT_DIR, f));
}
const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
console.log(`小游戏主包 → dist/minigame/game.js（${modules.size} 个模块 · ${kb(Buffer.byteLength(bundle))}）`);
console.log(`主包上限 4MB：当前占 ${(100 * Buffer.byteLength(bundle) / (4 * 1024 * 1024)).toFixed(2)}%（官方「代码包」口径：主包 ≤4M、主包+分包 ≤30M）`);
