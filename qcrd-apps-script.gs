/**
 * Narai — Apps Script สำหรับเมนู QC/RD (ชีทต้นทุนเมนู 1v8WRT…)
 * วิธีใช้:
 *   1) เปิดชีท https://docs.google.com/spreadsheets/d/1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw
 *   2) Extensions > Apps Script → วางโค้ดนี้ทั้งหมด → Save
 *   3) Deploy > New deployment > Web app (Execute as: Me / Who has access: Anyone) → คัดลอก URL /exec
 *   4) ใส่ env QCRD_GAS_URL บน Vercel แล้ว Redeploy (หรือใส่ fallback ใน pages/api/qcrd-gas.js)
 *
 * แท็บที่ใช้:
 *   menu : A=Code B=NameThai C=MenuCode D=UnitPrice E=cost Menu F=สถานะ(ใช้งาน/ปิดการใช้งาน)
 *          G=ปริมาณที่ได้ H=หน่วยที่ได้ (คอลัมน์เสริม สคริปต์เติมหัวตารางให้เองครั้งแรกที่บันทึก)
 *   BOM  : A=เลขPOS B=ชื่อเมนู C=ลำดับ D=รหัสวัตถุดิบ E=ชื่อวัตถุดิบ F=ยอดใช้ G=1 H=ตัวแปลงหน่วย
 *          I=รหัสวัตถุดิบ(ตัด 0 นำหน้า) J=ราคาวัตถุดิบ K=ต้นทุน/หน่วยเล็ก L=(ว่าง) M=ต้นทุน/หน่วยเล็ก N=ต้นทุนรวมของแถว
 *          O=รหัสเมนูต้นทาง P=ชื่อเมนูต้นทาง Q=สัดส่วนที่ดึงมา R=ยอดใช้ตามสูตรเดิม
 *          (O–R เป็นบันทึกที่มาของวัตถุดิบเฉย ๆ ไม่เกี่ยวกับการคำนวณต้นทุน A–N)
 *   item : A=รหัส B=ชื่อ C=ราคา D=หน่วย E=สถานะ(ใช้งาน/ปิดการใช้งาน) F,G,H=รหัสไอเทมทดแทน 1-3
 *          I=ตัวแปลงหน่วย(หน่วยเล็กต่อ 1 หน่วยซื้อ) J=สาขาที่ใช้(คั่นด้วย ,)
 *   menucodegroup : A=รหัสหมวด(MenuCode) B=ชื่อหมวด
 */

var SHEET_ID = '1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw';

function doGet(e) {
  return ContentService.createTextOutput('Narai QC/RD Backend is running.');
}

