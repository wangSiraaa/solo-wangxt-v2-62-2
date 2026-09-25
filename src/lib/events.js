/**
 * 事件流核心：
 *  - 事件账本是唯一事实来源，物化状态（guests[].rsvp）随时可从账本重建
 *  - 幂等键 (source, sourceSeq)：同键同内容 = 重复事件（跳过，不占事件号不占座）；同键异内容 = 非法
 *  - 同一来源内以 sourceSeq 判定新旧：晚到的旧事件只留痕（stale），不覆盖较新状态
 *  - 跨来源状态不一致 = 冲突，物化状态取确定性回退值并挂待人工处理，绝不依赖导入顺序静默覆盖
 */
import { RSVPS, RESOLUTION_SOURCE, MIGRATION_SOURCE } from './store.js';

export const VALIDATION_ERRORS = {
  UNKNOWN_GUEST: 'UNKNOWN_GUEST',
  BAD_STATUS: 'BAD_STATUS',
  BAD_PARTY: 'BAD_PARTY',
  BAD_CHILDREN: 'BAD_CHILDREN',
  BAD_OCCURRED_AT: 'BAD_OCCURRED_AT',
  BAD_SOURCE: 'BAD_SOURCE',
  BAD_SEQ: 'BAD_SEQ',
  REPLAY_CONFLICT: 'REPLAY_CONFLICT', // 同 (source, sourceSeq) 不同内容
  HEADER: 'HEADER',
};

const fpFields = (e) => [
  e.status,
  e.partySize ?? '',
  e.children ?? 0,
  e.childSeatNeeded ? 1 : 0,
].join('|');

/** 事件内容指纹：判重与裁决有效性都基于它，而不是 occurredAt（离线表格可能补录时间） */
export const fingerprint = (e) => fpFields(e);

export function emptyGuestRsvp() {
  return null;
}

function winnerOf(events) {
  // 同来源以 sourceSeq 最大者为最新（不依赖导入顺序）
  return events.reduce((a, b) => (b.sourceSeq > a.sourceSeq ? b : a), events[0]);
}

/** 全量重算所有宾客的物化 RSVP（从账本重建，排座等其余状态不动） */
export function recomputeAllRsvp(store) {
  const perGuest = new Map();
  for (const e of store.events) {
    if (e.type !== 'rsvp') continue;
    if (!perGuest.has(e.guestId)) perGuest.set(e.guestId, new Map());
    const bySource = perGuest.get(e.guestId);
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source).push(e);
  }
  for (const [guestId, bySource] of perGuest) {
    recomputeGuest(store, guestId, bySource);
  }
  return store;
}

function recomputeGuest(store, guestId, bySourceMaybe) {
  const guest = store.guests[guestId];
  if (!guest) return;
  const bySource = bySourceMaybe ?? collectBySource(store, guestId);
  const winners = [];
  let resolution = null;
  let migration = null;
  for (const [source, evs] of bySource) {
    if (source === RESOLUTION_SOURCE) { resolution = winnerOf(evs); continue; }
    if (source === MIGRATION_SOURCE) { migration = winnerOf(evs); continue; }
    winners.push(winnerOf(evs));
  }
  winners.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));

  const base = {
    status: null,
    source: null,
    partySize: null,
    children: null,
    childSeatNeeded: false,
    occurredAt: null,
    eventNo: null,
    conflict: null,
  };
  if (winners.length === 0) {
    // 没有任何活来源事件时，迁移基线（旧系统最后编辑值）作为初始物化状态
    if (migration) {
      guest.rsvp = {
        ...base,
        status: migration.status, source: migration.source, eventNo: migration.eventNo,
        partySize: migration.partySize ?? null, children: migration.children ?? 0,
        childSeatNeeded: !!migration.childSeatNeeded, occurredAt: migration.occurredAt,
      };
    } else {
      guest.rsvp = base;
    }
    return;
  }

  const fingerprints = new Set(winners.map(fpFields));
  let chosen;
  let conflict = null;

  if (fingerprints.size === 1) {
    chosen = winners[0];
  } else if (resolution && isResolutionStillValid(resolution, winners)) {
    chosen = winners.find((w) => w.source === resolution.payload.winSource) || winners[0];
  } else {
    // 跨来源冲突：确定性回退（来源名字典序最小），显式挂待人工处理
    chosen = winners[0];
    conflict = {
      kind: resolution ? 'resolution-stale' : 'cross-source',
      winners: winners.map((w) => ({
        source: w.source,
        eventNo: w.eventNo,
        sourceSeq: w.sourceSeq,
        occurredAt: w.occurredAt,
        fingerprint: fpFields(w),
      })),
      resolution: resolution
        ? { eventNo: resolution.eventNo, winSource: resolution.payload.winSource }
        : null,
      reason: resolution
        ? '裁决之后某来源又出现了更新的状态，请重新人工确认'
        : '不同来源给出的最新 RSVP 不一致，需人工裁决，自动排座已暂时排除该宾客',
    };
  }

  guest.rsvp = {
    ...base,
    status: chosen.status,
    source: chosen.source,
    partySize: chosen.partySize ?? null,
    children: chosen.children ?? 0,
    childSeatNeeded: !!chosen.childSeatNeeded,
    occurredAt: chosen.occurredAt,
    eventNo: chosen.eventNo,
    conflict,
  };
}

