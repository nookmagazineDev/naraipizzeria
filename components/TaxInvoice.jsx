// ACC › ใบกำกับภาษี (เต็มรูป)
//
// ตอบคำถามเดียว: "ใบกำกับภาษีที่ออกไปแล้วมีใบไหนบ้าง ใบล่าสุดเลขอะไร ของบิลวันไหน ยอดเท่าไหร่"
//
// ที่มาของข้อมูล: คอลัมน์ FullTaxInvNo ของตารางบิล (dbo.Cpaid) ผ่าน /api/sales
// ชุดเดียวกับหน้า "รายงานยอดการขาย" — บิลไหนไม่มีเลขในคอลัมน์นี้แปลว่าไม่ได้ออก
// ใบกำกับเต็มรูป จึงไม่ขึ้นในหน้านี้ (บิลปกติออกแค่ใบเสร็จ/ใบกำกับอย่างย่อ = TaxInvNo)
//
// เรียง "ใบล่าสุดขึ้นก่อน" เป็นค่าตั้งต้น: ดูวันที่ออกใบเป็นหลัก ถ้าออกวันเดียวกัน
// ค่อยดูเลขวิ่งใน FullTaxInvNo (เทียบแบบ natural ไม่งั้น 1000 จะน้อยกว่า 999)
// กดหัวคอลัมน์เพื่อเรียงแบบอื่นได้ แต่เปิดหน้ามาจะเจอใบล่าสุดอยู่บนสุดเสมอ
//
// หมายเหตุ: หน้านี้ไม่ตัดโต๊ะ/ไอเทมที่ยอดขายไม่นับ (เช่นโต๊ะ 600) ออก — ใบกำกับที่ออกไปแล้ว
// คือเอกสารที่ลูกค้าถืออยู่จริง ต้องเห็นครบทุกใบแม้ยอดนั้นจะไม่ถูกนับเป็นยอดขาย
import React, { useState, useMemo } from 'react';
import { FileText, Search, Calendar, Loader2, AlertCircle, Download, Building2, ChevronLeft, ChevronRight } from 'lucide-react';
import * as XLSX from 'xlsx-js-style';
import { fetchSalesRange, dateFromRow } from '../lib/salesFetch';
import { useBranches } from '../lib/useBranches';

const PAGE_SIZE = 50;

const fmtMoney = v => {
  const n = parseFloat(v);
  return isNaN(n) ? '-' : n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const todayStr = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

/**
 * เลขที่ใบกำกับที่ "ว่างจริง" — ทั้งช่องว่าง, ขีด และเลขศูนย์ล้วน
 * (บางสาขาเซ็ตให้ POS เขียน 0 ลงคอลัมน์แทนการปล่อยว่าง ถ้าไม่กันไว้จะกลายเป็นใบกำกับปลอม ๆ เต็มหน้า)
 */
const hasInvNo = v => {
  const s = String(v ?? '').trim();
  return s !== '' && s !== '-' && !/^0+$/.test(s);
};

// หั่นเลขที่ใบเป็นท่อนตัวเลข/ไม่ใช่ตัวเลข เพื่อเทียบแบบ natural
// (เลขที่ใบของ POS = อักษรนำหน้าของสาขา + เลขวิ่ง เช่น SJP-0001234)
const invChunks = s => String(s ?? '').trim().match(/\d+|\D+/g) || [];

/** เทียบเลขที่ใบกำกับ: คืนค่าบวกเมื่อ a เป็นใบที่ออกทีหลัง b */
function compareInvNo(a, b) {
  const A = invChunks(a);
  const B = invChunks(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i];
    const y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else {
      const d = x.localeCompare(y, 'th');
      if (d) return d;
    }
  }
  return 0;
}

