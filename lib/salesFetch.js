// ตัวช่วยดึงข้อมูล "บิล/ยอดขาย" จาก /api/sales — ชุดเดียวที่ทุกหน้าฝั่งยอดขายใช้ร่วมกัน
//
// เดิมโค้ดชุดนี้ (หั่นช่วงวันที่ทีละ 5 วัน · อ่าน JSON แบบกันหน้า error · ยึดวันเปิดบิล)
// อยู่ในตัว pages/index.js ที่เดียว คอมโพเนนต์อื่นที่ต้องตีความแถวบิลแบบเดียวกัน
// (เช่นหน้าใบกำกับภาษี ที่ใช้ dateFromRow) จึงเรียกใช้ไม่ได้ ต้องก๊อปไปทั้งดุ้น
// ย้ายมารวมไว้ที่นี่เพื่อให้ "กติกาการดึงบิล" มีที่มาที่เดียว แก้ทีเดียวตรงกันทุกหน้า
//
// ⚠️ ไฟล์นี้ใช้ทั้งจากหน้าเว็บและคอมโพเนนต์ ห้ามใส่ import ที่เป็นโมดูลของ Node

/** ดึงข้อมูลเผื่อท้ายช่วงไว้กี่วัน (รองรับบิลที่ "เปิด" ในช่วง แต่ "ปิด/ชำระ" ข้ามวัน) */
export const OPEN_DATE_BUFFER_DAYS = 2;

export const addDaysStr = (str, days) => {
  const d = new Date(str);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** ยึด "วันที่เปิดบิล" (startTime) เป็นหลักทุกเมนู; fallback เป็นวันปิด/ชำระ (date) ถ้าไม่มี */
export const dateFromRow = row => {
  const t = row['startTime'];
  if (t) return String(t).slice(0, 10);
  const d = row['Date'] || row['date'];
  return d ? String(d).slice(0, 10) : '-';
};

/** หั่นช่วงวันที่เป็นก้อนละ chunkSizeDays วัน — ยิงทีเดียวยาว ๆ ฝั่ง host จะหมดเวลาก่อน */
export function getChunks(startStr, endStr, chunkSizeDays = 5) {
  const chunks = [];
  let start = new Date(startStr);
  const end = new Date(endStr);

  while (start <= end) {
    let chunkEnd = new Date(start);
    chunkEnd.setDate(chunkEnd.getDate() + chunkSizeDays - 1);
    if (chunkEnd > end) {
      chunkEnd = new Date(end);
    }

    chunks.push({
      start: start.toISOString().slice(0, 10),
      end: chunkEnd.toISOString().slice(0, 10)
    });

    start = new Date(chunkEnd);
    start.setDate(start.getDate() + 1);
  }
  return chunks;
}

/** คำตอบของ API ฝั่งบิลมาได้หลายทรง (array ตรง ๆ / .data / .result) — คืนเป็น array เสมอ */
export const normalizeArray = json =>
  Array.isArray(json) ? json
  : Array.isArray(json.data) ? json.data
  : Array.isArray(json.result) ? json.result
  : Object.values(json).find(v => Array.isArray(v)) ?? [];

/** สถานะที่ "ลองใหม่แล้วมีโอกาสได้" — 502 คือ /api/sales บอกว่า host API ไม่ตอบ/ตอบช้า */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// อ่าน response แบบปลอดภัย: ถ้าเซิร์ฟเวอร์ล้ม/หมดเวลาจะได้หน้า error เป็น HTML/ข้อความดิบ
// (เช่น "An error occurred..." ของ Vercel) ไม่ใช่ JSON — เดิม res.json() ตรงนี้จะโยน
// SyntaxError ดิบที่อ่านไม่รู้เรื่อง ("Unexpected token 'A'...") ฟังก์ชันนี้แปลงเป็น
// ข้อความไทยที่บอกสาเหตุและช่วงวันที่ที่มีปัญหาแทน
//
// err.retryable = true แปลว่า "สะดุดชั่วคราว ลองใหม่แล้วมีโอกาสได้" (ดู fetchChunkJson)
// ส่วนคำขอที่ผิดเอง (400 = ไม่ได้ส่งวันที่มา) ไม่ติดธง เพราะลองกี่รอบก็ได้ผลเดิม
export async function safeFetchJson(res, label, chunkLabel) {
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    const isTimeout = /FUNCTION_INVOCATION_TIMEOUT|An error occurred with your deployment/i.test(text);
    const err = new Error(isTimeout
      ? `${label}: เซิร์ฟเวอร์ตอบช้าเกินไป (หมดเวลา) ช่วง ${chunkLabel} — ลองกด "ค้นหาข้อมูล" ใหม่อีกครั้ง หรือเลือกช่วงวันที่/สาขาให้แคบลง`
      : `${label}: ได้รับข้อมูลที่ไม่ใช่ JSON (สถานะ ${res.status}) ช่วง ${chunkLabel}`);
    err.retryable = true;   // ได้หน้า error แทน JSON = ฝั่งเซิร์ฟเวอร์สะดุด ไม่ใช่คำขอผิด
    throw err;
  }
  if (!res.ok) {
    const err = new Error(json.error || `${label}: HTTP ${res.status} (ช่วง ${chunkLabel})`);
    err.retryable = RETRYABLE_STATUS.has(res.status);
    err.status = res.status;
    throw err;
  }
  return json;
}

