import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Calendar, Search, Loader2, AlertCircle, Download, RefreshCw, Database } from 'lucide-react';
import { toast } from 'react-hot-toast';
import * as XLSX from 'xlsx-js-style';

/*
 * NARAI OFFICE — STOCK → ดูข้อมูลปิดรอบเดือน
 *
 * ดูอย่างเดียว: แถวปิดรอบของเดือนที่เลือก จากตาราง dbo.stock_month_end (ฐาน InventoryNarai)
 * ผ่าน /api/stock-month-end ซึ่งไปได้ทั้งทางต่อ SQL ตรง และ host API ที่เครื่องออฟฟิศ
 *
 * ⚠️ คนละชุดกับ "ยอดยกมา (Endding)" ในหน้านับสต๊อก — ตัวนั้นมาจาก dbo.stock_closing
 *    (ย้ายมาจากชีท "ปิดรอบสิ้นเดือน") และคัดเฉพาะแถวล่าสุดของแต่ละไอเทม
 *    หน้านี้แสดงของเดือนที่เลือกตามที่เก็บไว้จริงทั้งหมด ไม่คัดทิ้ง
 *
 * ชื่อคอลัมน์จริงในตารางถูกจับคู่ที่ lib/monthEndSql.mjs ตอนอ่าน — ช่องไหนตารางไม่มี
 * (เช่น มูลค่า/หน่วย) จะขึ้นเป็น "-" ทั้งคอลัมน์ ไม่ใช่ข้อมูลหาย
 */

const fmt2 = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-';
};

/** 'YYYY-MM' -> 'สิงหาคม 2569' (ปี พ.ศ. ตามที่ใช้กันในออฟฟิศ) */
const monthLabel = (m) => {
  const mt = String(m || '').match(/^(\d{4})-(\d{2})$/);
  if (!mt) return String(m || '');
  const names = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
    'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  return `${names[Number(mt[2]) - 1] || mt[2]} ${Number(mt[1]) + 543}`;
};

const SORTS = {
  branch: { label: 'เรียงตามสาขา', cmp: (a, b) => a.branch.localeCompare(b.branch) || String(a.itemCode).localeCompare(String(b.itemCode)) },
  itemCode: { label: 'เรียงตามรหัสสินค้า', cmp: (a, b) => String(a.itemCode).localeCompare(String(b.itemCode)) },
  itemName: { label: 'เรียงตามชื่อสินค้า', cmp: (a, b) => String(a.itemName).localeCompare(String(b.itemName), 'th') },
  balance: { label: 'เรียงตามยอดคงเหลือ (มากไปน้อย)', cmp: (a, b) => (b.balance || 0) - (a.balance || 0) },
  totalValue: { label: 'เรียงตามมูลค่ารวม (มากไปน้อย)', cmp: (a, b) => (b.totalValue || 0) - (a.totalValue || 0) },
};

