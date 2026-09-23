// 极简 RFC6455 服务端：只实现本作需要的部分（文本帧 + ping/pong + close），零依赖。
// 参考 RFC6455 §4（握手）、§5（帧格式）。不支持扩展、不做分片续传（消息都很小）。

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64');

export function upgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '', '',
  ].join('\r\n'));
  return wrapSocket(socket);
}

/** 把裸 socket 包装成「按消息收发」的接口。 */
function wrapSocket(socket) {
  const handlers = { message: [], close: [] };
  let buffer = Buffer.alloc(0);
  let closed = false;

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = readFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.consumed);
      if (frame.opcode === 0x8) { close(); return; }
      if (frame.opcode === 0x9) { socket.write(frameBytes(frame.payload, 0xA)); continue; }
      if (frame.opcode === 0x1) handlers.message.forEach((h) => h(frame.payload.toString('utf8')));
    }
  });
  socket.on('error', () => close());
  socket.on('close', () => close());
  socket.on('end', () => close());

  function close() {
    if (closed) return;
    closed = true;
    try { socket.write(frameBytes(Buffer.alloc(0), 0x8)); } catch { /* 已断开 */ }
    socket.end();
    handlers.close.forEach((h) => h());
  }

  return {
    send(text) { if (!closed) socket.write(frameBytes(Buffer.from(text, 'utf8'), 0x1)); },
    ping() { if (!closed) socket.write(frameBytes(Buffer.alloc(0), 0x9)); },
    close,
    on(event, fn) { handlers[event]?.push(fn); },
    get closed() { return closed; },
    raw: socket,
  };
}

/** 解析一个帧；数据不足返回 null。客户端→服务端必须带掩码（RFC6455 §5.1）。 */
function readFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > 1_000_000n) throw new Error('帧过大');
    len = Number(big); offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  const mask = masked ? buf.subarray(offset, offset + 4) : null;
  const start = offset + maskLen;
  const payload = Buffer.from(buf.subarray(start, start + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  if (!fin) throw new Error('不支持分片帧');
  return { opcode, payload, consumed: start + len };
}

/** 组帧：服务端发出的帧不加掩码。 */
export function frameBytes(payload, opcode = 0x1) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/** 客户端组帧（带掩码），测试与 node 侧客户端用。 */
export function clientFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  header[0] = 0x81;
  return Buffer.concat([header, mask, masked]);
}
