// 新手引导（§14.3 稿 11）：同一局游戏上叠一层提示，不是单独的模式。
// 验收口径来自 §1.8：首次到建起第一座塔 ≤90 秒、到打赢第一波 ≤3 分钟。

export const TUTORIAL_STEPS = [
  {
    id: 'build_first',
    text: '点亮的塔位可以建塔 —— 点一个，选「箭塔」',
    hintSlots: 3,
  },
  {
    id: 'build_more',
    text: '再建 2 座箭塔，然后点右下「提前开波」马上开打',
    hintSlots: 5,
  },
  {
    id: 'use_skill',
    text: '塔会自动攻击。怪多了就按左下角的「旋风斩」清场',
    hintSlots: 0,
  },
  {
    id: 'clean_wave',
    text: '撑住这一波！打完就出师了',
    hintSlots: 0,
  },
];

/** 引导状态机：外部只要喂「发生了什么」，它负责推进与给出当前提示。 */
export function createTutorial({ startedAt = 0, enabled = true } = {}) {
  const marks = { startedAt, firstTowerAt: null, firstWaveAt: null, firstWaveClearedAt: null, doneAt: null };
  let step = 0;
  let skipped = false;
  let towersBuilt = 0;
  let skillsCast = 0;
  let lastWave = 0;

  const current = () => (enabled && !skipped && step < TUTORIAL_STEPS.length ? TUTORIAL_STEPS[step] : null);

  return {
    get enabled() { return enabled && !skipped; },
    get skipped() { return skipped; },
    get done() { return step >= TUTORIAL_STEPS.length; },
    get step() { return step; },
    get marks() { return { ...marks }; },
    current,
    hintSlotCount: () => current()?.hintSlots ?? 0,

    onTowerBuilt(now) {
      if (!this.enabled || this.done) return;
      towersBuilt += 1;
      marks.firstTowerAt ??= now;
      if (TUTORIAL_STEPS[step].id === 'build_first' && towersBuilt >= 1) step += 1;
      // 第二步的推进条件是「开波」而不是「建满 3 座」：开波是玩家必须主动做的动作，
      // 建塔数量只是建议；否则玩家建完 3 座却不开波时，提示会跳到下一句而对不上当前场景。
    },

    onWaveStarted(waveIndex, now) {
      if (!this.enabled || this.done) return;
      lastWave = waveIndex;
      if (waveIndex >= 1) {
        marks.firstWaveAt ??= now;
        if (TUTORIAL_STEPS[step].id === 'build_more') step += 1;
      }
    },

    onSkillCast() {
      if (!this.enabled || this.done) return;
      skillsCast += 1;
      if (TUTORIAL_STEPS[step].id === 'use_skill') step += 1;
    },

    onWaveCleared(waveIndex, now) {
      if (!this.enabled || skipped) return;
      if (waveIndex >= 1) {
        marks.firstWaveClearedAt ??= now;
        if (TUTORIAL_STEPS[step].id === 'clean_wave') { step = TUTORIAL_STEPS.length; marks.doneAt = now; }
      }
    },

    skip() { skipped = true; },

    /** 给 UI/存档看的摘要：含两条验收指标。 */
    summary() {
      const m = this.marks;
      return {
        done: this.done | 0,
        skipped,
        towersBuilt,
        skillsCast,
        secondsToFirstTower: m.firstTowerAt == null ? null : +(m.firstTowerAt - m.startedAt).toFixed(1),
        secondsToWaveStart: m.firstWaveAt == null ? null : +(m.firstWaveAt - m.startedAt).toFixed(1),
        secondsToWaveCleared: m.firstWaveClearedAt == null ? null : +(m.firstWaveClearedAt - m.startedAt).toFixed(1),
      };
    },
  };
}

/** 验收判定：首次建塔 ≤90 秒、打赢第一波 ≤180 秒（§1.8）。 */
export function tutorialPasses(summary) {
  return {
    firstTowerOk: summary.secondsToFirstTower != null && summary.secondsToFirstTower <= 90,
    firstWaveOk: summary.secondsToWaveCleared != null && summary.secondsToWaveCleared <= 180,
  };
}
