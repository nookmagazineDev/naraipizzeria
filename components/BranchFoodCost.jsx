import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Loader2, AlertCircle, Download, X, ChevronRight, Info, Coins,
} from 'lucide-react';
import * as XLSX from 'xlsx-js-style';
import { FOOD_COST_CATS, foodCostCatOf } from '../lib/foodCostCats';
import { fetchDailySales } from '../lib/laborSales';
import { exportTableXlsx } from '../lib/exportTable';

/*
 * NARAI OFFICE — ACC → ต้นทุนใบเบิกสาขา
 *
 * ข้อมูลชุดเดียวกับส่วน "Cost" ในหน้าสรุปกำไร / ขาดทุนของแดชบอร์ดสาขา แต่ดูได้ทุกสาขาพร้อมกัน
 *   Total Food Cost = ต้นทุนจากใบเบิก + รายจ่ายจาก Supplier + ยอดยกมาเดือนที่แล้ว − ยอดมูลค่าสตอคปัจจุบัน
 *
 *   /api/food-cost         ยอดรวมต่อสาขา (แยกหมวด) + สต๊อก/Supplier — ทั้งหน้า
 *   /api/food-cost?branch= แนบรายการสต๊อก/Supplier ของสาขาที่กดดู
 *   /api/withdrawals       ใบเบิกทีละบรรทัดของสาขาที่กดดู (รายการในหมวด → ประวัติเบิก)
 *   lib/laborSales.js      ยอดขายก่อน VAT ต่อสาขา (ไว้คิด % ของยอดขาย) — ดึงต่อท้ายเพราะช้ากว่า
 */

