// 应用服务层：装载/保存、名录与桌台维护、物化、影响分析、席位事务（带审计）。

import {
  loadAll,
  writeJsonAtomic,
  appendJsonl,
  readJson,
  paths,
  listBatchFiles,
} from './storage.js';
import { initStore } from './migrate.js';
import { materialize } from './domain/materializer.js';
import {
  analyzeImpact,
  proposeSeating,
  assignSeat,
  lockSeat,
  unlockSeat,
  releaseSeat,
  applyProposal,
} from './domain/seating.js';
import { getGuest, getTable } from './domain/reference.js';
import { iso } from './util/time.js';
import { normalizeStatus, SOURCE_MANUAL } from './model/constants.js';
import { nextEventId, buildResolutionEvent } from './domain/events.js';

export function openStore(home, { autoInit = false } = {}) {
  if (autoInit) initStore(home);
  const store = loadAll(home);
  if (!store.meta) throw new Error(`数据目录尚未初始化：${store.p.home}（请先运行 rsvp migrate）`);
  return store;
}

export function refresh(store) {
  return materialize(store.roster, store.events);
}

export function impact(store) {
  const m = materialize(store.roster, store.events);
  return analyzeImpact(m, store.seating, store.tables, store.roster);
}

export function proposal(store) {
  const m = materialize(store.roster, store.events);
  return proposeSeating({
    roster: store.roster,
    tables: store.tables,
    materialized: m,
    seating: store.seating,
  });
}

export function saveRoster(store) {
  writeJsonAtomic(store.p.roster, store.roster);
}
export function saveTables(store) {
  writeJsonAtomic(store.p.tables, store.tables);
}
export function saveSeating(store) {
  writeJsonAtomic(store.p.seating, store.seating);
}

function writeAudit(store, entry) {
  appendJsonl(store.p.audit, [{ at: iso(), ...entry }]);
}

// ---- 名录维护 ----

export function addGuest(store, { guestId, name, child = false, group = '', sameWith = [], avoidWith = [] }) {
  if (!guestId) throw new Error('guestId 必填');
  if (getGuest(store.roster, guestId)) throw new Error(`宾客 ${guestId} 已存在`);
  // 关系允许前向引用（名录批量导入时对方可能尚未创建）；物化时只保留双方都存在的边。
  const g = {
    guestId,
    name: name || guestId,
    child: Boolean(child),
    group: group || null,
    sameWith: [...new Set(sameWith)].filter((x) => x !== guestId),
    avoidWith: [...new Set(avoidWith)].filter((x) => x !== guestId),
  };
  store.roster.guests.push(g);
  saveRoster(store);
  return g;
}

export function removeGuest(store, { guestId }) {
  if (!getGuest(store.roster, guestId)) throw new Error(`宾客 ${guestId} 不存在`);
  if (store.seating.assignments.some((a) => a.guestId === guestId))
    throw new Error(`宾客 ${guestId} 仍有席位，请先释放`);
  store.roster.guests = store.roster.guests.filter((g) => g.guestId !== guestId);
  for (const g of store.roster.guests) {
    g.sameWith = (g.sameWith || []).filter((x) => x !== guestId);
    g.avoidWith = (g.avoidWith || []).filter((x) => x !== guestId);
  }
  saveRoster(store);
}

export function addRelation(store, { guestId, other, type }) {
  const a = getGuest(store.roster, guestId);
  const b = getGuest(store.roster, other);
  if (!a || !b) throw new Error('宾客不存在');
  if (guestId === other) throw new Error('不能与自己建立关系');
  const field = type === 'avoid' ? 'avoidWith' : 'sameWith';
  a[field] = a[field] || [];
  if (a[field].includes(other)) return a;
  a[field].push(other);
  saveRoster(store);
  return a;
}

// ---- 桌台维护 ----

export function addTable(store, { tableId, name, capacity }) {
  if (!tableId) throw new Error('tableId 必填');
  if (getTable(store.tables, tableId)) throw new Error(`桌台 ${tableId} 已存在`);
  const cap = Number(capacity);
  if (!Number.isInteger(cap) || cap < 1) throw new Error('capacity 必须为正整数');
  const t = { tableId, name: name || tableId, capacity: cap };
  store.tables.tables.push(t);
  saveTables(store);
  return t;
}

// ---- 席位事务（人工显式操作，保留锁定/儿童/同桌/避让；全部审计）----

