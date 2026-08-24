// QC/RD เอาข้อมูลมาจากไหน — ชีท (ของเดิม) หรือ SQL Server (InventoryNarai)
//
//   QCRD_SOURCE = sheet (ค่าเริ่มต้น) | sql
//
// โหมด sql มีสองทางไปถึงฐานข้อมูล ลองตามลำดับนี้:
//   1) ต่อ SQL ตรงจาก Vercel (lib/qcrdPool.js) — ใช้เมื่อตั้ง QCRD_DB_USER/PASSWORD
//      หรือ HR_DB_USER/PASSWORD ไว้แล้ว เป็นเครื่องเดียวกับที่ตารางงาน/สแกนหน้าต่ออยู่
//      ทางนี้ไม่ต้องพึ่ง host-server และไม่ต้องมีกุญแจเขียน
//   2) host API /qcrd/* (host-server/qcrd-db.js) — สำหรับตอนที่ SQL ไม่ได้เปิดออกเน็ต
//      ต้องตั้ง QCRD_API_BASE (ไม่ตั้ง = ใช้ STORE_API_BASE) และ QCRD_WRITE_KEY สำหรับการเขียน
//
// ฝั่งอ่าน ถ้าทั้งสองทางล้ม จะถอยไปอ่านชีทให้พร้อมแนบ warning
// ฝั่งเขียนไม่ถอยไปชีท — เขียนสองที่สลับกันแปลว่าข้อมูลสองที่จะไม่ตรงกันตั้งแต่นาทีนั้น
import { isConfigured as hasDirectDb, describeTarget, qcrd } from './qcrdPool';
import { STORE_API_BASE, WRITE_UPSTREAM_OPTS, fetchUpstream } from './upstream.mjs';

export const QCRD_API_BASE = (process.env.QCRD_API_BASE || STORE_API_BASE).replace(/\/+$/, '');

export const qcrdSource = () => (String(process.env.QCRD_SOURCE || '').toLowerCase() === 'sql' ? 'sql' : 'sheet');
export const usingSql = () => qcrdSource() === 'sql';

/** ทางที่จะใช้จริงในโหมด sql — ไว้บอกใน /api/qcrd?debug=1 และในข้อความ error */
export const sqlRoute = () => (hasDirectDb() ? `ต่อ SQL ตรง (${describeTarget()})` : `host API (${QCRD_API_BASE})`);

export { hasDirectDb };

/** อ่านข้อมูลชุดหนึ่ง — kind = menu | bom | item | menugroup */
export async function fetchQcrdSql(kind, { timeoutMs = 20000 } = {}) {
  if (hasDirectDb()) {
    const fn = { menu: 'readMenus', bom: 'readBom', item: 'readItems', menugroup: 'readMenuGroups' }[kind];
    if (!fn) throw new Error(`ไม่รู้จักชุดข้อมูล ${kind}`);
    return qcrd[fn]();
  }
  // อ่านอย่างเดียว → ลองใหม่ได้ถ้า host API สะดุด (ค่าเริ่มต้นของ fetchUpstream = ลองใหม่ 1 ครั้ง)
  const res = await fetchUpstream(`${QCRD_API_BASE}/qcrd/${kind}`, { timeoutMs });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`host API ตอบไม่ใช่ JSON (HTTP ${res.status}) — ตรวจว่า host-server รันอยู่ไหม`); }
  if (!res.ok || json.status !== 'success') throw new Error(json.message || `host API HTTP ${res.status}`);
  return json.data;
}

/** เขียน — body เดียวกับที่เคยส่งไป Apps Script ทุกช่อง */
export async function saveQcrdSql(body, { timeoutMs = 60000 } = {}) {
  const action = String(body?.action || '').trim();

  if (hasDirectDb()) {
    const fn = qcrd.actions[action];
    if (!fn) throw new Error(`unknown action: ${action}`);
    return { status: 'success', data: await fn(body) };
  }

  const key = process.env.QCRD_WRITE_KEY || '';
  if (!key) {
    throw new Error(
      'โหมด SQL ยังเขียนไม่ได้ — ตั้ง QCRD_DB_USER/QCRD_DB_PASSWORD (ต่อ SQL ตรง) ' +
      'หรือ QCRD_WRITE_KEY ให้ตรงกับเครื่องโฮสต์ (ผ่าน host API) อย่างใดอย่างหนึ่งบน Vercel'
    );
  }
  // คำสั่งเขียน — ห้ามลองใหม่อัตโนมัติ (คำสั่งอาจถึงปลายทางแล้วแต่คำตอบหายกลางทาง = เขียนซ้ำ)
  const res = await fetchUpstream(`${QCRD_API_BASE}/qcrd/save`, {
    ...WRITE_UPSTREAM_OPTS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
    timeoutMs,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`host API ตอบไม่ใช่ JSON (HTTP ${res.status}) — ตรวจว่า host-server รันอยู่ไหม`); }
  if (json.status !== 'success') throw new Error(json.message || `host API HTTP ${res.status}`);
  return json;
}
