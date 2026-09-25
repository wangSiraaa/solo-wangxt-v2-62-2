import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { emptyStore, saveStore, loadStore, rebuildMaterialized } from '../src/lib/store.js';
import { appendBatch, validateBatch, resolveConflict, guestHistory } from '../src/lib/events.js';
import { autoCandidates, reviewImpact, applyPlan, setLock } from '../src/lib/seating.js';
import { csvToObjects, parseCsv } from '../src/lib/csv.js';
import { normalizeRows, importBatch, exportLedgerCsv, exportStateCsv, BatchRejectedError } from '../src/lib/importexport.js';
import { migrate } from '../src/lib/migrate.js';

let dir;
let storeFile;

function freshStore() {
  const s = emptyStore();
  s.tables = {
    T1: { id: 'T1', name: '主桌', capacity: 10, childCapacity: 2 },
    T2: { id: 'T2', name: '亲友桌', capacity: 8, childCapacity: 4 },
  };
  s.tableOrder = ['T1', 'T2'];
  for (const [id, name, party = 1] of [
    ['G01', '张三', 1], ['G02', '李四', 1], ['G03', '王五', 1], ['G04', '赵六', 1],
    ['G05', '钱七', 1], ['G06', '孙八', 1], ['G07', '周九', 1], ['G08', '吴十', 1],
  ]) {
    s.guests[id] = { id, name, partySize: party, children: 0, childSeatNeeded: false, rsvp: null };
  }
  return s;
}

function row(source, seq, guestId, status, opts = {}) {
  return {
    source, sourceSeq: seq, guestId, status,
    partySize: opts.party ?? (status === 'confirmed' ? (opts.children ? 1 + opts.children : 2) : null),
    children: opts.children ?? 0,
    childSeatNeeded: opts.childSeat ?? !!opts.children,
    occurredAt: opts.at ?? `2026-09-2${opts.day ?? 0}T10:00:0${seq}Z`,
    rawSeq: String(seq), rawGuest: guestId, rawStatus: status,
    rawParty: opts.party === undefined ? '' : String(opts.party),
    rawChildren: String(opts.children ?? 0),
    rawOccurredAt: opts.at ?? '',
  };
}

function csvRows(text, defaultSource) {
  return normalizeRows(csvToObjects(text), { defaultSource });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'rsvp-test-'));
  storeFile = path.join(dir, 'store.json');
});

test('验收1: 最新确认（刷新/重建物化状态）后仍可进入候选', () => {
  let s = freshStore();
  saveStore(storeFile, s);

  // G01 先待定
  appendBatch(s, [row('family-a', 1, 'G01', 'pending', { at: '2026-09-20T08:00:00Z' })]);
  assert.deepEqual(autoCandidates(s).plan, []);

  // 模拟“刷新”：从磁盘重新加载，再补录最新确认
  s = loadStore(storeFile);
  appendBatch(s, [row('family-a', 2, 'G01', 'confirmed', { at: '2026-09-21T08:00:00Z' })]);
  saveStore(storeFile, s);

  // 重新打开页面 = 从磁盘载入
  s = loadStore(storeFile);
  const { plan } = autoCandidates(s);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].guestIds, ['G01']);
  assert.ok(s.assignments.G01 === undefined, '候选阶段不落座');

  // 物化状态可从账本重建，结果一致
  const s2 = loadStore(storeFile);
  rebuildMaterialized(s2);
  assert.equal(autoCandidates(s2).plan.length, 1);
  assert.equal(s2.guests.G01.rsvp.status, 'confirmed');
});

test('验收2: 重复导入幂等——不产生事件、不重复占座', () => {
  let s = freshStore();
  const batch = [
    row('family-a', 1, 'G01', 'confirmed', { at: '2026-09-20T08:00:00Z' }),
    row('family-a', 2, 'G02', 'confirmed', { at: '2026-09-20T08:01:00Z' }),
  ];
  const r1 = importBatch(s, batch, storeFile);
  assert.deepEqual(r1.accepted.length, 2);

  // 同样的 CSV 再导一遍（完全重复）
  const before = JSON.parse(readFileSync(storeFile, 'utf8'));
  const r2 = importBatch(s, batch, storeFile);
  assert.equal(r2.accepted.length, 0);
  assert.equal(r2.duplicates, 2);
  const after = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.equal(after.events.length, before.events.length);
  assert.equal(after.counters.eventNo, before.counters.eventNo);

  // 应用候选一次
  let { plan } = autoCandidates(s);
  assert.equal(plan.length, 2, '两位独立宾客应各有一条候选');
  applyPlan(s, plan);
  saveStore(storeFile, s);
  assert.ok(s.assignments.G01); assert.ok(s.assignments.G02);

  // 再重复导入 + 再生成候选：不会重复占座、不会出现重复候选
  s = loadStore(storeFile);
  const r3 = importBatch(s, batch, storeFile);
  assert.equal(r3.accepted.length, 0);
  assert.equal(autoCandidates(s).plan.length, 0);
  const seats = Object.keys(s.assignments);
  assert.deepEqual(seats.sort(), ['G01', 'G02']);
});

