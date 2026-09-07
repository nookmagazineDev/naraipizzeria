// ด่านหน้าของ /api/* — ไม่มีตั๋วเข้าระบบ = ไม่ได้ข้อมูล
//
// ทำไมต้องมี: การซ่อนเมนูในแถบข้างเป็นแค่การซ่อน "ปุ่ม" — ใครเปิด /api/sales ตรง ๆ
// ก็ยังได้ยอดขายทั้งบริษัทไปอยู่ดี ด่านนี้ทำให้สิทธิ์ที่ตั้งในหน้าจัดการผู้ใช้มีผลจริง
//
// ⚠️ ด่านนี้เช็กแค่ "ล็อกอินหรือยัง" ไม่ได้เช็กว่าเปิดเมนูไหนได้บ้าง
//    การคุมรายเมนูอยู่ที่ฝั่งหน้าเว็บ (lib/permissions.js → hasPerm) เพราะ API หลายเส้น
//    ถูกใช้ร่วมกันหลายเมนู (เช่น /api/branches ใช้เติม dropdown แทบทุกหน้า) การผูก
//    เส้น API กับคีย์เมนูตายตัวจะทำให้หน้าที่ได้สิทธิ์แล้วโหลดของไม่ครบ
//    เส้นที่อันตรายกว่าคนอื่นเช็กบทบาทซ้ำในตัวเอง (/api/users ต้องเป็น admin เท่านั้น)
//
// รันบน Edge runtime — ใช้ได้เฉพาะของที่มีใน Web API (lib/authToken.js ใช้ crypto.subtle
// ไม่ใช่ node:crypto ด้วยเหตุนี้) ห้าม import อะไรที่ลาก mssql หรือ node:* เข้ามาเด็ดขาด
import { NextResponse } from 'next/server';
import { COOKIE_NAME, verifySession } from './lib/authToken';

/** เส้นที่ต้องเข้าได้ก่อนล็อกอิน — ไม่งั้นก็ล็อกอินไม่ได้ */
const PUBLIC_PATHS = ['/api/auth'];

/**
 * ทางออกฉุกเฉินสองอัน เผื่อด่านนี้ไปขวางของที่ยิงเข้ามาจากนอกหน้าเว็บ
 * (สคริปต์ที่เครื่องออฟฟิศ, GAS, งาน cron ที่ตั้งไว้)
 *   AUTH_DISABLED=1              ปิดด่านทั้งหมดชั่วคราว
 *   AUTH_PUBLIC_API=/api/a,/api/b  ปล่อยผ่านเฉพาะเส้นที่ระบุ
 * ตั้งได้ที่ Vercel → Settings → Environment Variables (ต้อง redeploy ถึงมีผล)
 */
const extraPublic = () =>
  String(process.env.AUTH_PUBLIC_API || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

export async function middleware(req) {
  if (String(process.env.AUTH_DISABLED || '') === '1') return NextResponse.next();

  const { pathname } = req.nextUrl;
  const allowed = [...PUBLIC_PATHS, ...extraPublic()];
  if (allowed.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(COOKIE_NAME)?.value || '';
  if (await verifySession(token)) return NextResponse.next();

  // 401 ให้หน้าเว็บรู้ว่าต้องเด้งกลับไปหน้าล็อกอิน (ตั๋วหมดอายุระหว่างเปิดค้างไว้)
  return new NextResponse(
    JSON.stringify({ status: 'error', message: 'ยังไม่ได้เข้าสู่ระบบ หรือหมดเวลาใช้งานแล้ว — กรุณาเข้าสู่ระบบใหม่' }),
    { status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

export const config = {
  matcher: ['/api/:path*'],
};
