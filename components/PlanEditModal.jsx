import React, { useMemo, useState } from 'react';
import { CalendarClock, Loader2, X, AlertCircle } from 'lucide-react';
import { PAID_LEAVE, UNPAID_LEAVE, leaveCode, leaveText } from '../lib/leaveCodes';

/*
 * แก้ "ตารางงานที่ลงไว้" ของหนึ่งคนหนึ่งวัน — เปิดจากช่องฝั่งซ้ายของตารางในหน้า "ดูสแกนหน้า"
 *
 * ตัวเลือกทุกช่องเหมือนหน้าลงตารางของ Narai-branch (นาทีทีละ 10, ออกถึง 24:00, เบรคทีละครึ่งชั่วโมง,
 * รหัสลาชุดเดียวกัน) ค่าที่บันทึกจึงขึ้นในหน้าสาขาได้ตรงทุกช่อง
 * บันทึกผ่าน /api/hr-schedule-edit → office-server (editTimesheetEntry) เขียนทับแถวเดิมใน hr_timesheet
 * ช่องอื่นของแถว (OT, ชม.สะสม, หมายเหตุ, ผู้อนุมัติ OT) คงเดิม ค่าแรงคิดใหม่ฝั่งเซิร์ฟเวอร์
 */

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const HOURS_OUT = Array.from({ length: 25 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = ['00', '10', '20', '30', '40', '50'];
const BREAKS = [
  { value: '', label: '— ไม่ได้ลง —' },
  { value: '0', label: 'ไม่เบรค' },
  ...Array.from({ length: 10 }, (_, i) => ({ value: String((i + 1) * 30), label: `${(i + 1) / 2} ชั่วโมง` })),
];

const splitTime = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  return m ? [m[1].padStart(2, '0'), m[2]] : ['', ''];
};

/** ค่าในตัวเลือกสถานะ: 'work' | 'paid:13' | 'unpaid:21' | 'legacy' (แถวเก่าที่ติ๊กหยุดไว้โดยไม่มีรหัส) */
function initialStatus(plan) {
  if (plan.leaveNote) return `paid:${leaveCode(plan.leaveNote) || plan.leaveNote}`;
  if (plan.unpaidLeave) return `unpaid:${leaveCode(plan.unpaidLeave) || plan.unpaidLeave}`;
  if (plan.status === 'หยุด') return 'legacy';
  return 'work';
}

/** ช่องเลือก ชม. + นาที — ค่าเดิมที่ไม่อยู่ในรายการ (เช่นนาที 35 ของข้อมูลเก่า) ยังโชว์ให้เห็น */
function TimePick({ value, onChange, hours, allowEmpty = false }) {
  const [h, m] = value;
  const minOpts = m && !MINUTES.includes(m) ? [m, ...MINUTES] : MINUTES;
  const hourOpts = h && !hours.includes(h) ? [h, ...hours] : hours;
  const cls = 'px-2 py-1.5 border border-slate-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-400 outline-none';
  return (
    <div className="flex items-center gap-1">
      <select value={h} onChange={(e) => onChange([e.target.value, e.target.value ? (m || '00') : ''])} className={cls}>
        {allowEmpty || !h ? <option value="">--</option> : null}
        {hourOpts.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
      <span className="text-slate-400">:</span>
      <select value={m} onChange={(e) => onChange([h, e.target.value])} disabled={!h} className={`${cls} disabled:opacity-50`}>
        {!m ? <option value="">--</option> : null}
        {minOpts.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
    </div>
  );
}

export default function PlanEditModal({ row, onClose, onSaved }) {
  const plan = row.plan;
  const [status, setStatus] = useState(() => initialStatus(plan));
  const [inT, setInT] = useState(() => splitTime(plan.in));
  const [outT, setOutT] = useState(() => splitTime(plan.out));
  const [brk, setBrk] = useState(() => (plan.breakAllowed != null ? String(Math.round(plan.breakAllowed)) : ''));
  const [brkStart, setBrkStart] = useState(() => splitTime(plan.breakOut));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const off = status !== 'work';
  // รหัสลาเก่าที่ไม่อยู่ในรายการ (ข้อความล้วนก่อนเปลี่ยนมาใช้รหัส) — ยังให้เห็นและเลือกค้างไว้ได้
  const extraLeave = useMemo(() => {
    const [kind, code] = status.split(':');
    if (!code) return null;
    const list = kind === 'paid' ? PAID_LEAVE : UNPAID_LEAVE;
    return list.some((l) => l.code === code) ? null : { kind, code };
  }, [status]);
  const breakOpts = brk && !BREAKS.some((b) => b.value === brk) ? [...BREAKS, { value: brk, label: `${brk} นาที (ค่าเดิม)` }] : BREAKS;

  const join = ([h, m]) => (h ? `${h}:${m || '00'}` : '');

  const save = async () => {
    if (status === 'legacy') { setErr('เลือกสถานะของวันนี้ก่อน (มาทำงาน หรือรหัสลา/หยุด)'); return; }
    const [kind, code] = status.split(':');
    const body = {
      workDate: plan.workDate || row.date,
      branch: plan.storedBranch,
      hrCode: plan.hrCode,
      leaveNote: kind === 'paid' ? code : '',
      unpaidLeave: kind === 'unpaid' ? code : '',
      checkIn: off ? '' : join(inT),
      checkOut: off ? '' : join(outT),
      breakMinutes: off ? '' : brk,
      breakStart: off || !brk || brk === '0' ? '' : join(brkStart),
    };
    if (!off) {
      if (!body.checkIn) { setErr('กรุณาระบุเวลาเข้า หรือเลือกว่าเป็นวันหยุด/วันลา'); return; }
      const offGrid = [body.checkIn, body.checkOut, body.breakStart].some((t) => t && !/:[0-5]0$/.test(t));
      if (offGrid) { setErr('นาทีต้องเป็นทีละ 10 (00, 10, …, 50) เหมือนหน้าลงตารางของสาขา'); return; }
    }

    setSaving(true);
    setErr('');
    try {
      const res = await fetch('/api/hr-schedule-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.status !== 'success') {
        throw new Error((json && (json.hint ? `${json.message} — ${json.hint}` : json.message)) || `บันทึกไม่สำเร็จ (${res.status})`);
      }
      onSaved(json.data, body);
    } catch (e) {
      setErr(e.message || 'บันทึกไม่สำเร็จ');
      setSaving(false);
    }
  };

  const selCls = 'w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-400 outline-none';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !saving && onClose()}>
      <div className="w-full max-w-md max-h-[90vh] overflow-auto rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 bg-indigo-50/60 px-5 py-3">
          <div>
            <h3 className="flex items-center gap-2 font-bold text-slate-800"><CalendarClock size={18} className="text-indigo-600" /> แก้ตารางงานที่ลงไว้</h3>
            <div className="mt-0.5 text-xs text-slate-500">
              {row.date} · {row.name || plan.hrCode} · {String(plan.storedBranch || row.branch).toUpperCase()}
            </div>
          </div>
          <button onClick={onClose} disabled={saving} className="p-1 text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <div className="mb-1.5 text-xs font-semibold text-slate-500">สถานะ</div>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={selCls}>
              {status === 'legacy' && <option value="legacy">หยุด (แถวเก่า ไม่มีรหัส) — เลือกใหม่</option>}
              <option value="work">มาทำงาน</option>
              <optgroup label="ลา (รับค่าแรง)">
                {PAID_LEAVE.map((l) => <option key={`p${l.code}`} value={`paid:${l.code}`}>{l.code} {l.label}</option>)}
                {extraLeave?.kind === 'paid' && <option value={`paid:${extraLeave.code}`}>{leaveText(extraLeave.code)} (ค่าเดิม)</option>}
              </optgroup>
              <optgroup label="หยุด (ไม่รับค่าแรง)">
                {UNPAID_LEAVE.map((l) => <option key={`u${l.code}`} value={`unpaid:${l.code}`}>{l.code} {l.label}</option>)}
                {extraLeave?.kind === 'unpaid' && <option value={`unpaid:${extraLeave.code}`}>{leaveText(extraLeave.code)} (ค่าเดิม)</option>}
              </optgroup>
            </select>
          </div>

          {!off && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1.5 text-xs font-semibold text-slate-500">เวลาเข้า</div>
                  <TimePick value={inT} onChange={setInT} hours={HOURS} />
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-semibold text-slate-500">เวลาออก</div>
                  <TimePick value={outT} onChange={setOutT} hours={HOURS_OUT} allowEmpty />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1.5 text-xs font-semibold text-slate-500">เบรค</div>
                  <select value={brk} onChange={(e) => setBrk(e.target.value)} className={selCls}>
                    {breakOpts.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                  </select>
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-semibold text-slate-500">เริ่มเบรค (ไม่บังคับ)</div>
                  {brk && brk !== '0'
                    ? <TimePick value={brkStart} onChange={setBrkStart} hours={HOURS} allowEmpty />
                    : <div className="py-2 text-xs text-slate-400">—</div>}
                </div>
              </div>
            </>
          )}

          <p className="text-[11px] leading-relaxed text-slate-400">
            บันทึกทับแถวเดียวกับที่สาขาลงไว้ หน้าลงตารางของสาขาจะเห็นค่าใหม่ทันทีที่โหลดหน้า
            · OT, ชม.สะสม, หมายเหตุ และผู้อนุมัติ OT คงเดิม · ค่าแรงคิดใหม่ด้วยสูตรเดียวกับหน้าสาขา
            · ออฟฟิศแก้ได้แม้วันนั้นจะถูกล็อก
          </p>

          {err && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" /><span>{err}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button onClick={onClose} disabled={saving} className="px-4 py-2 rounded-xl text-sm font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            ยกเลิก
          </button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
            {saving && <Loader2 size={15} className="animate-spin" />} บันทึก
          </button>
        </div>
      </div>
    </div>
  );
}
