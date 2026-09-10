// กติกา "ยอดใช้จากระบบ" ของหน้านับสต๊อก — ที่เดียวที่เก็บกฎ ใช้ร่วมกันทั้ง
// /api/usage-bom (ยอดใช้รวม + แยกเมนู) และ /api/usagebytable (แยกโต๊ะ)
//
// ที่มา: พอร์ตมาจาก office-server/server.js ของโปรเจกต์ Narai-branch (หน้านับสต๊อกของสาขา)
// เพื่อให้ตัวเลข "ยอดใช้จากระบบ" ของสองระบบตรงกัน — ก่อนหน้านี้ฝั่งนี้ขาดกฎกันนับซ้ำ
// สองข้อ (เมนูชั่ง กก. กับเมนูจาน) ยอดใช้ของเนื้อบางตัวจึงสูงกว่าความจริงเท่าตัว
//
// ทุกกฎปรับผ่าน env ได้ ไม่ต้องแก้โค้ด (ตั้งบน Vercel แล้ว redeploy)
//
// ⚠️ ทั้งสอง API ต้องกรองแถวขายด้วยกฎ "ชุดเดียวกัน" เสมอ ถ้ากรองต่างกันแม้แต่ข้อเดียว
//    ผลรวมรายโต๊ะจะไม่เท่ากับยอด "ขาย" ของเมนูนั้นอีก (เคยเจอเมนู P20 ต่างกันเท่าตัว)

/** ตัด .0 ท้าย + 0 นำหน้า ให้รหัสจากชีท/POS/SQL จับคู่กันได้ */
export const normalizeId = id =>
  String(id ?? '').replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

const listFromEnv = (value, fallback) =>
  String(value || fallback).split(',').map(s => s.trim()).filter(Boolean);

/** โต๊ะที่ไม่นับเป็นยอดขาย (โต๊ะ 600 = โต๊ะเตรียมของ/ทดสอบ) */
export const EXCLUDE_TABLES = listFromEnv(process.env.USAGE_EXCLUDE_TABLES, '600').map(Number);

/**
 * รหัสไอเทมฝั่งขายที่ "ไม่ต้องคิดยอดใช้"
 * ค่าเริ่มต้น 500017 (S17 เตรียมแป้งพิซซ่า S) · 500018 (S18 เตรียมแป้งพิซซ่า M)
 * เป็นรายการเตรียมของภายใน ไม่ใช่เมนูที่ขายจริง ถ้านับรวมจะบวกยอดใช้แป้งซ้ำกับพิซซ่าที่ขายจริง
 * (ตรงกับ EXCLUDE_ITEMCODES ของ Narai-branch — เดิมฝั่งนี้ตัดกว้างกว่าคือ 206001, 290016
 *  และช่วง 500002-500026 ทั้งช่วง ทำให้ยอดใช้ต่ำกว่าหน้านับสต๊อกของสาขา)
 */
export const EXCLUDE_ITEMCODES = new Set(
  listFromEnv(process.env.USAGE_EXCLUDE_ITEMCODES, '500017,500018').map(normalizeId)
);

/**
 * วัตถุดิบที่ "ห้ามนับจากเมนูหน่วยจาน (ที่)" — นับเฉพาะเมนูชั่งเป็น (กก)
 * ค่าเริ่มต้น 11010081 (สันคอหมู): เมนูบุฟเฟ่ต์ชั่ง กก. นับ · เมนูสไลด์รายจานไม่นับ
 * เพราะเป็นเนื้อก้อนเดียวกัน ถ้านับทั้งคู่ = ตัดสต๊อกสองรอบ
 */
export const EXCLUDE_PLATE_MENU_INGREDIENTS = new Set(
  listFromEnv(process.env.USAGE_EXCLUDE_PLATE_MENU_INGREDIENTS, '11010081').map(normalizeId)
);

