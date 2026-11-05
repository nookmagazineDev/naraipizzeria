import React, { useEffect, useMemo, useState } from 'react';
import { Lock, Unlock, Loader2, X, AlertCircle, CheckCircle, RefreshCw } from 'lucide-react';

/*
 * ล็อกตารางงานรายสาขา — อยู่ในหน้า "ดูสแกนหน้า" (components/Attendance.jsx)
 *
 * "ล็อกถึงวันที่ X" = หน้าลงตารางของสาขา (Narai-branch) แก้ตารางงานของวันที่ไม่เกิน X ไม่ได้
 * ใช้ตอนปิดงวดเงินเดือน ไม่ให้สาขาย้อนไปแก้ตารางที่ใช้คิดค่าแรงไปแล้ว
 * เลือกได้ทีละหลายสาขา แต่ละสาขามีวันล็อกของตัวเอง · ปลดล็อก = ลบล็อกของสาขาที่เลือก
 *
 * ไม่กระทบฝั่งออฟฟิศ: แก้เวลาสแกนในหน้านี้ได้ตามเดิม และ user สิทธิ์ all ของหน้าสาขายังแก้ได้
 * ข้อมูลผ่าน /api/hr-schedule-lock → office-server (schedule-lock.js) → narai_hr.dbo.hr_schedule_lock
 */

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** '2026-10-20' -> '20/10/2026' */
export const thaiDate = (ymd) => {
  const [y, m, d] = String(ymd || '').split('-');
  return y && m && d ? `${Number(d)}/${Number(m)}/${y}` : String(ymd || '');
};

/**
 * วันล็อกสำเร็จรูป — "สิ้นงวดที่แล้ว" = วันที่ 20 ของงวดเงินเดือน 21–20 ที่ปิดไปล่าสุด
 * (ตรงกับปุ่ม "งวดที่แล้ว 21–20" ด้านบน) · เมื่อวาน · สิ้นเดือนที่แล้ว
 */
function quickDates(now = new Date()) {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cycleEnd = new Date(t.getFullYear(), t.getDate() >= 21 ? t.getMonth() : t.getMonth() - 1, 20);
  const yesterday = new Date(t); yesterday.setDate(t.getDate() - 1);
  const lastMonthEnd = new Date(t.getFullYear(), t.getMonth(), 0);
  return [
    { label: `สิ้นงวดที่แล้ว (${thaiDate(fmtDate(cycleEnd))})`, value: fmtDate(cycleEnd) },
    { label: `สิ้นเดือนที่แล้ว (${thaiDate(fmtDate(lastMonthEnd))})`, value: fmtDate(lastMonthEnd) },
    { label: 'เมื่อวาน', value: fmtDate(yesterday) },
  ];
}

/** ล็อกของสาขานี้ (รวมรหัสพ้อง เช่น SJP/zjp) — ไม่มีคืน null */
export function lockFor(locks, branch) {
  const b = String(branch || '').trim().toLowerCase();
  if (!b) return null;
  let best = null;
  for (const l of locks || []) {
    const codes = l.codes?.length ? l.codes : [String(l.branch || '').toLowerCase()];
    if (codes.includes(b) && (!best || l.lockedUntil > best.lockedUntil)) best = l;
  }
  return best;
}

