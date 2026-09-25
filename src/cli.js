#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadStore, saveStore, emptyStore, DEFAULT_STORE_PATH } from './lib/store.js';
import { migrate } from './lib/migrate.js';
import { csvToObjects } from './lib/csv.js';
import { readText, writeTextAtomic } from './lib/fsutil.js';
import {
  normalizeRows, checkHeader, IMPORT_COLUMNS, importBatch,
  exportLedgerCsv, exportStateCsv,
} from './lib/importexport.js';
import { guestHistory, resolveConflict } from './lib/events.js';
import { autoCandidates, reviewImpact, applyPlan, releaseSeat, setLock } from './lib/seating.js';
import { startServer } from './server.js';

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv.shift() : null;
  const args = parse({
    store: { type: 'string', default: DEFAULT_STORE_PATH },
    from: { type: 'string' },
    to: { type: 'string' },
    out: { type: 'string' },
    file: { type: 'string' },
    source: { type: 'string' },
    id: { type: 'string' },
    name: { type: 'string' },
    capacity: { type: 'string' },
    'child-capacity': { type: 'string' },
    guest: { type: 'string' },
    items: { type: 'string' },
    note: { type: 'string' },
    port: { type: 'string' },
    force: { type: 'boolean', default: false },
  }, argv);
  try {
    switch (cmd) {
      case 'init': return cmdInit(args);
      case 'migrate': return cmdMigrate(args);
      case 'guest': return cmdGuest(args);
      case 'table': return cmdTable(args);
      case 'relation': return cmdRelation(args);
      case 'import': return cmdImport(args);
      case 'export-ledger': return cmdExportLedger(args);
      case 'export-state': return cmdExportState(args);
      case 'events': return cmdEvents(args);
      case 'status': return cmdStatus(args);
      case 'conflicts': return cmdConflicts(args);
      case 'resolve': return cmdResolve(args);
      case 'candidates': return cmdCandidates(args);
      case 'review': return cmdReview(args);
      case 'apply': return cmdApply(args);
      case 'release': return cmdRelease(args);
      case 'lock': return cmdLock(args);
      case 'unlock': return cmdLock(args, false);
      case 'serve': return cmdServe(args);
      case 'template': return cmdTemplate(args);
      default:
        console.error(`未知命令: ${cmd ?? ''}
可用: init migrate guest table relation import export-ledger export-state
      events status conflicts resolve candidates review apply release lock unlock serve template`);
        process.exitCode = 1;
    }
  } catch (err) {
    if (err.errors) {
      console.error(err.message);
      for (const e of err.errors) console.error(`  第 ${e.line} 行 [${e.code}] ${e.message}`);
    } else {
      console.error(`错误: ${err.message}`);
    }
    process.exitCode = 1;
  }
}

function parse(optsDef, argv) {
  const { values, positionals } = parseArgs({
    options: optsDef, allowPositionals: true, strict: false, args: argv,
  });
  return { ...values, _: positionals };
}

const needStore = (args) => {
  const s = loadStore(args.store);
  if (!s) throw new Error(`存储不存在: ${args.store}（先运行 init 或 migrate）`);
  return s;
};

function cmdInit(args) {
  if (existsSync(args.store) && !args.force) throw new Error(`${args.store} 已存在（--force 覆盖）`);
  saveStore(args.store, emptyStore());
  console.log(`已初始化空账本: ${args.store}`);
}

function cmdMigrate(args) {
  const from = args.from ?? args._[0];
  if (!from) throw new Error('用法: migrate --from v1.json|v1.csv [--to path] [--force]');
  const report = migrate({ inputFile: from, outputFile: args.to ?? args.store, force: !!args.force });
  console.log(`迁移完成: 宾客 ${report.guests}，基线事件 ${report.baselineEvents}，桌 ${report.tables}，席位 ${report.assignments}（锁定 ${report.locked}）`);
  for (const s of report.skipped) console.log(`  跳过: ${s}`);
  console.log(`账本: ${resolve(args.to ?? args.store)}`);
}

