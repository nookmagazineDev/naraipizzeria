// ยอดขายรายวันของสาขา — ใช้คู่กับค่าแรงในหน้ารายละเอียดค่าแรง (หน้า "ดูสแกนหน้า")
//
// ทำตามขั้นเดียวกับหน้ายอดขาย (pages/index.js ตอนกดค้นหา) ทุกขั้น ยอดจึงตรงกับหน้ายอดขาย:
//   1. ดึงบิล (/api/sales) แล้วตามด้วยรายการ (/api/detail) ทีละก้อน 5 วัน เผื่อท้ายช่วงไว้
//      สำหรับบิลที่เปิดในช่วงแต่ปิดข้ามวัน (ยิงทีละคำขอ ไม่ยิงพร้อมกัน — เหตุผลอยู่ใน pages/index.js)
//   2. รวมออเดอร์เพิ่มเติมจาก Google Sheet (/api/extra-orders · โต๊ะ 800)
//   3. ตัดสาขาที่ไม่นับรวม (lib/excludedBranches.js) · เหลือเฉพาะบิลที่ "วันเปิดบิล" อยู่ในช่วง
//   4. หัก voucher1 · ตัดโต๊ะ 600 · ตัดบิลที่มีไอเทมยอดเหมา (lib/salesRules.js — ชุดเดียวกับหน้ายอดขาย)
//   5. ยอดขาย = ผลรวม billTotal (ตัวเดียวกับ "ยอดขายรวม VAT" ในหน้ายอดขาย)
//      ก่อน VAT = billTotal − vat (ตัวเดียวกับ "ยอดขายรวมทั้งหมด" ในแดชบอร์ด)
//
// ต้องดึงรายการด้วยเพราะบิลยอดเหมาดูได้จากรายการในบิลเท่านั้น — ช้ากว่าดึงบิลอย่างเดียว
// แต่ถ้าข้าม วันที่มีบิลข้าวกล่องยอดขายจะสูงกว่าหน้ายอดขาย
//
// ⚠️ ไฟล์นี้ใช้จากหน้าเว็บ ห้าม import โมดูลของ Node
import { OPEN_DATE_BUFFER_DAYS, addDaysStr, dateFromRow, getChunks, normalizeArray, fetchChunkJson } from './salesFetch';
import { isIncludedBranch } from './excludedBranches';
import { isExcludedTable, lumpSumBillChecker, applyVoucher1 } from './salesRules';

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * @param {object} p
 * @param {string} p.start 'YYYY-MM-DD'
 * @param {string} p.end   'YYYY-MM-DD'
 * @param {number|string} [p.outletId]  ว่าง = ทุกสาขา
 * @param {Object<string,string>} [p.codeOfOutlet] outletId -> รหัสสาขา (ไว้ตัดสาขาที่ไม่นับรวม)
 * @param {(text:string) => void} [p.onProgress]
 * @returns {Promise<{ byDate: Object<string, number>, beforeVatByDate: Object<string, number>,
 *                     beforeVatByOutlet: Object<string, number>,
 *                     total: number, beforeVat: number, bills: number }>}
 */
export async function fetchDailySales({ start, end, outletId = '', codeOfOutlet = {}, onProgress }) {
  const chunks = getChunks(start, addDaysStr(end, OPEN_DATE_BUFFER_DAYS), 5);
  const outletParam = outletId ? `&outlet=${encodeURIComponent(outletId)}` : '';

  // ออเดอร์เพิ่มเติมจากชีท — คำขอเดียว ดึงคู่ขนานไปกับบิลได้ (ไม่ได้วิ่งไปที่ฐานของร้าน)
  const extraPromise = fetch('/api/extra-orders')
    .then((r) => (r.ok ? r.json() : { sales: [], details: [] }))
    .catch(() => ({ sales: [], details: [] }));

  let sales = [];
  let details = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const chunkLabel = `${c.start} ถึง ${c.end}`;
    const onRetry = ({ attempt, total }) =>
      onProgress?.(`ช่วง ${chunkLabel} ตอบไม่ทัน กำลังลองใหม่ (ครั้งที่ ${attempt}/${total})`);
    onProgress?.(`กำลังดึงบิล ${i + 1}/${chunks.length} (${chunkLabel})`);
    const s = await fetchChunkJson(`/api/sales?start=${c.start}&end=${c.end}${outletParam}`, 'ยอดขาย', chunkLabel, { onRetry });
    onProgress?.(`กำลังดึงรายการในบิล ${i + 1}/${chunks.length} (${chunkLabel})`);
    const d = await fetchChunkJson(`/api/detail?start=${c.start}&end=${c.end}${outletParam}`, 'รายการในบิล', chunkLabel, { onRetry });
    sales = sales.concat(normalizeArray(s));
    details = details.concat(normalizeArray(d));
  }

  const extra = await extraPromise;
  const sameOutlet = (r) => String(r.outletID) === String(outletId);
  sales = sales.concat(outletId ? (extra.sales || []).filter(sameOutlet) : (extra.sales || []));
  details = details.concat(outletId ? (extra.details || []).filter(sameOutlet) : (extra.details || []));

  const keepOutlet = (r) => isIncludedBranch(codeOfOutlet[String(r.outletID ?? r.OutletID ?? '')]);
  const inOpenRange = (r) => {
    const d = dateFromRow(r);
    return d >= start && d <= end;
  };
  sales = sales.filter((r) => keepOutlet(r) && inOpenRange(r));
  details = details.filter((r) => keepOutlet(r) && inOpenRange(r));

  applyVoucher1(sales);
  const isLumpSumBill = lumpSumBillChecker(details);
  const clean = sales.filter((r) => !isExcludedTable(r.tableID ?? r.TableID) && !isLumpSumBill(r));

  const byDate = {};
  const beforeVatByDate = {};
  const beforeVatByOutlet = {};
  let total = 0;
  let beforeVat = 0;
  for (const r of clean) {
    // หน้ายอดขายเลือกสาขาด้วยการกรอง outletID ของแถว — ทำแบบเดียวกัน
    if (outletId && !sameOutlet(r)) continue;
    const d = dateFromRow(r);
    const bill = num(r.billTotal);
    const net = bill - num(r.vat ?? r.Vat);
    byDate[d] = (byDate[d] || 0) + bill;
    beforeVatByDate[d] = (beforeVatByDate[d] || 0) + net;
    const oid = String(r.outletID ?? r.OutletID ?? '');
    beforeVatByOutlet[oid] = (beforeVatByOutlet[oid] || 0) + net;
    total += bill;
    beforeVat += net;
  }
  const bills = outletId ? clean.filter(sameOutlet).length : clean.length;
  return { byDate, beforeVatByDate, beforeVatByOutlet, total, beforeVat, bills };
}
