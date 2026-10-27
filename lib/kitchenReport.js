// รายงานการผลิตของครัวกลาง — ฝั่งเซิร์ฟเวอร์ของเมนู QC/RD › รายงานการผลิต (อ่านอย่างเดียว)
//
// ข้อมูลชุดเดียวกับหน้า "รายงานการผลิต" ของ narai-storefct (src/pages/kitchen/ProductionReport.jsx)
// ทั้งสองฝั่งยิงไปที่ office-server ตัวเดียวกัน action เดียวกัน — ตรรกะ SQL อยู่ที่ office-server/kitchen.js
// ของ repo Narai-branch ที่นี่เป็นแค่ตัวส่งต่อ (ทางเดียวกับตารางงาน ดู lib/hrSchedule.js)
//
//   เบราว์เซอร์ -> /api/kitchen-report -> office-server :8787/schedule -> SQL Server
//
// ส่วน "ตามสูตร" (ผลผลิต/ต้นทุนต่อสูตร + BOM) มาจาก QC/RD ของที่นี่เอง แปลงเป็นรูปเดียวกับ
// lib/qcrdMenu.js ของ narai-storefct (qcrdMenuList / qcrdMenuRecipe) — ฝั่งนั้นแก้ ที่นี่ต้องแก้ตาม
// ฝั่งนั้นอ่านผ่าน host API /qcrd/* ที่ host-server ของที่นี่เปิดไว้ ซึ่งเรียก readMenus/readBom/readItems
// ตัวเดียวกับ fetchQcrdSql ข้างล่าง ตัวเลขจึงตรงกัน
import { callSchedule } from './hrSchedule';
import { fetchQcrdSql } from './qcrdSource';
import { str, num, normCode, DEFAULT_CONVERTER } from './qcrdSql.mjs';

/**
 * action ที่หน้านี้เรียกได้ — อ่านอย่างเดียวทั้งหมด (หน้าของ QC/RD ไม่ลบ/แก้บันทึกการผลิต)
 * /schedule ของ office-server รวม action ของทุกระบบไว้ที่เดียว ห้ามส่งต่อชื่ออะไรก็ได้ที่หน้าเว็บส่งมา
 */
export const KITCHEN_REPORT_ACTIONS = new Set(['getProductionReport', 'getMaterialIssues']);

/** เรียก action ของครัวกลาง — โยน error ที่มี status 400 เมื่อชื่อ action ไม่อยู่ในรายการ */
export async function callKitchenReport(action, payload = {}) {
  if (!KITCHEN_REPORT_ACTIONS.has(action)) {
    throw Object.assign(new Error(`ไม่รู้จักคำสั่ง "${action}"`), { status: 400 });
  }
  return callSchedule(action, payload, { what: 'ดึงข้อมูลครัวกลาง' });
}

/* ─────────── เมนู + สูตรของ QC/RD ในรูปที่หน้ารายงานใช้ ─────────── */

// BOM ทั้งชุดใหญ่ — โหลดครั้งเดียวแล้วแคชไว้ 5 นาที เหมือนฝั่ง narai-storefct
const TTL_MS = 5 * 60 * 1000;
const g = globalThis;
g.__kitchenQcrd = g.__kitchenQcrd || { at: 0, data: null, pending: null };

async function loadFresh() {
  const [menuRows, bomByMenu, itemRows] = await Promise.all(['menu', 'bom', 'item'].map((k) => fetchQcrdSql(k)));

  const items = new Map();
  for (const it of itemRows || []) {
    const key = normCode(it.key || it.code);
    if (!key || items.has(key)) continue;
    items.set(key, { name: str(it.name), unit: str(it.unit), converter: num(it.converter), useUnit: str(it.useUnit) });
  }

  const bom = new Map();
  for (const [code, entry] of Object.entries(bomByMenu || {})) {
    bom.set(str(code), (entry?.items || []).map((l) => ({
      seq: num(l.seq),
      itemCode: str(l.itemCode),
      itemName: str(l.itemName),
      qty: num(l.qty),
      converter: num(l.converter),
      tag: str(l.tag),
      noDeduct: l.noDeduct === true,
    })));
  }

  const menus = (menuRows || [])
    .filter((m) => str(m.code))
    .map((m) => ({
      code: str(m.code),
      key: normCode(m.code),
      name: str(m.name),
      groupName: str(m.groupName),
      status: str(m.status) || 'ใช้งาน',
      cost: num(m.cost),
      yieldQty: num(m.yieldQty),
      yieldUnit: str(m.yieldUnit),
      lineCount: bom.get(str(m.code))?.length || 0,
    }));

  return { menus, bom, items, loadedAt: new Date().toISOString() };
}

/** คำขอที่มาพร้อมกันรอรอบโหลดเดียวกัน ไม่ยิงฐานซ้อน */
async function load({ refresh = false } = {}) {
  const c = g.__kitchenQcrd;
  if (!refresh && c.data && Date.now() - c.at < TTL_MS) return c.data;
  if (!c.pending) {
    c.pending = loadFresh()
      .then((data) => { g.__kitchenQcrd = { at: Date.now(), data, pending: null }; return data; })
      .catch((err) => { c.pending = null; throw err; });
  }
  return c.pending;
}

/** รายชื่อเมนูทั้งหมด (ไม่มีบรรทัดสูตร) */
export async function kitchenMenuList(opts) {
  const { menus, loadedAt } = await load(opts);
  return { menus, loadedAt };
}

/** สูตรของเมนูหนึ่งตัว — qty เป็นหน่วยเล็กตาม QC/RD การแปลงเป็นหน่วยสต๊อกทำที่หน้าเว็บ */
export async function kitchenMenuRecipe(code) {
  const { menus, bom, items } = await load();
  const menu = menus.find((m) => m.code === str(code)) || menus.find((m) => m.key === normCode(code));
  if (!menu) return null;
  const lines = (bom.get(menu.code) || []).map((l) => {
    const itemKey = normCode(l.itemCode);
    const it = items.get(itemKey);
    return {
      ...l,
      itemKey,
      itemName: l.itemName || it?.name || '',
      converter: l.converter || it?.converter || DEFAULT_CONVERTER,
      useUnit: it?.useUnit || '',
      purchaseUnit: it?.unit || '',
    };
  });
  return { menu, lines };
}
