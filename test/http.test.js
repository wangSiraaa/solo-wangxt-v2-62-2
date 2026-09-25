import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveStore } from '../src/lib/store.js';
import { freshSetup } from './helpers.js';
import { startServer } from '../src/server.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'rsvp-http-'));
const file = path.join(dir, 'store.json');
saveStore(file, freshSetup());

const server = await startServer({ storePath: file, port: 8391 });
after(() => server.close());

const get = (p) => fetch(`http://localhost:8391${p}`).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (p, body) => fetch(`http://localhost:8391${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('HTTP: 状态/历史/冲突裁决/候选应用闭环', async () => {
  let { body } = await get('/api/state');
  assert.equal(body.guests.length >= 4, true);

  // 跨来源冲突导入
  const csv = (source, seq, status, party) =>
    `source,source_seq,guest_id,status,party_size,children,child_seat,occurred_at\n${source},${seq},G04,${status},${party},0,0,2026-09-20T10:00:00Z`;
  let r = await post('/api/import', { csv: csv('family-a', 1, 'confirmed', 2) });
  assert.equal(r.status, 200);
  r = await post('/api/import', { csv: csv('family-b', 1, 'declined', 1) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.conflictGuests.map((x) => x.guestId), ['G04']);

  ({ body } = await get('/api/guests/G04'));
  assert.equal(body.guest.rsvp.conflict.kind, 'cross-source');
  assert.ok(body.history.length >= 2);

  // 冲突宾客不入候选
  ({ body } = await get('/api/state'));
  assert.equal(body.candidates.some((p) => p.guestIds.includes('G04')), false);

  // 裁决
  r = await post('/api/resolve', { guestId: 'G04', winSource: 'family-a', note: '电话确认' });
  assert.equal(r.status, 200);
  ({ body } = await get('/api/guests/G04'));
  assert.equal(body.guest.rsvp.conflict, null);
  assert.equal(body.guest.rsvp.status, 'confirmed');

  // 现在进入候选（不自动落座）
  ({ body } = await get('/api/state'));
  const cand = body.candidates.find((p) => p.guestIds.includes('G04'));
  assert.ok(cand, '裁决后刷新即可进入候选');
  assert.equal(body.guests.find((g) => g.id === 'G04').assignment, null);

  // 人工应用候选
  r = await post('/api/apply', { plan: [cand] });
  assert.equal(r.status, 200);
  ({ body } = await get('/api/state'));
  assert.ok(body.guests.find((g) => g.id === 'G04').assignment);

  // 试图通过 apply 移动已锁定/已入座宾客 → 400/500 拒绝
  r = await post('/api/apply', { plan: [{ guestIds: ['G04'], tableId: 'T2', locked: false }] });
  assert.notEqual(r.status, 200);
});

test('HTTP: 整批非法返回 422 且数据不变；重复导入幂等', async () => {
  const before = (await get('/api/state')).body.eventCount;
  const bad = `source,source_seq,guest_id,status,party_size,children,child_seat,occurred_at
family-a,90,GHOST,confirmed,2,0,0,2026-09-21T10:00:00Z`;
  const r = await post('/api/import', { csv: bad });
  assert.equal(r.status, 422);
  assert.equal(r.body.errors[0].code, 'UNKNOWN_GUEST');
  const after = await get('/api/state');
  assert.equal(after.body.eventCount, before);

  // 已存在事件重复提交
  const dup = `source,source_seq,guest_id,status,party_size,children,child_seat,occurred_at
family-b,1,G04,declined,1,0,0,2026-09-20T10:00:00Z`;
  const r2 = await post('/api/import', { csv: dup });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.duplicates, 1);
  assert.equal(r2.body.accepted.length, 0);
});

test('HTTP: 页面与 CSV 导出可达', async () => {
  const ui = await fetch('http://localhost:8391/');
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /RSVP 事件账本/);
  for (const kind of ['ledger', 'state']) {
    const exp = await fetch(`http://localhost:8391/api/export?kind=${kind}`);
    assert.equal(exp.status, 200);
    const text = await exp.text();
    assert.ok(text.includes('event_no') || text.includes('rsvp_status'));
  }
});
