// ยอดขายรายวันของสาขา — ใช้คู่กับค่าแรงในหน้ารายละเอียดค่าแรง (หน้า "ดูสแกนหน้า")
//
// ดึงบิลจาก /api/sales ด้วยตัวช่วยชุดเดียวกับหน้ายอดขาย (lib/salesFetch.js) แล้วรวมเป็นยอดต่อวัน:
//   - ยึดวันเปิดบิล (dateFromRow) และดึงเผื่อท้ายช่วงไว้สำหรับบิลที่ปิดข้ามวัน
//   - ยอด = billTotal หัก voucher1 (ยอดที่จ่ายจริง แบบเดียวกับหน้ายอดขาย) นับเฉพาะบิลที่ยอด > 0
//   - ตัดโต๊ะ 600 และสาขาที่ไม่นับรวม (lib/excludedBranches.js) เหมือนหน้ายอดขาย
// ไม่ได้ดึงรายการ (/api/detail) มาตัดบิลยอดเหมา และไม่ได้รวมออเดอร์เพิ่มเติมจากชีท (โต๊ะ 800)
// ยอดจึงอาจต่างจากหน้ายอดขายเล็กน้อยในวันที่มีบิลพวกนั้น — แลกกับการโหลดเร็วกว่ามาก
//
// ⚠️ ไฟล์นี้ใช้จากหน้าเว็บ ห้าม import โมดูลของ Node
import { OPEN_DATE_BUFFER_DAYS, addDaysStr, dateFromRow, getChunks, normalizeArray, fetchChunkJson } from './salesFetch';
import { isIncludedBranch } from './excludedBranches';

/** โต๊ะที่หน้ายอดขายไม่นับ (ตัวเดียวกับ EXCLUDE_TABLES ใน pages/index.js) */
const EXCLUDE_TABLES = new Set([600]);

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * @param {object} p
 * @param {string} p.start 'YYYY-MM-DD'
 * @param {string} p.end   'YYYY-MM-DD'
 * @param {number|string} [p.outletId]  ว่าง = ทุกสาขา
 * @param {Object<string,string>} [p.codeOfOutlet] outletId -> รหัสสาขา (ไว้ตัดสาขาที่ไม่นับรวมตอนดูทุกสาขา)
 * @param {(text:string) => void} [p.onProgress]
 * @returns {Promise<{ byDate: Object<string, number>, total: number, bills: number }>}
 */
export async function fetchDailySales({ start, end, outletId = '', codeOfOutlet = {}, onProgress }) {
  const fetchEnd = addDaysStr(end, OPEN_DATE_BUFFER_DAYS);
  const chunks = getChunks(start, fetchEnd);
  const outletParam = outletId ? `&outlet=${encodeURIComponent(outletId)}` : '';

  let rows = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const chunkLabel = `${c.start} ถึง ${c.end}`;
    onProgress?.(`กำลังดึงยอดขาย ${i + 1}/${chunks.length} (${chunkLabel})`);
    const json = await fetchChunkJson(
      `/api/sales?start=${c.start}&end=${c.end}${outletParam}`,
      'ยอดขาย', chunkLabel,
      { onRetry: ({ attempt, total }) => onProgress?.(`ยอดขายช่วง ${chunkLabel} สะดุด — ลองใหม่ครั้งที่ ${attempt}/${total}`) },
    );
    rows = rows.concat(normalizeArray(json));
  }

  const byDate = {};
  let total = 0;
  let bills = 0;
  for (const r of rows) {
    const d = dateFromRow(r);
    if (d < start || d > end) continue;
    if (EXCLUDE_TABLES.has(parseInt(r.tableID ?? r.TableID, 10))) continue;
    const outlet = String(r.outletID ?? r.OutletID ?? '');
    if (outletId && outlet && outlet !== String(outletId)) continue;
    if (!outletId && !isIncludedBranch(codeOfOutlet[outlet])) continue;
    const amount = num(r.billTotal ?? r.BillTotal ?? r.amount) - num(r.voucher1 ?? r.Voucher1);
    if (!(amount > 0)) continue;
    byDate[d] = (byDate[d] || 0) + amount;
    total += amount;
    bills += 1;
  }
  return { byDate, total, bills };
}
