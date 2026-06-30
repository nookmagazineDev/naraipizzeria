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
 * โครงสร้างชีท:
 *   "ข้อมูลค่าใช้อื่น"  : A=ประเภท  B=สาขา  C=รหัส        (ข้อมูลอ้างอิง/รหัส)
 *   "ค่าใช้จ่ายอื่น"    : A=เดือน B=ประเภท C=สาขา D=รหัส E=เลขเริ่มต้น F=เลขสิ้นสุด G=จำนวน(E-F) H=ราคา/หน่วย I=ผลรวม(G*H)
 */

var EXPENSE_SHEET_ID = '1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw';
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
    var ss = SpreadsheetApp.openById(EXPENSE_SHEET_ID);

    if (action === 'getExpenseRefs') {
      // อ่านรายการ (ประเภท, สาขา, รหัส) จากชีทข้อมูลอ้างอิง
      var sh = ss.getSheetByName(REF_SHEET);
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
      // เขียนข้อมูลลงชีท "ค่าใช้จ่ายอื่น" (แถวละ 1 ประเภท)
      var sh = ss.getSheetByName(DATA_SHEET);
      if (!sh) {
        sh = ss.insertSheet(DATA_SHEET);
        sh.appendRow(DATA_HEADER);
        sh.getRange('A1:I1').setFontWeight('bold');
      }
      var month = data.month || '';
      var branch = data.branch || '';
      var items = data.items || [];
      var appended = 0;
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        var start = Number(it.start) || 0;
        var end = Number(it.end) || 0;
        var price = Number(it.price) || 0;
        var qty = start - end;        // G = E - F
        var total = qty * price;      // I = G * H
        sh.appendRow([month, it.type || '', branch, it.code || '', start, end, qty, price, total]);
        appended++;
      }
      res.status = 'success';
      res.data = { appended: appended };

    } else {
      res.message = 'unknown action: ' + action;
    }
  } catch (err) {
    res.message = err.message;
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}
