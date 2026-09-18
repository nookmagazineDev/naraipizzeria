// อัปเดตตารางเมนูในเครื่องจากผลการบันทึก — ไม่ต้องโหลดข้อมูลใหม่ทั้งชุด
//
// ของเดิมพอบันทึกเสร็จจะโหลดใหม่ทั้ง 5 ชุด (เมนู 3,000 · สูตรทุกบรรทัดของ 1,167 เมนู ·
// ทะเบียนวัตถุดิบ · หมวดหมู่ · ดัชนีสูตร POS) เพื่อแก้เลขในตารางไม่กี่ช่อง แถมต่อ ?t= กัน
// CDN ทุกครั้งจึงเป็น cache MISS เสมอ — คนกดเห็น "บันทึกสำเร็จ" คู่กับตัวเลขเก่าอยู่หลายวินาที
// จนนึกว่าไม่เข้า
//
// แต่คำตอบจากการบันทึกบอกครบอยู่แล้วว่าอะไรเปลี่ยนไปเป็นอะไร (ต้นทุนใหม่ · จำนวนแถวสูตร ·
// เมนูที่ผูกสูตรกันซึ่งถูกคิดต้นทุนใหม่ตาม) เอามาแปะทับ state ตรง ๆ ได้เลย
//
// แยกออกมาเป็นฟังก์ชันบริสุทธิ์เพื่อให้ทดสอบได้โดยไม่ต้องมีเบราว์เซอร์
// (scripts/bench-qcrd-refresh.mjs วัดเวลาของมันเทียบกับการโหลดใหม่ทั้งชุด)

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * แปะผลการบันทึกลง state ของหน้าเมนู
 *
 * @param {{ menus: any[], bom: Record<string, any> }} state ของเดิม (ไม่ถูกแก้ — คืนชุดใหม่)
 * @param {object} saved
 *   code, name        รหัส/ชื่อเมนูที่เพิ่งบันทึก
 *   price, cost       ราคาขาย/ต้นทุนใหม่ (cost มาจาก totalCost ที่เซิร์ฟเวอร์คิดให้)
 *   group, groupName  รหัส/ชื่อหมวด (undefined = ไม่แตะของเดิม)
 *   rows              แถวสูตรชุดใหม่ในรูปแบบเดียวกับที่ /api/qcrd?sheet=bom คืนมา
 *   cascaded          [{ code, name, rows, cost }] เมนูที่ดึงสูตรนี้ไปใช้แล้วถูกคิดใหม่ตาม
 * @returns {{ menus: any[], bom: Record<string, any>, staleBom: string[] }}
 *   staleBom = รหัสเมนูที่จำนวนแถวถูกต้องแล้ว แต่รายละเอียดบรรทัดยังเป็นของเก่า
 *              (เมนู cascaded — เซิร์ฟเวอร์บอกจำนวนกับต้นทุนมา ไม่ได้ส่งบรรทัดมาด้วย)
 */
export function patchSavedMenu(state, saved) {
  const code = str(saved.code);
  if (!code) return { ...state, staleBom: [] };

  const rows = Array.isArray(saved.rows) ? saved.rows : [];
  const cascaded = Array.isArray(saved.cascaded) ? saved.cascaded : [];
  const costOf = new Map(cascaded.map(c => [str(c.code), c]));

  const patchOne = (m) => {
    if (str(m.code) === code) {
      const next = { ...m, name: saved.name ?? m.name, cost: saved.cost ?? m.cost };
      if (saved.price !== undefined) next.price = saved.price;
      if (saved.group !== undefined) next.group = saved.group;
      if (saved.groupName !== undefined) next.groupName = saved.groupName;
      return next;
    }
    const hit = costOf.get(str(m.code));
    // cost ของเมนู cascaded เป็น null ได้ (สูตรว่าง) จึงเช็ก undefined ไม่ใช่ความจริงเท็จ
    return hit && hit.cost !== undefined ? { ...m, cost: hit.cost } : m;
  };

  let menus = state.menus.map(patchOne);
  // เมนูใหม่ยังไม่มีในตาราง — ต่อท้ายให้ตรงกับ sort_order ที่ฝั่ง SQL ตั้งเป็น MAX+1
  if (!menus.some(m => str(m.code) === code)) {
    menus = [...menus, {
      code, name: saved.name || code,
      group: saved.group || '', groupName: saved.groupName || '',
      price: saved.price ?? null, cost: saved.cost ?? null,
      status: 'ใช้งาน', yieldQty: saved.yieldQty ?? null, yieldUnit: saved.yieldUnit || '',
    }];
  }

  const bom = { ...state.bom };
  if (rows.length) bom[code] = { name: saved.name || code, items: rows };
  else delete bom[code];   // ถอดวัตถุดิบออกหมด = เมนูนั้นไม่มีสูตรแล้ว

  // เมนู cascaded: แก้จำนวนแถวให้ถูกไว้ก่อน (ตารางโชว์แค่จำนวน) รายละเอียดบรรทัดค่อยตามมา
  const staleBom = [];
  cascaded.forEach(c => {
    const cCode = str(c.code);
    if (!cCode || cCode === code) return;
    staleBom.push(cCode);
    const prev = bom[cCode];
    const n = Number(c.rows) || 0;
    if (!n) { delete bom[cCode]; return; }
    // ไม่กุบรรทัดปลอมขึ้นมาให้ครบจำนวน — เก็บบรรทัดเดิมไว้แล้วบอกจำนวนจริงผ่าน count
    // ป้าย "n รายการ" จึงถูกทันที ส่วนหน้าดูสูตรยังเห็นของเดิมจนกว่าบรรทัดชุดใหม่จะโหลดมาทับ
    bom[cCode] = { ...prev, name: c.name || prev?.name || cCode, items: prev?.items || [], count: n, stale: true };
  });

  return { menus, bom, staleBom };
}

/** แถวสูตรจากฟอร์ม -> รูปแบบเดียวกับที่ /api/qcrd?sheet=bom คืนมา (สูตรต้นทุนเดียวกับฝั่ง SQL) */
export function bomRowsFromForm(rows, priceMap = {}, defaultConverter = 1000) {
  return rows.map((r, i) => {
    const price = priceMap[r.itemCode] ?? null;
    const conv = Number(r.converter) || defaultConverter;
    const qty = Number(r.qty) || 0;
    const unitCost = price && conv ? price / conv : null;
    return {
      seq: String(i + 1),
      itemCode: r.itemCode, itemName: r.itemName || '',
      qty, converter: conv,
      itemPrice: price, unitCost,
      lineCost: unitCost === null ? null : qty * unitCost,
      srcCode: r.srcCode || '', srcName: r.srcName || '',
      srcFactor: r.srcFactor === '' || r.srcFactor === undefined ? null : Number(r.srcFactor),
      srcBase: r.srcBase === '' || r.srcBase === undefined ? null : Number(r.srcBase),
      tag: r.tag || '', noDeduct: Boolean(r.noDeduct),
    };
  });
}
