// QC/RD ดึงข้อมูลจากไหน — ชีท (ของเดิม) หรือ SQL Server (InventoryNarai)
//
//   QCRD_SOURCE = sheet (ค่าเริ่มต้น) | sql
//   QCRD_API_BASE = URL ของ host API ที่รันอยู่เครื่องเดียวกับ SQL Server
//                   ไม่ตั้ง = ใช้ STORE_API_BASE ตัวเดียวกับหน้ายอดขาย
//   QCRD_WRITE_KEY = กุญแจสำหรับ POST /qcrd/save (ต้องตรงกับที่ตั้งบนเครื่องโฮสต์)
//
// ตั้ง QCRD_SOURCE=sql เมื่อย้ายข้อมูลขึ้น SQL แล้ว (ดู docs/qcrd-sql-migration.md)
// ถ้าเรียก SQL ไม่ได้ ฝั่งอ่านจะถอยไปอ่านชีทให้อัตโนมัติ พร้อมแนบ warning มาด้วย
// ฝั่งเขียนไม่ถอย — เขียนสองที่สลับกันแปลว่าข้อมูลสองที่จะไม่ตรงกันตั้งแต่นาทีนั้น

export const QCRD_API_BASE = (
  process.env.QCRD_API_BASE || process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com'
).replace(/\/+$/, '');

export const qcrdSource = () => (String(process.env.QCRD_SOURCE || '').toLowerCase() === 'sql' ? 'sql' : 'sheet');

export const usingSql = () => qcrdSource() === 'sql';

/** อ่านข้อมูลชุดหนึ่งจาก host API — kind = menu | bom | item | menugroup */
export async function fetchQcrdSql(kind, { timeoutMs = 20000 } = {}) {
  const res = await fetch(`${QCRD_API_BASE}/qcrd/${kind}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'ngrok-skip-browser-warning': 'true' },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`host API ตอบไม่ใช่ JSON (HTTP ${res.status}) — ตรวจว่า host-server รันอยู่ไหม`); }
  if (!res.ok || json.status !== 'success') {
    throw new Error(json.message || `host API HTTP ${res.status}`);
  }
  return json.data;
}

/** เขียนผ่าน host API — body เดียวกับที่เคยส่งไป Apps Script ทุกช่อง */
export async function saveQcrdSql(body, { timeoutMs = 60000 } = {}) {
  const key = process.env.QCRD_WRITE_KEY || '';
  if (!key) {
    throw new Error('ยังไม่ได้ตั้ง env QCRD_WRITE_KEY บน Vercel — โหมด SQL จึงยังเขียนไม่ได้');
  }
  const res = await fetch(`${QCRD_API_BASE}/qcrd/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'ngrok-skip-browser-warning': 'true',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`host API ตอบไม่ใช่ JSON (HTTP ${res.status}) — ตรวจว่า host-server รันอยู่ไหม`); }
  if (json.status !== 'success') throw new Error(json.message || `host API HTTP ${res.status}`);
  return json;
}
