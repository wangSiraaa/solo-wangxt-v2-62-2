// 排座领域：席位物化状态、变更影响分析、自动排座候选（只出方案不动席位）。
//
// 关键边界：
//  - RSVP 变化（确认/待定/婉拒）绝不自动移动任何席位；系统只给出"受影响清单"。
//  - 自动排座仅处理"已确认、无冲突、未排座"的宾客；锁定席、同桌/避让、儿童椅
//    在方案中全部保留与满足，不满足时明确列入 unsatisfiable，绝不强塞。

import { STATUS } from '../model/constants.js';
import {
  getGuest,
  sameTableGroups,
  avoidPairs,
  getTable,
  tableCapacity,
} from './reference.js';
import { stateIndex } from './materializer.js';

// ---- 基础查询 ----

export function assignmentByGuest(seating) {
  const m = new Map();
  for (const a of seating.assignments || []) m.set(a.guestId, a);
  return m;
}

export function assignmentsAtTable(seating, tableId) {
  return (seating.assignments || []).filter((a) => a.tableId === tableId);
}

export function tableOccupancy(tables, seating, tableId) {
  return assignmentsAtTable(seating, tableId).length;
}

export function nextSeatNumber(seating, tableId) {
  const used = assignmentsAtTable(seating, tableId).map((a) => a.seatNumber);
  let n = 1;
  while (used.includes(n)) n++;
  return n;
}

export function isGuestSeated(seating, guestId) {
  return (seating.assignments || []).some((a) => a.guestId === guestId);
}

// ---- 变更影响分析 ----
// 输入最新物化状态 + 当前席位，输出受影响清单。只报告，不动席位。

export function analyzeImpact(materialized, seating, tables, roster) {
  const idx = stateIndex(materialized);
  const amap = assignmentByGuest(seating);

  const seatedDeclined = [];
  const seatedPending = [];
  const seatedConflicted = [];
  const lockedDeclined = [];

  for (const a of seating.assignments || []) {
    const st = idx.get(a.guestId);
    if (!st) continue;
    const guest = getGuest(roster, a.guestId);
    const entry = {
      guestId: a.guestId,
      guestName: st.name,
      tableId: a.tableId,
      seatNumber: a.seatNumber,
      locked: Boolean(a.locked),
      child: Boolean(st.child),
      status: st.currentStatus,
      statusProvisional: st.statusProvisional,
    };
    if (st.hasConflict) {
      seatedConflicted.push(entry);
    } else if (st.currentStatus === STATUS.DECLINED) {
      seatedDeclined.push(entry);
      if (a.locked) lockedDeclined.push(entry);
    } else if (st.currentStatus === STATUS.PENDING) {
      seatedPending.push(entry);
    }
  }

  // 同桌关系传递：婉拒者所在同桌组若有人已排座，提示组完整性可能受影响。
  const sameGroups = sameTableGroups(roster);
  const declinedIds = new Set(seatedDeclined.map((e) => e.guestId));
  const groupWarnings = [];
  for (const grp of sameGroups) {
    const declinedInGroup = grp.filter((id) => declinedIds.has(id));
    if (declinedInGroup.length === 0) continue;
    const seatedOthers = grp.filter(
      (id) => !declinedIds.has(id) && amap.has(id),
    );
    if (seatedOthers.length) {
      groupWarnings.push({
        type: 'same_group_affected',
        group: grp,
        declinedGuests: declinedInGroup,
        stillSeated: seatedOthers.map((id) => ({
          guestId: id,
          ...amap.get(id),
        })),
        message: `婉拒宾客与仍在席宾客存在同桌关系，释放席位前请人工确认组安排`,
      });
    }
  }

  // 新的自动候选仅统计人数与名单，具体方案见 proposeSeating。
  const unassignedConfirmed = materialized.guests.filter(
    (g) =>
      g.currentStatus === STATUS.CONFIRMED &&
      !g.hasConflict &&
      !amap.has(g.guestId),
  );

  const pendingReview = [];
  for (const e of lockedDeclined) {
    pendingReview.push({
      type: 'locked_seat_declined',
      guestId: e.guestId,
      guestName: e.guestName,
      tableId: e.tableId,
      seatNumber: e.seatNumber,
      message: `宾客已婉拒但席位锁定，系统不移动该席位，请人工处理`,
    });
  }
  for (const e of seatedConflicted) {
    pendingReview.push({
      type: 'seated_conflicted',
      guestId: e.guestId,
      guestName: e.guestName,
      tableId: e.tableId,
      seatNumber: e.seatNumber,
      message: `宾客 RSVP 跨来源冲突未决且已排座，请先解决冲突`,
    });
  }

  return {
    seatedDeclined,
    lockedDeclined,
    seatedPending,
    seatedConflicted,
    groupWarnings,
    unassignedConfirmed: unassignedConfirmed.map((g) => ({
      guestId: g.guestId,
      name: g.name,
      child: g.child,
    })),
    pendingReview,
    note: '系统不会自动移动任何席位；以下仅为受影响清单与候选信息。',
  };
}

