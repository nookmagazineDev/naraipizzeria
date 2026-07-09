/**
 * Narai — action saveEmployee (เพิ่มเข้าไปใน Apps Script "ตัวเดียวกับ getEmployees")
 *
 * วิธีใช้:
 *   1) เปิด Apps Script ที่มี getEmployees อยู่ (ตัวที่ deploy เป็น stock-gas)
 *   2) วาง 2 ฟังก์ชันด้านล่างเพิ่ม (saveEmployee_ + ตัวช่วย) — อย่าลบ getEmployees เดิม
 *   3) ในสวิตช์ของ doPost เพิ่มบรรทัด:
 *          else if (action === 'saveEmployee') { return _json(saveEmployee_(data)); }
 *      (ถ้าโครงสร้าง doPost ต่างจากนี้ ปรับให้เรียก saveEmployee_(data) แล้วคืน JSON)
 *   4) Deploy > Manage deployments > ✏️ > New version > Deploy (URL เดิม)
 *
 * ทำงานแบบปลอดภัย:
 *   - หาแถวพนักงานจากคอลัมน์รหัส (hrCode) ที่ตรงกัน
 *   - หาคอลัมน์ที่จะเขียนจาก "หัวตาราง" (รองรับหลายชื่อ) → ไม่พึ่งตำแหน่งคอลัมน์ตายตัว
 *   - เขียนเฉพาะฟิลด์ที่ส่งมาเท่านั้น (ฟิลด์อื่นไม่ถูกแตะ)
 */

var EMP_SHEET_ID = '';        // ใส่ ID ชีตพนักงานถ้าสคริปต์เป็นแบบ standalone (ว่าง = ใช้ชีตที่ผูกกับสคริปต์)
var EMP_SHEET_NAME = 'DATA';  // ชื่อแท็บพนักงาน

// ชื่อหัวคอลัมน์ที่เป็นไปได้ของแต่ละฟิลด์ (เทียบแบบตัดช่องว่าง/ตัวพิมพ์เล็ก)
var EMP_HEADER_ALIASES = {
  hrCode:   ['รหัส hr', 'รหัส', 'hrcode', 'hr code', 'รหัสพนักงาน'],
  fullName: ['ชื่อ - สกุล', 'ชื่อ - นามสกุล', 'ชื่อ-สกุล', 'ชื่อสกุล', 'ชื่อ', 'fullname', 'name'],
  branch:   ['สาขา', 'branch'],
  type:     ['ประเภท', 'type'],
  status:   ['สถานะ', 'status'],
  startDate:['วันเริ่มงาน', 'วันเริ่มทำงาน', 'วันที่เริ่มงาน', 'เริ่มงาน', 'startdate', 'start date'],
  position: ['ตำแหน่ง', 'position'],
  loga:     ['loga', 'เลขที่ loga', 'เลข loga'],
  newCode:  ['รหัสใหม่', 'รหัส ใหม่', 'newcode', 'new code'],
  photoUrl: ['รูป', 'ลิงก์รูป', 'photo', 'photourl', 'url รูป', 'ลิงค์รูป'],
};

function _norm(s) { return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase(); }

function _empSheet() {
  var ss = EMP_SHEET_ID ? SpreadsheetApp.openById(EMP_SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(EMP_SHEET_NAME);
}

// สร้างแผนที่ field -> index คอลัมน์ (0-based) จากแถวหัวตาราง (ลองหัวใน 3 แถวแรก)
function _empColMap(values) {
  var map = {};
  var headerRow = 0;
  for (var r = 0; r < Math.min(3, values.length); r++) {
    var found = 0;
    var m = {};
    for (var c = 0; c < values[r].length; c++) {
      var cell = _norm(values[r][c]);
      if (!cell) continue;
      for (var field in EMP_HEADER_ALIASES) {
        if (map[field] !== undefined) continue;
        var aliases = EMP_HEADER_ALIASES[field];
        for (var a = 0; a < aliases.length; a++) {
          if (cell === _norm(aliases[a])) { m[field] = c; found++; break; }
        }
      }
    }
    if (found >= 3) { for (var k in m) map[k] = m[k]; headerRow = r; break; }
  }
  return { map: map, headerRow: headerRow };
}

function saveEmployee_(data) {
  var hrCode = String(data.hrCode == null ? '' : data.hrCode).trim();
  if (!hrCode) return { status: 'error', message: 'ต้องระบุ hrCode' };
  var sh = _empSheet();
  if (!sh) return { status: 'error', message: 'ไม่พบแท็บ ' + EMP_SHEET_NAME };

  var values = sh.getDataRange().getValues();
  var cm = _empColMap(values);
  if (cm.map.hrCode === undefined) return { status: 'error', message: 'หาคอลัมน์รหัส (hrCode) จากหัวตารางไม่เจอ' };

  // หาแถวที่รหัสตรง
  var rowNum = -1;
  for (var i = cm.headerRow + 1; i < values.length; i++) {
    if (String(values[i][cm.map.hrCode]).trim() === hrCode) { rowNum = i + 1; break; }
  }
  if (rowNum < 0) return { status: 'error', message: 'ไม่พบพนักงานรหัส ' + hrCode };

  // เขียนเฉพาะฟิลด์ที่ส่งมา และมีคอลัมน์รองรับ
  var updated = [];
  var skipped = [];
  for (var field in EMP_HEADER_ALIASES) {
    if (field === 'hrCode') continue;
    if (!(field in data)) continue;
    if (cm.map[field] === undefined) { skipped.push(field); continue; }
    sh.getRange(rowNum, cm.map[field] + 1).setValue(data[field]);
    updated.push(field);
  }
  return { status: 'success', data: { hrCode: hrCode, row: rowNum, updated: updated, skipped: skipped } };
}