function cmdGuest(args) {
  const sub = args._[0];
  const store = needStore(args);
  if (sub === 'add') {
    const id = args.id ?? args._[1];
    if (!id) throw new Error('用法: guest add --id G01 [--name 张三]');
    if (store.guests[id]) throw new Error(`宾客已存在: ${id}`);
    store.guests[id] = { id, name: args.name ?? id, partySize: null, children: 0, childSeatNeeded: false, rsvp: null };
    saveStore(args.store, store);
    console.log(`已添加宾客 ${id}`);
  } else if (sub === 'list' || !sub) {
    for (const g of Object.values(store.guests)) {
      const a = store.assignments[g.id];
      const r = g.rsvp;
      const flags = [
        r?.status ?? '无回复',
        r ? `#${r.eventNo}/${r.source}` : '',
        r?.conflict ? '⚠冲突待处理' : '',
        a ? `${store.tables[a.tableId]?.name ?? a.tableId}${a.locked ? '🔒' : ''}` : '未排座',
      ].filter(Boolean).join('  ');
      console.log(`${g.id}\t${g.name}\t${flags}`);
    }
  } else throw new Error(`未知 guest 子命令: ${sub}`);
}

function cmdTable(args) {
  const sub = args._[0];
  const store = needStore(args);
  if (sub === 'add') {
    const id = args.id ?? args._[1];
    const cap = Number(args.capacity ?? 10);
    if (!id) throw new Error('用法: table add --id T1 [--name 主桌 --capacity 10 --child-capacity 2]');
    store.tables[id] = { id, name: args.name ?? id, capacity: cap, childCapacity: args['child-capacity'] == null ? null : Number(args['child-capacity']) };
    store.tableOrder.push(id);
    saveStore(args.store, store);
    console.log(`已添加桌 ${id}（${cap} 座，儿童椅 ${store.tables[id].childCapacity ?? '不限'}）`);
  } else if (sub === 'list' || !sub) {
    for (const id of store.tableOrder) {
      const t = store.tables[id];
      const seated = Object.entries(store.assignments).filter(([, a]) => a.tableId === id);
      console.log(`${id}\t${t.name}\t${seated.length}组/${t.capacity}座\t${t.childCapacity == null ? '儿童椅不限' : `儿童椅${t.childCapacity}`}\t${seated.map(([g, a]) => g + (a.locked ? '🔒' : '')).join(',')}`);
    }
  } else throw new Error(`未知 table 子命令: ${sub}`);
}

function cmdRelation(args) {
  const sub = args._[0];
  const store = needStore(args);
  if (sub === 'same') {
    const ids = args._.slice(1);
    if (ids.length < 2) throw new Error('用法: relation same G01 G02 ...');
    store.sameGroups.push(ids);
    saveStore(args.store, store);
    console.log(`同桌关系: ${ids.join(' + ')}`);
  } else if (sub === 'avoid') {
    const [a, b] = args._.slice(1);
    if (!a || !b) throw new Error('用法: relation avoid G01 G02');
    store.avoidPairs.push([a, b]);
    saveStore(args.store, store);
    console.log(`避让关系: ${a} ✕ ${b}`);
  } else throw new Error('用法: relation same ... | relation avoid a b');
}

function cmdImport(args) {
  const file = args.file ?? args._[0];
  if (!file) throw new Error('用法: import --file family-a.csv [--source family-a]');
  const store = needStore(args);
  const objs = csvToObjects(readText(file));
  const fields = Object.keys(objs[0] ?? {}).filter((k) => k !== '__line');
  const required = IMPORT_COLUMNS.filter((c) => c !== 'source');
  checkHeader(required, fields);
  const rows = normalizeRows(objs, { defaultSource: args.source });
  const result = importBatch(store, rows, args.store);
  console.log(`导入 ${file}: 新事件 ${result.accepted.length}，重复跳过 ${result.duplicates}，乱序旧事件留痕 ${result.stale.length}`);
  for (const s of result.stale) console.log(`  留痕(旧): 事件#${s.eventNo} ${s.guestId} ${s.source}#${s.sourceSeq} —— 不覆盖较新状态`);
  if (result.conflictGuests.length) {
    console.log(`⚠ 跨来源冲突待人工处理: ${result.conflictGuests.map((c) => c.guestId).join(', ')}（可用 resolve 裁决）`);
  }
}

function cmdExportLedger(args) {
  const csv = exportLedgerCsv(needStore(args));
  outputCsv(csv, args.out);
}

function cmdExportState(args) {
  const csv = exportStateCsv(needStore(args));
  outputCsv(csv, args.out);
}

function outputCsv(csv, out) {
  if (out) { writeTextAtomic(out, csv); console.log(`已写出: ${out}`); }
  else process.stdout.write(csv);
}

