import React, { useState, useMemo, useCallback } from 'react';
import {
  TrendingUp, Receipt, Layers, DollarSign, Search, Download, X, Eye, History, FileText,
  Loader2, AlertCircle, RefreshCw, Store, Users, CreditCard, Wallet, ChevronLeft, ChevronRight,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import * as XLSX from 'xlsx';

/*
 * NARAI OFFICE — เมนู "เฟรนไชส์" (ร้านเฟรนไชส์)
 *
 * ข้อมูลมาจากฐาน "Aoringo" บน SQL Server 203.154.185.48 (เครื่องเดียวกับ InventoryNarai)
 * ผ่าน /api/franchise ซึ่งลองต่อ SQL ตรงก่อนแล้วถอยไป host API ให้เอง (ดู lib/aoringoSource.js)
 *
 * ห้าหน้าย่อยใช้ข้อมูลชุดเดียวกัน (บิล + รายการสินค้า + รายจ่าย ของช่วงวันที่ที่เลือก)
 * จึงโหลดครั้งเดียวแล้วสลับหน้าได้เลย ไม่ต้องยิงใหม่ทุกครั้ง — index.js เรนเดอร์คอมโพเนนต์นี้
 * ตัวเดียวสำหรับทั้ง 5 เมนู (เปลี่ยนแค่ prop view) state ที่โหลดไว้จึงไม่หายตอนสลับเมนู
 *
 * ⚠️ ชื่อคอลัมน์ของฐาน Aoringo ไม่ได้เหมือน NaraiPos เสมอไป ฝั่ง API จับคู่คอลัมน์ให้ตอนรัน
 *    แล้วส่งมาด้วยชื่อกลางชุดนี้ (billTotal/quantity/itemName/...) ช่องที่ฐานไม่มีจะเป็น null
 *    ตรงไหนขึ้นว่างทั้งคอลัมน์ ให้ดูที่ /api/franchise?view=schema ว่าจับคู่ไปที่คอลัมน์ไหน
 */

/* ── สีของเมนูนี้: เขียว (คนละสีกับเมนูเดิมที่เป็นเหลืองอำพัน) ── */
const CHART_COLORS = ['#059669', '#10b981', '#34d399', '#6ee7b7', '#0d9488', '#14b8a6', '#5eead4', '#84cc16', '#a3e635', '#facc15'];

const num = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const money = (v) => num(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = (v) => Math.round(num(v)).toLocaleString('th-TH');
const qtyFmt = (v) => {
  const n = num(v);
  return Number.isInteger(n) ? n.toLocaleString('th-TH') : n.toLocaleString('th-TH', { maximumFractionDigits: 3 });
};

const dayOf = (v) => str(v).slice(0, 10);
const timeOf = (v) => str(v).slice(11, 16);

/** บิลที่ถูกยกเลิก — ฐานแต่ละที่เก็บไม่เหมือนกัน (1 / true / 'Y' / 'Void' / 'Cancelled')
 *  ต้องเป็น "ใช่" แบบชัดเจนเท่านั้นถึงจะตัดออก: ถ้าคอลัมน์ที่จับคู่มาเป็นสถานะข้อความ
 *  (Paid / Completed / Open) แล้วเหมาว่าข้อความไหนก็คือยกเลิก ยอดขายจะกลายเป็นศูนย์ทั้งหน้า */
const isVoid = (r) => {
  const v = r?.voided;
  if (v === null || v === undefined || v === '') return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'y', 'yes', 'void', 'voided'].includes(s)) return true;
  return /void|cancel|refund|ยกเลิก|คืนเงิน/.test(s);
};

/** ยอดของบิล — บางฐานเก็บยอดสุทธิที่ billTotal บางฐานที่ amount */
const billAmount = (r) => num(r.billTotal) || num(r.amount);

/** ยอดของรายการสินค้า 1 บรรทัด — ไม่มียอดรวมบรรทัดก็คิดจาก ราคา × จำนวน */
const lineAmount = (r) => num(r.grossPrice) || num(r.unitPrice) * num(r.quantity);

/** ช่องทางชำระเงินที่หน้านี้แจกแจง (ช่องไหนฐานไม่มีจะเป็น 0 ทั้งคอลัมน์ → ซ่อนทิ้งตอนแสดงผล) */
const CHANNELS = [
  { key: 'cash', label: 'เงินสด' },
  { key: 'credit', label: 'บัตรเครดิต' },
  { key: 'qr', label: 'QR / โอน' },
  { key: 'qrCredit', label: 'QR Credit' },
  { key: 'alipay', label: 'Alipay' },
  { key: 'weChat', label: 'WeChat' },
  { key: 'voucher', label: 'Voucher' },
  { key: 'oc', label: 'OC' },
  { key: 'delivery', label: 'เดลิเวอรี' },
];

/* ช่องของรายจ่ายที่ "มีก็ดี ไม่มีก็ได้" — ฐาน Aoringo เก็บ จำนวน/หน่วย/ราคาต่อหน่วย
   ส่วนฐานอื่นอาจเก็บผู้ขาย/เลขที่เอกสารแทน โชว์เฉพาะช่องที่มีข้อมูลจริงจะได้ไม่มีคอลัมน์ขีดกลางเปล่า ๆ */
const EXPENSE_OPTIONAL_COLS = [
  { key: 'quantity', label: 'จำนวน', align: 'right', render: (v) => qtyFmt(v) },
  { key: 'unit', label: 'หน่วย' },
  { key: 'unitPrice', label: 'ราคา/หน่วย', align: 'right', render: (v) => `฿${money(v)}` },
  { key: 'vendor', label: 'ผู้ขาย/ร้านค้า' },
  { key: 'ref', label: 'เลขที่เอกสาร' },
  { key: 'payType', label: 'ชำระโดย' },
  { key: 'user', label: 'ผู้บันทึก' },
];
const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== '';

/* ช่องของ "ประวัติออเดอร์" ที่มีก็โชว์ ไม่มีก็ซ่อน — ตาราง OrderActivity แต่ละเวอร์ชันเก็บไม่เท่ากัน
   (บางที่ log แค่ประเภท+ข้อความ บางที่ log เมนู/จำนวน/ยอดของทุกความเคลื่อนไหวด้วย)
   ถ้าโชว์หมดทุกช่องจะได้คอลัมน์ขีดกลางเปล่า ๆ เต็มไปหมด */
const ACTIVITY_OPTIONAL_COLS = [
  { key: 'itemName', label: 'เมนู' },
  { key: 'quantity', label: 'จำนวน', align: 'right', render: (v) => qtyFmt(v) },
  { key: 'amount', label: 'ยอด', align: 'right', render: (v) => `฿${money(v)}` },
  { key: 'user', label: 'ผู้ทำรายการ' },
];

/* ประเภทออร์เดอร์ — ฐาน Aoringo เก็บเป็นข้อความใน SaleOrder.OrderType ซึ่งแต่ละที่เขียนไม่เหมือนกัน
   (DineIn / Dine-in / ทานที่ร้าน / TakeAway / กลับบ้าน / Delivery / Grab …)
   อะไรที่ไม่ใช่ "กลับบ้าน" หรือ "เดลิเวอรี" นับเป็นทานที่ร้าน — ตรงกับที่เมนู ACC ทำกับโต๊ะ 300/400/401 */
// ชื่อช่องขึ้นต้นด้วย type… เพราะ "delivery" ชนกับช่องทางจ่ายชื่อเดียวกัน
// (ถ้าใช้ชื่อซ้ำ ยอดขายแบบเดลิเวอรีกับยอดที่จ่ายผ่านเดลิเวอรีจะบวกทับกันในช่องเดียว)
const orderBucket = (b) => {
  const t = `${str(b.orderType)} ${str(b.tableId)}`.toLowerCase();
  if (/deliver|grab|line ?man|shopee|robinhood|panda|ส่ง|เดลิ/.test(t)) return 'typeDelivery';
  if (/take.?away|take.?home|to.?go|กลับบ้าน|กลับ|ห่อ|takeout/.test(t)) return 'typeTakeHome';
  return 'typeDineIn';
};

/* คอลัมน์ตารางยอดขายรายวัน — ทรงเดียวกับ "ยอดรายวัน" ของเมนู ACC (pages/index.js: DAILY_COLUMNS)
   ต่างกันเฉพาะช่องที่ฐานเฟรนไชส์ไม่มี (ต้นทุน/บุฟเฟต์รายไอเทม) และมีรายจ่ายของวันนั้นเพิ่มมาแทน
   ช่องทางจ่ายไม่ได้ fix ไว้ตายตัวเหมือน ACC — เติมตามช่องที่ฐานนั้นมียอดจริง (ดู usedChannels) */
const FC_DAILY_FIXED_HEAD = [
  { key: 'date', label: 'วันที่', type: 'text' },
  { key: 'typeDineIn', label: 'Dine-in', type: 'money', drill: 'typeDineIn' },
  { key: 'typeTakeHome', label: 'Take-Home', type: 'money', drill: 'typeTakeHome' },
  { key: 'typeDelivery', label: 'Delivery', type: 'money', drill: 'typeDelivery' },
  { key: 'serviceChg', label: 'Service Charge', type: 'money' },
  { key: 'discount', label: 'ส่วนลด', type: 'money' },
  { key: 'netSales', label: 'Net Sales', type: 'money', tone: 'emerald' },
  { key: 'vat', label: 'Vat', type: 'money', tone: 'muted' },
  { key: 'grossSales', label: 'Gross Sales', type: 'money', tone: 'brand', drill: 'all' },
];
const FC_DAILY_FIXED_TAIL = [
  { key: 'totalSales', label: 'Total Sales', type: 'money', tone: 'brand', drill: 'all' },
  { key: 'billCount', label: 'ผลรวมบิล', type: 'number', drill: 'all' },
  { key: 'cover', label: 'จำนวนหัว', type: 'number' },
  { key: 'avgPerBill', label: 'เฉลี่ย/บิล', type: 'money' },
  { key: 'avgPerCover', label: 'เฉลี่ย/หัว', type: 'money' },
  { key: 'expense', label: 'รายจ่าย', type: 'money', tone: 'rose' },
];

