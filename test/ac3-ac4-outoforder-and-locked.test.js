// 验收 3：乱序旧婉拒不回滚后来的确认
// 验收 4：锁定席宾客婉拒只进入待处理，席位不动
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, cleanup, seedBasics, imp, freshStore, app } from './helpers.js';

describe('AC3 乱序旧事件只留痕、不覆盖较新状态', () => {
  let home;
  beforeEach(() => {
    home = makeHome();
    seedBasics(home);
  });
  afterEach(() => cleanup(home));

  test('先到确认（9/22），后到更旧的婉拒（9/10）：仍为确认，旧婉拒标 superseded', () => {
    imp(home, 'family_zhang', 'G001,confirmed,2026-09-22T10:00:00Z,1,2,确认\n');
    // 后来补录一张更旧的离线表
    imp(home, 'family_zhang', 'G001,declined,2026-09-10T08:00:00Z,2,1,旧婉拒\n');

    const store = freshStore(home);
    assert.equal(store.events.length, 2, '两条事件都留痕');
    const g = app.refresh(store).guests.find((x) => x.guestId === 'G001');
    assert.equal(g.currentStatus, 'confirmed', '当前仍是较新的确认');
    assert.equal(g.currentEventId, store.events[0].eventId);

    const byOccur = Object.fromEntries(g.history.map((h) => [h.occurredAt, h]));
    const older = byOccur['2026-09-10T08:00:00.000Z'] || g.history.find((h) => h.status === 'declined');
    const newer = g.history.find((h) => h.status === 'confirmed');
    assert.equal(older.effect, 'superseded', '旧婉拒仅留痕（superseded）');
    assert.equal(newer.effect, 'applied', '新确认生效');
    assert.equal(older.late, true, '旧婉拒被标记为迟到');
  });

  test('真实乱序：9/10婉拒先导入，9/22确认后导入（正常顺序）也保持确认', () => {
    imp(home, 'family_li', 'G002,declined,2026-09-10T08:00:00Z,1,1,\n');
    imp(home, 'family_li', 'G002,confirmed,2026-09-22T10:00:00Z,2,2,改主意\n');
    const store = freshStore(home);
    const g = app.refresh(store).guests.find((x) => x.guestId === 'G002');
    assert.equal(g.currentStatus, 'confirmed');
  });

  test('物化与导入顺序无关：交换两个文件的导入顺序结果一致', () => {
    // 路径 A：先新后旧
    const a = makeHome();
    seedBasics(a);
    imp(a, 'family_zhang', 'G001,confirmed,2026-09-22T10:00:00Z,1,2,\n');
    imp(a, 'family_zhang', 'G001,declined,2026-09-10T08:00:00Z,2,1,\n');
    const ga = app.refresh(freshStore(a)).guests.find((x) => x.guestId === 'G001');

    // 路径 B：先旧后新
    const b = makeHome();
    seedBasics(b);
    imp(b, 'family_zhang', 'G001,declined,2026-09-10T08:00:00Z,1,1,\n');
    imp(b, 'family_zhang', 'G001,confirmed,2026-09-22T10:00:00Z,2,2,\n');
    const gb = app.refresh(freshStore(b)).guests.find((x) => x.guestId === 'G001');

    assert.equal(ga.currentStatus, gb.currentStatus);
    assert.equal(ga.currentStatus, 'confirmed');
    assert.equal(ga.history.length, gb.history.length);
    cleanup(a);
    cleanup(b);
  });
});

describe('AC4 锁定席宾客婉拒：只进待处理，席位不被系统移动', () => {
  let home;
  beforeEach(() => {
    home = makeHome();
    seedBasics(home);
  });
  afterEach(() => cleanup(home));

  test('锁定席 + 婉拒：席位原封不动，出现在 review 与 impact.lockedDeclined', () => {
    imp(home, 'family_zhang', 'G001,confirmed,2026-09-20T10:00:00Z,1,1,\n');
    let store = freshStore(home);
    app.seatApplyProposal(store);
    app.seatLock(store, { guestId: 'G001', reason: '主桌固定' });
    const before = store.seating.assignments.find((x) => x.guestId === 'G001');
    assert.deepEqual(
      { tableId: before.tableId, seatNumber: before.seatNumber, locked: before.locked },
      { tableId: 'T1', seatNumber: 1, locked: true },
    );

    // 之后婉拒
    imp(home, 'family_zhang', 'G001,declined,2026-09-23T09:00:00Z,2,1,生病\n');
    store = freshStore(home);

    // 系统不移动：席位仍在、仍锁定
    const after = store.seating.assignments.find((x) => x.guestId === 'G001');
    assert.ok(after, '席位仍然存在');
    assert.equal(after.tableId, 'T1');
    assert.equal(after.seatNumber, 1);
    assert.equal(after.locked, true);

    // 进入待处理
    const rq = app.reviewQueue(store);
    assert.ok(rq.seatingReviews.some((r) => r.type === 'locked_seat_declined' && r.guestId === 'G001'));

    const imp2 = app.impact(store);
    assert.ok(imp2.lockedDeclined.some((e) => e.guestId === 'G001'));
    assert.ok(imp2.seatedDeclined.some((e) => e.guestId === 'G001'));

    // 自动候选不会把锁定席宾客当作未排座；也不会动任何席位
    const prop = app.seatProposal(store);
    assert.ok(!prop.proposals.some((p) => p.guestId === 'G001'));
    assert.equal(store.seating.assignments.length, 1);

    // 系统级释放应被拒绝（必须先人工解锁）
    assert.throws(() => app.seatRelease(store, { guestId: 'G001', reason: 'test' }), /锁定/);
  });

  test('非锁定席婉拒也只给清单：不自动释放，必须人工显式 release', () => {
    imp(home, 'family_zhang', 'G002,confirmed,2026-09-20T10:00:00Z,1,1,\n');
    let store = freshStore(home);
    app.seatApplyProposal(store);
    assert.equal(store.seating.assignments.length, 1);
    imp(home, 'family_zhang', 'G002,declined,2026-09-23T09:00:00Z,2,1,\n');
    store = freshStore(home);
    assert.equal(store.seating.assignments.length, 1, '婉拒不会自动释放席位');
    const res = app.seatRelease(store, { guestId: 'G002', reason: '人工确认释放' });
    assert.equal(res.removed.guestId, 'G002');
    assert.equal(store.seating.assignments.length, 0);
  });
});
