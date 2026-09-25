/**
 * 本地 Web 界面：宾客历史 / 影响提示 / 冲突裁决 / 候选应用 / 导入导出。
 * 零依赖 http 实现；每次请求从磁盘读取最新账本（刷新后看到最新确认）。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadStore, saveStore, DEFAULT_STORE_PATH } from './lib/store.js';
import { csvToObjects } from './lib/csv.js';
import {
  normalizeRows, checkHeader, IMPORT_COLUMNS, importBatch,
  exportLedgerCsv, exportStateCsv,
} from './lib/importexport.js';
import { guestHistory, resolveConflict } from './lib/events.js';
import { autoCandidates, reviewImpact, applyPlan } from './lib/seating.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

export async function startServer({ storePath = DEFAULT_STORE_PATH, port = 8080 } = {}) {
  const server = http.createServer((req, res) => handle(req, res, storePath).catch((err) => {
    res.writeHead(err.status ?? 500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message, errors: err.errors ?? null }));
  }));
  await new Promise((resolveServer) => server.listen(port, () => {
    console.log(`RSVP 账本界面: http://localhost:${port}/  （账本 ${storePath}）`);
    resolveServer();
  }));
  return server;
}

async function handle(req, res, storePath) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = await readFile(path.join(PUBLIC, 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return void res.end(html);
  }

  if (pathname.startsWith('/api/')) return await api(req, res, url, storePath);
  res.writeHead(404).end('not found');
}

async function readBodyJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function api(req, res, url, storePath) {
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const get = () => loadStore(storePath);
  const save = (s) => saveStore(storePath, s);

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const store = get();
    const review = reviewImpact(store);
    const tables = store.tableOrder.map((id) => {
      const t = store.tables[id];
      const seated = Object.entries(store.assignments)
        .filter(([, a]) => a.tableId === id)
        .map(([guestId, a]) => ({ guestId, name: store.guests[guestId]?.name ?? guestId, locked: a.locked, status: store.guests[guestId]?.rsvp?.status ?? null }));
      const seatsUsed = seated.reduce((n, x) => n + (store.guests[x.guestId]?.rsvp?.partySize ?? 0), 0);
      return { ...t, seatsUsed, seated };
    });
    const guests = Object.values(store.guests).map((g) => ({
      id: g.id, name: g.name,
      status: g.rsvp?.status ?? null,
      source: g.rsvp?.source ?? null,
      eventNo: g.rsvp?.eventNo ?? null,
      partySize: g.rsvp?.partySize ?? null,
      children: g.rsvp?.children ?? 0,
      childSeatNeeded: !!g.rsvp?.childSeatNeeded,
      conflict: g.rsvp?.conflict ?? null,
      assignment: store.assignments[g.id] ?? null,
    }));
    return json(200, {
      guests, tables,
      candidates: review.plan,
      excluded: review.excluded,
      affected: review.affected,
      sameGroups: store.sameGroups,
      avoidPairs: store.avoidPairs,
      eventCount: store.events.length,
    });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/guests/')) {
    const store = get();
    const id = decodeURIComponent(url.pathname.split('/').pop());
    if (!store.guests[id]) return json(404, { error: `未知宾客 ${id}` });
    return json(200, { guest: store.guests[id], assignment: store.assignments[id] ?? null, history: guestHistory(store, id) });
  }

  if (req.method === 'POST' && url.pathname === '/api/import') {
    const body = await readBodyJson(req);
    const store = get();
    const objs = csvToObjects(body.csv ?? '');
    const fields = Object.keys(objs[0] ?? {}).filter((k) => k !== '__line');
    try {
      checkHeader(IMPORT_COLUMNS.filter((c) => c !== 'source'), fields);
    } catch (e) {
      return json(400, { error: e.message, errors: [{ line: 1, code: 'HEADER', message: e.message }] });
    }
    const rows = normalizeRows(objs, { defaultSource: body.source || undefined });
    try {
      const result = importBatch(store, rows, storePath);
      return json(200, result);
    } catch (e) {
      // BatchRejectedError：未写入任何内容
      return json(422, { error: e.message, errors: e.errors });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/resolve') {
    const body = await readBodyJson(req);
    const store = get();
    const event = resolveConflict(store, body.guestId, body.winSource, body.note ?? '');
    save(store);
    return json(200, { eventNo: event.eventNo });
  }

  if (req.method === 'POST' && url.pathname === '/api/apply') {
    const body = await readBodyJson(req);
    const store = get();
    const applied = applyPlan(store, body.plan ?? []);
    save(store);
    return json(200, { applied });
  }

  if (req.method === 'GET' && url.pathname === '/api/export') {
    const store = get();
    const kind = url.searchParams.get('kind') || 'state';
    const csv = kind === 'ledger' ? exportLedgerCsv(store) : exportStateCsv(store);
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="rsvp-${kind}.csv"`,
    });
    return void res.end(csv);
  }

  if (req.method === 'POST' && url.pathname === '/api/guests') {
    const body = await readBodyJson(req);
    const store = get();
    if (!body.id || store.guests[body.id]) return json(400, { error: 'id 必填或已存在' });
    store.guests[body.id] = { id: body.id, name: body.name ?? body.id, partySize: null, children: 0, childSeatNeeded: false, rsvp: null };
    save(store);
    return json(200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/tables') {
    const body = await readBodyJson(req);
    const store = get();
    if (!body.id || store.tables[body.id]) return json(400, { error: 'id 必填或已存在' });
    store.tables[body.id] = { id: body.id, name: body.name ?? body.id, capacity: Number(body.capacity ?? 10), childCapacity: body.childCapacity == null ? null : Number(body.childCapacity) };
    store.tableOrder.push(body.id);
    save(store);
    return json(200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/relations') {
    const body = await readBodyJson(req);
    const store = get();
    if (body.kind === 'same' && Array.isArray(body.guests) && body.guests.length >= 2) {
      store.sameGroups.push(body.guests.map(String));
    } else if (body.kind === 'avoid' && body.a && body.b) {
      store.avoidPairs.push([String(body.a), String(body.b)]);
    } else return json(400, { error: '参数非法' });
    save(store);
    return json(200, { ok: true });
  }

  return json(404, { error: 'not found' });
}