// ---- 自动排座方案（纯计算，不修改任何数据）----

export function proposeSeating({ roster, tables, materialized, seating }) {
  const amap = assignmentByGuest(seating);
  const idx = stateIndex(materialized);

  // 输入边界分类
  const excluded = {
    notConfirmed: [],
    conflicted: [],
    alreadySeated: [],
    notInRoster: [],
  };
  const eligibleIds = new Set();
  for (const g of materialized.guests) {
    if (amap.has(g.guestId)) {
      excluded.alreadySeated.push({ guestId: g.guestId, name: g.name });
      continue;
    }
    if (g.hasConflict) {
      excluded.conflicted.push({ guestId: g.guestId, name: g.name });
      continue;
    }
    if (g.currentStatus !== STATUS.CONFIRMED) {
      excluded.notConfirmed.push({
        guestId: g.guestId,
        name: g.name,
        status: g.currentStatus,
      });
      continue;
    }
    eligibleIds.add(g.guestId);
  }

  // 避让对
  const allAvoidPairs = avoidPairs(roster);

  // 同桌组：组内若混入任何不可自动排座的宾客，整组不自动拆分。
  const groups = sameTableGroups(roster);
  const planGroups = [];
  const unsatisfiable = [];
  const consumedEligible = new Set();

  for (const grp of groups) {
    const members = grp.filter((id) => idx.has(id)); // 名录内
    const eligibleMembers = members.filter((id) => eligibleIds.has(id));
    if (eligibleMembers.length === 0) continue;

    // 组内自相矛盾：既要求同桌又要求避让
    const internalAvoid = allAvoidPairs.filter(
      ([x, y]) => members.includes(x) && members.includes(y),
    );
    if (internalAvoid.length) {
      unsatisfiable.push({
        type: 'same_group_internal_avoid',
        group: members,
        pairs: internalAvoid,
        message: `同桌组内部存在避让关系，约束互相矛盾，需人工处理`,
      });
      eligibleMembers.forEach((id) => consumedEligible.add(id));
      continue;
    }

    // 边界：组内已有成员入座（无论锁定与否）时，自动排座不得把其余成员
    // "悄悄"补到该桌——那会改动既有安排。整组转人工处理。
    const seatedMembers = members.filter((id) => amap.has(id));
    if (seatedMembers.length > 0) {
      const unseatedEligible = eligibleMembers.filter((id) => !amap.has(id));
      if (unseatedEligible.length > 0) {
        unsatisfiable.push({
          type: 'same_group_partly_seated',
          group: members,
          seatedMembers,
          unseatedEligible,
          message: `同桌组已有成员入座，自动排座不向既有安排补位，请人工统一调整`,
        });
      }
      unseatedEligible.forEach((id) => consumedEligible.add(id));
      continue;
    }

    const blockers = members.filter((id) => !eligibleIds.has(id) && !amap.has(id));
    if (blockers.length > 0) {
      unsatisfiable.push({
        type: 'same_group_blocked',
        group: members,
        eligibleMembers,
        blockedBy: blockers.map((id) => {
          let reason = 'not_eligible';
          if (amap.has(id)) reason = 'already_seated';
          else if (idx.get(id)?.hasConflict) reason = 'conflicted';
          else if (idx.get(id)?.currentStatus !== STATUS.CONFIRMED)
            reason = `status_${idx.get(id)?.currentStatus ?? 'none'}`;
          return { guestId: id, name: idx.get(id)?.name ?? id, reason };
        }),
        message: `同桌组含已排座/非确认/冲突宾客，自动排座不拆分该组`,
      });
      eligibleMembers.forEach((id) => consumedEligible.add(id));
      continue;
    }
    planGroups.push(members);
    members.forEach((id) => consumedEligible.add(id));
  }
  // 没有同桌关系的散客，各自成组
  for (const id of eligibleIds) {
    if (!consumedEligible.has(id)) planGroups.push([id]);
  }

  // 模拟占用：在既有（含锁定）席位之上加位
  const occupied = new Map(); // tableId -> Set(guestId)
  for (const a of seating.assignments || []) {
    if (!occupied.has(a.tableId)) occupied.set(a.tableId, new Set());
    occupied.get(a.tableId).add(a.guestId);
  }

  const proposals = [];
  const groupSize = (grp) => grp.length;
  const sortedGroups = [...planGroups].sort((a, b) =>
    groupSize(b) - groupSize(a) === 0
      ? a.join(',').localeCompare(b.join(','))
      : groupSize(b) - groupSize(a),
  );
  const tableList = [...(tables.tables || [])].sort((a, b) =>
    a.capacity === b.capacity
      ? a.tableId.localeCompare(b.tableId)
      : b.capacity - a.capacity,
  );

  for (const grp of sortedGroups) {
    const size = grp.length;
    let placed = null;
    for (const table of tableList) {
      const occ = (occupied.get(table.tableId) || new Set()).size;
      if (occ + size > table.capacity) continue;
      // 避让检查
      const hitPair = allAvoidPairs.find(([x, y]) => {
        const inGroup = grp.includes(x) || grp.includes(y);
        if (!inGroup) return false;
        const atTable = occupied.get(table.tableId) || new Set();
        const other = grp.includes(x) ? y : x;
        return atTable.has(other);
      });
      if (hitPair) continue;
      placed = table.tableId;
      break;
    }
    if (!placed) {
      unsatisfiable.push({
        type: 'no_feasible_table',
        group: grp,
        size,
        childCount: grp.filter((id) => getGuest(roster, id)?.child).length,
        message: `无桌可同时容纳该组（容量或避让约束不满足），需人工处理`,
      });
      continue;
    }
    if (!occupied.has(placed)) occupied.set(placed, new Set());
    for (const id of grp) {
      const st = idx.get(id);
      occupied.get(placed).add(id);
      proposals.push({
        guestId: id,
        guestName: st?.name ?? id,
        tableId: placed,
        child: Boolean(getGuest(roster, id)?.child),
      });
    }
  }

  // 儿童椅统计
  const childChairs = {};
  for (const pr of proposals) {
    if (pr.child) childChairs[pr.tableId] = (childChairs[pr.tableId] || 0) + 1;
  }

  return {
    generatedFrom: {
      confirmedEligible: materialized.guests.filter((g) =>
        eligibleIds.has(g.guestId),
      ).length,
      alreadySeated: (seating.assignments || []).length,
    },
    boundary: {
      excluded,
      rule:
        '自动排座仅纳入：名录内、RSVP 已确认且无跨来源冲突、当前未排座的宾客；同桌组必须整体放置；已有席位（含锁定席）一律不动。',
    },
    proposals,
    childChairs,
    unsatisfiable,
    willMoveSeats: false,
    requiresApproval: true,
  };
}

