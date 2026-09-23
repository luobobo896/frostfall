// 权威房间：服务端跑同一份 match.js 内核，客户端只发指令（§10.3）。
// 指令校验一律走 match.js 的函数（它们本身就带资源与状态检查），不在这里重复实现规则。

import {
  buildTower, buyItem, castSkill, craftEquipment, reviveNow, sellTower, setPriority,
  startWaveEarly, update, upgradeTower, usePotion, towerAtSlot, repairTower,
  enhanceItem, equipItem, sellItem, applyPlayerScale,
} from '../match.js';
import { createMatch } from '../match.js';
import { MAX_COMMANDS_PER_SEC, makeRoomCode, SNAPSHOT_RATE, TICK_RATE, snapshot, msg } from '../protocol.js';
import { createDefenseSnapshotter, createSnapshotter, privateSnapshot } from '../protocol.js';
import { buildFort, createDefenseMatch, orderMove, repairCastle, teleportHome, updateDefense } from '../defense.js';
import { resultSummary } from '../result.js';
import { addLog } from '../defense.js';

/**
 * §1.5 / §102：房间的配置（模式 / 地图 / 难度）。跟着 `hello` 下发，客户端据此对齐自己的镜像——
 * 客户端镜像本来是按「上次配置」建的，与房间不一致时第一份快照就会抛异常。
 */
const roomConfig = (m) => ({
  mode: m.mode === 'defense' ? 'defense' : 'td', mapId: m.mapId, difficulty: m.difficulty,
  // §163：**`length` 也要给**。它决定用哪张波次表（12 波 / 长局 30 波），以前 `hello.config` 只有
  // 模式+地图+难度，于是加入者按自己的「上次配置」建镜像：房里是 30 波，他的 HUD 一直写「第 N / 12 波」，
  // 「下一波预告」从第 13 波起直接空（`wavePreview` 拿短表查不到 → null → 标签写「—」，
  // §6.2 要靠它看护甲类型决定补哪种塔）。
  length: m.mode === 'defense' ? undefined : (m.length ?? 'short'),
  // §166：**英雄职业也要给**。M0.5 是一房一个英雄（服务端的 `m.hero`），而加入者的镜像按**自己**
  // 大厅里选的职业建：他点进一间房主的战士房，技能栏却写着「暴风雪 / 奥术冲击」（自己选的法师），
  // 血量/射程/天赋那一栏也全是别人的数。修法同 §163：配置带上，客户端按它对齐。
  heroId: m.hero?.def?.id ?? null,
});

/**
 * §148：只在 TD 局里成立的指令。防守局的 `match` 没有 `m.map.slots`（建塔）也没有 `m.wave`
 * （波次），这些函数跑下去只会抛 TypeError——以前是靠 `handleMessage` 的 try/catch 兜成
 * 「服务器处理不了」，现在在模式边界上直接拒（返回 false → 客户端收到「指令被拒绝」）。
 * 反过来的那些（`cast` / `buy` / `potion` / `craft` / `equip` / `enhance` / `sellitem` / `revive`）
 * 两个模式都成立，**不要**加进这张表。
 */
const TD_ONLY_COMMANDS = new Set(['build', 'upgrade', 'sell', 'priority', 'early', 'repairTower']);

