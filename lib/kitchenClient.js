// ตัวช่วยฝั่งหน้าเว็บของ QC/RD › รายงานการผลิต — ยกมาจาก narai-storefct (services/kitchenService.js,
// services/qcrdService.js, services/dateQuick.js) เท่าที่หน้ารายงานใช้ ให้ตัวเลข/วันที่ออกมาเหมือนหน้าครัวกลาง
//
// ต่างจากฝั่งนั้นแค่ปลายทาง: ทุกอย่างวิ่งผ่าน /api/kitchen-report ของที่นี่ (ดู lib/kitchenReport.js)

async function readJson(res) {
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ (HTTP ${res.status})`);
  if (!res.ok || json.status !== 'success') throw new Error(json.message || `เกิดข้อผิดพลาด (HTTP ${res.status})`);
  const { status, ...data } = json;
  return data;
}

async function request(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    // fetch โยน error เฉพาะตอนต่อไม่ติดจริงๆ (เน็ตหลุด, เซิร์ฟเวอร์ไม่ตอบ)
    throw new Error('ต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่');
  }
  return readJson(res);
}

/** เรียก action ของครัวกลาง (อ่านอย่างเดียว) — คืนเนื้อคำตอบไม่รวมฟิลด์ status */
export const kitchenCall = (action, payload = {}) => request('/api/kitchen-report', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action, ...payload }),
});

/** รายชื่อเมนู QC/RD — { menus, loadedAt } */
export const fetchQcrdMenus = (refresh = false) =>
  request(`/api/kitchen-report?menus=1${refresh ? '&refresh=1' : ''}`);

/** สูตรของเมนูหนึ่งตัว — { menu, lines } (qty ของ lines เป็นหน่วยเล็กตาม QC/RD) */
export const fetchQcrdRecipe = (code) =>
  request(`/api/kitchen-report?recipe=${encodeURIComponent(code)}`);

/* ------------------------------ วันที่ / ตัวเลข (ชุดเดียวกับครัวกลาง) ------------------------------ */

/** วันที่วันนี้แบบ YYYY-MM-DD ตามเวลาไทย — ใช้เป็นค่าตั้งต้นของช่องวันที่ทุกหน้า */
export function todayYmd() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** บวก/ลบวันจากสตริง YYYY-MM-DD โดยไม่ผ่าน new Date(str) ซึ่งตีความเป็น UTC แล้วเพี้ยนหนึ่งวัน */
export function shiftYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** วันที่แบบอ่านง่าย เช่น "17 ก.ย. 2026" (ปี ค.ศ. ไม่ใช่ พ.ศ.) */
export function formatThaiDate(value) {
  if (!value) return '-';
  const raw = String(value).slice(0, 10);
  const [y, m, d] = raw.split('-').map(Number);
  if (!y || !m || !d) return raw;
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
    'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  return `${d} ${months[m - 1]} ${y}`;
}

/** ตัวเลขแบบอ่านง่าย ตัดศูนย์ท้ายทศนิยมทิ้ง (12.500 -> 12.5, 3.000 -> 3) */
export function formatQty(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

/** เงินบาท 2 ตำแหน่ง เช่น ฿1,234.50 */
export function formatBaht(value) {
  const n = Number(value);
  return `฿${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}


/* ------------------------------ ปุ่มลัดช่วงวันที่ ------------------------------ */

export const QUICK_LABEL = {
  yesterday: 'เมื่อวาน',
  today: 'วันนี้',
  tomorrow: 'พรุ่งนี้',
  lastWeek: 'สัปดาห์ที่แล้ว',
  week: 'สัปดาห์นี้',
  month: 'เดือนนี้',
  lastMonth: 'เดือนที่แล้ว',
};

/**
 * ช่วงวันที่ [from, to] ของปุ่มลัด
 * สัปดาห์นี้ = จันทร์–อาทิตย์ · สัปดาห์ที่แล้ว = จันทร์–อาทิตย์ของสัปดาห์ก่อน · เดือนนี้ = วันที่ 1–สิ้นเดือน (เต็มช่วง เพราะหลายหน้าต้องดูวันข้างหน้าด้วย)
 */
export function quickRange(kind, today) {
  const [y, m, d] = today.split('-').map(Number);
  const iso = (dt) => dt.toISOString().slice(0, 10);
  switch (kind) {
    case 'yesterday': { const x = shiftYmd(today, -1); return [x, x]; }
    case 'tomorrow': { const x = shiftYmd(today, 1); return [x, x]; }
    case 'week': {
      const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = อาทิตย์
      const mon = shiftYmd(today, -((wd + 6) % 7));
      return [mon, shiftYmd(mon, 6)];
    }
    case 'lastWeek': {
      const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      const mon = shiftYmd(today, -((wd + 6) % 7) - 7);
      return [mon, shiftYmd(mon, 6)];
    }
    case 'month': return [iso(new Date(Date.UTC(y, m - 1, 1))), iso(new Date(Date.UTC(y, m, 0)))];
    case 'lastMonth': return [iso(new Date(Date.UTC(y, m - 2, 1))), iso(new Date(Date.UTC(y, m - 1, 0)))];
    default: return [today, today];
  }
}
