// กติกาตัดบิลออกจาก "ยอดขาย" ที่ใช้ร่วมกันระหว่างหน้ายอดขาย (pages/index.js)
// กับยอดขายรายวันในหน้ารายละเอียดค่าแรง (lib/laborSales.js)
// แก้ที่นี่ที่เดียว สองหน้าตัดบิลชุดเดียวกันเสมอ ยอดจึงตรงกัน
//
// ⚠️ ไฟล์นี้ใช้จากหน้าเว็บ ห้าม import โมดูลของ Node

/** โต๊ะที่ตัดออก (500 กลับไปนับต้นทุนจริงแล้ว) */
export const EXCLUDE_TABLES = [600];

/** ไอเทมยอดเหมา: บิลไหนมีไอเทมนี้ ให้ตัด "ทั้งบิล" ออกจากยอดขาย (กัน 1 บิลบวมยอด/จำนวนมหาศาล) */
export const LUMP_SUM_BILL_ITEMS = [290016];   // ข้าวกล่อง (คีย์ยอดเหมาเป็นจำนวนชิ้น)

export const isExcludedTable = (tid) => EXCLUDE_TABLES.indexOf(parseInt(tid, 10)) >= 0;

/**
 * ตัวเช็กว่าบิลเป็น "บิลยอดเหมา" ไหม — สร้างจากแถวรายการ (details) ของช่วงเดียวกัน
 * เก็บคีย์ทั้งจาก orderID และ checkID+outlet เพื่อจับให้ครบแม้ orderID ว่าง
 */
export function lumpSumBillChecker(details) {
  const keys = new Set();
  for (const r of details || []) {
    if (LUMP_SUM_BILL_ITEMS.indexOf(parseInt(r.itemCode, 10)) < 0) continue;
    const oid = String(r.orderID ?? r.OrderID ?? '').trim();
    if (oid) keys.add('O:' + oid);
    const chk = String(r.chkCheckID ?? r.checkID ?? '').trim();
    if (chk) keys.add('C:' + chk + '_' + (r.outletID ?? ''));
  }
  return (r) => {
    const oid = String(r.orderID ?? r.OrderID ?? '').trim();
    if (oid && keys.has('O:' + oid)) return true;
    const chk = String(r.checkID ?? r.CheckID ?? '').trim();
    return Boolean(chk) && keys.has('C:' + chk + '_' + (r.outletID ?? ''));
  };
}

/**
 * หัก voucher1 (ส่วนลด/วอเชอร์ที่บวกอยู่ใน billTotal แต่ไม่ใช่รายได้จริง) ออกจาก billTotal
 * → billTotal สุทธิ = ยอดที่จ่ายจริง · แก้แถวที่ส่งมาเลย (แบบเดียวกับที่หน้ายอดขายทำ)
 */
export function applyVoucher1(sales) {
  for (const r of sales || []) {
    const v1 = parseFloat(r.voucher1 ?? r.Voucher1 ?? 0) || 0;
    if (v1) {
      const bt = parseFloat(r.billTotal ?? r.BillTotal ?? r.amount ?? 0) || 0;
      r.billTotal = bt - v1;
    }
  }
  return sales;
}