// หน่วงก่อนลองใหม่ครั้งที่ 1 และ 2 (ลองทั้งหมดได้ 3 รอบต่อหนึ่งคำขอ)
//
// ทำไมการลองใหม่ถึงช่วยได้จริง ไม่ใช่แค่ยิงซ้ำเปล่า ๆ: ตอนฝั่ง Vercel ตัดที่ 55 วิ
// คำสั่ง SQL ที่เครื่องร้าน "ยังวิ่งต่อ" จนจบ (requestTimeout ที่ host-server = 90 วิ)
// แล้วข้อมูลที่สแกนมาจะค้างอยู่ใน buffer cache ของ SQL Server — รอบถัดไปที่ขอช่วงเดิม
// จึงมักเร็วกว่ารอบแรกมาก เพราะไม่ต้องอ่านดิสก์ใหม่ทั้งตาราง
// หน่วงให้นานพอที่รอบแรกจะวิ่งจนจบก่อน ไม่งั้นได้สแกนทั้งตารางสองชุดพร้อมกันบนเครื่อง 2 คอร์
const RETRY_DELAYS_MS = [8000, 20000];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * ดึง JSON ของ "ก้อนวันที่" หนึ่งก้อน พร้อมลองใหม่เองเมื่อสะดุดชั่วคราว
 *
 * ดึงทั้งเดือน = 6 ก้อน x 2 คำขอ (บิล+รายการ) ถ้าแต่ละคำขอมีโอกาสพลาด 10%
 * โอกาสที่ทั้งงานรอดเหลือแค่ ~28% — เดิมพลาดคำขอเดียวก็ทิ้งข้อมูลที่ดึงมาแล้วทั้งหมด
 * แล้วขึ้น error ให้คนกดค้นหาใหม่เองตั้งแต่ต้น กลายเป็นอาการ "มาบ้างไม่มาบ้าง"
 *
 * @param {(info: {attempt:number,total:number,label:string,chunkLabel:string,error:Error}) => void} [onRetry]
 *        เรียกก่อนหน่วงรอลองใหม่ — ไว้บอกบนหน้าจอว่ากำลังลองใหม่อยู่ ไม่ใช่ค้าง
 */
export async function fetchChunkJson(url, label, chunkLabel, { onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      onRetry?.({ attempt, total: RETRY_DELAYS_MS.length, label, chunkLabel, error: lastErr });
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
    try {
      return await safeFetchJson(await fetch(url, { cache: 'no-store' }), label, chunkLabel);
    } catch (err) {
      // fetch เองล้ม (เน็ตหลุด · เบราว์เซอร์ตัดคำขอ) ไม่มี response ให้ดูสถานะ — โยน TypeError
      // ออกมาดื้อ ๆ ซึ่งเป็นอาการชั่วคราวเหมือนกัน จึงนับเป็น retryable ด้วย
      if (err?.retryable === undefined && err?.name === 'TypeError') err.retryable = true;
      if (!err?.retryable) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
