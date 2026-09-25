// 批量导出：事件账本（可审计、可重放）、当前物化状态（含宾客历史）、
// 导入批次留痕。CSV / JSON 两种形态。

import { serializeCsv } from './util/csv.js';
import { materialize } from './domain/materializer.js';
import { stateIndex } from './domain/materializer.js';
import { assignmentByGuest } from './domain/seating.js';

export function ledgerToCsv(events) {
  const headers = [
    'eventId',
    'kind',
    'guestId',
    'source',
    'seq',
    'status',
    'partySize',
    'note',
    'occurredAt',
    'receivedAt',
  ];
  const records = events.map((e) => ({
    eventId: e.eventId,
    kind: e.kind,
    guestId: e.guestId,
    source: e.source,
    seq: e.seq,
    status: e.status,
    partySize: e.partySize ?? 1,
    note: e.note ?? '',
    occurredAt: e.occurredAt,
    receivedAt: e.receivedAt,
  }));
  return serializeCsv(headers, records);
}

export function stateToCsv(materialized, seating = null) {
  const amap = seating ? assignmentByGuest(seating) : null;
  const headers = [
    'guestId',
    'name',
    'currentStatus',
    'currentPartySize',
    'currentSource',
    'currentEventId',
    'currentOccurredAt',
    'hasConflict',
    'statusProvisional',
    'child',
    'tableId',
    'seatNumber',
    'locked',
  ];
  const records = materialized.guests.map((g) => {
    const a = amap?.get(g.guestId);
    return {
      guestId: g.guestId,
      name: g.name,
      currentStatus: g.currentStatus ?? '',
      currentPartySize: g.currentPartySize,
      currentSource: g.currentSource ?? '',
      currentEventId: g.currentEventId ?? '',
      currentOccurredAt: g.currentOccurredAt ?? '',
      hasConflict: g.hasConflict ? '1' : '0',
      statusProvisional: g.statusProvisional ? '1' : '0',
      child: g.child ? '1' : '0',
      tableId: a?.tableId ?? '',
      seatNumber: a?.seatNumber ?? '',
      locked: a?.locked ? '1' : '0',
    };
  });
  return serializeCsv(headers, records);
}

export function guestHistoryCsv(guestState) {
  const headers = [
    'eventId',
    'source',
    'seq',
    'status',
    'partySize',
    'note',
    'occurredAt',
    'receivedAt',
    'late',
    'effect',
  ];
  return serializeCsv(
    headers,
    guestState.history.map((h) => ({
      eventId: h.eventId,
      source: h.source,
      seq: h.seq,
      status: h.status,
      partySize: h.partySize,
      note: h.note,
      occurredAt: h.occurredAt,
      receivedAt: h.receivedAt,
      late: h.late ? '1' : '0',
      effect: h.effect,
    })),
  );
}

// 全量 JSON 导出：账本 + 物化视图，可用于备份或在另一家重新重建。
export function fullExport(store) {
  const materialized = materialize(store.roster, store.events);
  return {
    exportedAt: new Date().toISOString(),
    meta: store.meta,
    roster: store.roster,
    tables: store.tables,
    seating: store.seating,
    events: store.events,
    materialized,
  };
}

export { stateIndex };