const todayISO = () => new Date().toISOString().slice(0, 10);
const firstOfMonthISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

/** ดาวน์โหลดตารางเป็น Excel (คอลัมน์ตามหัวตารางที่เห็นบนหน้าจอ) */
function exportRows(rows, sheetName, fileName) {
  if (!rows.length) return;
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, fileName);
}

/* ── ชิ้นส่วนหน้าตาที่ใช้ซ้ำ ─────────────────────────────────────────── */

function StatCard({ icon: Icon, label, value, sub, tone = 'emerald' }) {
  const tones = {
    emerald: 'bg-emerald-50 text-emerald-600',
    teal: 'bg-teal-50 text-teal-600',
    slate: 'bg-slate-100 text-slate-600',
    rose: 'bg-rose-50 text-rose-600',
  };
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">{label}</p>
          <p className="mt-2 text-2xl font-bold text-slate-800 truncate">{value}</p>
          {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
        </div>
        <div className={`flex items-center justify-center w-10 h-10 rounded-xl flex-shrink-0 ${tones[tone] || tones.emerald}`}>
          <Icon size={18} />
        </div>
      </div>
    </div>
  );
}

function Empty({ children }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-2">
      <Store size={32} className="text-slate-300" />
      <p className="text-sm">{children}</p>
    </div>
  );
}

/** ตารางที่ยาวเกินหน้าจอ — แบ่งหน้าให้เบราว์เซอร์ไม่ต้องวาดหมื่นแถวพร้อมกัน */
function Pager({ page, pageCount, total, onPage }) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-xs text-slate-500">
      <span>ทั้งหมด {int(total)} แถว · หน้า {page + 1} / {pageCount}</span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPage(Math.max(0, page - 1))}
          disabled={page === 0}
          className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:border-emerald-400 hover:text-emerald-600 disabled:opacity-40"
        ><ChevronLeft size={14} /></button>
        <button
          onClick={() => onPage(Math.min(pageCount - 1, page + 1))}
          disabled={page >= pageCount - 1}
          className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:border-emerald-400 hover:text-emerald-600 disabled:opacity-40"
        ><ChevronRight size={14} /></button>
      </div>
    </div>
  );
}

const PAGE_SIZE = 200;

/* ── คอมโพเนนต์หลัก ─────────────────────────────────────────────────── */

