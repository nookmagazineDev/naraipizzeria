import React, { useState, useEffect, useMemo } from 'react';
import { PackageSearch, Search, Loader2, AlertCircle, Save, CheckCircle, Info, Pencil, X, Plus, ArrowRightLeft } from 'lucide-react';
import { apiCall } from '../lib/qcrdApi';

/*
 * QC/RD — วัตถุดิบ: รหัส / ชื่อ / หน่วย / ราคาต้นทุน / สถานะ / ไอเทมทดแทน จากชีท item (1v8WRT…)
 * - หน่วย (คอลัมน์ D) ว่าง → วิเคราะห์จากชื่ออัตโนมัติ (badge "วิเคราะห์") + ปุ่มเขียนลงชีท
 * - แก้ไขได้: ชื่อ (B), สถานะใช้งาน/ปิดการใช้งาน (E), ไอเทมทดแทนสูงสุด 3 ตัว (F–H)
 *   ผ่าน Apps Script action: saveItem
 */

const fmt = v => (v === null || v === undefined || isNaN(v)) ? '—'
  : Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// เทียบรหัสแบบมองข้ามเลข 0 นำหน้า — ระบบคลังใช้ 01000078 แต่ชีท item เก็บ 1000078
const codeMatch = (code, q) => {
  const c = String(code).toLowerCase(), s = q.toLowerCase();
  return c.includes(s) || c.replace(/^0+/, '').includes(s.replace(/^0+/, ''));
};

// รายชื่อสาขาสำหรับเลือก "สาขาที่ใช้ไอเทม" (ชุดเดียวกับหน้าค่าใช้จ่าย)
const BRANCHES = [
  'SJP', 'CRM', 'XCM', 'SLR', 'SUM', 'XUM', 'SCS', 'SMP', 'XSB', 'XHH',
  'HRS', 'CLK', 'P90', 'HPS', 'ZBW', 'ZPT', 'NPT', 'WRM', 'WMT', 'IPR', 'ZK3',
];