export default function ScheduleLockPanel({ onChange }) {
  const [locks, setLocks] = useState([]);
  const [branches, setBranches] = useState([]);   // [{ name, fullName }] จากฐาน HR
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null); // { message, hint }

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [until, setUntil] = useState(() => quickDates()[0].value);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState('');       // '' | 'lock' | 'unlock'
  const [msg, setMsg] = useState(null);           // { ok, text, hint }

  const quick = useMemo(() => quickDates(), []);

  const apply = (list) => {
    const l = Array.isArray(list) ? list : [];
    setLocks(l);
    if (onChange) onChange(l);
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/hr-schedule-lock');
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.status !== 'success') {
        const e = new Error((json && json.message) || `อ่านล็อกตารางงานไม่สำเร็จ (${res.status})`);
        e.hint = json && json.hint;
        throw e;
      }
      apply(json.locks);
      setBranches(Array.isArray(json.branches) ? json.branches : []);
      setLoadError(null);
    } catch (err) {
      setLoadError({ message: err.message || 'อ่านล็อกตารางงานไม่สำเร็จ', hint: err.hint });
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  // รายชื่อสาขาให้ติ๊ก = สาขาในฐาน HR + สาขาที่มีล็อกอยู่แต่ไม่อยู่ในรายชื่อ (เผื่อสาขาถูกลบไปแล้ว)
  const options = useMemo(() => {
    const seen = new Map();
    for (const b of branches) {
      const code = String(b.name || '').toLowerCase();
      if (code && !seen.has(code)) seen.set(code, { code, fullName: b.fullName || b.name });
    }
    for (const l of locks) {
      const code = String(l.branch || '').toLowerCase();
      if (code && !seen.has(code)) seen.set(code, { code, fullName: code.toUpperCase() });
    }
    return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [branches, locks]);

  const lockedNow = useMemo(
    () => [...locks].sort((a, b) => String(a.branch).localeCompare(String(b.branch))),
    [locks]
  );

  const toggle = (code) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  const openModal = () => {
    setMsg(null);
    setOpen(true);
    if (loadError) load();
  };

  const submit = async (mode) => {
    const list = [...selected];
    if (list.length === 0) { setMsg({ ok: false, text: 'กรุณาเลือกสาขาอย่างน้อย 1 สาขา' }); return; }
    if (mode === 'lock' && !until) { setMsg({ ok: false, text: 'กรุณาเลือกวันที่ที่จะล็อก' }); return; }
    const names = list.map((c) => c.toUpperCase()).join(', ');
    const ask = mode === 'lock'
      ? `ล็อกตารางงานของ ${names}\nถึงวันที่ ${thaiDate(until)} ?\n\nสาขาจะแก้ตารางงานของวันที่ ${thaiDate(until)} และก่อนหน้านั้นไม่ได้`
      : `ปลดล็อกตารางงานของ ${names} ?\n\nสาขาจะกลับมาแก้ตารางย้อนหลังได้ทุกวัน`;
    if (!window.confirm(ask)) return;

    setSaving(mode);
    setMsg(null);
    try {
      const res = await fetch('/api/hr-schedule-lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branches: list, lockedUntil: mode === 'lock' ? until : '', note }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.status !== 'success') {
        const e = new Error((json && json.message) || `บันทึกไม่สำเร็จ (${res.status})`);
        e.hint = json && json.hint;
        throw e;
      }
      apply(json.locks);
      setSelected(new Set());
      setNote('');
      setMsg({ ok: true, text: json.message || 'บันทึกแล้ว' });
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'บันทึกไม่สำเร็จ', hint: err.hint });
    } finally {
      setSaving('');
    }
  };

  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-slate-100 text-slate-600 rounded-lg"><Lock size={16} /></div>
          <div>
            <div className="text-sm font-semibold text-slate-700">ล็อกตารางงาน</div>
            <div className="text-[11px] text-slate-400">สาขาแก้ตารางงานของวันที่ถูกล็อกไม่ได้ · ออฟฟิศและสิทธิ์ all ยังแก้ได้</div>
          </div>
        </div>

        <div className="flex flex-1 flex-wrap items-center gap-1.5 min-w-0">
          {loading ? (
            <span className="inline-flex items-center gap-1 text-xs text-slate-400"><Loader2 size={13} className="animate-spin" /> กำลังโหลด…</span>
          ) : loadError ? (
            <span className="text-xs text-rose-600" title={loadError.hint || ''}>
              {loadError.message}{loadError.hint ? ` — ${loadError.hint}` : ''}
            </span>
          ) : lockedNow.length === 0 ? (
            <span className="text-xs text-slate-400">ยังไม่มีสาขาที่ถูกล็อก</span>
          ) : (
            lockedNow.map((l) => (
              <span
                key={l.branch}
                className="inline-flex items-center gap-1 rounded-lg bg-slate-700 px-2 py-0.5 text-[11px] font-semibold text-white"
                title={`ล็อกโดย ${l.lockedBy || '-'} เมื่อ ${l.lockedAt || '-'}${l.note ? ` · ${l.note}` : ''}`}
              >
                <Lock size={10} /> {String(l.branch).toUpperCase()} ≤ {thaiDate(l.lockedUntil)}
              </span>
            ))
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={load} disabled={loading} title="โหลดใหม่"
            className="p-2 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={openModal}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-slate-800 text-white hover:bg-slate-900"
          >
            <Lock size={15} /> ล็อก / ปลดล็อก
          </button>
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !saving && setOpen(false)}>
          <div className="w-full max-w-2xl max-h-[90vh] overflow-auto rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
              <h3 className="flex items-center gap-2 font-bold text-slate-800"><Lock size={18} /> ล็อกตารางงานของสาขา</h3>
              <button onClick={() => setOpen(false)} disabled={!!saving} className="p-1 text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>

            <div className="space-y-4 px-5 py-4">
              {/* วันที่ */}
              <div>
                <div className="mb-1.5 text-xs font-semibold text-slate-500">ล็อกถึงวันที่ (รวมวันนั้น)</div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="date" value={until} onChange={(e) => setUntil(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-slate-500 outline-none"
                  />
                  {quick.map((q) => (
                    <button
                      key={q.value + q.label} onClick={() => setUntil(q.value)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${until === q.value ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* สาขา */}
              <div>
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-slate-500">สาขา (เลือกได้หลายสาขา) · เลือกแล้ว {selected.size}</span>
                  <button onClick={() => setSelected(new Set(options.map((o) => o.code)))} className="text-xs text-indigo-600 hover:underline">เลือกทั้งหมด</button>
                  <button onClick={() => setSelected(new Set(locks.map((l) => String(l.branch).toLowerCase())))} className="text-xs text-indigo-600 hover:underline">เลือกที่ล็อกอยู่</button>
                  <button onClick={() => setSelected(new Set())} className="text-xs text-slate-500 hover:underline">ล้าง</button>
                </div>
                {options.length === 0 ? (
                  <div className="text-xs text-slate-400">{loading ? 'กำลังโหลดรายชื่อสาขา…' : 'ไม่พบรายชื่อสาขาในฐานข้อมูลตารางงาน'}</div>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                    {options.map((o) => {
                      const l = locks.find((x) => String(x.branch).toLowerCase() === o.code);
                      const on = selected.has(o.code);
                      return (
                        <label
                          key={o.code}
                          className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${on ? 'border-slate-700 bg-slate-50' : 'border-slate-200 hover:bg-slate-50'}`}
                          title={o.fullName}
                        >
                          <input type="checkbox" checked={on} onChange={() => toggle(o.code)} className="accent-slate-800" />
                          <span className="font-semibold text-slate-700">{o.code.toUpperCase()}</span>
                          {l ? (
                            <span className="ml-auto inline-flex items-center gap-0.5 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-white">
                              <Lock size={9} /> {thaiDate(l.lockedUntil)}
                            </span>
                          ) : (
                            <span className="ml-auto text-[10px] text-slate-300">ไม่ล็อก</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <div className="mb-1.5 text-xs font-semibold text-slate-500">หมายเหตุ (ไม่บังคับ)</div>
                <input
                  type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={255}
                  placeholder="เช่น ปิดงวดเงินเดือน 21/9–20/10"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-slate-500 outline-none"
                />
              </div>

              {msg && (
                <div className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${msg.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>
                  {msg.ok ? <CheckCircle size={16} className="mt-0.5 flex-shrink-0" /> : <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />}
                  <span>{msg.text}{msg.hint ? <span className="block text-xs opacity-80 mt-0.5">{msg.hint}</span> : null}</span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
              <button
                onClick={() => submit('unlock')} disabled={!!saving || selected.size === 0}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {saving === 'unlock' ? <Loader2 size={15} className="animate-spin" /> : <Unlock size={15} />}
                ปลดล็อก {selected.size ? `${selected.size} สาขา` : ''}
              </button>
              <button
                onClick={() => submit('lock')} disabled={!!saving || selected.size === 0 || !until}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-50"
              >
                {saving === 'lock' ? <Loader2 size={15} className="animate-spin" /> : <Lock size={15} />}
                ล็อกถึง {until ? thaiDate(until) : '…'} {selected.size ? `(${selected.size} สาขา)` : ''}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
