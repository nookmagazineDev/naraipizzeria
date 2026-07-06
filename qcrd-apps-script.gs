/**
 * Narai — Apps Script สำหรับเมนู QC/RD (ชีทต้นทุนเมนู 1v8WRT…)
 * วิธีใช้:
 *   1) เปิดชีท https://docs.google.com/spreadsheets/d/1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw
 *   2) Extensions > Apps Script → วางโค้ดนี้ทั้งหมด → Save
 *   3) Deploy > New deployment > Web app (Execute as: Me / Who has access: Anyone) → คัดลอก URL /exec
 *   4) ใส่ env QCRD_GAS_URL บน Vercel แล้ว Redeploy (หรือใส่ fallback ใน pages/api/qcrd-gas.js)
 *
 * แท็บที่ใช้:
 *   menu : A=Code B=NameThai C=MenuCode D=UnitPrice E=cost Menu
 *   BOM  : A=เลขPOS B=ชื่อเมนู C=ลำดับ D=รหัสวัตถุดิบ E=ชื่อวัตถุดิบ F=ยอดใช้ G=1 H=ตัวแปลงหน่วย
 *          I=รหัสวัตถุดิบ(ตัด 0 นำหน้า) J=ราคาวัตถุดิบ K=ต้นทุน/หน่วยเล็ก L=(ว่าง) M=ต้นทุน/หน่วยเล็ก N=ต้นทุนรวมของแถว
 *   item : A=รหัส B=ชื่อ C=ราคา D=หน่วย
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
  }

  return { status: 'success', data: { code: code, bomRows: bomRows.length, totalCost: costCell } };
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