function doPost(e) {
  var res = { status: 'error', message: '' };
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action;
    var ss = SpreadsheetApp.openById(SHEET_ID);

    if (action === 'saveMenu') {
      res = saveMenu_(ss, data);
    } else if (action === 'updateItemUnits') {
      res = updateItemUnits_(ss, data);
    } else if (action === 'saveItem') {
      res = saveItem_(ss, data);
    } else if (action === 'addItem') {
      res = addItem_(ss, data);
    } else if (action === 'deleteItem') {
      res = deleteItem_(ss, data);
    } else if (action === 'saveMenuStatus') {
      res = saveMenuStatus_(ss, data);
    } else if (action === 'saveMenuGroup') {
      res = saveMenuGroup_(ss, data);
    } else if (action === 'sortBom') {
      res = sortBom_(ss);
    } else {
      res.message = 'unknown action: ' + action;
    }
  } catch (err) {
    res.message = err.message;
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

// เพิ่ม/แก้ไขเมนู: upsert แถวในชีท menu + แทนที่สูตรทั้งหมดของเมนูนั้นในชีท BOM
// payload: { code, name, price, group, newGroupName, yieldQty, yieldUnit, items: [{ itemCode, itemName, qty, converter }] }
//   group        = รหัสหมวด (คอลัมน์ C) — ส่ง '' เพื่อล้างหมวด, ไม่ส่งเลย = คงหมวดเดิม
//   newGroupName = ชื่อหมวดใหม่ ถ้าส่งมาจะสร้าง/หาในชีท menucodegroup แล้วใช้รหัสนั้นแทน group
//   yieldQty/yieldUnit = ปริมาณที่ได้ต่อ 1 สูตร + หน่วย (เช่น 10 ชิ้น) — ไม่ส่ง = คงค่าเดิม
function saveMenu_(ss, data) {
  var code = String(data.code || '').trim();
  var name = String(data.name || '').trim();
  var price = Number(data.price) || '';
  var items = data.items || [];
  if (!code || !name) return { status: 'error', message: 'ต้องระบุรหัสและชื่อเมนู' };

  // หมวดหมู่: null = ไม่แตะคอลัมน์ C ของแถวเดิม
  var groupCode = null;
  if (String(data.newGroupName || '').trim()) {
    groupCode = upsertMenuGroup_(ss, '', data.newGroupName).code;
  } else if (data.group !== undefined) {
    groupCode = String(data.group || '').trim();
  }

  // ราคาวัตถุดิบจากชีท item (ใช้คำนวณต้นทุน)
  var itemSh = ss.getSheetByName('item');
  var priceMap = {};
  if (itemSh) {
    var iv = itemSh.getDataRange().getValues();
    for (var i = 1; i < iv.length; i++) {
      var c = String(iv[i][0] || '').trim();
      if (c) priceMap[c] = Number(iv[i][2]) || 0;
    }
  }

  // คำนวณ BOM แต่ละแถว + ต้นทุนรวมเมนู
  var totalCost = 0;
  var bomRows = items.map(function (it, idx) {
    var itemCode = String(it.itemCode || '').trim();
    var qty = Number(it.qty) || 0;
    var conv = Number(it.converter) || 1000;
    var p = priceMap[itemCode] || 0;
    var unitCost = conv ? p / conv : 0;
    var lineCost = qty * unitCost;
    totalCost += lineCost;
    // O–R = บันทึกที่มา (ดึงมาจากสูตรของเมนูไหน สัดส่วนเท่าไร ยอดเดิมเท่าไร) ไม่ใช้คำนวณต้นทุน
    return [code, name, idx + 1, itemCode, String(it.itemName || '').trim(),
            qty, 1, conv, itemCode.replace(/^0+/, ''), p || '',
            p ? unitCost : '', '', p ? unitCost : '', p ? lineCost : '',
            String(it.srcCode || '').trim(), String(it.srcName || '').trim(),
            it.srcFactor === undefined || it.srcFactor === '' ? '' : Number(it.srcFactor),
            it.srcBase === undefined || it.srcBase === '' ? '' : Number(it.srcBase)];
  });

  // upsert ชีท menu (คอลัมน์ E = ต้นทุนรวมจากสูตร)
  var menuSh = ss.getSheetByName('menu');
  var mv = menuSh.getRange(1, 1, menuSh.getLastRow(), 1).getValues();
  var found = -1;
  for (var r = 1; r < mv.length; r++) {
    if (String(mv[r][0] || '').trim() === code) { found = r + 1; break; }
  }
  var costCell = bomRows.length ? Math.round(totalCost * 10000) / 10000 : '';
  if (found > 0) {
    menuSh.getRange(found, 2).setValue(name);
    if (groupCode !== null) menuSh.getRange(found, 3).setValue(groupCode);
    if (data.price !== undefined && data.price !== '') menuSh.getRange(found, 4).setValue(price);
    if (bomRows.length) menuSh.getRange(found, 5).setValue(costCell);
  } else {
    menuSh.appendRow([code, name, groupCode || '', price, costCell]);
    found = menuSh.getLastRow();
  }
  // ปริมาณที่ได้ต่อ 1 สูตร (คอลัมน์เสริม) — เขียนเฉพาะที่ส่งมา, ส่ง '' = ล้างค่า
  if (data.yieldQty !== undefined || data.yieldUnit !== undefined) {
    var yc = yieldCols_(menuSh);
    if (data.yieldQty !== undefined) {
      var yq = String(data.yieldQty).trim();
      menuSh.getRange(found, yc.qty).setValue(yq === '' || isNaN(Number(yq)) ? '' : Number(yq));
    }
    if (data.yieldUnit !== undefined) {
      menuSh.getRange(found, yc.unit).setValue(String(data.yieldUnit || '').trim());
    }
  }

  // แทนที่แถว BOM เดิมของเมนูนี้ (ลบจากล่างขึ้นบน แล้วต่อท้ายใหม่)
  var bomSh = ss.getSheetByName('BOM');
  var bv = bomSh.getRange(1, 1, bomSh.getLastRow(), 1).getValues();
  for (var j = bv.length - 1; j >= 1; j--) {
    if (String(bv[j][0] || '').trim() === code) bomSh.deleteRow(j + 1);
  }
  if (bomRows.length) {
    ensureBomSrcHeader_(bomSh);
    bomSh.getRange(bomSh.getLastRow() + 1, 1, bomRows.length, bomRows[0].length).setValues(bomRows);
    sortBom_(ss); // จัดเรียงชีท BOM ใหม่ทุกครั้ง สูตรของเมนูเดียวกันจะอยู่ติดกันเสมอ
  }

  return { status: 'success', data: { code: code, bomRows: bomRows.length, totalCost: costCell, group: groupCode } };
}

// เติมหัวตารางคอลัมน์บันทึกที่มาในชีท BOM (O–R) ให้เองถ้ายังว่าง — เขียนเฉพาะช่องที่ว่างจริง
function ensureBomSrcHeader_(bomSh) {
  var labels = ['รหัสเมนูต้นทาง', 'ชื่อเมนูต้นทาง', 'สัดส่วนที่ดึงมา', 'ยอดใช้ตามสูตรเดิม'];
  var header = bomSh.getRange(1, 15, 1, 4).getValues()[0];
  for (var i = 0; i < labels.length; i++) {
    if (!String(header[i] || '').trim()) bomSh.getRange(1, 15 + i).setValue(labels[i]);
  }
}

// หาคอลัมน์ "ปริมาณที่ได้ / หน่วยที่ได้" ในชีท menu (1-indexed)
// ดูจากหัวตารางตั้งแต่คอลัมน์ G เป็นต้นไป (กันชนกับ D=UnitPrice) ไม่เจอ = ใช้ G/H แล้วเติมหัวตารางให้
// ต้องตรงกับฝั่งอ่านใน pages/api/qcrd.js (findYieldCols)
function yieldCols_(menuSh) {
  var lastCol = Math.max(menuSh.getLastColumn(), 8);
  var header = menuSh.getRange(1, 1, 1, lastCol).getValues()[0];
  var qtyCol = 0, unitCol = 0;
  for (var i = 6; i < header.length; i++) {   // i = 0-indexed, เริ่มที่คอลัมน์ G
    var h = String(header[i] || '').trim();
    if (!qtyCol && /ปริมาณ|yield/i.test(h)) qtyCol = i + 1;
    if (!unitCol && /หน่วย|unit/i.test(h)) unitCol = i + 1;
  }
  if (!qtyCol) { qtyCol = 7; menuSh.getRange(1, 7).setValue('ปริมาณที่ได้'); }
  if (!unitCol) { unitCol = 8; menuSh.getRange(1, 8).setValue('หน่วยที่ได้'); }
  return { qty: qtyCol, unit: unitCol };
}

// หมวดหมู่เมนู (ชีท menucodegroup: A=รหัสหมวด B=ชื่อหมวด)
// - ส่ง code มา → เปลี่ยนชื่อหมวดนั้น (ไม่เจอรหัส = สร้างใหม่ด้วยรหัสที่ส่งมา)
// - ไม่ส่ง code → หาจากชื่อก่อน ถ้าไม่มีค่อยสร้างรหัสใหม่ (เลขถัดจากรหัสสูงสุดในชีท)
function upsertMenuGroup_(ss, code, name) {
  var sh = ss.getSheetByName('menucodegroup');
  if (!sh) throw new Error('ไม่พบชีท menucodegroup');
  code = String(code || '').trim();
  name = String(name || '').trim();
  if (!code && !name) throw new Error('ต้องระบุรหัสหรือชื่อหมวดหมู่');

  var values = sh.getLastRow() > 1 ? sh.getRange(1, 1, sh.getLastRow(), 2).getValues() : [[]];
  var maxCode = 0;
  var foundByName = -1;
  for (var i = 1; i < values.length; i++) {
    var c = String(values[i][0] || '').trim();
    var n = String(values[i][1] || '').trim();
    var asNum = Number(c);
    if (c && !isNaN(asNum) && asNum > maxCode) maxCode = asNum;
    if (code && c === code) {
      if (name && name !== n) sh.getRange(i + 1, 2).setValue(name);
      return { code: c, name: name || n, renamed: Boolean(name && name !== n) };
    }
    if (!code && name && n === name && foundByName < 0) foundByName = i;
  }
  if (foundByName >= 0) return { code: String(values[foundByName][0] || '').trim(), name: name };
  if (!name) throw new Error('ไม่พบรหัสหมวด ' + code + ' และไม่ได้ระบุชื่อหมวดใหม่');

  var newCode = code || String(maxCode + 1);
  sh.appendRow([newCode, name]);
  return { code: newCode, name: name, created: true };
}

// เพิ่ม/เปลี่ยนชื่อหมวดหมู่เมนู
// payload: { code, name }  — มี code = เปลี่ยนชื่อหมวดนั้น, ไม่มี code = เพิ่มหมวดใหม่
function saveMenuGroup_(ss, data) {
  try {
    return { status: 'success', data: upsertMenuGroup_(ss, data.code, data.name) };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// เรียงชีท BOM ให้ลำดับเมนู "ตรงกับหน้าเว็บ" — คือเรียงตามลำดับแถวในชีท menu
// (ไม่เรียงตามเลขรหัส) แล้วภายในเมนูเดียวกันเรียงตามลำดับวัตถุดิบ (คอลัมน์ C)
// เมนูที่ไม่มีในชีท menu จะไปอยู่ท้ายชีท
function sortBom_(ss) {
  var sh = ss.getSheetByName('BOM');
  if (!sh) return { status: 'error', message: 'ไม่พบชีท BOM' };
  var last = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (last <= 2) return { status: 'success', data: { sortedRows: 0 } };

  // สร้างแผนที่ลำดับเมนูจากชีท menu: รหัสเมนู -> ตำแหน่งแถว (ใช้เป็นคีย์เรียง)
  var order = {};
  var menuSh = ss.getSheetByName('menu');
  if (menuSh) {
    var mv = menuSh.getRange(1, 1, menuSh.getLastRow(), 1).getValues();
    for (var i = 1; i < mv.length; i++) {
      var c = String(mv[i][0] || '').trim();
      if (c && order[c] === undefined) order[c] = i;
    }
  }
  var BIG = 1e9;

  var range = sh.getRange(2, 1, last - 1, lastCol);
  var rows = range.getValues();
  rows.sort(function (a, b) {
    var oa = order[String(a[0] || '').trim()];
    var ob = order[String(b[0] || '').trim()];
    if (oa === undefined) oa = BIG;
    if (ob === undefined) ob = BIG;
    if (oa !== ob) return oa - ob;
    return (Number(a[2]) || 0) - (Number(b[2]) || 0); // ลำดับวัตถุดิบในเมนูเดียวกัน
  });
  range.setValues(rows);
  return { status: 'success', data: { sortedRows: rows.length } };
}

// เปิด/ปิดใช้งานเมนู: เขียนสถานะลงชีท menu คอลัมน์ F ตามรหัส
// payload: { code, status }  (status = 'ใช้งาน' | 'ปิดการใช้งาน')
function saveMenuStatus_(ss, data) {
  var code = String(data.code || '').trim();
  if (!code) return { status: 'error', message: 'ต้องระบุรหัสเมนู' };
  var sh = ss.getSheetByName('menu');
  if (!sh) return { status: 'error', message: 'ไม่พบชีท menu' };
  var values = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === code) {
      sh.getRange(i + 1, 6).setValue(String(data.status || 'ใช้งาน').trim());
      return { status: 'success', data: { code: code, status: data.status } };
    }
  }
  return { status: 'error', message: 'ไม่พบรหัส ' + code + ' ในชีท menu' };
}

// แก้ไขข้อมูลวัตถุดิบ: ชื่อ(B) ราคา(C) หน่วย(D) สถานะ(E) ไอเทมทดแทน(F-H) ตัวแปลงหน่วย(I) สาขาที่ใช้(J) หมวดสโตร์(N)
// payload: { code, name, price, unit, status, subs: ['รหัส1','รหัส2','รหัส3'], converter, branches: ['SJP','CRM'], storeCategory }
function saveItem_(ss, data) {
  var code = String(data.code || '').trim();
  if (!code) return { status: 'error', message: 'ต้องระบุรหัสวัตถุดิบ' };
  var sh = ss.getSheetByName('item');
  if (!sh) return { status: 'error', message: 'ไม่พบชีท item' };
  var values = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === code) {
      var row = i + 1;
      if (data.name !== undefined && String(data.name).trim()) sh.getRange(row, 2).setValue(String(data.name).trim());
      if (data.price !== undefined && data.price !== '' && !isNaN(Number(data.price))) {
        sh.getRange(row, 3).setValue(Number(data.price));
      }
      if (data.unit !== undefined) sh.getRange(row, 4).setValue(String(data.unit || '').trim());
      if (data.status !== undefined) sh.getRange(row, 5).setValue(String(data.status || 'ใช้งาน').trim());
      if (data.subs !== undefined) {
        var subs = (data.subs || []).slice(0, 3);
        sh.getRange(row, 6, 1, 3).setValues([[subs[0] || '', subs[1] || '', subs[2] || '']]);
      }
      if (data.converter !== undefined) {
        sh.getRange(row, 9).setValue(data.converter === '' ? '' : Number(data.converter) || '');
      }
      if (data.branches !== undefined) {
        sh.getRange(row, 10).setValue((data.branches || []).join(','));
      }
      if (data.storeCategory !== undefined) {
        sh.getRange(row, 14).setValue(String(data.storeCategory || '').trim());
      }
      return { status: 'success', data: { code: code, row: row } };
    }
  }
  return { status: 'error', message: 'ไม่พบรหัส ' + code + ' ในชีท item' };
}

