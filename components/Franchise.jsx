import React, { useState, useMemo, useCallback } from 'react';
import {
  TrendingUp, Receipt, Layers, DollarSign, Search, Download,
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
  const [data, setData] = useState(null);      // { bills, items, expenses, layout }
  const [meta, setMeta] = useState(null);      // { source, expenseError }
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [detailMode, setDetailMode] = useState('summary'); // 'summary' = สรุปตามเมนู · 'line' = รายบรรทัด

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
    const map = new Map();
    bills.forEach((b) => {
      const d = dayOf(b.date);
      if (!d) return;
      if (!map.has(d)) {
        map.set(d, { date: d, bills: 0, cover: 0, sales: 0, vat: 0, discount: 0, ...Object.fromEntries(CHANNELS.map((c) => [c.key, 0])) });
      }
      const row = map.get(d);
      row.bills += 1;
      row.cover += num(b.cover);
      row.sales += billAmount(b);
      row.vat += num(b.vat);
      row.discount += num(b.discount);
      CHANNELS.forEach((c) => { row[c.key] += num(b[c.key]); });
    });
    const expByDay = new Map();
    expenses.forEach((e) => {
      const d = dayOf(e.date);
      if (!d) return;
      expByDay.set(d, (expByDay.get(d) || 0) + num(e.amount));
    });
    expByDay.forEach((v, d) => {
      if (!map.has(d)) {
        map.set(d, { date: d, bills: 0, cover: 0, sales: 0, vat: 0, discount: 0, ...Object.fromEntries(CHANNELS.map((c) => [c.key, 0])) });
      }
    });
    return [...map.values()]
      .map((r) => ({ ...r, expense: expByDay.get(r.date) || 0, avgPerBill: r.bills ? r.sales / r.bills : 0 }))
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

  /* ── หน้าย่อย 2: ยอดขายรายวัน ── */
  const dailyExport = () => exportRows(daily.map((r) => ({
    วันที่: r.date, จำนวนบิล: r.bills, จำนวนลูกค้า: r.cover, ยอดขาย: r.sales,
    'เฉลี่ย/บิล': r.avgPerBill,
    ...Object.fromEntries(usedChannels.map((c) => [c.label, r[c.key]])),
    รายจ่าย: r.expense,
  })), 'ยอดขายรายวัน', `เฟรนไชส์_ยอดขายรายวัน_${rangeLabel}.xlsx`);

  const dailyView = (
    <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden">
      {sectionHead(<Receipt size={16} className="text-emerald-600" />, 'ยอดขายรายวัน', exportBtn(dailyExport, !daily.length))}
      {daily.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 sticky top-0">
              <tr>
                <th className="px-3 py-2.5 text-left font-semibold">วันที่</th>
                <th className="px-3 py-2.5 text-right font-semibold">บิล</th>
                <th className="px-3 py-2.5 text-right font-semibold">ลูกค้า</th>
                <th className="px-3 py-2.5 text-right font-semibold">ยอดขาย</th>
                <th className="px-3 py-2.5 text-right font-semibold">เฉลี่ย/บิล</th>
                {usedChannels.map((c) => <th key={c.key} className="px-3 py-2.5 text-right font-semibold">{c.label}</th>)}
                <th className="px-3 py-2.5 text-right font-semibold">รายจ่าย</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {daily.map((r) => (
                <tr key={r.date} className="hover:bg-emerald-50/40">
                  <td className="px-3 py-2 font-semibold text-slate-700">{r.date}</td>
                  <td className="px-3 py-2 text-right text-slate-600">{int(r.bills)}</td>
                  <td className="px-3 py-2 text-right text-slate-600">{int(r.cover)}</td>
                  <td className="px-3 py-2 text-right font-bold text-emerald-700">฿{money(r.sales)}</td>
                  <td className="px-3 py-2 text-right text-slate-600">฿{money(r.avgPerBill)}</td>
                  {usedChannels.map((c) => <td key={c.key} className="px-3 py-2 text-right text-slate-500">{r[c.key] ? `฿${money(r[c.key])}` : '-'}</td>)}
                  <td className="px-3 py-2 text-right text-rose-600">{r.expense ? `฿${money(r.expense)}` : '-'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 font-bold text-slate-800">
              <tr>
                <td className="px-3 py-2.5">รวม {int(daily.length)} วัน</td>
                <td className="px-3 py-2.5 text-right">{int(summary.billCount)}</td>
                <td className="px-3 py-2.5 text-right">{int(summary.cover)}</td>
                <td className="px-3 py-2.5 text-right text-emerald-700">฿{money(summary.sales)}</td>
                <td className="px-3 py-2.5 text-right">฿{money(summary.avgPerBill)}</td>
                {usedChannels.map((c) => (
                  <td key={c.key} className="px-3 py-2.5 text-right">
                    ฿{money(daily.reduce((s, r) => s + num(r[c.key]), 0))}
                  </td>
                ))}
                <td className="px-3 py-2.5 text-right text-rose-600">฿{money(summary.expense)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : <Empty>ยังไม่มีข้อมูล — เลือกช่วงวันที่แล้วกด &quot;ค้นหาข้อมูล&quot;</Empty>}
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
    </div>
  );
}
