// ตัวช่วยดึงข้อมูล "บิล/ยอดขาย" จาก /api/sales — ชุดเดียวที่ทุกหน้าฝั่งยอดขายใช้ร่วมกัน
//
// เดิมโค้ดชุดนี้ (หั่นช่วงวันที่ทีละ 5 วัน · อ่าน JSON แบบกันหน้า error · ยึดวันเปิดบิล)
// อยู่ในตัว pages/index.js ที่เดียว หน้าใหม่ที่อยากได้บิลชุดเดียวกันจึงต้องก๊อปไปทั้งดุ้น
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

// อ่าน response แบบปลอดภัย: ถ้าเซิร์ฟเวอร์ล้ม/หมดเวลาจะได้หน้า error เป็น HTML/ข้อความดิบ
// (เช่น "An error occurred..." ของ Vercel) ไม่ใช่ JSON — เดิม res.json() ตรงนี้จะโยน
// SyntaxError ดิบที่อ่านไม่รู้เรื่อง ("Unexpected token 'A'...") ฟังก์ชันนี้แปลงเป็น
// ข้อความไทยที่บอกสาเหตุและช่วงวันที่ที่มีปัญหาแทน
export async function safeFetchJson(res, label, chunkLabel) {
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    const isTimeout = /FUNCTION_INVOCATION_TIMEOUT|An error occurred with your deployment/i.test(text);
    throw new Error(isTimeout
      ? `${label}: เซิร์ฟเวอร์ตอบช้าเกินไป (หมดเวลา) ช่วง ${chunkLabel} — ลองกด "ค้นหาข้อมูล" ใหม่อีกครั้ง หรือเลือกช่วงวันที่/สาขาให้แคบลง`
      : `${label}: ได้รับข้อมูลที่ไม่ใช่ JSON (สถานะ ${res.status}) ช่วง ${chunkLabel}`);
  }
  if (!res.ok) throw new Error(json.error || `${label}: HTTP ${res.status} (ช่วง ${chunkLabel})`);
  return json;
}

/**
 * ดึงบิลทั้งช่วง (หั่นเป็นก้อน + ดึงเผื่อท้ายช่วง + คัดเหลือเฉพาะบิลที่ "เปิด" ในช่วงจริง)
 * คืนแถวดิบจาก /api/sales ตามที่ host ส่งมา ไม่ตัดโต๊ะ/ไอเทมใด ๆ ออก
 * (กติกาตัดออกเป็นเรื่องของการคิดยอดขาย หน้าที่เอาไปใช้ค่อยตัดเองตามที่ต้องการ)
 *
 * @param {{ start: string, end: string, outlet?: string|number,
 *           chunkDays?: number, onProgress?: (p: {current:number,total:number}) => void }} opts
 */
export async function fetchSalesRange({ start, end, outlet, chunkDays = 5, onProgress }) {
  const outletParam = outlet ? `&outlet=${encodeURIComponent(outlet)}` : '';
  const chunks = getChunks(start, addDaysStr(end, OPEN_DATE_BUFFER_DAYS), chunkDays);
  let rows = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    onProgress?.({ current: i, total: chunks.length });
    const res = await fetch(`/api/sales?start=${chunk.start}&end=${chunk.end}${outletParam}`);
    const json = await safeFetchJson(res, 'Sales API', `${chunk.start} ถึง ${chunk.end}`);
    rows = rows.concat(normalizeArray(json));
  }
  onProgress?.({ current: chunks.length, total: chunks.length });

  // ตัดบิลส่วนเกินที่ดึงเผื่อมาจาก buffer ท้ายช่วงออก
  return rows.filter(r => {
    const d = dateFromRow(r);
    return d >= start && d <= end;
  });
}
