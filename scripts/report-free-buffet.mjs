#!/usr/bin/env node
/**
 * รายงานบิลที่ใช้โปร "ฟรี บุฟเฟต์ 1แถม1 มูลค่า 259 บาท" (รหัส 528009)
 * ตอบคำถาม: แต่ละบิลลูกค้ากี่คน และสั่งเครื่องดื่มครบทุกคนไหม → ออกเป็นไฟล์ Excel
 *
 *   node scripts/report-free-buffet.mjs --start=2026-05-01 --end=2026-10-21
 *   node scripts/report-free-buffet.mjs --start=2026-10-01 --end=2026-10-21 --branch=SJP
 *   node scripts/report-free-buffet.mjs ... --api=http://localhost:14365 --out=รายงาน.xlsx
 *
 * ดึงรายการขายจาก host API (/ctranbetweendate) ตัวเดียวกับหน้าแดชบอร์ด
 * ต้องรันบนเครื่องที่เข้าถึง API ได้ (เครื่องโฮสต์ หรือเครื่องที่ออกเน็ตได้ปกติ)
 *
 * กติกาที่ใช้ (ดูประกอบ lib/coverRules.js):
 *   - หัวจ่ายเงิน   = จำนวนจานบุฟเฟต์ COVER_ITEM_CODES ในบิล
 *   - หัวฟรี        = จำนวนของรายการ 528009 ในบิล
 *   - ลูกค้ารวม     = หัวจ่าย + หัวฟรี
 *   - เครื่องดื่ม   = รายการที่ชื่อตรงกับ --drink (ค่าเริ่มต้น: refill / รีฟิล / เครื่องดื่ม)
 *   - ข้ามแถว void ทุกแถว และตัดโต๊ะ 600 เหมือนแดชบอร์ด
 */
import process from 'node:process';
import XLSX from 'xlsx-js-style';
import { COVER_ITEM_CODES, isCoverItem } from '../lib/coverRules.js';
import { FALLBACK_BRANCHES } from '../lib/branchCore.mjs';

const PROMO_CODE = 528009;
const PROMO_VALUE = 259;
const EXCLUDE_TABLES = [600];

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; }));

const API = (args.api || process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com').replace(/\/$/, '');
const START = args.start;
const END = args.end;
const DRINK_RE = new RegExp(args.drink || 'refill|รีฟิล|เครื่องดื่ม', 'i');

if (!/^\d{4}-\d{2}-\d{2}$/.test(START || '') || !/^\d{4}-\d{2}-\d{2}$/.test(END || '')) {
  console.error('ใช้: node scripts/report-free-buffet.mjs --start=YYYY-MM-DD --end=YYYY-MM-DD [--branch=SJP] [--api=URL] [--out=ไฟล์.xlsx] [--drink=regex]');
  process.exit(1);
}

const OUTLET_TO_CODE = Object.fromEntries(FALLBACK_BRANCHES.map((b) => [b.outletId, b.code]));
const CODE_TO_OUTLET = Object.fromEntries(FALLBACK_BRANCHES.map((b) => [b.code, b.outletId]));
let outletQuery = '';
if (args.branch) {
  const oid = CODE_TO_OUTLET[args.branch.toUpperCase()];
  if (!oid) { console.error(`ไม่รู้จักสาขา ${args.branch}`); process.exit(1); }
  outletQuery = `&outlet=${oid}`;
}
const OUT = args.out || `free-buffet-528009_${START}_${END}${args.branch ? '_' + args.branch.toUpperCase() : ''}.xlsx`;

const num = (v) => parseFloat(v) || 0;
const txt = (v) => String(v ?? '').trim();
const isVoid = (r) => !!(r.void && r.void !== 'N') || r.Void === 'V';

/** หั่นช่วงวันละ 5 วัน — ยิงช่วงยาวทีเดียว host หมดเวลาก่อน (กติกาเดียวกับ lib/salesFetch.js) */
function chunks(start, end, size = 5) {
  const out = [];
  for (let s = new Date(start); s <= new Date(end);) {
    const e = new Date(s); e.setUTCDate(e.getUTCDate() + size - 1);
    if (e > new Date(end)) e.setTime(new Date(end).getTime());
    out.push([s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)]);
    s = new Date(e); s.setUTCDate(s.getUTCDate() + 1);
  }
  return out;
}