/* คอลัมน์ในตาราง — sortVal คืนค่าที่เอาไปเรียง (undefined = ใช้ตัวเทียบพิเศษของคอลัมน์นั้น) */
const COLUMNS = [
  { key: 'invNo', label: 'เลขที่ใบกำกับภาษี', align: 'left' },
  { key: 'billDate', label: 'วันที่บิล', align: 'left', sortVal: r => r.billDate },
  { key: 'taxDate', label: 'วันที่ออกใบ', align: 'left', sortVal: r => r.taxDate || '' },
  { key: 'branch', label: 'สาขา', align: 'left', sortVal: r => r.branch },
  { key: 'checkID', label: 'เลขที่บิล', align: 'left', sortVal: r => String(r.checkID ?? '') },
  { key: 'beforeVat', label: 'ยอดก่อน VAT', align: 'right', sortVal: r => r.beforeVat },
  { key: 'vat', label: 'VAT', align: 'right', sortVal: r => r.vat },
  { key: 'amount', label: 'ยอดขาย (รวม VAT)', align: 'right', sortVal: r => r.amount },
];

export default function TaxInvoice() {
  const firstOfMonth = todayStr().slice(0, 8) + '01';
  const [startDate, setStartDate] = useState(firstOfMonth);
  const [endDate, setEndDate] = useState(todayStr());
  const [outlet, setOutlet] = useState('');            // '' = ทุกสาขา

  const [rawRows, setRawRows] = useState([]);          // ใบกำกับที่ดึงมารอบล่าสุด (เรียงใบล่าสุดไว้บนสุดแล้ว)
  const [range, setRange] = useState(null);            // ช่วง/สาขาของข้อมูลที่แสดงอยู่จริง
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);      // { current, total } ระหว่างไล่ดึงทีละก้อน
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  // ค่าตั้งต้น = ใบล่าสุดอยู่บนสุด (col: null คือใช้ลำดับ "ใบล่าสุดก่อน" ที่คำนวณไว้แล้ว)
  const [sort, setSort] = useState({ col: null, asc: false });
  const [page, setPage] = useState(1);

  // ทะเบียนสาขากลาง (HR → จัดการสาขา) — ใช้ทั้ง dropdown และแปลง outletID เป็นรหัสสาขา
  const { branches } = useBranches();
  const outletOptions = useMemo(() => branches.filter(b => b.outletId), [branches]);
  const branchByOutlet = useMemo(() => {
    const m = {};
    outletOptions.forEach(b => { m[String(b.outletId)] = b.code; });
    return m;
  }, [outletOptions]);

  async function load() {
    if (!startDate || !endDate) { setError('กรุณาเลือกวันที่เริ่มต้นและวันที่สิ้นสุด'); return; }
    if (startDate > endDate) { setError('วันที่เริ่มต้นต้องไม่มากกว่าวันที่สิ้นสุด'); return; }

    setLoading(true);
    setError('');
    setProgress({ current: 0, total: 1 });
    try {
      const bills = await fetchSalesRange({ start: startDate, end: endDate, outlet, onProgress: setProgress });

      const list = bills.filter(b => hasInvNo(b.fullTaxInvNo)).map(b => {
        const amount = parseFloat(b.amount ?? 0) || 0;
        const vat = parseFloat(b.vat ?? 0) || 0;
        return {
          invNo: String(b.fullTaxInvNo).trim(),
          billDate: dateFromRow(b),                          // วันที่เปิดบิล (ยึดเหมือนทุกหน้า)
          billTime: String(b.date ?? b.startTime ?? '').slice(0, 19),
          taxDate: String(b.fullTaxDate ?? '').slice(0, 10),
          outletID: b.outletID,
          checkID: b.checkID,
          accID: String(b.fullTaxAccID ?? '').trim(),
          amount,
          vat,
          beforeVat: amount - vat,
          // วันที่ใช้เรียง: ยึดวันที่ออกใบกำกับ ถ้าไม่ได้บันทึกไว้ค่อยใช้วันปิดบิลแทน
          // (เทียบแค่ระดับวัน เพราะ FullTaxDate เป็นคอลัมน์วันที่ล้วน เวลาเป็น 00:00:00 เสมอ)
          issuedDay: String(b.fullTaxDate || b.date || b.startTime || '').slice(0, 10),
        };
      });

      // ใบล่าสุดก่อน: วันที่ออกใบใหม่สุดขึ้นบน วันเดียวกันดูเลขวิ่งใน FullTaxInvNo แล้วค่อยดูเวลาปิดบิล
      list.sort((a, b) =>
        b.issuedDay.localeCompare(a.issuedDay)
        || compareInvNo(b.invNo, a.invNo)
        || b.billTime.localeCompare(a.billTime));

      setRawRows(list);
      setRange({ start: startDate, end: endDate, outlet });
      setSort({ col: null, asc: false });
      setPage(1);
    } catch (e) {
      setError(e.message || 'ดึงข้อมูลไม่สำเร็จ');
      setRawRows([]);
      setRange(null);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  const rows = useMemo(
    () => rawRows.map(r => ({ ...r, branch: branchByOutlet[String(r.outletID)] || String(r.outletID ?? '-') })),
    [rawRows, branchByOutlet],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = q
      ? rows.filter(r => [r.invNo, r.checkID, r.branch, r.billDate, r.taxDate, r.accID]
          .some(v => String(v ?? '').toLowerCase().includes(q)))
      : rows;

    if (sort.col) {
      const col = COLUMNS.find(c => c.key === sort.col);
      const dir = sort.asc ? 1 : -1;
      // เรียงจากสำเนา — rows ต้องคงลำดับ "ใบล่าสุดก่อน" ไว้เผื่อผู้ใช้กดกลับ
      list = [...list].sort((a, b) => {
        if (!col?.sortVal) return dir * compareInvNo(a.invNo, b.invNo);
        const x = col.sortVal(a);
        const y = col.sortVal(b);
        if (typeof x === 'number' && typeof y === 'number') return dir * (x - y);
        return dir * String(x).localeCompare(String(y), 'th');
      });
    }
    return list;
  }, [rows, search, sort]);

  const totals = useMemo(() => visible.reduce(
    (s, r) => ({ amount: s.amount + r.amount, vat: s.vat + r.vat, beforeVat: s.beforeVat + r.beforeVat }),
    { amount: 0, vat: 0, beforeVat: 0 },
  ), [visible]);

  // ใบล่าสุดของแต่ละสาขา — เลขวิ่งเป็นของใครของมัน ดูรวมกันทั้งกองแล้วบอกไม่ได้ว่าใบไหนของสาขาไหน
  // (rows เรียงใบล่าสุดไว้บนสุดแล้ว ตัวแรกที่เจอของแต่ละสาขาจึงเป็นใบล่าสุดของสาขานั้น)
  const latestByBranch = useMemo(() => {
    const seen = new Map();
    rows.forEach(r => { if (!seen.has(r.branch)) seen.set(r.branch, r); });
    return [...seen.values()].sort((a, b) => b.issuedDay.localeCompare(a.issuedDay));
  }, [rows]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageRows = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  // กดหัวคอลัมน์วนสามจังหวะ: มาก→น้อย · น้อย→มาก · กลับไปลำดับตั้งต้น "ใบล่าสุดก่อน"
  const clickSort = key => {
    setSort(s => {
      if (s.col !== key) return { col: key, asc: false };
      if (!s.asc) return { col: key, asc: true };
      return { col: null, asc: false };
    });
    setPage(1);
  };

  function exportExcel() {
    if (!visible.length) return;
    const aoa = [
      ['ใบกำกับภาษี (เต็มรูป)', `${range?.start} ถึง ${range?.end}`,
        range?.outlet ? `สาขา ${branchByOutlet[String(range.outlet)] || range.outlet}` : 'ทุกสาขา'],
      [],
      ['เลขที่ใบกำกับภาษี', 'วันที่บิล', 'เวลาปิดบิล', 'วันที่ออกใบ', 'สาขา', 'เลขที่บิล', 'รหัสผู้ขอใบกำกับ',
        'ยอดก่อน VAT', 'VAT', 'ยอดขาย (รวม VAT)'],
      ...visible.map(r => [r.invNo, r.billDate, r.billTime, r.taxDate || '', r.branch, String(r.checkID ?? ''),
        r.accID, Number(r.beforeVat.toFixed(2)), Number(r.vat.toFixed(2)), Number(r.amount.toFixed(2))]),
      [],
      ['รวม', '', '', '', '', `${visible.length} ใบ`, '',
        Number(totals.beforeVat.toFixed(2)), Number(totals.vat.toFixed(2)), Number(totals.amount.toFixed(2))],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 20 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 16 },
      { wch: 14 }, { wch: 12 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ใบกำกับภาษี');
    XLSX.writeFile(wb, `tax-invoice_${range?.start}_${range?.end}.xlsx`);
  }

  return (
    <div className="max-w-7xl mx-auto pb-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-3">
          <div className="p-2 bg-amber-100 text-amber-600 rounded-xl">
            <FileText className="w-6 h-6" />
          </div>
          ใบกำกับภาษี (เต็มรูป)
        </h1>
        <p className="text-gray-500 mt-1 ml-11">
          บิลที่ออกใบกำกับภาษีเต็มรูป (มีเลขในคอลัมน์ FullTaxInvNo) — เรียงใบล่าสุดขึ้นก่อน
        </p>
      </div>

      {/* ตัวกรอง: ช่วงวันที่ของบิล + สาขา */}
      <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-slate-500 flex items-center gap-1"><Calendar size={13} /> วันที่เริ่มต้น</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-slate-500">วันที่สิ้นสุด</label>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-slate-500 flex items-center gap-1"><Building2 size={13} /> สาขา</label>
            <select value={outlet} onChange={e => setOutlet(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500">
              <option value="">ทุกสาขา</option>
              {outletOptions.map(b => (
                <option key={b.code} value={b.outletId}>{b.outletId} · {b.code}</option>
              ))}
            </select>
          </div>
          <button onClick={load} disabled={loading}
            className="px-5 py-2 bg-amber-500 text-white text-sm font-semibold rounded-xl hover:bg-amber-600 disabled:opacity-50 flex items-center gap-2 transition-colors">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            {loading ? 'กำลังดึงข้อมูล...' : 'ค้นหาข้อมูล'}
          </button>

          <div className="flex-1" />

          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-gray-400" />
            </div>
            <input type="text" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
              placeholder="ค้นหาเลขที่ใบ / เลขที่บิล / สาขา..."
              className="pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm w-64 focus:outline-none focus:ring-2 focus:ring-amber-500" />
          </div>
          <button onClick={exportExcel} disabled={!visible.length}
            className="px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-xl hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2 transition-colors">
            <Download className="w-4 h-4" /> Export Excel
          </button>
        </div>

        {loading && progress && (
          <div className="mt-3 text-xs text-slate-500">
            กำลังดึงบิลช่วงที่ {Math.min(progress.current + 1, progress.total)} จาก {progress.total} ...
          </div>
        )}
        {error && (
          <div className="mt-3 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-sm flex items-center gap-2">
            <AlertCircle size={16} /> <span>{error}</span>
          </div>
        )}
      </div>

      {/* สรุป: ใบล่าสุด + จำนวนใบ + ยอดรวม */}
      {range && !loading && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div className="bg-white border border-amber-200 rounded-2xl p-4 shadow-sm">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">ใบกำกับล่าสุด</div>
            {rows.length ? (
              <>
                <div className="text-xl font-bold text-amber-600 font-mono mt-1 break-all">{rows[0].invNo}</div>
                <div className="text-xs text-slate-500 mt-1">
                  {rows[0].branch} · บิลวันที่ {rows[0].billDate} · {fmtMoney(rows[0].amount)} บาท
                </div>
              </>
            ) : (
              <div className="text-sm text-slate-400 mt-2">ช่วงนี้ยังไม่มีใบกำกับเต็มรูป</div>
            )}
          </div>
          <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">จำนวนใบกำกับ</div>
            <div className="text-xl font-bold text-slate-700 mt-1">{visible.length.toLocaleString('th-TH')} ใบ</div>
            <div className="text-xs text-slate-500 mt-1">{range.start} ถึง {range.end}</div>
          </div>
          <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">ยอดขายรวม (รวม VAT)</div>
            <div className="text-xl font-bold text-emerald-600 mt-1">{fmtMoney(totals.amount)}</div>
            <div className="text-xs text-slate-500 mt-1">
              ก่อน VAT {fmtMoney(totals.beforeVat)} · VAT {fmtMoney(totals.vat)}
            </div>
          </div>
        </div>
      )}

      {/* ใบล่าสุดของแต่ละสาขา — เลขวิ่งแยกกันคนละชุด ดูรวมกันแล้วบอกไม่ได้ว่าถึงเลขไหนแล้ว */}
      {latestByBranch.length > 1 && !loading && (
        <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm mb-4">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">ใบล่าสุดของแต่ละสาขา</div>
          <div className="flex flex-wrap gap-2">
            {latestByBranch.map(r => (
              <div key={r.branch} className="px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-100 text-xs">
                <span className="font-bold text-slate-700">{r.branch}</span>
                <span className="mx-1.5 text-slate-300">·</span>
                <span className="font-mono text-amber-600 font-semibold">{r.invNo}</span>
                <span className="mx-1.5 text-slate-300">·</span>
                <span className="text-slate-500">{r.billDate}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ตารางใบกำกับ */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center text-amber-600">
            <Loader2 className="w-10 h-10 animate-spin mb-4" />
            <p className="font-medium text-sm">กำลังดึงบิลจากระบบ POS...</p>
          </div>
        ) : !range ? (
          <div className="py-20 text-center text-slate-400 text-sm">
            <FileText className="w-8 h-8 mx-auto mb-2 text-slate-300" />
            เลือกช่วงวันที่และสาขา แล้วกด “ค้นหาข้อมูล”
          </div>
        ) : (
          <>
            <div className="overflow-auto max-h-[70vh]">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100 text-slate-500 font-bold sticky top-0">
                    {COLUMNS.map(c => (
                      <th key={c.key} onClick={() => clickSort(c.key)}
                        className={`px-4 py-3 text-slate-600 cursor-pointer hover:bg-slate-100 hover:text-amber-600 transition-colors whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''}`}>
                        <div className={`flex items-center gap-1 ${c.align === 'right' ? 'justify-end' : ''}`}>
                          <span>{c.label}</span>
                          {sort.col === c.key && <span>{sort.asc ? '▲' : '▼'}</span>}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {pageRows.length === 0 ? (
                    <tr>
                      <td colSpan={COLUMNS.length} className="py-16 text-center text-slate-400">
                        <AlertCircle className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                        ช่วงนี้ไม่มีบิลที่ออกใบกำกับภาษีเต็มรูป
                      </td>
                    </tr>
                  ) : pageRows.map((r, i) => (
                    <tr key={`${r.invNo}-${r.checkID}-${i}`} className="hover:bg-amber-50/40 transition-colors">
                      <td className="px-4 py-2.5 whitespace-nowrap font-mono font-bold text-amber-600">{r.invNo}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <div>{r.billDate}</div>
                        {r.billTime && <div className="text-[10px] text-slate-400" title="เวลาปิดบิล">{r.billTime.slice(11)}</div>}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-slate-500">{r.taxDate || '-'}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap font-semibold">{r.branch}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap font-mono text-slate-500">{r.checkID ?? '-'}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-slate-600">{fmtMoney(r.beforeVat)}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-slate-500">{fmtMoney(r.vat)}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono font-bold text-emerald-600">{fmtMoney(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                {visible.length > 0 && (
                  <tfoot>
                    <tr className="bg-slate-50 border-t border-slate-200 font-bold text-slate-700">
                      <td className="px-4 py-3" colSpan={5}>รวม {visible.length.toLocaleString('th-TH')} ใบ</td>
                      <td className="px-4 py-3 text-right font-mono">{fmtMoney(totals.beforeVat)}</td>
                      <td className="px-4 py-3 text-right font-mono">{fmtMoney(totals.vat)}</td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-700">{fmtMoney(totals.amount)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
              <span>
                แสดง {visible.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, visible.length)} จาก {visible.length.toLocaleString('th-TH')} ใบ
              </span>
              <div className="flex gap-1.5">
                <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
                  className="p-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40">
                  <ChevronLeft size={16} />
                </button>
                <span className="flex items-center px-3 font-semibold text-slate-700">
                  หน้า {visible.length === 0 ? 0 : page} จาก {totalPages}
                </span>
                <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
                  className="p-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40">
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
