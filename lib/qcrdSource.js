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
import { isUnreachable, directDown, markDirectDown, clearDirectDown, explainHostError } from './directRoute';

export const QCRD_API_BASE = (
  process.env.QCRD_API_BASE || process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com'
).replace(/\/+$/, '');

// ยึดชีทเสมอ ไม่ดู env QCRD_SOURCE แล้ว (ดูเหตุผลด้านบน)
export const qcrdSource = () => 'sheet';
export const usingSql = () => false;

/** ทางที่จะใช้จริงในโหมด sql — ไว้บอกใน /api/qcrd?debug=1 และในข้อความ error */
export const sqlRoute = () => (hasDirectDb() ? `ต่อ SQL ตรง (${describeTarget()})` : `host API (${QCRD_API_BASE})`);

export { hasDirectDb };

/**
 * ลองต่อ SQL ตรงก่อน ต่อไม่ติดค่อยถอยไป host API — คืนทางที่ใช้จริงมาด้วย ไว้บอกในหน้าเว็บ/log
 *
 * ที่ร้าน SQL Server ไม่ได้เปิดพอร์ตออกเน็ตตลอด แต่บน Vercel ตั้ง QCRD_DB_USER/PASSWORD ไว้ใช้กับหน้าอื่น
 * hasDirectDb() จึงเป็น true เสมอ ถ้าไม่มีตัวถอยนี้ ทุกคำสั่งจะไปตายที่
 * "ต่อ SQL Server (inventory.dyndns.tv:1433/InventoryNarai) ไม่ได้: Failed to connect ... in 15000ms"
 * ทั้งที่ทาง host API (tunnel ขาออกของเครื่องออฟฟิศ) ยังใช้ได้อยู่
 *
 * ถอยเฉพาะ error ที่แปลว่า "ไปไม่ถึงเครื่อง" เท่านั้น — ตารางไม่มี/ไม่มีสิทธิ์/ข้อมูลไม่ถูก ต้องเด้งขึ้นไปให้คนแก้
 */
export async function viaDirectOrHost(label, runDirect, runHost) {
  const hostRoute = `host API (${QCRD_API_BASE})`;
  const fromHost = async (note) => ({ data: await runHost(), route: note ? `${hostRoute} — ${note}` : hostRoute });

  if (!hasDirectDb()) return fromHost();
  if (directDown()) return fromHost('ต่อ SQL ตรงไม่ติดเมื่อครู่ จึงข้ามมาทางนี้เลย');

  try {
    const data = await runDirect();
    clearDirectDown();
    return { data, route: `ต่อ SQL ตรง (${describeTarget()})` };
  } catch (err) {
    if (!isUnreachable(err.message)) throw err;
    markDirectDown();
    console.error(`qcrd ${label}: ต่อ SQL ตรงไม่ได้ (${describeTarget()}) — ถอยไปเรียก host API:`, err.message);
    try {
      return await fromHost('ต่อ SQL ตรงไม่ได้จึงถอยมาทางนี้');
    } catch (hostErr) {
      // พังทั้งสองทาง — บอกทั้งคู่ ไม่งั้นจะเห็นแค่ทางหลังแล้วไล่ผิดจุด
      throw new Error(
        `ต่อ SQL ตรงไม่ได้: ${err.message}\n` +
        `→ ถอยไปเรียก ${hostRoute} ก็ไม่ได้: ${hostErr.message}`);
    }
  }
}

/** เรียก host API ฝั่งอ่าน */
async function getFromHost(path, { timeoutMs = 20000 } = {}) {
  const res = await fetch(`${QCRD_API_BASE}/qcrd/${path}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'ngrok-skip-browser-warning': 'true' },
  }).catch((err) => { throw explainHostError(err, { base: QCRD_API_BASE, timeoutMs }); });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`host API ตอบไม่ใช่ JSON (HTTP ${res.status}) — ตรวจว่า host-server รันอยู่ไหม`); }
  if (!res.ok || json.status !== 'success') throw new Error(json.message || `host API HTTP ${res.status}`);
  return json.data;
}

/** อ่านข้อมูลชุดหนึ่ง — kind = menu | bom | item | menugroup */
export async function fetchQcrdSql(kind, { timeoutMs = 20000 } = {}) {
  const fn = { menu: 'readMenus', bom: 'readBom', item: 'readItems', menugroup: 'readMenuGroups' }[kind];
  if (!fn) throw new Error(`ไม่รู้จักชุดข้อมูล ${kind}`);
  const { data } = await viaDirectOrHost(`อ่าน ${kind}`, () => qcrd[fn](), () => getFromHost(kind, { timeoutMs }));
  return data;
}

/** เรียก host API ฝั่งเขียน — ต้องมีกุญแจให้ตรงกับเครื่องโฮสต์ */
async function postToHost(body, { timeoutMs = 60000 } = {}) {
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
  }).catch((err) => { throw explainHostError(err, { base: QCRD_API_BASE, timeoutMs }); });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`host API ตอบไม่ใช่ JSON (HTTP ${res.status}) — ตรวจว่า host-server รันอยู่ไหม`); }
  if (json.status !== 'success') throw new Error(json.message || `host API HTTP ${res.status}`);
  return json;
}

/** เขียน — body เดียวกับที่เคยส่งไป Apps Script ทุกช่อง (ต่อตรงไม่ได้ก็ถอยไป host API ให้เอง) */
export async function saveQcrdSql(body, { timeoutMs = 60000 } = {}) {
  const action = String(body?.action || '').trim();

  const runDirect = async () => {
    const fn = qcrd.actions[action];
    if (!fn) throw new Error(`unknown action: ${action}`);
    return { status: 'success', data: await fn(body) };
  };

  const { data } = await viaDirectOrHost(action || 'save', runDirect, () => postToHost(body, { timeoutMs }));
  return data;
}
