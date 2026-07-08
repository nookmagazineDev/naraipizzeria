/**
 * Narai — Apps Script สำหรับชีท "ค่าใช้จ่ายอื่นๆ"
 * วิธีใช้:
 *   1) เปิดชีท https://docs.google.com/spreadsheets/d/1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw
 *   2) เมนู Extensions > Apps Script → วางโค้ดนี้ทั้งหมด → Save
 *   3) Deploy > New deployment > เลือก type = Web app
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      → Deploy → คัดลอก URL ที่ลงท้าย /exec
 *   4) เอา URL ไปใส่ env EXPENSE_GAS_URL บน Vercel (Project > Settings > Environment Variables) แล้ว Redeploy
 *      หรือใส่ตรง fallback ใน pages/api/expense-gas.js
 *
 * โครงสร้าง (อ่าน/เขียนสเปรดชีตเดียวกัน 1YXOaA… คนละแท็บ):
 *   อ่านรหัส : แท็บ "ข้อมูลค่าใช้อื่น"  A=ประเภท B=สาขา C=รหัส
 *   บันทึก   : แท็บ "ค่าใช้จ่ายอื่น"    A=เดือน B=ประเภท C=สาขา D=รหัส E=เลขเริ่มต้น F=เลขสิ้นสุด G=จำนวน(E-F) H=ราคา/หน่วย I=ผลรวม
 *
 * actions: getExpenseRefs (อ่านรหัส) · saveOtherExpense (บันทึกจากฟอร์ม) ·
 *          bulkImport (นำเข้าหลายแถวรวดเดียว) · deleteExpenseByMonth (ลบตามเดือน)
 */

var REF_SHEET_ID  = '1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw';            // อ่านรหัส/สาขา
var DATA_SHEET_ID = '1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw';            // เก็บข้อมูล (ใช้สเปรดชีตเดียวกัน คนละแท็บ)
var REF_SHEET  = 'ข้อมูลค่าใช้อื่น';
var DATA_SHEET = 'ค่าใช้จ่ายอื่น';
var DATA_HEADER = ['เดือน', 'ประเภท', 'สาขา', 'รหัส', 'เลขเริ่มต้น', 'เลขสิ้นสุด', 'จำนวน', 'ราคาต่อหน่วย', 'ผลรวม'];

function doGet(e) {
  return ContentService.createTextOutput('Narai Expense Backend is running.');
}

function doPost(e) {
  var res = { status: 'error', message: '' };
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action;

    if (action === 'getExpenseRefs') {
      // อ่านรายการ (ประเภท, สาขา, รหัส) จากสเปรดชีตอ้างอิง
      var sh = SpreadsheetApp.openById(REF_SHEET_ID).getSheetByName(REF_SHEET);
      var refs = [];
      if (sh) {
        var values = sh.getDataRange().getValues();
        for (var i = 1; i < values.length; i++) { // ข้าม header แถวแรก
          var row = values[i];
          var type = (row[0] || '').toString().trim();   // A ประเภท
          var branch = (row[1] || '').toString().trim();  // B สาขา
          var code = (row[2] || '').toString().trim();    // C รหัส
          if (!type && !branch) continue;
          refs.push({ type: type, branch: branch, code: code });
        }
      }
      res.status = 'success';
      res.data = refs;

    } else if (action === 'saveOtherExpense') {
      // เขียนข้อมูลลงชีท "ค่าใช้จ่ายอื่น" (แถวละ 1 ประเภท/มิเตอร์)
      var sh = getDataSheet_();
      var month = data.month || '';
      var branch = data.branch || '';
      var items = data.items || [];
      var out = [];
      for (var j = 0; j < items.length; j++) {
        out.push(buildRow_(month, branch, items[j]));
      }
      if (out.length) sh.getRange(sh.getLastRow() + 1, 1, out.length, 9).setValues(out);
      res.status = 'success';
      res.data = { appended: out.length };

    } else if (action === 'bulkImport') {
      // นำเข้าหลายแถวรวดเดียว — rows: [{month,type,branch,code,start,end,price,total}]
      var sh2 = getDataSheet_();
      var rows = data.rows || [];
      var out2 = [];
      for (var k = 0; k < rows.length; k++) {
        var r = rows[k];
        out2.push(buildRow_(r.month || '', r.branch || '', r));
      }
      if (out2.length) sh2.getRange(sh2.getLastRow() + 1, 1, out2.length, 9).setValues(out2);
      res.status = 'success';
      res.data = { appended: out2.length };

    } else if (action === 'deleteExpenseByMonth') {
      // ลบแถวตามค่าในคอลัมน์เดือน (A) — ใช้ตอนต้องล้าง/แก้ข้อมูลที่นำเข้าผิด
      var sh3 = getDataSheet_();
      var m = String(data.month || '');
      var vals = sh3.getDataRange().getValues();
      var deleted = 0;
      for (var x = vals.length - 1; x >= 1; x--) {
        if (String(vals[x][0]) === m) { sh3.deleteRow(x + 1); deleted++; }
      }
      res.status = 'success';
      res.data = { deleted: deleted };

    } else {
      res.message = 'unknown action: ' + action;
    }
  } catch (err) {
    res.message = err.message;
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

// หา/สร้างชีทเก็บข้อมูล พร้อมหัวคอลัมน์
function getDataSheet_() {
  var ss = SpreadsheetApp.openById(DATA_SHEET_ID);
  var sh = ss.getSheetByName(DATA_SHEET);
  if (!sh) {
    sh = ss.insertSheet(DATA_SHEET);
    sh.appendRow(DATA_HEADER);
    sh.getRange('A1:I1').setFontWeight('bold');
  }
  return sh;
}

// สร้าง 1 แถวข้อมูล: คงช่องว่างไว้ถ้าไม่มีค่า (ไม่บังคับเป็น 0)
// จำนวน = เริ่มต้น − สิ้นสุด (ถ้ามีทั้งคู่) ; ผลรวม = ค่า total ที่ส่งมา หรือ จำนวน×ราคา
function buildRow_(month, branch, it) {
  var hasS = it.start !== '' && it.start != null;
  var hasE = it.end !== '' && it.end != null;
  var hasP = it.price !== '' && it.price != null;
  var start = hasS ? Number(it.start) : '';
  var end = hasE ? Number(it.end) : '';
  var price = hasP ? Number(it.price) : '';
  var qty = (hasS && hasE) ? (Number(it.start) - Number(it.end)) : '';
  var total;
  if (it.total !== '' && it.total != null) {
    total = Number(it.total);                       // นำเข้ายอดเงินรวมโดยตรง
  } else if (qty !== '' && hasP) {
    total = qty * price;                            // คำนวณจากมิเตอร์×ราคา
  } else {
    total = '';
  }
  return [month, it.type || '', branch, it.code || '', start, end, qty, price, total];
}
