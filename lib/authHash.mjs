// เข้ารหัส/ตรวจรหัสผ่านด้วย scrypt — ใช้ร่วมกันสองฝั่ง
//
// ฝั่ง Vercel (lib/authUsers.js) และฝั่งเครื่องออฟฟิศ (host-server/auth-db.js) ต้องคิดค่า
// แบบเดียวกันเป๊ะ ไม่งั้นรหัสที่ตั้งจากทางหนึ่งจะเข้าอีกทางไม่ได้ — จึงอยู่ไฟล์เดียวกัน
// (กติกาเดียวกับ lib/qcrdSql.mjs ที่ host-server ดึงไปใช้ด้วย dynamic import)
//
// ใช้ scrypt ของ node ล้วน ๆ ไม่เพิ่ม dependency (bcrypt/argon2 ต้อง build native บน Vercel)
// N=16384 คือค่ามาตรฐานที่ node แนะนำ ใช้เวลาราว 50–100 มิลลิวินาทีต่อครั้ง
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const KEY_LEN = 32;

/** เก็บเป็นข้อความบรรทัดเดียว: scrypt$<N>$<salt hex>$<key hex> */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(String(password), salt, KEY_LEN, { N: SCRYPT_N, r: 8, p: 1 });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** เทียบรหัสผ่านกับค่าที่เก็บไว้ — รูปแบบแปลก/ว่าง = ไม่ผ่าน (ไม่โยน error) */
export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').trim().split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  try {
    const n = Number(parts[1]) || SCRYPT_N;
    const salt = Buffer.from(parts[2], 'hex');
    const want = Buffer.from(parts[3], 'hex');
    const got = scryptSync(String(password), salt, want.length, { N: n, r: 8, p: 1 });
    return timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** เทียบข้อความล้วนแบบไม่ให้เวลาที่ใช้ฟ้องว่าตรงกันกี่ตัว (ใช้กับกุญแจ/รหัสที่อ่านจาก env) */
export function plainEquals(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}