/** 裁决只在“裁决时各来源最新内容均未再变化”时有效；任一新事件都会让冲突重新挂起 */
function isResolutionStillValid(resolution, winners) {
  const snapshot = resolution.payload.winnerFingerprints;
  if (!snapshot) return false;
  if (snapshot.length !== winners.length) return false;
  const now = new Map(winners.map((w) => [w.source, fpFields(w)]));
  return snapshot.every(({ source, fingerprint }) => now.get(source) === fingerprint);
}

function collectBySource(store, guestId) {
  const bySource = new Map();
  for (const e of store.events) {
    if (e.type !== 'rsvp' || e.guestId !== guestId) continue;
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source).push(e);
  }
  return bySource;
}

/**
 * 预检整批导入。返回 { errors: [{line,code,message}] }。
 * 规则：未知宾客/非法状态/非法人数/非法顺序……任一行错误即整批拒绝。
 * rows: [{source, sourceSeq, guestId, status, partySize, children, childSeatNeeded, occurredAt, __line}]
 */
export function validateBatch(store, rows) {
  const errors = [];
  const knownGuests = new Set(Object.keys(store.guests));
  const seenInBatch = new Map(); // source#seq -> fp
  const existing = new Map();    // source#seq -> fp
  for (const e of store.events) {
    if (e.type !== 'rsvp') continue;
    existing.set(`${e.source}#${e.sourceSeq}`, fpFields(e));
  }

  for (const r of rows) {
    const line = r.__line;
    const key = `${r.source}#${r.sourceSeq}`;
    const fp = fpFields(r);

    if (!r.source || r.source === RESOLUTION_SOURCE || r.source === MIGRATION_SOURCE) {
      errors.push({ line, code: VALIDATION_ERRORS.BAD_SOURCE, message: `来源非法或被保留: "${r.source}"` });
    }
    if (!Number.isInteger(r.sourceSeq) || r.sourceSeq < 1) {
      errors.push({ line, code: VALIDATION_ERRORS.BAD_SEQ, message: `来源内序号必须为 >=1 的整数，收到: "${r.rawSeq}"` });
    }
    if (!knownGuests.has(r.guestId)) {
      errors.push({ line, code: VALIDATION_ERRORS.UNKNOWN_GUEST, message: `未知宾客: "${r.rawGuest}"` });
    }
    if (!RSVPS.includes(r.status)) {
      errors.push({ line, code: VALIDATION_ERRORS.BAD_STATUS, message: `状态必须是 confirmed/pending/declined，收到: "${r.rawStatus}"` });
    }
    if (r.partySize !== null && (!Number.isInteger(r.partySize) || r.partySize < 1)) {
      errors.push({ line, code: VALIDATION_ERRORS.BAD_PARTY, message: `人数必须为正整数，收到: "${r.rawParty}"` });
    }
    if (r.status === 'confirmed' && (r.partySize === null || (r.children ?? 0) > r.partySize)) {
      errors.push({ line, code: VALIDATION_ERRORS.BAD_PARTY, message: '确认出席需给出 >=1 的人数，且儿童数不能超过总人数' });
    }
    if (r.children !== null && (!Number.isInteger(r.children) || r.children < 0)) {
      errors.push({ line, code: VALIDATION_ERRORS.BAD_CHILDREN, message: `儿童数必须为非负整数，收到: "${r.rawChildren}"` });
    }
    if (!r.occurredAt || Number.isNaN(Date.parse(r.occurredAt))) {
      errors.push({ line, code: VALIDATION_ERRORS.BAD_OCCURRED_AT, message: `发生时间无法解析: "${r.rawOccurredAt}"` });
    }

    if (existing.has(key)) {
      if (existing.get(key) !== fp) {
        errors.push({ line, code: VALIDATION_ERRORS.REPLAY_CONFLICT, message: `非法顺序：${r.source} 序号 ${r.sourceSeq} 已存在且内容不同（重放冲突）` });
      }
    } else if (seenInBatch.has(key)) {
      if (seenInBatch.get(key) !== fp) {
        errors.push({ line, code: VALIDATION_ERRORS.REPLAY_CONFLICT, message: `非法顺序：同批中 ${r.source} 序号 ${r.sourceSeq} 出现且内容不同` });
      }
    } else {
      seenInBatch.set(key, fp);
    }
  }
  return { errors };
}

