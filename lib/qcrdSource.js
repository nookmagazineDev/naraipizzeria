// QC/RD เอาข้อมูลมาจากไหน — **ตอนนี้ยึดชีทเหมือนเดิม** (ชีทต้นทุนเมนู 1v8WRT…)
//
// เคยย้ายไป SQL Server (InventoryNarai) ด้วย env QCRD_SOURCE=sql แล้วถอยกลับมาใช้ชีท
// เพราะทางไปถึงฐานต้องผ่านเครื่องออฟฟิศ พอ host-server ไม่ได้รัน/เป็นเวอร์ชันเก่า
// ฝั่งอ่านถอยไปอ่านชีทได้ก็จริง แต่ฝั่งเขียนไม่มีทางถอย — หน้า QC/RD จึงบันทึกไม่ได้เลย
// และช่วงที่อ่านชีทแต่เขียน SQL ก็เกิดอาการ "บันทึกสำเร็จแต่ข้อมูลไม่เปลี่ยน" ซ้ำอีก
//
// ปักไว้ในโค้ดไม่ให้ดู env แล้ว เพราะ QCRD_SOURCE=sql ที่ตั้งค้างไว้บน Vercel จะพาไปทางเดิมทันที
// จะกลับไปใช้ SQL อีกรอบ: แก้ qcrdSource() ให้อ่าน env เหมือนเดิม (ของเดิมอยู่ใน git history)
// ตัวช่วยฝั่ง SQL ข้างล่างเก็บไว้ครบ ยังใช้ได้กับ /api/qcrd-migrate และ host-server
//
// โหมด sql (ตอนเปิดใช้) มีสองทางไปถึงฐานข้อมูล ลองตามลำดับนี้:
//   1) ต่อ SQL ตรงจาก Vercel (lib/qcrdPool.js) — ใช้เมื่อตั้ง QCRD_DB_USER/PASSWORD
//      หรือ HR_DB_USER/PASSWORD ไว้แล้ว เป็นเครื่องเดียวกับที่ตารางงาน/สแกนหน้าต่ออยู่
//      ทางนี้ไม่ต้องพึ่ง host-server และไม่ต้องมีกุญแจเขียน
//   2) host API /qcrd/* (host-server/qcrd-db.js) — สำหรับตอนที่ SQL ไม่ได้เปิดออกเน็ต
//      ต้องตั้ง QCRD_API_BASE (ไม่ตั้ง = ใช้ STORE_API_BASE) และ QCRD_WRITE_KEY สำหรับการเขียน
import { isConfigured as hasDirectDb, describeTarget, qcrd } from './qcrdPool';

export const QCRD_API_BASE = (
  process.env.QCRD_API_BASE || process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com'
).replace(/\/+$/, '');

// ยึดชีทเสมอ ไม่ดู env QCRD_SOURCE แล้ว (ดูเหตุผลด้านบน)
export const qcrdSource = () => 'sheet';
export const usingSql = () => false;

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
  const res = await fetch(`${QCRD_API_BASE}/qcrd/${kind}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'ngrok-skip-browser-warning': 'true' },
  });
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
