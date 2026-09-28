// งาน "เขียน" ของ QC/RD ทั้งหมดผ่าน /api/qcrd-save
// ปลายทางจริงเป็น SQL Server (InventoryNarai) หรือ Google Apps Script ตาม env QCRD_SOURCE
// — ฝั่งหน้าเว็บเรียกเหมือนกันทั้งสองแบบ ไม่ต้องรู้ว่าข้อมูลอยู่ที่ไหน
export const apiCall = async (action, payload = {}) => {
  const res = await fetch('/api/qcrd-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const result = await res.json();
  if (result.status === 'success') return result;
  throw new Error(result.message || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
};

// ── เติมหน่วยใช้ (+ ตัวแปลงที่ยังว่าง) ให้วัตถุดิบ — ใช้ร่วมกันทุกที่ ──
//
// ทางหลักคือ action updateItemUseUnits ก้อนเดียว (เขียนเฉพาะช่องที่ยังว่าง ดู lib/qcrdSql.mjs)
// แต่ action นี้เพิ่งมี — ตอน Vercel ต่อ SQL ตรงไม่ติดแล้วถอยไป host-server ที่เครื่องออฟฟิศ
// ถ้าเครื่องนั้นยังไม่ได้ git pull จะตอบ "unknown action: updateItemUseUnits" (เจอจริง ก.ย. 2026)
// จึงถอยต่อไป saveItem ทีละตัว ซึ่งมีมาตั้งแต่รุ่นแรก ๆ และเขียนเฉพาะช่องที่ส่งไป
//
// ⚠️ saveItem ไม่เช็กว่าช่องยังว่าง (เขียนทับเสมอ) — ผู้เรียกต้องส่งมาเฉพาะตัวที่หน่วยใช้ในทะเบียน
//    ยังว่าง และใส่ converter เฉพาะตัวที่ตัวแปลงยังว่าง (ทุกจุดที่เรียกทำแบบนั้นอยู่แล้ว)
let useUnitsBatchMissing = false;   // จำไว้ทั้งหน้า — รอบถัดไปไม่ต้องลองก้อนเดียวแล้วรอ error ซ้ำ
const USE_UNIT_FALLBACK_CONCURRENCY = 4;

/** ข้อความต่อท้ายตอนต้องถอยไปบันทึกทีละรายการ */
export const HOST_OUTDATED_NOTE = 'host-server ที่เครื่องออฟฟิศยังเป็นรุ่นเก่า จึงบันทึกทีละรายการแทน (ช้ากว่าปกติ)'
  + ' — แก้ถาวร: ที่เครื่องออฟฟิศ git pull แล้ว host-server\\start-narai.ps1 -Restart -NoTunnel';

export const isUnknownAction = (err, action) =>
  new RegExp(`unknown action:?\\s*${action}\\b`, 'i').test(String(err?.message || ''));

/**
 * @param {Array<{code, useUnit, converter?}>} units
 * @param {{ onProgress?: (done: number, total: number) => void }} opts
 * @returns {Promise<{ data: { updated, converters }, fallback: boolean, saved: string[],
 *                     failed: Array<{code, msg}>, sync?: object }>}
 *   saved = รหัสที่เขียนสำเร็จ (ทางก้อนเดียว = ทุกตัวที่ส่งไป — ฝั่งฐานข้ามตัวที่มีค่าอยู่แล้วเอง)
 *   error อื่นที่ไม่ใช่ "ไม่รู้จัก action" โยนต่อตามปกติ
 */
export async function fillUseUnits(units, { onProgress } = {}) {
  const list = (units || []).filter(u => u && u.code && String(u.useUnit || '').trim());
  if (!list.length) return { data: { updated: 0, converters: 0 }, fallback: false, saved: [], failed: [] };

  if (!useUnitsBatchMissing) {
    try {
      const res = await apiCall('updateItemUseUnits', { units: list });
      onProgress?.(list.length, list.length);
      return { ...res, fallback: false, saved: list.map(u => u.code), failed: [] };
    } catch (err) {
      if (!isUnknownAction(err, 'updateItemUseUnits')) throw err;
      useUnitsBatchMissing = true;
    }
  }

  let next = 0;
  let done = 0;
  let converters = 0;
  let sync;
  const saved = [];
  const failed = [];
  const worker = async () => {
    while (next < list.length) {
      const u = list[next++];
      const payload = { code: u.code, useUnit: String(u.useUnit).trim() };
      if (Number(u.converter) > 0) payload.converter = Number(u.converter);
      try {
        const res = await apiCall('saveItem', payload);
        saved.push(u.code);
        if (payload.converter) converters++;
        if (res?.sync && !res.sync.ok) sync = res.sync;
      } catch (err) {
        failed.push({ code: u.code, msg: err.message || 'บันทึกไม่สำเร็จ' });
      }
      onProgress?.(++done, list.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(USE_UNIT_FALLBACK_CONCURRENCY, list.length) }, worker));
  return { status: 'success', data: { updated: saved.length, converters }, fallback: true, saved, failed, sync };
}

// ── ดันชีทขึ้น SQL (ให้หน้า "นับสต๊อก" ของ Narai-branch เห็นของที่แก้จากหน้านี้) ──
//
// /api/qcrd-save ดันให้อัตโนมัติหลังบันทึกลงชีทสำเร็จอยู่แล้ว แล้วแนบผลกลับมาในฟิลด์ sync
// syncNote() เอาไว้ต่อท้ายข้อความ toast ให้ผู้ใช้รู้ทันทีว่าขึ้นฐานแล้วหรือยัง
// ถ้ายังไม่ขึ้น กด syncSql() ซ้ำได้ (ดันแบบ MERGE ทำซ้ำกี่รอบก็ได้ ไม่ทำข้อมูลซ้ำ)

/** '' ถ้าขึ้น SQL แล้ว (หรือไม่มีการดันในรอบนั้น) · ข้อความเตือนถ้ายังไม่ขึ้น */
export const syncNote = (res) => {
  const sync = res && res.sync;
  if (!sync || sync.ok) return '';
  return ` · ⚠ ยังไม่ขึ้น SQL (หน้านับสต๊อกจะยังไม่เห็น): ${sync.message || 'ดันขึ้นฐานไม่สำเร็จ'}`;
};

/** ผลรวมว่าบันทึกรอบนั้น "ครบทั้งชีทและ SQL" ไหม — ใช้เลือกสีของ toast */
export const syncOk = (res) => !(res && res.sync) || res.sync.ok === true;

/** ดันขึ้น SQL เอง — steps: 'item' | 'menu' | 'bom' | 'group' | 'all' (คั่นด้วย , ได้) */
export const syncSql = async (steps = 'item', { verify = false } = {}) => {
  const r = await fetch('/api/qcrd-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps, verify: verify ? 1 : 0 }),
  });
  return r.json();
};
