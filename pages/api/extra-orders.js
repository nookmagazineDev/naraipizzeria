// ดึงออเดอร์เพิ่มเติมจาก Google Sheet (ระบบสั่งอาหารภายนอก) แล้วแปลงให้อยู่ในรูปแบบ
// เดียวกับ API บิล (sales) และรายการ (details) เพื่อนำไปรวมในรายงาน โดยตั้งเป็นโต๊ะ 800
// แยกสาขาตามคอลัมน์ L (RecordedBy) เช่น xum → 59, xcm → 19 (เดิม hardcode เป็น XUM หมด)
// คอลัมน์ใดที่ชีตไม่มี จะใส่เป็นค่าว่าง/0 เพื่อไม่ให้กระทบการคำนวณเมนูอื่น

const SHEET_ID = '1gijgBrK56bsjR7-R5NVWiTGTcxM57wjuYR3FUpl3EDQ';
const GID = '255916825';                 // แท็บรายการออเดอร์
const PAY_SHEET = 'PaymentSummary';      // แท็บสรุปช่องทางจ่ายต่อออเดอร์
const DEFAULT_OUTLET = 59;   // ค่า fallback ถ้าคอลัมน์ L ไม่ตรงสาขาใด (เช่น admin) → XUM
const TABLE_ID = 800;
const CHECKID_BASE = 800000; // ฐานเลขบิลสังเคราะห์ กันชนกับ checkID จริง

// รหัสสาขาในคอลัมน์ L (RecordedBy) → outletID (ชุดเดียวกับ branchMap ทั้งระบบ)
const BRANCH_OUTLET = {
  sjp: 7, crm: 12, xcm: 19, slr: 37, sum: 51, xum: 59, scs: 61, smp: 63,
  xsb: 67, xhh: 72, hrs: 78, clk: 79, p90: 80, hps: 109, zbw: 400, zpt: 401,
  npt: 500, wrm: 501, wmt: 503, ipr: 904, zk3: 906,
};

// แปลงช่องทางจ่ายจากชีต -> ช่องทางในระบบ (เติมยอดลงคอลัมน์ที่ตรง เพื่อให้ Total Sales นับถูก)
// ถ้าไม่มีข้อมูลช่องทางจ่าย (ไม่อยู่ใน PaymentSummary) ให้ตั้งเป็น "เงินโอน (QR)" ไปก่อน
function mapPayment(method, total) {
  const m = String(method || '').trim();
  const out = { paidType: m || 'เงินโอน', cash: 0, credit: 0, qr: 0 };
  if (m.includes('สด')) out.cash = total;
  else if (m.includes('บัตร') || m.includes('เครดิต') || m.toLowerCase().includes('credit')) out.credit = total;
  else out.qr = total;   // เงินโอน/QR/พร้อมเพย์ และกรณีไม่มีข้อมูล -> เงินโอน (QR)
  return out;
}

