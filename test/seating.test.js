// 自动排座边界与约束：只给候选不动席位；锁定席、儿童椅、同桌、避让必须保留。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, cleanup, seedBasics, imp, freshStore, app } from './helpers.js';
import { proposeSeating } from '../src/domain/seating.js';
import { materialize } from '../src/domain/materializer.js';

describe('自动排座输入边界', () => {
  let home;
  beforeEach(() => {
    home = makeHome();
    seedBasics(home);
  });
  afterEach(() => cleanup(home));

  test('非确认 / 冲突 / 已排座 宾客均被排除，并给出分类原因', () => {
    imp(
      home,
      'family_zhang',
      'G001,confirmed,2026-09-20T10:00:00Z,1,1,\n' +
        'G002,pending,2026-09-20T10:01:00Z,2,1,\n' +
        'G003,declined,2026-09-20T10:02:00Z,3,1,\n',
    );
    const store = freshStore(home);
    const prop = app.seatProposal(store);
    assert.equal(prop.willMoveSeats, false);
    assert.equal(prop.requiresApproval, true);
    assert.ok(prop.proposals.some((p) => p.guestId === 'G001'));
    assert.ok(prop.boundary.excluded.notConfirmed.some((x) => x.guestId === 'G002'));
    assert.ok(prop.boundary.excluded.notConfirmed.some((x) => x.guestId === 'G003'));
    assert.equal(prop.proposals.some((p) => ['G002', 'G003'].includes(p.guestId)), false);
  });

  test('儿童椅：候选带 child 标记并按桌汇总', () => {
    imp(home, 'family_zhang', 'G004,confirmed,2026-09-20T10:00:00Z,1,1,儿童\n', 'x');
    const store = freshStore(home);
    const prop = app.seatProposal(store);
    const p = prop.proposals.find((x) => x.guestId === 'G004');
    assert.ok(p);
    assert.equal(p.child, true);
    assert.equal(prop.childChairs[p.tableId], 1);
    app.seatApplyProposal(store);
    const a = store.seating.assignments.find((x) => x.guestId === 'G004');
    assert.equal(a.child, true, '儿童标记随席位物化保留');
  });

  test('同桌关系：组成员整体同桌', () => {
    // 重建带关系的名录
    cleanup(home);
    home = makeHome();
    seedBasics(home, [
      { guestId: 'G001', name: '张三' },
      { guestId: 'G002', name: '李四', sameWith: ['G003'] },
      { guestId: 'G003', name: '王五' },
      { guestId: 'G004', name: '赵六' },
      { guestId: 'G005', name: '钱七' },
    ]);
    imp(
      home,
      'family_zhang',
      'G001,confirmed,2026-09-20T10:00:00Z,1,1,\n' +
        'G002,confirmed,2026-09-20T10:01:00Z,2,1,\n' +
        'G003,confirmed,2026-09-20T10:02:00Z,3,1,\n',
    );
    const store = freshStore(home);
    const prop = app.seatProposal(store);
    const t2 = prop.proposals.find((p) => p.guestId === 'G002').tableId;
    const t3 = prop.proposals.find((p) => p.guestId === 'G003').tableId;
    assert.equal(t2, t3, 'G002/G003 必须同桌');
  });

  test('避让关系：不与避让对象同桌', () => {
    cleanup(home);
    home = makeHome();
    seedBasics(home, [
      { guestId: 'G001', name: '张三' },
      { guestId: 'G002', name: '李四', avoidWith: ['G003'] },
      { guestId: 'G003', name: '王五' },
      { guestId: 'G004', name: '赵六' },
      { guestId: 'G005', name: '钱七' },
    ]);
    imp(
      home,
      'family_zhang',
      'G002,confirmed,2026-09-20T10:01:00Z,1,1,\n' +
        'G003,confirmed,2026-09-20T10:02:00Z,2,1,\n',
    );
    const store = freshStore(home);
    const prop = app.seatProposal(store);
    const t2 = prop.proposals.find((p) => p.guestId === 'G002').tableId;
    const t3 = prop.proposals.find((p) => p.guestId === 'G003').tableId;
    assert.notEqual(t2, t3, '避让双方不得同桌（存在 T1/T2 两张桌时必须分开）');
  });

  test('锁定席/既有席位保留：候选在既有占用之上叠加，不移动任何人', () => {
    imp(
      home,
      'family_zhang',
      'G001,confirmed,2026-09-20T10:00:00Z,1,1,\n' +
        'G002,confirmed,2026-09-20T10:01:00Z,2,1,\n' +
        'G003,confirmed,2026-09-20T10:02:00Z,3,1,\n' +
        'G004,confirmed,2026-09-20T10:03:00Z,4,1,\n',
    );
    let store = freshStore(home);
    app.seatApplyProposal(store);
    // 锁 G001
    app.seatLock(store, { guestId: 'G001', reason: '主桌' });
    const snapshot = JSON.stringify(store.seating.assignments);

    // G005 新确认，新一轮候选/应用
    imp(home, 'family_zhang', 'G005,confirmed,2026-09-21T10:00:00Z,5,1,\n');
    store = freshStore(home);
    const prop = app.seatProposal(store);
    assert.deepEqual(prop.proposals.map((p) => p.guestId), ['G005']);
    app.seatApplyProposal(store);

    const oldFour = JSON.parse(snapshot);
    for (const a of oldFour) {
      const now = store.seating.assignments.find((x) => x.guestId === a.guestId);
      assert.ok(now, `${a.guestId} 仍在席`);
      assert.equal(now.tableId, a.tableId);
      assert.equal(now.seatNumber, a.seatNumber);
    }
    const g1 = store.seating.assignments.find((x) => x.guestId === 'G001');
    assert.equal(g1.locked, true);
  });

  test('同桌组中有人已排座/非确认：整组不自动拆分，列入 unsatisfiable', () => {
    cleanup(home);
    home = makeHome();
    seedBasics(home, [
      { guestId: 'G001', name: '张三' },
      { guestId: 'G002', name: '李四', sameWith: ['G003'] },
      { guestId: 'G003', name: '王五' },
      { guestId: 'G004', name: '赵六' },
      { guestId: 'G005', name: '钱七' },
    ]);
    // G002 先被人工安排入座（当时 G003 尚未回复，自动排座不会拆组）
    imp(home, 'family_zhang', 'G002,confirmed,2026-09-20T10:01:00Z,1,1,\n');
    let store = freshStore(home);
    // 自动排座此时不放置 G002（组友 G003 未确认）
    assert.ok(!app.seatProposal(store).proposals.some((p) => p.guestId === 'G002'));
    app.seatAssign(store, { guestId: 'G002', tableId: 'T1', operator: 'planner' });
    imp(home, 'family_li', 'G003,confirmed,2026-09-21T10:02:00Z,1,1,\n');
    store = freshStore(home);
    const prop = app.seatProposal(store);
    assert.ok(!prop.proposals.some((p) => p.guestId === 'G003'), '不得单独挪动组成员');
    assert.ok(
      prop.unsatisfiable.some(
        (u) => u.type === 'same_group_partly_seated' && u.group.includes('G003'),
      ),
    );
  });

  test('容量不足：超容量组进入 unsatisfiable 而不是强塞', () => {
    cleanup(home);
    home = makeHome();
    // 两张 2 人桌
    seedBasics(
      home,
      [
        { guestId: 'G001', name: '一' },
        { guestId: 'G002', name: '二', sameWith: ['G003'] },
        { guestId: 'G003', name: '三', sameWith: ['G004'] },
        { guestId: 'G004', name: '四' },
      ],
      [
        { tableId: 'T1', name: '小桌1', capacity: 2 },
        { tableId: 'T2', name: '小桌2', capacity: 2 },
      ],
    );
    imp(
      home,
      'family_zhang',
      'G001,confirmed,2026-09-20T10:00:00Z,1,1,\n' +
        'G002,confirmed,2026-09-20T10:01:00Z,2,1,\n' +
        'G003,confirmed,2026-09-20T10:02:00Z,3,1,\n' +
        'G004,confirmed,2026-09-20T10:03:00Z,4,1,\n',
    );
    const store = freshStore(home);
    const prop = app.seatProposal(store);
    assert.ok(
      prop.unsatisfiable.some((u) => u.type === 'no_feasible_table' && u.group.includes('G002')),
      '三人同桌组放不进 2 人桌，应报不可满足',
    );
    // 散客 G001 仍可正常给候选
    assert.ok(prop.proposals.some((p) => p.guestId === 'G001'));
    assert.ok(!prop.proposals.some((p) => ['G002', 'G003', 'G004'].includes(p.guestId)));
  });
});
