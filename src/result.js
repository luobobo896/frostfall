// 结算数据提取：两种模式的状态口径不同（TD 看核心与漏怪，防守看城堡与挨打次数）。
// 单独成模块是为了能直接测——它挂在每帧的结算钩子上，出错会直接冻住整局。

import { DEFENSE_MAPS, MAPS } from './data.js';

export function resultSummary(m) {
  if (!m?.result) return null;
  if (m.mode === 'defense') {
    return {
      mode: 'defense',
      mapId: m.mapId,
      difficulty: m.difficulty,
      result: m.result,
      timeSec: m.time,
      coreHp: Math.round(m.castle?.hp ?? 0),
      leaks: m.stats?.castleHits ?? 0,   // 防守模式没有「漏怪」，用城堡挨打次数当压力指标
      roundsCleared: m.stats?.roundsCleared ?? 0,
    };
  }
  return {
    mode: 'td',
    mapId: m.mapId,
    difficulty: m.difficulty,
    result: m.result,
    timeSec: m.time,
    coreHp: Math.round(m.core?.hp ?? 0),
    leaks: m.stats?.leaks ?? 0,
  };
}

/** 地图通用查询：两种模式的地图表分开维护，UI 与解锁规则都走这里。 */
export const mapDefOf = (mapId) => MAPS[mapId] ?? DEFENSE_MAPS[mapId] ?? null;
