// ยูนิฟอร์มของสาขา — หน้า HR → "ยูนิฟอร์ม" (ดูอย่างเดียว)
//
// ที่มา: dbo.UniformBranch ในฐาน InventoryNarai (ตารางที่มีอยู่ในฐานอยู่แล้ว ไม่ได้สร้างจากรีโปนี้)
//
//   GET /api/uniform-branch              -> แถวล่าสุดไม่เกิน 20000 แถว ครบทุกคอลัมน์
//   GET /api/uniform-branch?limit=50000  -> ขอแถวเพิ่ม (สูงสุด 50000)
//   GET /api/uniform-branch?view=requests -> ใบขอเบิกยูนิฟอร์มของสาขา (dbo.stock_request)
//        { rows: [{ requestId, branch, itemKey, itemCode, itemName, unit, qty, requester, savedAt,
//                   status: 'pending'|'waiting_order'|'shipping', statusBy, statusAt }] }
//   POST /api/uniform-branch { action: 'setStatus', requestIds: [..], status }
//        -> ตั้งสถานะใบขอเบิก (บันทึกชื่อผู้กดจากคุกกี้ล็อกอิน) ลง dbo.uniform_request_status
//
// คืน: { status:'success', data: { rows[], total, truncated, limit, layout, source } }
//   layout.columns = คอลัมน์จริงในตาราง [{ name, type, kind: 'text'|'number'|'date' }]
//   layout.fields  = คอลัมน์ที่เดาว่าเป็น branch/item/size/qty/price/total/date/employee/status
//                    (หน้าเว็บใช้เป็นค่าเริ่มต้นของตัวเลือกจัดกลุ่ม/รวมยอด)
//
// ทางไปถึงฐานเลือกให้ที่ lib/sheetsSource.js (ต่อ SQL ตรง แล้วถอยไป host API ที่เครื่องออฟฟิศ)
// ไม่มีชีทให้ถอย — ต่อฐานไม่ได้ = ตอบ error ให้หน้าเว็บขึ้นข้อความ
import { readUniformBranch, readUniformRequests, setUniformRequestStatusRow } from '../../lib/sheetsSource';
import { sessionFromRequest } from '../../lib/authToken';

// ต่อ SQL ตรงไม่ติดแล้วถอยไป host API กินเวลาเกินเพดาน 10 วิของ Vercel ได้
export const config = { maxDuration: 60 };

/** แปลง error ที่ผู้ใช้แก้เองได้ ให้เป็นข้อความที่บอกวิธีแก้ */
function explain(msg) {
  if (/Cannot GET \/sheets\/uniform-|HTTP 404|ไม่ใช่ JSON \(HTTP 404/i.test(msg)) {
    return 'host-server ที่เครื่องออฟฟิศเป็นเวอร์ชันเก่า (ยังไม่มี endpoint ยูนิฟอร์มตัวใหม่) — ' +
      'ที่เครื่องนั้น: git pull แล้วรัน start-narai.ps1 -Restart';
  }
  if (/CREATE TABLE permission|uniform_request_status/i.test(msg) && /permission|denied/i.test(msg)) {
    return 'login ที่แดชบอร์ดใช้ไม่มีสิทธิ์สร้าง/เขียนตารางสถานะ — ' +
      'รัน docs/schema-uniform-request-status.sql ที่เครื่องออฟฟิศ แล้วให้สิทธิ์ INSERT/UPDATE/DELETE ตารางนั้น';
  }
  if (/permission was denied|SELECT permission/i.test(msg)) {
    return 'login ที่แดชบอร์ดใช้ยังไม่มีสิทธิ์อ่านตาราง dbo.UniformBranch — ให้สิทธิ์ SELECT ที่เครื่องออฟฟิศก่อน';
  }
  return msg;
}

export default async function handler(req, res) {
  if (req.method === 'POST') {
    res.setHeader('Cache-Control', 'no-store');
    const me = await sessionFromRequest(req);
    if (!me) return res.status(401).json({ status: 'error', message: 'ยังไม่ได้เข้าสู่ระบบ' });
    const body = req.body || {};
    if (body.action !== 'setStatus') {
      return res.status(400).json({ status: 'error', message: `unknown action: ${body.action}` });
    }
    try {
      const data = await setUniformRequestStatusRow({
        requestIds: body.requestIds, status: body.status, by: me.displayName || me.username,
      });
      return res.status(200).json({ status: 'success', data });
    } catch (err) {
      console.error('uniform-branch: ตั้งสถานะไม่ได้:', err.message);
      return res.status(err.badRequest ? 400 : 500).json({ status: 'error', message: explain(err.message || String(err)) });
    }
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'GET หรือ POST เท่านั้น' });
  }

  const limit = Number(String(req.query.limit || '').trim()) || 0;
  const view = String(req.query.view || '').trim().toLowerCase();

  try {
    if (view === 'requests') {
      const data = await readUniformRequests({ limit: limit > 0 ? limit : undefined });
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json({ status: 'success', data, meta: { rows: data.rows.length, source: data.source } });
    }

    const data = await readUniformBranch({ limit: limit > 0 ? limit : undefined });
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      status: 'success',
      data,
      meta: { rows: data.rows.length, total: data.total, source: data.source },
    });
  } catch (err) {
    console.error('uniform-branch: อ่านไม่ได้:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ status: 'error', message: explain(err.message || String(err)) });
  }
}
