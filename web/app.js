/* 单页逻辑：快照渲染、导入、冲突解决、排座候选/应用。 */
'use strict';

let S = null;
let TAB = 'review';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function statusPill(g) {
  if (g.hasConflict) return '<span class="pill s-conflict">冲突待人工</span>';
  const s = g.currentStatus;
  if (!s) return '<span class="pill s-null">无记录</span>';
  const map = { confirmed: '确认', pending: '待定', declined: '婉拒' };
  return `<span class="pill s-${s}">${map[s]}</span>`;
}

function effLabel(e) {
  return { applied: '生效中', superseded: '已被覆盖', convergent: '一致冗余', CONFLICTED: '' }[e] || e;
}

async function api(path, body) {
  const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const res = await fetch(path, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
  return data;
}

async function load() {
  S = await api('/api/snapshot');
  render();
}

function setTab(t) {
  TAB = t;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  render();
}
$('#nav').addEventListener('click', (e) => {
  if (e.target.dataset.tab) setTab(e.target.dataset.tab);
});

// ---------- 待处理 ----------
function tabReview() {
  const { reviewQueue, impact } = S;
  let html = `
  <div class="warn">
    规则提示：跨来源冲突与锁定席异常<b>不会被系统静默处理</b>；自动排座只给候选，不移动任何既有席位。
  </div>`;

  html += `<div class="panel"><h3>① 跨来源 RSVP 冲突（${reviewQueue.rsvpConflicts.length}）</h3>`;
  if (!reviewQueue.rsvpConflicts.length) html += '<div class="muted">无</div>';
  for (const r of reviewQueue.rsvpConflicts) {
    html += `<div class="err"><b>${esc(r.guestName)}</b>（${esc(r.guestId)}）在 ${esc(r.occurredAt)} 收到互相矛盾的记录：<table style="margin-top:6px">
      <tr><th>来源</th><th>序号</th><th>状态</th><th>人数</th><th>事件号</th></tr>`;
    for (const e of r.events) {
      html += `<tr><td>${esc(e.source)}</td><td>${e.seq}</td><td>${esc(e.status)}</td><td>${e.partySize}</td><td><code>${esc(e.eventId)}</code></td></tr>`;
    }
    html += `</table>
      <div style="margin-top:8px">
        <button class="act primary" onclick="resolveAs('${esc(r.guestId)}','confirmed')">采纳为 确认</button>
        <button class="act" onclick="resolveAs('${esc(r.guestId)}','pending')">采纳为 待定</button>
        <button class="act danger" onclick="resolveAs('${esc(r.guestId)}','declined')">采纳为 婉拒</button>
      </div></div>`;
  }
  html += '</div>';

  html += `<div class="panel"><h3>② 锁定席 / 在席异常（${reviewQueue.seatingReviews.length}）</h3>`;
  if (!reviewQueue.seatingReviews.length) html += '<div class="muted">无</div>';
  for (const r of reviewQueue.seatingReviews) {
    html += `<div class="warn"><b>${esc(r.guestName)}</b>（${esc(r.guestId)}）：${esc(r.message)}　当前 ${esc(r.tableId)} 桌 ${r.seatNumber} 号
      <button class="act" onclick="openGuest('${esc(r.guestId)}')">查看历史/影响</button></div>`;
  }
  html += '</div>';

  html += `<div class="panel"><h3>③ 同桌关系受影响（${reviewQueue.groupWarnings.length}）</h3>`;
  if (!reviewQueue.groupWarnings.length) html += '<div class="muted">无</div>';
  for (const w of reviewQueue.groupWarnings) {
    html += `<div class="warn">${esc(w.message)}<br>组：[${w.group.map(esc).join(', ')}]
      婉拒：[${w.declinedGuests.map(esc).join(', ')}]，仍在席：[${w.stillSeated.map((x) => esc(x.guestId)).join(', ')}]</div>`;
  }
  html += '</div>';

  html += `<div class="panel"><h3>④ 变更影响清单（已排座宾客）</h3>`;
  html += impactList(impact);
  html += '</div>';
  return html;
}

function impactList(impact) {
  const li = (arr) =>
    arr.length
      ? `<table><tr><th>宾客</th><th>桌/座</th><th>锁定</th><th>儿童</th><th></th></tr>` +
        arr
          .map(
            (e) => `<tr><td>${esc(e.guestName)} <span class="muted">${esc(e.guestId)}</span></td>
          <td>${esc(e.tableId)}-${e.seatNumber}</td><td>${e.locked ? '<span class="lock">🔒</span>' : ''}</td>
          <td>${e.child ? '<span class="child-flag">儿童椅</span>' : ''}</td>
          <td><button class="act" onclick="openGuest('${esc(e.guestId)}')">历史/影响</button></td></tr>`,
          )
          .join('') +
        `</table>`
      : '<div class="muted">无</div>';
  return `
    <details open><summary>已婉拒但仍占座（${impact.seatedDeclined.length}，锁定席不会被系统移动）</summary>${li(impact.seatedDeclined)}</details>
    <details><summary>待定但仍占座（${impact.seatedPending.length}）</summary>${li(impact.seatedPending)}</details>
    <details><summary>冲突未决但在席（${impact.seatedConflicted.length}）</summary>${li(impact.seatedConflicted)}</details>
    <details open><summary>新确认、尚未排座 → 自动候选输入（${impact.unassignedConfirmed.length}）</summary>${li(
      impact.unassignedConfirmed.map((u) => ({
        guestName: u.name,
        guestId: u.guestId,
        tableId: '—',
        seatNumber: '',
        locked: false,
        child: u.child,
      })),
    )}</details>
    <p class="muted">${esc(impact.note)}</p>`;
}

// ---------- 宾客 ----------
function tabGuests() {
  const rows = S.guests
    .map((g) => {
      const seat = S.seating.assignments.find((a) => a.guestId === g.guestId);
      return `<tr>
      <td>${esc(g.name)}<br><span class="muted">${esc(g.guestId)}</span></td>
      <td>${statusPill(g)}${g.statusProvisional ? '<div class="muted">当前值暂定</div>' : ''}</td>
      <td>${g.currentPartySize}</td>
      <td>${esc(g.currentSource || '')}${g.currentEventId ? `<br><code>${esc(g.currentEventId)}</code>` : ''}</td>
      <td>${g.child ? '<span class="child-flag">儿童</span>' : ''}</td>
      <td>${seat ? `${esc(seat.tableId)}-${seat.seatNumber}${seat.locked ? ' <span class="lock">🔒</span>' : ''}` : '<span class="muted">未排座</span>'}</td>
      <td><button class="act" onclick="openGuest('${esc(g.guestId)}')">历史/影响</button></td>
    </tr>`;
    })
    .join('');
  return `<div class="cards">
    <div class="card"><b>${S.stats.confirmed}</b><span>确认</span></div>
    <div class="card"><b>${S.stats.pending}</b><span>待定</span></div>
    <div class="card"><b>${S.stats.declined}</b><span>婉拒</span></div>
    <div class="card"><b>${S.stats.noRecord}</b><span>无记录</span></div>
    <div class="card"><b style="color:var(--red)">${S.stats.conflicts}</b><span>冲突待处理</span></div>
  </div>
  <table><tr><th>宾客</th><th>当前状态</th><th>人数</th><th>来源/事件</th><th>儿童</th><th>席位</th><th></th></tr>${rows}</table>`;
}

async function openGuest(guestId) {
  const data = await api(`/api/guest/${encodeURIComponent(guestId)}`);
  const g = data.guest;
  const hrows = g.history
    .map(
      (h) => `<tr class="${h.late ? '' : ''}">
      <td><code>${esc(h.eventId)}</code></td>
      <td>${esc(h.source)}#${h.seq}</td>
      <td><span class="pill s-${h.status}">${esc(h.status)}</span></td>
      <td>${h.partySize}</td>
      <td>${esc(h.occurredAt)}</td>
      <td>${esc(h.receivedAt)}</td>
      <td>${h.late ? '<span class="lock">迟到旧事件</span>' : ''}</td>
      <td class="eff-${h.effect}">${effLabel(h.effect)}</td>
      <td>${esc(h.note)}</td>
    </tr>`,
    )
    .join('');
  $('#dlgBody').innerHTML = `
    <h3 style="margin-top:0">${esc(g.name)}（${esc(g.guestId)}） ${statusPill(g)}
      <button class="act" style="float:right" onclick="$('#dlg').close()">关闭</button></h3>
    ${g.hasConflict ? '<div class="err">该宾客存在跨来源冲突，当前值仅为冲突前的暂定状态。请到"待处理"页人工裁决。</div>' : ''}
    <div class="muted">当前生效事件 <code>${esc(g.currentEventId || '—')}</code>，来源 ${esc(g.currentSource || '—')}，发生于 ${esc(g.currentOccurredAt || '—')}</div>
    ${
      data.seat
        ? `<div class="panel" style="margin-top:10px">席位：<b>${esc(data.seat.tableId)}-${data.seat.seatNumber}</b>${
            data.seat.locked ? ' <span class="lock">🔒 已锁定（RSVP 变化不会移动它）</span>' : ''
          }${data.seat.child ? ' <span class="child-flag">儿童椅</span>' : ''}</div>`
        : '<div class="panel" style="margin-top:10px">当前未排座；确认后可进入自动候选。</div>'
    }
    <h4>事件历史（稳定事件号 / 来源内序号 / 时间 / 效果）</h4>
    <table><tr><th>事件号</th><th>来源#序号</th><th>状态</th><th>人数</th><th>发生时间</th><th>到账时间</th><th>迟到</th><th>效果</th><th>备注</th></tr>${hrows}</table>`;
  $('#dlg').showModal();
}

async function resolveAs(guestId, status) {
  if (!confirm(`人工裁决：将 ${guestId} 的冲突解决为「${status}」？该操作以 resolution 事件落账，可追溯。`)) return;
  await api('/api/resolve', { guestId, status, note: 'Web 端人工裁决' });
  await load();
}

// ---------- 导入 ----------
const SAMPLE_CSV = `guestId,status,occurredAt,seq,partySize,note
G001,confirmed,2026-09-20T10:00:00Z,1,2,夫妻二人
G002,declined,2026-09-20T11:30:00Z,2,1,出差
`;
function tabImport() {
  const batches = S.batches || [];
  const brows = batches
    .map(
      (b) => `<tr><td>${esc(b.batchId)}</td><td>${esc(b.source)}</td><td>${esc(b.receivedAt)}</td>
      <td>${b.appended.length}</td><td>${b.duplicates.length}</td>
      <td>${b.duplicates.map((d) => `#${d.seq} ${esc(d.guestId)}`).join('<br>') || '<span class="muted">—</span>'}</td></tr>`,
    )
    .join('');
  return `<div class="panel">
    <h3>批量导入（整批事务：任一非法行 → 全批拒绝，账本/席位不变）</h3>
    <div class="row">
      来源 <input id="impSource" placeholder="如 family_zhang / family_li" style="width:240px">
      <button class="act" onclick="fillSample()">填入示例</button>
    </div>
    <textarea id="impCsv">${esc(SAMPLE_CSV)}</textarea>
    <div class="muted" style="margin:6px 0">列：guestId,status,occurredAt,seq[,partySize,note]；status 支持 confirmed/pending/declined 与 确认/待定/婉拒；同来源 seq 必须连续追加，重复 seq 同内容幂等跳过。</div>
    <button class="act primary" onclick="doImport()">导入（事务）</button>
    <div id="impResult"></div>
  </div>
  <div class="panel"><h3>导入批次留痕（含被幂等跳过的重复）</h3>
    <table><tr><th>批次</th><th>来源</th><th>到账时间</th><th>入账</th><th>重复跳过</th><th>明细</th></tr>${brows || '<tr><td colspan="6" class="muted">暂无</td></tr>'}</table>
  </div>`;
}
function fillSample() {
  $('#impCsv').value = SAMPLE_CSV;
}
async function doImport() {
  const box = $('#impResult');
  box.innerHTML = '';
  try {
    const r = await api('/api/import', { source: $('#impSource').value.trim(), csvText: $('#impCsv').value });
    box.innerHTML = `<div class="ok">导入成功：入账 ${r.appended} 条，重复幂等跳过 ${r.duplicatesSkipped} 条（批次 ${esc(r.batchId)}）。</div>`;
    await load();
  } catch (e) {
    const d = e.data || {};
    const errs = (d.errors || [{ message: e.message }])
      .map((x) => `· 第 ${x.line} 行：${esc(x.message)}`)
      .join('\n');
    const u = d.untouched
      ? `\n校验：事件数 ${d.untouched.eventsBefore}→${d.untouched.eventsAfter}，席位数 ${d.untouched.seatsBefore}→${d.untouched.seatsAfter}（均未变化）`
      : '';
    box.innerHTML = `<div class="err"><b>整批导入失败，未写入任何数据</b>\n${errs}${u}</div>`;
  }
}

// ---------- 排座 ----------
async function tabSeating() {
  let p;
  try {
    p = await api('/api/proposal');
  } catch (e) {
    return `<div class="err">${esc(e.message)}</div>`;
  }
  const byTable = {};
  for (const a of S.seating.assignments) (byTable[a.tableId] ||= []).push(a);
  let map = '<div class="panel"><h3>当前席位（🔒锁定 / 🧒儿童椅；RSVP 变化不会自动移动这些席位）</h3>';
  map += '<table class="seatmap"><tr><th>桌台</th><th>座位分布</th></tr>';
  for (const t of S.tables) {
    const seats = [...Array(t.capacity)].map((_, i) => {
      const n = i + 1;
      const a = (byTable[t.tableId] || []).find((x) => x.seatNumber === n);
      if (!a) return `<td class="empty">${n}</td>`;
      const g = S.guests.find((x) => x.guestId === a.guestId);
      return `<td title="${esc(a.guestId)}">${n}<br>${esc(g?.name || a.guestId)}${a.locked ? ' 🔒' : ''}${a.child ? ' 🧒' : ''}</td>`;
    });
    map += `<tr><td><b>${esc(t.tableId)}</b><br><span class="muted">${esc(t.name)}（${(byTable[t.tableId]||[]).length}/${t.capacity}）</span></td><td style="text-align:left"><table style="border:0"><tr style="border:0">${seats.join('')}</tr></table></td></tr>`;
  }
  map += '</table></div>';

  const propRows = p.proposals
    .map(
      (x) => `<tr><td>${esc(x.guestName)} <span class="muted">${esc(x.guestId)}</span></td><td>${x.child ? '🧒 ' : ''}${esc(x.tableId)}</td></tr>`,
    )
    .join('');
  const cc = Object.entries(p.childChairs).map(([t, n]) => `${esc(t)} 桌 ${n} 把`).join('；') || '无';
  const ex = p.boundary.excluded;
  const unsat = p.unsatisfiable
    .map((u) => `<li>${esc(u.message)}：[${u.group.map(esc).join(', ')}]${u.blockedBy ? ' 阻塞方：' + u.blockedBy.map((b) => `${esc(b.guestId)}(${b.reason})`).join('，') : ''}</li>`)
    .join('');

  return `${map}
  <div class="panel"><h3>自动排座候选（仅方案，不移动席位；需人工批准）</h3>
    <div class="muted">${esc(p.boundary.rule)}</div>
    <div class="row" style="margin-top:8px">
      候选 ${p.proposals.length} 人｜已有席位跳过 ${ex.alreadySeated.length}｜非确认跳过 ${ex.notConfirmed.length}｜冲突跳过 ${ex.conflicted.length}
    </div>
    <div class="muted">儿童椅需求：${cc}</div>
    <table style="margin:8px 0"><tr><th>宾客</th><th>建议桌台</th></tr>${propRows || '<tr><td colspan="2" class="muted">无新候选（可能均已排座或无确认宾客）</td></tr>'}</table>
    ${p.unsatisfiable.length ? `<div class="warn"><b>无法自动满足（需人工）：</b><ul style="margin:6px 0">${unsat}</ul></div>` : ''}
    ${p.proposals.length ? `<button class="act primary" onclick="applyProposal()">批准并应用候选（仅加位，绝不移动既有席位）</button>` : ''}
  </div>`;
}
async function applyProposal() {
  if (!confirm('应用候选只会为未排座宾客加位；锁定席、儿童椅、同桌/避让均已在方案中保留。确认应用？')) return;
  await api('/api/seat/apply-proposal', {});
  await load();
}

// ---------- 账本 ----------
function tabLedger() {
  return `<div class="panel"><h3>事件账本（只追加，稳定事件号）</h3>
    <p class="muted">账本按追加顺序分配 E000001… 事件号；(来源, 来源内序号) 是事件天然身份。当前共 <b>${S.meta ? '' : ''}${S.guests.reduce((n, g) => n + g.history.length, 0)}</b> 条宾客可见事件记录（含跨宾客）。</p>
    <div class="row">
      <a class="act" href="/api/ledger.csv" download>⬇ 导出事件账本 CSV</a>
      <a class="act" href="/api/state.csv" download>⬇ 导出当前物化状态 CSV</a>
    </div>
    <p class="muted">账本可在另一台机器上完全重建当前状态：物化结果只取决于事件内容，与导入顺序无关。</p>
  </div>
  <div class="panel"><h3>来源游标</h3><pre>${esc(JSON.stringify(S.meta?.sources || {}, null, 2))}</pre></div>`;
}

function render() {
  if (!S) return;
  const main = $('#main');
  main.innerHTML = { review: tabReview, guests: tabGuests, import: tabImport, seating: tabSeating, ledger: tabLedger }[TAB]();
}

load().catch((e) => {
  $('#main').innerHTML = `<div class="err">加载失败：${esc(e.message)}</div>`;
});