test('验收3: 乱序到达的旧婉拒不回滚后来的确认，只留痕', () => {
  const s = freshStore();
  // 先导入“新”确认（序号大）
  appendBatch(s, [row('family-a', 10, 'G01', 'confirmed', { at: '2026-09-23T09:00:00Z' })]);
  assert.equal(s.guests.G01.rsvp.status, 'confirmed');

  // 晚到的旧婉拒（序号小、发生时间早）
  const r = appendBatch(s, [row('family-a', 3, 'G01', 'declined', { at: '2026-09-18T09:00:00Z' })]);
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0].sourceSeq, 3);

  assert.equal(s.guests.G01.rsvp.status, 'confirmed', '旧婉拒不得覆盖新确认');
  assert.equal(s.guests.G01.rsvp.eventNo, 1);

  const hist = guestHistory(s, 'G01');
  const staleEvt = hist.find((e) => e.sourceSeq === 3);
  assert.equal(staleEvt.stale, true);
  assert.ok(staleEvt.supersededBy, '旧事件必须标记被谁覆盖（留痕）');

  // 顺序反过来导入结果也必须一致（不依赖导入顺序）
  const s2 = freshStore();
  appendBatch(s2, [row('family-a', 3, 'G01', 'declined', { at: '2026-09-18T09:00:00Z' })]);
  appendBatch(s2, [row('family-a', 10, 'G01', 'confirmed', { at: '2026-09-23T09:00:00Z' })]);
  assert.equal(s2.guests.G01.rsvp.status, 'confirmed');
  assert.equal(autoCandidates(s2).plan.length, 1);
});

test('验收4: 锁定席宾客婉拒——只进入待处理，不腾座、不移动、不进候选', () => {
  const s = freshStore();
  appendBatch(s, [row('family-a', 1, 'G01', 'confirmed', { at: '2026-09-20T08:00:00Z' })]);
  const { plan } = autoCandidates(s);
  applyPlan(s, plan);
  setLock(s, 'G01', true);
  saveStore(storeFile, s);
  const seatBefore = { ...s.assignments.G01 };

  // 婉拒（同源更新）
  appendBatch(s, [row('family-a', 2, 'G01', 'declined', { at: '2026-09-22T08:00:00Z' })]);
  saveStore(storeFile, s);

  const review = reviewImpact(s);
  const item = review.affected.find((a) => a.guestId === 'G01');
  assert.ok(item, '必须出现在受影响/待处理清单');
  assert.equal(item.locked, true);
  assert.equal(item.manualOnly, true);
  assert.ok(item.problems.includes('declined'));

  // 席位原封不动
  assert.deepEqual(s.assignments.G01, seatBefore);
  assert.equal(s.assignments.G01.locked, true);
  // 不会有任何针对 G01 的候选；其余宾客候选不得占用锁定席或移动它
  assert.equal(review.plan.some((p) => p.guestIds.includes('G01')), false);

  // 重新载入文件依然保持
  const s2 = loadStore(storeFile);
  assert.deepEqual(s2.assignments.G01, seatBefore);
});

test('验收5a: 未知宾客导致整批导入失败，项目与桌卡完全不变', () => {
  const s = freshStore();
  appendBatch(s, [row('family-a', 1, 'G02', 'confirmed', { at: '2026-09-20T08:00:00Z' })]);
  const { plan } = autoCandidates(s);
  applyPlan(s, plan); // G02 落座
  setLock(s, 'G02', true);
  saveStore(storeFile, s);
  const snapshot = readFileSync(storeFile, 'utf8');

  const bad = [
    row('family-a', 2, 'G02', 'confirmed', { at: '2026-09-21T08:00:00Z' }), // 好行
    row('family-a', 3, 'GHOST', 'confirmed', { at: '2026-09-21T08:01:00Z' }), // 未知宾客
  ];
  const { errors } = validateBatch(s, bad);
  assert.equal(errors.some((e) => e.code === 'UNKNOWN_GUEST'), true);
  assert.throws(() => importBatch(s, bad, storeFile), BatchRejectedError);

  // 文件未变（原子写 + 预检）
  assert.equal(readFileSync(storeFile, 'utf8'), snapshot);
  const s2 = loadStore(storeFile);
  assert.equal(s2.events.length, 1, '好行也不得部分写入');
  assert.ok(s2.assignments.G02?.locked, '锁定桌卡不受影响');
  assert.equal(s2.guests.G02.rsvp.status, 'confirmed');
});