async function fetchDetails() {
  const all = [];
  for (const [s, e] of chunks(START, END)) {
    process.stdout.write(`ดึงรายการ ${s} → ${e} ... `);
    const r = await fetch(`${API}/ctranbetweendate?start=${s}&end=${e}${outletQuery}`);
    if (!r.ok) throw new Error(`host API HTTP ${r.status}`);
    const j = await r.json();
    const rows = Array.isArray(j) ? j : j.data || [];
    console.log(`${rows.length} แถว`);
    all.push(...rows);
  }
  return all;
}

const rows = (await fetchDetails()).filter((r) => !EXCLUDE_TABLES.includes(parseInt(r.tableID)) && !isVoid(r));

// รวมแถวเป็นบิล: สาขา + เลขบิล + วันเปิดบิล (เลขบิลวนซ้ำได้ข้ามวัน)
const bills = new Map();
for (const r of rows) {
  const day = txt(r.startTime || r.postTime).slice(0, 10);
  const key = `${r.outletID}|${txt(r.chkCheckID)}|${day}`;
  if (!bills.has(key)) bills.set(key, { r0: r, day, lines: [] });
  bills.get(key).lines.push(r);
}

const addItem = (m, name, q) => m.set(name, (m.get(name) || 0) + q);
const fmtItems = (m) => [...m].map(([n, q]) => `${n} (${q})`).join(', ');

const detail = [];
for (const { r0, day, lines } of bills.values()) {
  const promo = lines.filter((l) => parseInt(l.itemCode) === PROMO_CODE);
  const freeCovers = promo.reduce((s, l) => s + num(l.quantity), 0);
  if (freeCovers <= 0) continue;

  const paidCovers = lines.filter((l) => isCoverItem(l.itemCode)).reduce((s, l) => s + num(l.quantity), 0);
  const total = paidCovers + freeCovers;
  const promoValue = Math.abs(promo.reduce((s, l) => s + num(l.grossPrice), 0)) || freeCovers * PROMO_VALUE;

  const drinks = new Map();
  const buffet = new Map();
  for (const l of lines) {
    const name = txt(l.nameThai) || txt(l.nameEng) || txt(l.itemCode);
    if (DRINK_RE.test(`${l.nameThai} ${l.nameEng}`)) addItem(drinks, name, num(l.quantity));
    if (isCoverItem(l.itemCode)) addItem(buffet, name, num(l.quantity));
  }
  const drinkQty = [...drinks.values()].reduce((a, b) => a + b, 0);
  const short = Math.max(0, total - drinkQty);

  detail.push({
    branch: OUTLET_TO_CODE[parseInt(r0.outletID)] || txt(r0.outletID),
    month: day.slice(0, 7),
    day,
    bill: txt(r0.chkCheckID),
    table: txt(r0.tableID),
    paidCovers, freeCovers, total,
    promoValue,
    drinkQty,
    status: total === 0 ? '-' : short === 0 ? 'ครบ' : `ไม่ครบ (ขาด ${short})`,
    drinks: fmtItems(drinks) || '-',
    buffet: fmtItems(buffet) || '-',
  });
}
detail.sort((a, b) => a.branch.localeCompare(b.branch) || a.day.localeCompare(b.day) || a.bill.localeCompare(b.bill, undefined, { numeric: true }));

// สรุปรายสาขา × เดือน
const sumMap = new Map();
for (const d of detail) {
  const k = `${d.branch}|${d.month}`;
  const s = sumMap.get(k) || { branch: d.branch, month: d.month, bills: 0, paid: 0, free: 0, total: 0, value: 0, drinks: 0, full: 0 };
  s.bills++; s.paid += d.paidCovers; s.free += d.freeCovers; s.total += d.total;
  s.value += d.promoValue; s.drinks += d.drinkQty; if (d.status === 'ครบ') s.full++;
  sumMap.set(k, s);
}
const summary = [...sumMap.values()].sort((a, b) => a.branch.localeCompare(b.branch) || a.month.localeCompare(b.month));

// ── เขียน Excel ──
const HEAD = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '7C3AED' } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } };
const BAD = { font: { color: { rgb: 'B91C1C' }, bold: true } };
const GOOD = { font: { color: { rgb: '15803D' } } };

function sheet(headers, data, widths, styleRow) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  headers.forEach((_, c) => { ws[XLSX.utils.encode_cell({ r: 0, c })].s = HEAD; });
  data.forEach((row, i) => styleRow?.(ws, i + 1, row));
  ws['!cols'] = widths.map((wch) => ({ wch }));
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length, c: headers.length - 1 } }) };
  return ws;
}

