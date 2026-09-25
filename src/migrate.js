// 本地迁移：初始化 schema，并支持把"旧版扁平 RSVP 表"一次性迁移为事件流。
// 迁移是幂等的：已初始化的库重复执行只报 up-to-date，不产生重复事件。

import { existsSync, readFileSync } from 'node:fs';
import {
  ensureHome,
  paths,
  readJson,
  readJsonl,
  writeJsonAtomic,
  appendJsonl,
} from './storage.js';
import { iso } from './util/time.js';
import { parseCsv } from './util/csv.js';
import { normalizeStatus } from './model/constants.js';
import { nextEventId, buildRsvpEvent } from './domain/events.js';

export const CURRENT_SCHEMA = 1;

export function initStore(home) {
  const p = ensureHome(home);
  if (existsSync(p.meta)) {
    const meta = readJson(p.meta);
    return { migrated: false, schemaVersion: meta.schemaVersion, p };
  }
  const now = iso();
  writeJsonAtomic(p.meta, {
    schemaVersion: CURRENT_SCHEMA,
    createdAt: now,
    sources: {},
  });
  writeJsonAtomic(p.roster, { guests: [] });
  writeJsonAtomic(p.tables, { tables: [] });
  writeJsonAtomic(p.seating, { revision: 0, assignments: [] });
  return { migrated: true, schemaVersion: CURRENT_SCHEMA, p };
}

// 旧版扁平 JSON：[{ guestId, status, partySize?, note?, updatedAt? }, ...]
// 或扁平 CSV：guestId,status,occurredAt[,partySize,note]
// 每个宾客的最后一条扁平记录 -> 一条来源 legacy 的初始事件（seq 从 1 开始）。
export function migrateLegacy(home, legacyFile, { operator = 'migration' } = {}) {
  initStore(home);
  const p = paths(home);
  const meta = readJson(p.meta);
  const existing = readJsonl(p.ledger);
  if (existing.some((e) => e.source === 'legacy')) {
    return { migrated: 0, skipped: 'legacy 事件已存在，迁移幂等跳过' };
  }
  const roster = readJson(p.roster, { guests: [] });
  const known = new Set((roster.guests || []).map((g) => g.guestId));

  let rows;
  if (legacyFile.endsWith('.csv')) {
    const { records } = parseCsv(readFileSync(legacyFile, 'utf8'));
    rows = records.map((r) => ({
      guestId: r.guestId,
      status: r.status,
      partySize: r.partySize || 1,
      note: r.note || '',
      updatedAt: r.occurredAt || r.updatedAt,
    }));
  } else {
    rows = readJson(legacyFile);
  }
  if (!Array.isArray(rows)) throw new Error('旧版数据必须是数组或 CSV');

  // 未知宾客：迁移同样整批失败，避免污染名录外数据
  const errors = rows
    .filter((r) => !known.has(r.guestId))
    .map((r) => `未知宾客 guestId=${r.guestId}`);
  if (errors.length) throw new Error('旧版数据包含名录外宾客：\n - ' + errors.join('\n - '));

  const received = Date.now();
  const seqByGuest = new Map();
  const events = [];
  for (const r of rows) {
    const seq = (seqByGuest.get(r.guestId) || 0) + 1;
    seqByGuest.set(r.guestId, seq);
    const ms = r.updatedAt ? Date.parse(r.updatedAt) : received;
    if (Number.isNaN(ms)) throw new Error(`guestId=${r.guestId} 的时间非法：${r.updatedAt}`);
    events.push(
      buildRsvpEvent(
        {
          guestId: r.guestId,
          source: 'legacy',
          seq,
          status: normalizeStatus(r.status),
          partySize: Number(r.partySize) || 1,
          note: r.note ?? '迁移自旧版扁平表',
          occurredAt: iso(ms),
          occurredAtMs: ms,
        },
        {
          eventId: nextEventId(existing.length + events.length),
          receivedAt: iso(received),
          receivedAtMs: received,
        },
      ),
    );
  }
  appendJsonl(p.ledger, events);
  meta.sources = meta.sources || {};
  meta.sources.legacy = {
    lastSeq: 1,
    lastImportAt: iso(received),
    lastOperator: operator,
    note: '由旧版扁平表迁移（每宾客一条初始事件）',
  };
  writeJsonAtomic(p.meta, meta);
  return { migrated: events.length, events };
}
