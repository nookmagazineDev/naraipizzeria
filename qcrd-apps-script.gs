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
 *   BOM  : A=เลขPOS B=ชื่อเมนู C=ลำดับ D=รหัสวัตถุดิบ E=ชื่อวัตถุดิบ F=ยอดใช้ G=1 H=ตัวแปลงหน่วย
 *          I=รหัสวัตถุดิบ(ตัด 0 นำหน้า) J=ราคาวัตถุดิบ K=ต้นทุน/หน่วยเล็ก L=(ว่าง) M=ต้นทุน/หน่วยเล็ก N=ต้นทุนรวมของแถว
 *   item : A=รหัส B=ชื่อ C=ราคา D=หน่วย E=สถานะ(ใช้งาน/ปิดการใช้งาน) F,G,H=รหัสไอเทมทดแทน 1-3
 *          I=ตัวแปลงหน่วย(หน่วยเล็กต่อ 1 หน่วยซื้อ) J=สาขาที่ใช้(คั่นด้วย ,)
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
    } else if (action === 'saveMenuStatus') {
      res = saveMenuStatus_(ss, data);
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
// payload: { code, name, price, items: [{ itemCode, itemName, qty, converter }] }
function saveMenu_(ss, data) {
  var code = String(data.code || '').trim();
  var name = String(data.name || '').trim();
  var price = Number(data.price) || '';
  var items = data.items || [];
  if (!code || !name) return { status: 'error', message: 'ต้องระบุรหัสและชื่อเมนู' };

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
    return [code, name, idx + 1, itemCode, String(it.itemName || '').trim(),
            qty, 1, conv, itemCode.replace(/^0+/, ''), p || '',
            p ? unitCost : '', '', p ? unitCost : '', p ? lineCost : ''];
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
    menuSh.getRange(found, 2, 1, 2).setValues([[name, menuSh.getRange(found, 3).getValue() || '']]);
    if (data.price !== undefined && data.price !== '') menuSh.getRange(found, 4).setValue(price);
    if (bomRows.length) menuSh.getRange(found, 5).setValue(costCell);
  } else {
    menuSh.appendRow([code, name, '', price, costCell]);
  }

  // แทนที่แถว BOM เดิมของเมนูนี้ (ลบจากล่างขึ้นบน แล้วต่อท้ายใหม่)
  var bomSh = ss.getSheetByName('BOM');
  var bv = bomSh.getRange(1, 1, bomSh.getLastRow(), 1).getValues();
  for (var j = bv.length - 1; j >= 1; j--) {
    if (String(bv[j][0] || '').trim() === code) bomSh.deleteRow(j + 1);
  }
  if (bomRows.length) {
    bomSh.getRange(bomSh.getLastRow() + 1, 1, bomRows.length, bomRows[0].length).setValues(bomRows);
    sortBom_(ss); // จัดเรียงชีท BOM ใหม่ทุกครั้ง สูตรของเมนูเดียวกันจะอยู่ติดกันเสมอ
  }

  return { status: 'success', data: { code: code, bomRows: bomRows.length, totalCost: costCell } };
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

// แก้ไขข้อมูลวัตถุดิบ: ชื่อ(B) ราคา(C) สถานะ(E) ไอเทมทดแทน(F-H) ตัวแปลงหน่วย(I) สาขาที่ใช้(J) หมวดสโตร์(N)
// payload: { code, name, price, status, subs: ['รหัส1','รหัส2','รหัส3'], converter, branches: ['SJP','CRM'], storeCategory }
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
// payload: { code, name, price, status, subs[], converter, branches[], storeCategory }
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
    code, name, price, '', String(data.status || 'ใช้งาน').trim(),
    subs[0] || '', subs[1] || '', subs[2] || '',
    converter, (data.branches || []).join(','),
    '', '', '', storeCategory,
  ]]);
  return { status: 'success', data: { code: code, row: newRow } };
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
