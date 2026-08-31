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
// ไปถึงฐานได้ 2 ทาง ลองตามลำดับ:
//   1) ต่อ SQL ตรงจาก Vercel (lib/qcrdPool.js) — เร็วกว่า ใช้เมื่อตั้งรหัสฐานไว้แล้ว
//   2) host API /qcrd/rcp ที่เครื่องออฟฟิศ — เครื่องนั้นต่อ localhost ได้อยู่แล้ว
// ทางที่ 2 มีไว้เพราะที่ร้านจริง Vercel ต่อ TCP 1433 เข้าไปไม่ได้ (แพ็กเก็ตหายกลางทาง
// ขึ้น "Failed to connect ... in 15000ms" ไม่ใช่ถูกปฏิเสธ) ส่วน tunnel ขาออกของเครื่องออฟฟิศ
// ใช้งานได้ปกติ จึงเป็นทางที่ใช้จริงอยู่ตอนนี้ — และไม่ต้องเปิดพอร์ตฐานข้อมูลออกเน็ตด้วย
//
// ⭐ ฝั่งอ่านห้ามพังหน้า — ต่อฐานไม่ได้/ยังไม่ได้สร้างตาราง = คืนดัชนีว่างพร้อม warning
//    ไม่ใช่ตอบ error เพราะหน้าเมนูต้องใช้งานต่อได้จากข้อมูลชีทตามเดิม (เหมือน /api/plan-items)
import { isConfigured as hasDirectDb, describeTarget, runQuery } from '../../lib/qcrdPool';
import { QCRD_API_BASE } from '../../lib/qcrdSource';

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

/** แปลงแถวดิบเป็นรูปแบบที่หน้าเว็บใช้ — ทั้งทาง SQL ตรงและทาง host API คืนชื่อคอลัมน์ชุดเดียวกัน */
function mapLines(rtsId, rows) {
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

/** เรียก host API ที่เครื่องออฟฟิศ — คืน rows ดิบแบบเดียวกับ runQuery */
async function viaHost(pathAndQuery, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${QCRD_API_BASE}${pathAndQuery}`, { signal: ctrl.signal });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); }
    catch {
      // GAS/tunnel ล่มมักตอบหน้า HTML — บอกให้ตรงแทนที่จะโยน "Unexpected token <"
      throw new Error(`host API ตอบกลับไม่ใช่ JSON (HTTP ${r.status}) — เครื่องออฟฟิศอาจไม่ได้รัน host-server อยู่`);
    }
    if (!r.ok || body.status !== 'success') {
      throw new Error(body.message || `host API ตอบ HTTP ${r.status}`);
    }
    return body.data || [];
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`host API (${QCRD_API_BASE}) ไม่ตอบใน ${timeoutMs / 1000} วิ`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  return mapLines(rtsId, rows);
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
  const empty = wantOne ? null : {};
  const why = [];   // เหตุผลของทางที่ลองแล้วไม่ผ่าน เอาไปต่อกันเป็น warning

  // ── ทางที่ 1: ต่อ SQL ตรง ──
  if (hasDirectDb()) {
    try {
      const out = wantOne ? await readLines(rtsId) : await readIndex();
      if (wantOne && !out.items.length) {
        return res.status(404).json({ status: 'error', message: `ไม่พบสูตร rtsId=${rtsId}` });
      }
      res.setHeader('Cache-Control', CACHE_OK);
      return res.status(200).json({ status: 'success', source: 'sql', ...(wantOne ? { data: out } : out) });
    } catch (err) {
      console.error('RcpDtls: ต่อ SQL ตรงไม่ได้ — ลอง host API ต่อ:', err.message);
      why.push(explain(err));
    }
  } else {
    why.push('ยังไม่ได้ตั้งรหัสฐานข้อมูลบน Vercel (QCRD_DB_USER/PASSWORD หรือ HR_DB_USER/PASSWORD)');
  }

  // ── ทางที่ 2: host API ที่เครื่องออฟฟิศ ──
  try {
    if (wantOne) {
      const rows = await viaHost(`/qcrd/rcp-lines?rtsId=${rtsId}`);
      if (!rows.length) {
        return res.status(404).json({ status: 'error', message: `ไม่พบสูตร rtsId=${rtsId}` });
      }
      res.setHeader('Cache-Control', CACHE_OK);
      return res.status(200).json({ status: 'success', source: 'host', data: mapLines(rtsId, rows) });
    }
    const out = buildIndex(await viaHost('/qcrd/rcp'));
    res.setHeader('Cache-Control', CACHE_OK);
    return res.status(200).json({ status: 'success', source: 'host', ...out });
  } catch (err) {
    console.error('RcpDtls: host API ก็ไม่ได้:', err.message);
    why.push(`host API: ${err.message}`);
  }

  // ── ไม่เหลือทางแล้ว — คืนว่างพร้อมเหตุผล ไม่ใช่ error หน้าเมนูต้องใช้งานต่อได้ ──
  return res.status(200).json({
    status: 'success', source: 'none', data: empty, warning: why.join(' · '),
  });
}
