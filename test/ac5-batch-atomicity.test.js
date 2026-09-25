// 验收 5：未知宾客或非法顺序的整批导入失败，且原项目（事件/席位/桌卡）不受影响
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeHome, cleanup, seedBasics, imp, impRaw, freshStore, app, csvFile } from './helpers.js';
import { importCsvFile } from '../src/domain/import.js';

describe('AC5 非法整批导入必须原子失败，原数据不受影响', () => {
  let home;
  beforeEach(() => {
    home = makeHome();
    seedBasics(home);
  });
  afterEach(() => cleanup(home));

  test('未知宾客：整批拒绝，账本不变', () => {
    const before = freshStore(home);
    const eventCountBefore = before.events.length;

    const r = impRaw(
      home,
      'family_zhang',
      'G001,confirmed,2026-09-20T10:00:00Z,1,1,\n' +
        'G999,confirmed,2026-09-20T10:05:00Z,2,1,不在名录\n',
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /未知宾客/.test(e.message)));

    const after = freshStore(home);
    assert.equal(after.events.length, eventCountBefore, '事件数不变');
    // 同批中合法的那一行也没有被写入（原子性）
    assert.ok(!after.events.some((e) => e.guestId === 'G001'), '合法行不允许部分写入');
  });

  test('非法序号（跳号）：整批拒绝', () => {
    const r = impRaw(
      home,
      'family_li',
      'G001,confirmed,2026-09-20T10:00:00Z,1,1,\n' +
        'G002,confirmed,2026-09-20T10:05:00Z,3,1,跳到3\n',
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /非法顺序/.test(e.message)));
    assert.equal(freshStore(home).events.length, 0);
  });

  test('批内行序颠倒但序号集合完整连续：接受（顺序无关）；非正整数拒绝', () => {
    const r1 = impRaw(
      home,
      'family_li',
      'G002,confirmed,2026-09-20T10:05:00Z,2,1,\n' +
        'G001,confirmed,2026-09-20T10:00:00Z,1,1,\n',
    );
    // 排序后为连续 1,2，无空洞、无改写 -> 可接受（物化本身与顺序无关）
    assert.equal(r1.ok, true);
    assert.equal(r1.appended, 2);

    const r2 = impRaw(home, 'family_zhang', 'G001,confirmed,2026-09-20T10:00:00Z,0,1,\n');
    assert.equal(r2.ok, false);
    assert.ok(r2.errors.some((e) => /seq 必须/.test(e.message)));

    const r3 = impRaw(home, 'family_wang', 'G001,confirmed,2026-09-20T10:00:00Z,abc,1,\n');
    assert.equal(r3.ok, false);
  });

  test('已有历史时再补录：不允许回填空洞序号；拒绝后游标不前进', () => {
    assert.equal(imp(home, 'family_zhang', 'G001,confirmed,2026-09-20T10:00:00Z,1,1,\n').ok, true);
    assert.equal(imp(home, 'family_zhang', 'G002,confirmed,2026-09-20T10:05:00Z,2,1,\n').ok, true);
    // 试图再发 seq=2（不同负载）——同序号不同内容，拒绝
    const rDiff = impRaw(home, 'family_zhang', 'G003,declined,2026-09-21T00:00:00Z,2,1,\n');
    assert.equal(rDiff.ok, false);
    assert.ok(rDiff.errors.some((e) => /已存在但负载不同/.test(e.message)));
    // 试图发 seq=4（跳过 3）——拒绝
    const rHole = impRaw(home, 'family_zhang', 'G003,confirmed,2026-09-21T00:00:00Z,4,1,\n');
    assert.equal(rHole.ok, false);
    // 正常补 seq=3 仍可成功（游标未被失败批次污染）
    const rOk = impRaw(home, 'family_zhang', 'G003,confirmed,2026-09-21T00:00:00Z,3,1,\n');
    assert.equal(rOk.ok, true);
  });

  test('非法状态 / 非法时间 / 缺列：整批拒绝', () => {
    const r1 = impRaw(home, 'family_zhang', 'G001,maybe-later,2026-09-20T10:00:00Z,1,1,\n');
    assert.equal(r1.ok, false);
    const r2 = impRaw(home, 'family_zhang', 'G001,confirmed,not-a-time,1,1,\n');
    assert.equal(r2.ok, false);
    const r3 = impRaw(home, 'family_zhang', 'G001,confirmed,,1,1,\n');
    assert.equal(r3.ok, false);
    assert.equal(freshStore(home).events.length, 0);
  });

  test('失败批次不影响既有席位与桌卡（seating revision 不变、桌卡仍在）', () => {
    imp(home, 'family_zhang', 'G001,confirmed,2026-09-20T10:00:00Z,1,1,\n');
    let store = freshStore(home);
    app.seatApplyProposal(store);
    app.seatLock(store, { guestId: 'G001', reason: '固定' });
    const seatsBefore = JSON.stringify(store.seating);
    const tablesBefore = JSON.stringify(store.tables);

    // 整批非法
    const r = impRaw(
      home,
      'family_li',
      'G002,confirmed,2026-09-20T10:00:00Z,1,1,\n' +
        'G999,confirmed,2026-09-20T10:05:00Z,2,1,\n',
    );
    assert.equal(r.ok, false);

    store = freshStore(home);
    assert.equal(JSON.stringify(store.seating), seatsBefore, '席位（含锁定）未变化');
    assert.equal(JSON.stringify(store.tables), tablesBefore, '桌卡未变化');
    assert.equal(store.seating.assignments[0].guestId, 'G001');
    assert.equal(store.seating.assignments[0].locked, true);
  });

  test('保留来源名 manual 不可用于外部导入', () => {
    const r = impRaw(home, 'manual', 'G001,confirmed,2026-09-20T10:00:00Z,1,1,\n');
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /保留/.test(e.message)));
  });

  test('坏表头（缺必填列）直接拒绝', () => {
    csvFile(home, 'bad.csv', 'guestId,status,seq\nG001,confirmed,1\n');
    const store = freshStore(home);
    const r = importCsvFile(store, { file: join(home, 'bad.csv'), source: 'family_zhang' });
    assert.equal(r.ok, false);
    assert.ok(r.errors[0].message.includes('occurredAt'));
  });
});
