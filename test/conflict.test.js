// 跨来源冲突：同刻不同内容必须显式提示、不得按导入顺序静默覆盖；
// 更晚时刻的新事实（含人工 resolution）可解除冲突。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, cleanup, seedBasics, imp, freshStore, app } from './helpers.js';

describe('跨来源冲突检测与人工处理', () => {
  let home;
  beforeEach(() => {
    home = makeHome();
    seedBasics(home);
  });
  afterEach(() => cleanup(home));

  test('两家在同一时刻给出不同状态：进入冲突待处理，当前值暂定，不静默选边', () => {
    // 先有一条较早的确认
    imp(home, 'family_zhang', 'G001,confirmed,2026-09-20T10:00:00Z,1,1,\n');
    // 两家在 9/21 12:00 同刻分别说 婉拒 / 确认
    imp(home, 'family_zhang', 'G001,declined,2026-09-21T12:00:00Z,2,1,\n');
    imp(home, 'family_li', 'G001,confirmed,2026-09-21T12:00:00Z,1,1,\n');

    const store = freshStore(home);
    const m = app.refresh(store);
    const g = m.guests.find((x) => x.guestId === 'G001');
    assert.equal(g.hasConflict, true);
    assert.equal(g.statusProvisional, true);
    assert.equal(g.currentStatus, 'confirmed', '冲突时刻不选边，保留冲突前的已生效值');
    assert.equal(m.reviews.length, 1);
    assert.deepEqual(
      m.reviews[0].events.map((e) => e.source).sort(),
      ['family_li', 'family_zhang'],
    );
  });

  test('冲突结果与导入顺序无关：先李后张同样是冲突', () => {
    imp(home, 'family_li', 'G001,declined,2026-09-21T12:00:00Z,1,1,\n');
    imp(home, 'family_zhang', 'G001,confirmed,2026-09-21T12:00:00Z,1,1,\n');
    const store = freshStore(home);
    const g = app.refresh(store).guests.find((x) => x.guestId === 'G001');
    assert.equal(g.hasConflict, true);
    assert.equal(g.currentStatus, null, '此前无任何已生效值');
    assert.equal(g.contending.length, 2);
  });

  test('同刻但内容一致（跨来源）：无冲突，视为收敛冗余', () => {
    imp(home, 'family_zhang', 'G002,confirmed,2026-09-21T12:00:00Z,1,1,\n');
    imp(home, 'family_li', 'G002,confirmed,2026-09-21T12:00:00Z,1,1,\n');
    const store = freshStore(home);
    const g = app.refresh(store).guests.find((x) => x.guestId === 'G002');
    assert.equal(g.hasConflict, false);
    assert.equal(g.currentStatus, 'confirmed');
    const effects = g.history.map((h) => h.effect).sort();
    assert.ok(effects.includes('applied'));
    assert.ok(effects.includes('convergent'));
  });

  test('冲突之后到达更晚时刻的新事实：冲突自动解除，仅留痕', () => {
    imp(home, 'family_li', 'G001,declined,2026-09-21T12:00:00Z,1,1,\n');
    imp(home, 'family_zhang', 'G001,confirmed,2026-09-21T12:00:00Z,1,1,\n');
    imp(home, 'family_zhang', 'G001,pending,2026-09-22T08:00:00Z,2,1,家属再商量\n');
    const store = freshStore(home);
    const g = app.refresh(store).guests.find((x) => x.guestId === 'G001');
    assert.equal(g.hasConflict, false);
    assert.equal(g.currentStatus, 'pending');
    // 冲突事件仍在历史中留痕
    const conflicted = g.history.filter((h) => h.occurredAt === '2026-09-21T12:00:00.000Z');
    assert.equal(conflicted.length, 2);
    assert.ok(conflicted.every((h) => h.effect === 'superseded'));
  });

  test('人工 resolution 落账解决冲突：可追溯，冲突双方记入审计', () => {
    imp(home, 'family_li', 'G001,declined,2026-09-21T12:00:00Z,1,1,\n');
    imp(home, 'family_zhang', 'G001,confirmed,2026-09-21T12:00:00Z,1,1,\n');
    let store = freshStore(home);
    assert.equal(app.refresh(store).reviews.length, 1);

    const evt = app.resolveConflict(store, {
      guestId: 'G001',
      status: 'confirmed',
      note: '电话核实确认',
      operator: 'planner',
    });
    assert.equal(evt.kind, 'resolution');
    assert.equal(evt.source, 'manual');
    assert.equal(evt.seq, 0);

    store = freshStore(home);
    const g = app.refresh(store).guests.find((x) => x.guestId === 'G001');
    assert.equal(g.hasConflict, false);
    assert.equal(g.currentStatus, 'confirmed');
    assert.equal(g.currentEventId, evt.eventId);

    const audit = store.audit;
    const rec = audit.find((a) => a.action === 'rsvp_conflict_resolved');
    assert.ok(rec);
    assert.equal(rec.contending.length, 2);
  });
});
