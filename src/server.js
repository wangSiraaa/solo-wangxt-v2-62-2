// 零依赖本地 Web 服务：JSON API + 静态单页界面。
// 启动：RSVP_HOME=./data node src/server.js --port 4173

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { initStore } from './migrate.js';
import * as app from './app.js';
import { importCsvFile } from './domain/import.js';
import { ledgerToCsv, stateToCsv } from './export.js';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5 * 1024 * 1024) reject(new Error('请求体过大（上限 5MB）'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// 把 CSV 文本落临时文件后复用文件导入通道（同样的事务/幂等规则）
function importCsvText(store, { source, csvText, operator }) {
  const file = pathJoin(tmpdir(), `rsvp-import-${process.pid}-${Date.now()}.csv`);
  writeFileSync(file, csvText, 'utf8');
  return importCsvFile(store, { file, source, operator: operator || '' });
}

export function createApp(home) {
  initStore(home);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;

    try {
      // 静态资源
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = await readFile(join(WEB_DIR, 'index.html'), 'utf8');
        return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
      }
      if (method === 'GET' && path.startsWith('/web/')) {
        const name = path.replace('/web/', '');
        if (!/^[a-zA-Z0-9._-]+$/.test(name)) return send(res, 403, { error: 'forbidden' });
        const buf = await readFile(join(WEB_DIR, name));
        const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
        return send(res, 200, buf, { 'Content-Type': types[extname(name)] || 'application/octet-stream' });
      }

      const store = app.openStore(home);

      // ---- 查询 API ----
      if (method === 'GET' && path === '/api/snapshot') {
        const materialized = app.refresh(store);
        const impact = app.impact(store);
        return send(res, 200, {
          meta: store.meta,
          stats: materialized.stats,
          guests: materialized.guests,
          reviews: materialized.reviews,
          tables: store.tables.tables,
          seating: store.seating,
          impact,
          reviewQueue: app.reviewQueue(store),
          batches: app.importBatches(store).slice(-10).reverse(),
        });
      }
      if (method === 'GET' && path === '/api/proposal') {
        return send(res, 200, app.seatProposal(store));
      }
      if (method === 'GET' && path === '/api/impact') {
        return send(res, 200, app.impact(store));
      }
      if (method === 'GET' && path.startsWith('/api/guest/')) {
        const id = decodeURIComponent(path.split('/').pop());
        const st = app.refresh(store).guests.find((g) => g.guestId === id);
        if (!st) return send(res, 404, { error: `未知宾客 ${id}` });
        const seat = store.seating.assignments.find((a) => a.guestId === id) || null;
        return send(res, 200, { guest: st, seat });
      }
      if (method === 'GET' && path === '/api/ledger.csv') {
        return send(res, 200, ledgerToCsv(store.events), {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="ledger.csv"',
        });
      }
      if (method === 'GET' && path === '/api/state.csv') {
        return send(res, 200, stateToCsv(app.refresh(store), store.seating), {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="state.csv"',
        });
      }

      if (method !== 'POST') return send(res, 404, { error: 'not found' });
      const body = await readBody(req);

      // ---- 写入 API ----
      switch (path) {
        case '/api/import': {
          if (!body.source || !body.csvText) {
            return send(res, 400, { ok: false, errors: [{ line: 0, message: '需要 source 与 csvText' }] });
          }
          const before = store.events.length;
          const beforeSeats = store.seating.assignments.length;
          const result = importCsvText(store, body);
          if (!result.ok) {
            return send(res, 422, {
              ok: false,
              errors: result.errors,
              untouched: { eventsBefore: before, eventsAfter: before, seatsBefore: beforeSeats, seatsAfter: beforeSeats },
            });
          }
          return send(res, 200, {
            ok: true,
            batchId: result.batchId,
            appended: result.appended,
            duplicatesSkipped: result.duplicates,
          });
        }
        case '/api/resolve':
          return send(res, 200, app.resolveConflict(store, {
            guestId: body.guestId,
            status: body.status,
            partySize: body.partySize || 1,
            note: body.note || '',
            operator: body.operator || 'web',
          }));
        case '/api/guest':
          return send(res, 200, app.addGuest(store, {
            guestId: body.guestId,
            name: body.name,
            child: Boolean(body.child),
            group: body.group || '',
            sameWith: body.sameWith || [],
            avoidWith: body.avoidWith || [],
          }));
        case '/api/table':
          return send(res, 200, app.addTable(store, {
            tableId: body.tableId,
            name: body.name,
            capacity: Number(body.capacity),
          }));
        case '/api/seat/assign':
          return send(res, 200, app.seatAssign(store, {
            guestId: body.guestId,
            tableId: body.tableId,
            seatNumber: body.seatNumber ?? null,
            locked: Boolean(body.locked),
            operator: body.operator || 'web',
          }));
        case '/api/seat/lock':
          return send(res, 200, app.seatLock(store, { guestId: body.guestId, reason: body.reason || '', operator: 'web' }));
        case '/api/seat/unlock':
          return send(res, 200, app.seatUnlock(store, { guestId: body.guestId, operator: 'web' }));
        case '/api/seat/release':
          return send(res, 200, app.seatRelease(store, { guestId: body.guestId, reason: body.reason || '', operator: 'web' }));
        case '/api/seat/apply-proposal':
          return send(res, 200, app.seatApplyProposal(store, { operator: 'web' }));
        default:
          return send(res, 404, { error: 'not found' });
      }
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  });
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const portIdx = process.argv.indexOf('--port');
  const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : Number(process.env.PORT) || 4173;
  const home = process.env.RSVP_HOME;
  const server = createApp(home);
  server.listen(port, () => {
    console.log(`RSVP 控制台: http://localhost:${port}  (RSVP_HOME=${home || join(process.cwd(), 'data')})`);
  });
}