function cmdEvents(args) {
  const store = needStore(args);
  const list = args.guest ? guestHistory(store, args.guest) : store.events.slice().sort((a, b) => a.eventNo - b.eventNo);
  for (const e of list) {
    const tags = [];
    if (e.stale) tags.push('留痕:旧');
    if (e.supersededBy) tags.push(`被#${e.supersededBy}覆盖`);
    if (e.source === 'manual-resolution') tags.push('人工裁决');
    if (e.source === 'migration') tags.push('迁移基线');
    if (!e.stale && !e.supersededBy && e.source !== 'migration') tags.push('当前');
    console.log(`#${e.eventNo}\t${e.source}\t${e.sourceSeq}\t${e.guestId}\t${e.status}\t${e.partySize ?? ''}人/${e.children ?? 0}童\t发生${e.occurredAt}\t[${[...new Set(tags)].join(',')}]`);
  }
}

function cmdStatus(args) {
  cmdGuest({ ...args, _: ['list'] });
}

function cmdConflicts(args) {
  const store = needStore(args);
  const found = Object.values(store.guests).filter((g) => g.rsvp?.conflict);
  if (!found.length) { console.log('无待处理冲突'); return; }
  for (const g of found) {
    console.log(`⚠ ${g.id} ${g.name} [${g.rsvp.conflict.kind}] ${g.rsvp.conflict.reason}`);
    for (const w of g.rsvp.conflict.winners) {
      console.log(`    - ${w.source}: 事件#${w.eventNo} 序号${w.sourceSeq} ${w.fingerprint}`);
    }
  }
}

function cmdResolve(args) {
  const store = needStore(args);
  const guest = args.guest ?? args._[0];
  const win = args.source ?? args._[1];
  if (!guest || !win) throw new Error('用法: resolve --guest G01 --source family-a [--note ...]');
  const e = resolveConflict(store, guest, win, args.note ?? '');
  saveStore(args.store, store);
  console.log(`已记录人工裁决事件 #${e.eventNo}: ${guest} 采用 ${win} 的状态（${e.status}）`);
}

function cmdCandidates(args) {
  const store = needStore(args);
  const { plan, excluded } = autoCandidates(store);
  if (!plan.length) console.log('没有新候选');
  plan.forEach((p, i) => console.log(`候选[${i}] ${p.guestIds.join('+')} → ${store.tables[p.tableId]?.name ?? p.tableId}`));
  for (const x of excluded) console.log(`排除 ${x.guestId}: ${x.reason}`);
}

function cmdReview(args) {
  const store = needStore(args);
  const r = reviewImpact(store);
  if (!r.affected.length) console.log('已排座宾客无受影响项');
  for (const a of r.affected) {
    if (a.guestId) console.log(`${a.manualOnly ? '⚠待处理' : '受影响'} ${a.guestId} @${a.tableId}${a.locked ? '🔒' : ''}: ${a.problems.join(',')} —— ${a.suggestion}`);
    else console.log(`⚠待处理 桌 ${a.tableId ?? ''} ${a.problem}`);
  }
  console.log('— 新自动候选（不移动任何现有席位）—');
  cmdCandidates(args);
}

function cmdApply(args) {
  // 用法: apply --items "G01+G02@T1,G03@T2"（仅接受候选中仍有效的项）
  const store = needStore(args);
  const plan = String(args.items ?? '').split(',').filter(Boolean).map((tok) => {
    const [guests, table] = tok.split('@');
    return { guestIds: guests.split('+').map((s) => s.trim()), tableId: table.trim(), locked: false };
  });
  if (!plan.length) throw new Error('用法: apply --items G01@T1,G02+G03@T2');
  const applied = applyPlan(store, plan);
  saveStore(args.store, store);
  console.log(`人工确认应用 ${applied.length} 个席位: ${applied.map((a) => `${a.guestId}→${a.tableId}`).join(', ')}`);
}

function cmdRelease(args) {
  const store = needStore(args);
  const guest = args.guest ?? args._[0];
  releaseSeat(store, guest);
  saveStore(args.store, store);
  console.log(`已释放 ${guest}（非锁定）`);
}

function cmdLock(args, locked = true) {
  const store = needStore(args);
  const guest = args.guest ?? args._[0];
  setLock(store, guest, locked);
  saveStore(args.store, store);
  console.log(`${guest} 已${locked ? '锁定' : '解锁'}`);
}

function cmdTemplate(args) {
  process.stdout.write([
    IMPORT_COLUMNS.join(','),
    'family-a,1,G01,confirmed,3,1,1,2026-09-20T10:00:00Z',
    'family-a,2,G02,declined,1,0,0,2026-09-20T10:05:00Z',
  ].join('\r\n') + '\r\n');
}

async function cmdServe(args) {
  await startServer({ storePath: args.store, port: Number(args.port ?? 8080) });
}

main();