// เพิ่มวัตถุดิบใหม่: ต่อแถวใหม่ท้ายชีท item (กันรหัสซ้ำ)
// คอลัมน์: A=รหัส B=ชื่อ C=ราคา D=หน่วย E=สถานะ F–H=ไอเทมทดแทน I=ตัวแปลง J=สาขาที่ใช้ N=หมวดสโตร์
// payload: { code, name, price, unit, status, subs[], converter, branches[], storeCategory }
function addItem_(ss, data) {
  var code = String(data.code || '').trim();
  if (!code) return { status: 'error', message: 'ต้องระบุรหัสวัตถุดิบ' };
  var name = String(data.name || '').trim();
  if (!name) return { status: 'error', message: 'ต้องระบุชื่อวัตถุดิบ' };
  var sh = ss.getSheetByName('item');
  if (!sh) return { status: 'error', message: 'ไม่พบชีท item' };
  var values = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === code) {
      return { status: 'error', message: 'มีรหัส ' + code + ' อยู่แล้วในชีท item' };
    }
  }
  var subs = (data.subs || []).slice(0, 3);
  var price = (data.price !== undefined && data.price !== '' && !isNaN(Number(data.price))) ? Number(data.price) : '';
  var converter = (data.converter !== undefined && data.converter !== '' && !isNaN(Number(data.converter))) ? Number(data.converter) : '';
  var storeCategory = String(data.storeCategory || '').trim();
  var newRow = sh.getLastRow() + 1;
  // ใช้ setValues แทน appendRow เพื่อคุมตำแหน่งคอลัมน์ N (K,L,M เว้นว่างไว้ตามชีทเดิม)
  sh.getRange(newRow, 1, 1, 14).setValues([[
    code, name, price, String(data.unit || '').trim(), String(data.status || 'ใช้งาน').trim(),
    subs[0] || '', subs[1] || '', subs[2] || '',
    converter, (data.branches || []).join(','),
    '', '', '', storeCategory,
  ]]);
  return { status: 'success', data: { code: code, row: newRow } };
}