test('验收5b: 非法顺序（同序号不同内容）整批失败且桌卡不变', () => {
  const s = freshStore();
  appendBatch(s, [row('family-a', 5, 'G01', 'confirmed', { at: '2026-09-20T08:00:00Z' })]);
  const { plan } = autoCandidates(s);
  applyPlan(s, plan);
  saveStore(storeFile, s);
  const snapshot = readFileSync(storeFile, 'utf8');

  // 重放冲突：同来源同序号，但内容变成 declined
  const bad = [row('family-a', 5, 'G01', 'declined', { at: '2026-09-20T09:00:00Z' })];
  const { errors } = validateBatch(s, bad);
  assert.equal(errors[0]?.code, 'REPLAY_CONFLICT');
  assert.throws(() => importBatch(s, bad, storeFile), BatchRejectedError);
  assert.equal(readFileSync(storeFile, 'utf8'), snapshot);
  assert.equal(loadStore(storeFile).guests.G01.rsvp.status, 'confirmed');
});

test('跨来源冲突：确定性回退 + 明确待人工处理，且与导入顺序无关', () => {
  const mk = () => {
    const s = freshStore();
    appendBatch(s, [row('family-a', 1, 'G01', 'confirmed', { at: '2026-09-20T08:00:00Z' })]);
    appendBatch(s, [row('family-b', 1, 'G01', 'declined', { at: '2026-09-20T09:00:00Z' })]);
    return s;
  };
  const s1 = mk();

  // 反向导入
  const s2 = freshStore();
  appendBatch(s2, [row('family-b', 1, 'G01', 'declined', { at: '2026-09-20T09:00:00Z' })]);
  appendBatch(s2, [row('family-a', 1, 'G01', 'confirmed', { at: '2026-09-20T08:00:00Z' })]);

  for (const s of [s1, s2]) {
    assert.ok(s.guests.G01.rsvp.conflict, '必须显式标记冲突');
    assert.equal(s.guests.G01.rsvp.conflict.kind, 'cross-source');
    assert.equal(s.guests.G01.rsvp.source, 'family-a', '确定性回退=来源字典序，不依赖导入顺序');
    // 冲突宾客不进自动排座
    assert.equal(autoCandidates(s).plan.some((p) => p.guestIds.includes('G01')), false);
  }

  // 人工裁决
  const ev = resolveConflict(s1, 'G01', 'family-b', '电话核实确实不来');
  assert.equal(s1.guests.G01.rsvp.status, 'declined');
  assert.equal(s1.guests.G01.rsvp.source, 'family-b');
  assert.equal(s1.guests.G01.rsvp.conflict, null);
  assert.ok(ev.eventNo);

  // 裁决之后来源又更新（人数变化）→ 冲突重新挂起
  appendBatch(s1, [row('family-a', 2, 'G01', 'confirmed', { party: 3, at: '2026-09-24T08:00:00Z' })]);
  assert.equal(s1.guests.G01.rsvp.conflict.kind, 'resolution-stale');
});

