/**
 * 本地存储：单个 JSON 文件（v2）。
 * 事件账本（events + counters）与当前物化状态（guests 上的 rsvp、tables、assignments）
 * 在同一次原子写中落盘 —— 批量导入要么整批生效，要么完全不留痕。
 */
import { readJson, writeJsonAtomic } from './fsutil.js';

export const SCHEMA_VERSION = 2;
export const DEFAULT_STORE_PATH = 'data/rsvp-store.json';

/** 保留来源：迁移基线与人工裁决，导入时禁止外部表格占用 */
export const MIGRATION_SOURCE = 'migration';
export const RESOLUTION_SOURCE = 'manual-resolution';
export const RSVPS = ['confirmed', 'pending', 'declined'];

export function emptyStore() {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    counters: { eventNo: 0, sourceSeq: {} },
    events: [],
    guests: {},
    tables: {},
    tableOrder: [],
    assignments: {}, // guestId -> { tableId, locked }
    sameGroups: [],  // [ [guestId, ...], ... ]
    avoidPairs: [],  // [ [a, b], ... ]
  };
}

export function loadStore(file = DEFAULT_STORE_PATH) {
  const store = readJson(file, null);
  if (!store) return null;
  if (store.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`不支持的数据版本 schemaVersion=${store.schemaVersion}（期望 ${SCHEMA_VERSION}），请先运行 migrate`);
  }
  return store;
}

export function saveStore(file, store) {
  writeJsonAtomic(file, store);
}

/** 物化状态可随时从事件账本完整重建（账本是唯一事实来源） */
import { recomputeAllRsvp } from './events.js';

export function rebuildMaterialized(store) {
  for (const g of Object.values(store.guests)) g.rsvp = null;
  recomputeAllRsvp(store);
  return store;
}
