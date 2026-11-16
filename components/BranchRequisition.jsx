import React, { useState, useEffect, useMemo } from 'react';
import { PackageOpen, Search, Loader2, AlertCircle, Download, Info, ImageOff, Calendar } from 'lucide-react';
import * as XLSX from 'xlsx-js-style';
import { isIncludedBranch } from '../lib/excludedBranches';

/*
 * จัดซื้อ — เบิกของสาขา: ใบเบิกที่สาขากดในหน้านับสต๊อก (dbo.stock_request บน SQL) ผ่าน /api/branch-requisition
 * ดึงทีละเดือน — API ส่งแถวดิบ (logs) ของเดือนนั้นมา แล้วหน้านี้ pivot (แถว=ไอเทม, คอลัมน์=สาขา, ช่อง=จำนวนรวม)
 */

const fmtNum = v => (v === null || v === undefined || v === 0 || isNaN(v)) ? '' : Number(v).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const fmtMoney = v => (v === null || v === undefined || isNaN(v)) ? '—' : Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const HEAD_STYLE = {
  font: { name: 'Tahoma', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
  fill: { patternType: 'solid', fgColor: { rgb: '0E7490' } }, // cyan-700
};

const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

// timestamp จาก API: "DD/MM/YYYY HH:mm" — เรียงเป็น YYYYMMDDHHmm ก่อนเทียบว่าอันไหนล่าสุด
const sortableTime = timestamp => {
  const [datePart, timePart = ''] = String(timestamp || '').split(' ');
  const [d, m, y] = (datePart || '').split('/');
  return d && m && y ? `${y}${m.padStart(2, '0')}${d.padStart(2, '0')}${timePart}` : '';
};
const monthLabel = key => {
  const [y, m] = key.split('-');
  const mi = parseInt(m, 10) - 1;
  return `${THAI_MONTHS[mi] || m} ${y}`;
};

function ItemImage({ src, alt }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-slate-300 flex-shrink-0">
        <ImageOff size={14} />
      </div>
    );
  }
  return (
    <img src={src} alt={alt} onError={() => setBroken(true)}
      className="w-9 h-9 rounded-lg object-cover border border-slate-100 flex-shrink-0" />
  );
}

