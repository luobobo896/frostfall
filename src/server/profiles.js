// 服务端局外档案（按 uid 记账）。目前是进程内存态——正式形态应放 Redis/DB（§10.2）。
// 规则复用客户端同款纯函数 recordResult（声望、人物等级、每图战绩），避免两端各算一套。

import { emptyProfile, recordResult, reviveMulOf, startGoldOf } from '../profile.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class ProfileStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file] 落盘路径；给了就自动读写（原子写：先写临时文件再 rename，避免半截 JSON）
   * @param {number} [opts.flushMs] 合并写入的间隔（默认 1 秒），避免每次声望变化都摸磁盘
   */
  constructor({ file = null, flushMs = 1000 } = {}) {
    this.map = new Map();   // uid → profile（字段与客户端档案同构，便于互通）
    this.file = file;
    this.flushMs = flushMs;
    this.dirty = false;
    this.timer = null;
    if (this.file) this.load();
  }

  get(uid) {
    if (!this.map.has(uid)) this.map.set(uid, emptyProfile());
    return this.map.get(uid);
  }

  /** 一局结束：给参战玩家记账，返回每人的变化（用于结算提示）。 */
  applyResult(uid, summary) {
    const before = this.get(uid);
    const r = recordResult(before, summary);
    this.map.set(uid, r.profile);
    this.markDirty();
    return { profile: r.profile, gain: r.gain, leveledUp: r.leveledUp };
  }

  /** 初始金币加成（§3.6）：房主的人物等级决定共享池的起始金币。 */
  startGoldFor(uid) {
    return startGoldOf(this.get(uid));
  }

  /** 复活加速（§3.6）：同样是房主的人物等级说了算（与初始金币同一条口径）。 */
  reviveMulFor(uid) {
    return reviveMulOf(this.get(uid));
  }

  get size() { return this.map.size; }

  clear() { this.map.clear(); this.markDirty(); }

  /* ---------- 落盘 ---------- */

  markDirty() {
    if (!this.file) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
    this.timer.unref?.();   // 别因为这个定时器卡住进程退出
  }

  /** 立刻写盘（关服、测试里用）。 */
  flush() {
    if (!this.file || !this.dirty) return false;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: Date.now(), profiles: [...this.map] }, null, 0));
      renameSync(tmp, this.file);
      return true;
    } catch {
      this.dirty = true;   // 写失败就留着，下次再试（别把内存里的档案也丢了）
      return false;
    }
  }

  load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (raw?.v !== 1 || !Array.isArray(raw.profiles)) return false;
      this.map = new Map(raw.profiles);
      return true;
    } catch {
      return false;   // 文件不存在或损坏：空档案起步，不能因此拒绝启动
    }
  }
}
