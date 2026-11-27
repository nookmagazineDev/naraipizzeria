// หมวดวัตถุดิบของ "ต้นทุนจากใบเบิก" แยกตามช่วงรหัสสินค้า
//
// ⚠️ ต้องตรงกับ CATS / CAT_OVERRIDES ใน Narai-branch src/components/ProfitSummary.jsx
//    (หน้าสรุปกำไร/ขาดทุนของแดชบอร์ดสาขา) — แก้ฝั่งหนึ่งต้องแก้อีกฝั่ง ไม่งั้นยอดต่อหมวดไม่ตรงกัน
//
// ใช้ได้ทั้งหน้าเว็บและฝั่ง API (ไม่มี import ของ Node)

export const FOOD_COST_CATS = [
  { key: 'central', label: 'ครัวกลาง', test: (c) => c >= 1000001 && c <= 5000102 },
  { key: 'food', label: 'สินค้าประเภทอาหาร', test: (c) => c >= 11000001 && c <= 11050061 },
  { key: 'veg', label: 'ผัก,ผลไม้', test: (c) => c >= 11090003 && c <= 11090999 },
  { key: 'drink', label: 'เครื่องดื่ม', test: (c) => c >= 11100001 && c <= 11130025 },
  { key: 'supply', label: 'วัสดุใช้ไป', test: (c) => c >= 11300001 && c <= 11600020 },
  { key: 'consume', label: 'วัสดุสิ้นเปลือง', test: (c) => (c >= 11800001 && c <= 11800217) || c >= 41000001 },
  { key: 'other', label: 'อื่นๆ', test: () => true }, // fallback — รหัสนอกหมวด
];

// รหัสที่อยู่นอกช่วงของหมวด แต่ต้องนับเข้าหมวดที่กำหนด (มาก่อนการเทียบช่วง)
const CAT_OVERRIDES = {
  5000103: 'central', // FC ชอคลาวา(BM)
  11050101: 'central', // ไก่ไร้กระดูกขิมชิว
  11050069: 'food', // น้ำปรุงซูชิซามูไร
};

/** รหัสสินค้า -> key ของหมวด */
export function foodCostCatOf(code) {
  const n = parseInt(String(code).replace(/\D/g, ''), 10) || 0;
  return CAT_OVERRIDES[n] || (FOOD_COST_CATS.find((c) => c.test(n)) || FOOD_COST_CATS[FOOD_COST_CATS.length - 1]).key;
}

/** { central: 0, food: 0, ... } */
export const emptyCatTotals = () => Object.fromEntries(FOOD_COST_CATS.map((c) => [c.key, 0]));

/**
 * Total Food Cost = ต้นทุนจากใบเบิก + รายจ่ายจาก Supplier + ยอดยกมาเดือนที่แล้ว − ยอดมูลค่าสตอคปัจจุบัน
 * (สูตรเดียวกับหน้าสรุปกำไรของสาขา)
 */
export const totalFoodCostOf = ({ withdraw = 0, sup = 0, prevStock = 0, curStock = 0 }) =>
  withdraw + sup + prevStock - curStock;
