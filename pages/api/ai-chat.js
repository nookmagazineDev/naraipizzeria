// AI NARAI — แชท AI (Gemini) ที่ดึงข้อมูลจริงจาก SQL Server ผ่าน host API
// สถาปัตยกรรม: หน้าเว็บ → /api/ai-chat → Gemini (function calling) ⇄ เครื่องมือ read-only
// เครื่องมือทุกตัวเรียก host API (Cloudflare tunnel → server.js → SQL Server) แล้ว aggregate
// ฝั่งนี้ก่อนส่งให้ AI (กัน token บวม + AI ไม่มีสิทธิ์ยิง SQL ตรง)
//
// ต้องตั้ง env: GEMINI_API_KEY (ขอฟรีที่ https://aistudio.google.com/apikey)
// เลือกโมเดลผ่าน env GEMINI_MODEL (default: gemini-2.0-flash)

const STORE_API = process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

const OUTLETS = {
  7: 'SJP', 12: 'CRM', 19: 'XCM', 37: 'SLR', 51: 'SUM',
  59: 'XUM', 61: 'SCS', 63: 'SMP', 67: 'XSB', 72: 'XHH',
  78: 'HRS', 79: 'CLK', 80: 'P90', 109: 'HPS', 400: 'ZBW',
  401: 'ZPT', 500: 'NPT', 501: 'WRM', 503: 'WMT', 904: 'IPR', 906: 'ZK3',
};
const BRANCH_TO_OUTLET = Object.fromEntries(
  Object.entries(OUTLETS).map(([id, name]) => [name.toUpperCase(), parseInt(id)])
);

// กติกาเดียวกับหน้าเว็บ: ตัดโต๊ะ 600, ไอเทมเตรียมของ, บิลยอดเหมาข้าวกล่อง
const EXCLUDE_TABLES = [600];
const EXCLUDE_ITEMS = [206001, 290016];
const isExcludedItem = c => {
  const ic = parseInt(c);
  return EXCLUDE_ITEMS.includes(ic) || (ic >= 500002 && ic <= 500026);
};

const num = v => parseFloat(v) || 0;
const r2 = v => Math.round(v * 100) / 100;