/**
 * 追加整批事件（调用前必须先通过 validateBatch）。
 * 返回 { accepted, duplicates, stale, conflictGuests:[{guestId,kind}] }。
 * 重复事件不分配事件号、不改变任何状态（重复导入不重复占座的基础）。
 */
export function appendBatch(store, rows, nowIso = new Date().toISOString()) {
  const seenFp = new Map(); // source#seq -> fp（账本已有，用于幂等判重）
  for (const e of store.events) {
    if (e.type !== 'rsvp') continue;
    seenFp.set(`${e.source}#${e.sourceSeq}`, fpFields(e));
  }

  const accepted = [];
  const duplicates = [];
  const stale = [];
  const batchSeen = new Set();
  const touched = new Set();

  // 各来源对各宾客已知的最大序号（账本 + 本批），用于判定迟到旧事件；
  // 不依赖批内行序：哪怕旧行排在新行之后导入，照样能识别为留痕。
  const maxSeqPerGuest = new Map();
  const bump = (source, guestId, seq) => {
    const gk = `${source}#${guestId}`;
    maxSeqPerGuest.set(gk, Math.max(maxSeqPerGuest.get(gk) ?? 0, seq));
  };
  for (const e of store.events) {
    if (e.type !== 'rsvp' || e.source === RESOLUTION_SOURCE) continue;
    bump(e.source, e.guestId, e.sourceSeq);
  }
  for (const r of rows) bump(r.source, r.guestId, r.sourceSeq);

  // 批内按 (source, sourceSeq) 去重后再按事件号顺序（导入顺序）处理
  const uniq = new Map();
  for (const r of rows) {
    const key = `${r.source}#${r.sourceSeq}`;
    if (!uniq.has(key)) uniq.set(key, r);
  }
  const sorted = [...uniq.values()];

  for (const r of sorted) {
    const key = `${r.source}#${r.sourceSeq}`;
    const fp = fpFields(r);
    if (seenFp.has(key) && seenFp.get(key) === fp) { duplicates.push({ key, guestId: r.guestId }); continue; }
    if (batchSeen.has(key)) { duplicates.push({ key, guestId: r.guestId }); continue; }
    batchSeen.add(key);

    const gk = `${r.source}#${r.guestId}`;
    const isStale = r.sourceSeq < (maxSeqPerGuest.get(gk) ?? 0);

    const event = {
      eventNo: ++store.counters.eventNo,
      type: 'rsvp',
      source: r.source,
      sourceSeq: r.sourceSeq,
      guestId: r.guestId,
      status: r.status,
      partySize: r.partySize,
      children: r.children ?? 0,
      childSeatNeeded: !!r.childSeatNeeded,
      occurredAt: r.occurredAt,
      recordedAt: nowIso,
      stale: isStale,
      supersededBy: null, // 重算时可回填：被本来源哪个更大序号覆盖
    };
    store.events.push(event);
    seenFp.set(key, fp);
    touched.add(r.guestId);
    accepted.push(event);
    if (isStale) stale.push({ eventNo: event.eventNo, guestId: r.guestId, source: r.source, sourceSeq: r.sourceSeq });
  }

  // 回填留痕信息：每条非最新事件指向覆盖它的最新事件
  markSuperseded(store);
  recomputeAllRsvp(store);

  const conflictGuests = [...touched].filter((g) => store.guests[g]?.rsvp?.conflict)
    .map((g) => ({ guestId: g, kind: store.guests[g].rsvp.conflict.kind }));

  return { accepted: accepted.map((e) => e.eventNo), duplicates: duplicates.length, stale, conflictGuests };
}