// แยก CSV แบบรองรับเครื่องหมายคำพูดและคอมมาในฟิลด์
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (c === '\r') {
      // ข้าม
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// '2026-06-16T19:49:12+07:00' -> '2026-06-16 19:49:12'
function toDateTime(iso) {
  if (!iso) return '';
  return String(iso).slice(0, 19).replace('T', ' ');
}

export default async function handler(req, res) {
  try {
    const ordersUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;
    const payUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(PAY_SHEET)}`;
    const [ordersRes, payRes] = await Promise.all([
      fetch(ordersUrl, { cache: 'no-store' }),
      fetch(payUrl, { cache: 'no-store' }),
    ]);
    if (!ordersRes.ok) throw new Error(`Google Sheets HTTP ${ordersRes.status}`);
    const text = await ordersRes.text();
    if (text.includes('<!DOCTYPE html>')) {
      throw new Error('Google Sheet ไม่เปิดสิทธิ์สาธารณะ (ได้หน้า login กลับมา)');
    }

    // แผนที่ช่องทางจ่ายต่อออเดอร์ จากแท็บ PaymentSummary (ไม่บังคับ — ถ้าโหลดไม่ได้ก็ปล่อยว่าง)
    const paymentByOrder = new Map();
    try {
      if (payRes.ok) {
        const payText = await payRes.text();
        if (!payText.includes('<!DOCTYPE html>')) {
          const pm = parseCSV(payText);
          const ph = pm[0].map(h => h.trim());
          const pOrd = ph.indexOf('orderNumber');
          const pMethod = ph.indexOf('paymentMethod');
          if (pOrd >= 0 && pMethod >= 0) {
            for (let i = 1; i < pm.length; i++) {
              const key = (pm[i][pOrd] || '').trim();
              if (key) paymentByOrder.set(key, (pm[i][pMethod] || '').trim());
            }
          }
        }
      }
    } catch (e) { /* ปล่อยว่างถ้าอ่าน PaymentSummary ไม่ได้ */ }

    const matrix = parseCSV(text);
    if (matrix.length < 2) return res.status(200).json({ sales: [], details: [] });

    const header = matrix[0].map(h => h.trim());
    const idx = name => header.indexOf(name);
    const col = {
      orderNo: idx('OrderNumber'),
      itemDetail: idx('ItemDetail'),
      price: idx('Price'),
      total: idx('TotalAmount'),
      start: idx('OrderStartTime'),
      complete: idx('CompletionTime'),
      recordedBy: idx('RecordedBy'),
      timestamp: idx('Timestamp'),
    };

    // รวมแถวเป็นรายการ object ก่อน
    const rows = [];
    for (let i = 1; i < matrix.length; i++) {
      const r = matrix[i];
      if (!r || r.length === 0 || r.every(c => !String(c).trim())) continue;
      rows.push(r);
    }

    // สร้างรหัสสินค้าสังเคราะห์ต่อชื่อเมนู (เพื่อให้เมนู "ค้นหารายไอเทม" จัดกลุ่มแยกได้)
    const codeByName = new Map();
    let codeSeq = 0;
    const codeForName = name => {
      const key = name || '-';
      if (!codeByName.has(key)) {
        codeSeq += 1;
        codeByName.set(key, 'X8' + String(codeSeq).padStart(4, '0'));
      }
      return codeByName.get(key);
    };

    // สาขาจากคอลัมน์ L (RecordedBy) → outletID
    const branchOf = r => String(r[col.recordedBy] || '').trim().toLowerCase();
    const outletOf = r => BRANCH_OUTLET[branchOf(r)] || DEFAULT_OUTLET;

    // จัดกลุ่มตาม สาขา + OrderNumber + วันที่เปิด
    // (ต้องมีสาขาในคีย์ ไม่งั้นเลขออเดอร์ซ้ำวันเดียวกันคนละสาขาจะรวมเป็นบิลเดียวผิด)
    const groups = new Map();
    for (const r of rows) {
      const orderNo = (r[col.orderNo] || '').trim();
      const day = toDateTime(r[col.start]).slice(0, 10);
      const key = `${outletOf(r)}|${orderNo}|${day}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    // เรียงตามเวลาเปิดเพื่อให้ checkID สังเคราะห์คงที่
    const orderKeys = [...groups.keys()].sort((a, b) => {
      const ra = groups.get(a)[0], rb = groups.get(b)[0];
      return toDateTime(ra[col.start]).localeCompare(toDateTime(rb[col.start]));
    });

    const sales = [];
    const details = [];

    orderKeys.forEach((key, gi) => {
      const lines = groups.get(key);
      const first = lines[0];
      const outletID = outletOf(first);
      const checkID = CHECKID_BASE + gi + 1;
      const orderNoRaw = (first[col.orderNo] || '').replace(/[^0-9]/g, '');
      // ใส่ outletID ในคีย์ออเดอร์ กันชนกันข้ามสาขาที่เลขออเดอร์ซ้ำ
      const orderID = 'X800-' + outletID + '-' + (orderNoRaw || String(gi + 1));
      const startTime = toDateTime(first[col.start]);
      const closeTime = toDateTime(first[col.complete] || first[col.start]);
      const total = parseFloat(first[col.total] || 0) || 0;
      // total จากชีตเป็นยอดรวม VAT แล้ว → แยก VAT 7% แบบรวมใน ออกมาใส่ช่อง vat
      // (ยอดก่อน VAT = total - vat ; ก่อน VAT + VAT = total เท่าที่ได้จาก API)
      const vat = Math.round((total * 7 / 107) * 100) / 100;
      const recordedBy = (first[col.recordedBy] || '').trim();
      const pay = mapPayment(paymentByOrder.get((first[col.orderNo] || '').trim()), total);

      // ── บิล (sales) 1 แถวต่อ 1 ออเดอร์ ──
      sales.push({
        outletID,
        checkID,
        amount: total,
        billTotal: total,
        cashierID: '',
        cashierName: recordedBy,
        waiterName: recordedBy,
        checkDesc: 'Order ' + (first[col.orderNo] || ''),
        cover: 0,
        coverAd: 0,
        coverAll: 0,
        date: closeTime,        // เวลาปิดบิล
        startTime,              // เวลาเปิดบิล
        tableID: TABLE_ID,
        taxInvNo: '',
        vat,
        paidType: pay.paidType,
        paidNote: '',
        memberTel: '',
        orderID,
        pkg: 'XUM-SHEET',
        cash: pay.cash, credit: pay.credit, qr: pay.qr, qrCredit: 0,
        alipay: 0, weChat: 0, voucher: 0, oc: 0,
      });

      // ── รายการสินค้า (details) 1 แถวต่อ 1 บรรทัดในชีต ──
      lines.forEach((r, li) => {
        const rawName = (r[col.itemDetail] || '').trim();
        const price = parseFloat(r[col.price] || 0) || 0;
        // ถ้าชื่อลงท้ายด้วย (xN) เช่น "ข้าวมันไก่ไหหลำ (x5)" -> ดึง N มาเป็นจำนวน,
        // ตัด (xN) ออกจากชื่อ และคิดราคา/หน่วย = ราคารวม ÷ N (มูลค่ารวมคงเดิม)
        const qm = rawName.match(/\(\s*[xX]\s*(\d+)\s*\)\s*$/);
        const quantity = qm ? parseInt(qm[1], 10) : 1;
        const name = qm ? rawName.replace(/\(\s*[xX]\s*\d+\s*\)\s*$/, '').trim() : rawName;
        const unitPrice = quantity > 0 ? price / quantity : price;
        details.push({
          outletID,
          chkCheckID: checkID,
          orderID,
          orderNo: 0,
          sequence: li + 1,
          tableID: TABLE_ID,
          itemCode: codeForName(name),
          menuCode: '',
          nameThai: name,
          nameEng: '',
          quantity,
          unitPrice,
          grossPrice: price,
          tax: 0,
          svc: 0,
          cover: 0,
          eatType: 'E',
          ordType: 'E',
          station: '',
          waiterName: recordedBy,
          waiterID: '',
          cashierID: '',
          startTime,
          postTime: startTime,
          prtOrdTime: startTime,
          endTime: closeTime,
          serveTime: closeTime,
          void: '',
          voidTime: '',
          pkg: 'XUM-SHEET',
        });
      });
    });

    res.status(200).json({ sales, details });
  } catch (err) {
    console.error('Extra-orders API error:', err.message);
    res.status(502).json({ error: err.message, sales: [], details: [] });
  }
}
