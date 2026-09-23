// 服务端档案落盘：重启不丢进度、原子写、坏文件不阻碍启动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProfileStore } from '../src/server/profiles.js';

const tmpDir = () => mkdtempSync(join(tmpdir(), 'frostfall-prof-'));
const RESULT = { mapId: 'map_01', difficulty: 'normal', result: 'win', timeSec: 480, coreHp: 900, leaks: 2 };

test('落盘：写盘后新建一个 store 能读回同样的档案（模拟服务器重启）', () => {
  const file = join(tmpDir(), 'profiles.json');
  const a = new ProfileStore({ file, flushMs: 5 });
  a.applyResult('u1', RESULT);
  a.applyResult('u1', RESULT);
  a.applyResult('u2', { ...RESULT, mapId: 'map_02' });
  assert.equal(a.flush(), true, 'flush 应真的写了盘');
  assert.ok(existsSync(file));

  const b = new ProfileStore({ file });
  assert.equal(b.size, 2);
  assert.equal(b.get('u1').reputation, 240, '两局普通通关共 240 声望');
  assert.equal(b.get('u1').clears.map_01.wins, 2);
  assert.equal(b.get('u2').clears.map_02.wins, 1);
  assert.ok(b.get('u2').commanderLevel >= 1);
});

test('脏标记：没有变化就不写盘；写盘后 dirty 归位', () => {
  const file = join(tmpDir(), 'profiles.json');
  const s = new ProfileStore({ file, flushMs: 5 });
  assert.equal(s.flush(), false, '刚建、没变化 → 不写');
  s.applyResult('u1', RESULT);
  assert.equal(s.dirty, true);
  assert.equal(s.flush(), true);
  assert.equal(s.dirty, false);
  assert.equal(s.flush(), false, '再写一次没有新变化 → 不写');
});

test('坏文件不阻碍启动：空档案起步，且下次写盘会覆盖它', () => {
  const file = join(tmpDir(), 'profiles.json');
  writeFileSync(file, '{ 这不是 JSON');
  const s = new ProfileStore({ file });
  assert.equal(s.size, 0, '损坏就当空档案');
  s.applyResult('u1', RESULT);
  s.flush();
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.v, 1);
  assert.equal(raw.profiles.length, 1, '写盘应把坏文件覆盖成合法内容');
});

test('不落盘模式（不给 file）仍然可用：测试与临时起服不该写磁盘', () => {
  const s = new ProfileStore();
  s.applyResult('u1', RESULT);
  assert.equal(s.get('u1').reputation, 120);
  assert.equal(s.flush(), false, '没有文件路径时 flush 是空操作');
});

test('原子写：写盘过程中不会留下半截 JSON（临时文件 + rename）', () => {
  const file = join(tmpDir(), 'profiles.json');
  const s = new ProfileStore({ file });
  for (let i = 0; i < 5; i++) s.applyResult(`u${i}`, RESULT);
  s.flush();
  const raw = JSON.parse(readFileSync(file, 'utf8'));   // 能直接解析 = 没有半截
  assert.equal(raw.profiles.length, 5);
  assert.ok(!existsSync(`${file}.tmp`), '临时文件应已被 rename 掉');
});
