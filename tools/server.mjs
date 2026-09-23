// 联机服务器入口：HTTP 静态资源 + WebSocket 房间。用法 node tools/server.mjs [port]
import { createGameServer } from '../src/server/game-server.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] ?? 8788);
// 局外档案落盘到 ./.data/profiles.json：重启服务器不丢玩家进度（正式形态应换 Redis/DB）
// FF_DATA_DIR 让冒烟脚本之类的一次性起服别写到玩家的局外档案里去
const dataDir = process.env.FF_DATA_DIR || join(fileURLToPath(new URL('..', import.meta.url)), '.data');
// §126：调试钩子（`?wave=`）默认关；冒烟起服时用 FF_DEBUG_HOOKS=1 打开
const game = createGameServer({ dataDir, debugHooks: process.env.FF_DEBUG_HOOKS === '1' });
const actual = await game.listen(port);
console.log(`冰封之地联机服务器：http://localhost:${actual}/`);
console.log(`局外档案：${join(dataDir, 'profiles.json')}（已加载 ${game.profiles.size} 份）`);
console.log('玩法：浏览器打开上面地址 → 大厅「创建房间」得到房间码 → 好友用 ?room=码 进入');
