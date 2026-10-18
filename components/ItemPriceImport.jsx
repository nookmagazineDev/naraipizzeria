import React, { useState, useMemo } from 'react';
import { Loader2, AlertCircle, CheckCircle, X, Search, AlertTriangle, FileSpreadsheet } from 'lucide-react';
import { apiCall } from '../lib/qcrdApi';
import { nudgeModal } from '../lib/modalNudge';
import { readPriceSheets, comparePrices } from '../lib/priceFile.mjs';
import { dateLabel } from '../lib/thaiDate';

/*
 * หน้าวัตถุดิบ QC/RD — ปุ่ม "อัปเดตราคาจากไฟล์"
 * อ่านไฟล์ "ราคาซื้อสินค้าล่าสุด" (ดู lib/priceFile.mjs) → หน้าสรุปก่อนบันทึก → updateItemPrices
 * ราคาเดิมฝั่งฐานย้ายไปช่อง "ราคาก่อนหน้า" ให้เอง ราคาใหม่ลงวันที่วันที่กดอัปเดต
 * รายการที่ไฟล์ไม่มีราคา (0/ว่าง) ข้าม ไม่ทับราคาเดิม
 */

const BIG_CHANGE_PCT = 30;   // ราคาขึ้น/ลงเกินนี้ ติดสีเหลืองให้ตรวจก่อน
const fmtMoney = (n) => (n === null || n === undefined ? '—'
  : Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 4 }));

// วันที่จากเซลล์ Excel เป็นเวลาท้องถิ่น — toISOString() จะเลื่อนเป็นวันก่อนหน้าตอนเที่ยงคืน (UTC+7)
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** อ่านไฟล์ Excel → แถวดิบของทุกชีท (โหลดแพ็กเกจ xlsx ตอนกดเท่านั้น ไม่ให้หน้าแรกหนัก) */
export async function readPriceFile(file) {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const sheets = wb.SheetNames.map(name => ({
    name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null }),
  }));
  return readPriceSheets(sheets);
}

const TABS = [
  ['change', 'ราคาเปลี่ยน', 'จะอัปเดต (ติ๊กออกได้) · ราคาขึ้น/ลงเกิน 30% มีสีเหลือง ตรวจก่อนกด'],
  ['same', 'ราคาเท่าเดิม', 'ราคาเท่าเดิม ไม่ต้องอัปเดต'],
  ['noPrice', 'ไม่มีราคาในไฟล์', 'ไฟล์ให้ราคา 0 หรือว่าง ข้ามไว้ ราคาเดิมในทะเบียนไม่เปลี่ยน'],
  ['missing', 'ไม่อยู่ในทะเบียน', 'รหัสนี้ยังไม่มีในทะเบียนวัตถุดิบ ข้ามไว้ (เพิ่มเข้าทะเบียนก่อนถ้าต้องการ)'],
];

