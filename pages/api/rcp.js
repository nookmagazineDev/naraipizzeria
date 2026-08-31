// สูตรฝั่ง POS (RcpDtls) — อ่านจากตาราง InventoryNarai.dbo.rcp_recipe / rcp_line
//
//   GET /api/rcp             -> ดัชนีสูตรทั้งหมด { [name_key]: { rtsId, name, nItems } }
//   GET /api/rcp?rtsId=6081  -> บรรทัดวัตถุดิบของสูตรนั้น
//
// ใช้ที่หน้า QC/RD > เมนู เพื่อ "เติม" สูตรให้เมนูที่ยังไม่มีในแท็บ BOM ของชีทต้นทุนเมนู
// จับคู่ด้วยชื่อ (name_key) เพราะ RcpDtls ไม่มีคอลัมน์รหัสเมนูให้ join — ดู lib/rcpMatch.js
//
// ⭐ อ่านอย่างเดียว ไม่มีทางเขียน — ชุดนี้มาจากชีท POS ที่หน้าเว็บไม่ได้เป็นเจ้าของ
//    การแก้สูตรยังต้องทำผ่าน /api/qcrd-save ซึ่งเขียนลงชีทต้นทุนเมนูเหมือนเดิม
//
// ⭐ ฝั่งอ่านห้ามพังหน้า — ต่อฐานไม่ได้/ยังไม่ได้สร้างตาราง = คืนดัชนีว่างพร้อม warning
//    ไม่ใช่ตอบ error เพราะหน้าเมนูต้องใช้งานต่อได้จากข้อมูลชีทตามเดิม (เหมือน /api/plan-items)
import { isConfigured as hasDirectDb, describeTarget, runQuery } from '../../lib/qcrdPool';

export const config = { maxDuration: 60 };

// ดัชนีสูตรเปลี่ยนเฉพาะตอนมีคนรัน migrate-rcp.mjs ซึ่งนาน ๆ ที — แคชที่ CDN ได้ยาวกว่า /api/qcrd
const CACHE_OK = 'public, s-maxage=300, stale-while-revalidate=3600';

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

const isMissingTable = (msg) => /Invalid object name .*rcp_(recipe|line)/i.test(msg || '');

/** ต่อฐานไม่ได้/ตารางยังไม่มี — บอกให้ชัดว่าต้องทำอะไรต่อ แทนที่จะโยน error ดิบ ๆ ไปให้หน้าเว็บ */
function explain(err) {
  if (isMissingTable(err.message)) {
    return 'ยังไม่ได้สร้างตาราง rcp_recipe/rcp_line — รัน docs/schema-rcp.sql แล้วนำเข้าด้วย scripts/migrate-rcp.mjs';
  }
  return `อ่านสูตร RcpDtls จากฐานไม่ได้ (${describeTarget()}): ${err.message}`;
}

/** บรรทัดวัตถุดิบของสูตรเดียว */
async function readLines(rtsId) {
  const rows = await runQuery(
    `SELECT l.line_no, l.seq, l.item_code, l.item_key, l.item_name,
            l.net_qty, l.rcp_qty, l.portion, r.name
       FROM dbo.rcp_line l
       JOIN dbo.rcp_recipe r ON r.rts_id = l.rts_id
      WHERE l.rts_id = @rtsId
      ORDER BY l.line_no`,
    { rtsId }
  );
  return {
    rtsId,
    name: rows.length ? str(rows[0].name) : '',
    items: rows.map((r) => ({
      lineNo: num(r.line_no),
      seq: num(r.seq),
      itemCode: str(r.item_code),
      itemKey: str(r.item_key),
      itemName: str(r.item_name),
      qty: num(r.net_qty),
      rcpQty: num(r.rcp_qty),
      portion: num(r.portion),
    })),
  };
}

/**
 * ดัชนี name_key -> สูตร
 * ชื่อ (หลัง normalize) ซ้ำกันข้ามสูตรได้จริง — ข้อมูลชุดที่นำเข้ามี 18 ชื่อที่ซ้ำ
 * เลือกตัวที่มีบรรทัดมากที่สุดไว้ก่อน เพราะสูตรที่มีบรรทัดเดียวมักเป็นตัวห่อ (WFC -> FC)
 * ไม่ใช่สูตรจริงที่คนอยากเห็น เสมอกันให้ใช้ rts_id น้อยกว่า ผลลัพธ์จะได้คงที่ทุกครั้ง
 */
export function buildIndex(rows) {
  const data = {};
  let dup = 0;
  for (const r of rows) {
    const key = str(r.name_key);
    if (!key) continue;
    if (data[key]) { dup++; continue; }   // ORDER BY ของคิวรีทำให้ตัวแรกคือตัวที่ควรเลือกแล้ว
    data[key] = { rtsId: num(r.rts_id), name: str(r.name), nItems: num(r.line_count) || 0 };
  }
  return { data, total: rows.length, dup };
}

async function readIndex() {
  return buildIndex(await runQuery(
    `SELECT rts_id, name, name_key, line_count
       FROM dbo.rcp_recipe
      ORDER BY name_key, line_count DESC, rts_id`
  ));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const rtsId = Number(req.query.rtsId);
  const wantOne = Number.isInteger(rtsId) && rtsId > 0;

  if (!hasDirectDb()) {
    return res.status(200).json({
      status: 'success', source: 'none', data: wantOne ? null : {},
      warning: 'ยังไม่ได้ตั้งรหัสฐานข้อมูลบน Vercel (QCRD_DB_USER/PASSWORD หรือ HR_DB_USER/PASSWORD) — สูตรจาก RcpDtls จึงยังไม่ขึ้น',
    });
  }

  try {
    if (wantOne) {
      const one = await readLines(rtsId);
      if (!one.items.length) {
        return res.status(404).json({ status: 'error', message: `ไม่พบสูตร rtsId=${rtsId}` });
      }
      res.setHeader('Cache-Control', CACHE_OK);
      return res.status(200).json({ status: 'success', source: 'sql', data: one });
    }

    const { data, total, dup } = await readIndex();
    res.setHeader('Cache-Control', CACHE_OK);
    return res.status(200).json({ status: 'success', source: 'sql', total, dup, data });
  } catch (err) {
    console.error('RcpDtls API error:', err.message);
    // ไม่ทำให้หน้าเมนูพัง — คืนว่างพร้อมเหตุผล
    return res.status(200).json({
      status: 'success', source: 'none', data: wantOne ? null : {}, warning: explain(err),
    });
  }
}
