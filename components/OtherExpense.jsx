import React, { useState, useMemo, useEffect } from 'react';
import { DollarSign, Save, Building2, Calendar, Info, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { apiCall } from '../lib/expenseApi';

/*
 * NARAI OFFICE — ค่าใช้จ่ายอื่นๆ
 * เลือกสาขา + เดือน แล้วกรอกค่าใช้จ่ายแต่ละประเภท (เลขเริ่มต้น/สิ้นสุด + ราคา/หน่วย)
 * จำนวน = เริ่มต้น − สิ้นสุด (E−F) · ผลรวม = จำนวน × ราคา/หน่วย
 *
 * ข้อมูลผ่าน Google Apps Script (ผูกกับชีท 1YXOaA…) → proxy /api/expense-gas:
 *  - getExpenseRefs  : อ่านชีท "ข้อมูลค่าใช้อื่น" (A=ประเภท, B=สาขา, C=รหัส)
 *  - saveOtherExpense: เขียนชีท "ค่าใช้จ่ายอื่น" (A=เดือน B=ประเภท C=สาขา D=รหัส E=เริ่ม F=สิ้นสุด G=จำนวน H=ราคา/หน่วย I=ผลรวม)
 */

const EXPENSE_TYPES = ['ค่าเช่าพื้นที่', 'ไฟฟ้า', 'น้ำประปา', 'แก็ส', 'tel'];

// รายชื่อสาขาสำรอง (ใช้ตอนยังต่อ GAS ไม่ได้) — เฟสจริงดึงจากชีท "ข้อมูลค่าใช้อื่น" คอลัมน์ B
const FALLBACK_BRANCHES = [
  'SJP', 'CRM', 'XCM', 'SLR', 'SUM', 'XUM', 'SCS', 'SMP', 'XSB', 'XHH',
  'HRS', 'CLK', 'P90', 'HPS', 'ZBW', 'ZPT', 'NPT', 'WRM', 'WMT', 'IPR', 'ZK3',
];

const fmt = v => {
  const n = parseFloat(v);
  return isNaN(n) ? '0.00' : n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const refKey = (type, branch) => `${String(type).trim()}||${String(branch).trim()}`;

export default function OtherExpense() {
  const [month, setMonth] = useState(thisMonth());
  const [branch, setBranch] = useState('');
  const [rows, setRows] = useState(() =>
    EXPENSE_TYPES.reduce((acc, t) => ({ ...acc, [t]: { start: '', end: '', price: '' } }), {})
  );

  // refs จากชีท: branches + codeMap (type||branch -> รหัส)
  const [refs, setRefs] = useState({ branches: FALLBACK_BRANCHES, codeMap: {}, loaded: false, error: '' });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null); // { ok, msg }

  useEffect(() => {
    let alive = true;
    apiCall('getExpenseRefs', {})
      .then(res => {
        if (!alive) return;
        const list = res.data || [];
        const branches = [...new Set(list.map(r => String(r.branch || '').trim()).filter(Boolean))];
        const codeMap = {};
        list.forEach(r => { codeMap[refKey(r.type, r.branch)] = String(r.code || '').trim(); });
        setRefs({ branches: branches.length ? branches : FALLBACK_BRANCHES, codeMap, loaded: true, error: '' });
      })
      .catch(err => { if (alive) setRefs(r => ({ ...r, loaded: true, error: err.message || 'โหลดข้อมูลอ้างอิงไม่สำเร็จ' })); });
    return () => { alive = false; };
  }, []);

  const setCell = (type, field, value) =>
    setRows(prev => ({ ...prev, [type]: { ...prev[type], [field]: value } }));

  const codeFor = type => (branch ? (refs.codeMap[refKey(type, branch)] || '') : '');

  // จำนวน = เริ่มต้น − สิ้นสุด (E−F) ; ผลรวม = จำนวน × ราคา/หน่วย
  const computed = useMemo(() => EXPENSE_TYPES.map(type => {
    const r = rows[type];
    const start = parseFloat(r.start) || 0;
    const end = parseFloat(r.end) || 0;
    const price = parseFloat(r.price) || 0;
    const qty = start - end;
    const total = qty * price;
    return { type, start, end, price, qty, total, hasInput: r.start !== '' || r.end !== '' || r.price !== '' };
  }), [rows]);

  const grandTotal = computed.reduce((s, r) => s + (r.total || 0), 0);
  const canSave = branch && month && computed.some(r => r.hasInput) && !saving;

  const handleSave = async () => {
    setSaving(true);
    setToast(null);
    try {
      const items = computed.filter(r => r.hasInput).map(r => ({
        type: r.type, code: codeFor(r.type),
        start: r.start, end: r.end, price: r.price,
      }));
      const res = await apiCall('saveOtherExpense', { month, branch, items });
      setToast({ ok: true, msg: `บันทึกสำเร็จ ${res.data?.appended ?? items.length} รายการ` });
      // ล้างค่าหลังบันทึก
      setRows(EXPENSE_TYPES.reduce((acc, t) => ({ ...acc, [t]: { start: '', end: '', price: '' } }), {}));
    } catch (err) {
      setToast({ ok: false, msg: err.message || 'บันทึกไม่สำเร็จ' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-6 md:p-7 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex items-center gap-3">
          <div className="p-3 bg-amber-100 text-amber-600 rounded-xl"><DollarSign className="w-6 h-6" /></div>
          <div>
            <h2 className="text-xl font-bold text-slate-800">ค่าใช้จ่ายอื่นๆ</h2>
            <p className="text-sm text-slate-500 mt-0.5">บันทึกค่าเช่า/ไฟฟ้า/น้ำประปา/แก็ส/โทรศัพท์ แยกตามสาขาและเดือน</p>
          </div>
        </div>
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-slate-500 flex items-center gap-1"><Calendar size={13} /> เดือน</label>
            <input type="month" value={month} onChange={e => setMonth(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-bold text-slate-500 flex items-center gap-1">
              <Building2 size={13} /> สาขา {!refs.loaded && <Loader2 size={11} className="animate-spin" />}
            </label>
            <select value={branch} onChange={e => setBranch(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500">
              <option value="">— เลือกสาขา —</option>
              {refs.branches.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="text-xs font-bold uppercase tracking-wide">
                <th className="px-4 py-3 text-left">ประเภท</th>
                <th className="px-3 py-3 text-left">รหัส</th>
                <th className="px-4 py-3 text-right">เลขเริ่มต้น</th>
                <th className="px-4 py-3 text-right">เลขสิ้นสุด</th>
                <th className="px-4 py-3 text-right">จำนวน <span className="font-normal normal-case">(เริ่มต้น−สิ้นสุด)</span></th>
                <th className="px-4 py-3 text-right">ราคา/หน่วย</th>
                <th className="px-4 py-3 text-right">ผลรวม</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {computed.map(r => (
                <tr key={r.type} className="hover:bg-slate-50/60">
                  <td className="px-4 py-2.5 font-semibold text-slate-800 whitespace-nowrap">{r.type}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-slate-500 whitespace-nowrap">{codeFor(r.type) || '—'}</td>
                  <td className="px-2 py-2">
                    <input type="number" inputMode="decimal" value={rows[r.type].start} onChange={e => setCell(r.type, 'start', e.target.value)} placeholder="0"
                      className="w-28 text-right border border-slate-200 rounded-lg px-2 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-amber-500" />
                  </td>
                  <td className="px-2 py-2">
                    <input type="number" inputMode="decimal" value={rows[r.type].end} onChange={e => setCell(r.type, 'end', e.target.value)} placeholder="0"
                      className="w-28 text-right border border-slate-200 rounded-lg px-2 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-amber-500" />
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-700">{fmt(r.qty)}</td>
                  <td className="px-2 py-2">
                    <input type="number" inputMode="decimal" value={rows[r.type].price} onChange={e => setCell(r.type, 'price', e.target.value)} placeholder="0"
                      className="w-24 text-right border border-slate-200 rounded-lg px-2 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-amber-500" />
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold text-amber-700">฿{fmt(r.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-amber-50/60 border-t-2 border-amber-400 font-bold text-slate-800">
                <td className="px-4 py-3" colSpan={6}>รวมทั้งหมด</td>
                <td className="px-4 py-3 text-right font-mono text-amber-700">฿{fmt(grandTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="p-5 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-slate-400">{branch ? `สาขา ${branch} · เดือน ${month}` : 'ยังไม่ได้เลือกสาขา'}</span>
            {toast && (
              <span className={`inline-flex items-center gap-1 font-semibold ${toast.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                {toast.ok ? <CheckCircle size={13} /> : <AlertCircle size={13} />}{toast.msg}
              </span>
            )}
          </div>
          <button onClick={handleSave} disabled={!canSave}
            className="inline-flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-sm px-6 py-2.5 rounded-xl transition-all">
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            <span>{saving ? 'กำลังบันทึก…' : 'บันทึก'}</span>
          </button>
        </div>
      </div>

      {/* สถานะการเชื่อมต่อชีท */}
      {refs.error && (
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 text-xs text-amber-800 flex gap-2.5">
          <Info size={16} className="flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">ยังเชื่อมต่อชีทไม่ได้ — กำลังใช้รายชื่อสาขาสำรอง</p>
            <p className="mt-0.5">ตั้งค่า Google Apps Script + URL ใน <code className="bg-white px-1 rounded">/api/expense-gas</code> ให้เรียบร้อยก่อน (รหัส/สาขาจริง + ปุ่มบันทึกจะทำงานทันที) · {refs.error}</p>
          </div>
        </div>
      )}
    </div>
  );
}
