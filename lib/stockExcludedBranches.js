// สาขาที่ไม่นับรวมในหน้าเมนู STOCK ฝั่งออฟฟิศ (นับสต๊อก/ยอดรวม/ใช้ต่อหัว/ปิดรอบเดือน)
// ตัดแค่ที่หน้าเว็บ ทะเบียนสาขาไม่เปลี่ยน — สาขาที่ล็อกอินเองยังนับสต๊อกของตัวเองได้ตามปกติ
// จะตัด/คืนสาขาให้แก้ที่ชุดนี้ที่เดียว (ตัวพิมพ์เล็ก)
export const STOCK_EXCLUDED_BRANCHES = new Set(['clk']);

export const isStockBranch = (name) =>
  !STOCK_EXCLUDED_BRANCHES.has(String(name ?? '').trim().toLowerCase());