export default function MonthEndList() {
  const [month, setMonth] = useState('');        // '' = ให้ API เลือกเดือนล่าสุดให้
  const [branch, setBranch] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState('branch');

  const [data, setData] = useState({ month: '', months: [], branches: [], rows: [], layout: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // กดเปลี่ยนเดือนแล้วเปลี่ยนสาขาติด ๆ กัน คำตอบอาจกลับมาสลับลำดับ — เอาเฉพาะคำขอล่าสุดเท่านั้น
  const reqRef = useRef(0);

  const load = useCallback(async (wantMonth, wantBranch, { quiet = true } = {}) => {
    const req = ++reqRef.current;
    setLoading(true);
    setError('');
    try {
      const p = new URLSearchParams();
      if (wantMonth) p.set('month', wantMonth);
      if (wantBranch && wantBranch !== 'all') p.set('branch', wantBranch);
      const res = await fetch(`/api/stock-month-end${p.toString() ? `?${p}` : ''}`);
      const json = await res.json();
      if (json.status !== 'success') throw new Error(json.message || 'ดึงข้อมูลปิดรอบเดือนไม่สำเร็จ');
      if (req !== reqRef.current) return;

      setData(json.data);
      // เปิดหน้ามาครั้งแรกไม่ได้เลือกเดือน — จำเดือนที่ API เลือกให้ไว้ ปุ่ม/dropdown จะได้ตรงกัน
      if (!wantMonth && json.data.month) setMonth(json.data.month);
      if (!quiet) toast.success(`โหลดข้อมูลปิดรอบ ${monthLabel(json.data.month)} แล้ว`);
    } catch (err) {
      if (req !== reqRef.current) return;
      setError(err.message);
      setData((d) => ({ ...d, rows: [] }));
      if (!quiet) toast.error(err.message);
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load('', 'all'); }, [load]);

  const changeMonth = (m) => { setMonth(m); setBranch('all'); load(m, 'all'); };
  const changeBranch = (b) => { setBranch(b); load(month, b); };

  const rows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const filtered = data.rows.filter((r) => !term
      || String(r.itemCode).toLowerCase().includes(term)
      || String(r.itemName).toLowerCase().includes(term)
      || String(r.branch).toLowerCase().includes(term));
    return [...filtered].sort(SORTS[sortBy]?.cmp || SORTS.branch.cmp);
  }, [data.rows, searchTerm, sortBy]);

  const totals = useMemo(() => rows.reduce((acc, r) => ({
    balance: acc.balance + (Number(r.balance) || 0),
    value: acc.value + (Number(r.totalValue) || 0),
    branches: acc.branches.add(r.branch),
  }), { balance: 0, value: 0, branches: new Set() }), [rows]);

  // คอลัมน์ที่ตารางต้นทางไม่มีจริง ๆ — ซ่อนไปเลยดีกว่าโชว์ "-" ยาวทั้งคอลัมน์
  const has = (field) => Boolean(data.layout?.mapped?.[field]);

  const exportExcel = () => {
    if (rows.length === 0) { toast.error('ไม่มีรายการให้ export'); return; }
    const head = ['วันที่ปิดรอบ', 'สาขา', 'รหัสสินค้า', 'ชื่อสินค้า', 'หน่วย', 'ยอดคงเหลือ'];
    if (has('unitValue')) head.push('มูลค่า/หน่วย');
    if (has('totalValue')) head.push('มูลค่ารวม');
    if (has('recordedBy')) head.push('ผู้บันทึก');
    if (has('recordedAt')) head.push('เวลาบันทึก');

    const aoa = [head];
    rows.forEach((r) => {
      const line = [r.date, r.branch, String(r.itemCode || ''), r.itemName, r.unit, Number(r.balance) || 0];
      if (has('unitValue')) line.push(r.unitValue ?? '');
      if (has('totalValue')) line.push(r.totalValue ?? '');
      if (has('recordedBy')) line.push(r.recordedBy);
      if (has('recordedAt')) line.push(r.recordedAt);
      aoa.push(line);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 45 }, { wch: 8 }, { wch: 12 },
      ...head.slice(6).map(() => ({ wch: 14 }))];
    const headerStyle = {
      font: { name: 'Tahoma', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
      fill: { patternType: 'solid', fgColor: { rgb: '2E74B5' } },
    };
    head.forEach((_, c) => {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
      if (cell) cell.s = headerStyle;
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ปิดรอบเดือน');
    const suffix = branch === 'all' ? 'all' : branch.toUpperCase();
    XLSX.writeFile(wb, `stock_month_end_${data.month || 'latest'}_${suffix}.xlsx`);
    toast.success('Export สำเร็จ');
  };

  const branchOptions = data.branches.length ? data.branches : [];

  return (
    <div className="max-w-7xl mx-auto pb-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-3">
          <div className="p-2 bg-sky-100 text-sky-600 rounded-xl">
            <Calendar className="w-6 h-6" />
          </div>
          ดูข้อมูลปิดรอบเดือน
        </h1>
        <p className="text-gray-500 mt-1 ml-11 text-sm">
          ยอดปิดรอบของเดือนที่เลือก จากตาราง <span className="font-mono text-sky-700">dbo.stock_month_end</span> — ดูอย่างเดียว แก้ไขจากหน้านี้ไม่ได้
        </p>
      </div>

      {/* ตัวกรอง: เดือน · สาขา · ค้นหา · เรียงลำดับ */}
      <div className="flex flex-col md:flex-row gap-4 mb-4">
        <div className="flex items-center gap-2 bg-gradient-to-r from-sky-50 to-cyan-50 border border-sky-100 p-2 rounded-xl">
          <span className="text-sm font-medium text-gray-700 ml-2 whitespace-nowrap">เดือน :</span>
          <select
            value={month}
            onChange={(e) => changeMonth(e.target.value)}
            disabled={loading || data.months.length === 0}
            className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-sky-500 text-gray-700">
            {data.months.length === 0 && <option value="">— ไม่มีข้อมูล —</option>}
            {data.months.map((m) => (
              <option key={m} value={m}>{monthLabel(m)} ({m})</option>
            ))}
          </select>

          <span className="text-sm font-medium text-gray-700 whitespace-nowrap">สาขา :</span>
          <select
            value={branch}
            onChange={(e) => changeBranch(e.target.value)}
            disabled={loading || branchOptions.length === 0}
            className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-1 focus:ring-sky-500 text-gray-700">
            <option value="all">ทุกสาขา</option>
            {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>

          <button
            onClick={() => load(month, branch, { quiet: false })}
            disabled={loading}
            title="โหลดใหม่จากฐานข้อมูล"
            className="px-3 py-1.5 bg-sky-600 text-white text-sm rounded-lg hover:bg-sky-700 disabled:opacity-50 flex items-center gap-2 transition-colors">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          </button>
        </div>

        <div className="relative flex-1 flex gap-2">
          <div className="relative flex-1">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-gray-400" />
            </div>
            <input type="text"
              className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl bg-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500 sm:text-sm"
              placeholder="ค้นหาด้วยรหัส ชื่อสินค้า หรือสาขา..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="border border-gray-200 rounded-xl px-3 py-3 bg-white text-sm focus:outline-none focus:ring-1 focus:ring-sky-500 text-gray-700">
            {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
          </select>
        </div>

        <button
          onClick={exportExcel}
          disabled={loading || rows.length === 0}
          className="px-4 py-2 bg-emerald-600 text-white text-sm rounded-xl hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2 transition-colors whitespace-nowrap">
          <Download className="w-4 h-4" /> Export Excel
        </button>
      </div>

      {/* อ่านฐานไม่ได้ / ยังไม่มีตาราง — บอกข้อความจาก API ตรง ๆ เพราะมันบอกวิธีแก้มาด้วย */}
      {error && (
        <div className="mb-4 p-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-sm flex items-start gap-2">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap">{error}</span>
        </div>
      )}

      {/* สรุปหัวตาราง */}
      {!error && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <SummaryCard label="เดือนที่ปิดรอบ" value={data.month ? monthLabel(data.month) : '-'} tone="sky" />
          <SummaryCard label="จำนวนรายการ" value={rows.length.toLocaleString('th-TH')} tone="indigo" />
          <SummaryCard label="ยอดคงเหลือรวม" value={fmt2(totals.balance)} tone="emerald" />
          <SummaryCard
            label="มูลค่ารวม"
            value={has('totalValue') ? fmt2(totals.value) : '—'}
            tone="amber"
            note={has('totalValue') ? `${totals.branches.size} สาขา` : 'ตารางไม่มีคอลัมน์มูลค่า'} />
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-sky-100 overflow-hidden">
        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center text-sky-600">
            <Loader2 className="w-10 h-10 animate-spin mb-4" />
            <p className="font-medium text-sm">กำลังโหลดข้อมูลปิดรอบเดือน...</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-28">วันที่ปิดรอบ</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-20">สาขา</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-28">รหัสสินค้า</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ชื่อสินค้า</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-16">หน่วย</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-emerald-600 uppercase w-32 bg-emerald-50/60">ยอดคงเหลือ</th>
                  {has('unitValue') && <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase w-28">มูลค่า/หน่วย</th>}
                  {has('totalValue') && <th className="px-4 py-3 text-right text-xs font-semibold text-amber-600 uppercase w-32 bg-amber-50/60">มูลค่ารวม</th>}
                  {has('recordedBy') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-32">ผู้บันทึก</th>}
                  {has('recordedAt') && <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-36">เวลาบันทึก</th>}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-100">
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-6 py-12 text-center text-gray-400">
                      <AlertCircle className="w-8 h-8 mx-auto mb-2" />
                      {error ? 'อ่านข้อมูลจากฐานไม่ได้' : 'ไม่พบรายการปิดรอบของเดือนนี้'}
                    </td>
                  </tr>
                ) : rows.map((r, i) => (
                  <tr key={`${r.branch}|${r.itemKey}|${r.date}|${i}`} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">{r.date || '-'}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs font-semibold text-sky-700">{r.branch || '-'}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs font-mono text-gray-600">{r.itemCode || r.itemKey || '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-800 font-medium">{r.itemName || '-'}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">{r.unit || '-'}</td>
                    <td className={`px-4 py-3 text-right text-sm font-semibold bg-emerald-50/30 ${Number(r.balance) < 0 ? 'text-rose-500' : 'text-emerald-700'}`}>
                      {fmt2(r.balance)}
                    </td>
                    {has('unitValue') && <td className="px-4 py-3 text-right text-xs text-gray-600">{fmt2(r.unitValue)}</td>}
                    {has('totalValue') && <td className="px-4 py-3 text-right text-sm font-semibold text-amber-700 bg-amber-50/30">{fmt2(r.totalValue)}</td>}
                    {has('recordedBy') && <td className="px-4 py-3 text-xs text-gray-500">{r.recordedBy || '-'}</td>}
                    {has('recordedAt') && <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{r.recordedAt || '-'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ผังคอลัมน์ที่ใช้จริง — ชื่อคอลัมน์ในตารางต่างจากที่หน้านี้ตั้งชื่อไว้ ดูตรงนี้ได้ว่าอันไหนคืออันไหน */}
      {data.layout && (
        <details className="mt-4 bg-white border border-gray-100 rounded-xl p-4 text-xs text-gray-500">
          <summary className="cursor-pointer font-medium text-gray-600 flex items-center gap-2">
            <Database size={14} /> คอลัมน์ที่อ่านมาจาก {data.layout.table}
          </summary>
          <div className="mt-3 space-y-1">
            {Object.entries(data.layout.mapped).map(([field, col]) => (
              <div key={field}><span className="font-mono text-sky-700">{col}</span> → {field}</div>
            ))}
            <div className="pt-2 text-gray-400">
              คอลัมน์ทั้งหมดในตาราง: <span className="font-mono">{(data.layout.tableColumns || []).join(', ')}</span>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone, note }) {
  const tones = {
    sky: 'from-sky-50 to-cyan-50 border-sky-100 text-sky-700',
    indigo: 'from-indigo-50 to-violet-50 border-indigo-100 text-indigo-700',
    emerald: 'from-emerald-50 to-teal-50 border-emerald-100 text-emerald-700',
    amber: 'from-amber-50 to-orange-50 border-amber-100 text-amber-700',
  };
  return (
    <div className={`bg-gradient-to-r ${tones[tone] || tones.sky} border rounded-xl p-3`}>
      <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="text-lg font-bold mt-0.5">{value}</div>
      {note && <div className="text-[11px] text-gray-400 mt-0.5">{note}</div>}
    </div>
  );
}
