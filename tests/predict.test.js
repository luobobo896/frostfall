// 客户端预测（§10.3：仅放塔）——纯逻辑比较容易出错的地方。
import test from 'node:test';
import assert from 'node:assert/strict';

import { PENDING_TTL_MS, pendingBuild, reconcilePending, rejectLastPending } from '../src/predict.js';

test('点了就出现：预测项记下来，同一塔位重复点只保留最新一条', () => {
  let list = pendingBuild([], 3, 'tw_arrow', 1000);
  assert.deepEqual(list, [{ slot: 3, towerId: 'tw_arrow', at: 1000 }]);
  list = pendingBuild(list, 3, 'tw_cannon', 1100);
  assert.equal(list.length, 1, '同一塔位不该堆两条鬼影');
  assert.equal(list[0].towerId, 'tw_cannon');
  list = pendingBuild(list, 4, 'tw_frost', 1200);
  assert.equal(list.length, 2);
});

test('服务端确认：该塔位出现真实塔后预测项消失（不回滚、不重复画）', () => {
  const list = pendingBuild(pendingBuild([], 1, 'tw_arrow', 0), 2, 'tw_arrow', 0);
  const afterSnap = reconcilePending(list, [{ slot: 1, towerId: 'tw_arrow' }], 300);
  assert.deepEqual(afterSnap.map((p) => p.slot), [2], '只有确认过的那条被移除');
});

test('超时清除：服务端迟迟不认（丢包/被拒但没回错误）也不会留永久鬼影', () => {
  const list = pendingBuild([], 5, 'tw_static', 0);
  assert.equal(reconcilePending(list, [], PENDING_TTL_MS - 1).length, 1, 'TTL 内保留');
  assert.equal(reconcilePending(list, [], PENDING_TTL_MS + 1).length, 0, '超过 TTL 清掉');
});

test('被拒撤回：撤掉最近一条预测并报告给 UI 提示', () => {
  const list = pendingBuild(pendingBuild([], 7, 'tw_arrow', 0), 8, 'tw_cannon', 0);
  const { list: after, rejected } = rejectLastPending(list);
  assert.equal(rejected.slot, 8);
  assert.deepEqual(after.map((p) => p.slot), [7]);
  assert.deepEqual(rejectLastPending([]), { list: [], rejected: null }, '空列表不该炸');
});
