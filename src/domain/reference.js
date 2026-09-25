// 宾客参考名录与桌台：RSVP 事件只能引用名录中已存在的 guestId。
// 关系（同桌/避让）以宾客为载体，按对称关系处理。

export function guestIndex(roster) {
  const m = new Map();
  for (const g of roster.guests || []) m.set(g.guestId, g);
  return m;
}

export function getGuest(roster, guestId) {
  return (roster.guests || []).find((g) => g.guestId === guestId) || null;
}

function symmetricSet(roster, guestId, field) {
  const out = new Set();
  const me = getGuest(roster, guestId);
  if (me && Array.isArray(me[field])) for (const x of me[field]) out.add(x);
  for (const g of roster.guests || []) {
    if (g.guestId === guestId) continue;
    if (Array.isArray(g[field]) && g[field].includes(guestId)) out.add(g.guestId);
  }
  return out;
}

export function sameWithSet(roster, guestId) {
  return symmetricSet(roster, guestId, 'sameWith');
}

export function avoidWithSet(roster, guestId) {
  return symmetricSet(roster, guestId, 'avoidWith');
}

// 计算"同桌组"连通分量：组内宾客在自动排座时必须整体同桌。
export function sameTableGroups(roster) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) {
      const nxt = parent.get(x);
      parent.set(x, r);
      x = nxt;
    }
    return r;
  };
  const union = (a, b) => {
    parent.set(find(a), find(b));
  };

  const ids = new Set((roster.guests || []).map((g) => g.guestId));
  for (const g of roster.guests || []) {
    for (const x of g.sameWith || []) {
      // 忽略指向不存在宾客的关系
      if (ids.has(x)) union(g.guestId, x);
    }
  }
  const groups = new Map();
  for (const id of ids) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  return [...groups.values()].map((members) => members.sort());
}

// 避让对（无向、去重），仅保留双方都存在的关系。
export function avoidPairs(roster) {
  const ids = new Set((roster.guests || []).map((g) => g.guestId));
  const seen = new Set();
  const pairs = [];
  for (const g of roster.guests || []) {
    for (const x of g.avoidWith || []) {
      if (!ids.has(x)) continue;
      const key = [g.guestId, x].sort().join('');
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([g.guestId, x].sort());
    }
  }
  return pairs;
}

export function getTable(tables, tableId) {
  return (tables.tables || []).find((t) => t.tableId === tableId) || null;
}

export function tableCapacity(tables, tableId) {
  const t = getTable(tables, tableId);
  return t ? Number(t.capacity) : 0;
}