export class Room {
  constructor({ mapId, difficulty, heroId, seed, mode = 'td', length = 'short', maxPlayers = 4, onEmpty, profiles = null } = {}) {
    this.code = makeRoomCode();
    this.maxPlayers = maxPlayers;
    this.onEmpty = onEmpty;
    this.profiles = profiles;      // 服务端档案库（按 uid 记账）
    this.resultRecorded = false;
    this.mode = mode;
    this.match = mode === 'defense'
      ? createDefenseMatch({ mapId: mapId?.startsWith('def_') ? mapId : 'def_01', difficulty, heroId, seed, players: maxPlayers })
      : createMatch({ mapId, difficulty, heroId, seed, players: maxPlayers, length });
    this.match.players = maxPlayers;
    this.players = new Map();       // uid → { id, name, socket, cmdCount, windowStart }
    this.seq = 0;
    this.rev = 0;
    this.snapshotter = mode === 'defense' ? createDefenseSnapshotter() : createSnapshotter();
    this.lastEvents = 0;
    this.privateEvery = 5;   // 私人数据（背包/装备）2Hz 就够，省带宽
    this.snapCount = 0;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.tick(), 1000 / TICK_RATE);
    this.lastSnapshotAt = 0;
  }

  get playerList() {
    // 必须带 slot：客户端面板是按座号排的（有人掉线/离开时数组下标对不上座号，
    // 少了这个字段就会把别人的名字和颜色画到错的位置，也会把自己标成「不是自己」）
    // §125：**不带 uid**。uid 就是这一版的身份凭证（§8.2「uid 才是身份」，登录要等 M3 的 wx.login），
    // 而这份名单是广播给全房的——以前把每个人的 uid 一起发出去，房间里任何人都能拿它重连，
    // 顶掉原主人并占掉他的座位与个人资源（验证记录 §125 实测：受害者那条连接当场被服务器关掉）。
    // 客户端渲染只需要 name / slot / online（自己在名单里是谁，按 slot 认，见 hud-model.playerPanel）。
    return [...this.players.values()].map((p) => ({ name: p.name, slot: p.slot, online: !!p.socket }));
  }

  /** 满员（快速匹配靠它判断「不用再等人了」） */
  isFull() {
    return this.players.size >= this.maxPlayers;
  }

  /**
   * §12.3 的中途加入窗口：TD「波次 ≤ 3」、防守「≤ 3 分钟」。
   * 过了窗口就拒绝**新玩家**（否则会被丢进一场已经打到第 12 波的局：0 金币、0 塔、只能看着核心掉）。
   * 注意只管新面孔——**同一个 uid 断线回来不受限制**（§10.3 的 5 分钟重连窗口）。
   */
  canJoinNow() {
    const m = this.match;
    if (m.mode === 'defense') return m.time <= 180;
    return (m.wave?.index ?? 0) <= 3;
  }

  /**
   * §1.5 / §1.6：房间是按**人数上限**建的，但「人数不足要按 §1.6 缩放」——
   * 所以在第一波出怪之前，按真实名册重算一次；出怪之后就固定下来，免得半局换难度。
   */
  syncPlayerScale() {
    const m = this.match;
    if (m.wave && (m.wave.index > 0 || m.wave.phase !== 'prep')) return m.scale;
    const n = Math.max(1, this.players.size);
    if (m.scalePlayers === n) return m.scale;
    m.scalePlayers = n;
    return applyPlayerScale(m, n);
  }

  join(socket, name = '玩家') {
    return this.#join(socket, name, null);
  }

  /** uid 相同视为同一玩家（刷新 / 断线重连，§10.3 的 5 分钟保留窗口）。 */
  joinAs(socket, name, uid) {
    return this.#join(socket, name, uid);
  }

  #join(socket, name, uid) {
    const existing = uid ? this.players.get(uid) : null;
    // 重连：沿用原来的玩家位与资源。**旧连接不一定已经关了**——页面跳转/切网时
    // FIN 可能还没到（半开口连接），这时如果只认「socket 已空」的重连，玩家会拿到
    // 一个「房间已满」，5 分钟重连窗口形同虚设。所以这里让新连接直接接管这一席。
    if (existing) {
      const stale = existing.socket;
      if (stale && stale !== socket) this.closeStale(existing, stale);
      existing.socket = socket;
      existing.absentSince = null;
      existing.cmdCount = 0;
      existing.windowStart = Date.now();
      this.syncPlayerScale();   // §1.5：名册没变也要保证开局前对齐过一次
      socket.on('message', (text) => this.handleMessage(existing, text));
      // 只认「当前这条连接」的关闭事件：被顶掉的旧连接关闭时不该把玩家判成掉线
      socket.on('close', () => this.leave(existing.id, socket));
      const shared = this.snapshotter(this.match, { full: true });
      // 重连也要带房间配置：客户端可能刚因为「配置不一致」重载过，第二次握手拿不到配置就无从校验
      socket.send(JSON.stringify(msg.hello(this.code, existing.id, this.players.size, shared,
        privateSnapshot(this.match, existing.slot), existing.slot, null, roomConfig(this.match))));
      // 自己也要收到一份名单：否则新进来的人只知道自己，玩家面板上其他人全是「空位」
      // （原来的广播把自己排除了，只有别人进出时才补得上）
      socket.send(JSON.stringify(msg.joined(existing.id, this.playerList)));
      this.broadcast(msg.joined(existing.id, this.playerList), existing.id);
      return existing;
    }
    if (this.players.size >= this.maxPlayers) return null;
    if (!this.canJoinNow()) return null;   // §12.3：开了局就只收「回来的人」，不收新面孔
    const slot = this.nextSlot();
    const id = uid ?? `p${slot}`;
    if (this.players.has(id)) return null;
    const player = { id, slot, name, socket, cmdCount: 0, windowStart: Date.now(), absentSince: null };
    this.players.set(id, player);
    this.syncPlayerScale();   // §1.5：开局前按真实人数缩放（房间是按人数上限建的）
    socket.on('message', (text) => this.handleMessage(player, text));
    socket.on('close', () => this.leave(id, socket));
    // 房主的人物等级决定共享池的起始金币（§3.6）：房间刚建、还没花过钱时才补
    // 注意顺序：加成要在「生成 hello 快照」之前生效，否则客户端看到的是旧金币
    if (this.profiles && !this.hostBonusApplied) {
      this.hostBonusApplied = true;
      const bonus = this.profiles.startGoldFor(id) - 200;
      if (bonus > 0) {
        this.match.gold += bonus;
        addLog(this.match, `房主人等级加成：初始金币 +${bonus}`);
      }
      // §3.6 的另一半便利：复活加速也按房主的人物等级（与初始金币同一条口径）
      this.match.reviveMul = this.profiles.reviveMulFor(id);
    }
    const shared = this.snapshotter(this.match, { full: true });
    socket.send(JSON.stringify(msg.hello(
      this.code, id, this.players.size, shared, privateSnapshot(this.match, slot), slot,
      this.profiles ? this.profiles.get(id) : null,
      // §1.5：房间配置以服务端为准（进房的人可能上一局打的是另一个模式）
      roomConfig(this.match),
    )));
    socket.send(JSON.stringify(msg.joined(id, this.playerList)));
    this.broadcast(msg.joined(id, this.playerList), id);
    return player;
  }

  /** 资源槽位（0-3）：与 uid 解耦，木材等按槽位记账。 */
  nextSlot() {
    const used = new Set([...this.players.values()].map((p) => p.slot));
    for (let i = 0; i < this.maxPlayers; i++) if (!used.has(i)) return i;
    return this.players.size;
  }

  leave(id, socket = null) {
    const p = this.players.get(id);
    if (!p) return;
    // 同一个人可能有多条连接（旧连接半开口时新连接接管了这一席）：
    // 只有「当前这条连接」的关闭才算掉线，否则刚接管进来的人会被自己顶掉的旧连接判掉线
    if (socket && p.socket && p.socket !== socket) return;
    p.socket = null;                    // 保留玩家位与资源：5 分钟内用同一 uid 可回到原位
    p.absentSince = Date.now();
    this.broadcast(msg.left(id, this.playerList));
    this.sweep();
  }

  /**
   * STATUS §3.1 #23（已拍板）：**主动退房 ≠ 掉线**。
   * 客户端的「回大厅 / 再开一局」会先发一条 `leave` 再关连接（见 `net.js` 的 `leave()`），
   * 这条把它**自己**那个座位立刻释放：名册短一位、`isFull()` 立刻放行下一位朋友、
   * 第一波出怪前的怪量缩放按真实名册重算。掉线（socket 自己断的）走的还是 `leave()`：
   * 座位保留 5 分钟等重连（§10.3）——两条路不能混。
   */
  leaveSelf(id) {
    if (!this.players.delete(id)) return false;
    this.broadcast(msg.left(id, this.playerList));
    this.sweep();          // 名册空了就回收房间（sweep 里判 size === 0）
    return true;
  }

  /** 顶掉同一个人残留的旧连接（半开口/页面跳转时 FIN 还没到）。 */
  closeStale(player, stale) {
    try {
      stale.close?.();
    } catch { /* 旧连接已经坏了就算了：下面直接用新连接接管 */ }
  }

  /** 清理超时未归的玩家；全员离场且超过保留窗口才回收房间。 */
  sweep(now = Date.now()) {
    for (const [id, p] of [...this.players.entries()]) {
      if (p.socket) continue;
      if (now - p.absentSince > Room.emptyGraceMs) this.players.delete(id);
    }
    if (this.players.size === 0) this.stop();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.onEmpty?.(this.code);
  }

  broadcast(message, exceptId = null) {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    for (const p of this.players.values()) if (p.id !== exceptId && p.socket) p.socket.send(text);
  }

  /** 指令限速：1 秒窗口内最多 MAX_COMMANDS_PER_SEC 条（§12.7 反作弊的同类约束）。 */
  allow(player) {
    const now = Date.now();
    if (now - player.windowStart > 1000) { player.windowStart = now; player.cmdCount = 0; }
    player.cmdCount += 1;
    return player.cmdCount <= MAX_COMMANDS_PER_SEC;
  }

  handleMessage(player, text) {
    let message;
    try { message = JSON.parse(text); } catch { player.socket.send(JSON.stringify(msg.error('无法解析的消息'))); return; }
    if (!this.allow(player)) { player.socket.send(JSON.stringify(msg.error('操作过于频繁', 'rate_limited'))); return; }
    // §123：指令处理里抛异常**不许带走整个进程**——`{t:'build',slot:'abc'}` 曾经就是这么把服务器
    // 弄死的（字符串和数字比大小永远为 false，两道范围检查形同虚设 → `slots['abc']` 是 undefined
    // → 读 `cell.x` 抛 TypeError，而这里没人接）。内核那一层已经补了整数检查，这里是兜底。
    let ok = false;
    try {
      ok = this.applyCommand(player.id, message, player.slot);
    } catch (err) {
      console.error(`[room ${this.code}] 指令 ${JSON.stringify(message)} 处理失败：`, err);
      player.socket.send(JSON.stringify(msg.error('这条指令服务器处理不了（已忽略）', 'bad_command')));
      return;
    }
    if (!ok) player.socket.send(JSON.stringify(msg.error(`指令被拒绝: ${message.t}`)));
    else if (message.t !== 'ping' && message.t !== 'leave') {
      // 指令成功 → 立刻推一份「全量共享 + 私人数据」回去：
      // 既让操作零延迟可见，也避免增量标记被这一条消息吃掉（塔的 tw 是「变化时才有」的）
      // 注意：只读心跳（ping）不能触发这条，否则「ping → 快照 → ping」会自激
      player.socket.send(JSON.stringify(msg.snap(
        this.snapshotter(this.match, { full: true, peek: true }),
        privateSnapshot(this.match, player.slot),
      )));
      this.flushEvents();
    }
  }

  /** 唯一的写入口。所有校验都在 match.js 里，返回 false 表示没有改变任何状态。 */
  applyCommand(playerId, cmd, playerSlot = 0) {
    const m = this.match;
    if (m.result && cmd.t !== 'ping') return false;
    /**
     * §148：**TD 专属指令在防守局里直接拒**。这些函数读的是 TD 才有的状态
     * （`m.map.slots` / `m.wave`），防守局的 `match` 里根本没有这两个字段——
     * 让它们跑下去只会抛 TypeError，再由 `handleMessage` 的 try/catch 兜成一句含糊的
     * 「这条指令服务器处理不了（已忽略）」（§123 的兜底是给**畸形参数**用的，不是给模式边界用的）。
     */
    if (m.mode === 'defense' && TD_ONLY_COMMANDS.has(cmd.t)) return false;
    switch (cmd.t) {
      case 'build': return buildTower(m, cmd.slot, cmd.towerId, playerSlot ?? 0);
      case 'upgrade': return upgradeTower(m, cmd.slot);
      case 'sell': return sellTower(m, cmd.slot);
      case 'priority': return setPriority(m, cmd.slot, cmd.priority);
      case 'cast': return castSkill(m, cmd.index);
      // 木材是按玩家记账的个人资源（§1.2）：花钱的指令都要带上发起人的槽位
      case 'buy': return buyItem(m, cmd.itemId, playerSlot ?? 0);
      case 'potion': return usePotion(m, cmd.itemId);
      case 'craft': return craftEquipment(m, cmd.slot, cmd.quality);
      // §5.4：装备的穿戴 / 强化 / 出售——强化花的是共享金币，出售返还的木材记在发起人名下
      case 'equip': return equipItem(m, cmd.uid);
      case 'enhance': return enhanceItem(m, cmd.uid);
      case 'sellitem': return sellItem(m, cmd.uid, playerSlot ?? 0);
      case 'early': return startWaveEarly(m, playerSlot ?? 0);
      case 'revive': return reviveNow(m, playerSlot ?? 0);
      // 只读心跳：不改变状态，但仍受频率限制（原来这里还有个 'price' 查询，全项目没有任何发送方，已删）
      case 'ping': return true;
      // §3.1 #23：主动退房（客户端点「回大厅 / 再开一局」）——只释放自己那一席，不是掉线
      case 'leave': return this.leaveSelf(playerId);
      // §10.3：客户端发现序号跳跃 → 要一份全量快照。handleMessage 对成功指令本来就会回
      // 「全量共享 + 私人数据」，所以这里只要返回 true 就够了（peek 不算新序号，客户端序号对齐）
      case 'resync': return true;
      // 防守模式专用指令（TD 局里这些会被对应的函数直接拒掉）
      case 'move': return m.mode === 'defense' ? orderMove(m, { x: cmd.x, y: cmd.y }) : false;
      case 'fort': return m.mode === 'defense' ? buildFort(m, cmd.slot, cmd.fortId) : false;
      case 'repair': return m.mode === 'defense' ? repairCastle(m) : false;
      case 'teleport': return m.mode === 'defense' ? teleportHome(m) : false;
      // §148：这里原来写的是 `m.mode === 'td'`——**TD 局的 `m.mode` 是 `undefined`**（只有防守局写
      // `'defense'`，全项目都按「不是防守」判定），于是这一格永远返回 false：**联机的「修塔」从来
      // 没生效过**（5★/6★ 攻城图里点了只会弹「金币不足或无需修复」）。现在由上面那条模式守卫负责
      // 拦住防守局，这里不再自己判一次。
      case 'repairTower': return repairTower(m, cmd.slot);
      default: return false;
    }
  }

  tick() {
    // §1.5 快速匹配：攒人窗口里不推进对局（否则 45 秒等待会白吃第 1 波的备战时间）
    if (this.queued) return;
    // §121：这一局里的异常**不许带走整个进程**。内核抛错时 `setInterval` 里的未捕获异常会让
    // node 直接退出——线上表现是「所有人的房间一起掉」。这里兜住：告诉房里的人这局坏了，停表退房。
    // （触发过一次真实事故：`?difficulty=bogus` 的房建得出来，30 秒后第一只怪出生读 `m.diff.hp` 才炸。）
    try {
      if (this.match.mode === 'defense') updateDefense(this.match, 1 / TICK_RATE);
      else update(this.match, 1 / TICK_RATE);
    } catch (err) {
      for (const p of this.players.values()) {
        if (!p.socket) continue;
        try { p.socket.send(JSON.stringify(msg.error('这局出了点问题，请回大厅重开一局', 'room_error'))); } catch { /* 连接已经坏了 */ }
      }
      console.error(`[room ${this.code}] 内核异常，已停这一局：`, err);
      this.stop();
      return;
    }
    this.rev += 1;
    this.recordResultIfFinished();
    if (this.rev % (TICK_RATE * 5) === 0) this.sweep();   // 每 5 秒清一次超时未归的玩家
    const now = Date.now();
    if (now - this.lastSnapshotAt >= 1000 / SNAPSHOT_RATE) {
      this.lastSnapshotAt = now;
      this.snapCount += 1;
      const shared = this.snapshotter(this.match);
      const withPrivate = this.snapCount % this.privateEvery === 0;
      for (const p of this.players.values()) {
        if (!p.socket) continue;   // 掉线中的玩家位保留，但不发消息
        p.socket.send(JSON.stringify(msg.snap(shared, withPrivate ? privateSnapshot(this.match, p.slot) : undefined)));
      }
      this.flushEvents();
    }
  }

  /** 一局结束：服务端给每位参战者记账（声望 / 人物等级 / 每图战绩），并推回客户端。 */
  recordResultIfFinished() {
    if (this.resultRecorded || !this.match.result || !this.profiles) return;
    this.resultRecorded = true;
    const summary = resultSummary(this.match);
    // §149：伤害占比是**服务端才有的账本**（客户端是纯镜像，`stats.damage` 永远是空的）。
    // 结算面板要画那几条占比条，所以随「结算推送」一次性发过去（§130 的声望/等级走的是同一条消息）。
    const extra = { damage: { ...this.match.stats.damage } };
    let gain = 0;
    for (const p of this.players.values()) {
      const r = this.profiles.applyResult(p.id, summary);
      gain = r.gain;
      if (p.socket) p.socket.send(JSON.stringify(msg.profile(r.profile, r.gain, r.leveledUp, extra)));
    }
    addLog(this.match, `${this.match.result === 'win' ? '通关' : '失败'}结算：每人声望 +${gain}`);
  }

  /** 事件只在有新内容时单独发（放进 10Hz 快照里纯属浪费带宽）。 */
  flushEvents() {
    const fresh = this.match.events.slice(this.lastEvents);
    if (!fresh.length) return;
    this.lastEvents = this.match.events.length;
    this.broadcast(msg.events(fresh));
  }

  /** 房间态保留窗口：断线重连用（§10.3 的 5 分钟）。这里先给出可判断的状态。 */
  static get emptyGraceMs() { return 5 * 60 * 1000; }

  info() {
    return {
      code: this.code, players: this.playerList.length,
      online: [...this.players.values()].filter((p) => p.socket).length,
      maxPlayers: this.maxPlayers,
      mode: this.mode, mapId: this.match.mapId, difficulty: this.match.difficulty,
      // 两种模式的状态口径不同：TD 看波次，防守看轮次
      wave: this.mode === 'defense' ? this.match.assault.round : this.match.wave.index,
      result: this.match.result,
      castleHp: this.mode === 'defense' ? Math.round(this.match.castle.hp) : undefined,
    };
  }
}