// ---- 席位变更（显式人工操作；审计由服务层 app.js 统一落盘）----

export function lockSeat(store, { guestId, reason = '', at = null }) {
  const a = (store.seating.assignments || []).find((x) => x.guestId === guestId);
  if (!a) throw new Error(`宾客 ${guestId} 当前未排座，无法锁定`);
  a.locked = true;
  a.lockReason = reason || a.lockReason || '';
  if (at) a.lockedAt = at;
  return a;
}

export function unlockSeat(store, { guestId }) {
  const a = (store.seating.assignments || []).find((x) => x.guestId === guestId);
  if (!a) throw new Error(`宾客 ${guestId} 当前未排座`);
  a.locked = false;
  a.lockReason = '';
  return a;
}

// 释放席位：锁定席需先 unlock；婉拒宾客的席位释放后产生空位（供下一轮候选）。
export function releaseSeat(store, { guestId, at, operator = '', reason = '' }) {
  const all = store.seating.assignments || [];
  const a = all.find((x) => x.guestId === guestId);
  if (!a) throw new Error(`宾客 ${guestId} 当前未排座`);
  if (a.locked) {
    throw new Error(`席位已锁定（${a.tableId}-${a.seatNumber}），请先显式解锁再释放`);
  }
  store.seating.assignments = all.filter((x) => x.guestId !== guestId);
  store.seating.revision += 1;
  return { removed: { ...a }, at, operator, reason };
}