test('排座约束：锁定席不动、同桌组、避让、儿童椅全部保留', () => {
  const s = freshStore();
  // G05 已锁在 T1（2 人）
  appendBatch(s, [row('family-a', 1, 'G05', 'confirmed', { at: '2026-09-20T08:00:00Z' })]);
  s.assignments.G05 = { tableId: 'T1', locked: true };
  // G06 与 G05 避让 → G06 绝不能进 T1
  s.avoidPairs.push(['G05', 'G06']);
  // G02/G03 同桌
  s.sameGroups.push(['G02', 'G03']);
  // G04 需要儿童椅，T1 儿童椅容量 2 但 G05 占用 0…给 G04 2 个孩子，T1 容量会被占的话验证童椅
  appendBatch(s, [
    row('family-a', 2, 'G06', 'confirmed', { at: '2026-09-20T08:01:00Z' }),
    row('family-a', 3, 'G02', 'confirmed', { at: '2026-09-20T08:02:00Z' }),
    row('family-b', 1, 'G03', 'confirmed', { at: '2026-09-20T08:03:00Z' }),
    row('family-a', 4, 'G04', 'confirmed', { children: 2, childSeat: true, at: '2026-09-20T08:04:00Z' }),
  ]);
  const { plan, excluded } = autoCandidates(s);

  // G02+G03 必须同组同桌
  const pair = plan.find((p) => p.guestIds.includes('G02'));
  assert.ok(pair);
  assert.deepEqual(pair.guestIds.sort(), ['G02', 'G03']);

  // G06 不得与 G05 同桌
  const g06 = plan.find((p) => p.guestIds.includes('G06'));
  assert.ok(g06);
  assert.notEqual(g06.tableId, 'T1');

  // 计划不触碰 G05 锁定席
  assert.equal(plan.some((p) => p.guestIds.includes('G05')), false);
  assert.deepEqual(s.assignments.G05, { tableId: 'T1', locked: true });

  // applyPlan 拒绝任何非当前候选（防绕过移动席位）
  assert.throws(() => applyPlan(s, [{ guestIds: ['G05'], tableId: 'T2', locked: false }]), /候选已失效/);
  assert.deepEqual(s.assignments.G05, { tableId: 'T1', locked: true });

  // 儿童椅超限检测：把 G04 人为锁到童椅已满场景，reviewImpact 只登记不动席
  s.assignments.G04 = { tableId: 'T1', locked: true };
  s.tables.T1.childCapacity = 1; // 2 童椅需求 > 1
  const review = reviewImpact(s);
  assert.ok(review.affected.some((a) => a.problem === 'child-seat-overflow' && a.manualOnly));
  assert.deepEqual(s.assignments.G04, { tableId: 'T1', locked: true }, '不得自动移动童椅超限宾客');
  assert.ok(!excluded || true);
});

test('CSV 批量：幂等、重复表头、缺列等结构问题处理', () => {
  const csv = `source,source_seq,guest_id,status,party_size,children,child_seat,occurred_at
family-a,1,G01,confirmed,2,0,0,2026-09-20T10:00:00Z
family-a,2,G02,pending,1,0,0,2026-09-20T10:01:00Z`;
  const s = freshStore();
  importBatch(s, csvRows(csv), storeFile);
  assert.equal(s.guests.G01.rsvp.status, 'confirmed');

  // 整文件重复导入：全部幂等
  const r = importBatch(s, csvRows(csv), storeFile);
  assert.equal(r.duplicates, 2);
  assert.equal(r.accepted.length, 0);

  // 非法状态 + 非法人数行：整批失败
  const bad = `source,source_seq,guest_id,status,party_size,children,child_seat,occurred_at
family-a,3,G03,maybe,2,0,0,2026-09-20T11:00:00Z
family-a,4,G04,confirmed,0,0,0,2026-09-20T11:01:00Z
family-a,5,,confirmed,2,0,0,2026-09-20T11:02:00Z`;
  const { errors } = validateBatch(s, csvRows(bad));
  assert.ok(errors.length >= 3);
  assert.throws(() => importBatch(s, csvRows(bad), storeFile), BatchRejectedError);
});

test('导出：账本 CSV 含留痕列；状态 CSV 含冲突标记', () => {
  const s = freshStore();
  appendBatch(s, [row('family-a', 10, 'G01', 'confirmed', { at: '2026-09-23T09:00:00Z' })]);
  appendBatch(s, [row('family-a', 3, 'G01', 'declined', { at: '2026-09-18T09:00:00Z' })]);
  appendBatch(s, [row('family-b', 1, 'G01', 'pending', { at: '2026-09-23T10:00:00Z' })]);

  const ledger = parseCsv(exportLedgerCsv(s));
  const header = ledger[0];
  assert.ok(header.includes('stale') && header.includes('superseded_by'));
  const staleLine = ledger.slice(1).find((r) => r[3] === 'G01' && r[2] === '3');
  assert.equal(staleLine[header.indexOf('stale')], '1');
  assert.ok(staleLine[header.indexOf('superseded_by')] !== '');

  const state = parseCsv(exportStateCsv(s));
  const sh = state[0];
  const g01 = state.find((r) => r[sh.indexOf('guest_id')] === 'G01');
  assert.equal(g01[sh.indexOf('conflict')], 'cross-source');
});

