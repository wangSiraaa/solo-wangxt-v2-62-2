// 本地持久化（零依赖 JSON / JSONL 文件，原子写）。
//
// 目录结构：
//   home/meta.json      运行元数据（schema 版本、来源游标）
//   home/ledger.jsonl   事件账本（只追加，一行一事件）
//   home/roster.json    宾客参考名录（guestId -> 宾客属性）
//   home/tables.json    桌台定义
//   home/seating.json   当前席位分配（物化的排座状态，独立于 RSVP 账本）
//   home/audit.jsonl    排座操作审计（只追加）
//   home/imports/<id>.json  每次导入批次的留痕（含被幂等丢弃的重复事件）

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';

export const FILES = Object.freeze({
  META: 'meta.json',
  LEDGER: 'ledger.jsonl',
  ROSTER: 'roster.json',
  TABLES: 'tables.json',
  SEATING: 'seating.json',
  AUDIT: 'audit.jsonl',
});

export function resolveHome(home) {
  return home || process.env.RSVP_HOME || join(process.cwd(), 'data');
}

export function paths(home) {
  const h = resolveHome(home);
  return {
    home: h,
    meta: join(h, FILES.META),
    ledger: join(h, FILES.LEDGER),
    roster: join(h, FILES.ROSTER),
    tables: join(h, FILES.TABLES),
    seating: join(h, FILES.SEATING),
    audit: join(h, FILES.AUDIT),
    importsDir: join(h, 'imports'),
  };
}

export function ensureHome(home) {
  const p = paths(home);
  mkdirSync(p.importsDir, { recursive: true });
  return p;
}

export function readJson(path, fallback) {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`文件不存在：${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`文件为空：${path}`);
  }
  return JSON.parse(raw);
}

export function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (t) out.push(JSON.parse(t));
  }
  return out;
}

export function appendJsonl(path, items) {
  if (items.length === 0) return;
  const chunk = items.map((e) => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(path, chunk, 'utf8');
}

export function listBatchFiles(home) {
  const dir = paths(home).importsDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(dir, f));
}

// ---- 高层装载 ----

export function loadAll(home) {
  const p = paths(home);
  return {
    p,
    meta: readJson(p.meta, null),
    events: readJsonl(p.ledger),
    roster: readJson(p.roster, { guests: [] }),
    tables: readJson(p.tables, { tables: [] }),
    seating: readJson(p.seating, { revision: 0, assignments: [] }),
    audit: readJsonl(p.audit),
  };
}
