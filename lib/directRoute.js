// "ต่อ SQL ตรงจาก Vercel ไปไม่ถึง" — ตัวรู้จำ error + ตัวจำว่าเพิ่งต่อไม่ติด (ใช้ร่วมกันทุกหน้า)
//
// ที่ร้าน SQL Server ไม่ได้เปิดพอร์ตออกเน็ตตลอดเวลา (ดู docs/sheets-sql-migration.md) แต่บน Vercel
// ตั้ง QCRD_DB_USER/PASSWORD ไว้ใช้กับหน้าอื่น hasDirectDb() จึงเป็น true เสมอ ทางที่เลือกจึงเป็น
// "ต่อตรง" แล้วไปตายที่ "Failed to connect to inventory.dyndns.tv:1433 in 15000ms" ทั้งที่ทาง
// host API (tunnel ขาออกของเครื่องออฟฟิศ) ยังใช้ได้อยู่
//
// ทุกทางที่มีทางถอย (ปิดรอบเดือน · QC/RD อ่าน/เขียน/อัพขึ้น SQL) จึงใช้ชุดนี้ร่วมกัน:
//   ลองต่อตรงก่อน -> เจอ error แบบ "ไปไม่ถึงเครื่อง" -> จำไว้ 5 นาที แล้วถอยไป host API
// error แบบอื่น (ตารางไม่มี · ไม่มีสิทธิ์ · จับคู่คอลัมน์ไม่ได้) ต้องเด้งขึ้นไปให้คนอ่านแก้ ห้ามกลบด้วยการถอย

/** error ที่แปลว่า "ไปไม่ถึง SQL Server" (พอร์ตไม่เปิด/เครื่องดับ/DNS เพี้ยน) ไม่ใช่ปัญหาที่ตัวคำสั่ง */
export const isUnreachable = (msg) =>
  /ต่อ SQL Server .*ไม่ได้|Failed to connect|ETIMEOUT|ESOCKET|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up|getaddrinfo/i
    .test(msg || '');

// ต่อตรงไม่ติดครั้งหนึ่งแล้วรออีก 15 วิทุกคำขอถัดไปไม่มีประโยชน์ — พอร์ตที่ปิดอยู่ไม่ได้เปิดเองใน 1 นาที
// จำไว้ 5 นาทีแล้วข้ามไป host API เลย เวลาที่ประหยัดได้เอาไปเผื่อให้ host API ตอบทัน
// (เก็บบน globalThis เพราะ Vercel ใช้ instance ซ้ำระหว่าง request และหลายหน้าต่างไฟล์กันต้องเห็นค่าเดียวกัน
//  instance ใหม่ก็แค่ลองต่อตรงอีกครั้ง ซึ่งเป็นสิ่งที่ต้องการอยู่แล้ว — วันไหนเปิดพอร์ตจริง
//  จะได้กลับไปใช้ทางเร็วเองโดยไม่ต้อง deploy ใหม่)
const DIRECT_COOLDOWN_MS = 5 * 60 * 1000;
const g = globalThis;
g.__directDownUntil = g.__directDownUntil || 0;

/** เพิ่งต่อตรงไม่ติดเมื่อครู่ไหม — true = ข้ามไป host API เลย ไม่ต้องเสียเวลารออีก 15 วิ */
export const directDown = () => Date.now() < g.__directDownUntil;

/** จำว่าต่อตรงไม่ติด (เริ่มนับ cooldown ใหม่ทุกครั้งที่เจอ) */
export const markDirectDown = () => { g.__directDownUntil = Date.now() + DIRECT_COOLDOWN_MS; };

/** ต่อตรงได้แล้ว — ล้างที่จำไว้ จะได้ใช้ทางเร็วต่อทันที */
export const clearDirectDown = () => { g.__directDownUntil = 0; };