// ลบวัตถุดิบ: ลบทั้งแถวออกจากชีท item
// payload: { code, row }  — row = เลขแถวจริงในชีท (1-indexed) จาก field _row ที่ /api/qcrd?sheet=item ส่งมา
//   ส่ง row มาด้วยเพื่อความแม่นยำ เผื่อรหัสซ้ำกันหลายแถว (ลบด้วยรหัสอย่างเดียวจะเจอแค่แถวแรกเสมอ)
function deleteItem_(ss, data) {
  var code = String(data.code || '').trim();
  if (!code) return { status: 'error', message: 'ต้องระบุรหัสวัตถุดิบ' };
  var sh = ss.getSheetByName('item');
  if (!sh) return { status: 'error', message: 'ไม่พบชีท item' };
  var values = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();

  var targetRow = Number(data.row) || 0;
  if (targetRow > 1 && targetRow <= values.length) {
    var cellCode = String(values[targetRow - 1][0] || '').trim();
    if (cellCode !== code) {
      return { status: 'error', message: 'แถว ' + targetRow + ' ไม่ตรงกับรหัส ' + code + ' (ข้อมูลในชีทอาจเปลี่ยนไปแล้ว รีเฟรชหน้าแล้วลองอีกครั้ง)' };
    }
    sh.deleteRow(targetRow);
    return { status: 'success', data: { code: code, row: targetRow } };
  }

  // ไม่ได้ส่ง row มา (หรือ row ไม่ตรงกับที่เช็ค) → หาแถวแรกที่รหัสตรง
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === code) {
      var row = i + 1;
      sh.deleteRow(row);
      return { status: 'success', data: { code: code, row: row } };
    }
  }
  return { status: 'error', message: 'ไม่พบรหัส ' + code + ' ในชีท item' };
}

// เติมหน่วยลงคอลัมน์ D ของชีท item — เขียนเฉพาะช่องที่ยังว่าง (ไม่ทับของเดิม)
// payload: { units: [{ code, unit }] }
function updateItemUnits_(ss, data) {
  var units = data.units || [];
  var sh = ss.getSheetByName('item');
  if (!sh) return { status: 'error', message: 'ไม่พบชีท item' };
  var values = sh.getDataRange().getValues();
  var map = {};
  units.forEach(function (u) { map[String(u.code || '').trim()] = String(u.unit || '').trim(); });
  var updated = 0;
  for (var i = 1; i < values.length; i++) {
    var code = String(values[i][0] || '').trim();
    var cur = String(values[i][3] || '').trim();
    if (code && !cur && map[code]) {
      sh.getRange(i + 1, 4).setValue(map[code]);
      updated++;
    }
  }
  return { status: 'success', data: { updated: updated } };
}