test('本地迁移：v1 JSON/CSV → v2 账本，锁定席与关系保留', () => {
  const v1 = {
    guests: [
      { id: 'G01', name: '张三', rsvp: 'yes', partySize: 2, children: 0 },
      { id: 'G02', name: '李四', rsvp: 'no', partySize: 1 },
      { id: 'G03', name: '王五', rsvp: 'maybe' },
    ],
    tables: [{ id: 'T1', name: '主桌', capacity: 10 }],
    assignments: [{ guestId: 'G01', tableId: 'T1', locked: true }],
    sameGroups: [['G01', 'G03']],
    avoidPairs: [['G02', 'G03']],
  };
  const v1Path = path.join(dir, 'v1.json');
  writeFileSync(v1Path, JSON.stringify(v1));
  const out = path.join(dir, 'v2.json');
  const report = migrate({ inputFile: v1Path, outputFile: out });
  assert.equal(report.baselineEvents, 3);
  const s = loadStore(out);
  assert.equal(s.schemaVersion, 2);
  assert.deepEqual(s.assignments.G01, { tableId: 'T1', locked: true });
  assert.equal(s.guests.G01.rsvp.status, 'confirmed');
  assert.equal(s.guests.G02.rsvp.status, 'declined');
  assert.equal(s.guests.G03.rsvp.status, 'pending');
  assert.deepEqual(s.sameGroups, [['G01', 'G03']]);
  assert.deepEqual(s.avoidPairs, [['G02', 'G03']]);
  // 迁移基线事件可被后续真实来源事件正常接续
  appendBatch(s, [row('family-a', 1, 'G03', 'confirmed', { at: '2026-09-24T08:00:00Z' })]);
  assert.equal(s.guests.G03.rsvp.status, 'confirmed');
  assert.equal(s.guests.G03.rsvp.source, 'family-a');

  // v1 CSV
  const csv = `guest_id,name,rsvp,party_size,children,child_seat,table_id,locked,capacity,table_name,updated_at
G10,赵六,yes,3,1,1,T2,1,8,次桌,2026-09-19T00:00:00Z`;
  const csvPath = path.join(dir, 'v1.csv');
  writeFileSync(csvPath, csv);
  const out2 = path.join(dir, 'v2b.json');
  migrate({ inputFile: csvPath, outputFile: out2 });
  const s2 = loadStore(out2);
  assert.equal(s2.guests.G10.rsvp.status, 'confirmed');
  assert.deepEqual(s2.assignments.G10, { tableId: 'T2', locked: true });
});

test('候选的儿童椅边界：容量内可入座，超容量进入排除清单', () => {
  const s = freshStore();
  s.tables.T2.childCapacity = 1;
  appendBatch(s, [row('family-a', 1, 'G07', 'confirmed', { children: 2, childSeat: true, at: '2026-09-20T08:00:00Z' })]);
  let { plan, excluded } = autoCandidates(s);
  // T1 童椅容量 2 可以放下
  const g07 = plan.find((p) => p.guestIds.includes('G07'));
  assert.ok(g07, 'T1 有 2 张童椅应可入选');
  assert.equal(g07.tableId, 'T1');

  // T1 也占掉童椅 → 两张桌都放不下
  s.assignments.G08 = { tableId: 'T1', locked: true };
  s.guests.G08.rsvp = { status: 'confirmed', source: 'x', eventNo: 99, partySize: 1, children: 2, childSeatNeeded: true, conflict: null };
  s.assignments.G08 = { tableId: 'T1', locked: true };
  ({ plan, excluded } = autoCandidates(s));
  assert.equal(plan.some((p) => p.guestIds.includes('G07')), false);
  assert.ok(excluded.find((x) => x.guestId === 'G07')?.reason.includes('儿童椅'));
});

test('reviewImpact：未锁定婉拒给清单与建议，但绝不自动移动', () => {
  const s = freshStore();
  appendBatch(s, [row('family-a', 1, 'G01', 'confirmed', { at: '2026-09-20T08:00:00Z' })]);
  applyPlan(s, autoCandidates(s).plan);
  assert.ok(s.assignments.G01);
  appendBatch(s, [row('family-a', 2, 'G01', 'declined', { at: '2026-09-22T08:00:00Z' })]);
  const review = reviewImpact(s);
  const item = review.affected.find((a) => a.guestId === 'G01');
  assert.ok(item);
  assert.equal(item.locked, false);
  assert.ok(s.assignments.G01, '未锁定也不会被自动移走');
});