export default function BranchRequisition() {
  const [branches, setBranches] = useState([]);
  const [logs, setLogs] = useState([]);
  const [itemInfo, setItemInfo] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  // เดือนนี้ตามเวลาไทย — 'YYYY-MM'
  const [monthFilter, setMonthFilter] = useState(() => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7));
  const [months, setMonths] = useState([]);
  const [warning, setWarning] = useState('');

  // ดึงทีละเดือนจาก SQL — เปลี่ยนเดือนแล้วโหลดใหม่ (ไม่ได้โหลดทุกเดือนมาเก็บไว้เหมือนตอนอ่านชีท)
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/branch-requisition?month=${encodeURIComponent(monthFilter)}`)
      .then(r => r.json())
      .then(res => {
        if (!alive) return;
        if (res.status === 'success') {
          // ตัดสาขาที่ไม่นับรวม (lib/excludedBranches.js) — ไม่ขึ้นเป็นคอลัมน์/ตัวกรอง และไม่รวมในยอด
          setBranches((res.data?.branches || []).filter(b => isIncludedBranch(b)));
          setLogs((res.data?.logs || []).filter(r => isIncludedBranch(r.branch)));
          setItemInfo(res.data?.itemInfo || {});
          setMonths(res.data?.months || []);
          setWarning(res.data?.warning || '');
          setError('');
        } else {
          setLogs([]); setBranches([]); setWarning('');
          setError(res.message || 'โหลดข้อมูลไม่สำเร็จ');
        }
      })
      .catch(err => { if (alive) { setLogs([]); setBranches([]); setWarning(''); setError(err.message); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [monthFilter]);

  const emptyInfo = { code: '', oldCode: '', unit: '', image: '', price: null, supplier: '' };

  // pivot ไอเทม × สาขา จาก log ของเดือนที่โหลดมา
  const items = useMemo(() => {
    const rows = logs;
    const map = {};
    rows.forEach(r => {
      if (!map[r.itemName]) {
        map[r.itemName] = {
          itemName: r.itemName,
          ...(itemInfo[r.itemName] || emptyInfo),
          total: 0,
          qtyByBranch: {},
          lastRequested: '',
        };
      }
      const it = map[r.itemName];
      it.total += r.qty;
      it.qtyByBranch[r.branch] = (it.qtyByBranch[r.branch] || 0) + r.qty;
      if (sortableTime(r.timestamp) > sortableTime(it.lastRequested)) it.lastRequested = r.timestamp;
    });
    return Object.values(map).sort((a, b) => a.itemName.localeCompare(b.itemName, 'th'));
  }, [logs, itemInfo]);

  const visibleBranches = useMemo(
    () => branchFilter ? branches.filter(b => b === branchFilter) : branches,
    [branches, branchFilter]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = items;
    if (branchFilter) list = list.filter(x => (x.qtyByBranch[branchFilter] || 0) > 0);
    if (!q) return list;
    return list.filter(x => x.itemName.toLowerCase().includes(q) || x.code.toLowerCase().includes(q));
  }, [items, search, branchFilter]);

  const grandTotal = useMemo(
    () => filtered.reduce((s, x) => s + (branchFilter ? (x.qtyByBranch[branchFilter] || 0) : x.total), 0),
    [filtered, branchFilter]
  );

  const branchTotals = useMemo(() => {
    const t = {};
    visibleBranches.forEach(b => { t[b] = filtered.reduce((s, x) => s + (x.qtyByBranch[b] || 0), 0); });
    return t;
  }, [filtered, visibleBranches]);

  const exportExcel = () => {
    if (!filtered.length) return;
    const wb = XLSX.utils.book_new();
    const head = ['รหัส', 'ชื่อ', 'หน่วย', 'ราคา', 'ซัพ', ...visibleBranches, 'รวม'];
    const aoa = [head];
    filtered.forEach(x => aoa.push([
      x.code, x.itemName, x.unit, x.price ?? '', x.supplier,
      ...visibleBranches.map(b => x.qtyByBranch[b] || 0),
      branchFilter ? (x.qtyByBranch[branchFilter] || 0) : x.total,
    ]));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 34 }, { wch: 8 }, { wch: 10 }, { wch: 10 },
      ...visibleBranches.map(() => ({ wch: 8 })), { wch: 10 }];
    for (let cIdx = 0; cIdx < head.length; cIdx++) {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c: cIdx })];
      if (cell) cell.s = HEAD_STYLE;
    }
    XLSX.utils.book_append_sheet(wb, ws, 'เบิกของสาขา');
    const suffix = monthFilter || new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `branch_requisition_${suffix}.xlsx`);
  };

  return (
    <div className="max-w-full mx-auto space-y-5">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-6 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-cyan-100 text-cyan-700 rounded-xl"><PackageOpen className="w-6 h-6" /></div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">เบิกของสาขา</h2>
              <p className="text-sm text-slate-500 mt-0.5">
                {filtered.length.toLocaleString()} รายการ · จำนวนเบิกรวม {fmtNum(grandTotal) || 0}
                {branchFilter && <span className="ml-1.5 text-cyan-600 font-semibold">· เฉพาะสาขา {branchFilter}</span>}
                <span className="ml-1.5 text-cyan-600 font-semibold">· เดือน{monthLabel(monthFilter)}</span>
              </p>
            </div>
          </div>
          <button onClick={exportExcel} disabled={loading || !filtered.length}
            className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
            <Download size={14} /> Export Excel
          </button>
        </div>

        <div className="p-4 flex flex-wrap gap-3 border-b border-slate-100">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหารหัส / ชื่อสินค้า…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500" />
          </div>
          <select value={branchFilter} onChange={e => setBranchFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500">
            <option value="">ทุกสาขา ({branches.length})</option>
            {branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <div className="flex items-center gap-2 bg-cyan-50/60 border border-cyan-100 rounded-xl px-3 py-1.5">
            <Calendar size={14} className="text-cyan-600 flex-shrink-0" />
            <select value={monthFilter} onChange={e => setMonthFilter(e.target.value)} disabled={loading}
              className="border-0 bg-transparent text-xs font-semibold text-cyan-700 focus:outline-none">
              {!months.includes(monthFilter) && <option value={monthFilter}>{monthLabel(monthFilter)}</option>}
              {months.map(mk => <option key={mk} value={mk}>{monthLabel(mk)}</option>)}
            </select>
          </div>
        </div>

        {error && (
          <div className="m-4 p-3 bg-rose-50 border border-rose-100 rounded-xl text-sm text-rose-700 flex items-center gap-2">
            <AlertCircle size={16} /><span>{error}</span>
          </div>
        )}
        {!error && warning && (
          <div className="m-4 p-3 bg-amber-50 border border-amber-100 rounded-xl text-sm text-amber-700 flex items-center gap-2">
            <AlertCircle size={16} /><span>{warning}</span>
          </div>
        )}

        <div className="overflow-auto max-h-[70vh]">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 sticky top-0 z-10 shadow-sm">
              <tr className="text-xs font-bold uppercase tracking-wide">
                <th className="px-3 py-3 text-left bg-slate-50">รูป</th>
                <th className="px-3 py-3 text-left bg-slate-50">รหัส</th>
                <th className="px-4 py-3 text-left bg-slate-50">ชื่อ</th>
                <th className="px-3 py-3 text-center bg-slate-50">หน่วย</th>
                <th className="px-3 py-3 text-right bg-slate-50">ราคา</th>
                <th className="px-3 py-3 text-left bg-slate-50">ซัพ</th>
                {visibleBranches.map(b => (
                  <th key={b} className="px-3 py-3 text-center whitespace-nowrap bg-slate-50">{b}</th>
                ))}
                <th className="px-4 py-3 text-right bg-slate-50">รวม</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={7 + visibleBranches.length} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />กำลังโหลดข้อมูล…
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7 + visibleBranches.length} className="px-4 py-10 text-center text-slate-400">ไม่พบรายการ</td></tr>
              ) : filtered.map(x => (
                <tr key={x.itemName} className="hover:bg-cyan-50/50 transition-colors">
                  <td className="px-3 py-2"><ItemImage src={x.image} alt={x.itemName} /></td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500 whitespace-nowrap">{x.code || '—'}</td>
                  <td className="px-4 py-2 text-slate-800 font-medium">{x.itemName}</td>
                  <td className="px-3 py-2 text-center text-slate-500 whitespace-nowrap">{x.unit || '—'}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{fmtMoney(x.price)}</td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{x.supplier || '—'}</td>
                  {visibleBranches.map(b => (
                    <td key={b} className="px-3 py-2 text-center font-mono">
                      {x.qtyByBranch[b] ? (
                        <span className="inline-block px-2 py-0.5 bg-cyan-50 text-cyan-700 rounded-full font-semibold">{fmtNum(x.qtyByBranch[b])}</span>
                      ) : <span className="text-slate-200">—</span>}
                    </td>
                  ))}
                  <td className="px-4 py-2 text-right font-mono font-bold text-slate-800">
                    {fmtNum(branchFilter ? (x.qtyByBranch[branchFilter] || 0) : x.total)}
                  </td>
                </tr>
              ))}
            </tbody>
            {!loading && filtered.length > 0 && (
              <tfoot className="bg-slate-50 border-t-2 border-slate-200">
                <tr className="text-xs font-bold text-slate-600">
                  <td colSpan={6} className="px-4 py-2.5 text-right">รวมทั้งหมด</td>
                  {visibleBranches.map(b => (
                    <td key={b} className="px-3 py-2.5 text-center font-mono">{fmtNum(branchTotals[b]) || '—'}</td>
                  ))}
                  <td className="px-4 py-2.5 text-right font-mono text-cyan-700">{fmtNum(grandTotal)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {!loading && (
          <div className="px-4 py-3 border-t border-slate-100 text-xs text-slate-400 flex items-center gap-2">
            <Info size={13} />
            จำนวนเบิก/รหัส/หน่วย/ราคา จากใบเบิกในฐานข้อมูล (หน้านับสต๊อกของสาขา) · รูปและซัพจากทะเบียนไอเทมในชีท data
          </div>
        )}
      </div>
    </div>
  );
}
