// §1.5 快速匹配：服务端按「模式 + 地图 + 难度」分流（首发不加段位维度——9 个桶），
// 45 秒未满员即开局，人数不足按 §1.6 缩放。
//
// 为什么需要独立一层：好友房是「知道房间码 → 进房」，快速匹配是「不知道和谁玩 → 排队」。
// 后者需要「先攒人、到点开局」这个节奏，所以排队的房间在窗口关闭前**不推进对局**
// （Room 的 `queued` 开关），否则 45 秒的等待会白吃掉第 1 波的备战时间。

export class MatchQueue {
  /**
   * @param {object} opts
   * @param {number} [opts.windowMs] 攒人窗口（默认 45 秒，§1.5）
   * @param {(room: object) => void} [opts.onStart] 窗口关闭/满员时的回调（用来打日志、做断言）
   */
  constructor({ windowMs = 45000, onStart = null } = {}) {
    this.windowMs = windowMs;
    this.onStart = onStart;
    this.buckets = new Map();   // key → { room, timer, players }
  }

  static keyOf({ mode = 'td', mapId = 'map_01', difficulty = 'normal' }) {
    return `${mode}|${mapId}|${difficulty}`;
  }

  /**
   * 把一个人放进队列。
   * @returns {object|null} 命中的房间（调用方负责 join）；null 表示队列暂时不可用
   */
  enqueue({ mode, mapId, difficulty, createRoom }) {
    const key = MatchQueue.keyOf({ mode, mapId, difficulty });
    let bucket = this.buckets.get(key);
    if (!bucket || !bucket.room || bucket.room.isFull()) {
      const room = createRoom();
      if (!room) return null;
      room.queued = true;   // 攒人期间不推进对局
      bucket = { room, timer: null, players: 0 };
      bucket.timer = setTimeout(() => this.start(key), this.windowMs);
      bucket.timer.unref?.();
      this.buckets.set(key, bucket);
    }
    bucket.players += 1;
    if (bucket.room.isFull()) this.start(key);   // 满员立刻开局，不等窗口
    return bucket.room;
  }

  /** 关窗/满员：开打并清空这个桶 */
  start(key) {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.room.queued = false;
    this.buckets.delete(key);
    this.onStart?.(bucket.room);
    return bucket.room;
  }

  /**
   * 满员就立刻开局。
   * 为什么不在 `enqueue` 里判：座位是在**加入成功之后**才占上的，
   * 最后一个玩家排队时房间还没满——所以要在 join 之后补一次判断。
   */
  startFull() {
    let started = null;
    for (const [key, b] of [...this.buckets]) {
      if (b.room?.isFull()) started = this.start(key) ?? started;
    }
    return started;
  }

  /** 队列现状（调试 / 用例用） */
  info() {
    return [...this.buckets.entries()].map(([key, b]) => ({ key, players: b.players, code: b.room?.code ?? null }));
  }

  clear() {
    for (const [, b] of this.buckets) if (b.timer) clearTimeout(b.timer);
    this.buckets.clear();
  }
}