/** รหัสเมนูขายที่เข้ากฎด้านบน (ชื่อเมนูใน BOM ไม่มีคำว่า "(ที่)" แล้ว จึงต้องระบุรหัสตรง ๆ)
 *  ค่าเริ่มต้น 102001 (สันคอหมูสไลด์) · 180007 (สันคอหมูอนามัยสไลซ์) */
export const EXCLUDE_PLATE_MENU_CODES = new Set(
  listFromEnv(process.env.USAGE_EXCLUDE_PLATE_MENU_CODES, '102001,180007').map(normalizeId)
);

/** เมนูที่ขายแบบชั่งน้ำหนัก — ชื่อมี "(กก" เช่น "สันคอหมู (กก.)" */
export const isKgMenu = name => /\(\s*กก/.test(String(name || ''));

/** เมนูหน่วยจาน — ชื่อมี "(ที่)" */
export const isPlateMenu = name => /\(\s*ที่\s*\)/.test(String(name || ''));

/** แถวขายนี้เอามาคิดยอดใช้ไหม (void · โต๊ะที่ตัด · ไอเทมที่ตั้งว่าไม่คิด) */
export const countableSaleRow = row => {
  if (!row || row.void) return false;
  if (EXCLUDE_TABLES.includes(parseInt(row.tableID))) return false;
  if (EXCLUDE_ITEMCODES.has(normalizeId(row.itemCode))) return false;
  return true;
};

/**
 * วันที่ที่ยอดใช้ของแถวขายไปตกอยู่ — ใช้ PostTime (เวลาที่ POS โพสต์รายการ) เป็นหลัก
 * ให้ตรงกับฝั่ง Narai-branch ที่ดึงข้อมูลทีละวันจาก ctranbetweendate ซึ่ง host กรองด้วย PostTime
 * (เดิมฝั่งนี้ใช้ prtOrdTime/startTime ยอดรวมทั้งช่วงเท่ากัน แต่วันหัว-ท้ายช่วงแบ่งไม่ตรงกัน)
 */
export const usageDateKey = row =>
  String(row?.postTime || row?.prtOrdTime || row?.startTime || '').slice(0, 10);

/**
 * วัตถุดิบตัวไหนที่ "มีเมนูชั่ง กก. ขายในช่วงนี้" → ให้นับจากเมนู (กก) อย่างเดียว
 * ยอดขายของเมนู (กก) คือน้ำหนักที่ชั่งจริงจาก POS (สูตร BOM ตั้ง F = H ยอดใช้จึงเท่ากับยอดขายตรง ๆ)
 * ถ้ายังไปนับเมนูจานที่ใช้เนื้อตัวเดียวกันอีก = นับซ้ำ
 *
 * @param soldMenus  [{ key, name, qty }] เมนูที่ขายได้ในช่วงนี้ (key = รหัสเมนู normalize แล้ว)
 * @param bom        { รหัสเมนู: { รหัสวัตถุดิบ: ยอดใช้ต่อ 1 หน่วยขาย } }
 */
export function kgOnlyIngredients(soldMenus, bom) {
  const set = new Set();
  soldMenus.forEach(({ key, name, qty }) => {
    if (!qty) return;
    const recipe = bom[key];
    if (!recipe || !isKgMenu(name)) return;
    Object.keys(recipe).forEach(ing => set.add(ing));
  });
  return set;
}

/**
 * เมนูนี้นับยอดใช้ของวัตถุดิบตัวนี้ไหม (กฎกันนับซ้ำสองข้อ)
 * @returns 'kg' | 'plate' | null   (null = นับปกติ, ค่าอื่น = ข้ามเพราะกฎข้อนั้น)
 */
export function skipReason({ ing, menuKey, menuName, kgOnlyIngs }) {
  if (kgOnlyIngs.has(ing) && !isKgMenu(menuName)) return 'kg';
  if (EXCLUDE_PLATE_MENU_INGREDIENTS.has(ing) &&
      (isPlateMenu(menuName) || EXCLUDE_PLATE_MENU_CODES.has(normalizeId(menuKey)))) return 'plate';
  return null;
}
