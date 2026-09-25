// 批量导入：CSV 行 -> 校验 -> 事务性追加账本。
//
// 事务保证：任何一行非法（未知宾客 / 非法序号 / 非法状态或时间……），
// 整批拒绝，账本、游标、席位与桌卡均不受影响。
//
// 幂等保证：同 (source, seq) 再次导入且负载指纹一致 -> 识别为重复，跳过且不计占座；
// 若负载不一致（同序号却内容不同）-> 视为损坏/非法顺序，整批拒绝。

import { readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../util/csv.js';
import { parseTime, iso } from '../util/time.js';
import { normalizeStatus, SOURCE_MANUAL } from '../model/constants.js';
import { getGuest } from './reference.js';
import { buildRsvpEvent, nextEventId, payloadFingerprint } from './events.js';
import { appendJsonl, paths, writeJsonAtomic } from '../storage.js';

const REQUIRED_HEADERS = ['guestId', 'status', 'occurredAt'];

// 纯函数：校验并分类行。不产生副作用，返回 { toAppend, duplicates, errors }。
export function planImport({ rows, source, roster, events, expectedStartSeq = null }) {
  const errors = [];
  const fail = (line, msg) => errors.push({ line, message: msg });

  if (!source || String(source).trim() === '') {
    fail(0, '必须提供来源标识 source（如 family_zhang）');
  }
  if (source === SOURCE_MANUAL) {
    fail(0, `来源 "${SOURCE_MANUAL}" 为系统保留，外部表格不得使用`);
  }
  if (rows.length === 0) {
    fail(1, 'CSV 没有任何数据行');
  }

  // 来源内已到账事件序号（含已存在的本来源事件）
  const existing = new Map();
  for (const e of events) {
    if (e.source === source) existing.set(e.seq, e);
  }
  const maxExistingSeq = existing.size ? Math.max(...existing.keys()) : 0;

  // 本批内序号去重
  const seenInBatch = new Map();

  const parsed = [];
  rows.forEach((row) => {
    const line = row.__line ?? 0;
    for (const h of REQUIRED_HEADERS) {
      if (!(h in row) || row[h] === '') fail(line, `缺少必填列 ${h}`);
    }
    if (errors.some((e) => e.line === line)) return;

    const guestId = row.guestId;
    if (!getGuest(roster, guestId)) {
      fail(line, `未知宾客 guestId=${guestId}（名录中不存在）`);
      return;
    }

    let status;
    try {
      status = normalizeStatus(row.status);
    } catch (err) {
      fail(line, err.message);
      return;
    }

    let t;
    try {
      t = parseTime(row.occurredAt);
    } catch (err) {
      fail(line, err.message);
      return;
    }

    const seqRaw = row.seq ?? '';
    if (seqRaw === '') {
      fail(line, '缺少来源内序号 seq（正整数，从 1 开始、批内严格递增）');
      return;
    }
    if (!/^\d+$/.test(seqRaw)) {
      fail(line, `seq 必须为正整数，实际为 "${seqRaw}"`);
      return;
    }
    const seq = Number(seqRaw);
    if (seq < 1) {
      fail(line, `seq 必须 >= 1，实际为 ${seq}`);
      return;
    }

    let partySize = 1;
    if (row.partySize !== undefined && row.partySize !== '') {
      if (!/^\d+$/.test(row.partySize) || Number(row.partySize) < 1) {
        fail(line, `partySize 必须为 >=1 的整数，实际为 "${row.partySize}"`);
        return;
      }
      partySize = Number(row.partySize);
    }

    if (seenInBatch.has(seq)) {
      fail(line, `批内序号重复 seq=${seq}（另见第 ${seenInBatch.get(seq)} 行）`);
      return;
    }
    seenInBatch.set(seq, line);

    parsed.push({
      line,
      guestId,
      source,
      seq,
      status,
      partySize,
      note: row.note ?? '',
      occurredAt: iso(t.ms),
      occurredAtMs: t.ms,
    });
  });

  if (errors.length) return { errors, toAppend: [], duplicates: [], newMaxSeq: maxExistingSeq };

  // 序号必须按行严格递增，且从 maxExistingSeq+1 连续无洞。
  const ordered = [...parsed].sort((a, b) => a.seq - b.seq);
  let cursor = maxExistingSeq;
  for (const item of ordered) {
    const prev = existing.get(item.seq);
    if (prev) {
      const fp = payloadFingerprint({ ...item, kind: 'rsvp' });
      if (fp !== payloadFingerprint(prev)) {
        fail(
          item.line,
          `seq=${item.seq} 在来源 "${source}" 中已存在但负载不同（来源内序号不可改写历史）`,
        );
        continue;
      }
      // 完全一致 -> 幂等重复
      continue;
    }
    if (item.seq !== cursor + 1) {
      fail(
        item.line,
        `非法顺序：来源 "${source}" 下一个序号应为 ${cursor + 1}，却收到 ${item.seq}（序号必须连续、按序追加）`,
      );
      continue;
    }
    cursor = item.seq;
  }

  if (errors.length) return { errors, toAppend: [], duplicates: [], newMaxSeq: maxExistingSeq };

  const duplicates = ordered.filter((i) => existing.has(i.seq)).map((i) => ({ ...i }));
  const toAppend = ordered.filter((i) => !existing.has(i.seq));

  return { errors, toAppend, duplicates, newMaxSeq: cursor };
}

// 执行导入（planImport 通过后）：分配事件号 -> 追加账本 -> 更新游标 -> 留痕批次。
export function commitImport(store, { source, planned, receivedAtMs = Date.now(), operator = '' }) {
  if (planned.errors.length) {
    throw new Error('存在校验错误，拒绝提交');
  }
  const receivedAt = iso(receivedAtMs);
  const newEvents = planned.toAppend.map((item, index) =>
    buildRsvpEvent(
      { ...item },
      {
        eventId: nextEventId(store.events.length + index),
        receivedAt,
        receivedAtMs,
      },
    ),
  );

  appendJsonl(store.p.ledger, newEvents);

  const meta = store.meta;
  meta.sources = meta.sources || {};
  meta.sources[source] = {
    lastSeq: planned.newMaxSeq,
    lastImportAt: receivedAt,
    lastOperator: operator || (meta.sources[source] && meta.sources[source].lastOperator) || '',
  };
  writeJsonAtomic(store.p.meta, meta);

  const batchId = `imp-${receivedAtMs}-${source}`;
  const record = {
    batchId,
    source,
    receivedAt,
    operator,
    appended: newEvents.map((e) => ({ eventId: e.eventId, seq: e.seq, guestId: e.guestId })),
    duplicates: planned.duplicates.map((d) => ({
      seq: d.seq,
      guestId: d.guestId,
      status: d.status,
      reason: 'same_source_same_seq_same_payload',
    })),
  };
  mkdirSync(store.p.importsDir, { recursive: true });
  writeJsonAtomic(join(store.p.importsDir, `${batchId}.json`), record);

  return { batchId, newEvents, duplicateCount: planned.duplicates.length, record };
}

// 高层：读 CSV 文件并执行导入，返回事务结果（绝不部分写入）。
export function importCsvFile(store, { file, source, operator = '' }) {
  const text = readFileSync(file, 'utf8');
  const { headers, records } = parseCsv(text);
  for (const h of REQUIRED_HEADERS) {
    if (!headers.includes(h)) {
      return {
        ok: false,
        errors: [{ line: 0, message: `CSV 表头缺少必需列 ${h}（实际表头：${headers.join(', ')}）` }],
      };
    }
  }
  const planned = planImport({
    rows: records,
    source,
    roster: store.roster,
    events: store.events,
  });
  if (planned.errors.length) {
    return { ok: false, errors: planned.errors };
  }
  const result = commitImport(store, { source, planned, operator });
  return {
    ok: true,
    batchId: result.batchId,
    appended: result.newEvents.length,
    duplicates: result.duplicateCount,
    newEvents: result.newEvents,
  };
}

export { paths };