const wb = XLSX.utils.book_new();

const detailHeaders = ['สาขา', 'เดือน', 'วันที่', 'เลขบิล', 'โต๊ะ', 'จำนวนหัวจ่าย', 'จำนวนหัวฟรี (528009)', 'ลูกค้ารวม (คน)',
  'มูลค่าส่วนลดฟรี (บาท)', 'จำนวนเครื่องดื่ม', 'ทานน้ำครบทุกคน?', 'รายการเครื่องดื่ม', 'รายการบุฟเฟต์ในบิล'];
XLSX.utils.book_append_sheet(wb, sheet(detailHeaders,
  detail.map((d) => [d.branch, d.month, d.day, d.bill, d.table, d.paidCovers, d.freeCovers, d.total,
    d.promoValue, d.drinkQty, d.status, d.drinks, d.buffet]),
  [8, 10, 12, 10, 8, 12, 14, 12, 14, 12, 18, 40, 40],
  (ws, r, row) => {
    const cell = ws[XLSX.utils.encode_cell({ r, c: 10 })];
    cell.s = row[10] === 'ครบ' ? GOOD : row[10] === '-' ? {} : BAD;
    ws[XLSX.utils.encode_cell({ r, c: 8 })].z = '#,##0.00';
  }), 'รายบิล');

const sumHeaders = ['สาขา', 'เดือน', 'จำนวนบิล', 'หัวจ่าย', 'หัวฟรี', 'ลูกค้ารวม (คน)', 'มูลค่าส่วนลดฟรี (บาท)',
  'จำนวนเครื่องดื่ม', 'บิลที่ทานน้ำครบ', 'บิลที่ไม่ครบ', '% บิลทานน้ำครบ'];
const totals = summary.reduce((t, s) => {
  for (const k of ['bills', 'paid', 'free', 'total', 'value', 'drinks', 'full']) t[k] += s[k];
  return t;
}, { bills: 0, paid: 0, free: 0, total: 0, value: 0, drinks: 0, full: 0 });
const sumRow = (s, branch, month) => [branch, month, s.bills, s.paid, s.free, s.total, s.value, s.drinks, s.full,
  s.bills - s.full, s.bills ? s.full / s.bills : 0];
const sumData = [...summary.map((s) => sumRow(s, s.branch, s.month)), sumRow(totals, 'รวมทั้งหมด', '')];
XLSX.utils.book_append_sheet(wb, sheet(sumHeaders, sumData, [12, 10, 10, 10, 10, 14, 18, 14, 14, 12, 14],
  (ws, r) => {
    ws[XLSX.utils.encode_cell({ r, c: 6 })].z = '#,##0.00';
    ws[XLSX.utils.encode_cell({ r, c: 10 })].z = '0.0%';
    if (r === sumData.length) for (let c = 0; c < sumHeaders.length; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      cell.s = { ...(cell.s || {}), font: { bold: true }, fill: { fgColor: { rgb: 'EDE9FE' } } };
    }
  }), 'สรุปสาขา-เดือน');

const notes = [
  ['รายงานโปร ฟรี บุฟเฟต์ 1แถม1 มูลค่า 259 บาท (รหัส 528009)'],
  [`ช่วงวันที่: ${START} ถึง ${END}${args.branch ? ' · สาขา ' + args.branch.toUpperCase() : ' · ทุกสาขา'}`],
  [`ดึงข้อมูลเมื่อ: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`],
  [''],
  ['หัวจ่าย = จำนวนจานบุฟเฟต์ในบิล (รหัส ' + COVER_ITEM_CODES.join(', ') + ')'],
  ['หัวฟรี = จำนวนรายการ 528009 ในบิล'],
  ['ลูกค้ารวม = หัวจ่าย + หัวฟรี'],
  [`เครื่องดื่ม = รายการที่ชื่อตรงกับ /${DRINK_RE.source}/i`],
  ['ทานน้ำครบ = จำนวนเครื่องดื่ม ≥ ลูกค้ารวม'],
  ['ไม่นับแถวที่ void และโต๊ะ 600'],
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(notes), 'หมายเหตุ');

XLSX.writeFile(wb, OUT);
console.log(`\nพบ ${detail.length} บิลที่ใช้โปร 528009 · ทานน้ำครบ ${totals.full} บิล · ไม่ครบ ${totals.bills - totals.full} บิล`);
console.log(`บันทึกไฟล์: ${OUT}`);
