// 验收 1：最新确认刷新后仍可进入候选
// 验收 2：重复导入不重复占座
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, cleanup, seedBasics, imp, freshStore, app } from './helpers.js';

describe('AC1 最新确认刷新后仍可进入候选 + AC2 重复导入不重复占座', () => {
  let home;
  beforeEach(() => {
    home = makeHome();
    seedBasics(home);
  });
  afterEach(() => cleanup(home));

  test('导入确认 -> 候选包含该宾客 -> 应用后占一个座；再次候选不再包含', () => {
    const r = imp(
      home,
      'family_zhang',
      'G001,confirmed,2026-09-20T10:00:00Z,1,2,夫妻\n',
    );
    assert.equal(r.ok, true);
    assert.equal(r.appended, 1);

    let store = freshStore(home);
    let m = app.refresh(store);
    let g = m.guests.find((x) => x.guestId === 'G001');
    assert.equal(g.currentStatus, 'confirmed');

    let prop = app.seatProposal(store);
    assert.ok(prop.proposals.some((p) => p.guestId === 'G001'), '确认宾客应进入候选');
    // 应用候选
    const applied = app.seatApplyProposal(store, { operator: 'tester' });
    assert.equal(applied.added.length, 1);
    assert.equal(applied.added[0].guestId, 'G001');

    // 重新打开（模拟刷新），候选不应再包含已占座宾客
    store = freshStore(home);
    prop = app.seatProposal(store);
    assert.ok(!prop.proposals.some((p) => p.guestId === 'G001'), '已排座宾客不再进候选');
    const seats = store.seating.assignments.filter((a) => a.guestId === 'G001');
    assert.equal(seats.length, 1, '只占一个席位');
  });

  test('同一文件/同序号重复导入：幂等跳过，不产生新事件、不重复占座', () => {
    const lines =
      'G001,confirmed,2026-09-20T10:00:00Z,1,2,夫妻\n' +
      'G002,confirmed,2026-09-20T10:01:00Z,2,1,\n';
    const r1 = imp(home, 'family_zhang', lines, 'a');
    const r2 = imp(home, 'family_zhang', lines, 'b');
    assert.equal(r1.ok, true);
    assert.equal(r1.appended, 2);
    assert.equal(r2.ok, true);
    assert.equal(r2.appended, 0, '第二次导入不新增事件');
    assert.equal(r2.duplicates, 2, '两条均识别为幂等重复');

    const store = freshStore(home);
    assert.equal(store.events.length, 2, '账本仍只有 2 条事件');
    const applied = app.seatApplyProposal(store);
    assert.equal(applied.added.length, 2, '两人各占一位');
    assert.equal(store.seating.assignments.length, 2);

    // 再重复导入后重新排座，不会再给 G001/G002 加位
    const r3 = imp(home, 'family_zhang', lines, 'c');
    assert.equal(r3.appended, 0);
    const store2 = freshStore(home);
    const prop = app.seatProposal(store2);
    assert.ok(!prop.proposals.some((p) => ['G001', 'G002'].includes(p.guestId)));
  });

  test('刷新（重新物化）后晚到的新确认仍能进入候选', () => {
    imp(home, 'family_zhang', 'G003,pending,2026-09-18T09:00:00Z,1,1,\n');
    let store = freshStore(home);
    assert.equal(app.seatProposal(store).proposals.length, 0, '待定不进候选');

    imp(home, 'family_zhang', 'G003,confirmed,2026-09-22T09:00:00Z,2,1,改确认\n');
    store = freshStore(home);
    const g = app.refresh(store).guests.find((x) => x.guestId === 'G003');
    assert.equal(g.currentStatus, 'confirmed');
    assert.equal(g.currentEventId, store.events.find((e) => e.seq === 2).eventId);
    const prop = app.seatProposal(store);
    assert.ok(prop.proposals.some((p) => p.guestId === 'G003'), '最新确认后可进候选');
  });
});
