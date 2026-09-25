// 物化器：从"宾客名录 + 事件账本"确定性地重建当前 RSVP 状态。
//
// 规则（与导入顺序无关，只按事件内容重放）：
//  1. 同一宾客的事件按 occurredAt 升序（同刻按 来源/序号/事件号 兜底排序）。
//  2. 较晚发生时间的事件覆盖较早的；较早但后到账的旧事件效果为 superseded，
//     仅保留在宾客历史中，绝不回滚当前确认/待定/婉拒。
//  3. 同一时刻、跨来源的事件：内容一致 -> convergent（冗余，无冲突）；
//     内容不一致 -> conflicted，当前状态停留在上一已生效值并标记为暂定，
//     生成待人工处理条目，系统不选择任何一方。
//  4. 同源同序号的重复事件在导入阶段即被幂等丢弃，不会进入账本。
//  5. 冲突之后若出现更晚时刻的新事实（含人工 resolution），该冲突即告解决，
//     只在历史中留痕；仅"最新时刻且仍被冲突占据"的冲突保持开放。

import { EFFECT } from '../model/constants.js';
import { orderKey } from '../util/time.js';

function payloadKey(e) {
  return [e.kind, e.status, e.partySize ?? 1, e.note ?? ''].join('');
}

function summarize(e) {
  return {
    eventId: e.eventId,
    source: e.source,
    seq: e.seq,
    status: e.status,
    partySize: e.partySize ?? 1,
    note: e.note ?? '',
    occurredAt: e.occurredAt,
    kind: e.kind,
  };
}

function materializeGuest(guest, events) {
  const sorted = [...events].sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : 1));

  // 迟到标记：比某已到账事件发生得更早、却更晚才到账的事件。
  // 到账先后用稳定事件号（追加顺序）判断；仅用于历史提示，不影响物化结果。
  const lateByEventId = new Set();
  const arrivalRank = (e) => Number(String(e.eventId).replace(/^E/, ''));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      // 发生更早（a），却到账更晚 -> a 迟到
      if (a.occurredAtMs < b.occurredAtMs && arrivalRank(a) > arrivalRank(b)) {
        lateByEventId.add(a.eventId);
      } else if (b.occurredAtMs < a.occurredAtMs && arrivalRank(b) > arrivalRank(a)) {
        lateByEventId.add(b.eventId);
      }
    }
  }

  // 按发生时刻分组
  const groups = [];
  for (const e of sorted) {
    let g = groups[groups.length - 1];
    if (!g || g.occurredAtMs !== e.occurredAtMs) {
      g = { occurredAtMs: e.occurredAtMs, occurredAt: e.occurredAt, events: [] };
      groups.push(g);
    }
    g.events.push(e);
  }

  // 正向分组判定
  const classified = groups.map((g) => {
    const distinctKeys = new Set(g.events.map(payloadKey));
    const isCrossSource = new Set(g.events.map((e) => e.source)).size > 1;
    let kind;
    if (g.events.length === 1 || !isCrossSource || distinctKeys.size === 1) {
      kind = 'settles'; // 产生生效值
    } else {
      kind = 'conflict'; // 跨来源同刻且内容不一致
    }
    return { ...g, kind };
  });

  // 倒序收窄：决定每条历史的最终效果
  const effectById = new Map();
  let chosenApplied = false; // 是否已找到最新生效事件
  const openReviews = [];
  for (let i = classified.length - 1; i >= 0; i--) {
    const g = classified[i];
    if (g.kind === 'settles') {
      g.events.forEach((e, idx) => {
        if (idx === 0 && !chosenApplied) {
          effectById.set(e.eventId, EFFECT.APPLIED);
          chosenApplied = true;
        } else if (idx === 0) {
          effectById.set(e.eventId, EFFECT.SUPERSEDED);
        } else {
          effectById.set(e.eventId, EFFECT.CONVERGENT);
        }
      });
    } else {
      // 冲突组：其后已存在生效事实 -> 冲突已被解决，仅留痕；否则保持开放。
      const resolved = chosenApplied;
      for (const e of g.events) {
        effectById.set(e.eventId, resolved ? EFFECT.SUPERSEDED : EFFECT.CONFLICTED);
      }
      if (!resolved) {
        openReviews.push({
          type: 'rsvp_conflict',
          guestId: guest.guestId,
          guestName: guest.name,
          occurredAt: g.occurredAt,
          occurredAtMs: g.occurredAtMs,
          events: g.events.map(summarize),
        });
      }
    }
  }

  // 当前生效事件 = 最新一个 settles 组的首条
  let applied = null;
  for (let i = classified.length - 1; i >= 0; i--) {
    if (classified[i].kind === 'settles') {
      applied = classified[i].events[0];
      break;
    }
  }
  const hasOpenConflict = openReviews.length > 0;

  const history = sorted
    .map((e) => ({
      ...summarize(e),
      receivedAt: e.receivedAt,
      late: lateByEventId.has(e.eventId),
      effect: effectById.get(e.eventId),
    }))
    .reverse(); // 最新在前，便于界面展示

  const state = {
    guestId: guest.guestId,
    name: guest.name,
    child: Boolean(guest.child),
    group: guest.group ?? null,
    currentStatus: applied ? applied.status : null,
    currentPartySize: applied ? applied.partySize ?? 1 : 1,
    currentNote: applied ? applied.note ?? '' : '',
    currentEventId: applied ? applied.eventId : null,
    currentSource: applied ? applied.source : null,
    currentOccurredAt: applied ? applied.occurredAt : null,
    hasConflict: hasOpenConflict,
    statusProvisional: hasOpenConflict, // 冲突未决时，旧值仅为暂定参考
    contending: hasOpenConflict ? openReviews[0].events : [],
    history,
  };
  return { state, reviews: openReviews };
}

export function materialize(roster, events) {
  const byGuest = new Map();
  for (const e of events) {
    if (!byGuest.has(e.guestId)) byGuest.set(e.guestId, []);
    byGuest.get(e.guestId).push(e);
  }

  const guests = [];
  const reviews = [];
  for (const guest of roster.guests || []) {
    const list = byGuest.get(guest.guestId) || [];
    const { state, reviews: gr } = materializeGuest(guest, list);
    guests.push(state);
    reviews.push(...gr);
  }

  const stats = {
    totalGuests: guests.length,
    confirmed: guests.filter((g) => g.currentStatus === 'confirmed' && !g.hasConflict).length,
    pending: guests.filter((g) => g.currentStatus === 'pending' && !g.hasConflict).length,
    declined: guests.filter((g) => g.currentStatus === 'declined' && !g.hasConflict).length,
    noRecord: guests.filter((g) => g.currentStatus === null).length,
    conflicts: guests.filter((g) => g.hasConflict).length,
  };

  return { guests, reviews, stats, generatedAt: new Date().toISOString() };
}

// 便捷：按 guestId 取状态
export function stateIndex(materialized) {
  return new Map(materialized.guests.map((g) => [g.guestId, g]));
}
