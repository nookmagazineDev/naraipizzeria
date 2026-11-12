// จัดซื้อ — เบิกของสาขา: ใบเบิกที่สาขากดในหน้านับสต๊อก (dbo.stock_request บน SQL Server)
//
//   GET /api/branch-requisition?month=YYYY-MM   (ไม่ส่ง = เดือนนี้)
//   → { status, data: { month, months, branches, logs, itemInfo, catalogWarning? } }
//
// เดิมอ่านชีท "ใบเบิก" (สเปรดชีต 12Wb7t…) ซึ่งหยุดรับรายการใหม่ตั้งแต่สาขาย้ายไปบันทึกบน SQL
// หน้านี้จึงค้างอยู่ที่ข้อมูลเก่า — ตอนนี้จำนวนเบิก/รหัส/หน่วย/ราคามาจาก SQL ทั้งหมด
// (ตรรกะคิวรีอยู่ใน lib/stockCountSql.mjs ตัวเดียวกับเครื่องมือใบเบิกของ AI NARAI)
//
// เหลืออ่านชีทแท็บ "data" อย่างเดียว เพื่อเอา "รูป" กับ "ซัพ" ของไอเทม — สองช่องนี้ไม่มีใน SQL
// ชีทนั้นเป็นแค่ทะเบียนไอเทม ไม่ใช่ข้อมูลการเบิก อ่านไม่ได้ก็ยังแสดงรายการเบิกครบ แค่ไม่มีรูป/ซัพ
// (ช่อง "คงเหลือ" ในแท็บนั้นเป็นตัวเลขที่คีย์มือไว้นานแล้ว เลิกแสดง)
import { readStockRequests } from '../../lib/sheetsSource';

const SHEET_ID = '12Wb7tMXfT548XvK1H0Cp6uOysjS8ksmMFzQZ-Rpay2k';

/** เดือนย้อนหลังที่ให้เลือกในหน้าเว็บ (นับเดือนนี้ด้วย) */
const MONTHS_BACK = 12;

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// แปลงลิงก์ Google Drive (…/file/d/<ID>/view) เป็นลิงก์รูป thumbnail ที่ฝังใน <img> ได้
function toThumbUrl(driveLink) {
  const s = String(driveLink || '').trim();
  if (!s) return '';
  const m = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return s;
  return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w200`;
}

/** รหัสสินค้าไว้จับคู่ (ตัด .0 ท้าย + 0 นำหน้า) — กติกาเดียวกับ item_key ฝั่งสาขา */
const codeKey = (v) => String(v ?? '').trim().replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

/**
 * รูป/ซัพของไอเทมจากทะเบียนในชีท data — คืน { byCode, byName }
 * จับคู่ด้วยรหัสก่อน (รหัสใหม่ แล้วรหัสเก่า) ไม่เจอค่อยใช้ชื่อ
 */
async function fetchCatalog() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('data')}`;
  const r = await fetch(url, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Google Sheets HTTP ${r.status} (data)`);
  const rows = parseCSV(await r.text());
  const header = (rows[0] || []).map(h => h.trim());
  const col = name => header.indexOf(name);
  const c = {
    codeNew: col('รหัสอุปกรณ์ใหม่'), codeOld: col('เก่า'), name: col('รายการสินค้า'),
    image: col('รูป'), supplier: col('ซัพฯ'),
  };
  const byCode = {};
  const byName = {};
  rows.slice(1).forEach(r => {
    const info = {
      oldCode: (r[c.codeOld] || '').trim(),
      image: toThumbUrl(r[c.image]),
      supplier: (r[c.supplier] || '').trim(),
    };
    const name = (r[c.name] || '').trim();
    [r[c.codeNew], r[c.codeOld]].map(codeKey).filter(Boolean).forEach(k => { if (!byCode[k]) byCode[k] = info; });
    if (name && !byName[name]) byName[name] = info;
  });
  return { byCode, byName };
}

/** 'YYYY-MM' ของวันนี้ตามเวลาไทย */
const thisMonth = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);

/** 'YYYY-MM' → วันแรก/วันสุดท้ายของเดือน */
function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${ym}-01`, end: `${ym}-${String(last).padStart(2, '0')}` };
}

/** เดือนย้อนหลัง MONTHS_BACK เดือน ล่าสุดก่อน */
function recentMonths(fromYm) {
  const [y, m] = fromYm.split('-').map(Number);
  return Array.from({ length: MONTHS_BACK }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

export default async function handler(req, res) {
  const asked = String(req.query.month || '').trim();
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) ? asked : thisMonth();

  try {
    const [requests, catalog] = await Promise.all([
      readStockRequests(monthRange(month)),
      fetchCatalog().catch(err => {
        console.error('Branch requisition: อ่านทะเบียนไอเทม (ชีท data) ไม่ได้:', err.message);
        return { error: err.message };
      }),
    ]);

    // ส่งเป็นแถวดิบ (ไม่ pivot ที่ฝั่ง API) ให้หน้าเว็บรวมยอดเอง — รูปแบบเดิมที่หน้าเว็บใช้อยู่
    const logs = requests.rows
      .filter(r => r.itemName && r.branch)
      .map(r => ({
        timestamp: r.savedAt,   // DD/MM/YYYY HH:mm
        branch: r.branch,
        itemName: r.itemName,
        itemCode: r.itemCode,
        qty: r.qty,
        docNo: r.docNo,
        requester: r.requester,
      }));

    // ข้อมูลไอเทมต่อชื่อ — รหัส/หน่วย/ราคาจาก SQL · รูป/ซัพจากทะเบียนในชีท (ถ้าอ่านได้)
    const itemInfo = {};
    requests.rows.forEach(r => {
      if (!r.itemName || itemInfo[r.itemName]) return;
      const extra = catalog.byCode?.[codeKey(r.itemCode)] || catalog.byName?.[r.itemName] || {};
      itemInfo[r.itemName] = {
        code: r.itemCode,
        oldCode: extra.oldCode || '',
        unit: r.unit,
        image: extra.image || '',
        price: r.price || null,
        supplier: extra.supplier || '',
      };
    });

    const branches = [...new Set(logs.map(r => r.branch))].sort();
    const warnings = [];
    if (requests.truncated) warnings.push('รายการเดือนนี้เยอะเกินเพดานที่อ่านได้ในครั้งเดียว ยอดอาจไม่ครบ');
    if (catalog.error) warnings.push(`อ่านรูป/ซัพของไอเทมจากชีท data ไม่ได้ (${catalog.error}) — จำนวนเบิกยังครบ`);

    res.status(200).json({
      status: 'success',
      source: 'sql',
      data: {
        month,
        months: recentMonths(thisMonth()),
        branches,
        logs,
        itemInfo,
        warning: warnings.join(' · ') || undefined,
      },
    });
  } catch (err) {
    console.error('Branch requisition API error:', err.message);
    res.status(502).json({ status: 'error', message: `อ่านใบเบิกจากฐานข้อมูลไม่ได้: ${err.message}` });
  }
}