export function markSuperseded(store) {
  const latest = new Map();
  for (const e of store.events) {
    if (e.type !== 'rsvp' || e.source === RESOLUTION_SOURCE) continue;
    const k = `${e.source}#${e.guestId}`;
    const cur = latest.get(k);
    if (!cur || e.sourceSeq > cur.sourceSeq) latest.set(k, e);
  }
  for (const e of store.events) {
    if (e.type !== 'rsvp' || e.source === RESOLUTION_SOURCE) continue;
    const k = `${e.source}#${e.guestId}`;
    const top = latest.get(k);
    e.supersededBy = top && top.eventNo !== e.eventNo ? top.eventNo : null;
  }
}

/** 人工裁决跨来源冲突；裁决本身也是账本事件，之后被新事件推翻会自动重新挂起 */
export function resolveConflict(store, guestId, winSource, note = '', nowIso = new Date().toISOString()) {
  const guest = store.guests[guestId];
  if (!guest) throw new Error(`未知宾客: ${guestId}`);
  const bySource = collectBySource(store, guestId);
  const winners = [...bySource.entries()]
    .filter(([s]) => s !== RESOLUTION_SOURCE && s !== MIGRATION_SOURCE)
    .map(([, evs]) => winnerOf(evs));
  if (winners.length === 0) throw new Error(`${guestId} 还没有任何 RSVP 事件，无法裁决`);
  const w = winners.find((x) => x.source === winSource);
  if (!w) throw new Error(`来源 ${winSource} 对 ${guestId} 没有事件，无法选为裁决结果`);

  const seqKey = RESOLUTION_SOURCE;
  const nextSeq = (store.counters.sourceSeq[seqKey] ?? 0) + 1;
  store.counters.sourceSeq[seqKey] = nextSeq;
  const event = {
    eventNo: ++store.counters.eventNo,
    type: 'rsvp',
    source: RESOLUTION_SOURCE,
    sourceSeq: nextSeq,
    guestId,
    status: w.status,
    partySize: w.partySize ?? null,
    children: w.children ?? 0,
    childSeatNeeded: !!w.childSeatNeeded,
    occurredAt: nowIso,
    recordedAt: nowIso,
    stale: false,
    supersededBy: null,
    payload: {
      kind: 'resolve-conflict',
      winSource,
      winnerFingerprint: fpFields(w),
      winnerFingerprints: winners
        .sort((a, b) => (a.source < b.source ? -1 : 1))
        .map((x) => ({ source: x.source, fingerprint: fpFields(x) })),
      note,
    },
  };
  store.events.push(event);
  recomputeAllRsvp(store);
  return event;
}

/** 宾客事件历史（含留痕/重复信息），供“宾客历史/影响提示”界面 */
export function guestHistory(store, guestId) {
  return store.events
    .filter((e) => e.type === 'rsvp' && e.guestId === guestId)
    .sort((a, b) => b.eventNo - a.eventNo)
    .map((e) => ({
      eventNo: e.eventNo,
      source: e.source,
      sourceSeq: e.sourceSeq,
      status: e.status,
      partySize: e.partySize,
      children: e.children ?? 0,
      childSeatNeeded: !!e.childSeatNeeded,
      occurredAt: e.occurredAt,
      recordedAt: e.recordedAt,
      stale: !!e.stale,
      supersededBy: e.supersededBy ?? null,
      isResolution: e.source === RESOLUTION_SOURCE,
      note: e.payload?.note ?? '',
    }));
}
