// 本地迁移（含旧版扁平表）、导出往返、事件号稳定性。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, cleanup, seedBasics, freshStore, app } from './helpers.js';
import { migrateLegacy, initStore } from '../src/migrate.js';
import { ledgerToCsv, stateToCsv, guestHistoryCsv, fullExport } from '../src/export.js';
import { parseCsv } from '../src/util/csv.js';
import { materialize } from '../src/domain/materializer.js';
import { importCsvFile } from '../src/domain/import.js';

describe('本地迁移', () => {
  let home;
  beforeEach(() => {
    home = makeHome();
    seedBasics(home);
  });
  afterEach(() => cleanup(home));

  test('旧版扁平 CSV 迁移为事件流（来源 legacy），并幂等可重跑', () => {
    const legacy = join(home, 'legacy.csv');
    writeFileSync(
      legacy,
      'guestId,status,occurredAt\n' +
        'G001,confirmed,2026-09-01T08:00:00Z\n' +
        'G002,declined,2026-09-01T09:00:00Z\n',
    );
    const r1 = migrateLegacy(home, legacy);
    assert.equal(r1.migrated, 2);
    let store = freshStore(home);
    assert.equal(store.events.length, 2);
    assert.ok(store.events.every((e) => e.source === 'legacy'));
    assert.deepEqual(store.events.map((e) => e.eventId), ['E000001', 'E000002']);
    const m = materialize(store.roster, store.events);
    assert.equal(m.guests.find((g) => g.guestId === 'G001').currentStatus, 'confirmed');
    assert.equal(m.guests.find((g) => g.guestId === 'G002').currentStatus, 'declined');

    // 再跑一次迁移：幂等跳过
    const r2 = migrateLegacy(home, legacy);
    assert.equal(r2.migrated, 0);
    store = freshStore(home);
    assert.equal(store.events.length, 2);
  });

  test('迁移文件包含未知宾客时整批失败，账本不被污染', () => {
    const legacy = join(home, 'legacy-bad.json');
    writeFileSync(legacy, JSON.stringify([{ guestId: 'G001', status: 'confirmed' }, { guestId: 'GHOST', status: 'declined' }]));
    assert.throws(() => migrateLegacy(home, legacy), /名录外/);
    assert.equal(freshStore(home).events.length, 0);
  });

  test('init 幂等', () => {
    const a = initStore(home);
    assert.equal(a.migrated, false);
  });
});

describe('导出与稳定事件号', () => {
  let home;
  beforeEach(() => {
    home = makeHome();
    seedBasics(home);
  });
  afterEach(() => cleanup(home));

  test('事件号在账本中稳定、唯一、按追加顺序', () => {
    // importCsvFile 顶部导入
    const f1 = join(home, 'a.csv');
    writeFileSync(
      f1,
      'guestId,status,occurredAt,seq,partySize,note\n' +
        'G001,confirmed,2026-09-20T10:00:00Z,1,1,\n' +
        'G002,confirmed,2026-09-20T10:01:00Z,2,1,\n',
    );
    importCsvFile(freshStore(home), { file: f1, source: 'family_zhang' });
    const f2 = join(home, 'b.csv');
    writeFileSync(f2, 'guestId,status,occurredAt,seq,partySize,note\nG003,pending,2026-09-20T11:00:00Z,1,1,\n');
    importCsvFile(freshStore(home), { file: f2, source: 'family_li' });

    const store = freshStore(home);
    assert.deepEqual(store.events.map((e) => e.eventId), ['E000001', 'E000002', 'E000003']);
    assert.equal(new Set(store.events.map((e) => e.eventId)).size, 3);
  });

  test('ledger/state/history CSV 可解析、内容一致', () => {
    // importCsvFile 顶部导入
    const f = join(home, 'a.csv');
    writeFileSync(
      f,
      'guestId,status,occurredAt,seq,partySize,note\n' +
        'G001,confirmed,2026-09-20T10:00:00Z,1,2,夫妻\n' +
        'G001,declined,2026-09-10T10:00:00Z,2,1,旧婉拒\n',
    );
    importCsvFile(freshStore(home), { file: f, source: 'family_zhang' });
    const store = freshStore(home);
    const m = materialize(store.roster, store.events);

    const ledger = parseCsv(ledgerToCsv(store.events));
    assert.equal(ledger.records.length, 2);
    assert.equal(ledger.headers.includes('eventId'), true);

    const state = parseCsv(stateToCsv(m, store.seating));
    const g1 = state.records.find((r) => r.guestId === 'G001');
    assert.equal(g1.currentStatus, 'confirmed');
    assert.equal(g1.currentPartySize, '2');

    const gst = m.guests.find((g) => g.guestId === 'G001');
    const hist = parseCsv(guestHistoryCsv(gst));
    assert.equal(hist.records.length, 2);
    const effects = hist.records.map((r) => r.effect).sort();
    assert.deepEqual(effects, ['applied', 'superseded']);

    const full = fullExport(store);
    assert.ok(Array.isArray(full.events) && full.materialized.stats.totalGuests === 5);
  });

  test('状态别名（中文/英文）归一', () => {
    // importCsvFile 顶部导入
    const f = join(home, 'zh.csv');
    writeFileSync(
      f,
      'guestId,status,occurredAt,seq,partySize,note\n' +
        'G001,确认,2026-09-20T10:00:00Z,1,1,\n' +
        'G002,待定,2026-09-20T10:01:00Z,2,1,\n' +
        'G003,婉拒,2026-09-20T10:02:00Z,3,1,\n',
    );
    const r = importCsvFile(freshStore(home), { file: f, source: 'family_zhang' });
    assert.equal(r.ok, true);
    const m = materialize(freshStore(home).roster, freshStore(home).events);
    assert.equal(m.guests.find((g) => g.guestId === 'G001').currentStatus, 'confirmed');
    assert.equal(m.guests.find((g) => g.guestId === 'G002').currentStatus, 'pending');
    assert.equal(m.guests.find((g) => g.guestId === 'G003').currentStatus, 'declined');
  });
});

