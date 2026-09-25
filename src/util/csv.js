// 极简 RFC 4180 风格 CSV 解析/序列化（零依赖）。
// - 支持引号包裹、引号内双引号转义、字段内换行
// - 空行忽略；首行为表头
// - 序列化时按需加引号

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  const s = text.replace(/^﻿/, ''); // 去 BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else if (c === '\r') {
      // 跳过，交给 \n 处理（单独 \r 也算换行）
      if (s[i + 1] !== '\n') pushRow();
    } else {
      field += c;
    }
  }
  // 末行/末字段
  if (field.length > 0 || row.length > 0) pushRow();

  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
  if (nonEmpty.length === 0) return { headers: [], records: [] };

  const headers = nonEmpty[0].map((h) => h.trim());
  const records = nonEmpty.slice(1).map((r, idx) => {
    if (r.length > headers.length) {
      throw new Error(`CSV 第 ${idx + 2} 行字段数(${r.length})多于表头(${headers.length})`);
    }
    const obj = {};
    headers.forEach((h, hi) => {
      obj[h] = (r[hi] ?? '').trim();
    });
    obj.__line = idx + 2;
    return obj;
  });
  return { headers, records };
}

function needsQuote(v) {
  return /[",\r\n]/.test(v);
}

function quote(v) {
  return '"' + String(v).replace(/"/g, '""') + '"';
}

export function serializeCsv(headers, records) {
  const lines = [];
  lines.push(headers.map((h) => (needsQuote(h) ? quote(h) : h)).join(','));
  for (const rec of records) {
    lines.push(
      headers
        .map((h) => {
          const v = rec[h] ?? '';
          return needsQuote(String(v)) ? quote(String(v)) : String(v);
        })
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}
