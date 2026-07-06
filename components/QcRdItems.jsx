import React, { useState, useEffect, useMemo } from 'react';
import { PackageSearch, Search, Loader2, AlertCircle, Save, CheckCircle, Info } from 'lucide-react';
import { apiCall } from '../lib/qcrdApi';

/*
 * QC/RD — วัตถุดิบ: รหัส / ชื่อ / หน่วย / ราคาต้นทุน จากชีท item (1v8WRT…)
 * คอลัมน์หน่วย (D) ในชีทยังว่าง → ระบบวิเคราะห์หน่วยจากชื่อให้อัตโนมัติ (badge "วิเคราะห์")
 * ปุ่ม "บันทึกหน่วยลงชีท" เขียนหน่วยที่วิเคราะห์ลงคอลัมน์ D ผ่าน Apps Script (เฉพาะช่องที่ว่าง)
 */

const fmt = v => (v === null || v === undefined || isNaN(v)) ? '—'
  : Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function QcRdItems() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [unitFilter, setUnitFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null); // { ok, msg }

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

  const units = useMemo(() => [...new Set(items.map(i => i.unit).filter(Boolean))].sort(), [items]);
  const autoCount = useMemo(() => items.filter(i => i.unitSource === 'auto' && i.unit).length, [items]);
  const noUnitCount = useMemo(() => items.filter(i => !i.unit).length, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(i => {
      if (unitFilter && i.unit !== unitFilter) return false;
      if (!q) return true;
      return i.code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q);
    });
  }, [items, search, unitFilter]);

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

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-6 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-emerald-100 text-emerald-600 rounded-xl"><PackageSearch className="w-6 h-6" /></div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">วัตถุดิบ (QC/RD)</h2>
              <p className="text-sm text-slate-500 mt-0.5">
                {items.length.toLocaleString()} รายการจากชีท item · หน่วยวิเคราะห์อัตโนมัติ {autoCount.toLocaleString()} รายการ
                {noUnitCount > 0 && ` · ระบุหน่วยไม่ได้ ${noUnitCount} รายการ`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {toast && (
              <span className={`inline-flex items-center gap-1 text-xs font-semibold ${toast.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                {toast.ok ? <CheckCircle size={13} /> : <AlertCircle size={13} />}{toast.msg}
              </span>
            )}
            <button onClick={saveUnits} disabled={saving || autoCount === 0}
              title="เขียนหน่วยที่วิเคราะห์ได้ลงคอลัมน์ D ของชีท (เฉพาะช่องที่ยังว่าง)"
              className="inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              บันทึกหน่วยลงชีท ({autoCount})
            </button>
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
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />กำลังโหลดข้อมูล…
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-slate-400">ไม่พบรายการ</td></tr>
              ) : filtered.map(i => (
                <tr key={i.code} className="hover:bg-slate-50/60">
                  <td className="px-4 py-2 font-mono text-xs text-slate-500 whitespace-nowrap">{i.code}</td>
                  <td className="px-4 py-2 text-slate-800">{i.name}</td>
                  <td className="px-4 py-2 text-center whitespace-nowrap">
                    {i.unit ? (
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${i.unitSource === 'sheet' ? 'bg-slate-100 text-slate-600' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
                        {i.unit}{i.unitSource === 'auto' && <span className="text-[9px] opacity-70">วิเคราะห์</span>}
                      </span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">{fmt(i.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && (
          <div className="px-4 py-3 border-t border-slate-100 text-xs text-slate-400 flex items-center gap-2">
            <Info size={13} />
            แสดง {filtered.length.toLocaleString()} / {items.length.toLocaleString()} รายการ ·
            หน่วยสีเหลือง = วิเคราะห์จากชื่อโดยระบบ (ยังไม่ได้เขียนลงชีท) — กด "บันทึกหน่วยลงชีท" เพื่อเขียนลงคอลัมน์ D
          </div>
        )}
      </div>
    </div>
  );
}