export default function Franchise({ view = 'fcDashboard' }) {
  const [startDate, setStartDate] = useState(firstOfMonthISO());
  const [endDate, setEndDate] = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);      // { bills, items, expenses, activities, layout }
  const [meta, setMeta] = useState(null);      // { source, expenseError, activityError }
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [detailMode, setDetailMode] = useState('summary'); // 'summary' = สรุปตามเมนู · 'line' = รายบรรทัด
  const [dailySort, setDailySort] = useState({ col: 'date', asc: true });      // เรียงตารางรายวัน (กดหัวคอลัมน์)
  const [drill, setDrill] = useState({ open: false, title: '', rows: [] });    // บิลเบื้องหลังตัวเลขที่กด
  const [reportSort, setReportSort] = useState({ col: 'date', asc: true });   // เรียงตารางรายงานยอดขาย
  const [billModal, setBillModal] = useState({ open: false, bill: null, lines: [] });  // ดูบิล (รายการในบิลนั้น)
  const [activityModal, setActivityModal] = useState({ open: false, bill: null });     // ประวัติออเดอร์

  const load = useCallback(async () => {
    if (!startDate || !endDate) { setError('กรุณาเลือกวันที่เริ่มต้นและสิ้นสุด'); return; }
    if (startDate > endDate) { setError('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/franchise?view=all&start=${startDate}&end=${endDate}`, { cache: 'no-store' });
      const json = await res.json().catch(() => ({ status: 'error', message: `เซิร์ฟเวอร์ตอบไม่ใช่ JSON (HTTP ${res.status})` }));
      if (!res.ok || json.status !== 'success') throw new Error(json.message || `HTTP ${res.status}`);
      setData(json.data);
      setMeta(json.meta || null);
      setPage(0);
    } catch (err) {
      setError(err.message || 'โหลดข้อมูลไม่สำเร็จ');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  const applyThisMonth = () => { setStartDate(firstOfMonthISO()); setEndDate(todayISO()); };
  const applyLastMonth = () => {
    const d = new Date();
    const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const last = new Date(d.getFullYear(), d.getMonth(), 0);
    const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    setStartDate(iso(first)); setEndDate(iso(last));
  };
  const applyToday = () => { setStartDate(todayISO()); setEndDate(todayISO()); };

  /* ── ตัวเลขที่ทุกหน้าย่อยใช้ร่วมกัน ── */
  const bills = useMemo(() => (data?.bills || []).filter((b) => !isVoid(b)), [data]);
  const items = useMemo(() => (data?.items || []).filter((i) => !isVoid(i)), [data]);
  const expenses = useMemo(() => data?.expenses || [], [data]);
  // ประวัติออเดอร์ไม่กรองบิลที่ยกเลิกออก — "ยกเลิกเมื่อไหร่ ใครยกเลิก" คือสิ่งที่คนเปิดหน้านี้มาหา
  const activities = useMemo(() => data?.activities || [], [data]);

  const summary = useMemo(() => {
    const sales = bills.reduce((s, b) => s + billAmount(b), 0);
    const cover = bills.reduce((s, b) => s + num(b.cover), 0);
    const vat = bills.reduce((s, b) => s + num(b.vat), 0);
    const discount = bills.reduce((s, b) => s + num(b.discount), 0);
    const expense = expenses.reduce((s, e) => s + num(e.amount), 0);
    const qty = items.reduce((s, i) => s + num(i.quantity), 0);
    const days = new Set(bills.map((b) => dayOf(b.date)).filter(Boolean)).size;
    return {
      sales, cover, vat, discount, expense, qty, days,
      billCount: bills.length,
      avgPerBill: bills.length ? sales / bills.length : 0,
      avgPerCover: cover ? sales / cover : 0,
      avgPerDay: days ? sales / days : 0,
      net: sales - expense,
    };
  }, [bills, items, expenses]);

  /** ยอดรายวัน — ตัวตั้งของทั้งหน้า "ยอดขายรายวัน" และกราฟบนแดชบอร์ด */
  const daily = useMemo(() => {
    const blank = (d) => ({
      date: d, billCount: 0, cover: 0, sales: 0, vat: 0, discount: 0, serviceChg: 0,
      typeDineIn: 0, typeTakeHome: 0, typeDelivery: 0,
      ...Object.fromEntries(CHANNELS.map((c) => [c.key, 0])),
    });
    const map = new Map();
    bills.forEach((b) => {
      const d = dayOf(b.date);
      if (!d) return;
      if (!map.has(d)) map.set(d, blank(d));
      const row = map.get(d);
      const amt = billAmount(b);
      row.billCount += 1;
      row.cover += num(b.cover);
      row.sales += amt;
      row.vat += num(b.vat);
      row.discount += num(b.discount);
      row.serviceChg += num(b.serviceChg);
      row[orderBucket(b)] += amt;            // Dine-in / Take-Home / Delivery แบบเดียวกับ ACC
      CHANNELS.forEach((c) => { row[c.key] += num(b[c.key]); });
    });
    const expByDay = new Map();
    expenses.forEach((e) => {
      const d = dayOf(e.date);
      if (!d) return;
      expByDay.set(d, (expByDay.get(d) || 0) + num(e.amount));
    });
    // วันที่มีแต่รายจ่าย (ไม่มีบิลขาย) ก็ต้องมีแถวของตัวเอง ไม่งั้นยอดรายจ่ายรวมจะไม่ตรงกับหน้ารายจ่าย
    expByDay.forEach((v, d) => { if (!map.has(d)) map.set(d, blank(d)); });

    return [...map.values()]
      .map((r) => {
        // ยอดที่เก็บเงินได้จริงจากทุกช่องทาง — ACC เรียกช่องนี้ว่า Total Sales และใช้เทียบกับ Gross
        // ฐานไหนไม่มีตารางการชำระเงินให้ตกมาใช้ยอดบิล จะได้ไม่เห็นเป็น 0 ทั้งคอลัมน์
        const channelSum = CHANNELS.reduce((s, c) => s + num(r[c.key]), 0);
        return {
          ...r,
          grossSales: r.sales,                      // ยอดบิลรวม (รวม VAT แล้ว)
          netSales: r.sales - num(r.vat),           // ยอดก่อน VAT
          totalSales: channelSum > 0 ? channelSum : r.sales,
          expense: expByDay.get(r.date) || 0,
          avgPerBill: r.billCount ? r.sales / r.billCount : 0,
          avgPerCover: r.cover ? r.sales / r.cover : 0,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [bills, expenses]);

  /** ช่องทางชำระเงินที่ฐานนี้มีข้อมูลจริง — ช่องที่เป็น 0 ทั้งคอลัมน์ไม่ต้องเอามารก */
  const channelTotals = useMemo(() => {
    const totals = CHANNELS.map((c) => ({ ...c, value: bills.reduce((s, b) => s + num(b[c.key]), 0) }));
    const used = totals.filter((t) => t.value > 0);
    // ไม่มีคอลัมน์ช่องทางจ่ายเลย → ถอยไปแจกแจงตาม PaidType ซึ่งเกือบทุก POS มี
    if (!used.length) {
      const byType = new Map();
      bills.forEach((b) => {
        const k = str(b.paidType) || 'ไม่ระบุ';
        byType.set(k, (byType.get(k) || 0) + billAmount(b));
      });
      return [...byType.entries()].map(([label, value]) => ({ key: label, label, value }))
        .filter((t) => t.value > 0).sort((a, b) => b.value - a.value);
    }
    // ยอดที่ไม่เข้าช่องไหนเลย (บิลที่ POS ไม่ได้ลงยอดในช่อง) — โชว์เป็น "อื่นๆ" ให้ผลรวมตรงกับยอดขาย
    const rest = summary.sales - used.reduce((s, t) => s + t.value, 0);
    if (rest > 1) used.push({ key: '_rest', label: 'อื่นๆ / ไม่ระบุช่องทาง', value: rest });
    return used.sort((a, b) => b.value - a.value);
  }, [bills, summary.sales]);

  const usedChannels = useMemo(
    () => CHANNELS.filter((c) => bills.some((b) => num(b[c.key]) !== 0)),
    [bills]
  );

  /** สรุปตามเมนู — ใช้ทั้งกราฟ "เมนูขายดี" และหน้า "รายละเอียดการขาย" โหมดสรุป */
  const byMenu = useMemo(() => {
    const map = new Map();
    items.forEach((i) => {
      const key = str(i.itemCode) || str(i.itemName) || '-';
      if (!map.has(key)) {
        map.set(key, {
          itemCode: str(i.itemCode), itemName: str(i.itemName), groupName: str(i.groupName),
          quantity: 0, amount: 0, lines: 0,
        });
      }
      const row = map.get(key);
      if (!row.itemName) row.itemName = str(i.itemName);
      if (!row.groupName) row.groupName = str(i.groupName);
      row.quantity += num(i.quantity);
      row.amount += lineAmount(i);
      row.lines += 1;
    });
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }, [items]);

  const expenseCols = useMemo(
    () => EXPENSE_OPTIONAL_COLS.filter((c) => expenses.some((e) => hasValue(e[c.key]))),
    [expenses]
  );

  const byExpenseCategory = useMemo(() => {
    const map = new Map();
    expenses.forEach((e) => {
      const k = str(e.category) || 'ไม่ระบุประเภท';
      map.set(k, (map.get(k) || 0) + num(e.amount));
    });
    return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }, [expenses]);

  /* ── ตัวกรองคำค้นของหน้าที่เป็นตารางยาว ── */
  const kw = search.trim().toLowerCase();
  const matches = useCallback((fields) => !kw || fields.some((f) => str(f).toLowerCase().includes(kw)), [kw]);

  const filteredBills = useMemo(
    () => (!kw ? bills : bills.filter((b) => matches([b.checkId, b.tableId, b.cashier, b.paidType, b.orderType, b.status, b.memberTel, b.note, dayOf(b.date)]))),
    [bills, kw, matches]
  );
  const filteredItems = useMemo(
    () => (!kw ? items : items.filter((i) => matches([i.itemCode, i.itemName, i.groupName, i.checkId, i.tableId, i.waiter, dayOf(i.date)]))),
    [items, kw, matches]
  );
  const filteredMenu = useMemo(
    () => (!kw ? byMenu : byMenu.filter((m) => matches([m.itemCode, m.itemName, m.groupName]))),
    [byMenu, kw, matches]
  );
  const filteredExpenses = useMemo(
    () => (!kw ? expenses : expenses.filter((e) => matches([e.category, e.detail, e.vendor, e.ref, e.payType, e.user, dayOf(e.date)]))),
    [expenses, kw, matches]
  );

  const pageCount = (rows) => Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // หน้าที่กำลังดูอยู่ต้องไม่เกินจำนวนหน้าของตารางตรงหน้า — สลับหน้าย่อย/พิมพ์คำค้นแล้วแถวเหลือน้อยลง
  // ถ้าไม่หนีบไว้จะค้างอยู่หน้าที่ไม่มีแถวเลย (ตารางว่างทั้งที่ข้อมูลมี)
  const clampPage = (rows) => Math.min(page, pageCount(rows) - 1);
  const paged = (rows) => {
    const p = clampPage(rows);
    return rows.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
  };

  const loaded = Boolean(data);
  const rangeLabel = `${startDate}_${endDate}`;

  /* ── แผงกรองด้านบน (ทุกหน้าย่อยใช้ร่วมกัน) ── */
  const filterPanel = (
    <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-[11px] font-semibold text-slate-400">เลือกด่วน:</span>
        {[['วันนี้', applyToday], ['เดือนนี้', applyThisMonth], ['เดือนที่แล้ว', applyLastMonth]].map(([label, fn]) => (
          <button
            key={label}
            onClick={fn}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 text-slate-600 hover:border-emerald-400 hover:text-emerald-600 disabled:opacity-50 transition-colors"
          >{label}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">วันที่เริ่มต้น</label>
          <input
            type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-400"
          />
        </div>
        <div>
          <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">วันที่สิ้นสุด</label>
          <input
            type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
            className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-400"
          />
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
          {loading ? 'กำลังโหลด...' : 'ค้นหาข้อมูล'}
        </button>
        {loaded && (
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-200 text-slate-600 hover:border-emerald-400 hover:text-emerald-600 disabled:opacity-50 transition-colors"
          ><RefreshCw size={14} /> โหลดใหม่</button>
        )}
      </div>
      {loaded && (
        <p className="mt-3 text-[11px] text-slate-400">
          ฐานข้อมูล Aoringo · {int(bills.length)} บิล · {int(items.length)} รายการสินค้า · {int(expenses.length)} รายจ่าย
          {meta?.source ? ` · ที่มา: ${meta.source}` : ''}
        </p>
      )}
    </div>
  );

  const searchBox = (placeholder) => (
    <div className="relative">
      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
      <input
        value={search}
        onChange={(e) => { setSearch(e.target.value); setPage(0); }}
        placeholder={placeholder}
        className="pl-9 pr-3 py-2 w-64 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-400"
      />
    </div>
  );

  const exportBtn = (onClick, disabled) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg border border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-40 transition-colors"
    ><Download size={14} /> ส่งออก Excel</button>
  );

  const sectionHead = (icon, title, right) => (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-slate-100">
      <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800">{icon}{title}</h3>
      <div className="flex flex-wrap items-center gap-2">{right}</div>
    </div>
  );

  /* ── หน้าย่อย 1: แดชบอร์ด ── */
  const dashboardView = (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard icon={TrendingUp} label="ยอดขายรวม" value={`฿${money(summary.sales)}`} sub={`${int(summary.days)} วันที่มีการขาย`} />
        <StatCard icon={Receipt} label="จำนวนบิล" value={int(summary.billCount)} sub={`เฉลี่ย ฿${money(summary.avgPerBill)} / บิล`} tone="teal" />
        <StatCard icon={Users} label="จำนวนลูกค้า" value={int(summary.cover)} sub={summary.cover ? `เฉลี่ย ฿${money(summary.avgPerCover)} / คน` : 'ฐานนี้ไม่มีข้อมูลจำนวนลูกค้า'} tone="slate" />
        <StatCard icon={Wallet} label="รายจ่าย" value={`฿${money(summary.expense)}`} sub={`คงเหลือ ฿${money(summary.net)}`} tone="rose" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 bg-white border border-slate-100 rounded-2xl shadow-sm">
          {sectionHead(<TrendingUp size={16} className="text-emerald-600" />, 'ยอดขายรายวัน')}
          <div className="h-72 p-4">
            {daily.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={daily} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fcSales" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#059669" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#059669" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d) => d.slice(5)} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => int(v)} width={70} />
                  <Tooltip formatter={(v, n) => [`฿${money(v)}`, n === 'sales' ? 'ยอดขาย' : 'รายจ่าย']} labelFormatter={(d) => `วันที่ ${d}`} />
                  <Area type="monotone" dataKey="sales" stroke="#059669" strokeWidth={2} fill="url(#fcSales)" name="sales" />
                </AreaChart>
              </ResponsiveContainer>
            ) : <Empty>ยังไม่มีข้อมูลยอดขายในช่วงที่เลือก</Empty>}
          </div>
        </div>

        <div className="bg-white border border-slate-100 rounded-2xl shadow-sm">
          {sectionHead(<CreditCard size={16} className="text-emerald-600" />, 'ช่องทางการชำระเงิน')}
          <div className="h-72 p-4">
            {channelTotals.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={channelTotals} dataKey="value" nameKey="label" innerRadius={45} outerRadius={80} paddingAngle={2}>
                    {channelTotals.map((c, i) => <Cell key={c.key} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v) => `฿${money(v)}`} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            ) : <Empty>ไม่มีข้อมูลช่องทางการชำระเงิน</Empty>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-100 rounded-2xl shadow-sm">
          {sectionHead(<Layers size={16} className="text-emerald-600" />, 'เมนูขายดี 10 อันดับ (ตามยอดขาย)')}
          <div className="h-80 p-4">
            {byMenu.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byMenu.slice(0, 10)} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => int(v)} />
                  <YAxis type="category" dataKey="itemName" tick={{ fontSize: 10 }} width={130}
                    tickFormatter={(v) => (String(v).length > 18 ? `${String(v).slice(0, 18)}…` : v)} />
                  <Tooltip formatter={(v) => `฿${money(v)}`} />
                  <Bar dataKey="amount" fill="#10b981" radius={[0, 4, 4, 0]} name="ยอดขาย" />
                </BarChart>
              </ResponsiveContainer>
            ) : <Empty>ยังไม่มีรายการสินค้าในช่วงที่เลือก</Empty>}
          </div>
        </div>

        <div className="bg-white border border-slate-100 rounded-2xl shadow-sm">
          {sectionHead(<Wallet size={16} className="text-emerald-600" />, 'รายจ่ายตามประเภท')}
          <div className="p-4">
            {byExpenseCategory.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">ประเภท</th>
                      <th className="px-3 py-2 text-right font-semibold">จำนวนเงิน</th>
                      <th className="px-3 py-2 text-right font-semibold">% ของรายจ่าย</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {byExpenseCategory.map((c) => (
                      <tr key={c.label} className="hover:bg-emerald-50/40">
                        <td className="px-3 py-2 text-slate-700">{c.label}</td>
                        <td className="px-3 py-2 text-right font-semibold text-slate-800">฿{money(c.value)}</td>
                        <td className="px-3 py-2 text-right text-slate-500">
                          {summary.expense ? `${((c.value / summary.expense) * 100).toFixed(1)}%` : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-50 font-bold text-slate-800">
                    <tr>
                      <td className="px-3 py-2">รวม</td>
                      <td className="px-3 py-2 text-right">฿{money(summary.expense)}</td>
                      <td className="px-3 py-2 text-right">100%</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : <Empty>{meta?.expenseError ? 'ยังอ่านรายจ่ายจากฐานนี้ไม่ได้ (ดูรายละเอียดในหน้ารายจ่าย)' : 'ไม่มีรายจ่ายในช่วงที่เลือก'}</Empty>}
          </div>
        </div>
      </div>
    </div>
  );

  /* ── หน้าย่อย 2: ยอดขายรายวัน (ทรงเดียวกับตาราง "ยอดรายวัน" ของเมนู ACC) ── */

  // คอลัมน์จริงของตาราง = ช่องคงที่ + ช่องทางจ่ายเท่าที่ฐานนี้มียอด + ช่องท้าย
  const dailyColumns = useMemo(() => [
    ...FC_DAILY_FIXED_HEAD,
    ...usedChannels.map((c) => ({ key: c.key, label: c.label, type: 'money', drill: `channel:${c.key}` })),
    ...FC_DAILY_FIXED_TAIL,
  ], [usedChannels]);

  const dailyRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = term ? daily.filter((r) => r.date.toLowerCase().includes(term)) : daily;
    const { col, asc } = dailySort;
    const sorted = [...list].sort((a, b) => {
      const x = a[col], y = b[col];
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return asc ? c : -c;
    });
    return sorted;
  }, [daily, search, dailySort]);

  /** ยอดรวมท้ายตาราง — รวมทุกช่องที่เป็นตัวเลข (ยกเว้นค่าเฉลี่ย ซึ่งต้องคิดจากยอดรวมอีกที) */
  const dailyTotals = useMemo(() => {
    const t = {};
    dailyColumns.forEach((c) => {
      if (c.type === 'money' || c.type === 'number') t[c.key] = dailyRows.reduce((s, r) => s + num(r[c.key]), 0);
    });
    t.avgPerBill = t.billCount ? t.grossSales / t.billCount : 0;
    t.avgPerCover = t.cover ? t.grossSales / t.cover : 0;
    return t;
  }, [dailyRows, dailyColumns]);

  /** กดตัวเลขในตาราง → เปิดดูบิลที่อยู่เบื้องหลังตัวเลขนั้น (เหมือนกดเซลล์ในตารางของ ACC) */
  const openDrill = (row, colDef) => {
    if (!colDef.drill) return;
    const sameDay = (b) => dayOf(b.date) === row.date;
    let fn = sameDay;
    let title = `${colDef.label} · ${row.date}`;
    if (colDef.drill.startsWith('channel:')) {
      const key = colDef.drill.slice(8);
      fn = (b) => sameDay(b) && num(b[key]) > 0;
    } else if (['typeDineIn', 'typeTakeHome', 'typeDelivery'].includes(colDef.drill)) {
      fn = (b) => sameDay(b) && orderBucket(b) === colDef.drill;
    } else {
      title = `บิลทั้งหมด · ${row.date}`;
    }
    setDrill({ open: true, title, rows: bills.filter(fn) });
  };

  const dailyExport = () => exportRows(
    dailyRows.map((r) => Object.fromEntries(dailyColumns.map((c) => [c.label, c.type === 'text' ? r[c.key] : num(r[c.key])]))),
    'ยอดขายรายวัน', `เฟรนไชส์_ยอดขายรายวัน_${rangeLabel}.xlsx`
  );

  const cellTone = {
    emerald: 'text-emerald-600 font-semibold',
    brand: 'text-emerald-700 font-bold',
    muted: 'text-slate-500',
    rose: 'text-rose-600',
  };

  const dailyView = (
    <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden flex flex-col">
      {sectionHead(
        <Receipt size={16} className="text-emerald-600" />,
        'ตารางรายงานยอดขายรายวัน',
        <>{searchBox('ค้นหาวันที่...')}{exportBtn(dailyExport, !dailyRows.length)}</>
      )}
      {daily.length ? (
        <>
          <div className="px-5 py-2 text-[11px] text-slate-400 border-b border-slate-100">
            พบบันทึกยอดขายรายวัน {int(dailyRows.length)} วัน · กดที่ตัวเลขในคอลัมน์ที่ขีดเส้นใต้ได้ เพื่อดูบิลที่อยู่เบื้องหลัง
          </div>
          <div className="overflow-auto max-h-[70vh] min-h-[320px] w-full">
            <table className="w-full text-left text-[11px] border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50 border-b border-slate-100 text-slate-600 font-bold">
                  {dailyColumns.map((c) => (
                    <th
                      key={c.key}
                      onClick={() => setDailySort((prev) => ({ col: c.key, asc: prev.col === c.key ? !prev.asc : c.type === 'text' }))}
                      className={`px-3 py-2.5 cursor-pointer hover:bg-slate-100 hover:text-emerald-600 transition-colors whitespace-nowrap ${c.type === 'text' ? 'text-left' : 'text-right'}`}
                    >
                      <div className={`flex items-center gap-0.5 ${c.type === 'text' ? '' : 'justify-end'}`}>
                        <span>{c.label}</span>
                        {dailySort.col === c.key && <span>{dailySort.asc ? '▲' : '▼'}</span>}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700 font-medium">
                {dailyRows.map((r) => (
                  <tr key={r.date} className="hover:bg-emerald-50/40 transition-colors">
                    {dailyColumns.map((c) => {
                      if (c.type === 'text') {
                        return <td key={c.key} className="px-3 py-2 whitespace-nowrap font-semibold text-slate-800">{r[c.key]}</td>;
                      }
                      const v = num(r[c.key]);
                      const text = c.type === 'number' ? int(v) : `฿${money(v)}`;
                      return (
                        <td key={c.key} className={`px-3 py-2 whitespace-nowrap text-right font-mono ${cellTone[c.tone] || 'text-slate-600'}`}>
                          {c.drill && v !== 0 ? (
                            <button onClick={() => openDrill(r, c)} className="hover:underline cursor-pointer">{text}</button>
                          ) : (v === 0 ? <span className="text-slate-300">-</span> : text)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0">
                <tr className="bg-emerald-50 border-t-2 border-emerald-500 font-bold text-slate-800">
                  {dailyColumns.map((c, i) => {
                    if (c.type === 'text') {
                      return <td key={c.key} className="px-3 py-2.5 whitespace-nowrap">{i === 0 ? `รวม ${int(dailyRows.length)} วัน` : ''}</td>;
                    }
                    const v = num(dailyTotals[c.key]);
                    return (
                      <td key={c.key} className={`px-3 py-2.5 text-right font-mono ${cellTone[c.tone] || 'text-slate-800'}`}>
                        {c.type === 'number' ? int(v) : `฿${money(v)}`}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      ) : <Empty>ยังไม่มีข้อมูล — เลือกช่วงวันที่แล้วกด &quot;ค้นหาข้อมูล&quot;</Empty>}
    </div>
  );

  /* ── หน้าย่อย: รายงานยอดขาย (รายบิล + ดูบิล + ประวัติออเดอร์) ──
     ทรงเดียวกับ "รายงานยอดการขาย" ของเมนู ACC ที่มีปุ่มดูบิลอยู่หน้าสุดของแต่ละแถว
     ต่างกันตรงที่ฐานเฟรนไชส์บันทึกความเคลื่อนไหวรายออเดอร์ไว้ที่ตาราง OrderActivity
     (เปิดออร์เดอร์ / สั่งเพิ่ม / แก้ไข / ยกเลิก / ชำระเงิน) จึงกดดู "ประวัติออเดอร์" ต่อได้ในคลิกเดียว */

  /** รายการสินค้าของแต่ละบิล — จับคู่ด้วย วันที่+เลขที่บิล เพราะเลขบิลของ POS มักวนใหม่ทุกวัน */
  const itemsByBill = useMemo(() => {
    const map = new Map();
    items.forEach((i) => {
      const k = `${dayOf(i.date)}|${str(i.checkId)}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(i);
    });
    return map;
  }, [items]);

  const openBill = (b) => setBillModal({
    open: true, bill: b, lines: itemsByBill.get(`${dayOf(b.date)}|${str(b.checkId)}`) || [],
  });
  // ปิดหน้าต่างบิลก่อนเสมอ — สองหน้าต่างนี้ z-index เท่ากัน เปิดทับกันแล้วอันหลังจะโดนบัง
  const openActivity = (b) => {
    setBillModal({ open: false, bill: null, lines: [] });
    setActivityModal({ open: true, bill: b });
  };
  const closeActivity = () => setActivityModal({ open: false, bill: null });

  /** ประวัติของแต่ละบิล — จับคู่ด้วย วันที่+เลขที่บิล ชุดเดียวกับรายการสินค้า
      (ฝั่ง API ส่ง orderDate ของบิลมาให้ในทุกแถว จึงจับคู่ได้ตรงแม้เลขบิลจะวนใหม่ทุกวัน) */
  const activityByBill = useMemo(() => {
    const map = new Map();
    activities.forEach((a) => {
      const k = `${dayOf(a.orderDate || a.date)}|${str(a.checkId)}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(a);
    });
    // เรียงเป็นไทม์ไลน์ เก่า→ใหม่ ในแต่ละออเดอร์
    map.forEach((rows) => rows.sort((x, y) => String(x.date).localeCompare(String(y.date))));
    return map;
  }, [activities]);

  const activityOf = (b) => (b ? activityByBill.get(`${dayOf(b.date)}|${str(b.checkId)}`) || [] : []);

  /** ความเคลื่อนไหวของออเดอร์ที่กำลังเปิดดู */
  const orderHistory = useMemo(
    () => (activityModal.open ? activityOf(activityModal.bill) : []),
    [activityModal, activityByBill]           // eslint-disable-line react-hooks/exhaustive-deps
  );

  const activityCols = useMemo(
    () => ACTIVITY_OPTIONAL_COLS.filter((c) => orderHistory.some((a) => hasValue(a[c.key]))),
    [orderHistory]                            // eslint-disable-line react-hooks/exhaustive-deps
  );

  const reportRows = useMemo(() => {
    const { col, asc } = reportSort;
    const val = (b) => (col === 'billTotal' ? billAmount(b)
      : col === 'cover' ? num(b.cover)
      : col === 'vat' ? num(b.vat)
      : str(b[col]));
    return [...filteredBills].sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return asc ? c : -c;
    });
  }, [filteredBills, reportSort]);

  const REPORT_COLUMNS = [
    { key: 'date', label: 'วันที่/เวลา', type: 'text' },
    { key: 'checkId', label: 'เลขที่บิล', type: 'text' },
    { key: 'tableId', label: 'โต๊ะ', type: 'text' },
    { key: 'orderType', label: 'ประเภท', type: 'text' },
    { key: 'cover', label: 'ลูกค้า', type: 'number' },
    { key: 'paidType', label: 'ชำระโดย', type: 'text' },
    { key: 'cashier', label: 'ผู้ทำรายการ', type: 'text' },
    { key: 'discount', label: 'ส่วนลด', type: 'money' },
    { key: 'vat', label: 'VAT', type: 'money' },
    { key: 'billTotal', label: 'ยอดรวมบิล', type: 'money' },
    { key: 'status', label: 'สถานะ', type: 'text' },
  ];

  const reportExport = () => exportRows(reportRows.map((b) => ({
    วันที่: dayOf(b.date), เวลา: timeOf(b.date), เลขที่บิล: str(b.checkId), โต๊ะ: str(b.tableId),
    ประเภท: str(b.orderType), ลูกค้า: num(b.cover), ชำระโดย: str(b.paidType), ผู้ทำรายการ: str(b.cashier),
    ส่วนลด: num(b.discount), VAT: num(b.vat), ยอดรวมบิล: billAmount(b), สถานะ: str(b.status),
    จำนวนรายการในบิล: (itemsByBill.get(`${dayOf(b.date)}|${str(b.checkId)}`) || []).length,
  })), 'รายงานยอดขาย', `เฟรนไชส์_รายงานยอดขาย_${rangeLabel}.xlsx`);

  const reportView = (
    <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden flex flex-col">
      {sectionHead(
        <FileText size={16} className="text-emerald-600" />,
        'รายงานยอดขาย',
        <>{searchBox('ค้นหาเลขที่บิล / โต๊ะ / ผู้ทำรายการ')}{exportBtn(reportExport, !reportRows.length)}</>
      )}
      {reportRows.length ? (
        <>
          <div className="px-5 py-2 text-[11px] text-slate-400 border-b border-slate-100">
            {int(reportRows.length)} บิล · รวม ฿{money(reportRows.reduce((t, b) => t + billAmount(b), 0))}
            {' '}· กด <b>ดูบิล</b> เพื่อดูรายการในบิล · กด <b>ประวัติออเดอร์</b> เพื่อดูความเคลื่อนไหวของออเดอร์นั้น
          </div>
          <div className="overflow-auto max-h-[70vh]">
            <table className="w-full text-left text-[11px] border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50 border-b border-slate-100 text-slate-600 font-bold">
                  <th className="px-3 py-2.5 whitespace-nowrap">ดูข้อมูล</th>
                  {REPORT_COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      onClick={() => setReportSort((prev) => ({ col: c.key, asc: prev.col === c.key ? !prev.asc : c.type === 'text' }))}
                      className={`px-3 py-2.5 cursor-pointer hover:bg-slate-100 hover:text-emerald-600 transition-colors whitespace-nowrap ${c.type === 'text' ? 'text-left' : 'text-right'}`}
                    >
                      <div className={`flex items-center gap-0.5 ${c.type === 'text' ? '' : 'justify-end'}`}>
                        <span>{c.label}</span>
                        {reportSort.col === c.key && <span>{reportSort.asc ? '▲' : '▼'}</span>}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {paged(reportRows).map((b, i) => (
                  <tr key={`${str(b.checkId)}-${i}`} className="hover:bg-emerald-50/40 transition-colors">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openBill(b)}
                          className="flex items-center gap-1 px-2 py-1 border border-emerald-200 hover:bg-emerald-50 text-emerald-700 font-semibold rounded-lg text-[10px] transition-colors"
                        ><Eye size={12} /><span>ดูบิล</span></button>
                        <button
                          onClick={() => openActivity(b)}
                          title={`ดูความเคลื่อนไหวของออเดอร์ ${str(b.checkId) || '-'} (${int(activityOf(b).length)} รายการ)`}
                          className="flex items-center gap-1 px-2 py-1 border border-slate-200 hover:bg-slate-50 text-slate-600 font-semibold rounded-lg text-[10px] transition-colors"
                        >
                          <History size={12} /><span>ประวัติออเดอร์</span>
                          {activityOf(b).length > 0 && (
                            <span className="px-1 rounded bg-slate-100 text-slate-500 font-mono">{int(activityOf(b).length)}</span>
                          )}
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{dayOf(b.date)} <span className="text-slate-400">{timeOf(b.date)}</span></td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono font-semibold text-slate-800">{str(b.checkId) || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{str(b.tableId) || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500">{str(b.orderType) || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-right font-mono">{b.cover === null ? '-' : int(b.cover)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600">{str(b.paidType) || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600">{str(b.cashier) || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-right font-mono text-slate-500">{num(b.discount) ? `฿${money(b.discount)}` : '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-right font-mono text-slate-500">{num(b.vat) ? `฿${money(b.vat)}` : '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-right font-mono font-bold text-emerald-700">฿{money(billAmount(b))}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {str(b.status) ? (
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${isVoid(b) ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}>
                          {str(b.status)}
                        </span>
                      ) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0">
                <tr className="bg-emerald-50 border-t-2 border-emerald-500 font-bold text-slate-800">
                  <td className="px-3 py-2.5" colSpan={5}>รวม {int(reportRows.length)} บิล{kw ? ' (ตามคำค้น)' : ''}</td>
                  <td className="px-3 py-2.5 text-right font-mono">{int(reportRows.reduce((t, b) => t + num(b.cover), 0))}</td>
                  <td className="px-3 py-2.5" colSpan={2} />
                  <td className="px-3 py-2.5 text-right font-mono">฿{money(reportRows.reduce((t, b) => t + num(b.discount), 0))}</td>
                  <td className="px-3 py-2.5 text-right font-mono">฿{money(reportRows.reduce((t, b) => t + num(b.vat), 0))}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-emerald-700">฿{money(reportRows.reduce((t, b) => t + billAmount(b), 0))}</td>
                  <td className="px-3 py-2.5" />
                </tr>
              </tfoot>
            </table>
          </div>
          <Pager page={clampPage(reportRows)} pageCount={pageCount(reportRows)} total={reportRows.length} onPage={setPage} />
        </>
      ) : <Empty>{loaded ? 'ไม่พบบิลตามเงื่อนไขที่เลือก' : 'ยังไม่มีข้อมูล — เลือกช่วงวันที่แล้วกด "ค้นหาข้อมูล"'}</Empty>}
    </div>
  );

  /* ── หน้าย่อย 3: รายการขาย (รายบิล) ── */
  const billsExport = () => exportRows(filteredBills.map((b) => ({
    วันที่: dayOf(b.date), เวลา: timeOf(b.date), เลขที่บิล: str(b.checkId), โต๊ะ: str(b.tableId),
    จำนวนลูกค้า: num(b.cover), ประเภทการชำระ: str(b.paidType), ประเภทออร์เดอร์: str(b.orderType),
    สถานะ: str(b.status), แคชเชียร์: str(b.cashier),
    ...Object.fromEntries(usedChannels.map((c) => [c.label, num(b[c.key])])),
    ส่วนลด: num(b.discount), VAT: num(b.vat), ยอดบิล: billAmount(b),
  })), 'รายการขาย', `เฟรนไชส์_รายการขาย_${rangeLabel}.xlsx`);

  const salesView = (
    <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden">
      {sectionHead(
        <TrendingUp size={16} className="text-emerald-600" />,
        'รายการขาย (รายบิล)',
        <>{searchBox('ค้นหาเลขที่บิล / โต๊ะ / แคชเชียร์')}{exportBtn(billsExport, !filteredBills.length)}</>
      )}
      {filteredBills.length ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs whitespace-nowrap">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2.5 text-left font-semibold">วันที่</th>
                  <th className="px-3 py-2.5 text-left font-semibold">เวลา</th>
                  <th className="px-3 py-2.5 text-left font-semibold">เลขที่บิล</th>
                  <th className="px-3 py-2.5 text-left font-semibold">โต๊ะ</th>
                  <th className="px-3 py-2.5 text-right font-semibold">ลูกค้า</th>
                  <th className="px-3 py-2.5 text-left font-semibold">ชำระโดย</th>
                  <th className="px-3 py-2.5 text-left font-semibold">ประเภท</th>
                  <th className="px-3 py-2.5 text-left font-semibold">สถานะ</th>
                  <th className="px-3 py-2.5 text-left font-semibold">แคชเชียร์</th>
                  <th className="px-3 py-2.5 text-right font-semibold">ส่วนลด</th>
                  <th className="px-3 py-2.5 text-right font-semibold">VAT</th>
                  <th className="px-3 py-2.5 text-right font-semibold">ยอดบิล</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paged(filteredBills).map((b, i) => (
                  <tr key={`${str(b.checkId)}-${i}`} className="hover:bg-emerald-50/40">
                    <td className="px-3 py-2 text-slate-600">{dayOf(b.date)}</td>
                    <td className="px-3 py-2 text-slate-500">{timeOf(b.date) || '-'}</td>
                    <td className="px-3 py-2 font-semibold text-slate-700">{str(b.checkId) || '-'}</td>
                    <td className="px-3 py-2 text-slate-600">{str(b.tableId) || '-'}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{b.cover === null ? '-' : int(b.cover)}</td>
                    <td className="px-3 py-2 text-slate-600">{str(b.paidType) || '-'}</td>
                    <td className="px-3 py-2 text-slate-500">{str(b.orderType) || '-'}</td>
                    <td className="px-3 py-2 text-slate-500">{str(b.status) || '-'}</td>
                    <td className="px-3 py-2 text-slate-600">{str(b.cashier) || '-'}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{num(b.discount) ? `฿${money(b.discount)}` : '-'}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{num(b.vat) ? `฿${money(b.vat)}` : '-'}</td>
                    <td className="px-3 py-2 text-right font-bold text-emerald-700">฿{money(billAmount(b))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-50 font-bold text-slate-800">
                <tr>
                  <td colSpan={11} className="px-3 py-2.5">รวม {int(filteredBills.length)} บิล{kw ? ' (ตามคำค้น)' : ''}</td>
                  <td className="px-3 py-2.5 text-right text-emerald-700">
                    ฿{money(filteredBills.reduce((s, b) => s + billAmount(b), 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <Pager page={clampPage(filteredBills)} pageCount={pageCount(filteredBills)} total={filteredBills.length} onPage={setPage} />
        </>
      ) : <Empty>{loaded ? 'ไม่พบบิลตามเงื่อนไขที่เลือก' : 'ยังไม่มีข้อมูล — เลือกช่วงวันที่แล้วกด "ค้นหาข้อมูล"'}</Empty>}
    </div>
  );

  /* ── หน้าย่อย 4: รายละเอียดการขาย (รายไอเทม) ── */
  const detailExport = () => {
    if (detailMode === 'summary') {
      exportRows(filteredMenu.map((m) => ({
        รหัสสินค้า: m.itemCode, ชื่อสินค้า: m.itemName, หมวด: m.groupName,
        จำนวนที่ขาย: m.quantity, จำนวนบรรทัด: m.lines, ยอดขาย: m.amount,
      })), 'สรุปตามเมนู', `เฟรนไชส์_รายละเอียดการขาย_สรุป_${rangeLabel}.xlsx`);
    } else {
      exportRows(filteredItems.map((i) => ({
        วันที่: dayOf(i.date), เวลา: timeOf(i.date), เลขที่บิล: str(i.checkId), โต๊ะ: str(i.tableId),
        รหัสสินค้า: str(i.itemCode), ชื่อสินค้า: str(i.itemName), หมวด: str(i.groupName),
        จำนวน: num(i.quantity), 'ราคา/หน่วย': num(i.unitPrice), ยอดรวม: lineAmount(i), พนักงาน: str(i.waiter),
      })), 'รายละเอียดการขาย', `เฟรนไชส์_รายละเอียดการขาย_${rangeLabel}.xlsx`);
    }
  };

  const detailRows = detailMode === 'summary' ? filteredMenu : filteredItems;

  const detailView = (
    <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden">
      {sectionHead(
        <Layers size={16} className="text-emerald-600" />,
        'รายละเอียดการขาย',
        <>
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-semibold">
            {[['summary', 'สรุปตามเมนู'], ['line', 'รายบรรทัด']].map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => { setDetailMode(mode); setPage(0); }}
                className={`px-3 py-2 transition-colors ${detailMode === mode ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
              >{label}</button>
            ))}
          </div>
          {searchBox('ค้นหาชื่อ/รหัสสินค้า หรือเลขที่บิล')}
          {exportBtn(detailExport, !detailRows.length)}
        </>
      )}
      {detailRows.length ? (
        <>
          <div className="overflow-x-auto">
            {detailMode === 'summary' ? (
              <table className="w-full text-xs whitespace-nowrap">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3 py-2.5 text-left font-semibold">รหัสสินค้า</th>
                    <th className="px-3 py-2.5 text-left font-semibold">ชื่อสินค้า</th>
                    <th className="px-3 py-2.5 text-left font-semibold">หมวด</th>
                    <th className="px-3 py-2.5 text-right font-semibold">จำนวนที่ขาย</th>
                    <th className="px-3 py-2.5 text-right font-semibold">ยอดขาย</th>
                    <th className="px-3 py-2.5 text-right font-semibold">% ของยอดขาย</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paged(filteredMenu).map((m) => (
                    <tr key={`${m.itemCode}-${m.itemName}`} className="hover:bg-emerald-50/40">
                      <td className="px-3 py-2 text-slate-500">{m.itemCode || '-'}</td>
                      <td className="px-3 py-2 font-semibold text-slate-700">{m.itemName || '-'}</td>
                      <td className="px-3 py-2 text-slate-500">{m.groupName || '-'}</td>
                      <td className="px-3 py-2 text-right text-slate-600">{qtyFmt(m.quantity)}</td>
                      <td className="px-3 py-2 text-right font-bold text-emerald-700">฿{money(m.amount)}</td>
                      <td className="px-3 py-2 text-right text-slate-500">
                        {summary.sales ? `${((m.amount / summary.sales) * 100).toFixed(1)}%` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 font-bold text-slate-800">
                  <tr>
                    <td colSpan={3} className="px-3 py-2.5">รวม {int(filteredMenu.length)} รายการ</td>
                    <td className="px-3 py-2.5 text-right">{qtyFmt(filteredMenu.reduce((s, m) => s + m.quantity, 0))}</td>
                    <td className="px-3 py-2.5 text-right text-emerald-700">฿{money(filteredMenu.reduce((s, m) => s + m.amount, 0))}</td>
                    <td className="px-3 py-2.5" />
                  </tr>
                </tfoot>
              </table>
            ) : (
              <table className="w-full text-xs whitespace-nowrap">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3 py-2.5 text-left font-semibold">วันที่</th>
                    <th className="px-3 py-2.5 text-left font-semibold">เวลา</th>
                    <th className="px-3 py-2.5 text-left font-semibold">เลขที่บิล</th>
                    <th className="px-3 py-2.5 text-left font-semibold">โต๊ะ</th>
                    <th className="px-3 py-2.5 text-left font-semibold">รหัส</th>
                    <th className="px-3 py-2.5 text-left font-semibold">ชื่อสินค้า</th>
                    <th className="px-3 py-2.5 text-right font-semibold">จำนวน</th>
                    <th className="px-3 py-2.5 text-right font-semibold">ราคา/หน่วย</th>
                    <th className="px-3 py-2.5 text-right font-semibold">ยอดรวม</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paged(filteredItems).map((i, idx) => (
                    <tr key={`${str(i.checkId)}-${str(i.itemCode)}-${idx}`} className="hover:bg-emerald-50/40">
                      <td className="px-3 py-2 text-slate-600">{dayOf(i.date)}</td>
                      <td className="px-3 py-2 text-slate-500">{timeOf(i.date) || '-'}</td>
                      <td className="px-3 py-2 text-slate-600">{str(i.checkId) || '-'}</td>
                      <td className="px-3 py-2 text-slate-500">{str(i.tableId) || '-'}</td>
                      <td className="px-3 py-2 text-slate-500">{str(i.itemCode) || '-'}</td>
                      <td className="px-3 py-2 font-semibold text-slate-700">{str(i.itemName) || '-'}</td>
                      <td className="px-3 py-2 text-right text-slate-600">{qtyFmt(i.quantity)}</td>
                      <td className="px-3 py-2 text-right text-slate-500">฿{money(i.unitPrice)}</td>
                      <td className="px-3 py-2 text-right font-bold text-emerald-700">฿{money(lineAmount(i))}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 font-bold text-slate-800">
                  <tr>
                    <td colSpan={6} className="px-3 py-2.5">รวม {int(filteredItems.length)} บรรทัด</td>
                    <td className="px-3 py-2.5 text-right">{qtyFmt(filteredItems.reduce((s, i) => s + num(i.quantity), 0))}</td>
                    <td className="px-3 py-2.5" />
                    <td className="px-3 py-2.5 text-right text-emerald-700">
                      ฿{money(filteredItems.reduce((s, i) => s + lineAmount(i), 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
          <Pager page={clampPage(detailRows)} pageCount={pageCount(detailRows)} total={detailRows.length} onPage={setPage} />
        </>
      ) : <Empty>{loaded ? 'ไม่พบรายการสินค้าตามเงื่อนไขที่เลือก' : 'ยังไม่มีข้อมูล — เลือกช่วงวันที่แล้วกด "ค้นหาข้อมูล"'}</Empty>}
    </div>
  );

  /* ── หน้าย่อย 5: รายจ่าย ── */
  const expenseExport = () => exportRows(filteredExpenses.map((e) => ({
    วันที่: dayOf(e.date), ประเภท: str(e.category), รายละเอียด: str(e.detail), ผู้ขาย: str(e.vendor),
    จำนวน: num(e.quantity), หน่วย: str(e.unit), 'ราคา/หน่วย': num(e.unitPrice),
    เลขที่เอกสาร: str(e.ref), ชำระโดย: str(e.payType), ผู้บันทึก: str(e.user), จำนวนเงิน: num(e.amount),
  })), 'รายจ่าย', `เฟรนไชส์_รายจ่าย_${rangeLabel}.xlsx`);

  const expenseView = (
    <div className="space-y-4">
      {meta?.expenseError && (
        <div className="p-4 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl text-xs flex items-start gap-2">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">ยังอ่านรายจ่ายจากฐาน Aoringo ไม่ได้ — ส่วนอื่นของเมนูนี้ยังใช้ได้ตามปกติ</p>
            <p className="mt-1 whitespace-pre-line">{meta.expenseError}</p>
            <p className="mt-1">
              ถ้าฐานนี้เก็บรายจ่ายไว้คนละชื่อกับที่เดาไว้ ให้เปิด <code className="px-1 bg-amber-100 rounded">/api/franchise?view=schema</code>{' '}
              ดูรายชื่อตารางทั้งหมด แล้วตั้ง env <code className="px-1 bg-amber-100 rounded">AORINGO_EXPENSE_TABLE</code> เป็นชื่อตารางที่ถูกต้อง
            </p>
          </div>
        </div>
      )}

      {loaded && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard icon={Wallet} label="รายจ่ายรวม" value={`฿${money(summary.expense)}`} sub={`${int(expenses.length)} รายการ`} tone="rose" />
          <StatCard icon={TrendingUp} label="ยอดขายรวม" value={`฿${money(summary.sales)}`} sub={`${int(summary.billCount)} บิล`} />
          <StatCard icon={DollarSign} label="ยอดขายหักรายจ่าย" value={`฿${money(summary.net)}`}
            sub={summary.sales ? `รายจ่ายคิดเป็น ${((summary.expense / summary.sales) * 100).toFixed(1)}% ของยอดขาย` : ''} tone="teal" />
        </div>
      )}

      <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden">
        {sectionHead(
          <DollarSign size={16} className="text-emerald-600" />,
          'รายจ่าย',
          <>{searchBox('ค้นหาประเภท / รายละเอียด / ผู้ขาย')}{exportBtn(expenseExport, !filteredExpenses.length)}</>
        )}
        {filteredExpenses.length ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs whitespace-nowrap">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3 py-2.5 text-left font-semibold">วันที่</th>
                    <th className="px-3 py-2.5 text-left font-semibold">ประเภท</th>
                    <th className="px-3 py-2.5 text-left font-semibold">รายละเอียด</th>
                    {expenseCols.map((c) => (
                      <th key={c.key} className={`px-3 py-2.5 font-semibold ${c.align === 'right' ? 'text-right' : 'text-left'}`}>{c.label}</th>
                    ))}
                    <th className="px-3 py-2.5 text-right font-semibold">จำนวนเงิน</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paged(filteredExpenses).map((e, i) => (
                    <tr key={`${str(e.ref)}-${i}`} className="hover:bg-emerald-50/40">
                      <td className="px-3 py-2 text-slate-600">{dayOf(e.date)}</td>
                      <td className="px-3 py-2 font-semibold text-slate-700">{str(e.category) || '-'}</td>
                      <td className="px-3 py-2 text-slate-600 whitespace-normal min-w-[16rem]">{str(e.detail) || '-'}</td>
                      {expenseCols.map((c) => (
                        <td key={c.key} className={`px-3 py-2 text-slate-500 ${c.align === 'right' ? 'text-right' : ''}`}>
                          {hasValue(e[c.key]) ? (c.render ? c.render(e[c.key]) : str(e[c.key])) : '-'}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-right font-bold text-rose-600">฿{money(e.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50 font-bold text-slate-800">
                  <tr>
                    <td colSpan={3 + expenseCols.length} className="px-3 py-2.5">รวม {int(filteredExpenses.length)} รายการ{kw ? ' (ตามคำค้น)' : ''}</td>
                    <td className="px-3 py-2.5 text-right text-rose-600">
                      ฿{money(filteredExpenses.reduce((s, e) => s + num(e.amount), 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <Pager page={clampPage(filteredExpenses)} pageCount={pageCount(filteredExpenses)} total={filteredExpenses.length} onPage={setPage} />
          </>
        ) : <Empty>{loaded ? 'ไม่มีรายจ่ายในช่วงที่เลือก' : 'ยังไม่มีข้อมูล — เลือกช่วงวันที่แล้วกด "ค้นหาข้อมูล"'}</Empty>}
      </div>
    </div>
  );

  const views = {
    fcDashboard: dashboardView,
    fcReport: reportView,
    fcDaily: dailyView,
    fcSales: salesView,
    fcDetail: detailView,
    fcExpense: expenseView,
  };

  return (
    <div className="space-y-6">
      {filterPanel}

      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-sm flex items-start gap-2">
          <AlertCircle size={18} className="flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">โหลดข้อมูลร้านเฟรนไชส์ไม่สำเร็จ</p>
            <p className="mt-1 whitespace-pre-line">{error}</p>
            <p className="mt-2 text-xs text-rose-600">
              ตรวจว่าขาไหนพังได้ที่ <code className="px-1 bg-rose-100 rounded">/api/franchise?view=diag</code>
            </p>
          </div>
        </div>
      )}

      {loading && !loaded && (
        <div className="flex items-center justify-center gap-2 py-16 text-slate-400">
          <Loader2 size={20} className="animate-spin" />
          <span className="text-sm">กำลังดึงข้อมูลจากฐาน Aoringo…</span>
        </div>
      )}

      {!loading && !loaded && !error && (
        <div className="bg-white border border-slate-100 rounded-2xl p-10 shadow-sm">
          <Empty>เลือกช่วงวันที่ด้านบนแล้วกด &quot;ค้นหาข้อมูล&quot; เพื่อดูข้อมูลร้านเฟรนไชส์</Empty>
        </div>
      )}

      {loaded && (views[view] || dashboardView)}

      {/* บิลเบื้องหลังตัวเลขที่กดในตารางรายวัน — แบบเดียวกับที่กดเซลล์ในตารางของเมนู ACC */}
      {drill.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => setDrill({ open: false, title: '', rows: [] })}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[80vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div>
                <h3 className="text-sm font-bold text-slate-800">{drill.title}</h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {int(drill.rows.length)} บิล · รวม ฿{money(drill.rows.reduce((s2, b) => s2 + billAmount(b), 0))}
                </p>
              </div>
              <button
                onClick={() => setDrill({ open: false, title: '', rows: [] })}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              ><X size={18} /></button>
            </div>
            <div className="overflow-auto">
              <table className="w-full text-[11px] whitespace-nowrap">
                <thead className="bg-slate-50 text-slate-500 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">เวลา</th>
                    <th className="px-3 py-2 text-left font-semibold">เลขที่บิล</th>
                    <th className="px-3 py-2 text-left font-semibold">โต๊ะ</th>
                    <th className="px-3 py-2 text-left font-semibold">ประเภท</th>
                    <th className="px-3 py-2 text-left font-semibold">ชำระโดย</th>
                    <th className="px-3 py-2 text-right font-semibold">ลูกค้า</th>
                    <th className="px-3 py-2 text-right font-semibold">ยอดบิล</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {drill.rows.map((b, i) => (
                    <tr key={`${str(b.checkId)}-${i}`} className="hover:bg-emerald-50/40">
                      <td className="px-3 py-2 text-slate-500">{timeOf(b.date) || '-'}</td>
                      <td className="px-3 py-2 font-semibold text-slate-700">{str(b.checkId) || '-'}</td>
                      <td className="px-3 py-2 text-slate-600">{str(b.tableId) || '-'}</td>
                      <td className="px-3 py-2 text-slate-500">{str(b.orderType) || '-'}</td>
                      <td className="px-3 py-2 text-slate-600">{str(b.paidType) || '-'}</td>
                      <td className="px-3 py-2 text-right text-slate-600">{b.cover === null ? '-' : int(b.cover)}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-emerald-700">฿{money(billAmount(b))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ประวัติออเดอร์ — ทุกความเคลื่อนไหวของออเดอร์นั้นจากตาราง OrderActivity */}
      {activityModal.open && activityModal.bill && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={closeActivity}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[80vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800">
                  <History size={16} className="text-emerald-600" />
                  ประวัติออเดอร์ {str(activityModal.bill.checkId) || '-'}
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {dayOf(activityModal.bill.date)} {timeOf(activityModal.bill.date)}
                  {str(activityModal.bill.tableId) && <> · โต๊ะ {str(activityModal.bill.tableId)}</>}
                  {str(activityModal.bill.orderType) && <> · {str(activityModal.bill.orderType)}</>}
                  {str(activityModal.bill.status) && <> · {str(activityModal.bill.status)}</>}
                  {' '}· ยอดบิล ฿{money(billAmount(activityModal.bill))}
                  {' '}· {int(orderHistory.length)} ความเคลื่อนไหว
                </p>
              </div>
              <button
                onClick={closeActivity}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              ><X size={18} /></button>
            </div>
            <div className="overflow-auto">
              {orderHistory.length ? (
                <table className="w-full text-[11px] whitespace-nowrap">
                  <thead className="bg-slate-50 text-slate-500 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">ลำดับ</th>
                      <th className="px-3 py-2 text-left font-semibold">วันที่</th>
                      <th className="px-3 py-2 text-left font-semibold">เวลา</th>
                      <th className="px-3 py-2 text-left font-semibold">รายการ</th>
                      <th className="px-3 py-2 text-left font-semibold">รายละเอียด</th>
                      {activityCols.map((c) => (
                        <th key={c.key} className={`px-3 py-2 font-semibold ${c.align === 'right' ? 'text-right' : 'text-left'}`}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {orderHistory.map((a, i) => (
                      <tr key={`${str(a.activityId)}-${i}`} className="hover:bg-emerald-50/40">
                        <td className="px-3 py-2 text-slate-400 font-mono">{i + 1}</td>
                        <td className="px-3 py-2 text-slate-600">{dayOf(a.date) || '-'}</td>
                        <td className="px-3 py-2 text-slate-500 font-mono">{timeOf(a.date) || '-'}</td>
                        <td className="px-3 py-2">
                          {str(a.activityType) ? (
                            <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-bold text-[10px]">
                              {str(a.activityType)}
                            </span>
                          ) : '-'}
                        </td>
                        <td className="px-3 py-2 text-slate-600 whitespace-pre-wrap break-words max-w-md">{str(a.detail) || '-'}</td>
                        {activityCols.map((c) => (
                          <td
                            key={c.key}
                            className={`px-3 py-2 text-slate-600 ${c.align === 'right' ? 'text-right font-mono' : ''}`}
                          >{hasValue(a[c.key]) ? (c.render ? c.render(a[c.key]) : str(a[c.key])) : '-'}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="px-5 py-10 text-center text-xs text-slate-400 space-y-2">
                  {meta?.activityError ? (
                    <>
                      <p className="font-semibold text-amber-700">ยังอ่านประวัติออเดอร์จากฐาน Aoringo ไม่ได้</p>
                      <p className="whitespace-pre-line text-amber-700/80 max-w-xl mx-auto">{meta.activityError}</p>
                    </>
                  ) : (
                    <p>ไม่พบความเคลื่อนไหวของออเดอร์นี้ในตาราง OrderActivity</p>
                  )}
                </div>
              )}
            </div>
            <div className="border-t border-slate-100 bg-slate-50 px-5 py-3 flex items-center justify-between text-[11px] text-slate-400">
              <span>ข้อมูลจากตาราง OrderActivity · ช่วง {data?.range?.start} ถึง {data?.range?.end}</span>
              <button
                onClick={() => { closeActivity(); openBill(activityModal.bill); }}
                className="flex items-center gap-1 px-2 py-1 border border-emerald-200 hover:bg-emerald-50 text-emerald-700 font-semibold rounded-lg text-[10px]"
              ><Eye size={12} /><span>ดูบิล</span></button>
            </div>
          </div>
        </div>
      )}

      {/* ดูบิล — หัวบิล + รายการในบิล + วิธีชำระ (ข้อมูลอยู่ในเครื่องแล้ว ไม่ต้องยิงถามฐานซ้ำ) */}
      {billModal.open && billModal.bill && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => setBillModal({ open: false, bill: null, lines: [] })}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-5 py-4 border-b border-slate-100">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800">
                  <Receipt size={16} className="text-emerald-600" /> บิลเลขที่ {str(billModal.bill.checkId) || '-'}
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {dayOf(billModal.bill.date)} {timeOf(billModal.bill.date)}
                  {str(billModal.bill.tableId) && <> · โต๊ะ {str(billModal.bill.tableId)}</>}
                  {str(billModal.bill.orderType) && <> · {str(billModal.bill.orderType)}</>}
                  {billModal.bill.cover !== null && <> · {int(billModal.bill.cover)} คน</>}
                  {str(billModal.bill.cashier) && <> · {str(billModal.bill.cashier)}</>}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => openActivity(billModal.bill)}
                  className="flex items-center gap-1 px-2 py-1 border border-slate-200 hover:bg-slate-50 text-slate-600 font-semibold rounded-lg text-[10px]"
                ><History size={12} /><span>ประวัติออเดอร์</span></button>
                <button
                  onClick={() => setBillModal({ open: false, bill: null, lines: [] })}
                  className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                ><X size={18} /></button>
              </div>
            </div>

            <div className="overflow-auto flex-1">
              {billModal.lines.length ? (
                <table className="w-full text-[11px]">
                  <thead className="bg-slate-50 text-slate-500 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left font-semibold">รายการ</th>
                      <th className="px-4 py-2 text-right font-semibold">จำนวน</th>
                      <th className="px-4 py-2 text-right font-semibold">ราคา/หน่วย</th>
                      <th className="px-4 py-2 text-right font-semibold">รวม</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {billModal.lines.map((i, idx) => (
                      <tr key={idx} className="hover:bg-emerald-50/40">
                        <td className="px-4 py-2">
                          <div className="font-semibold text-slate-700">{str(i.itemName) || '-'}</div>
                          <div className="text-[10px] text-slate-400">
                            {str(i.itemCode) && <>รหัส {str(i.itemCode)}</>}
                            {str(i.groupName) && <> · {str(i.groupName)}</>}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right font-mono">{qtyFmt(i.quantity)}</td>
                        <td className="px-4 py-2 text-right font-mono text-slate-500">฿{money(i.unitPrice)}</td>
                        <td className="px-4 py-2 text-right font-mono font-semibold text-slate-700">฿{money(lineAmount(i))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="px-5 py-10 text-center text-xs text-slate-400">
                  ไม่พบรายการสินค้าของบิลนี้ในช่วงวันที่ที่โหลดไว้
                </div>
              )}
            </div>

            {/* สรุปท้ายบิล */}
            <div className="border-t border-slate-100 bg-slate-50 px-5 py-4 text-[11px] space-y-1">
              {[
                ['รวมรายการ', billModal.lines.reduce((t, i) => t + lineAmount(i), 0)],
                ['ยอดก่อนส่วนลด/ภาษี', num(billModal.bill.amount)],
                ['ส่วนลด', -num(billModal.bill.discount)],
                ['Service Charge', num(billModal.bill.serviceChg)],
                ['VAT', num(billModal.bill.vat)],
              ].filter(([, v]) => v !== 0).map(([label, v]) => (
                <div key={label} className="flex justify-between text-slate-500">
                  <span>{label}</span>
                  <span className="font-mono">฿{money(v)}</span>
                </div>
              ))}
              <div className="flex justify-between pt-2 border-t border-slate-200 text-sm font-bold text-slate-800">
                <span>ยอดสุทธิ</span>
                <span className="font-mono text-emerald-700">฿{money(billAmount(billModal.bill))}</span>
              </div>
              <div className="pt-2 flex flex-wrap gap-1.5">
                {(() => {
                  const paid = CHANNELS.filter((c) => num(billModal.bill[c.key]) > 0);
                  if (paid.length) {
                    return paid.map((c) => (
                      <span key={c.key} className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-semibold">
                        {c.label} ฿{money(billModal.bill[c.key])}
                      </span>
                    ));
                  }
                  return str(billModal.bill.paidType) ? (
                    <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 text-[10px] font-semibold">
                      {str(billModal.bill.paidType)}
                    </span>
                  ) : null;
                })()}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
