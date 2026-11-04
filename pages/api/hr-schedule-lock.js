// ล็อกตารางงานรายสาขา — ปุ่ม "ล็อกตารางงาน" ในหน้า "ดูสแกนหน้า"
//
//   GET  /api/hr-schedule-lock
//        → { status:'success', locks:[{ branch, codes, lockedUntil, note, lockedBy, lockedAt }], branches:[{ name, fullName }] }
//          codes = รหัสทั้งกลุ่มของสาขานั้น (รหัสจริง + รหัสพ้อง) ตัวพิมพ์เล็ก ไว้จับคู่กับแถวสแกน
//          branches = สาขาทั้งหมดในฐาน HR ไว้ให้ติ๊กเลือก
//
//   POST /api/hr-schedule-lock   { branches:['crm','sum'], lockedUntil:'YYYY-MM-DD' | '', note? }
//        → { status:'success', message, locks:[...] }   lockedUntil ว่าง = ปลดล็อกสาขาเหล่านั้น
//
// "ล็อกถึงวันที่ X" = หน้าลงตารางของสาขา (Narai-branch) แก้ตารางงานของวันที่ <= X ไม่ได้
// ตัวกันจริงอยู่ที่ office-server (schedule-lock.js) — ร่างที่ค้างในเครื่องสาขาส่งขึ้นมาก็ไม่ผ่าน
// ฝั่งออฟฟิศเองไม่โดนล็อก (ส่ง user สิทธิ์ all ไป) ทั้งตารางงานและการแก้เวลาสแกนในหน้านี้
//
// ตั้ง/ปลดล็อกได้เฉพาะผู้ใช้ที่มีสิทธิ์เมนู "ดูสแกนหน้า" (หรือผู้ดูแลระบบ)
import { fetchScheduleBranches, fetchScheduleLocks, saveScheduleLocks } from '../../lib/hrSchedule';
import { branchAliasMap } from '../../lib/branchRegistry';
import { sessionFromRequest } from '../../lib/authToken';
import { hasPerm } from '../../lib/permissions';

export const config = { maxDuration: 30 };

const txt = (v) => (v == null ? '' : String(v).trim());
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** รหัสทั้งกลุ่มของสาขา (รหัสจริงก่อน ตามด้วยรหัสพ้อง) — ตัวพิมพ์เล็ก */
function groupOf(code, aliasTo) {
  const c = txt(code).toLowerCase();
  const canon = aliasTo[c] || c;
  return [...new Set([canon, c, ...Object.keys(aliasTo).filter((a) => aliasTo[a] === canon)])];
}

async function lockList() {
  const [rows, aliasTo] = await Promise.all([fetchScheduleLocks(), branchAliasMap().catch(() => ({}))]);
  return rows.map((r) => ({ ...r, codes: groupOf(r.branch, aliasTo) }));
}

/** office-server รุ่นเก่ายังไม่มีคำสั่งล็อก — บอกวิธีแก้ให้ตรงจุด */
function hintOf(message) {
  if (/ไม่รู้จักคำสั่ง/.test(message)) {
    return 'office-server ที่ออฟฟิศยังเป็นรุ่นเก่า (ยังไม่มีคำสั่งล็อกตารางงาน) — อัปเดต Narai-branch ด้วย update-office-server.bat แล้วรีสตาร์ท';
  }
  if (/hr-schedule-lock\.sql|สร้างตาราง/.test(message)) {
    return 'รัน docs/hr-schedule-lock.sql ของ Narai-branch ใน SSMS ที่เครื่องออฟฟิศครั้งเดียว';
  }
  if (/SCHEDULE_LOCK_KEY/.test(message)) {
    return 'ตั้ง SCHEDULE_LOCK_KEY บน Vercel ให้ตรงกับ .env ของ office-server แล้ว redeploy';
  }
  return undefined;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const [locks, branches] = await Promise.all([
        lockList(),
        fetchScheduleBranches().catch(() => []),
      ]);
      return res.status(200).json({ status: 'success', locks, branches });
    }

    if (req.method === 'POST') {
      const me = await sessionFromRequest(req);
      if (!me) return res.status(401).json({ status: 'error', message: 'ยังไม่ได้เข้าสู่ระบบ' });
      if (!hasPerm(me, 'attendance')) {
        return res.status(403).json({ status: 'error', message: 'ไม่มีสิทธิ์ล็อกตารางงาน (ต้องมีสิทธิ์เมนู "ดูสแกนหน้า")' });
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const branches = [...new Set((Array.isArray(body.branches) ? body.branches : [])
        .map((b) => txt(b).toLowerCase())
        .filter((b) => b && b !== 'all'))];
      const lockedUntil = txt(body.lockedUntil);
      if (branches.length === 0) {
        return res.status(400).json({ status: 'error', message: 'กรุณาเลือกสาขาอย่างน้อย 1 สาขา' });
      }
      if (lockedUntil && !isYmd(lockedUntil)) {
        return res.status(400).json({ status: 'error', message: 'รูปแบบวันที่ต้องเป็น YYYY-MM-DD' });
      }

      const out = await saveScheduleLocks({
        branches,
        lockedUntil,
        note: txt(body.note).slice(0, 255),
        by: me.displayName || me.username,
      });
      const locks = await lockList().catch(() => out?.locks || []);
      return res.status(200).json({ status: 'success', message: out?.message || 'บันทึกแล้ว', locks });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ status: 'error', message: 'รองรับเฉพาะ GET และ POST' });
  } catch (err) {
    const message = err?.message || 'ทำรายการไม่สำเร็จ';
    console.error('hr-schedule-lock API error:', message);
    const status = err?.status && err.status < 500 ? err.status : 502;
    return res.status(status).json({ status: 'error', message, hint: hintOf(message) });
  }
}