export function seatAssign(store, { guestId, tableId, seatNumber = null, locked = false, operator = '' }) {
  const at = iso();
  // assignSeat 已直接导入
  const a = assignSeat(store, { guestId, tableId, seatNumber, locked, at, operator });
  saveSeating(store);
  writeAudit(store, { action: 'seat_assign', guestId, tableId, seatNumber: a.seatNumber, locked, operator });
  return a;
}

export function seatLock(store, { guestId, reason = '', operator = '' }) {
  // lockSeat 已直接导入
  const at = iso();
  const a = lockSeat(store, { guestId, reason, at });
  saveSeating(store);
  writeAudit(store, { action: 'seat_lock', guestId, tableId: a.tableId, seatNumber: a.seatNumber, reason, operator });
  return a;
}

export function seatUnlock(store, { guestId, operator = '' }) {
  // unlockSeat 已直接导入
  const a = unlockSeat(store, { guestId });
  saveSeating(store);
  writeAudit(store, { action: 'seat_unlock', guestId, tableId: a.tableId, seatNumber: a.seatNumber, operator });
  return a;
}

export function seatRelease(store, { guestId, operator = '', reason = '' }) {
  // releaseSeat 已直接导入
  const at = iso();
  const res = releaseSeat(store, { guestId, at, operator, reason });
  saveSeating(store);
  writeAudit(store, {
    action: 'seat_release',
    guestId,
    tableId: res.removed.tableId,
    seatNumber: res.removed.seatNumber,
    wasLocked: false,
    operator,
    reason,
  });
  return res;
}

// 计算方案（不落任何数据）
export function seatProposal(store) {
  return proposal(store);
}

// 显式批准并应用给定方案（默认取当前候选）：仅给未排座宾客加位，绝不移动既有席位。
export function seatApplyProposal(store, { proposal = null, operator = '' } = {}) {
  const p = proposal || seatProposal(store);
  // applyProposal 已直接导入
  const at = iso();
  const res = applyProposal(store, { proposal: p, at, operator });
  saveSeating(store);
  writeAudit(store, {
    action: 'seat_apply_auto_proposal',
    addedCount: res.added.length,
    added: res.added.map((a) => ({ guestId: a.guestId, tableId: a.tableId, seatNumber: a.seatNumber })),
    unsatisfiable: p.unsatisfiable,
    operator,
  });
  return { ...res, proposal: p };
}

// ---- 人工解决跨来源冲突 ----
// 追加一条 manual/resolution 事件：它是更晚时刻的新事实，旧的同刻冲突在
// 重放时自动降级为留痕，宾客恢复为确定状态。
export function resolveConflict(store, { guestId, status, partySize = 1, note = '', operator = '' }) {
  if (!getGuest(store.roster, guestId)) throw new Error(`未知宾客 ${guestId}`);
  const m = materialize(store.roster, store.events);
  const st = m.guests.find((g) => g.guestId === guestId);
  if (!st.hasConflict) throw new Error(`宾客 ${guestId} 当前没有待解决的跨来源冲突`);
  const s = normalizeStatus(status);

  const seq =
    Math.max(
      -1,
      ...store.events.filter((e) => e.source === SOURCE_MANUAL && e.guestId === guestId).map((e) => e.seq),
    ) + 1;
  const nowMs = Date.now();
  const evt = buildResolutionEvent(
    {
      guestId,
      status: s,
      partySize: Number(partySize) || 1,
      note: note || '人工解决跨来源冲突',
      occurredAt: iso(nowMs),
      occurredAtMs: nowMs,
    },
    {
      eventId: nextEventId(store.events.length),
      seq,
      receivedAt: iso(nowMs),
      receivedAtMs: nowMs,
    },
  );
  appendJsonl(store.p.ledger, [evt]);
  store.events.push(evt);
  writeAudit(store, {
    action: 'rsvp_conflict_resolved',
    guestId,
    eventId: evt.eventId,
    chosenStatus: s,
    contending: st.contending.map((c) => ({ eventId: c.eventId, source: c.source, status: c.status })),
    operator,
  });
  return evt;
}

// 待处理总览：跨来源 RSVP 冲突 + 锁定席婉拒/冲突在席
export function reviewQueue(store) {
  const m = materialize(store.roster, store.events);
  const imp = analyzeImpact(m, store.seating, store.tables, store.roster);
  return {
    rsvpConflicts: m.reviews,
    seatingReviews: imp.pendingReview,
    groupWarnings: imp.groupWarnings,
  };
}

// ---- 读取辅助 ----

export function importBatches(store) {
  return listBatchFiles(store.p.home).map((f) => readJson(f));
}

