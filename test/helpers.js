// 测试辅助：在临时目录构造名录/桌台，并提供 CSV 导入快捷方式。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/migrate.js';
import * as app from '../src/app.js';
import { importCsvFile } from '../src/domain/import.js';

export function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'rsvp-test-'));
  initStore(home);
  return home;
}

export function cleanup(home) {
  rmSync(home, { recursive: true, force: true });
}

export function seedBasics(home, guests = null, tables = null) {
  const store = app.openStore(home);
  const gs = guests || [
    { guestId: 'G001', name: '张三' },
    { guestId: 'G002', name: '李四' },
    { guestId: 'G003', name: '王五' },
    { guestId: 'G004', name: '赵六', child: true },
    { guestId: 'G005', name: '钱七' },
  ];
  // 第一遍：先建全部宾客（允许关系前向引用）
  for (const g of gs) {
    app.addGuest(store, {
      guestId: g.guestId,
      name: g.name,
      child: Boolean(g.child),
      group: g.group || '',
    });
  }
  // 第二遍：补同桌/避让关系
  for (const g of gs) {
    for (const other of g.sameWith || []) {
      app.addRelation(store, { guestId: g.guestId, other, type: 'same' });
    }
    for (const other of g.avoidWith || []) {
      app.addRelation(store, { guestId: g.guestId, other, type: 'avoid' });
    }
  }
  const ts = tables || [
    { tableId: 'T1', name: '一号桌', capacity: 4 },
    { tableId: 'T2', name: '二号桌', capacity: 4 },
  ];
  for (const t of ts) app.addTable(store, t);
  return store;
}

export function csvFile(home, name, rows) {
  const file = join(home, name);
  writeFileSync(file, rows, 'utf8');
  return file;
}

export const HEADER = 'guestId,status,occurredAt,seq,partySize,note\n';

export function imp(home, source, lines, filePrefix = 'batch') {
  const file = csvFile(home, `${filePrefix}-${source}-${Math.random().toString(36).slice(2, 8)}.csv`, HEADER + lines);
  const store = app.openStore(home);
  const result = importCsvFile(store, { file, source, operator: 'test' });
  if (!result.ok) {
    const e = new Error(
      `测试夹具导入失败(source=${source})：\n` + result.errors.map((x) => `  第${x.line}行 ${x.message}`).join('\n'),
    );
    e.result = result;
    throw e;
  }
  return result;
}

export function freshStore(home) {
  return app.openStore(home);
}

export function impRaw(home, source, lines, filePrefix = 'batch') {
  const file = csvFile(home, `${filePrefix}-${source}-${Math.random().toString(36).slice(2, 8)}.csv`, HEADER + lines);
  const store = app.openStore(home);
  return importCsvFile(store, { file, source, operator: 'test' });
}

export { app };
