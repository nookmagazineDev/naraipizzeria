// ทะเบียนเมนูข้าวกล่อง — อ่านจาก Google Sheet ให้หน้า QC/RD > เมนู หยิบมาเพิ่มเข้าทะเบียนหลัก
// เป็นต้นทางที่ 4 ของ /api/qcrd-menu-source (ต่อจาก Aoringo/HumlaiPOS/NaraiPos ที่อยู่บน SQL)
//
// ชีท: https://docs.google.com/spreadsheets/d/1gijgBrK56bsjR7-R5NVWiTGTcxM57wjuYR3FUpl3EDQ
// ตั้งทับได้ด้วย env: BENTO_SHEET_ID · BENTO_SHEET_GID (แท็บ) · BENTO_MENU_PREFIX (ตัวนำหน้ารหัส)
//
// ⚠️ ไม่ฮาร์ดโค้ดตำแหน่งคอลัมน์ — ไล่หาแถวหัวตารางใน 10 แถวแรกแล้วจับคู่ด้วยคำในหัวคอลัมน์
//    (รหัส / ชื่อเมนู / ราคา / หมวด / สถานะ) ชีทเลื่อนคอลัมน์หรือมีแถวชื่อเรื่องด้านบนก็ยังอ่านได้
//    ถ้าไม่มีคอลัมน์รหัส หน้าเว็บจะออกเลขรันนิ่งให้เอง (BX000001, BX000002, …)
import { parseCSV } from './qcrdSheet';

const env = (k, fallback) => String(process.env[k] || '').trim() || fallback;

export const BENTO_SHEET_ID = env('BENTO_SHEET_ID', '1gijgBrK56bsjR7-R5NVWiTGTcxM57wjuYR3FUpl3EDQ');
const BENTO_SHEET_GID = env('BENTO_SHEET_GID', '0');
const PREFIX = env('BENTO_MENU_PREFIX', 'BX').toUpperCase();

const HEADERS = {
  code: /^(รหัส|รหัสเมนู|รหัสสินค้า|code|menu ?code|item ?code|sku|plu)$/i,
  name: /^(ชื่อ|ชื่อเมนู|เมนู|ชื่อสินค้า|รายการ|name|menu|menu ?name|item ?name)$/i,
  price: /^(ราคา|ราคาขาย|price|sale ?price|unit ?price)/i,
  group: /^(หมวด|หมวดหมู่|กลุ่ม|ประเภท|group|category)/i,
  status: /^(สถานะ|active|status|ใช้งาน|เปิดขาย)/i,
};

const INACTIVE = /^(0|n|no|f|false|inactive|ปิด|ปิดขาย|ยกเลิก|ไม่ใช้|ไม่ใช้งาน|ไม่ขาย)$/i;

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

/** หาแถวหัวตาราง — แถวแรก (ใน 10 แถวบน) ที่มีคอลัมน์ชื่อเมนู */
function detect(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cells = rows[i].map(norm);
    const map = {};
    Object.entries(HEADERS).forEach(([f, re]) => {
      const idx = cells.findIndex((c, j) => re.test(c) && !Object.values(map).includes(j));
      if (idx >= 0) map[f] = idx;
    });
    if (map.name !== undefined) return { headerRow: i, map, headers: cells };
  }
  // ไม่มีหัวตาราง: ถือว่า A=ชื่อเมนู B=ราคา
  return { headerRow: -1, map: { name: 0, price: 1 }, headers: [] };
}

const toPrice = (v) => {
  const s = String(v ?? '').replace(/[,฿\s]|บาท/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

let cache = null;   // { at, rows, info } — กันยิงชีทซ้ำทุกตัวอักษรที่พิมพ์ค้น
const TTL = 60 * 1000;

async function load({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache;
  const url = `https://docs.google.com/spreadsheets/d/${BENTO_SHEET_ID}/export?format=csv&gid=${BENTO_SHEET_GID}`;
  const r = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!r.ok) {
    throw new Error(`อ่านชีทข้าวกล่องไม่ได้ (Google Sheets HTTP ${r.status}) — ตรวจว่าแชร์ชีทแบบ "ทุกคนที่มีลิงก์ดูได้" แล้ว`);
  }
  const text = await r.text();
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new Error('ชีทข้าวกล่องตอบกลับเป็นหน้าเว็บ ไม่ใช่ CSV — ชีทอาจยังไม่ได้แชร์แบบ "ทุกคนที่มีลิงก์ดูได้"');
  }
  const all = parseCSV(text);
  const { headerRow, map, headers } = detect(all);
  const hasCode = map.code !== undefined;
  const cell = (row, f) => (map[f] === undefined ? '' : norm(row[map[f]]));

  const rows = all.slice(headerRow + 1)
    .map(row => {
      const name = cell(row, 'name');
      if (!name) return null;
      const code = hasCode ? cell(row, 'code') : '';
      const status = cell(row, 'status');
      return {
        code,
        newCode: hasCode && code ? `${PREFIX}${code}` : '',
        name,
        price: toPrice(cell(row, 'price')),
        group: cell(row, 'group'),
        active: !status || !INACTIVE.test(status),
        statusRaw: status,
      };
    })
    .filter(Boolean)
    // มีคอลัมน์รหัสแต่แถวไหนรหัสว่าง ใช้ไม่ได้ (บันทึกแล้วจะได้แค่ตัวนำหน้า)
    .filter(r => !hasCode || r.code);

  // แถวที่ไม่มีรหัส ใช้ลำดับแถวเป็นรหัสต้นทางไว้เป็นคีย์ในหน้าเว็บ
  if (!hasCode) rows.forEach((r, i) => { r.code = `#${i + 1}`; });

  const colName = (f) => (map[f] === undefined ? null : (headers[map[f]] || String.fromCharCode(65 + map[f])));
  const info = {
    id: 'naraiboxset',
    label: 'NaraiBoxSet',
    prefix: PREFIX,
    codeMode: hasCode ? 'source' : 'running6',
    table: `Google Sheet ${BENTO_SHEET_ID.slice(0, 8)}… gid=${BENTO_SHEET_GID}`,
    map: Object.fromEntries(Object.keys(HEADERS).map(f => [f, colName(f)])),
  };
  cache = { at: Date.now(), rows, info };
  return cache;
}

/** แถวของแท็บ "ข้าวกล่อง" ใน schema — อ่านไม่ได้ก็บอกเหตุผล ไม่ทำให้แท็บอื่นพัง */
export async function bentoSchema({ fresh = false } = {}) {
  try {
    const { rows, info } = await load({ fresh });
    return { ...info, ok: true, rows: rows.length, columns: Object.values(info.map).filter(Boolean) };
  } catch (err) {
    return {
      id: 'naraiboxset', label: 'NaraiBoxSet', prefix: PREFIX, codeMode: 'running6',
      table: `Google Sheet ${BENTO_SHEET_ID.slice(0, 8)}…`, ok: false, error: err.message,
    };
  }
}

/** ค้นเมนูข้าวกล่อง — รูปแบบผลเหมือน search() ของ lib/menuSourceSql.mjs ทุกช่อง */
export async function bentoSearch({ q = '', limit = 50, includeInactive = false } = {}) {
  const { rows, info } = await load();
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const kw = String(q || '').trim().toLowerCase();
  const matched = kw
    ? rows.filter(r => r.code.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw))
    : rows;
  const kept = includeInactive ? matched : matched.filter(r => r.active);
  return {
    source: info,
    rows: kept.slice(0, n),
    hiddenInactive: matched.length - kept.length,
    limited: kept.length > n,
  };
}
