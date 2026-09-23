// 客户端预测（§10.3：只预测「放塔」，其余等服务端确认）。
// 逻辑做成纯函数，便于测试；渲染层把 pending 列表当鬼影画。

export const PENDING_TTL_MS = 1500;

/** 玩家点了建造：立刻在本地记一条待确认项（不写进 match，避免污染权威状态）。 */
export function pendingBuild(list, slot, towerId, now) {
  return [...list.filter((p) => p.slot !== slot), { slot, towerId, at: now }];
}

/**
 * 收到快照后对账：
 * - 该塔位已出现真实塔 → 预测命中，移除
 * - 超过 TTL 还没出现 → 移除（别留一个永久鬼影）
 */
export function reconcilePending(list, towers, now, ttl = PENDING_TTL_MS) {
  const occupied = new Set(towers.map((t) => t.slot));
  return list.filter((p) => !occupied.has(p.slot) && now - p.at < ttl);
}

/** 服务端拒绝（余额不足、塔位非法等）：撤掉最近一次预测，并把它报给 UI。 */
export function rejectLastPending(list) {
  if (!list.length) return { list, rejected: null };
  const rejected = list[list.length - 1];
  return { list: list.slice(0, -1), rejected };
}
