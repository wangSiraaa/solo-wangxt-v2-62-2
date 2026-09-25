#!/usr/bin/env node
// RSVP 事件账本命令行。零依赖。
// 用法见 rsvp --help

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initStore, migrateLegacy } from '../src/migrate.js';
import { openStore, refresh, impact, seatProposal } from '../src/app.js';
import * as app from '../src/app.js';
import { importCsvFile } from '../src/domain/import.js';
import {
  ledgerToCsv,
  stateToCsv,
  guestHistoryCsv,
  fullExport,
} from '../src/export.js';

function args(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out.flags[key] = true;
      else {
        out.flags[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function fail(msg) {
  console.error(`错误：${msg}`);
  process.exit(1);
}

function out(text, file) {
  if (file) {
    writeFileSync(resolve(file), text);
    console.error(`已写入 ${file}`);
  } else process.stdout.write(text);
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

const HELP = `rsvp — 可追溯 RSVP 事件账本 + 物化状态 + 排座边界

用法: rsvp <命令> [参数]   （数据目录可用 --home 或环境变量 RSVP_HOME 指定）

初始化 / 迁移
  init                                          初始化本地库（幂等）
  legacy-migrate --file <csv|json>              旧版扁平表一次性迁移为事件流

名录 / 桌台
  guest add --id G --name N [--child] [--group G] [--same a,b] [--avoid c,d]
  guest relation --id G --other O --type same|avoid
  guest remove --id G
  table add --id T --name N --capacity N

导入（事务性；非法行整批失败；同源同序号重复幂等）
  import --source family_zhang --file rsvp.csv [--operator 张三]

导出
  export ledger   [--out events.csv]           事件账本 CSV
  export state    [--out state.csv]            物化状态 CSV（含席位）
  export history  --id G [--out g.csv]         宾客历史（applied/superseded/...）
  export full     [--out backup.json]          全量 JSON 备份（账本+视图）

查询
  status                                        统计 + 待处理
  guests                                        宾客物化状态
  history --id G                                宾客历史 JSON
  conflicts                                     跨来源冲突待处理
  review                                        待人工处理总览（含锁定席婉拒）
  impact                                        RSVP 变更对已排座宾客的影响清单
  propose                                       自动排座候选方案（不动席位）

冲突处理 / 席位（显式人工操作）
  resolve --id G --status confirmed|pending|declined [--note ...]
  seat assign   --id G --table T [--seat N] [--locked]
  seat lock     --id G [--reason ...]
  seat unlock   --id G
  seat release  --id G [--reason ...]
  seat apply                                    批准并应用候选（仅加位，不移动既有席位）

事件 CSV 列: guestId,status,occurredAt,seq[,partySize,note]
`;

async function main() {
  const a = args(process.argv.slice(2));
  const [cmd, sub] = a._;
  const home = a.flags.home;
  const f = a.flags;

  if (!cmd || cmd === '--help' || cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }

  switch (cmd) {
    case 'init': {
      const r = initStore(home);
      printJson(r);
      return;
    }
    case 'legacy-migrate': {
      if (!f.file) fail('需要 --file');
      const r = migrateLegacy(home, resolve(f.file), { operator: f.operator || 'migration' });
      printJson(r);
      return;
    }
  }

  const store = openStore(home, { autoInit: false });

  switch (cmd) {
    case 'guest': {
      if (sub === 'add') {
        printJson(
          app.addGuest(store, {
            guestId: f.id,
            name: f.name,
            child: Boolean(f.child),
            group: f.group || '',
            sameWith: f.same ? String(f.same).split(',').filter(Boolean) : [],
            avoidWith: f.avoid ? String(f.avoid).split(',').filter(Boolean) : [],
          }),
        );
      } else if (sub === 'relation') {
        printJson(app.addRelation(store, { guestId: f.id, other: f.other, type: f.type }));
      } else if (sub === 'remove') {
        app.removeGuest(store, { guestId: f.id });
        console.log(`已移除 ${f.id}`);
      } else fail(`未知 guest 子命令 ${sub}`);
      return;
    }
    case 'table': {
      if (sub === 'add') printJson(app.addTable(store, { tableId: f.id, name: f.name, capacity: f.capacity }));
      else fail(`未知 table 子命令 ${sub}`);
      return;
    }
    case 'import': {
      if (!f.source || !f.file) fail('需要 --source 与 --file');
      const before = store.events.length;
      const beforeSeats = store.seating.assignments.length;
      const result = importCsvFile(store, { file: resolve(f.file), source: f.source, operator: f.operator || '' });
      if (!result.ok) {
        console.error(`整批导入失败：共 ${result.errors.length} 个错误，账本与席位均未改动（事件数仍为 ${before}，席位数仍为 ${beforeSeats}）`);
        for (const e of result.errors) console.error(`  第 ${e.line} 行: ${e.message}`);
        process.exit(2);
      }
      printJson({
        ok: true,
        batchId: result.batchId,
        appended: result.appended,
        duplicatesSkipped: result.duplicates,
      });
      return;
    }
    case 'export': {
      if (sub === 'ledger') out(ledgerToCsv(store.events), f.out);
      else if (sub === 'state') out(stateToCsv(refresh(store), store.seating), f.out);
      else if (sub === 'history') {
        if (!f.id) fail('需要 --id');
        const st = refresh(store).guests.find((g) => g.guestId === f.id);
        if (!st) fail(`未知宾客 ${f.id}`);
        out(guestHistoryCsv(st), f.out);
      } else if (sub === 'full') {
        const text = JSON.stringify(fullExport(store), null, 2) + '\n';
        out(text, f.out);
      } else fail(`未知 export 子命令 ${sub}`);
      return;
    }
    case 'status': {
      const m = refresh(store);
      const rq = app.reviewQueue(store);
      printJson({
        schemaVersion: store.meta.schemaVersion,
        sources: store.meta.sources,
        eventCount: store.events.length,
        stats: m.stats,
        review: {
          rsvpConflicts: rq.rsvpConflicts.length,
          seatingReviews: rq.seatingReviews.length,
        },
      });
      return;
    }
    case 'guests': {
      printJson(refresh(store));
      return;
    }
    case 'history': {
      if (!f.id) fail('需要 --id');
      const st = refresh(store).guests.find((g) => g.guestId === f.id);
      if (!st) fail(`未知宾客 ${f.id}`);
      printJson(st);
      return;
    }
    case 'conflicts': {
      printJson(refresh(store).reviews);
      return;
    }
    case 'review': {
      printJson(app.reviewQueue(store));
      return;
    }
    case 'impact': {
      printJson(impact(store));
      return;
    }
    case 'propose': {
      printJson(seatProposal(store));
      return;
    }
    case 'resolve': {
      if (!f.id || !f.status) fail('需要 --id 与 --status');
      printJson(app.resolveConflict(store, { guestId: f.id, status: f.status, note: f.note || '', operator: f.operator || '' }));
      return;
    }
    case 'seat': {
      if (sub === 'assign') {
        printJson(
          app.seatAssign(store, {
            guestId: f.id,
            tableId: f.table,
            seatNumber: f.seat === true ? null : Number(f.seat) || null,
            locked: Boolean(f.locked),
            operator: f.operator || '',
          }),
        );
      } else if (sub === 'lock') printJson(app.seatLock(store, { guestId: f.id, reason: f.reason || '', operator: f.operator || '' }));
      else if (sub === 'unlock') printJson(app.seatUnlock(store, { guestId: f.id, operator: f.operator || '' }));
      else if (sub === 'release') printJson(app.seatRelease(store, { guestId: f.id, reason: f.reason || '', operator: f.operator || '' }));
      else if (sub === 'apply') printJson(app.seatApplyProposal(store, { operator: f.operator || '' }));
      else fail(`未知 seat 子命令 ${sub}`);
      return;
    }
    default:
      fail(`未知命令 ${cmd}（见 rsvp --help）`);
  }
}

main().catch((err) => fail(err.stack || err.message));
