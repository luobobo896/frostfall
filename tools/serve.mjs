// 零依赖静态服务器：本地打开原型用。用法 node tools/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// 注意：file URL 的 pathname 是百分号编码的，路径含中文时必须用 fileURLToPath
const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] ?? 8788);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
/**
 * §186：**按需 gzip 文本资源**。首屏预算是 §10.7 那条「低端 4G ≤ 3 秒」，而这一包是 20 个模块 +
 * 样式 + HTML（约 388 KB 未压缩）：1.6 Mbps 的链路上光传输就要 1.9 秒，再叠上模块图那几跳 RTT，
 * 实测 **3.25 秒**（超线）。文本压缩率约 3-4 倍，压完实测 1.5 秒出头（验证记录 §186）。
 * 只压文本类型、只在客户端说要 gzip 时压——图片/音频压了反而更大。
 */
const TEXTY = /^(text\/|application\/(javascript|json))/;
const maybeGzip = (req, res, body, type) => {
  if (!/\bgzip\b/.test(req.headers['accept-encoding'] ?? '') || body.length < 1024 || !TEXTY.test(type)) return false;
  const gz = gzipSync(body);
  res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip', 'content-length': gz.length, vary: 'accept-encoding' });
  res.end(gz);
  return true;
};

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let filePath = join(root, normalize(urlPath === '/' ? '/index.html' : urlPath));
    if (!filePath.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
    const info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) filePath = join(filePath, 'index.html');
    const body = await readFile(filePath);
    const type = TYPES[extname(filePath)] ?? 'application/octet-stream';
    if (maybeGzip(req, res, body, type)) return;   // 压了就它自己收尾
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}).listen(port, () => console.log(`冰封之地原型：http://localhost:${port}/`));
