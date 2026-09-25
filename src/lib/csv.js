/**
 * 极简 RFC4180 风格 CSV 解析/序列化（支持引号、转义引号、字段内换行/逗号）。
 */

export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let started = false; // 本行是否已有内容（用于区分空行）
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
      started = true;
    } else if (c === ',') {
      row.push(field); field = ''; started = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      if (started || row.length) { row.push(field); rows.push(row); }
      field = ''; row = []; started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (started || row.length || field) { row.push(field); rows.push(row); }
  return rows;
}

export function toCsv(rows) {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 表头行 + 数据行 -> 对象数组；重复表头会报错 */
export function csvToObjects(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const dup = header.filter((h, i) => header.indexOf(h) !== i);
  if (dup.length) throw new CsvError(`重复表头: ${[...new Set(dup)].join(', ')}`);
  return rows.slice(1).map((cells, idx) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim(); });
    obj.__line = idx + 2; // 1-based，含表头
    return obj;
  });
}

export function objectsToCsv(objs, columns) {
  const head = columns;
  const rows = objs.map((o) => columns.map((c) => o[c] ?? ''));
  return toCsv([head, ...rows]);
}

export class CsvError extends Error {}
