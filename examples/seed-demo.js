#!/usr/bin/env node
// 端到端演示：构造两家离线表格 -> 乱序补录 -> 跨来源冲突 -> 锁定席婉拒 -> 自动候选。
// 用法: node examples/seed-demo.js [数据目录]
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initStore } from '../src/migrate.js';
import * as app from '../src/app.js';
import { importCsvFile } from '../src/domain/import.js';

const home = process.argv[2] || join(process.cwd(), 'data-demo');
rmSync(home, { recursive: true, force: true });
initStore(home);

const store = () => app.openStore(home);

// 名录（先建宾客，再补关系）
const guests = [
  { guestId: 'G001', name: '张家·大表舅' },
  { guestId: 'G002', name: '张家·二表妹', sameWith: ['G003'] },
  { guestId: 'G003', name: '张家·表妹夫' },
  { guestId: 'G004', name: '李家·小侄子', child: true },
  { guestId: 'G005', name: '李家·姑妈' },
  { guestId: 'G006', name: '共同·王叔叔' },
];
for (const g of guests) app.addGuest(store(), { ...g, sameWith: [], avoidWith: [] });
app.addRelation(store(), { guestId: 'G002', other: 'G003', type: 'same' });
app.addRelation(store(), { guestId: 'G005', other: 'G006', type: 'avoid' });
for (const t of [
  { tableId: 'T1', name: '主桌', capacity: 4 },
  { tableId: 'T2', name: '亲友一桌', capacity: 4 },
  { tableId: 'T3', name: '亲友二桌', capacity: 6 },
]) app.addTable(store(), t);

const H = 'guestId,status,occurredAt,seq,partySize,note\n';
const csv = (name, body) => {
  const f = join(home, name);
  writeFileSync(f, H + body);
  return f;
};

// 张家表（seq 1-3）
let f = csv('zhang-1.csv',
  'G001,确认,2026-09-18T10:00:00Z,1,2,\n' +
  'G002,确认,2026-09-18T10:05:00Z,2,2,\n' +
  'G003,确认,2026-09-18T10:06:00Z,3,2,\n');
console.log('张家首批:', importCsvFile(store(), { file: f, source: 'family_zhang', operator: '张' }));

// 李家表（独立来源，seq 从 1）
f = csv('li-1.csv',
  'G004,确认,2026-09-19T09:00:00Z,1,1,儿童椅\n' +
  'G005,确认,2026-09-19T09:10:00Z,2,1,\n' +
  'G006,确认,2026-09-19T09:12:00Z,3,1,\n');
console.log('李家首批:', importCsvFile(store(), { file: f, source: 'family_li', operator: '李' }));

// 乱序旧事件：张家后来补录一张更旧的离线纸条：G001 曾在 9/01 婉拒
f = csv('zhang-2.csv', 'G001,婉拒,2026-09-01T08:00:00Z,4,1,旧纸条\n');
console.log('迟到旧婉拒:', importCsvFile(store(), { file: f, source: 'family_zhang' }));

// 跨来源同刻冲突：两家都在 9/20 12:00 记录 G006，但状态不同
f = csv('zhang-3.csv', 'G006,婉拒,2026-09-20T12:00:00Z,5,1,张家转达\n');
console.log('张家说婉拒:', importCsvFile(store(), { file: f, source: 'family_zhang' }));
f = csv('li-2.csv', 'G006,确认,2026-09-20T12:00:00Z,4,1,李家转达\n');
console.log('李家说确认:', importCsvFile(store(), { file: f, source: 'family_li' }));

// 重复导入张家首批 -> 全部幂等跳过
console.log('重复导入张家首批:', importCsvFile(store(), { file: join(home, 'zhang-1.csv'), source: 'family_zhang' }));

// 人工锁定 G001 的席位后，G001 又婉拒（9/23）
app.seatAssign(store(), { guestId: 'G001', tableId: 'T1', locked: true, operator: 'planner' });
f = csv('zhang-4.csv', 'G001,婉拒,2026-09-23T08:00:00Z,6,1,突发\n');
console.log('锁定席宾客婉拒:', importCsvFile(store(), { file: f, source: 'family_zhang' }));

console.log('\n数据目录:', home);
console.log('查看: RSVP_HOME=' + home + ' node bin/rsvp.js review');
console.log('启动界面: RSVP_HOME=' + home + ' node src/server.js');
