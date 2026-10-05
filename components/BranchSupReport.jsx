import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Search, Loader2, AlertCircle, Download, Store, Package, X, CalendarDays, ChevronDown, ChevronRight,
} from 'lucide-react';
import * as XLSX from 'xlsx-js-style';
import { useBranches } from '../lib/useBranches';

/*
 * NARAI OFFICE — ACC → รายงานจากซัพหน้าสาขา
 *
 * สรุปของที่สาขาซื้อเองหน้าร้าน (ซัพพลายเออร์ / ผัก, ผลไม้) ตามช่วงวันที่
 * ข้อมูลจากชีท "ต้นทุนจากsup" ที่สาขากรอกผ่านหน้า "กรอกรายจ่าย" ของ Narai-branch
 * อ่านผ่าน /api/sup-cost (ดูอย่างเดียว)
 *
 * สองมุมมอง สลับด้วยปุ่มเหนือตาราง:
 *   รายสาขา  -> กดสาขา  -> รวมตามสินค้า / แยกตามวัน
 *   รายไอเทม -> กดสินค้า -> แยกตามสาขา / แยกตามวัน
 */

const baht = (n) =>
  '฿' + (Number(n) || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (n) => (Number(n) || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const sumBy = (rows, k = 'amount') => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const thDate = (s) => {
  const [y, m, d] = String(s || '').split('-');
  return y ? `${+d}/${+m}/${+y + 543}` : '';
};
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const CAT_LABEL = { sup: 'ซัพพลายเออร์', veg: 'ผัก, ผลไม้' };
const CatBadge = ({ cat, short }) => (
  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${
    cat === 'veg' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
  }`}>
    {short ? (cat === 'veg' ? 'ผัก' : 'ซัพ') : CAT_LABEL[cat]}
  </span>
);

function quickRange(key) {
  const t = new Date();
  if (key === 'today') return [ymd(t), ymd(t)];
  if (key === '7') { const f = new Date(t); f.setDate(f.getDate() - 6); return [ymd(f), ymd(t)]; }
  if (key === 'last') {
    const e = new Date(t.getFullYear(), t.getMonth(), 0);
    return [ymd(new Date(e.getFullYear(), e.getMonth(), 1)), ymd(e)];
  }
  return [ymd(new Date(t.getFullYear(), t.getMonth(), 1)), ymd(t)]; // month
}
const QUICK = [
  { key: 'today', label: 'วันนี้' },
  { key: '7', label: '7 วันล่าสุด' },
  { key: 'month', label: 'เดือนนี้' },
  { key: 'last', label: 'เดือนก่อน' },
];

/** รวมแถวตามรหัสสินค้า — ใช้ทั้งตารางรายไอเทมและรายละเอียดของสาขา */
function groupItems(rows) {
  const m = {};
  rows.forEach((r) => {
    const e = m[r.code] || (m[r.code] = {
      code: r.code, name: r.name, unit: r.unit, cat: r.cat, qty: 0, amount: 0, by: {},
    });
    e.qty += r.qty;
    e.amount += r.amount;
    e.by[r.branch] = (e.by[r.branch] || 0) + r.amount;
  });
  return Object.values(m).sort((a, b) => b.amount - a.amount);
}

const Chip = ({ on, children, ...p }) => (
  <button
    type="button"
    {...p}
    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
      on ? 'bg-amber-500 border-amber-500 text-white' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
    }`}
  >
    {children}
  </button>
);

const Kpi = ({ label, value, main }) => (
  <div className={`rounded-xl p-4 border ${
    main ? 'bg-gradient-to-br from-amber-500 to-orange-500 border-transparent text-white' : 'bg-white border-slate-200'
  }`}>
    <div className={`text-xs font-semibold ${main ? 'text-amber-50' : 'text-slate-500'}`}>{label}</div>
    <div className="text-xl md:text-2xl font-bold mt-1 tabular-nums">{value}</div>
  </div>
);

const TH = 'px-3 py-2 text-xs font-semibold text-slate-500 bg-slate-50 border-b border-slate-200 whitespace-nowrap';
const TD = 'px-3 py-2.5 border-b border-slate-100 whitespace-nowrap';

export default function BranchSupReport() {
  const { codes: branchCodes } = useBranches();
  const [range, setRange] = useState(() => quickRange('month'));
  const [quick, setQuick] = useState('month');
  const [branch, setBranch] = useState('');
  const [cat, setCat] = useState('');
  const [mode, setMode] = useState('branch'); // branch | item
  const [search, setSearch] = useState('');

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadedRange, setLoadedRange] = useState(null);

  const [detail, setDetail] = useState(null); // { type: 'branch'|'item', key }
  const [detailView, setDetailView] = useState('');

  const load = useCallback(async (from, to) => {
    if (!from || !to) return;
    if (from > to) { setError('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด'); return; }
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`/api/sup-cost?start=${from}&end=${to}`);
      const res = await r.json();
      if (res.status !== 'success') throw new Error(res.message || 'โหลดข้อมูลไม่สำเร็จ');
      setRows(res.data || []);
      setLoadedRange([from, to]);
    } catch (e) {
      setError(e.message);
      setRows([]);
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

  // ตัวกรองสาขา/หมวดทำฝั่งหน้าเว็บ — เปลี่ยนแล้วเห็นผลทันทีไม่ต้องโหลดชีทใหม่
  const filtered = useMemo(
    () => rows.filter((r) => (!branch || r.branch === branch) && (!cat || r.cat === cat)),
    [rows, branch, cat],
  );
  const supRows = useMemo(() => filtered.filter((r) => r.cat === 'sup'), [filtered]);
  const vegRows = useMemo(() => filtered.filter((r) => r.cat === 'veg'), [filtered]);

  const branchSummary = useMemo(() => {
    const by = {};
    filtered.forEach((r) => {
      const e = by[r.branch] || (by[r.branch] = { branch: r.branch, sup: 0, veg: 0, days: new Set(), n: 0 });
      e[r.cat] += r.amount;
      e.days.add(r.date);
      e.n += 1;
    });
    return Object.values(by).sort((a, b) => (b.sup + b.veg) - (a.sup + a.veg));
  }, [filtered]);

  const itemSummary = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groupItems(filtered).filter((r) => !q || r.name.toLowerCase().includes(q) || r.code.includes(q));
  }, [filtered, search]);
  const itemBranches = useMemo(() => [...new Set(filtered.map((r) => r.branch))].sort(), [filtered]);

  // สาขาใน dropdown: ทะเบียนสาขา + สาขาที่มีในข้อมูลจริง (เผื่อรหัสในชีทไม่ตรงทะเบียน)
  const branchOptions = useMemo(() => {
    const set = new Set(branchCodes.map((c) => String(c).toLowerCase()));
    rows.forEach((r) => set.add(r.branch));
    return [...set].filter(Boolean).sort();
  }, [branchCodes, rows]);

  const detailRows = useMemo(() => {
    if (!detail) return [];
    return filtered.filter((r) => (detail.type === 'branch' ? r.branch === detail.key : r.code === detail.key));
  }, [detail, filtered]);

  const openBranch = (b) => { setDetail({ type: 'branch', key: b }); setDetailView('item'); };
  const openItem = (code) => { setDetail({ type: 'item', key: code }); setDetailView('branch'); };

  const exportExcel = () => {
    if (!filtered.length) return;
    const wb = XLSX.utils.book_new();
    const sumSheet = mode === 'branch'
      ? branchSummary.map((b) => ({
        'สาขา': b.branch.toUpperCase(),
        'ซัพพลายเออร์': +b.sup.toFixed(2),
        'ผัก, ผลไม้': +b.veg.toFixed(2),
        'ยอดรวม': +(b.sup + b.veg).toFixed(2),
        'วันที่กรอก': b.days.size,
        'รายการ': b.n,
      }))
      : itemSummary.map((it) => ({
        'รหัส': it.code,
        'รายการ': it.name,
        'หมวด': CAT_LABEL[it.cat],
        'จำนวนรวม': it.qty,
        'หน่วย': it.unit,
        'ราคาเฉลี่ย/หน่วย': it.qty ? +(it.amount / it.qty).toFixed(2) : 0,
        ...Object.fromEntries(itemBranches.map((b) => [b.toUpperCase(), +(it.by[b] || 0).toFixed(2)])),
        'ยอดรวม': +it.amount.toFixed(2),
      }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sumSheet), mode === 'branch' ? 'สรุปรายสาขา' : 'สรุปรายไอเทม');
    const raw = [...filtered]
      .sort((a, b) => a.date.localeCompare(b.date) || a.branch.localeCompare(b.branch))
      .map((r) => ({
        'วันที่': r.date, 'สาขา': r.branch.toUpperCase(), 'หมวด': CAT_LABEL[r.cat], 'รหัส': r.code,
        'รายการ': r.name, 'หน่วย': r.unit, 'จำนวน': r.qty, 'ราคา/หน่วย': r.price, 'มูลค่า': r.amount,
        'ผู้บันทึก': r.recorder, 'เวลาบันทึก': r.savedAt, 'เวลาแก้ไข': r.editedAt,
      }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(raw), 'รายการทั้งหมด');
    const [f, t] = loadedRange || range;
    XLSX.writeFile(wb, `รายงานจากซัพหน้าสาขา_${f}_${t}.xlsx`);
  };

  const rangeText = loadedRange ? `${thDate(loadedRange[0])} – ${thDate(loadedRange[1])}` : '';

  return (
    <div className="space-y-4">
      {/* ตัวกรอง */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1">ตั้งแต่วันที่</label>
            <input
              type="date" value={range[0]}
              onChange={(e) => { setRange([e.target.value, range[1]]); setQuick(''); }}
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1">ถึงวันที่</label>
            <input
              type="date" value={range[1]}
              onChange={(e) => { setRange([range[0], e.target.value]); setQuick(''); }}
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1">สาขา</label>
            <select value={branch} onChange={(e) => setBranch(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white">
              <option value="">ทุกสาขา</option>
              {branchOptions.map((b) => <option key={b} value={b}>{b.toUpperCase()}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1">หมวด</label>
            <select value={cat} onChange={(e) => setCat(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white">
              <option value="">ทั้งหมด</option>
              <option value="sup">ซัพพลายเออร์</option>
              <option value="veg">ผัก, ผลไม้</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1">เลือกเร็ว</label>
            <div className="flex flex-wrap gap-1.5">
              {QUICK.map((q) => <Chip key={q.key} on={quick === q.key} onClick={() => pickQuick(q.key)}>{q.label}</Chip>)}
            </div>
          </div>
          <div className="flex gap-2 ml-auto">
            <button type="button" onClick={exportExcel} disabled={!filtered.length}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-amber-500 text-amber-600 text-sm font-semibold hover:bg-amber-50 disabled:opacity-40">
              <Download size={16} /> Excel
            </button>
            <button type="button" onClick={() => load(...range)} disabled={loading}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-semibold hover:bg-amber-600 disabled:opacity-60">
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />} ดูรายงาน
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm">
          <AlertCircle size={18} /> {error}
        </div>
      )}

      {/* การ์ดสรุป */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi main label="ยอดรวมทั้งหมด" value={baht(sumBy(filtered))} />
        <Kpi label="ซัพพลายเออร์" value={baht(sumBy(supRows))} />
        <Kpi label="ผัก, ผลไม้" value={baht(sumBy(vegRows))} />
        <Kpi label="สาขาที่กรอก / รายการ" value={`${new Set(filtered.map((r) => r.branch)).size} / ${filtered.length}`} />
      </div>

      {/* ตาราง */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-bold text-slate-800">{mode === 'branch' ? 'สรุปรายสาขา' : 'สรุปรายไอเทม'}</h2>
            <Chip on={mode === 'branch'} onClick={() => setMode('branch')}>
              <span className="inline-flex items-center gap-1"><Store size={14} /> รายสาขา</span>
            </Chip>
            <Chip on={mode === 'item'} onClick={() => setMode('item')}>
              <span className="inline-flex items-center gap-1"><Package size={14} /> รายไอเทม</span>
            </Chip>
            {mode === 'item' && (
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาชื่อ/รหัสสินค้า"
                className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm w-52" />
            )}
          </div>
          <span className="text-sm text-slate-500">{rangeText}</span>
        </div>

        <div className="overflow-x-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-slate-400">
              <Loader2 className="animate-spin" size={20} /> กำลังโหลดข้อมูลจากชีท...
            </div>
          ) : mode === 'branch' ? (
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr>
                  <th className={`${TH} text-left`}>สาขา</th>
                  <th className={`${TH} text-right`}>ซัพพลายเออร์</th>
                  <th className={`${TH} text-right`}>ผัก, ผลไม้</th>
                  <th className={`${TH} text-right`}>ยอดรวม</th>
                  <th className={`${TH} text-right`}>วันที่กรอก</th>
                  <th className={`${TH} text-right`}>รายการ</th>
                  <th className={TH} />
                </tr>
              </thead>
              <tbody>
                {branchSummary.map((b) => {
                  const t = b.sup + b.veg;
                  return (
                    <tr key={b.branch} onClick={() => openBranch(b.branch)} className="cursor-pointer hover:bg-amber-50">
                      <td className={TD}>
                        <div className="font-bold uppercase">{b.branch}</div>
                        <div className="flex h-1.5 w-28 rounded bg-slate-200 overflow-hidden mt-1">
                          <div className="bg-amber-400" style={{ width: `${t ? (b.sup / t) * 100 : 0}%` }} />
                          <div className="bg-green-500" style={{ width: `${t ? (b.veg / t) * 100 : 0}%` }} />
                        </div>
                      </td>
                      <td className={`${TD} text-right`}>{baht(b.sup)}</td>
                      <td className={`${TD} text-right`}>{baht(b.veg)}</td>
                      <td className={`${TD} text-right font-bold`}>{baht(t)}</td>
                      <td className={`${TD} text-right`}>{b.days.size} วัน</td>
                      <td className={`${TD} text-right`}>{b.n}</td>
                      <td className={`${TD} text-right text-amber-600 font-semibold`}>ดูรายละเอียด ›</td>
                    </tr>
                  );
                })}
                {!branchSummary.length && <EmptyRow cols={7} />}
              </tbody>
              {!!branchSummary.length && (
                <tfoot className="font-bold bg-slate-50">
                  <tr>
                    <td className="px-3 py-2.5">รวม</td>
                    <td className="px-3 py-2.5 text-right">{baht(sumBy(supRows))}</td>
                    <td className="px-3 py-2.5 text-right">{baht(sumBy(vegRows))}</td>
                    <td className="px-3 py-2.5 text-right">{baht(sumBy(filtered))}</td>
                    <td />
                    <td className="px-3 py-2.5 text-right">{filtered.length}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          ) : (
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr>
                  <th className={`${TH} text-left`}>รหัส</th>
                  <th className={`${TH} text-left`}>รายการ</th>
                  <th className={`${TH} text-left`}>หมวด</th>
                  <th className={`${TH} text-right`}>จำนวนรวม</th>
                  <th className={`${TH} text-right`}>ราคาเฉลี่ย</th>
                  {itemBranches.map((b) => <th key={b} className={`${TH} text-right uppercase`}>{b}</th>)}
                  <th className={`${TH} text-right`}>ยอดรวม</th>
                  <th className={TH} />
                </tr>
              </thead>
              <tbody>
                {itemSummary.map((it) => (
                  <tr key={it.code} onClick={() => openItem(it.code)} className="cursor-pointer hover:bg-amber-50">
                    <td className={`${TD} text-slate-500`}>{it.code}</td>
                    <td className={TD}>{it.name}</td>
                    <td className={TD}><CatBadge cat={it.cat} short /></td>
                    <td className={`${TD} text-right`}>{qtyFmt(it.qty)} {it.unit}</td>
                    <td className={`${TD} text-right`}>{baht(it.qty ? it.amount / it.qty : 0)}</td>
                    {itemBranches.map((b) => (
                      <td key={b} className={`${TD} text-right`}>
                        {it.by[b] ? baht(it.by[b]) : <span className="text-slate-300">-</span>}
                      </td>
                    ))}
                    <td className={`${TD} text-right font-bold`}>{baht(it.amount)}</td>
                    <td className={`${TD} text-right text-amber-600 font-semibold`}>ดูรายละเอียด ›</td>
                  </tr>
                ))}
                {!itemSummary.length && <EmptyRow cols={7 + itemBranches.length} />}
              </tbody>
              {!!itemSummary.length && (
                <tfoot className="font-bold bg-slate-50">
                  <tr>
                    <td className="px-3 py-2.5" colSpan={5}>รวม {itemSummary.length} รายการ</td>
                    {itemBranches.map((b) => (
                      <td key={b} className="px-3 py-2.5 text-right">
                        {baht(itemSummary.reduce((s, it) => s + (it.by[b] || 0), 0))}
                      </td>
                    ))}
                    <td className="px-3 py-2.5 text-right">{baht(sumBy(itemSummary))}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
        <div className="text-xs text-slate-400 mt-2">
          👆 {mode === 'branch' ? 'กดที่แถวสาขาเพื่อดูรายละเอียด' : 'กดที่แถวสินค้าเพื่อดูว่าแต่ละสาขาซื้อเท่าไร'}
          {' · '}ข้อมูลจากชีท &quot;ต้นทุนจากsup&quot; ที่สาขากรอกในหน้า &quot;กรอกรายจ่าย&quot;
        </div>
      </div>

      {detail && (
        <DetailDrawer
          detail={detail}
          rows={detailRows}
          view={detailView}
          setView={setDetailView}
          rangeText={rangeText}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function EmptyRow({ cols }) {
  return (
    <tr>
      <td colSpan={cols} className="text-center text-slate-400 py-12">ไม่มีข้อมูลในช่วงวันที่นี้</td>
    </tr>
  );
}

/** วันที่กรอก/แก้ไขของแถว — ใช้ในรายละเอียดทุกจุดที่แสดงรายการทีละแถว */
function EntryMeta({ r }) {
  if (!r.recorder && !r.savedAt) return null;
  return (
    <div className="text-xs text-slate-400">
      {r.recorder && <>โดย {r.recorder}</>}
      {r.savedAt && <> · บันทึก {r.savedAt}</>}
      {r.editedAt && <span className="text-amber-600"> · แก้ไข {r.editedAt}</span>}
    </div>
  );
}

function DetailDrawer({ detail, rows, view, setView, rangeText, onClose }) {
  // แท็บ "แยกตามสาขา" ของสินค้า: กดสาขาเพื่อกางดูทีละวันที่กรอก
  const [openBr, setOpenBr] = useState(null);
  // แท็บ "รวมตามสินค้า" ของสาขา: กดสินค้าเพื่อกางดูทีละวันที่กรอก
  const [openCode, setOpenCode] = useState(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isBranch = detail.type === 'branch';
  const first = rows[0] || {};
  const total = sumBy(rows);
  const totalQty = sumBy(rows, 'qty');
  const tabs = isBranch
    ? [{ key: 'item', label: 'รวมตามสินค้า' }, { key: 'day', label: 'แยกตามวัน' }]
    : [{ key: 'branch', label: 'แยกตามสาขา' }, { key: 'day', label: 'แยกตามวัน' }];
  const days = [...new Set(rows.map((r) => r.date))].sort().reverse();

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div className="w-full max-w-3xl h-full bg-white overflow-y-auto p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start">
          <div>
            <h2 className="text-xl font-bold text-slate-800">
              {isBranch ? `สาขา ${detail.key.toUpperCase()}` : `${first.name || ''} (${detail.key})`}
            </h2>
            <div className="text-sm text-slate-500">
              {rangeText} · {isBranch
                ? `${rows.length} รายการ`
                : `${new Set(rows.map((r) => r.branch)).size} สาขา · หน่วย: ${first.unit || '-'}`}
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600"><X size={22} /></button>
        </div>

        <div className="grid grid-cols-3 gap-3 my-4">
          <Kpi main label="ยอดรวม" value={baht(total)} />
          {isBranch ? (
            <>
              <Kpi label="ซัพพลายเออร์" value={baht(sumBy(rows.filter((r) => r.cat === 'sup')))} />
              <Kpi label="ผัก, ผลไม้" value={baht(sumBy(rows.filter((r) => r.cat === 'veg')))} />
            </>
          ) : (
            <>
              <Kpi label="จำนวนรวม" value={`${qtyFmt(totalQty)} ${first.unit || ''}`} />
              <Kpi label="ราคาเฉลี่ย/หน่วย" value={baht(totalQty ? total / totalQty : 0)} />
            </>
          )}
        </div>

        <div className="flex gap-1.5 mb-3">
          {tabs.map((t) => <Chip key={t.key} on={view === t.key} onClick={() => setView(t.key)}>{t.label}</Chip>)}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            {view === 'item' && (
              <>
                <thead>
                  <tr>
                    <th className={`${TH} text-left`}>รหัส</th>
                    <th className={`${TH} text-left`}>รายการ <span className="font-normal text-slate-400">(กดเพื่อดูวันที่กรอก)</span></th>
                    <th className={`${TH} text-left`}>หมวด</th>
                    <th className={`${TH} text-right`}>จำนวนรวม</th>
                    <th className={`${TH} text-right`}>ราคาเฉลี่ย/หน่วย</th>
                    <th className={`${TH} text-right`}>มูลค่า</th>
                  </tr>
                </thead>
                <tbody>
                  {groupItems(rows).map((it) => {
                    const open = openCode === it.code;
                    const entries = open
                      ? rows.filter((r) => r.code === it.code).sort((x, y) => y.date.localeCompare(x.date))
                      : [];
                    return [
                      <tr key={it.code} onClick={() => setOpenCode(open ? null : it.code)}
                        className={`cursor-pointer ${open ? 'bg-amber-50' : 'hover:bg-amber-50'}`}>
                        <td className={`${TD} text-slate-500`}>
                          <span className="inline-flex items-center gap-1">
                            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {it.code}
                          </span>
                        </td>
                        <td className={TD}>{it.name}</td>
                        <td className={TD}><CatBadge cat={it.cat} short /></td>
                        <td className={`${TD} text-right`}>{qtyFmt(it.qty)} {it.unit}</td>
                        <td className={`${TD} text-right`}>{baht(it.qty ? it.amount / it.qty : 0)}</td>
                        <td className={`${TD} text-right font-bold`}>{baht(it.amount)}</td>
                      </tr>,
                      ...entries.map((r, i) => (
                        <tr key={`${it.code}-${i}`} className="bg-amber-50/40 text-slate-600">
                          <td className="px-3 py-2 pl-9 border-b border-slate-100" colSpan={3}>
                            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                              <CalendarDays size={13} /> {thDate(r.date)}
                            </span>
                            <EntryMeta r={r} />
                          </td>
                          <td className="px-3 py-2 text-right border-b border-slate-100 whitespace-nowrap">{qtyFmt(r.qty)} {r.unit}</td>
                          <td className="px-3 py-2 text-right border-b border-slate-100 whitespace-nowrap">{baht(r.price)}</td>
                          <td className="px-3 py-2 text-right border-b border-slate-100 whitespace-nowrap">{baht(r.amount)}</td>
                        </tr>
                      )),
                    ];
                  })}
                </tbody>
                <tfoot className="font-bold bg-slate-50">
                  <tr><td className="px-3 py-2.5" colSpan={5}>รวม</td><td className="px-3 py-2.5 text-right">{baht(total)}</td></tr>
                </tfoot>
              </>
            )}

            {view === 'branch' && (() => {
              const m = {};
              rows.forEach((r) => {
                const e = m[r.branch] || (m[r.branch] = { qty: 0, amount: 0, days: new Set() });
                e.qty += r.qty; e.amount += r.amount; e.days.add(r.date);
              });
              const list = Object.entries(m).sort((a, b) => b[1].amount - a[1].amount);
              return (
                <>
                  <thead>
                    <tr>
                      <th className={`${TH} text-left`}>สาขา <span className="font-normal text-slate-400">(กดเพื่อดูวันที่กรอก)</span></th>
                      <th className={`${TH} text-right`}>จำนวนรวม</th>
                      <th className={`${TH} text-right`}>ราคาเฉลี่ย/หน่วย</th>
                      <th className={`${TH} text-right`}>วันที่ซื้อ</th>
                      <th className={`${TH} text-right`}>มูลค่า</th>
                      <th className={`${TH} text-right`}>สัดส่วน</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map(([b, v]) => {
                      const open = openBr === b;
                      const entries = open
                        ? rows.filter((r) => r.branch === b).sort((x, y) => y.date.localeCompare(x.date))
                        : [];
                      return [
                        <tr key={b} onClick={() => setOpenBr(open ? null : b)}
                          className={`cursor-pointer ${open ? 'bg-amber-50' : 'hover:bg-amber-50'}`}>
                          <td className={`${TD} font-bold uppercase`}>
                            <span className="inline-flex items-center gap-1">
                              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {b}
                            </span>
                          </td>
                          <td className={`${TD} text-right`}>{qtyFmt(v.qty)} {first.unit}</td>
                          <td className={`${TD} text-right`}>{baht(v.qty ? v.amount / v.qty : 0)}</td>
                          <td className={`${TD} text-right`}>{v.days.size} วัน</td>
                          <td className={`${TD} text-right font-bold`}>{baht(v.amount)}</td>
                          <td className={`${TD} text-right`}>{total ? ((v.amount / total) * 100).toFixed(1) : '0.0'}%</td>
                        </tr>,
                        ...entries.map((r, i) => (
                          <tr key={`${b}-${i}`} className="bg-amber-50/40 text-slate-600">
                            <td className="px-3 py-2 pl-9 border-b border-slate-100">
                              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                                <CalendarDays size={13} /> {thDate(r.date)}
                              </span>
                              <EntryMeta r={r} />
                            </td>
                            <td className="px-3 py-2 text-right border-b border-slate-100 whitespace-nowrap">{qtyFmt(r.qty)} {r.unit}</td>
                            <td className="px-3 py-2 text-right border-b border-slate-100 whitespace-nowrap">{baht(r.price)}</td>
                            <td className="border-b border-slate-100" />
                            <td className="px-3 py-2 text-right border-b border-slate-100 whitespace-nowrap">{baht(r.amount)}</td>
                            <td className="border-b border-slate-100" />
                          </tr>
                        )),
                      ];
                    })}
                  </tbody>
                  <tfoot className="font-bold bg-slate-50">
                    <tr>
                      <td className="px-3 py-2.5">รวม</td>
                      <td className="px-3 py-2.5 text-right">{qtyFmt(totalQty)} {first.unit}</td>
                      <td /><td />
                      <td className="px-3 py-2.5 text-right">{baht(total)}</td>
                      <td className="px-3 py-2.5 text-right">100%</td>
                    </tr>
                  </tfoot>
                </>
              );
            })()}

            {view === 'day' && (
              <>
                <thead>
                  <tr>
                    <th className={`${TH} text-left`}>{isBranch ? 'รายการ' : 'สาขา'}</th>
                    <th className={`${TH} text-right`}>จำนวน</th>
                    <th className={`${TH} text-right`}>ราคา/หน่วย</th>
                    <th className={`${TH} text-right`}>มูลค่า</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => {
                    const rs = rows.filter((r) => r.date === d);
                    return [
                      <tr key={d} className="bg-slate-50 font-bold">
                        <td className="px-3 py-2" colSpan={3}>
                          <span className="inline-flex items-center gap-1.5"><CalendarDays size={14} /> {thDate(d)}</span>
                        </td>
                        <td className="px-3 py-2 text-right">{baht(sumBy(rs))}</td>
                      </tr>,
                      ...rs.map((r, i) => (
                        <tr key={`${d}-${i}`}>
                          <td className={TD}>
                            {isBranch ? (
                              <span className="inline-flex items-center gap-2">
                                <CatBadge cat={r.cat} short /> {r.name} <span className="text-slate-400">{r.code}</span>
                              </span>
                            ) : <span className="font-bold uppercase">{r.branch}</span>}
                            <EntryMeta r={r} />
                          </td>
                          <td className={`${TD} text-right`}>{qtyFmt(r.qty)} {r.unit}</td>
                          <td className={`${TD} text-right`}>{baht(r.price)}</td>
                          <td className={`${TD} text-right`}>{baht(r.amount)}</td>
                        </tr>
                      )),
                    ];
                  })}
                </tbody>
              </>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