export class RoomRegistry {
  constructor() {
    this.rooms = new Map();
  }

  create(opts = {}) {
    const room = new Room({ ...opts, onEmpty: (code) => this.retire(code, room) });
    this.rooms.set(room.code, room);
    return room;
  }

  /**
   * §199：房间空了（或这一局坏了）就从注册表里摘掉。
   *
   * 以前这里还会把它塞进第二张表 `stopped`（注释写的是「用于同码重连」）——可那张表**只写不读**：
   * `get()` 只看 `rooms`，`until` 字段从头到尾没人读，也没有任何地方按它清理。
   * 于是服务器跑得越久攒得越多，每间退役的房都带着自己那份 `match`（塔、怪、掉落、事件…）常驻内存。
   * 「同码回来」这件事本来就不是靠它：断线重连按 **uid** 回**还活着**的房间位（§10.3 的 5 分钟窗口），
   * 码对不上就是 §102 的「另起一间」。所以这张表直接删掉，retire 只剩一个动作：摘掉。
   */
  retire(code, room) {
    this.rooms.delete(code);
    void room;   // 房间自己已经在 `stop()` 里停表了；这里只需要把它从注册表摘掉
  }

  get(code) {
    return this.rooms.get(code) ?? null;
  }

  closeAll() {
    for (const room of this.rooms.values()) room.stop();
    this.rooms.clear();
  }
}