// 应用一份候选方案：只允许涉及"当前未排座"宾客；任何冲突即整体拒绝。
export function applyProposal(store, { proposal, at, operator = '' }) {
  const existing = new Set((store.seating.assignments || []).map((a) => a.guestId));
  for (const p of proposal.proposals) {
    if (existing.has(p.guestId)) {
      throw new Error(`宾客 ${p.guestId} 已有席位；候选方案不得移动既有席位，整体拒绝`);
    }
    const cap = tableCapacity(store.tables, p.tableId);
    if (!cap) throw new Error(`未知桌台 ${p.tableId}`);
  }
  // 桌内容量二次校验（考虑本方案自身的叠加）
  const perTable = new Map();
  for (const a of store.seating.assignments || [])
    perTable.set(a.tableId, (perTable.get(a.tableId) || 0) + 1);
  for (const p of proposal.proposals)
    perTable.set(p.tableId, (perTable.get(p.tableId) || 0) + 1);
  for (const [tableId, n] of perTable) {
    if (n > tableCapacity(store.tables, tableId)) {
      throw new Error(`桌 ${tableId} 将超容量（${n}），整体拒绝`);
    }
  }

  const added = [];
  for (const p of proposal.proposals) {
    const seatNumber = nextSeatNumber(store.seating, p.tableId);
    const a = {
      guestId: p.guestId,
      tableId: p.tableId,
      seatNumber,
      locked: false,
      child: p.child,
      assignedAt: at,
      assignedBy: operator || 'auto-proposal',
    };
    store.seating.assignments.push(a);
    added.push(a);
  }
  store.seating.revision += 1;
  store.seating.lastAutoAppliedAt = at;
  return { added, revision: store.seating.revision };
}

// 手工直接安排单个宾客（用于儿童椅/特殊安排），同样不允许覆盖既有席位。
export function assignSeat(store, { guestId, tableId, seatNumber = null, locked = false, at, operator = '' }) {
  const all = store.seating.assignments || [];
  if (all.some((a) => a.guestId === guestId))
    throw new Error(`宾客 ${guestId} 已有席位，请先释放`);
  if (!getTable(store.tables, tableId)) throw new Error(`未知桌台 ${tableId}`);
  const cap = tableCapacity(store.tables, tableId);
  if (all.filter((a) => a.tableId === tableId).length >= cap)
    throw new Error(`桌 ${tableId} 已满`);
  const seat = seatNumber ?? nextSeatNumber(store.seating, tableId);
  if (all.some((a) => a.tableId === tableId && a.seatNumber === seat))
    throw new Error(`桌 ${tableId} 的 ${seat} 号座位已被占用`);
  const guest = getGuest(store.roster, guestId);
  const a = {
    guestId,
    tableId,
    seatNumber: seat,
    locked,
    child: Boolean(guest?.child),
    assignedAt: at,
    assignedBy: operator || 'manual',
  };
  store.seating.assignments.push(a);
  store.seating.revision += 1;
  return a;
}
