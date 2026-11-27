// ส่วนของ Total Food Cost ที่อยู่บน SQL Server (InventoryNarai) — ใช้กับหน้า ACC › ต้นทุนใบเบิกสาขา
// และการ์ดสรุปรวมในแดชบอร์ด
//
//   Total Food Cost = ต้นทุนจากใบเบิก + รายจ่ายจาก Supplier + ยอดยกมาเดือนที่แล้ว − ยอดมูลค่าสตอคปัจจุบัน
//
// สูตรและกติกาเลือกยอดสต๊อกพอร์ตมาจากหน้า "สรุปกำไร / ขาดทุน" ของแดชบอร์ดสาขา
// (Narai-branch: api/stockcount.js + src/components/ProfitSummary.jsx) เพื่อให้ตัวเลขตรงกับที่สาขาเห็น
// ต่างกันแค่ตรงนี้คิด "ทุกสาขาในคำขอเดียว" — ฝั่งสาขาคิดทีละสาขา
//
// ไฟล์นี้มีแค่ส่วนที่อยู่บน SQL Server (สต๊อกยกมา/คงเหลือ + รายจ่าย Supplier)
// ใบเบิกอยู่อีกฐาน (MySQL myfbdata.trans) — ดู pages/api/food-cost.js
//
// ไฟล์นี้ไม่รู้ว่า "ต่อฐานยังไง" — รับตัวยิง query (q) เข้ามา แนวเดียวกับ lib/stockCountSql.mjs
//   lib/sheetsSource.js      ฝั่งเว็บที่ต่อ SQL ตรง
//   host-server/sheets-db.js ฝั่ง host API (/sheets/food-cost)

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(str(v));

/** รหัสสินค้าที่ normalize แล้ว — ตัด .0 ท้าย + 0 นำหน้า (ตรงกับ normCode ฝั่งสาขา) */
export const normCode = (c) => str(c).replace(/\.0+$/, '').replace(/^0+/, '');

const pad2 = (n) => String(n).padStart(2, '0');

/** "2026-06" -> "2026-05" */
export function prevMonth(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return m > 1 ? `${y}-${pad2(m - 1)}` : `${y - 1}-12`;
}

/** "2026-12" -> "2027-01" */
export function nextMonth(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return m < 12 ? `${y}-${pad2(m + 1)}` : `${y + 1}-01`;
}