export function PriceImportDialog({ fileName, parsed, items, degraded, lockHint, onClose, onDone }) {
  const cmp = useMemo(() => comparePrices(parsed.lines, items), [parsed, items]);
  const [tab, setTab] = useState('change');
  const [off, setOff] = useState(() => new Set());   // รหัสที่ติ๊กออก (ไม่อัปเดต)
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [done, setDone] = useState(false);

  const list = cmp[tab] || [];
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? list.filter(l => `${l.code} ${l.name} ${l.item?.name || ''}`.toLowerCase().includes(q)) : list;
  }, [list, search]);
  const picked = cmp.change.filter(l => !off.has(l.key));
  const allOn = cmp.change.length > 0 && off.size === 0;

  const toggle = (key) => setOff(s => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const apply = async () => {
    if (degraded) { setMsg({ ok: false, msg: lockHint }); return; }
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiCall('updateItemPrices', { prices: picked.map(l => ({ code: l.item.code, price: l.price })) });
      const d = res.data || {};
      setDone(true);
      setMsg({
        ok: true,
        msg: `อัปเดตราคาแล้ว ${Number(d.updated || 0).toLocaleString()} รายการ`
          + (d.unchanged ? ` · เท่าเดิมอยู่แล้ว ${d.unchanged}` : '')
          + (d.missing ? ` · ไม่พบในทะเบียน ${d.missing}` : '')
          + ' · ราคาเดิมเก็บไว้ในช่อง "ราคาก่อนหน้า" แล้ว',
      });
      onDone();
    } catch (err) {
      setMsg({ ok: false, msg: err.message || 'อัปเดตราคาไม่สำเร็จ' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={nudgeModal}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-800">สรุปก่อนอัปเดตราคา</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {done ? 'บันทึกแล้ว' : 'ตรวจรายการแล้วกดอัปเดต ระบบยังไม่ได้บันทึกอะไร'}
            </p>
          </div>
          <button onClick={onClose} disabled={saving} className="text-slate-400 hover:text-slate-700 disabled:opacity-30"><X size={20} /></button>
        </div>

        <div className="p-5 overflow-auto space-y-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2">
            <span className="inline-flex items-center gap-1"><FileSpreadsheet size={13} /> <b className="text-slate-700">{fileName}</b></span>
            {parsed.exportedAt && <span>วันที่ในไฟล์ <b className="text-slate-700">{dateLabel(localDay(parsed.exportedAt))}</b></span>}
            <span>อ่าน {parsed.sheets.filter(s => s.found).map(s => `${s.name} ${s.rows.toLocaleString()} แถว`).join(' · ')}</span>
            {parsed.sheets.some(s => !s.found) && (
              <span className="text-amber-600">ข้ามชีท {parsed.sheets.filter(s => !s.found).map(s => s.name).join(', ')} (ไม่พบหัวตาราง รหัส/ราคา)</span>
            )}
            {cmp.duplicates > 0 && <span>รหัสซ้ำ {cmp.duplicates} แถว (ใช้แถวท้ายสุดที่มีราคา)</span>}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {TABS.map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`px-3 py-1 rounded-full text-xs font-semibold border ${tab === k ? 'bg-indigo-500 border-indigo-500 text-white' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                {label} <span className="font-mono font-normal ml-0.5">{(cmp[k] || []).length.toLocaleString()}</span>
              </button>
            ))}
          </div>

          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหารหัส / ชื่อ…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>

          <div className="overflow-x-auto border border-slate-100 rounded-xl max-h-[45vh]">
            <table className="w-full text-sm min-w-[680px]">
              <thead className="bg-slate-50 text-slate-500 text-xs sticky top-0">
                <tr>
                  <th className="px-3 py-2 w-9">
                    {tab === 'change' && (
                      <input type="checkbox" checked={allOn} disabled={saving || done}
                        onChange={e => setOff(e.target.checked ? new Set() : new Set(cmp.change.map(l => l.key)))} />
                    )}
                  </th>
                  <th className="px-3 py-2 text-left">รหัส</th>
                  <th className="px-3 py-2 text-left">ชื่อ (ในไฟล์)</th>
                  <th className="px-3 py-2 text-right">ราคาเดิม</th>
                  <th className="px-3 py-2 text-right">ราคาใหม่</th>
                  <th className="px-3 py-2 text-right">เปลี่ยน</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map(l => {
                  const big = tab === 'change' && l.pct !== null && Math.abs(l.pct) > BIG_CHANGE_PCT;
                  const isOff = tab === 'change' && off.has(l.key);
                  const old = l.item ? l.item.price : null;
                  return (
                    <tr key={l.key} className={`${big ? 'bg-amber-50' : ''} ${isOff ? 'opacity-40' : ''}`}>
                      <td className="px-3 py-1.5">
                        {tab === 'change' && (
                          <input type="checkbox" checked={!isOff} disabled={saving || done} onChange={() => toggle(l.key)} />
                        )}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-xs text-slate-500 whitespace-nowrap">{l.code}</td>
                      <td className="px-3 py-1.5">
                        {l.name || l.item?.name}
                        {big && <div className="text-[10px] font-bold text-amber-700">เปลี่ยนเกิน {BIG_CHANGE_PCT}% ตรวจก่อน</div>}
                        {l.sheet && <span className="ml-1.5 text-[10px] text-slate-400">ชีท {l.sheet}</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">
                        {fmtMoney(old)}
                        {l.item?.priceAt && <div className="text-[10px] text-slate-400 font-sans">{dateLabel(l.item.priceAt)}</div>}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{l.price === null ? <span className="text-slate-300">0</span> : fmtMoney(l.price)}</td>
                      <td className="px-3 py-1.5 text-right whitespace-nowrap">
                        {tab === 'change' && l.pct !== null ? (
                          <span className={`px-1.5 rounded-full text-[11px] font-bold font-mono ${l.pct > 0 ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-600'}`}>
                            {l.pct > 0 ? '▲' : '▼'}{Math.abs(l.pct).toFixed(1)}%
                          </span>
                        ) : tab === 'change' ? <span className="text-[11px] text-slate-400">ใหม่</span>
                          : <span className="text-[11px] text-slate-400">ข้าม</span>}
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">ไม่มีรายการ</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-400">{TABS.find(t => t[0] === tab)[2]}</p>

          {!done && (
            <p className="flex items-start gap-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              กดอัปเดตแล้ว ราคาเดิมจะถูกเก็บไว้ในช่อง &quot;ราคาก่อนหน้า&quot; พร้อมวันที่ ราคาใหม่ลงวันที่วันนี้
              · ต้นทุนเมนูยังไม่เปลี่ยนจนกว่าจะกด &quot;คำนวณต้นทุนใหม่&quot; ที่หน้าเมนู
            </p>
          )}
          {msg && (
            <div className={`text-xs font-semibold flex items-start gap-1 ${msg.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
              {msg.ok ? <CheckCircle size={13} className="flex-shrink-0 mt-0.5" /> : <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />}{msg.msg}
            </div>
          )}
        </div>

        <div className="p-5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-600">
            {done ? '' : `จะอัปเดต ${picked.length.toLocaleString()} รายการ`}
          </span>
          <div className="flex gap-2 ml-auto">
            <button onClick={onClose} disabled={saving}
              className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">
              {done ? 'ปิด' : 'ยกเลิก'}
            </button>
            {!done && (
              <button onClick={apply} disabled={saving || degraded || !picked.length} title={degraded ? lockHint : ''}
                className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-indigo-500 hover:bg-indigo-600 disabled:bg-slate-200 disabled:text-slate-400 rounded-xl">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle size={15} />}
                {saving ? 'กำลังอัปเดต…' : `อัปเดตราคา ${picked.length.toLocaleString()} รายการ`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
