/**
 * 批量导入 / 导出（两家人各自的离线表格）。
 * 导入列：source,source_seq,guest_id,status,party_size,children,child_seat,occurred_at
 * 整批语义：预检任一行失败 → 抛 BatchRejectedError，账本/物化状态/文件一律不变（原项目与桌卡不受影响）。
 */
import { objectsToCsv } from './csv.js';
import { validateBatch, appendBatch, VALIDATION_ERRORS } from './events.js';
import { saveStore } from './store.js';

export const IMPORT_COLUMNS = ['source', 'source_seq', 'guest_id', 'status', 'party_size', 'children', 'child_seat', 'occurred_at'];
export const LEDGER_EXPORT_COLUMNS = [
  'event_no', 'source', 'source_seq', 'guest_id', 'status',
  'party_size', 'children', 'child_seat', 'occurred_at', 'recorded_at', 'stale', 'superseded_by',
];
export const STATE_EXPORT_COLUMNS = [
  'guest_id', 'name', 'rsvp_status', 'source', 'event_no', 'party_size', 'children',
  'child_seat', 'conflict', 'table_id', 'locked',
];

export class BatchRejectedError extends Error {
  constructor(errors) {
    super(`整批导入失败：${errors.length} 行非法（未写入任何事件）`);
    this.name = 'BatchRejectedError';
    this.errors = errors;
  }
}

/** 把 CSV 对象行规范化为事件行；结构性错误（缺列/空值）也计入整批失败 */
export function normalizeRows(objects, { defaultSource } = {}) {
  const rows = [];
  for (const o of objects) {
    const raw = {
      source: (o.source ?? defaultSource ?? '').trim(),
      rawSeq: o.source_seq ?? '',
      rawGuest: (o.guest_id ?? '').trim(),
      rawStatus: (o.status ?? '').trim().toLowerCase(),
      rawParty: o.party_size ?? '',
      rawChildren: o.children ?? '',
      rawChildSeat: (o.child_seat ?? '').trim().toLowerCase(),
      rawOccurredAt: (o.occurred_at ?? '').trim(),
      __line: o.__line,
    };
    rows.push({
      source: raw.source,
      sourceSeq: Number.isFinite(Number(raw.rawSeq)) && /^\d+$/.test(String(raw.rawSeq).trim()) ? Number(raw.rawSeq) : NaN,
      guestId: raw.rawGuest,
      status: raw.rawStatus,
      partySize: raw.rawParty === '' ? null : (Number.isFinite(Number(raw.rawParty)) ? Number(raw.rawParty) : NaN),
      children: raw.rawChildren === '' ? null : (Number.isFinite(Number(raw.rawChildren)) ? Number(raw.rawChildren) : NaN),
      childSeatNeeded: /^(1|true|yes|y|是)$/.test(raw.rawChildSeat),
      occurredAt: raw.rawOccurredAt && !Number.isNaN(Date.parse(raw.rawOccurredAt))
        ? new Date(raw.rawOccurredAt).toISOString() : null,
      ...raw,
    });
  }
  return rows;
}

export function checkHeader(headerFields, actualFields) {
  const missing = headerFields.filter((c) => !actualFields.includes(c));
  if (missing.length) {
    const e = new Error(`缺少必需列: ${missing.join(', ')}`);
    e.code = VALIDATION_ERRORS.HEADER;
    throw e;
  }
}

/**
 * 导入整批。调用方负责 loadStore；本函数负责 校验 → append → 一次原子保存。
 * 校验失败时不触碰 store 内存对象（append 只在校验后执行）。
 */
export function importBatch(store, rows, file, { nowIso = new Date().toISOString() } = {}) {
  const { errors } = validateBatch(store, rows);
  if (errors.length) throw new BatchRejectedError(errors);
  const result = appendBatch(store, rows, nowIso);
  if (file) saveStore(file, store);
  return result;
}

/** 事件账本导出（含 stale/superseded_by 留痕列） */
export function exportLedgerCsv(store) {
  const objs = store.events
    .slice()
    .sort((a, b) => a.eventNo - b.eventNo)
    .map((e) => ({
      event_no: e.eventNo,
      source: e.source,
      source_seq: e.sourceSeq,
      guest_id: e.guestId,
      status: e.status,
      party_size: e.partySize ?? '',
      children: e.children ?? 0,
      child_seat: e.childSeatNeeded ? 1 : 0,
      occurred_at: e.occurredAt,
      recorded_at: e.recordedAt,
      stale: e.stale ? 1 : 0,
      superseded_by: e.supersededBy ?? '',
    }));
  return objectsToCsv(objs, LEDGER_EXPORT_COLUMNS);
}

/** 当前物化状态导出（桌卡/席位视图） */
export function exportStateCsv(store) {
  const objs = Object.values(store.guests).map((g) => {
    const a = store.assignments[g.id];
    return {
      guest_id: g.id,
      name: g.name,
      rsvp_status: g.rsvp?.status ?? '',
      source: g.rsvp?.source ?? '',
      event_no: g.rsvp?.eventNo ?? '',
      party_size: g.rsvp?.partySize ?? '',
      children: g.rsvp?.children ?? 0,
      child_seat: g.rsvp?.childSeatNeeded ? 1 : 0,
      conflict: g.rsvp?.conflict ? g.rsvp.conflict.kind : '',
      table_id: a?.tableId ?? '',
      locked: a?.locked ? 1 : 0,
    };
  });
  return objectsToCsv(objs, STATE_EXPORT_COLUMNS);
}
