// รายงาน "ข้อมูลเศษ" (เมนู STOCK) — ข้อมูลของ "สาขาเดียว" ต่อหนึ่งคำขอ (หน้าเว็บยิงทีละสาขาเป็นชุด)
//
// คืนของ 2 ก้อน รวมยอดรายวันมาแล้ว
//   pos = ยอดเศษ + ยอดเตรียม ที่สาขาคีย์ใน POS (ctranbetweendate ตัวเดียวกับ /api/detail) คัดตามรหัสไอเทม
//   wd  = ยอดเบิกวัตถุดิบต้นทาง จากใบเบิก/ใบรับ (myfbdata.trans เกณฑ์เดียวกับ /api/withdrawals)
// รหัส/ชื่อไอเทมที่คัดอยู่ใน lib/scrapReport.js ที่เดียว
//
// สองต้นทางไม่ขึ้นต่อกัน — ฝั่งไหนล้มก็ยังคืนอีกฝั่ง พร้อม warnings บอกว่าขาดอะไร
// (หน้าเว็บจะได้ไม่โชว์ 0 เงียบ ๆ ทั้งที่จริงคือดึงไม่ได้)
import mysql from 'mysql2/promise';
import { branchOutletMap } from '../../lib/branchRegistry';
import { explainHostError } from '../../lib/directRoute';
import { POS_CODE_MAP, SOURCE_NAME_MAP, normCode, nameKey } from '../../lib/scrapReport';

export const config = { maxDuration: 60 };

const STORE_API = process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com';

let pool;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || 'inventory.dyndns.tv',
      port: Number(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'myfbdata',
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 15000,
    });
  }
  return pool;
}

const r3 = n => Number((Number(n) || 0).toFixed(3));
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ── เศษ + เตรียม จาก POS ──
async function fetchPos(outletId, startDate, endDate) {
  const url = `${STORE_API}/ctranbetweendate?start=${startDate}&end=${endDate}&outlet=${encodeURIComponent(outletId)}`;
  let res;
  try {
    res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(50000),
      headers: { 'ngrok-skip-browser-warning': 'true' },
    });
  } catch (err) {
    throw explainHostError(err, { base: STORE_API, timeoutMs: 50000 });
  }
  if (!res.ok) throw new Error(`host API HTTP ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json) ? json : json.data || [];

  const agg = {};
  rows.forEach(r => {
    if (!r || r.void) return;
    const code = normCode(r.itemCode ?? r.ItemCode);
    const hit = POS_CODE_MAP[code];
    if (!hit) return;
    const qty = parseFloat(r.quantity ?? r.Quantity) || 0;
    if (!qty) return;
    // วันที่ใช้ PostTime เป็นหลัก ให้ตรงกับที่ host กรองช่วงวัน (เหมือน usageDateKey ใน lib/usageRules.js)
    const date = String(r.postTime || r.prtOrdTime || r.startTime || '').slice(0, 10);
    if (!YMD.test(date)) return;
    const key = `${date}|${code}`;
    if (!agg[key]) {
      agg[key] = { date, code, kind: hit.kind, group: hit.group, name: String(r.nameThai ?? r.NameThai ?? r.itemName ?? r.nameEng ?? '').trim(), qty: 0 };
    }
    agg[key].qty += qty;
  });
  return Object.values(agg).map(a => ({ ...a, qty: r3(a.qty) }));
}

// ── เบิกวัตถุดิบต้นทาง จากใบเบิก/ใบรับ ──
// คัดหยาบที่ SQL ด้วย LIKE (ไอเทมต้นทางทุกตัวมีคำว่า "เนื้อ" หรือ "หมู") แล้วเทียบชื่อจริงด้วย nameKey ที่ฝั่งนี้
// เพราะชื่อในระบบ inventory เว้นวรรค/ใส่จุดไม่คงที่ เทียบตรงตัวใน SQL จะหลุด
async function fetchWithdrawals(outletId, startDate, endDate) {
  const [rows] = await getPool().query(
    `SELECT DATE_FORMAT(Trn_DocDate, '%Y-%m-%d') AS d,
            Trn_itemCode AS itemCode, Trn_itemName AS itemName, Trn_Unit AS unit,
            SUM(Trn_InvQty) AS qty
       FROM trans
      WHERE Trn_Type IN ('TRF','RCV')
        AND Trn_To = ?
        AND Trn_DocDate BETWEEN ? AND ?
        AND (Trn_itemName LIKE '%เนื้อ%' OR Trn_itemName LIKE '%หมู%')
      GROUP BY d, Trn_itemCode, Trn_itemName, Trn_Unit`,
    [outletId, startDate, endDate]
  );

  const agg = {};
  rows.forEach(r => {
    const key = nameKey(r.itemName);
    const hit = SOURCE_NAME_MAP[key];
    if (!hit) return;
    const qty = Number(r.qty) || 0;
    if (!qty) return;
    const k = `${r.d}|${key}`;
    if (!agg[k]) {
      agg[k] = { date: r.d, key, group: hit.group, name: hit.name, itemCode: String(r.itemCode || '').trim(), unit: String(r.unit || '').trim(), qty: 0 };
    }
    agg[k].qty += qty;
  });
  return Object.values(agg).map(a => ({ ...a, qty: r3(a.qty) }));
}

export default async function handler(req, res) {
  const { branch, startDate, endDate, outletId: queryOutletId } = req.query;
  if (!branch || !YMD.test(String(startDate)) || !YMD.test(String(endDate))) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขา, วันที่เริ่มต้น และวันที่สิ้นสุดไม่ครบถ้วน' });
  }

  const branchKey = String(branch).toLowerCase().trim();
  let outletId = queryOutletId;
  if (!outletId) {
    const map = await branchOutletMap();
    outletId = map[branchKey];
  }
  if (!outletId) {
    return res.status(400).json({ status: 'error', message: `ไม่พบรหัส outlet ของสาขา ${branch}` });
  }

  const [pos, wd] = await Promise.allSettled([
    fetchPos(outletId, startDate, endDate),
    fetchWithdrawals(outletId, startDate, endDate),
  ]);

  const warnings = [];
  if (pos.status === 'rejected') {
    console.error('scrap-report POS error:', pos.reason?.message);
    warnings.push(`ดึงยอดเศษ/เตรียมจาก POS ไม่ได้: ${pos.reason?.message || 'ไม่ทราบสาเหตุ'}`);
  }
  if (wd.status === 'rejected') {
    console.error('scrap-report MySQL error:', wd.reason?.message);
    warnings.push(`ดึงยอดเบิกจากระบบ inventory ไม่ได้: ${wd.reason?.message || 'ไม่ทราบสาเหตุ'}`);
  }
  if (warnings.length === 2) {
    return res.status(502).json({ status: 'error', message: warnings.join(' · ') });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    status: 'success',
    data: {
      pos: pos.status === 'fulfilled' ? pos.value : [],
      wd: wd.status === 'fulfilled' ? wd.value : [],
    },
    warnings,
  });
}