export default function QcRdItems() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [unitFilter, setUnitFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null); // { ok, msg }
  const [editItem, setEditItem] = useState(null); // { code, name, status, subs[] }
  const [savingItem, setSavingItem] = useState(false);

  const load = () => {
    setLoading(true);
    fetch('/api/qcrd?sheet=item')
      .then(r => r.json())
      .then(res => {
        if (res.status === 'success') { setItems(res.data || []); setError(''); }
        else setError(res.message || 'โหลดข้อมูลไม่สำเร็จ');
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const nameMap = useMemo(() => {
    const m = {};
    items.forEach(i => { m[i.code] = i.name; });
    return m;
  }, [items]);

  const units = useMemo(() => [...new Set(items.map(i => i.unit).filter(Boolean))].sort(), [items]);
  const autoCount = useMemo(() => items.filter(i => i.unitSource === 'auto' && i.unit).length, [items]);
  const inactiveCount = useMemo(() => items.filter(i => i.status === 'ปิดการใช้งาน').length, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(i => {
      if (unitFilter && i.unit !== unitFilter) return false;
      if (statusFilter && i.status !== statusFilter) return false;
      if (!q) return true;
      return codeMatch(i.code, q) || i.name.toLowerCase().includes(q);
    });
  }, [items, search, unitFilter, statusFilter]);

  const saveUnits = async () => {
    setSaving(true);
    setToast(null);
    try {
      const units = items.filter(i => i.unitSource === 'auto' && i.unit).map(i => ({ code: i.code, unit: i.unit }));
      const res = await apiCall('updateItemUnits', { units });
      setToast({ ok: true, msg: `บันทึกหน่วยลงชีทแล้ว ${res.data?.updated ?? 0} รายการ` });
      load();
    } catch (err) {
      setToast({ ok: false, msg: err.message || 'บันทึกไม่สำเร็จ' });
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (i) => setEditItem({
    isNew: false,
    code: i.code, name: i.name, status: i.status || 'ใช้งาน', subs: [...(i.subs || [])],
    price: i.price ?? '', converter: i.converter ?? '', branches: [...(i.usedBranches || [])],
  });

  const openNew = () => setEditItem({
    isNew: true,
    code: '', name: '', status: 'ใช้งาน', subs: [],
    price: '', converter: '', branches: [],
  });

  const toggleBranch = (b) => setEditItem(m => ({
    ...m, branches: m.branches.includes(b) ? m.branches.filter(x => x !== b) : [...m.branches, b],
  }));

  const saveItem = async () => {
    const code = String(editItem.code || '').trim();
    if (editItem.isNew && !code) { setToast({ ok: false, msg: 'กรุณากรอกรหัสวัตถุดิบ' }); return; }
    if (editItem.isNew && items.some(i => String(i.code).trim() === code)) {
      setToast({ ok: false, msg: `มีรหัส ${code} อยู่แล้วในรายการ` }); return;
    }
    if (!editItem.name.trim()) { setToast({ ok: false, msg: 'กรุณากรอกชื่อวัตถุดิบ' }); return; }
    setSavingItem(true);
    setToast(null);
    try {
      await apiCall(editItem.isNew ? 'addItem' : 'saveItem', {
        code, name: editItem.name.trim(),
        status: editItem.status, subs: editItem.subs.slice(0, 3),
        price: editItem.price, converter: editItem.converter,
        branches: editItem.branches,
      });
      setToast({ ok: true, msg: editItem.isNew ? `เพิ่มวัตถุดิบ ${code} สำเร็จ` : `บันทึก ${code} สำเร็จ` });
      setEditItem(null);
      load();
    } catch (err) {
      setToast({ ok: false, msg: err.message || 'บันทึกไม่สำเร็จ' });
    } finally {
      setSavingItem(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-6 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-emerald-100 text-emerald-600 rounded-xl"><PackageSearch className="w-6 h-6" /></div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">วัตถุดิบ (QC/RD)</h2>
              <p className="text-sm text-slate-500 mt-0.5">
                {items.length.toLocaleString()} รายการจากชีท item
                {autoCount > 0 && ` · หน่วยวิเคราะห์อัตโนมัติ ${autoCount.toLocaleString()}`}
                {inactiveCount > 0 && ` · ปิดการใช้งาน ${inactiveCount}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {toast && (
              <span className={`inline-flex items-center gap-1 text-xs font-semibold ${toast.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                {toast.ok ? <CheckCircle size={13} /> : <AlertCircle size={13} />}{toast.msg}
              </span>
            )}
            <button onClick={openNew}
              title="เพิ่มวัตถุดิบใหม่ลงชีท item"
              className="inline-flex items-center gap-2 bg-slate-800 hover:bg-slate-900 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
              <Plus size={14} /> เพิ่มวัตถุดิบ
            </button>
            {autoCount > 0 && (
              <button onClick={saveUnits} disabled={saving}
                title="เขียนหน่วยที่วิเคราะห์ได้ลงคอลัมน์ D ของชีท (เฉพาะช่องที่ยังว่าง)"
                className="inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                บันทึกหน่วยลงชีท ({autoCount})
              </button>
            )}
          </div>
        </div>

        <div className="p-4 flex flex-wrap gap-3 border-b border-slate-100">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหารหัส / ชื่อวัตถุดิบ…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
          <select value={unitFilter} onChange={e => setUnitFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
            <option value="">ทุกหน่วย ({units.length})</option>
            {units.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
            <option value="">ทุกสถานะ</option>
            <option value="ใช้งาน">ใช้งาน</option>
            <option value="ปิดการใช้งาน">ปิดการใช้งาน</option>
          </select>
        </div>

        {error && (
          <div className="m-4 p-3 bg-rose-50 border border-rose-100 rounded-xl text-sm text-rose-700 flex items-center gap-2">
            <AlertCircle size={16} /><span>{error}</span>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 sticky top-0">
              <tr className="text-xs font-bold uppercase tracking-wide">
                <th className="px-4 py-3 text-left">รหัส</th>
                <th className="px-4 py-3 text-left">ชื่อ</th>
                <th className="px-4 py-3 text-center">หน่วย</th>
                <th className="px-4 py-3 text-right">ราคาต้นทุน</th>
                <th className="px-3 py-3 text-right">ตัวแปลง</th>
                <th className="px-3 py-3 text-left">สาขาที่ใช้</th>
                <th className="px-4 py-3 text-center">สถานะ</th>
                <th className="px-4 py-3 text-left">ไอเทมทดแทน</th>
                <th className="px-4 py-3 text-center">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />กำลังโหลดข้อมูล…
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-400">ไม่พบรายการ</td></tr>
              ) : filtered.map(i => (
                <tr key={i.code} className={`hover:bg-slate-50/60 ${i.status === 'ปิดการใช้งาน' ? 'bg-rose-50/40 text-slate-400' : ''}`}>
                  <td className="px-4 py-2 font-mono text-xs text-slate-500 whitespace-nowrap">{i.code}</td>
                  <td className={`px-4 py-2 ${i.status === 'ปิดการใช้งาน' ? '' : 'text-slate-800'}`}>{i.name}</td>
                  <td className="px-4 py-2 text-center whitespace-nowrap">
                    {i.unit ? (
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${i.unitSource === 'sheet' ? 'bg-slate-100 text-slate-600' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
                        {i.unit}{i.unitSource === 'auto' && <span className="text-[9px] opacity-70">วิเคราะห์</span>}
                      </span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{fmt(i.price)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">
                    {i.converter != null && !isNaN(i.converter) ? Number(i.converter).toLocaleString() : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {(i.usedBranches || []).length === 0 ? <span className="text-slate-300 text-xs">—</span> : (
                      <div className="flex flex-wrap gap-1 max-w-[180px]" title={i.usedBranches.join(', ')}>
                        {i.usedBranches.slice(0, 4).map(b => (
                          <span key={b} className="inline-block px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-semibold">{b}</span>
                        ))}
                        {i.usedBranches.length > 4 && (
                          <span className="inline-block px-1.5 py-0.5 bg-slate-200 text-slate-500 rounded text-[10px] font-bold">+{i.usedBranches.length - 4}</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-center whitespace-nowrap">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${i.status === 'ปิดการใช้งาน' ? 'bg-rose-100 text-rose-600' : 'bg-emerald-50 text-emerald-600'}`}>
                      {i.status}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {(i.subs || []).length === 0 ? <span className="text-slate-300 text-xs">—</span> : (
                      <div className="flex flex-wrap gap-1">
                        {i.subs.map(c => (
                          <span key={c} title={nameMap[c] || c}
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-sky-50 text-sky-700 border border-sky-100 rounded-full text-[11px] max-w-[180px] truncate">
                            <ArrowRightLeft size={9} className="flex-shrink-0" />{nameMap[c] || c}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <button onClick={() => openEdit(i)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">
                      <Pencil size={12} /> แก้ไข
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && (
          <div className="px-4 py-3 border-t border-slate-100 text-xs text-slate-400 flex items-center gap-2">
            <Info size={13} />
            แสดง {filtered.length.toLocaleString()} / {items.length.toLocaleString()} รายการ ·
            หน่วยสีเหลือง = วิเคราะห์จากชื่อโดยระบบ (ยังไม่ได้เขียนลงชีท)
          </div>
        )}
      </div>

      {/* ───── Modal แก้ไขวัตถุดิบ ───── */}
      {editItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => !savingItem && setEditItem(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-800">
                {editItem.isNew
                  ? <>➕ เพิ่มวัตถุดิบใหม่</>
                  : <>✏️ แก้ไขวัตถุดิบ <span className="font-mono text-sm text-slate-400">{editItem.code}</span></>}
              </h3>
              <button onClick={() => setEditItem(null)} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
            </div>

            <div className="p-5 overflow-auto space-y-4">
              {editItem.isNew && (
                <div>
                  <label className="text-xs font-bold text-slate-500">รหัสวัตถุดิบ</label>
                  <input value={editItem.code} onChange={e => setEditItem(m => ({ ...m, code: e.target.value }))}
                    placeholder="เช่น 1000078"
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
              )}
              <div>
                <label className="text-xs font-bold text-slate-500">ชื่อวัตถุดิบ</label>
                <input value={editItem.name} onChange={e => setEditItem(m => ({ ...m, name: e.target.value }))}
                  className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-500">ราคาต้นทุน (บาท/หน่วยซื้อ)</label>
                  <input type="number" inputMode="decimal" value={editItem.price}
                    onChange={e => setEditItem(m => ({ ...m, price: e.target.value }))} placeholder="0.00"
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500">ตัวแปลงหน่วย <span className="font-normal">(หน่วยเล็กต่อ 1 หน่วยซื้อ เช่น 1000)</span></label>
                  <input type="number" inputMode="decimal" value={editItem.converter}
                    onChange={e => setEditItem(m => ({ ...m, converter: e.target.value }))} placeholder="เช่น 1000"
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-slate-500">สาขาที่ใช้ไอเทมนี้</label>
                  <span className="text-[11px] text-slate-400">
                    เลือกแล้ว {editItem.branches.length} สาขา
                    {editItem.branches.length > 0 && (
                      <button onClick={() => setEditItem(m => ({ ...m, branches: [] }))} className="ml-2 text-rose-400 hover:text-rose-600 underline">ล้าง</button>
                    )}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {/* ปุ่มเลือก/ยกเลิกทุกสาขาในคลิกเดียว */}
                  <button onClick={() => setEditItem(m => ({ ...m, branches: m.branches.length === BRANCHES.length ? [] : [...BRANCHES] }))}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition-all ${editItem.branches.length === BRANCHES.length
                      ? 'bg-emerald-600 border-emerald-600 text-white'
                      : 'bg-emerald-50 border-emerald-300 text-emerald-700 hover:bg-emerald-100'}`}>
                    ✓ ทุกสาขา
                  </button>
                  {BRANCHES.map(b => {
                    const on = editItem.branches.includes(b);
                    return (
                      <button key={b} onClick={() => toggleBranch(b)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${on
                          ? 'bg-emerald-500 border-emerald-500 text-white'
                          : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                        {b}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500">สถานะ</label>
                <div className="mt-1 flex gap-2">
                  {['ใช้งาน', 'ปิดการใช้งาน'].map(s => (
                    <button key={s} onClick={() => setEditItem(m => ({ ...m, status: s }))}
                      className={`px-4 py-2 rounded-xl text-sm font-semibold border transition-all ${editItem.status === s
                        ? (s === 'ใช้งาน' ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-rose-500 border-rose-500 text-white')
                        : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-slate-500">ไอเทมทดแทน (สูงสุด 3 รายการ)</label>
                  <span className="text-[11px] text-slate-400">{editItem.subs.length}/3</span>
                </div>
                <div className="space-y-2">
                  {editItem.subs.map((c, idx) => (
                    <div key={idx} className="flex items-center justify-between gap-2 px-3 py-2 bg-sky-50/60 border border-sky-100 rounded-xl text-sm">
                      <span className="truncate">
                        <span className="font-mono text-xs text-slate-400 mr-1.5">{c}</span>{nameMap[c] || '(ไม่พบชื่อในชีท)'}
                      </span>
                      <button onClick={() => setEditItem(m => ({ ...m, subs: m.subs.filter((_, i2) => i2 !== idx) }))}
                        className="text-slate-300 hover:text-rose-500 flex-shrink-0"><X size={14} /></button>
                    </div>
                  ))}
                  {editItem.subs.length < 3 && (
                    <SubPicker items={items} exclude={[editItem.code, ...editItem.subs]}
                      onPick={code => setEditItem(m => ({ ...m, subs: [...m.subs, code] }))} />
                  )}
                </div>
              </div>
            </div>

            <div className="p-5 border-t border-slate-100 flex items-center justify-end gap-2">
              <button onClick={() => setEditItem(null)} disabled={savingItem}
                className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">ยกเลิก</button>
              <button onClick={saveItem} disabled={savingItem}
                className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-200 disabled:text-slate-400 rounded-xl">
                {savingItem ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle size={15} />}
                {savingItem ? 'กำลังบันทึก…' : (editItem.isNew ? 'เพิ่มวัตถุดิบ' : 'บันทึก')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ช่องค้นหาเพื่อเพิ่มไอเทมทดแทน
function SubPicker({ items, exclude, onPick }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return items
      .filter(i => !exclude.includes(i.code) && i.status !== 'ปิดการใช้งาน')
      .filter(i => codeMatch(i.code, q) || i.name.toLowerCase().includes(q))
      .slice(0, 12);
  }, [items, exclude, query]);

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <Plus size={14} className="text-sky-500 flex-shrink-0" />
        <input value={query} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          placeholder="เพิ่มไอเทมทดแทน — พิมพ์ค้นหารหัส/ชื่อ…"
          className="flex-1 px-3 py-2 border border-dashed border-sky-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sky-400" />
      </div>
      {open && suggestions.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-56 overflow-auto">
          {suggestions.map(s => (
            <button key={s.code} onMouseDown={() => { onPick(s.code); setQuery(''); setOpen(false); }}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-sky-50">
              <span className="font-mono text-xs text-slate-400 mr-1.5">{s.code}</span>{s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
