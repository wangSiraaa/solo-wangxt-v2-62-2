// 时间工具：事件 occurredAt 统一使用 ISO 8601（毫秒精度，UTC）。
// 比较以 epoch millis 为准；同毫秒视为"同一时刻"，跨来源时可能构成冲突。

export function parseTime(value, field = 'occurredAt') {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`${field} 不能为空（需要 ISO 8601，如 2026-09-24T10:00:00Z）`);
  }
  const text = String(value).trim();
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    throw new Error(`${field} 不是合法的 ISO 8601 时间：${text}`);
  }
  return { raw: text, ms };
}

export function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

// 稳定的全序键：先按发生时间，再按（来源、序号、事件号）。
export function orderKey(e) {
  return [
    String(e.occurredAtMs).padStart(16, '0'),
    e.source,
    String(e.seq).padStart(12, '0'),
    e.eventId,
  ].join('|');
}
