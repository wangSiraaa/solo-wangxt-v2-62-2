/**
 * 本地迁移：把“现有 RSVP 编辑”旧形态（v1：宾客上直接挂最后编辑值）
 * 升级为 v2：事件账本 + 物化状态。
 * 旧数据的每个当前 RSVP 折算为一条 source=migration 的基线事件，事件账本从此可追溯。
 *
 * 支持两种输入：
 *  1) v1 JSON（{guests:[{id,name,rsvp,partySize,children,...}], tables:[...], assignments:[...]}）
 *  2) v1 CSV（guest_id,name,rsvp,party_size,children,child_seat,table_id,locked）
 */
import { existsSync } from 'node:fs';
import { readJson, writeJsonAtomic } from './fsutil.js';
import { csvToObjects } from './csv.js';
import { readText } from './fsutil.js';
import {
  emptyStore, MIGRATION_SOURCE, RSVPS, SCHEMA_VERSION,
} from './store.js';
import { recomputeAllRsvp } from './events.js';

export function migrate({ inputFile, outputFile, baselineTime = new Date().toISOString(), force = false }) {
  if (existsSync(outputFile) && !force) {
    throw new Error(`目标已存在: ${outputFile}（加 --force 可覆盖）`);
  }
  const raw = inputFile.endsWith('.csv') ? parseV1Csv(readText(inputFile)) : readJson(inputFile);
  const store = emptyStore();
  const report = { guests: 0, baselineEvents: 0, tables: 0, assignments: 0, locked: 0, skipped: [] };

  const guests = Array.isArray(raw.guests) ? raw.guests : [];
  const tables = raw.tables || [];
  const assignments = raw.assignments || [];

  for (const t of tables) {
    store.tables[t.id] = {
      id: t.id, name: t.name ?? t.id,
      capacity: Number(t.capacity),
      childCapacity: t.childCapacity == null ? null : Number(t.childCapacity),
    };
    store.tableOrder.push(t.id);
    report.tables++;
  }

  let seq = 0;
  for (const x of guests) {
    const id = String(x.id ?? '').trim();
    if (!id) { report.skipped.push('缺少 id 的宾客行'); continue; }
    const status = normalizeStatus(x.rsvp ?? x.status);
    store.guests[id] = {
      id,
      name: x.name ?? id,
      partySize: x.partySize == null ? null : Number(x.partySize),
      children: x.children == null ? 0 : Number(x.children),
      childSeatNeeded: !!x.childSeatNeeded,
      rsvp: null,
    };
    report.guests++;
    if (status) {
      store.events.push({
        eventNo: ++store.counters.eventNo,
        type: 'rsvp',
        source: MIGRATION_SOURCE,
        sourceSeq: ++seq,
        guestId: id,
        status,
        partySize: x.partySize == null ? null : Number(x.partySize),
        children: x.children == null ? 0 : Number(x.children),
        childSeatNeeded: !!x.childSeatNeeded,
        occurredAt: x.updatedAt || baselineTime,
        recordedAt: baselineTime,
        stale: false,
        supersededBy: null,
        payload: { kind: 'migration-baseline' },
      });
      report.baselineEvents++;
    }
  }

  for (const a of assignments) {
    const guestId = String(a.guestId);
    if (!store.guests[guestId]) { report.skipped.push(`排座引用未知宾客 ${guestId}`); continue; }
    if (!store.tables[a.tableId]) { report.skipped.push(`排座引用未知桌 ${a.tableId}`); continue; }
    store.assignments[guestId] = { tableId: a.tableId, locked: !!a.locked };
    report.assignments++;
    if (a.locked) report.locked++;
  }
  if (raw.sameGroups) store.sameGroups = raw.sameGroups.map((g) => g.map(String));
  if (raw.avoidPairs) store.avoidPairs = raw.avoidPairs.map((p) => [String(p[0]), String(p[1])]);

  recomputeAllRsvp(store);
  store.migratedAt = baselineTime;
  store.schemaVersion = SCHEMA_VERSION;
  writeJsonAtomic(outputFile, store);
  return report;
}

function normalizeStatus(s) {
  if (!s) return null;
  const v = String(s).trim().toLowerCase();
  const map = { yes: 'confirmed', no: 'declined', maybe: 'pending', 确认: 'confirmed', 婉拒: 'declined', 待定: 'pending' };
  const out = map[v] ?? (RSVPS.includes(v) ? v : null);
  return out;
}

function parseV1Csv(text) {
  const objs = csvToObjects(text);
  const guests = [];
  const assignments = [];
  const tableMap = new Map();
  for (const o of objs) {
    guests.push({
      id: o.guest_id, name: o.name, rsvp: o.rsvp,
      partySize: o.party_size === '' ? null : Number(o.party_size),
      children: o.children === '' ? 0 : Number(o.children),
      childSeatNeeded: /^(1|true|yes|是)$/i.test(o.child_seat),
      updatedAt: o.updated_at || undefined,
    });
    if (o.table_id) {
      assignments.push({ guestId: o.guest_id, tableId: o.table_id, locked: /^(1|true|yes|是)$/i.test(o.locked) });
      if (!tableMap.has(o.table_id)) tableMap.set(o.table_id, { id: o.table_id, name: o.table_name || o.table_id, capacity: Number(o.capacity || 10), childCapacity: o.child_capacity === '' ? null : Number(o.child_capacity) });
    }
  }
  return { guests, assignments, tables: [...tableMap.values()] };
}
