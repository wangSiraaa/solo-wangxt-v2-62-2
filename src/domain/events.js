// 事件构建。事件号 eventId 在账本内按追加顺序分配，稳定且不重用。
// 事件的天然身份是 (source, seq)——同一来源内序号唯一。

import { createHash } from 'node:crypto';
import {
  EVENT_KIND_RSVP,
  EVENT_KIND_RESOLUTION,
  SOURCE_MANUAL,
} from '../model/constants.js';

export function nextEventId(existingCount) {
  return `E${String(existingCount + 1).padStart(6, '0')}`;
}

export function payloadFingerprint(evt) {
  const canonical = JSON.stringify({
    kind: evt.kind,
    guestId: evt.guestId,
    status: evt.status,
    partySize: evt.partySize ?? 1,
    note: evt.note ?? '',
    occurredAt: evt.occurredAt,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function buildRsvpEvent(
  { guestId, source, seq, status, partySize, note, occurredAt, occurredAtMs },
  { eventId, receivedAt, receivedAtMs },
) {
  return {
    eventId,
    kind: EVENT_KIND_RSVP,
    guestId,
    source,
    seq,
    status,
    partySize: partySize ?? 1,
    note: note ?? '',
    occurredAt,
    occurredAtMs,
    receivedAt,
    receivedAtMs,
  };
}

// 人工解决冲突：以 resolution 事件落账，来源固定为 manual，序号由账本游标分配。
export function buildResolutionEvent(
  { guestId, status, partySize, note, occurredAt, occurredAtMs },
  { eventId, seq, receivedAt, receivedAtMs },
) {
  return {
    eventId,
    kind: EVENT_KIND_RESOLUTION,
    guestId,
    source: SOURCE_MANUAL,
    seq,
    status,
    partySize: partySize ?? 1,
    note: note ?? '',
    occurredAt,
    occurredAtMs,
    receivedAt,
    receivedAtMs,
  };
}