function assertRange(start, end, maxDays = 62) {
  const d1 = new Date(start), d2 = new Date(end);
  if (isNaN(d1) || isNaN(d2)) throw new Error('รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
  const days = (d2 - d1) / 86400000 + 1;
  if (days < 1) throw new Error('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  if (days > maxDays) throw new Error(`ช่วงวันที่ยาวเกินไป (สูงสุด ${maxDays} วัน) — แบ่งช่วงถามทีละเดือน`);
}

function outletParam(branch) {
  if (!branch) return '';
  const oid = BRANCH_TO_OUTLET[String(branch).toUpperCase().trim()];
  if (!oid) throw new Error(`ไม่รู้จักสาขา "${branch}" — สาขาที่มี: ${Object.values(OUTLETS).join(', ')}`);
  return `&outlet=${oid}`;
}

async function fetchSales(start, end, branch) {
  const r = await fetch(`${STORE_API}/cpaidbetweendate?start=${start}&end=${end}${outletParam(branch)}`);
  if (!r.ok) throw new Error(`host API HTTP ${r.status}`);
  const j = await r.json();
  return (Array.isArray(j) ? j : j.data || [])
    .filter(b => !EXCLUDE_TABLES.includes(parseInt(b.tableID)));
}

async function fetchDetails(start, end, branch) {
  const r = await fetch(`${STORE_API}/ctranbetweendate?start=${start}&end=${end}${outletParam(branch)}`);
  if (!r.ok) throw new Error(`host API HTTP ${r.status}`);
  const j = await r.json();
  return (Array.isArray(j) ? j : j.data || []);
}

// ── เครื่องมือที่เปิดให้ AI เรียก (read-only ทั้งหมด) ──
const TOOL_HANDLERS = {
  // ยอดขายสรุปรายวัน/รายสาขา
  async get_daily_sales({ start_date, end_date, branch }) {
    assertRange(start_date, end_date);
    const rows = await fetchSales(start_date, end_date, branch);
    const g = {};
    rows.forEach(b => {
      let bt = num(b.billTotal) - num(b.voucher1);
      if (bt < 0) bt = 0;
      const date = String(b.startTime || b.date || '').slice(0, 10);
      const name = OUTLETS[b.outletID] || String(b.outletID);
      const k = `${date}|${name}`;
      if (!g[k]) g[k] = { date, branch: name, bills: 0, gross: 0, vat: 0 };
      g[k].bills++;
      g[k].gross += bt;
      g[k].vat += bt > 0 ? num(b.vat) : 0;
    });
    const out = Object.values(g).map(x => ({ ...x, gross: r2(x.gross), vat: r2(x.vat), net: r2(x.gross - x.vat) }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.branch.localeCompare(b.branch));
    return { rows: out, note: 'gross รวม VAT แล้ว, net = ก่อน VAT, ตัดโต๊ะ 600 และหักวอเชอร์แล้ว' };
  },

  // รายการขายดี (Top N) ตามยอดเงินหรือจำนวน
  async get_top_items({ start_date, end_date, branch, limit = 20, by = 'amount' }) {
    assertRange(start_date, end_date, 31);
    const rows = await fetchDetails(start_date, end_date, branch);
    const g = {};
    rows.forEach(r => {
      if (r.void) return;
      if (EXCLUDE_TABLES.includes(parseInt(r.tableID))) return;
      if (isExcludedItem(r.itemCode)) return;
      const k = String(r.itemCode);
      if (!g[k]) g[k] = { itemCode: k, name: String(r.nameThai || '').trim(), qty: 0, amount: 0 };
      g[k].qty += num(r.quantity);
      g[k].amount += num(r.grossPrice);
    });
    const sorted = Object.values(g).sort((a, b) => by === 'qty' ? b.qty - a.qty : b.amount - a.amount);
    const top = sorted.slice(0, Math.min(limit, 50)).map(x => ({ ...x, qty: r2(x.qty), amount: r2(x.amount) }));
    return { items: top, totalItems: sorted.length, note: 'amount = ยอดก่อน VAT, ไม่รวมรายการ void/ไอเทมเตรียมของ' };
  },

  // สรุปช่องทางการชำระเงิน
  async get_payment_summary({ start_date, end_date, branch }) {
    assertRange(start_date, end_date);
    const rows = await fetchSales(start_date, end_date, branch);
    const sum = { cash: 0, credit: 0, qr: 0, qrCredit: 0, grab: 0, lineMan: 0, shopee: 0, robinhood: 0, other: 0 };
    rows.forEach(b => {
      const bt = num(b.billTotal) - num(b.voucher1);
      if (bt <= 0) return;
      const pt = String(b.paidType || '').toUpperCase();
      if (num(b.cash)) sum.cash += num(b.cash);
      else if (num(b.credit)) sum.credit += num(b.credit);
      else if (num(b.qr)) sum.qr += num(b.qr);
      else if (num(b.qrCredit)) sum.qrCredit += num(b.qrCredit);
      else if (pt.includes('GRAB')) sum.grab += bt;
      else if (pt.includes('LINE')) sum.lineMan += bt;
      else if (pt.includes('SHOPEE')) sum.shopee += bt;
      else if (pt.includes('ROBINHOOD')) sum.robinhood += bt;
      else sum.other += bt;
    });
    Object.keys(sum).forEach(k => { sum[k] = r2(sum[k]); });
    return { payments: sum, bills: rows.length };
  },

  // รายละเอียดบิลหนึ่งใบ (บิล + รายการอาหาร)
  async get_bill_detail({ check_id, branch, date }) {
    if (!branch || !date) throw new Error('ต้องระบุ branch และ date (วันที่ของบิล YYYY-MM-DD)');
    const [sales, dets] = await Promise.all([
      fetchSales(date, date, branch),
      fetchDetails(date, date, branch),
    ]);
    const bill = sales.find(b => String(b.checkID) === String(check_id));
    if (!bill) return { found: false, message: `ไม่พบบิล ${check_id} สาขา ${branch} วันที่ ${date}` };
    const lines = dets.filter(r => String(r.chkCheckID) === String(check_id))
      .map(r => ({ itemCode: r.itemCode, name: r.nameThai, qty: num(r.quantity), gross: num(r.grossPrice), void: !!r.void }));
    return {
      found: true,
      bill: {
        checkID: bill.checkID, date: bill.date, startTime: bill.startTime, tableID: bill.tableID,
        billTotal: num(bill.billTotal), vat: num(bill.vat), paidType: bill.paidType,
        cash: num(bill.cash), credit: num(bill.credit), qr: num(bill.qr),
      },
      lines,
    };
  },

  // รายชื่อสาขาทั้งหมด
  async get_branches() {
    return { branches: Object.entries(OUTLETS).map(([id, name]) => ({ outletID: parseInt(id), code: name })) };
  },
};

// ── นิยามเครื่องมือให้ Gemini ──
const TOOL_DECLARATIONS = [
  {
    name: 'get_daily_sales',
    description: 'ดึงยอดขายสรุปรายวันต่อสาขา (จำนวนบิล, ยอดรวม VAT, VAT, ยอดก่อน VAT) จากฐานข้อมูลจริง',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING', description: 'วันเริ่ม YYYY-MM-DD' },
        end_date: { type: 'STRING', description: 'วันสิ้นสุด YYYY-MM-DD' },
        branch: { type: 'STRING', description: 'รหัสสาขา เช่น SJP, XUM (ไม่ระบุ = ทุกสาขา)' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_top_items',
    description: 'ดึงรายการอาหาร/สินค้าขายดี Top N ในช่วงวันที่ (จำนวนและยอดเงินต่อเมนู) สูงสุด 31 วันต่อครั้ง',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING', description: 'วันเริ่ม YYYY-MM-DD' },
        end_date: { type: 'STRING', description: 'วันสิ้นสุด YYYY-MM-DD' },
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
        limit: { type: 'NUMBER', description: 'จำนวนอันดับ (default 20, สูงสุด 50)' },
        by: { type: 'STRING', description: '"amount" เรียงตามยอดเงิน หรือ "qty" เรียงตามจำนวน' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_payment_summary',
    description: 'สรุปยอดตามช่องทางการชำระเงิน (เงินสด เครดิต QR Grab ฯลฯ) ในช่วงวันที่',
    parameters: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING' }, end_date: { type: 'STRING' },
        branch: { type: 'STRING', description: 'รหัสสาขา (ไม่ระบุ = ทุกสาขา)' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_bill_detail',
    description: 'ดูรายละเอียดบิลใบเดียว: ยอด, ช่องทางจ่าย, รายการอาหารทุกบรรทัด',
    parameters: {
      type: 'OBJECT',
      properties: {
        check_id: { type: 'STRING', description: 'เลขบิล (checkID)' },
        branch: { type: 'STRING', description: 'รหัสสาขา เช่น SJP' },
        date: { type: 'STRING', description: 'วันที่ของบิล YYYY-MM-DD' },
      },
      required: ['check_id', 'branch', 'date'],
    },
  },
  { name: 'get_branches', description: 'รายชื่อสาขาทั้งหมดพร้อม outletID', parameters: { type: 'OBJECT', properties: {} } },
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!GEMINI_KEY) {
    return res.status(503).json({
      error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY — ขอ key ฟรีที่ aistudio.google.com/apikey แล้วใส่ใน Environment Variables ของ Vercel',
    });
  }

  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'ต้องส่ง messages' });
    }

    const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); // เวลาไทย
    const systemText =
      `คุณคือ "AI NARAI" ผู้ช่วยวิเคราะห์ข้อมูลร้านอาหาร Narai Pizzeria ตอบเป็นภาษาไทย กระชับ ชัดเจน ` +
      `วันนี้คือ ${today} (ปี ค.ศ.) ข้อมูลทั้งหมดต้องมาจากเครื่องมือที่ให้ไว้เท่านั้น ห้ามเดาตัวเลขเอง ` +
      `ถ้าผู้ใช้ไม่ระบุช่วงวันที่ ให้ตีความอย่างสมเหตุผล (เช่น "เดือนนี้" = วันที่ 1 ของเดือนถึงวันนี้) และบอกช่วงที่ใช้ในคำตอบ ` +
      `สาขาที่มี: ${Object.values(OUTLETS).join(', ')} ` +
      `เมื่อแสดงตัวเลขเงินให้ใส่ comma และหน่วยบาท ถ้าเหมาะสมให้จัดเป็นตาราง markdown`;

    // แปลง history เป็นรูปแบบ Gemini
    const contents = messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: String(m.text || '') }],
    }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
    const toolCalls = [];

    // วนจนกว่า Gemini จะตอบข้อความ (จำกัด 6 รอบเครื่องมือ)
    for (let round = 0; round < 6; round++) {
      const body = {
        systemInstruction: { parts: [{ text: systemText }] },
        contents,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        // thinkingBudget 0 = ปิดโหมด "คิดก่อนตอบ" (เร็วขึ้น + กัน thought ภาษาอังกฤษหลุดมาในคำตอบ
        // และกันความคิดกินโควตา token จนคำตอบจริงถูกตัด)
        generationConfig: { temperature: 0.2, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
      };
      const gr = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const gj = await gr.json();
      if (!gr.ok) {
        const msg = gj?.error?.message || `Gemini HTTP ${gr.status}`;
        throw new Error(msg);
      }

      const parts = gj?.candidates?.[0]?.content?.parts || [];
      const fnCalls = parts.filter(p => p.functionCall);

      if (fnCalls.length === 0) {
        // ตัดส่วน "ความคิด" (thought) ของโมเดลออก เอาเฉพาะคำตอบจริง
        const text = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim() || '(ไม่มีคำตอบ)';
        return res.status(200).json({ text, toolCalls });
      }

      // มีการเรียกเครื่องมือ → รันแล้วส่งผลกลับ
      // ต้องส่ง parts กลับตามที่โมเดลส่งมาทั้งก้อน (รวม thoughtSignature) ไม่งั้นโมเดลรุ่นใหม่จะ error
      contents.push({ role: 'model', parts });
      const responses = [];
      for (const p of fnCalls) {
        const { name, args } = p.functionCall;
        toolCalls.push({ name, args });
        let result;
        try {
          const fn = TOOL_HANDLERS[name];
          result = fn ? await fn(args || {}) : { error: `ไม่รู้จักเครื่องมือ ${name}` };
        } catch (e) {
          result = { error: e.message };
        }
        // แนบ id กลับถ้าโมเดลส่งมา (Gemini 3.x ผูกคำตอบเครื่องมือกับ id ของ functionCall)
        const fr = { name, response: { result } };
        if (p.functionCall.id) fr.id = p.functionCall.id;
        responses.push({ functionResponse: fr });
      }
      contents.push({ role: 'user', parts: responses });
    }

    return res.status(200).json({ text: 'ขออภัย คำถามนี้ซับซ้อนเกินไป (เรียกข้อมูลหลายรอบเกินกำหนด) ลองแบ่งถามเป็นส่วนย่อยครับ', toolCalls });
  } catch (err) {
    console.error('AI chat error:', err.message);
    return res.status(502).json({ error: err.message });
  }
}