/** วันสุดท้ายของเดือน "2026-02" -> "2026-02-28" */
export function monthEndOf(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return `${ym}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/**
 * ยอดปิดรอบที่บันทึกวันที่ 1-5 นับเป็นยอดปิดของ "เดือนก่อนหน้า" (พนักงานมักกดปิดยอดช้าไม่กี่วัน)
 * กติกาเดียวกับ closingMonthOf ใน Narai-branch/api/stockcount.js — ห้ามเปลี่ยนแยก ไม่งั้นยอดไม่ตรงหน้าสาขา
 */
export function closingMonthOf(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  if (d >= 1 && d <= 5) return m > 1 ? `${y}-${pad2(m - 1)}` : `${y - 1}-12`;
  return `${y}-${pad2(m)}`;
}

/** เดือนปัจจุบันตามเวลาไทย "YYYY-MM" */
const thaiThisMonth = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);

/**
 * @param {{ q: (text:string, params?:object) => Promise<object[]> }} deps
 */
export function createFoodCost({ q }) {
  /**
   * สต๊อกยกมา/คงเหลือ + รายจ่าย Supplier ของทุกสาขา
   *
   * @param {object} p
   * @param {string} p.start 'YYYY-MM-DD' — ต้นช่วงของรายจ่าย Supplier
   * @param {string} p.end   'YYYY-MM-DD' — เดือนของวันนี้คือ "เดือนปัจจุบัน" ของการนับสต๊อก
   * @param {string} [p.branch] ระบุสาขา (ตัวพิมพ์เล็ก รหัสจริงหรือรหัสพ้อง) = แนบรายการสินค้าของสาขานั้นมาด้วย
   * @param {Object<string,string>} [p.aliasTo] รหัสพ้อง -> รหัสจริง (ตัวพิมพ์เล็ก) เช่น { zjp: 'sjp' }
   * @returns {Promise<{ curMonth, preMonth, branches: Object<string, {
   *   current:{countDate,source,total,items?}, previous:{countDate,source,total,items?},
   *   supCost:{total,count,items?} }> }>}
   */
  async function readStockAndSup({ start, end, branch = '', aliasTo = {} }) {
    if (!isYmd(start) || !isYmd(end)) throw new Error('ระบุวันที่ไม่ถูกต้อง (YYYY-MM-DD)');
    const canon = (b) => {
      const k = str(b).toLowerCase();
      return aliasTo[k] || k;
    };
    const want = branch ? canon(branch) : '';

    const curMonth = end.slice(0, 7);
    const preMonth = prevMonth(curMonth);

    const [counts, closings, prices, sups] = await Promise.all([
      // ยอดนับล่าสุดของแต่ละ (สาขา, สินค้า) แยกเดือนก่อนหน้า (ทั้งเดือน) กับเดือนปัจจุบัน (ไม่เกิน end)
      // คิดใน SQL ด้วย ROW_NUMBER — ถ้าดึงแถวนับดิบทุกสาขาสองเดือนมาคิดในเว็บจะได้หลักแสนแถว
      q(`SELECT x.branch, x.mon, x.item_key, x.item_code, x.item_name, x.unit, x.remaining, x.date_text, x.counted_text
           FROM (
             SELECT LOWER(LTRIM(RTRIM(branch))) AS branch,
                    CONVERT(NVARCHAR(7), counted_at, 23) AS mon,
                    item_key, item_code, item_name, unit, remaining,
                    CONVERT(NVARCHAR(10), counted_at, 23) AS date_text,
                    CONVERT(NVARCHAR(19), counted_at, 120) AS counted_text,
                    ROW_NUMBER() OVER (
                      PARTITION BY LOWER(LTRIM(RTRIM(branch))), CONVERT(NVARCHAR(7), counted_at, 23), item_key
                      ORDER BY counted_at DESC, count_id DESC) AS rn
               FROM dbo.stock_count
              WHERE counted_at >= CONVERT(DATETIME2(0), @from + ' 00:00:00', 120)
                AND counted_at <= CONVERT(DATETIME2(0), @to + ' 23:59:59', 120)
           ) x
          WHERE x.rn = 1`,
        { from: `${preMonth}-01`, to: end }),
      // ยอดปิดรอบ: ช่วงที่อาจถูกนับเป็นของเดือนก่อนหน้าหรือเดือนปัจจุบัน (กติกาวันที่ 1-5 ดู closingMonthOf)
      q(`SELECT LOWER(LTRIM(RTRIM(branch))) AS branch, CONVERT(NVARCHAR(10), closing_date, 23) AS date_text,
                item_key, item_code, item_name, unit, qty, unit_price, amount
           FROM dbo.stock_month_end
          WHERE closing_date >= CONVERT(DATE, @from, 120) AND closing_date <= CONVERT(DATE, @to, 120)
          ORDER BY closing_id`,
        { from: `${preMonth}-06`, to: `${nextMonth(curMonth)}-05` }),
      // ราคาต่อหน่วยจากทะเบียนสินค้า (ทั้งทะเบียน ไม่กรองสาขา/สถานะ — ต้องตีราคาของที่นับไปแล้วทุกตัว)
      q(`SELECT item_key, item_code, price FROM dbo.stock_item`),
      // รายจ่าย Supplier ในช่วง [start, end] — แถวที่แก้เป็น 0 คือยกเลิก ไม่นับ
      q(`SELECT LOWER(LTRIM(RTRIM(branch))) AS branch, CONVERT(NVARCHAR(10), cost_date, 23) AS date_text,
                item_code, item_name, unit, qty, unit_price, amount
           FROM dbo.stock_sup_cost
          WHERE cost_date BETWEEN CONVERT(DATE, @from, 120) AND CONVERT(DATE, @to, 120)
            AND qty > 0
          ORDER BY cost_date, sup_id`,
        { from: start, to: end }),
    ]);

    const priceMap = {};
    for (const r of prices) {
      const code = normCode(r.item_key || r.item_code);
      if (code) priceMap[code] = r.price === null || r.price === undefined ? 0 : Number(r.price);
    }

    const out = {};
    const slot = (b) => out[b] || (out[b] = { counts: { cur: {}, pre: {} }, closing: [], sup: [] });

    // ยอดนับ — รหัสพ้อง (zjp/sjp) รวมเป็นสาขาเดียว สินค้าเดียวกันเอาครั้งที่นับหลังสุด
    for (const r of counts) {
      const b = canon(r.branch);
      if (!b) continue;
      const bucket = r.mon === curMonth ? 'cur' : r.mon === preMonth ? 'pre' : '';
      if (!bucket) continue;
      const code = normCode(r.item_key || r.item_code);
      if (!code) continue;
      const m = slot(b).counts[bucket];
      const prev = m[code];
      if (prev && prev.counted > str(r.counted_text)) continue;
      m[code] = {
        counted: str(r.counted_text), date: str(r.date_text), itemCode: code,
        itemName: str(r.item_name) || '-', unit: str(r.unit), qty: num(r.remaining),
      };
    }
    for (const r of closings) slot(canon(r.branch)).closing.push(r);
    for (const r of sups) slot(canon(r.branch)).sup.push(r);

    const priced = (it) => {
      const has = Object.prototype.hasOwnProperty.call(priceMap, it.itemCode);
      const unitPrice = has ? priceMap[it.itemCode] : 0;
      return { itemCode: it.itemCode, itemName: it.itemName, unit: it.unit, qty: it.qty, unitPrice, value: it.qty * unitPrice, priced: has };
    };
    const fromCounts = (m) => {
      const list = Object.values(m);
      if (!list.length) return { countDate: '', total: 0, data: [] };
      const countDate = list.reduce((x, it) => (it.date > x ? it.date : x), '');
      const data = list.map(priced);
      return { countDate, total: data.reduce((s, it) => s + it.value, 0), data };
    };
    // ยอดปิดรอบของเดือนเป้าหมาย — แถวหลังสุดของสินค้าเดียวกันชนะ (เรียงตาม closing_id มาแล้ว)
    const fromClosing = (rows, target) => {
      const map = {};
      let latest = '';
      for (const r of rows) {
        const ds = str(r.date_text);
        if (!ds || closingMonthOf(ds) !== target) continue;
        const code = normCode(r.item_key || r.item_code);
        if (!code) continue;
        const qty = num(r.qty);
        const unitPrice = num(r.unit_price);
        const value = r.amount !== null && r.amount !== undefined ? num(r.amount) : qty * unitPrice;
        map[code] = { itemCode: code, itemName: str(r.item_name) || '-', unit: str(r.unit), qty, unitPrice, value, priced: true };
        if (ds > latest) latest = ds;
      }
      const data = Object.values(map);
      return { countDate: latest, total: data.reduce((s, it) => s + it.value, 0), data };
    };

    // เดือนปัจจุบันใช้ยอดปิดรอบแทนยอดนับเฉพาะเมื่อ: เป็นเดือนที่ผ่านไปแล้ว + เลือกถึงสิ้นเดือนพอดี + มียอดปิดรอบแล้ว
    const useClosingCur = curMonth < thaiThisMonth() && end === monthEndOf(curMonth);

    const branches = {};
    for (const [b, s] of Object.entries(out)) {
      const closeCur = useClosingCur ? fromClosing(s.closing, curMonth) : null;
      const current = closeCur?.data.length ? { ...closeCur, source: 'closing' } : { ...fromCounts(s.counts.cur), source: 'count' };
      const closePrev = fromClosing(s.closing, preMonth);
      const previous = closePrev.data.length ? { ...closePrev, source: 'closing' } : { ...fromCounts(s.counts.pre), source: 'count' };

      const supItems = s.sup.map((r) => ({
        date: str(r.date_text), code: str(r.item_code), name: str(r.item_name), unit: str(r.unit),
        qty: num(r.qty), unitPrice: num(r.unit_price), amount: num(r.amount),
      }));
      const supTotal = Math.round(supItems.reduce((t, r) => t + r.amount, 0) * 100) / 100;

      const detail = want && b === want;
      const pack = (x) => ({
        countDate: x.countDate, source: x.source, total: x.total,
        unpriced: x.data.filter((it) => it.qty > 0 && !it.priced).length,
        ...(detail ? { items: x.data.slice().sort((a1, a2) => a2.value - a1.value) } : {}),
      });
      branches[b] = {
        current: pack(current),
        previous: pack(previous),
        supCost: { total: supTotal, count: supItems.length, ...(detail ? { items: supItems } : {}) },
      };
    }
    return { curMonth, preMonth, branches };
  }

  return { readStockAndSup };
}