const baht = (n) =>
  '฿' + (Number(n) || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => (Number(n) || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = (n) => Math.round(Number(n) || 0).toLocaleString('th-TH');
const qtyFmt = (n) => (Number(n) || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const pctOf = (v, base) => (base > 0 ? `${((v / base) * 100).toFixed(2)}%` : '—');
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function quickRange(key) {
  const t = new Date();
  if (key === 'last') {
    const e = new Date(t.getFullYear(), t.getMonth(), 0);
    return [ymd(new Date(e.getFullYear(), e.getMonth(), 1)), ymd(e)];
  }
  return [ymd(new Date(t.getFullYear(), t.getMonth(), 1)), ymd(t)]; // month
}
const QUICK = [{ key: 'month', label: 'เดือนนี้' }, { key: 'last', label: 'เดือนที่แล้ว' }];

const stockTag = (date, source, empty = '') =>
  (date ? ` (${source === 'closing' ? 'ปิดรอบ' : 'นับ'} ${date})` : empty);

const TH = 'px-3 py-2 text-xs font-semibold text-slate-500 bg-slate-50 border-b border-slate-200 whitespace-nowrap text-right';
const TD = 'px-3 py-2 border-b border-slate-100 whitespace-nowrap text-right font-mono tabular-nums';

const Chip = ({ on, children, ...p }) => (
  <button type="button" {...p}
    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
      on ? 'bg-amber-500 border-amber-500 text-white' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
    {children}
  </button>
);

const Kpi = ({ label, value, sub, tone = 'text-rose-600' }) => (
  <div className="rounded-xl p-4 border bg-white border-slate-200">
    <div className="text-xs font-semibold text-slate-500">{label}</div>
    <div className={`text-xl md:text-2xl font-bold mt-1 font-mono tabular-nums ${tone}`}>{value}</div>
    {sub && <div className="text-xs text-slate-400 mt-0.5">{sub}</div>}
  </div>
);

/** Modal ตารางทั่วไป (รายการในหมวด / ประวัติเบิก / สต๊อก / Supplier) */
function TableModal({ title, subtitle, cols, rows, onRow, foot, onClose }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/60" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 bg-slate-800 text-white flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="font-bold truncate">{title}</h3>
            {subtitle && <p className="text-xs text-slate-300">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2">
            {rows.length > 0 && (
              <button
                onClick={() => exportTableXlsx({ title, subtitle, cols: cols.map((c) => ({ ...c, right: !c.left })), rows, foot })}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-emerald-400 text-emerald-300 text-xs font-semibold hover:bg-emerald-500/20"
                title="ส่งออกหน้านี้เป็น Excel">
                <Download size={14} /> Excel
              </button>
            )}
            <button onClick={onClose} className="p-1 rounded hover:bg-slate-700"><X size={18} /></button>
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {rows.length === 0 ? (
            <div className="py-16 text-center text-slate-400 text-sm">ไม่มีรายการ</div>
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0">
                <tr>{cols.map((c) => <th key={c.label} className={`${TH} ${c.left ? '!text-left' : ''}`}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} onClick={onRow ? () => onRow(r) : undefined}
                    className={onRow ? 'cursor-pointer hover:bg-amber-50' : ''}>
                    {cols.map((c) => (
                      <td key={c.label} className={`${TD} ${c.left ? '!text-left !font-sans' : ''} ${c.cls || ''}`}>{c.render(r)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {foot && (
                <tfoot className="sticky bottom-0 bg-slate-50 font-bold">
                  <tr>{cols.map((c, i) => <td key={c.label} className={`${TD} ${c.left ? '!text-left !font-sans' : ''}`}>{foot[i] ?? ''}</td>)}</tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

/** แถวหนึ่งในตาราง Cost ของรายละเอียดสาขา */
const CostRow = ({ label, value, pct, onClick, bold, tone = 'text-rose-600', indent }) => (
  <tr onClick={onClick} className={`${onClick ? 'cursor-pointer hover:bg-rose-50/50' : ''} ${bold ? 'bg-slate-50 font-bold' : ''}`}>
    <td className={`px-3 py-2 border-b border-slate-100 text-sm ${indent ? 'pl-7' : ''}`}>
      {onClick && <ChevronRight size={14} className="inline mr-1 text-slate-400" />}
      {label}
    </td>
    <td className={`px-3 py-2 border-b border-slate-100 text-right font-mono tabular-nums ${tone}`}>{baht(value)}</td>
    <td className="px-3 py-2 border-b border-slate-100 text-right font-mono text-xs text-slate-400 w-20">{pct}</td>
  </tr>
);

export default function BranchFoodCost() {
  const [range, setRange] = useState(() => quickRange('month'));
  const [quick, setQuick] = useState('month');
  const [data, setData] = useState(null);        // คำตอบของ /api/food-cost
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [sales, setSales] = useState(null);      // { byOutlet, total } | null
  const [salesNote, setSalesNote] = useState('');

  const [selected, setSelected] = useState('');  // รหัสสาขาที่กดดูรายละเอียด
  const [detail, setDetail] = useState(null);    // { code, lines, stock }
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [modal, setModal] = useState(null);

  const load = useCallback(async (from, to) => {
    if (!from || !to) return;
    if (from > to) { setError('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด'); return; }
    setLoading(true);
    setError('');
    setSales(null);
    setSelected('');
    setDetail(null);
    try {
      const r = await fetch(`/api/food-cost?start=${from}&end=${to}`);
      const res = await r.json();
      if (res.status !== 'success') throw new Error(res.message || 'โหลดข้อมูลไม่สำเร็จ');
      setData(res);
      // ยอดขายก่อน VAT ต่อสาขา — ไว้คิด % (ช้ากว่าเพราะต้องดึงบิล+รายการ ทีละ 5 วัน จึงดึงต่อท้าย)
      const codeOfOutlet = Object.fromEntries((res.branches || []).filter((b) => b.outletId).map((b) => [String(b.outletId), b.code]));
      setSalesNote('กำลังดึงยอดขาย…');
      fetchDailySales({ start: from, end: to, codeOfOutlet, onProgress: (t) => setSalesNote(t) })
        .then((s) => { setSales({ byOutlet: s.beforeVatByOutlet || {}, total: s.beforeVat }); setSalesNote(''); })
        .catch((e) => setSalesNote(`ดึงยอดขายไม่สำเร็จ (${e.message}) — ไม่แสดง % ของยอดขาย`));
    } catch (e) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(...quickRange('month')); }, [load]);

  const pickQuick = (key) => {
    const r = quickRange(key);
    setQuick(key);
    setRange(r);
    load(...r);
  };

  const rows = data?.branches || [];
  const salesOf = (b) => (sales ? Number(sales.byOutlet[String(b.outletId)] || 0) : 0);

  const total = useMemo(() => {
    const t = { withdraw: 0, sup: 0, supCount: 0, prevStock: 0, curStock: 0, foodCost: 0, sales: 0, cats: {} };
    FOOD_COST_CATS.forEach((c) => { t.cats[c.key] = 0; });
    rows.forEach((b) => {
      ['withdraw', 'sup', 'supCount', 'prevStock', 'curStock', 'foodCost'].forEach((k) => { t[k] += Number(b[k]) || 0; });
      FOOD_COST_CATS.forEach((c) => { t.cats[c.key] += Number(b.cats?.[c.key]) || 0; });
      t.sales += salesOf(b);
    });
    return t;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sales]);

  /* ── รายละเอียดสาขา ── */
  const openBranch = async (b) => {
    if (selected === b.code) return;
    setSelected(b.code);
    // จอไม่กว้างพอ กล่องรายละเอียดอยู่ใต้ตาราง — เลื่อนลงไปให้เห็นเลย
    setTimeout(() => document.getElementById('food-cost-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    const [from, to] = [data.start, data.end];
    try {
      const qs = new URLSearchParams({ branch: b.code, startDate: from, endDate: to });
      if (b.outletId) qs.set('outletId', b.outletId);
      const [w, s] = await Promise.all([
        fetch(`/api/withdrawals?${qs}`).then((r) => r.json()),
        fetch(`/api/food-cost?start=${from}&end=${to}&branch=${encodeURIComponent(b.code)}`).then((r) => r.json()),
      ]);
      if (w.status !== 'success') throw new Error(w.message || 'ดึงใบเบิกไม่สำเร็จ');
      const lines = [];
      for (const doc of w.data || []) {
        for (const it of doc.items || []) {
          lines.push({
            itemCode: String(it.itemCode || ''), itemName: it.itemName || '-', qty: Number(it.qty) || 0,
            unit: it.unit || '', unitPrice: Number(it.unitPrice) || 0, amount: Number(it.amount) || 0,
            docDate: doc.docDate || '', invNo: doc.invNo || doc.docNo || '', cat: foodCostCatOf(it.itemCode),
          });
        }
      }
      setDetail({ code: b.code, lines, stock: s.status === 'success' ? s.detail : null });
    } catch (e) {
      setDetailError(e.message);
    } finally {
      setDetailLoading(false);
    }
  };

  const sel = rows.find((b) => b.code === selected);
  const selSales = sel ? salesOf(sel) : 0;

  // ใบเบิกของสาขาที่เลือก: หมวด → สินค้า → บรรทัดเบิก
  const catItems = useMemo(() => {
    const out = {};
    FOOD_COST_CATS.forEach((c) => { out[c.key] = {}; });
    for (const ln of detail?.lines || []) {
      const m = out[ln.cat] || out.other;
      const it = m[ln.itemCode] || (m[ln.itemCode] = { itemCode: ln.itemCode, itemName: ln.itemName, unit: ln.unit, qty: 0, amount: 0, lines: [] });
      it.qty += ln.qty;
      it.amount += ln.amount;
      it.lines.push(ln);
    }
    return Object.fromEntries(Object.entries(out).map(([k, m]) => [k, Object.values(m).sort((a, b) => b.amount - a.amount)]));
  }, [detail]);

  const showHistory = (it) => setModal({
    title: it.itemName, subtitle: `รหัส ${it.itemCode} • เบิก ${it.lines.length} ครั้ง`,
    rows: it.lines.slice().sort((a, b) => String(a.docDate).localeCompare(String(b.docDate))),
    cols: [
      { label: 'วันที่เบิก', left: true, render: (r) => r.docDate },
      { label: 'เลขที่ใบเบิก', left: true, render: (r) => r.invNo || '-' },
      { label: 'จำนวน', render: (r) => qtyFmt(r.qty) },
      { label: 'หน่วย', left: true, render: (r) => r.unit || '-' },
      { label: 'ราคา/หน่วย', render: (r) => money(r.unitPrice) },
      { label: 'มูลค่ารวม', cls: 'text-rose-600', render: (r) => money(r.amount) },
    ],
    foot: ['รวม', '', qtyFmt(it.qty), '', '', money(it.amount)],
  });

  const showCatItems = (c) => {
    const items = catItems[c.key] || [];
    setModal({
      title: `${c.label} — สาขา ${selected}`, subtitle: `${items.length} รายการ • กดรายการเพื่อดูประวัติเบิก`,
      rows: items, onRow: (it) => showHistory(it),
      cols: [
        { label: 'รหัส', left: true, render: (r) => r.itemCode },
        { label: 'รายการ', left: true, render: (r) => r.itemName },
        { label: 'จำนวน', render: (r) => qtyFmt(r.qty) },
        { label: 'หน่วย', left: true, render: (r) => r.unit || '-' },
        { label: 'มูลค่ารวม', cls: 'text-rose-600', render: (r) => money(r.amount) },
      ],
      foot: ['', 'รวม', '', '', money(items.reduce((s, r) => s + r.amount, 0))],
    });
  };

  const showStock = (title, items) => setModal({
    title: `${title} — สาขา ${selected}`, subtitle: `${items.length} รายการ`,
    rows: items,
    cols: [
      { label: 'รหัส', left: true, render: (r) => r.itemCode },
      { label: 'รายการ', left: true, render: (r) => r.itemName },
      { label: 'คงเหลือ', render: (r) => qtyFmt(r.qty) },
      { label: 'หน่วย', left: true, render: (r) => r.unit || '-' },
      { label: 'ราคา/หน่วย', render: (r) => (r.priced ? money(r.unitPrice) : 'ไม่มีราคา') },
      { label: 'มูลค่า', cls: 'text-rose-600', render: (r) => money(r.value) },
    ],
    foot: ['', 'รวม', '', '', '', money(items.reduce((s, r) => s + (r.value || 0), 0))],
  });

  const showSup = (items) => setModal({
    title: `รายจ่ายจาก Supplier — สาขา ${selected}`, subtitle: `${items.length} รายการ`,
    rows: items,
    cols: [
      { label: 'วันที่', left: true, render: (r) => r.date },
      { label: 'รายการ', left: true, render: (r) => r.name },
      { label: 'จำนวน', render: (r) => qtyFmt(r.qty) },
      { label: 'หน่วย', left: true, render: (r) => r.unit || '-' },
      { label: 'ราคา/หน่วย', render: (r) => money(r.unitPrice) },
      { label: 'มูลค่า', cls: 'text-rose-600', render: (r) => money(r.amount) },
    ],
    foot: ['รวม', '', '', '', '', money(items.reduce((s, r) => s + r.amount, 0))],
  });

  /* ── Excel ── */
  const exportExcel = () => {
    if (!rows.length) return;
    const head = ['สาขา', ...FOOD_COST_CATS.map((c) => c.label), 'รวมต้นทุนจากใบเบิก', 'รายจ่าย Supplier',
      'ยอดยกมาเดือนที่แล้ว', 'ยอดมูลค่าสตอคปัจจุบัน', 'Total Food Cost', 'ยอดขายก่อน VAT', '% ของยอดขาย'];
    const line = (name, b, s) => [name, ...FOOD_COST_CATS.map((c) => Number((b.cats[c.key] || 0).toFixed(2))),
      Number(b.withdraw.toFixed(2)), Number(b.sup.toFixed(2)), Number(b.prevStock.toFixed(2)),
      Number(b.curStock.toFixed(2)), Number(b.foodCost.toFixed(2)), sales ? Number(s.toFixed(2)) : '',
      sales && s > 0 ? Number(((b.foodCost / s) * 100).toFixed(2)) : ''];
    const aoa = [
      [`ต้นทุนใบเบิกสาขา ${data.start} ถึง ${data.end}`], [],
      head,
      ...rows.map((b) => line(b.code, b, salesOf(b))),
      line('รวม', total, total.sales),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = head.map((h, i) => ({ wch: i === 0 ? 10 : 16 }));
    head.forEach((_, i) => {
      const cell = ws[XLSX.utils.encode_cell({ r: 2, c: i })];
      if (cell) cell.s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: 'B45309' } } };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ต้นทุนใบเบิก');
    XLSX.writeFile(wb, `food_cost_${data.start}_to_${data.end}.xlsx`);
  };

  return (
    <div className="space-y-4">
      {/* ตัวกรอง */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-wrap items-end gap-3">
        <div className="flex gap-2">
          {QUICK.map((q) => <Chip key={q.key} on={quick === q.key} onClick={() => pickQuick(q.key)}>{q.label}</Chip>)}
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">ตั้งแต่</label>
          <input type="date" value={range[0]} onChange={(e) => { setQuick(''); setRange([e.target.value, range[1]]); }}
            className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">ถึง</label>
          <input type="date" value={range[1]} onChange={(e) => { setQuick(''); setRange([range[0], e.target.value]); }}
            className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm" />
        </div>
        <button onClick={() => load(...range)} disabled={loading}
          className="px-4 py-2 rounded-lg bg-amber-500 text-white font-semibold text-sm hover:bg-amber-600 disabled:opacity-50 flex items-center gap-2">
          {loading && <Loader2 size={16} className="animate-spin" />} ดึงข้อมูล
        </button>
        <button onClick={exportExcel} disabled={!rows.length}
          className="px-4 py-2 rounded-lg border border-emerald-500 text-emerald-600 font-semibold text-sm hover:bg-emerald-50 disabled:opacity-40 flex items-center gap-2">
          <Download size={16} /> Excel
        </button>
        {salesNote && <span className="text-xs text-slate-500 flex items-center gap-1"><Loader2 size={12} className="animate-spin" />{salesNote}</span>}
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-3 text-sm flex gap-2"><AlertCircle size={18} />{error}</div>
      )}
      {(data?.warnings || []).map((w) => (
        <div key={w} className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-3 text-sm flex gap-2"><Info size={18} />{w}</div>
      ))}

      {loading && !data && (
        <div className="py-20 text-center text-slate-400"><Loader2 className="animate-spin inline mr-2" />กำลังดึงใบเบิกทุกสาขา…</div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label="รวมต้นทุนจากใบเบิก (ทุกสาขา)" value={baht(total.withdraw)} sub={`${rows.length} สาขา`} />
            <Kpi label="+ รายจ่ายจาก Supplier" value={baht(total.sup)} sub={`${int(total.supCount)} รายการ`} />
            <Kpi label="Total Food Cost" value={baht(total.foodCost)} sub="ใบเบิก + Supplier + ยกมา − คงเหลือ" />
            <Kpi label="Food Cost % ของยอดขาย" tone="text-slate-800"
              value={sales ? pctOf(total.foodCost, total.sales) : '…'}
              sub={sales ? `ยอดขายก่อน VAT ${baht(total.sales)}` : 'รอยอดขาย'} />
          </div>

          <div className="grid grid-cols-1 2xl:grid-cols-[1.3fr_1fr] gap-4 items-start">
            <div className="space-y-4 min-w-0">
              {/* เทียบทุกสาขา */}
              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 flex items-center justify-between">
                  <h3 className="font-bold text-slate-800">เทียบทุกสาขา</h3>
                  <span className="text-xs text-amber-600">กดแถวสาขาเพื่อดูรายละเอียด</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead><tr>
                      <th className={`${TH} !text-left`}>สาขา</th><th className={TH}>ใบเบิก</th><th className={TH}>Supplier</th>
                      <th className={TH}>ยกมา − คงเหลือ</th><th className={TH}>Total Food Cost</th><th className={TH}>% ยอดขาย</th>
                    </tr></thead>
                    <tbody>
                      {rows.map((b) => {
                        const s = salesOf(b);
                        return (
                          <tr key={b.code} onClick={() => openBranch(b)}
                            className={`cursor-pointer ${selected === b.code ? 'bg-amber-50' : 'hover:bg-slate-50'}`}>
                            <td className={`${TD} !text-left !font-sans font-semibold uppercase`}>{b.code}</td>
                            <td className={TD}>{money(b.withdraw)}</td>
                            <td className={TD}>{money(b.sup)}</td>
                            <td className={TD}>{money(b.prevStock - b.curStock)}</td>
                            <td className={`${TD} text-rose-600 font-semibold`}>{money(b.foodCost)}</td>
                            <td className={`${TD} text-slate-500`}>{sales ? pctOf(b.foodCost, s) : '…'}</td>
                          </tr>
                        );
                      })}
                      {rows.length === 0 && (
                        <tr><td colSpan={6} className="py-10 text-center text-slate-400">ไม่มีใบเบิกในช่วงนี้</td></tr>
                      )}
                    </tbody>
                    {rows.length > 0 && (
                      <tfoot><tr className="bg-slate-50 font-bold">
                        <td className={`${TD} !text-left !font-sans`}>รวม</td>
                        <td className={TD}>{money(total.withdraw)}</td>
                        <td className={TD}>{money(total.sup)}</td>
                        <td className={TD}>{money(total.prevStock - total.curStock)}</td>
                        <td className={`${TD} text-rose-600`}>{money(total.foodCost)}</td>
                        <td className={TD}>{sales ? pctOf(total.foodCost, total.sales) : ''}</td>
                      </tr></tfoot>
                    )}
                  </table>
                </div>
              </div>

              {/* แยกหมวดตามสาขา */}
              {rows.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                  <h3 className="px-4 py-3 font-bold text-slate-800">ต้นทุนจากใบเบิก แยกหมวดตามสาขา</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead><tr>
                        <th className={`${TH} !text-left sticky left-0`}>หมวด</th>
                        {rows.map((b) => <th key={b.code} className={`${TH} uppercase`}>{b.code}</th>)}
                        <th className={TH}>รวม</th>
                      </tr></thead>
                      <tbody>
                        {FOOD_COST_CATS.map((c) => (
                          <tr key={c.key}>
                            <td className={`${TD} !text-left !font-sans sticky left-0 bg-white`}>{c.label}</td>
                            {rows.map((b) => <td key={b.code} className={TD}>{int(b.cats[c.key])}</td>)}
                            <td className={`${TD} font-semibold`}>{int(total.cats[c.key])}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot><tr className="bg-slate-50 font-bold">
                        <td className={`${TD} !text-left !font-sans sticky left-0 bg-slate-50`}>รวมใบเบิก</td>
                        {rows.map((b) => <td key={b.code} className={TD}>{int(b.withdraw)}</td>)}
                        <td className={TD}>{int(total.withdraw)}</td>
                      </tr></tfoot>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* รายละเอียดสาขา — หน้าตาเดียวกับส่วน Cost ของหน้าสรุปกำไรสาขา */}
            <div id="food-cost-detail" className="bg-white rounded-2xl border border-slate-200 overflow-hidden 2xl:sticky 2xl:top-4">
              {!sel ? (
                <div className="py-20 px-6 text-center text-slate-400 text-sm">
                  <Coins className="mx-auto mb-2 text-slate-300" size={32} />
                  กดแถวสาขาในตาราง "เทียบทุกสาขา" เพื่อดูรายละเอียด
                </div>
              ) : (
                <>
                  <div className="px-4 py-3 flex items-center justify-between">
                    <h3 className="font-bold text-slate-800">รายละเอียด — สาขา <span className="uppercase">{sel.code}</span></h3>
                    {detailLoading && <Loader2 size={16} className="animate-spin text-slate-400" />}
                  </div>
                  {detailError && <div className="mx-4 mb-3 text-sm text-rose-600">{detailError}</div>}
                  <table className="w-full border-collapse">
                    <thead><tr><th colSpan={3} className="px-3 py-2 text-sm font-bold text-rose-700 bg-rose-50 border-b border-rose-100">
                      Cost (ต้นทุนจากใบเบิก + สต๊อก)</th></tr></thead>
                    <tbody>
                      {FOOD_COST_CATS.map((c) => (
                        <CostRow key={c.key} label={c.label} value={sel.cats[c.key]} pct={pctOf(sel.cats[c.key], selSales)}
                          onClick={detail ? () => showCatItems(c) : undefined} />
                      ))}
                      <CostRow label="รวมต้นทุนจากใบเบิก" value={sel.withdraw} pct={pctOf(sel.withdraw, selSales)} bold />
                      <CostRow indent label={`+ รายจ่ายจาก Supplier${sel.supCount ? ` (${sel.supCount} รายการ)` : ''}`}
                        value={sel.sup} pct={pctOf(sel.sup, selSales)}
                        onClick={detail?.stock?.supCost?.items?.length ? () => showSup(detail.stock.supCost.items) : undefined} />
                      <CostRow indent label={`+ ยอดยกมาเดือนที่แล้ว${stockTag(sel.prevDate, sel.prevSource)}`}
                        value={sel.prevStock} pct={pctOf(sel.prevStock, selSales)}
                        onClick={detail?.stock?.previous?.items?.length ? () => showStock('ยอดยกมาเดือนที่แล้ว', detail.stock.previous.items) : undefined} />
                      <CostRow indent label={`− ยอดมูลค่าสตอคปัจจุบัน${stockTag(sel.curDate, sel.curSource, ' (ยังไม่นับ)')}`}
                        value={-sel.curStock} pct={pctOf(sel.curStock, selSales)} tone="text-emerald-600"
                        onClick={detail?.stock?.current?.items?.length ? () => showStock('ยอดมูลค่าสตอคปัจจุบัน', detail.stock.current.items) : undefined} />
                      <tr className="bg-rose-50 font-bold text-rose-700">
                        <td className="px-3 py-2.5">Total Food Cost</td>
                        <td className="px-3 py-2.5 text-right font-mono">{baht(sel.foodCost)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-sm">{pctOf(sel.foodCost, selSales)}</td>
                      </tr>
                    </tbody>
                  </table>
                  <p className="px-4 py-3 text-xs text-slate-400 leading-relaxed">
                    * Total Food Cost = ต้นทุนจากใบเบิก + รายจ่ายจาก Supplier + ยอดยกมาเดือนที่แล้ว − ยอดมูลค่าสตอคปัจจุบัน
                    {sel.curUnpriced ? ` • สต๊อกปัจจุบันมี ${sel.curUnpriced} รายการที่ไม่มีราคาในทะเบียน (คิดเป็น 0)` : ''}
                    <br />* กดหมวดเพื่อดูรายการสินค้า → กดรายการเพื่อดูประวัติเบิก
                    {sales ? ` • % เทียบยอดขายก่อน VAT ${baht(selSales)}` : ''}
                  </p>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {modal && <TableModal {...modal} onClose={() => setModal(null)} />}
    </div>
  );
}
