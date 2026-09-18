// จำแนก error จาก Gemini แล้วแปลงเป็นข้อความที่ผู้ใช้อ่านแล้วรู้ว่าต้องทำอะไรต่อ
//
// แยกออกมาจาก pages/api/ai-chat.js เพราะไฟล์นั้นเป็น API route ที่เขียนเทสต์คลุมไม่ได้
// ตรรกะ "error แบบไหนควรขยับไปโมเดลถัดไป" จึงไม่เคยถูกตรวจเลย แล้วก็หลุดจริง:
// Gemini ตอบ 503 (โมเดลโหลดเต็ม) แล้วโค้ดโยน error ออกไปตั้งแต่โมเดลแรก ไม่ได้ลองตัวสำรอง
// ที่เตรียมไว้อีก 2 ตัวเลย ผู้ใช้เห็นข้อความอังกฤษดิบจาก Google ว่า
// "This model is currently experiencing high demand..." ทั้งที่โมเดลสำรองน่าจะตอบได้
//
// ตรวจด้วย scripts/test-gemini-errors.mjs

/** 429 / โควตาเต็ม — ขยับไปโมเดลถัดไปได้ */
const isRateLimited = (status, msg) => status === 429 || /quota|rate limit|RESOURCE_EXHAUSTED/i.test(msg);

/** 400 = คำขอไม่ผ่าน (พารามิเตอร์/ประวัติสนทนา) · 404 = ไม่มีโมเดลนี้ — ขยับไปตัวถัดไปได้ */
const isBadRequest = (status, msg) =>
  status === 400 || status === 404 ||
  (!status && /invalid argument|INVALID_ARGUMENT|not found|NOT_FOUND/i.test(msg));

/** 503/500 = ฝั่ง Google รับไม่ไหวชั่วคราว ไม่ใช่ความผิดของคำขอเรา — ขยับไปตัวถัดไปได้ */
const isOverloaded = (status, msg) =>
  status === 503 || status === 500 ||
  /overloaded|high demand|UNAVAILABLE|currently experiencing/i.test(msg);

/**
 * @param {{ status?: number, message?: string }} err
 * @returns {{ status: number|null, message: string, rateLimited: boolean, badRequest: boolean,
 *             overloaded: boolean, tryNextModel: boolean }}
 *   tryNextModel = ควรขยับไปโมเดลถัดไปใน MODEL_CHAIN แทนที่จะเลิกทั้งคำขอ
 */
export function classifyGeminiError(err = {}) {
  const status = Number(err.status) || null;
  const message = String(err.message || '');
  // ไล่จากเจาะจงที่สุดไปหากว้างที่สุด — ข้อความของ Google มีเลขสถานะปนอยู่ในเนื้อความได้
  const rateLimited = isRateLimited(status, message);
  const badRequest = !rateLimited && isBadRequest(status, message);
  const overloaded = !rateLimited && !badRequest && isOverloaded(status, message);
  return {
    status, message, rateLimited, badRequest, overloaded,
    tryNextModel: rateLimited || badRequest || overloaded,
  };
}

/** ข้อความสำหรับผู้ใช้ — ใช้กับ error ตัวสุดท้ายหลังลองครบทุกโมเดลแล้ว */
export function friendlyGeminiError(err) {
  const { message, rateLimited, badRequest, overloaded, status } = classifyGeminiError(err || {});
  if (!message) return 'เกิดข้อผิดพลาดที่ไม่รู้จัก';

  if (rateLimited) return 'โควตา AI เต็มชั่วคราวทุกโมเดล — รอสัก 1 นาทีแล้วถามใหม่ครับ';

  if (overloaded) {
    return 'AI ฝั่ง Google กำลังมีคนใช้งานหนักจนรับคำขอไม่ทัน และลองครบทุกโมเดลที่ตั้งไว้แล้ว '
      + '— ไม่ใช่โควตาของร้านหมด รอสัก 10-30 วินาทีแล้วกดถามใหม่ได้เลยครับ';
  }

  if (badRequest && status !== 404 && !/not found|NOT_FOUND/i.test(message)) {
    return 'AI ไม่รับคำขอนี้ (invalid argument) — มักเกิดตอนบทสนทนายาวมากหรือคำตอบก่อนหน้ามีตารางใหญ่ '
      + `ลองกด "ล้างบทสนทนา" แล้วถามใหม่เป็นคำถามเดียวจบครับ (รายละเอียด: ${message})`;
  }

  if (badRequest) {
    return `ไม่พบโมเดล AI ที่ตั้งไว้ — ตรวจค่า GEMINI_MODEL ใน Environment Variables ครับ (รายละเอียด: ${message})`;
  }

  return message;
}
