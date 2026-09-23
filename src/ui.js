// HUD：把 match 的状态画到 DOM，把点击翻译成 match 的动作。
// 布局按横屏 1334×750 的浮层方案（§14.1.1 / §14.3 第 4 稿）。

import {
  DEFENSE_RULES, EQUIP_SELL_BONUS_LUMBER, EQUIP_SELL_REFUND, EQUIP_SLOTS, QUALITY, QUALITY_ORDER, SHOP_ITEMS,
  TARGET_PRIORITIES, TOWERS, WAVES, WEAPONS,
} from './data.js';
import {
  craftableSlots, enhanceCostOf, heroMaxHp, shopPriceOf, skillLevel, TOWER_REPAIR_GOLD, towerStats, upgradeCost,
} from './match.js';
import { qualityColor, towerName } from './render.js';
import { attackHint, heroCard, heroCards, isLowHp, playerPanel, resultPanelModel, shopRows, wavePreview, zoneLabel } from './hud-model.js';
import { zoneAt } from './defense.js';

const $ = (id) => document.getElementById(id);
const PRIORITY_LABEL = { front: '最靠前', strongest: '最强', weakest: '最弱', air_first: '空中优先' };
/**
 * §122：凡是**别人能控制的字符串**（玩家的名字来自服务器广播，而名字来自别人的 URL），
 * 插进 `innerHTML` 之前必须转义——否则一个玩家用 `?name=<img src=x onerror=…)` 进房，
 * 就能在**其他所有玩家**的页面里执行脚本（实测过：`window.__xss` 真的被置 1）。
 * 内部数据（塔名 / 怪名 / 技能名）不需要转义，但转一下也不贵——这里只用于跨界字符串。
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createUI(handlers) {
  const el = {
    waveLabel: $('waveLabel'), phaseLabel: $('phaseLabel'), waveTimer: $('waveTimer'),
    coreLabel: $('coreLabel'), coreBar: $('coreBar'),
    goldLabel: $('goldLabel'), lumberLabel: $('lumberLabel'), rateLabel: $('rateLabel'), leakLabel: $('leakLabel'),
    heroName: $('heroName'), heroLevel: $('heroLevel'), heroHpBar: $('heroHpBar'),
    heroExpLabel: $('heroExpLabel'), heroState: $('heroState'),
    skillRow: $('skillRow'), toast: $('toast'), log: $('log'),
    wheel: $('wheel'),
    towerPanel: $('towerPanel'), twName: $('twName'), twLevel: $('twLevel'), twStats: $('twStats'),
    twPriority: $('twPriority'), prioRow: $('prioRow'), btnUpgrade: $('btnUpgrade'), btnSell: $('btnSell'),
    btnCloseTw: $('btnCloseTw'),
   shopPanel: $('shopPanel'), shopList: $('shopList'),
    shopHint: $('shopHint'),
    bagPanel: $('bagPanel'), equippedList: $('equippedList'), invList: $('invList'),
    btnCraft: $('btnCraft'), craftHint: $('craftHint'), bagBadge: $('bagBadge'),
    overlay: $('overlay'), overTitle: $('overTitle'), overBody: $('overBody'),
    overPanel: $('overPanel'), resultDetail: $('resultDetail'), resultRows: $('resultRows'),
    resultDamage: $('resultDamage'), resultLoot: $('resultLoot'), btnLobby: $('btnLobby'),
    btnResume: $('btnResume'), btnRestart: $('btnRestart'), btnEndless: $('btnEndless'),
    btnEarly: $('btnEarly'), btnShop: $('btnShop'), btnBag: $('btnBag'),
    btnSpeed: $('btnSpeed'), btnPause: $('btnPause'),
    btnSettings: $('btnSettings'), settingsPanel: $('settingsPanel'),
    setZoom: $('setZoom'), setEffects: $('setEffects'), setStick: $('setStick'), setToggles: $('setToggles'),
    btnReplayTutorial: $('btnReplayTutorial'), btnResetSettings: $('btnResetSettings'),
    btnLeaveRoom: $('btnLeaveRoom'), rowLeaveRoom: $('rowLeaveRoom'),
    playerPanel: $('playerPanel'), nextWaveLabel: $('nextWaveLabel'),
    tutorialBar: $('tutorialBar'), tutorialText: $('tutorialText'), btnTutorialSkip: $('btnTutorialSkip'),
    defensePanel: $('defensePanel'), defRound: $('defRound'), defTimer: $('defTimer'),
    defWarnBar: $('defWarnBar'), defCastle: $('defCastle'), defCastleBar: $('defCastleBar'),
    defFortCount: $('defFortCount'), btnRepair: $('btnRepair'),
    btnTeleport: $('btnTeleport'), defTeleportHint: $('defTeleportHint'),
  };

  let toastTimer = null;
  let sellArmed = false;
  let craftArmed = false;   // 合成同样不可逆（§5.4.1）：第一次点只「上膛」，第二次才真合
  let itemSellArmed = null;  // §5.4：出售装备也不可逆（记的是那一件的 uid）
  let openSlot = null;

  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1600);
  }

  function render(m, view) {
    if (m.mode === 'defense') return renderDefense(m, view);
    const w = m.wave;
    el.waveLabel.textContent = `第 ${w.index} / ${(m.waves?.length ?? WAVES.length)} 波`;
    el.phaseLabel.textContent = w.phase === 'prep' ? `准备 ${Math.max(0, w.timer).toFixed(0)}s`
      : w.phase === 'spawning' ? `出怪 ${w.spawned}/${w.total}` : `清场中（剩 ${m.monsters.length}）`;
    el.waveTimer.style.width = `${w.phase === 'prep' ? Math.min(100, (1 - w.timer / 30) * 100) : (w.spawned / Math.max(1, w.total)) * 100}%`;
    el.coreLabel.textContent = `${Math.round(m.core.hp)} / ${m.core.maxHp}`;
    el.coreBar.style.width = `${Math.max(0, m.core.hp / m.core.maxHp) * 100}%`;
    el.goldLabel.textContent = Math.round(m.gold);
    el.lumberLabel.textContent = m.lumber[0];
    el.leakLabel.textContent = `漏怪 ${m.stats.leaks}`;
    el.rateLabel.textContent = `${view?.rate ?? 1}×`;

    const h = m.hero;
    el.heroName.textContent = h.def.name;
    el.heroLevel.textContent = `Lv${h.level}`;
    el.heroHpBar.style.width = `${Math.max(0, Math.min(1, h.hp / heroMaxHp(h))) * 100}%`;
    el.heroHpBar.classList.toggle('low', isLowHp(h.hp, heroMaxHp(h)));   // §3.7 低血提示
    el.heroExpLabel.textContent = `EXP ${Math.round(h.exp)}`;
    el.heroState.textContent = h.dead ? `阵亡 ${Math.ceil(h.reviveTimer)}s` : h.attacking ? '交战中' : '驻守';
    el.btnEarly.disabled = !(w.phase === 'prep' && w.index < (m.waves?.length ?? WAVES.length));
    el.btnPause.textContent = view?.paused ? '继续' : '暂停';
    el.btnSpeed.textContent = `${view?.rate ?? 1}×`;

    const bagCount = Object.values(m.bag).reduce((a, b) => a + b, 0);
    el.bagBadge.textContent = bagCount;
    el.bagBadge.classList.toggle('hidden', bagCount === 0);

    renderSkills(m);
    renderLog(m);
    renderNextWave(m);
    renderPlayers(m, view);
    renderTutorial(m, view);
    if (!el.shopPanel.classList.contains('hidden')) renderShop(m);
    if (!el.bagPanel.classList.contains('hidden')) renderBag(m);
  }

  /** 防守模式 HUD：轮次 / 回防预警 / 城堡血条 / 修城 / 工事数。 */
  function renderDefense(m, view) {
    el.defensePanel.classList.remove('hidden');
    // TD 的波次条 / 下一波预告 / 玩家面板在防守模式没有意义（单人局没有队友面板）
    el.waveLabel.closest('.wave-panel')?.classList.add('hidden');
    el.nextWaveLabel.closest('.hud-next-wave')?.classList.add('hidden');
    if (el.playerPanel) el.playerPanel.classList.add('hidden');
    el.defRound.textContent = String(m.assault.round);
    const t = Math.max(0, Math.round(m.assault.timer));
    el.defTimer.textContent = m.assault.warning
      ? `⚠ ${t}s 后进攻`
      : `下一波 ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    const warnPct = Math.min(100, (1 - m.assault.timer / 180) * 100);
    el.defWarnBar.style.width = `${warnPct}%`;
    el.defCastle.textContent = `${Math.round(m.castle.hp)} / ${m.castle.maxHp}`;
    el.defCastleBar.style.width = `${Math.max(0, (m.castle.hp / m.castle.maxHp) * 100)}%`;
    el.defFortCount.textContent = `工事 ${m.forts.length}/${m.def.fortSlots.length}`;
    el.btnRepair.disabled = m.gold < 200 || m.castle.hp >= m.castle.maxHp;
    // §155：价钱与回血比例都从数据表读（以前 200 与 0.1 是两处字面量，与 DEFENSE_RULES 各写一份）
    el.btnRepair.textContent = `修城 ${DEFENSE_RULES.repairGold} 金（+${Math.round(m.castle.maxHp * DEFENSE_RULES.repairPct)}）`;
    const cd = Math.round(m.hero.teleportCd ?? 0);
    const scrolls = m.scrolls ?? 0;
    // §5.5.1：冷却中只要有回城卷轴，回城就还能按（消耗 1 张）
    el.btnTeleport.disabled = m.hero.dead || (cd > 0 && scrolls === 0);
    el.btnTeleport.textContent = cd > 0
      ? (scrolls > 0 ? `回城 ${cd}s（卷轴 ×${scrolls}）` : `回城 ${cd}s`)
      : (scrolls > 0 ? `回城（卷轴 ×${scrolls}）` : '回城');
    el.defTeleportHint.textContent = m.hero.dead ? '阵亡中'
      : cd > 0 && scrolls > 0 ? '冷却中：点它会消耗 1 张回城卷轴'
        : '点击小地图/按钮回基地（冷却 30s）';

    el.goldLabel.textContent = Math.round(m.gold);
    el.lumberLabel.textContent = m.lumber[0] ?? 0;
    el.leakLabel.textContent = `野外击杀 ${m.stats.fieldKills}`;
    const h = m.hero;
    el.heroName.textContent = h.def.name;
    el.heroLevel.textContent = `Lv${h.level}`;
    el.heroHpBar.style.width = `${Math.max(0, Math.min(1, h.hp / Math.max(1, h.def.hp))) * 100}%`;
    el.heroHpBar.classList.toggle('low', isLowHp(h.hp, Math.max(1, h.def.hp)));   // §3.7 低血提示
    el.heroExpLabel.textContent = `EXP ${Math.round(h.exp)}`;
    // §2.6 / §12.8：人在野外区里就报「区名 + 等级段 + 掉落加成」（这也是 lvMin/lvMax/dropBonus 的读取方），
    // 没进区（基地 / 路上）才回落到移动状态
    const zoneText = zoneLabel(zoneAt(m.def, h.cell));
    el.heroState.textContent = h.dead ? `阵亡 ${Math.ceil(h.reviveTimer)}s`
      : zoneText || (h.moving ? '移动中' : '待命');
    el.btnEarly.disabled = true;
    el.btnEarly.textContent = '点地面移动';
    el.btnPause.textContent = view?.paused ? '继续' : '暂停';
    el.btnSpeed.textContent = `${view?.rate ?? 1}×`;
    renderSkills(m);
    renderLog(m);
    if (!el.bagPanel.classList.contains('hidden')) renderBag(m);
  }

  function renderSkills(m) {
    const h = m.hero;
    const defs = [...h.def.skills, h.def.thirdSkill];
    el.skillRow.innerHTML = '';
    defs.forEach((def, i) => {
      if (!def) return;
      const btn = document.createElement('button');
      btn.className = `skill${h.skillUnlocked[i] ? '' : ' locked'}`;
      const cd = h.skillCd[i] ?? 0;
      // §132：等级走内核那**一个**出口（以前这里是内联的同一套算术，加了书本加成之后两边会打架）
      btn.innerHTML = `<span>${def.name}</span><span class="cd">${cd > 0 ? cd.toFixed(0) + 's' : `Lv${skillLevel(m, def)}`}</span>`;
      btn.disabled = !h.skillUnlocked[i] || cd > 0;
      btn.onclick = () => { if (!handlers.castSkill(i)) toast('技能冷却中或未解锁'); };
      el.skillRow.appendChild(btn);
    });
    const potions = Object.keys(m.bag).filter((k) => m.bag[k] > 0);
    if (potions.length) {
      const btn = document.createElement('button');
      btn.className = 'skill bag';
      const first = potions[0];
      btn.innerHTML = `<span>${SHOP_ITEMS.find((s) => s.id === first)?.name ?? '药品'}</span><span class="cd">×${m.bag[first]}</span>`;
      btn.disabled = Object.entries(m.potionCd ?? {}).every(([, v]) => v > 0);
      btn.onclick = () => { for (const p of potions) if (handlers.usePotion(p)) { toast('已使用药品'); return; } toast('药品冷却中'); };
      el.skillRow.appendChild(btn);
    }
  }

  function renderLog(m) {
    const recent = m.events.slice(-6).reverse();
    // §122 的规矩：「别人能控制的字符串」插进 `innerHTML` 必须先转义。今天的日志文案全是内核/服务端
    // 自己造的（塔名、怪名、轮次…），**没有**携带玩家名字的那一行——但这块面板是**最可能**新增一句
    // 「X 加入了房间 / X 掉线」的地方（§122 那次就是这么中招的：`?name=<img onerror>` 在别人页面上执行）。
    // 所以这里先按规矩过 `esc()`：一行成本，换掉一个随时会踩的坑。
    el.log.innerHTML = recent.map((e) => `<div class="${e.kind === 'warn' ? 'warn' : ''}">${esc(e.text)}</div>`).join('');
  }

  /** 下一波预告（§8.3 UI）：把波次表翻成人话，含空中与 Boss 提示。 */
  function renderNextWave(m) {
    if (!el.nextWaveLabel) return;
    if (handlers.getSettings && !handlers.getSettings().showWavePreview) {
      el.nextWaveLabel.textContent = '（已在设置里关闭）';
      return;
    }
    const p = wavePreview(m.wave.index + 1, 3, m.waves);
    if (!p) { el.nextWaveLabel.textContent = '—'; return; }
    el.nextWaveLabel.textContent = `${p.tag ? `【${p.tag}】` : ''}${p.text}`;
  }

  /** 玩家面板：4 格固定位 + 队伍色 + 掉线状态（联机时才知道谁在）。 */
  function renderPlayers(m, view) {
    if (!el.playerPanel) return;
    const players = view?.net?.players ?? [];
    const localSlot = view?.localSlot ?? 0;
    const panel = playerPanel(players, localSlot);
    if (panel.every((p) => !p.connected) && !players.length) {
      // 单人局：只显示自己，避免空位噪音
      el.playerPanel.innerHTML = `<div class="player-slot"><i class="dot" style="background:${panel[0].color}"></i><span class="who">我（Lv${m.hero.level}）</span></div>`;
      return;
    }
    el.playerPanel.innerHTML = panel.map((p) => `
      <div class="player-slot${p.connected && !p.online ? ' offline' : ''}">
        <i class="dot" style="background:${p.connected ? p.color : '#445'}"></i>
        <span class="who">${p.connected ? `${esc(p.name)}${p.isSelf ? '（我）' : ''}${p.online ? '' : ' 掉线'}` : '空位'}</span>
      </div>`).join('');
  }

  /** 新手引导提示条（§14.3 稿 11）：只在引导进行中显示。 */
  function renderTutorial(m, view) {
    if (!el.tutorialBar) return;
    if (view?.inLobby || m.result) { el.tutorialBar.classList.add('hidden'); return; }
    const tut = view?.tutorial;
    const step = tut?.current?.();
    if (!step) { el.tutorialBar.classList.add('hidden'); return; }
    el.tutorialBar.classList.remove('hidden');
    el.tutorialText.textContent = step.text;
  }

  /* ---------- 建造轮盘（§1.9.1：以触点为中心，最远 60pt，不做拖拽放置） ---------- */

  /**
   * 轮盘原点：贴着触点，但整盘（含上方的「取消」）必须留在屏幕内（§1.9.2 的热区要求）。
   * 之前直接取触点坐标，靠近屏幕上沿的塔位会把自己的选项和「取消」顶到屏幕外——
   * 玩家点了塔位却选不了塔，而且从截图和用例里都看不出来（`element.click()` 不需要可见）。
   */
  function wheelOrigin(p) {
    const SIDE = 108, UP = 148, DOWN = 108;   // 上方要给「取消」留 110 + 半径 30，其余方向是 62 + 按钮半径 38
    return {
      x: Math.min(Math.max(p.x, SIDE), window.innerWidth - SIDE),
      y: Math.min(Math.max(p.y, UP), window.innerHeight - DOWN),
    };
  }

  function openWheel(m, slotIndex, screenPoint) {
    openSlot = slotIndex;
    el.wheel.classList.remove('hidden');
    const o = wheelOrigin(screenPoint);
    el.wheel.style.left = `${o.x}px`;
    el.wheel.style.top = `${o.y}px`;
    el.wheel.innerHTML = '';
    const ids = Object.keys(TOWERS);
    ids.forEach((id, i) => {
      const t = TOWERS[id];
      const a = (Math.PI * 2 * i) / ids.length - Math.PI / 2;
      // §1.9.1：轮盘「4 个塔图标环绕，最远不超过 60 pt」（原来写 62，比文档多 2）
      const radius = 60;
      const btn = document.createElement('button');
      btn.className = `opt${m.gold < t.cost ? ' cant' : ''}`;
      btn.title = attackHint(t.attackType);   // 轮盘只有 60pt，克制说明走标题，不挤版面
      btn.style.left = `${Math.cos(a) * radius}px`;
      btn.style.top = `${Math.sin(a) * radius}px`;
      btn.innerHTML = `<span>${t.name}</span><span class="cost">${t.cost}</span>`;
      btn.onclick = () => {
        const ok = handlers.build(slotIndex, id);
        toast(ok ? `建造 ${t.name}` : (handlers.isOffline?.() ? '掉线中，重连后再试' : '金币不足'));
        closeWheel();
      };
      el.wheel.appendChild(btn);
    });
    const cancel = document.createElement('button');
    cancel.className = 'cancel';
    cancel.textContent = '取消';
    cancel.onclick = closeWheel;
    el.wheel.appendChild(cancel);
  }

  const closeWheel = () => { el.wheel.classList.add('hidden'); el.wheel.innerHTML = ''; openSlot = null; };

  /* ---------- 塔面板（升级 / 出售 / 优先级） ---------- */

  function openTower(m, slotIndex, screenPoint) {
    const t = m.towers.find((x) => x.slot === slotIndex);
    if (!t) return;
    sellArmed = false;
    el.towerPanel.classList.remove('hidden');
    el.towerPanel.style.left = `${Math.min(window.innerWidth - 280, Math.max(12, screenPoint.x - 130))}px`;
    el.towerPanel.style.top = `${Math.min(window.innerHeight - 260, Math.max(90, screenPoint.y - 40))}px`;
    const s = t.stats ?? towerStats(t.towerId, t.level);   // §2.3：面板读塔自己的那份（含地形加成）
    el.twName.textContent = towerName(t.towerId);
    el.twLevel.textContent = `Lv${t.level}`;
    el.twStats.textContent = `伤害 ${s.damage.toFixed(1)} · 攻速 ${s.atkSpeed.toFixed(2)} · 射程 ${s.range.toFixed(1)}`
      + (s.hitsAir ? ' · 对空' : ' · 不对空')
      // §3.8 / §6.2：UI 要给克制提示（数字直接从克制表算，见 hud-model.attackHint）
      + ` · ${attackHint(s.attackType)}`;
    el.twPriority.textContent = PRIORITY_LABEL[t.priority] ?? t.priority;
    const cost = upgradeCost(t.towerId, t.level);
    el.btnUpgrade.textContent = cost == null ? '已满级' : `升级 ${cost} 金`;
    // 5★/6★ 图的塔会被攻城怪拆：补一个「修复」按钮（60 金满血，§7.4）
    const canRepair = !!m.map.def.siege && t.maxHp && t.hp < t.maxHp;
    if (el.btnSell) el.btnSell.textContent = sellArmed ? '确认出售' : '出售';
    if (canRepair && !el.btnRepairTower) {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.id = 'btnRepairTower';
      b.onclick = () => { toast(handlers.repairTower(slotIndex) ? '塔已修复' : '金币不足或无需修复'); };
      el.btnSell?.parentElement?.insertBefore(b, el.btnSell);
      el.btnRepairTower = b;
    }
    if (el.btnRepairTower) {
      el.btnRepairTower.classList.toggle('hidden', !canRepair);
      el.btnRepairTower.textContent = `修塔 ${TOWER_REPAIR_GOLD} 金`;   // §155：与内核同一个常数
    }
    el.btnUpgrade.disabled = cost == null || m.gold < cost;
    el.btnUpgrade.onclick = () => { toast(handlers.upgrade(slotIndex) ? '升级完成' : '金币不足或已满级'); };
    el.btnSell.textContent = sellArmed ? '确认出售' : '出售';
    el.btnSell.onclick = () => {
      if (!sellArmed) { sellArmed = true; el.btnSell.textContent = '确认出售'; return; }
      handlers.sell(slotIndex);
      toast('已出售');
      closeTower();
    };
    el.prioRow.innerHTML = '';
    for (const p of TARGET_PRIORITIES) {
      const b = document.createElement('button');
      b.textContent = PRIORITY_LABEL[p];
      if (t.priority === p) b.classList.add('on');
      b.onclick = () => {
        handlers.setPriority(slotIndex, p);
        // 就地更新面板上的「选中态」与那行文字：塔面板不是每帧重画的，
        // 只发一条 toast 的话，面板会一直显示**旧**优先级（点完「最强」还写着「最靠前」）
        for (const x of el.prioRow.children) x.classList.toggle('on', x === b);
        el.twPriority.textContent = PRIORITY_LABEL[p];
        toast(`优先级：${PRIORITY_LABEL[p]}`);
      };
      el.prioRow.appendChild(b);
    }
    el.btnCloseTw.onclick = closeTower;
  }

  const closeTower = () => el.towerPanel.classList.add('hidden');

  /** 防守模式的工事轮盘（基地工事位）：只有箭塔与围墙两种（§12.5）。 */
  function openFortWheel(m, slotIndex, screenPoint, forts) {
    openSlot = slotIndex;
    el.wheel.classList.remove('hidden');
    const o = wheelOrigin(screenPoint);
    el.wheel.style.left = `${o.x}px`;
    el.wheel.style.top = `${o.y}px`;
    el.wheel.innerHTML = '';
    const ids = Object.keys(forts);
    ids.forEach((id, i) => {
      const f = forts[id];
      const a = (Math.PI * 2 * i) / ids.length - Math.PI / 2;
      const btn = document.createElement('button');
      btn.className = `opt${m.gold < f.cost ? ' cant' : ''}`;
      btn.style.left = `${Math.cos(a) * 62}px`;
      btn.style.top = `${Math.sin(a) * 62}px`;
      btn.innerHTML = `<span>${f.name}</span><span class="cost">${f.cost}</span>`;
      btn.onclick = () => {
        const ok = handlers.buildFort(slotIndex, id);
        toast(ok ? `建造 ${f.name}` : (handlers.isOffline?.() ? '掉线中，重连后再试' : '金币不足'));
        closeWheel();
      };
      el.wheel.appendChild(btn);
    });
    const cancel = document.createElement('button');
    cancel.className = 'cancel';
    cancel.textContent = '取消';
    cancel.onclick = closeWheel;
    el.wheel.appendChild(cancel);
  }

  /* ---------- 商店 ---------- */

  function renderShop(m) {
    el.shopList.innerHTML = '';
    // §5.5：波次进行中下的单要读条 3 秒——读条期间所有购买按钮都禁掉，并把剩余秒数写在提示行
    const cast = m.shopCast;
    if (el.shopHint) {
      el.shopHint.textContent = cast
        ? `补给读条中：${SHOP_ITEMS.find((i) => i.id === cast.itemId)?.name ?? ''} ${Math.max(0, cast.until - m.time).toFixed(1)}s`
        : '同种药品每买一次涨价 20%；药品背包共 3 格。波次进行中补给要读条 3 秒。';
    }
    // 行内容统一由 hud-model.shopRows 算（价格递增、限购、§5.5.3 的「药品共 3 格」都在那边，且有用例）
    for (const r of shopRows(m, (id) => shopPriceOf(m, id))) {
      const item = SHOP_ITEMS.find((i) => i.id === r.id);
      const rowEl = document.createElement('div');
      rowEl.className = 'shop-item';
      rowEl.innerHTML = `<div><div class="name">${r.name}</div><div class="desc">${r.effect}`
        + `${item?.cooldown ? ` · 冷却 ${item.cooldown}s` : ''}${r.limit ? ` · 限 ${r.bought}/${r.limit}` : ''}</div></div>`;
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = r.soldOut ? '已售罄'
        : r.bagFull ? '背包已满'
          : r.blockedReason ? '本模式不卖'
            : r.tooFar ? '回基地再买'
            : cast && cast.itemId === r.id ? '读条中…'
              : `${r.price.gold} 金${r.price.lumber ? ` +${r.price.lumber} 木` : ''}`;
      btn.disabled = r.soldOut || r.bagFull || !!r.blockedReason || r.tooFar || !r.affordable || !!cast;
      btn.onclick = () => {
        toast(handlers.buy(r.id) ? `购买 ${r.name}`
          : r.bagFull ? '药品背包已满（3 格）'
            : r.tooFar ? '商店在基地里：先回基地再买'
            : r.blockedReason ?? '资源不足');
      };
      rowEl.appendChild(btn);
      el.shopList.appendChild(rowEl);
    }
  }

  /* ---------- 背包与合成 ---------- */

  // 装备来自存档 / 服务端快照，都可能带脏数据（§21.1 的「坏档不该把界面带崩」同样适用）。
  // 这里查表全部带兜底：一个未知品质不该让整个背包渲染抛异常，进而把帧循环弄死。
  const qualityName = (q) => QUALITY[q]?.name ?? String(q ?? '?');
  const slotName = (s) => EQUIP_SLOTS[s]?.name ?? String(s ?? '?');

  function renderBag(m) {
    // §4.1：武器要说清是哪一类（它决定攻击档，不是纯数值）
    const wName = (item) => (item?.slot === 'weapon' && item.weaponId ? `·${WEAPONS[item.weaponId]?.name ?? item.weaponId}` : '');
    const fmt = (item) => item
      ? `<span class="${'q-' + item.quality}">${qualityName(item.quality)} ${slotName(item.slot)}${wName(item)} · ilvl ${item.ilvl}${item.plus ? ` <b>+${item.plus}</b>` : ''}</span>`
      : '<span class="muted">空</span>';

    /** §5.4：每件装备三个动作——穿上 / 强化（§4.4 无失败）、出售（不可逆，两步确认） */
    function actionsRow(item, inBag) {
      const row = document.createElement('div');
      row.className = 'item-actions';
      const cost = enhanceCostOf(item);
      if (inBag && handlers.equipItem) {
        const b = document.createElement('button');
        b.className = 'btn small';
        b.dataset.act = 'equip';
        b.textContent = '穿上';
        b.onclick = () => toast(handlers.equipItem(item.uid) ? '已换上' : '换装失败');
        row.appendChild(b);
      }
      const enh = document.createElement('button');
      enh.className = 'btn small';
      enh.dataset.act = 'enhance';
      enh.textContent = cost == null ? '强化满' : `强化 +${(item.plus ?? 0) + 1}（${cost} 金）`;
      enh.disabled = cost == null || m.gold < cost || !handlers.enhanceItem;
      enh.onclick = () => toast(handlers.enhanceItem && handlers.enhanceItem(item.uid)
        ? `强化到 +${(item.plus ?? 0)}`
        : (cost == null ? '已经 +5 封顶' : '金币不足'));
      row.appendChild(enh);
      const refund = Math.floor((item.invested ?? 0) * EQUIP_SELL_REFUND);
      const bonus = QUALITY_ORDER.indexOf(item.quality) >= QUALITY_ORDER.indexOf('purple') ? ` +${EQUIP_SELL_BONUS_LUMBER} 木` : '';
      const sell = document.createElement('button');
      sell.className = `btn small${itemSellArmed === item.uid ? ' danger' : ''}`;
      sell.dataset.act = 'sell';
      sell.textContent = itemSellArmed === item.uid ? '确认出售' : `出售（+${refund} 金${bonus}）`;
      sell.disabled = !handlers.sellItem;
      sell.onclick = () => {
        if (itemSellArmed !== item.uid) { itemSellArmed = item.uid; return; }   // 不可逆操作走两步（§1.9）
        itemSellArmed = null;
        toast(handlers.sellItem(item.uid) ? '已出售' : '出售失败');
      };
      row.appendChild(sell);
      return row;
    }

    el.equippedList.innerHTML = '';
    for (const slot of Object.keys(EQUIP_SLOTS)) {
      const div = document.createElement('div');
      div.className = 'item';
      div.dataset.uid = m.equipped[slot]?.uid ?? '';
      div.innerHTML = `<span>${EQUIP_SLOTS[slot].name}</span>${fmt(m.equipped[slot])}`;
      if (m.equipped[slot]) div.appendChild(actionsRow(m.equipped[slot], false));
      el.equippedList.appendChild(div);
    }

    const craftable = new Set(craftableSlots(m).map((c) => `${c.slot}|${c.quality}`));
    el.invList.innerHTML = '';
    for (const item of m.inventory.slice(-14).reverse()) {
      const div = document.createElement('div');
      div.className = `item${craftable.has(`${item.slot}|${item.quality}`) ? ' craftable' : ''}`;
      div.dataset.uid = item.uid;
      div.innerHTML = `<span class="${'q-' + item.quality}">${qualityName(item.quality)} ${slotName(item.slot)}${wName(item)} ilvl${item.ilvl}${item.plus ? ` <b>+${item.plus}</b>` : ''}</span>
        <span class="muted small">${(item.affixes ?? []).map((a) => a.id).join(' ') || '—'}</span>`;
      div.appendChild(actionsRow(item, true));
      el.invList.appendChild(div);
    }
    if (!m.inventory.length) el.invList.innerHTML = '<div class="item muted">还没有掉落</div>';

    const list = craftableSlots(m);
    el.btnCraft.disabled = list.length === 0;
    el.btnCraft.textContent = craftArmed ? '确认合成？' : '一键合成';
    if (list.length) {
      const c = list[0];
      const nextQ = ['white', 'blue', 'purple', 'orange'][['white', 'blue', 'purple', 'orange'].indexOf(c.quality) + 1];
      el.craftHint.textContent = `可合成：3 件${qualityName(c.quality)}${slotName(c.slot)} → 1 件${qualityName(nextQ)}（共 ${list.length} 组，点击合成第一组）`;
      el.btnCraft.onclick = () => {
        // 合成不可逆（§5.4.1），和出售一样走两步确认
        if (!craftArmed) { craftArmed = true; el.btnCraft.textContent = '确认合成？'; return; }
        craftArmed = false;
        const ok = handlers.craft(c.slot, c.quality);
        toast(ok ? '合成成功' : '合成失败');
      };
    } else {
      craftArmed = false;
      el.craftHint.textContent = '攒够 3 件同部位同品质即可一键合成';
      el.btnCraft.onclick = null;
    }
  }

  /* ---------- 面板开关与结算 ---------- */

  const togglePanel = (panel, show) => panel.classList.toggle('hidden', show === undefined ? !panel.classList.contains('hidden') : !show);

  function showOverlay(m, view) {
    if (view?.inLobby) { el.overlay.classList.add('hidden'); return; }   // 大厅期间不弹暂停/结算
    // §131：防守守住第 4 轮后**转无尽**（§12.5），玩家点过「继续（无尽）」之后这块面板要让开——
    // 不然无尽阶段只能看着面板，打不了。
    if (m.result && view?.resultDismissed && !view.paused) { el.overlay.classList.add('hidden'); return; }
    if (!m.result && !view.paused) { el.overlay.classList.add('hidden'); return; }
    el.overlay.classList.remove('hidden');
    if (!m.result) {
      el.overTitle.textContent = '暂停';
      el.overBody.textContent = '暂停中：塔与波次都已冻结（§1.8 随时能停）';
      el.resultDetail.classList.add('hidden');
      el.btnResume.classList.remove('hidden');
      el.overPanel.classList.remove('result-panel');
      return;
    }
    // 结算面板（§14.3 稿 8）：本局数据 / 伤害占比 / 掉落与合成
    const model = resultPanelModel(m, view.resultExtra ?? {});
    el.overTitle.textContent = model.title;
    el.overBody.textContent = model.reputationGain
      ? `声望 +${model.reputationGain}${model.leveledUp ? ` · 人物等级提升到 ${model.commanderLevel}` : ''}`
      : '';
    el.btnResume.classList.add('hidden');
    el.btnEndless.classList.toggle('hidden', !model.endless);
    el.overPanel.classList.add('result-panel');
    el.resultDetail.classList.remove('hidden');
    el.resultRows.innerHTML = model.rows
      .map((r) => `<div class="kv"><span class="muted">${r.label}</span><b>${r.value}</b></div>`).join('');
    el.resultDamage.innerHTML = model.damage.rows.length
      ? model.damage.rows.map((r) => `
        <div class="dmg-row"><span class="muted">${r.label}</span>
          <span class="bar2"><i style="width:${Math.round(r.pct * 100)}%"></i></span>
          <b>${Math.round(r.pct * 100)}%</b></div>`).join('')
      : '<div class="muted small">本局没有记录到伤害</div>';
    const q = model.loot.byQuality.filter((x) => x.count > 0)
      .map((x) => `<span class="${'q-' + x.quality}">${x.name} ${x.count}</span>`).join(' ');
    el.resultLoot.innerHTML = `
      <div class="loot-line"><span class="muted">掉落</span><b>${model.loot.drops} 件</b>
        <span class="muted">合成</span><b>${model.loot.crafts} 次</b>
        <span class="muted">品质</span><span>${q || '—'}</span></div>
      <div class="loot-line muted small">已装备：${model.loot.equipped.map((e) => `${e.qualityName}${e.slotName} ilvl${e.ilvl}`).join(' · ') || '—'}</div>`;
  }

  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => {
    b.closest('.modal').classList.add('hidden');
  }));
  el.btnShop.onclick = () => togglePanel(el.shopPanel, true);
  el.btnBag.onclick = () => togglePanel(el.bagPanel, true);
  el.btnSettings.onclick = () => { renderSettings(); togglePanel(el.settingsPanel, true); };
  // 防守模式的两个按钮：修城与回城（之前 handlers.repair 写好了但按钮没绑，点了没反应）
  el.btnRepair.onclick = () => {
    const ok = handlers.repair();
    toast(ok ? '城堡已修复' : '金币不足或城堡已满血');
  };
  el.btnTeleport.onclick = () => {
    const ok = handlers.teleport();
    toast(ok ? '已回城' : '冷却中或阵亡中');
  };
  el.btnResume.onclick = () => handlers.resume();
  el.btnEndless.onclick = () => handlers.endless();
  el.btnRestart.onclick = () => handlers.restart();
  el.btnLobby?.addEventListener('click', () => handlers.lobby());

  /** 大厅的英雄卡片（§14.3 稿 3）：点卡片切换，详情区展示技能与天赋。 */
  function renderHeroCards(selected, onPick) {
    const box = $('optHero');
    const detail = $('heroDetail');
    if (!box) return;
    box.innerHTML = '';
    for (const card of heroCards()) {
      const b = document.createElement('button');
      b.className = `hero-card${card.id === selected ? ' on' : ''}`;
      b.innerHTML = `<div class="hname">${card.name}</div><div class="hrole">${card.role}</div>
        <div class="hstat">${card.stats.map((s) => `${s.label} ${s.value}`).join(' · ')}</div>`;
      b.onclick = () => onPick(card.id);
      box.appendChild(b);
    }
    const c = heroCard(selected);
    if (detail && c) {
      detail.innerHTML = `<b>主动技</b>：${c.skills.map((s) => `${s.name}（Lv${s.unlockLevel} · CD ${s.cooldown}s）`).join('，')}`
        + `　<b>天赋</b>：${c.talents.map((t) => `${t.name}（Lv${t.unlockLevel}）`).join('，')}`
        + `<br><b>秘传</b>：${c.secret.name}（Lv${c.secret.unlockLevel}，局内用「${c.secret.via}」解锁）`;
    }
  }

  /** 设置面板（§14.3 稿 9）：改了就立刻生效并存档，玩家不用按「确定」。 */
  function renderSettings() {
    const s = handlers.getSettings();
    // §3.1 #31：联机局才有「离开房间」这个出口；单人局的「回大厅」在暂停面板上（那边一直有）
    el.rowLeaveRoom?.classList.toggle('hidden', handlers.isOnline?.() !== true);
    const opts = (box, items, current, pick) => {
      box.innerHTML = '';
      for (const [value, label] of items) {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = String(value) === String(current) ? 'on' : '';
        b.onclick = () => { pick(value); renderSettings(); };
        box.appendChild(b);
      }
    };
    opts(el.setZoom, [[1.2, '近'], [1.5, '中'], [1.8, '远']], s.zoom, (v) => handlers.updateSetting('zoom', v));
    opts(el.setEffects, [['high', '高'], ['low', '低（省电保帧）']], s.effects, (v) => handlers.updateSetting('effects', v));
    // §1.9.1 / §1.9.3：防守的摇杆固定左下，玩家可切浮动（浮动 = 手指按哪儿底座跟到哪儿）
    // §154：TD 没有摇杆（主操作是点选建造，§1.9.1），这一行在 TD 下要收起来——
    // 以前它照样摆着两个选项，玩家切了「浮动」什么也不会发生。
    const defense = handlers.isDefense?.() === true;
    el.setStick.closest('.start-row')?.classList.toggle('hidden', !defense);
    if (defense) {
      opts(el.setStick, [['fixed', '固定（左下）'], ['floating', '浮动（跟手）']], s.stick, (v) => handlers.updateSetting('stick', v));
    }
    el.setToggles.innerHTML = '';
    // 这一格现在同时管提示音（§2.6）与短震动（§1.9.2），所以标签写全，别让玩家以为关了还震
    // §154：只摆**这个模式真的会读**的那几项——「自动拾取」只有防守有掉落物（`defense.js` 是唯一读取方），
    // 「波次预告」控的是 TD 左上那条「下一波」提示（防守里它整块收起），「TD 整图可见」是 TD 的镜头档。
    const toggles = [
      ...(defense ? [['autoPickup', '自动拾取']] : [['showWavePreview', '波次预告'], ['tdFitAll', 'TD 整图可见']]),
      ['sfx', '音效/震动'],
    ];
    for (const [key, label] of toggles) {
      const b = document.createElement('button');
      b.textContent = `${label}：${s[key] ? '开' : '关'}`;
      b.className = s[key] ? 'on' : '';
      b.onclick = () => { handlers.updateSetting(key, !s[key]); renderSettings(); };
      el.setToggles.appendChild(b);
    }
  }

  el.btnReplayTutorial.onclick = () => { handlers.replayTutorial(); toast('下次开局会重新显示引导'); };
  el.btnResetSettings.onclick = () => { handlers.resetSettings(); renderSettings(); toast('已恢复默认设置'); };
  /**
   * §3.1 #31：联机局中途的出口。
   * 以前中途想退房只能刷新页面（结算面板上的「回大厅」要等这一局结束才出现）——
   * 而这个出口同时还把「主动退房」和「掉线」分开了（§3.1 #23 的 `leave`，座位立刻释放）。
   */
  el.btnLeaveRoom.onclick = () => handlers.lobby();   // 回大厅是整页重载，不用先关面板

  return { render, toast, openWheel, closeWheel, openFortWheel, openTower, closeTower, showOverlay, renderHeroCards, el };
}
