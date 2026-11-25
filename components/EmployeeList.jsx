import React, { useState, useEffect, useMemo } from 'react';
import { apiCall } from '../lib/stockApi';
import { Users, Loader2, Search, Gift, Image as ImageIcon, AlertCircle, Pencil, X, CheckCircle, Upload, ArrowLeftRight, Lock, FileSpreadsheet, Paperclip } from 'lucide-react';
import EmployeeMovements from './EmployeeMovements';
import { useBranches } from '../lib/useBranches';
import { parseEmployeeWorkbook } from '../lib/employeeSheetImport';
import hotToast from 'react-hot-toast';
import { NatBadge, DocStatusBadge, DocAlertPanel, EmployeeDocModal } from './EmployeeDocs';
import { docIssues, isForeign, parseForeignSheet } from '../lib/employeeDocs';

/** เรียก /api/employee-docs — โยน Error พร้อมข้อความจริง (และคำแนะนำ) เมื่อฝั่งเซิร์ฟเวอร์ตอบว่าทำไม่ได้ */
async function docsApi(body) {
  const r = await fetch('/api/employee-docs', body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.status !== 'success') {
    throw new Error([j?.message || `HTTP ${r.status}`, j?.hint].filter(Boolean).join(' — '));
  }
  return j;
}

/** ลิงก์ไฟล์ — ไฟล์ที่เก็บบนเครื่องออฟฟิศเป็น 'file:<path>' เปิดผ่าน /api/employee-file ส่วนลิงก์ Drive เดิมใช้ตรง ๆ */
const fileHref = (v) => {
  const s = String(v ?? '').trim();
  return s.startsWith('file:') ? `/api/employee-file?path=${encodeURIComponent(s.slice(5))}` : s;
};

const todayYmd = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const thShort = (ymd) => {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : (ymd || '-');
};
const thStamp = (v) => {
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?/);
  return m ? `${thShort(m[1])}${m[2] ? ` ${m[2]}` : ''}` : (v || '-');
};

/** เรียก /api/employee-hr แบบ POST — โยน Error พร้อมข้อความจริงเมื่อทำไม่สำเร็จ */
async function hrPost(body) {
  const r = await fetch('/api/employee-hr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.status !== 'success') throw new Error([j?.message || `HTTP ${r.status}`, j?.hint].filter(Boolean).join(' — '));
  return j;
}

/** ช่องข้อมูลส่วนตัว (เห็นเฉพาะออฟฟิศ) — key ตรงกับ saveEmployeeProfile ของ office-server */
const PROFILE_FIELDS = [
  { key: 'phone', label: 'เบอร์โทร' },
  { key: 'lineId', label: 'ID LINE' },
  { key: 'idCard', label: 'เลขประจำตัวประชาชน' },
  { key: 'birthday', label: 'วันเกิด', type: 'date' },
  { key: 'address', label: 'ที่อยู่', wide: true },
];
const emptyProfile = () => ({ phone: '', lineId: '', idCard: '', birthday: '', address: '' });

/** รหัสสาขาในช่องสาขาของพนักงาน — 'SUM, IPR' -> ['sum', 'ipr'] */
const branchCodesOf = (v) => String(v ?? '').toLowerCase().split(/[,/|;+&\s]+/).filter(Boolean);

// ฟิลด์ที่แก้ไขได้ (hrCode เป็นคีย์ ไม่ให้แก้)
// LABEL_OF ด้านล่างใช้แปลงชื่อฟิลด์เป็นชื่อไทยตอนรายงานว่าช่องไหนบันทึกไม่ได้
const EDIT_FIELDS = [
  { key: 'fullName', label: 'ชื่อ - นามสกุล', type: 'text' },
  // สาขาเปลี่ยนผ่าน "ย้ายสาขา" (เลือกจาก dropdown + วันที่มีผล) ไม่ได้เขียนตรงด้วย saveEmployee — ดู saveEmployee ด้านล่าง
  { key: 'branch', label: 'สาขา', type: 'branch' },
  { key: 'status', label: 'สถานะ', type: 'select', options: ['ทำงาน', 'ลาออก'] },
  { key: 'type', label: 'ประเภท', type: 'text' },
  { key: 'position', label: 'ตำแหน่ง', type: 'text' },
  { key: 'startDate', label: 'วันเริ่มทำงาน', type: 'text', hint: 'เช่น 31/03/2545 (พ.ศ.) หรือ 2002-03-31' },
  { key: 'dailyWage', label: 'ค่าแรงต่อวัน (บาท)', type: 'text', hint: 'ใช้คิดค่าแรงในหน้าลงตารางงานของสาขา · 0 = ยังไม่ได้ตั้ง' },
  { key: 'loga', label: 'เลขที่ LOGA', type: 'text' },
  { key: 'newCode', label: 'รหัสใหม่', type: 'text' },
  { key: 'photoUrl', label: 'ลิงก์รูป', type: 'text' },
];

const LABEL_OF = Object.fromEntries(EDIT_FIELDS.map(f => [f.key, f.label]));

/*
 * NARAI OFFICE — รายชื่อพนักงาน
 * ดึงผ่าน /api/stock-gas → action=getEmployees ซึ่งอ่านจาก narai_hr.dbo.hr_employee บน SQL Server
 * (ตารางเดียวกับตารางงาน/รายงานเงินเดือน) การแก้ไข (saveEmployee) เขียนกลับตารางเดียวกัน
 * — อ่านกับเขียนอยู่ที่เดียวเสมอ
 * แสดงผลให้เหมือนหน้า "รายชื่อพนักงาน" ของ narai-branch.vercel.app
 */

// แถว header ของชีต DATA (ค่าที่ไม่ใช่ข้อมูลพนักงานจริง) — ใช้กรองทิ้ง
const HEADER_HRCODES = ['รหัส hr', 'รหัส', 'hrcode'];

// แปลงวันที่ (รองรับทั้ง ค.ศ./พ.ศ. และรูปแบบ d/m/yyyy)
function parseThaiDate(dateStr) {
  if (!dateStr) return null;
  let d = new Date(dateStr);
  if (typeof dateStr === 'string' && dateStr.includes('/')) {
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      let year = parseInt(parts[2], 10);
      if (year > 2500) year -= 543;
      d = new Date(year, parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
    }
  } else if (!isNaN(d.getTime())) {
    if (d.getFullYear() > 2500) d.setFullYear(d.getFullYear() - 543);
  }
  return isNaN(d.getTime()) ? null : d;
}

function calculateDuration(startDateStr) {
  const start = parseThaiDate(startDateStr);
  if (!start) return '-';
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  let days = now.getDate() - start.getDate();
  if (days < 0) { months--; days += 30; }
  if (months < 0) { years--; months += 12; }
  const result = [];
  if (years > 0) result.push(`${years} ปี`);
  if (months > 0) result.push(`${months} เดือน`);
  if (years === 0 && days > 0) result.push(`${days} วัน`);
  if (result.length === 0) return 'เริ่มงานวันนี้';
  return result.join(' ');
}

function formatDate(dateStr) {
  const d = parseThaiDate(dateStr);
  if (!d) return dateStr || '-';
  return d.toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function EmployeeList() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [editEmp, setEditEmp] = useState(null);   // { ...ค่าที่กำลังแก้, _orig }
  const [toast, setToast] = useState(null);       // { ok, msg } — โชว์ที่หัวหน้า (เห็นตอนฟอร์มปิดแล้ว)

  /* ================== สัญชาติ + เอกสารพนักงานต่างชาติ ==================
     ข้อมูลอยู่ที่ dbo.employee_doc ตารางเดียวกับเว็บสาขา (ผ่าน /api/employee-docs -> office-server)
     จับคู่กับแถวพนักงานด้วยรหัส HR ที่หน้าเว็บ
       ไม่มีแถวเอกสาร      = คนไทย (ค่าเริ่มต้น)
       แถวที่ไม่มีรหัส HR   = นำเข้าจาก Excel แล้วชื่อไม่ตรงกับใคร รอกดผูกเอง */
  const [natFilter, setNatFilter] = useState('');   // '' | 'thai' | 'foreign' | 'alert'
  const [docs, setDocs] = useState([]);
  const [docTarget, setDocTarget] = useState(null); // { employee | null, doc | null }
  const [importingDocs, setImportingDocs] = useState(false);

  /* ================== ข้อมูลส่วนตัว (เห็นและแก้ได้เฉพาะออฟฟิศ) + พนักงานเข้า-ออก ==================
     ข้อมูลส่วนตัวอยู่ที่ dbo.hr_employee_profile (/api/employee-hr) สาขาไม่ได้รับข้อมูลชุดนี้เลย */
  const [profiles, setProfiles] = useState(() => new Map());
  const [profileDraft, setProfileDraft] = useState(emptyProfile);
  const [showMovements, setShowMovements] = useState(false);
  const [importingSheet, setImportingSheet] = useState(false);

  const loadProfiles = async () => {
    try {
      const r = await fetch('/api/employee-hr?view=profiles', { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (j?.status === 'success') setProfiles(new Map((j.data || []).map(p => [String(p.hrCode).trim().toLowerCase(), p])));
    } catch (err) {
      console.warn('โหลดข้อมูลส่วนตัวพนักงานไม่สำเร็จ:', err?.message || err);
    }
  };
  useEffect(() => { loadProfiles(); }, []);

  /* ================== ย้ายสาขา ==================
     ตั้งย้ายจากฟอร์มแก้ไข (dropdown สาขา + วันที่มีผล) → office-server ย้ายให้เองเมื่อถึงวัน (branch-transfer.js)
     pendingMoves = รายการรอย้ายของทุกคน ไว้ขึ้นป้าย "รอย้าย" ในตาราง
     personMoves  = ประวัติสาขาของคนที่เปิดกล่องข้อมูลอยู่ */
  const { branches: registry } = useBranches();
  const [pendingMoves, setPendingMoves] = useState(() => new Map());
  const [personMoves, setPersonMoves] = useState(null);   // { hrCode, data[], joined, loading, error }
  const [cancellingMove, setCancellingMove] = useState(0);

  const loadPendingMoves = async () => {
    try {
      const r = await fetch('/api/employee-hr?view=transfers&pending=1', { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (j?.status === 'success') setPendingMoves(new Map((j.data || []).map(t => [String(t.hrCode).trim().toLowerCase(), t])));
    } catch (err) {
      console.warn('โหลดรายการรอย้ายสาขาไม่สำเร็จ:', err?.message || err);
    }
  };
  useEffect(() => { loadPendingMoves(); }, []);
  const pendingOf = (emp) => (emp?.hrCode ? pendingMoves.get(String(emp.hrCode).trim().toLowerCase()) || null : null);

  const loadPersonMoves = async (hrCode) => {
    if (!hrCode) { setPersonMoves(null); return; }
    setPersonMoves({ hrCode, data: [], joined: null, loading: true, error: '' });
    try {
      const r = await fetch(`/api/employee-hr?view=transfers&hrCode=${encodeURIComponent(hrCode)}`, { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.status !== 'success') throw new Error(j?.message || `HTTP ${r.status}`);
      setPersonMoves({ hrCode, data: j.data || [], joined: j.joined || null, loading: false, error: '' });
    } catch (err) {
      setPersonMoves({ hrCode, data: [], joined: null, loading: false, error: err.message || 'โหลดประวัติสาขาไม่สำเร็จ' });
    }
  };

  const cancelMove = async (t) => {
    if (!window.confirm(`ยกเลิกการย้าย ${t.fullName} ไป ${t.toBranch.toUpperCase()} (มีผล ${thShort(t.effectiveDate)}) ?`)) return;
    setCancellingMove(t.id);
    try {
      const j = await hrPost({ action: 'cancelTransfer', transferId: t.id });
      hotToast.success(j.data?.message || 'ยกเลิกแล้ว');
      await Promise.all([loadPendingMoves(), loadPersonMoves(t.hrCode)]);
    } catch (err) {
      hotToast.error(err.message || 'ยกเลิกไม่สำเร็จ');
    } finally {
      setCancellingMove(0);
    }
  };

  /** ข้อมูลพนักงาน (รหัส/สาขา/สถานะ/ประเภท/ตำแหน่ง/วันเริ่มงาน/ค่าแรง/LOGA ...) ในกล่องข้อมูลพนักงาน
      โหมดดู = สรุปสั้น ๆ · โหมดแก้ไข = ฟอร์มเต็ม (ชื่ออยู่ช่องบนสุดของกล่องอยู่แล้ว จึงไม่ซ้ำที่นี่)
      ค่าที่กำลังแก้อยู่ใน editEmp แล้วบันทึกพร้อมกันตอนกด "บันทึก" ของกล่อง (handleDocSave) */
  const renderEmployeeForm = (editing) => {
    const emp = docTarget?.employee;
    if (!emp) return null;
    if (!editing || !editEmp) {
      const items = [
        ['สถานะ', emp.status || 'ทำงาน'],
        ['วันเริ่มทำงาน', formatDate(emp.startDate)],
        ['ค่าแรงต่อวัน', Number(emp.dailyWage) > 0 ? `${Number(emp.dailyWage).toLocaleString('th-TH')} บาท` : 'ยังไม่ตั้ง'],
        ['เลขที่ LOGA', emp.loga || '-'],
      ];
      return (
        <section>
          <h4 className="text-xs font-bold text-gray-500 tracking-wide mb-2">ข้อมูลพนักงาน</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {items.map(([k, v]) => (
              <div key={k} className="bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
                <p className="text-[11px] font-semibold text-slate-400">{k}</p>
                <p className={`text-sm font-semibold ${v === 'ยังไม่ตั้ง' ? 'text-rose-600' : 'text-slate-800'}`}>{v}</p>
              </div>
            ))}
          </div>
        </section>
      );
    }
    return (
      <section>
        <h4 className="text-xs font-bold text-gray-500 tracking-wide mb-2">ข้อมูลพนักงาน</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-slate-50/70 border border-slate-200 rounded-xl p-4">
              {(() => {
                const nc = String(editEmp._newCode || '').trim();
                const changedCode = nc !== String(editEmp.hrCode || '').trim();
                const dup = changedCode && codeTaken(nc, editEmp.hrCode);
                const bad = changedCode && !/^[A-Za-z0-9-]{3,30}$/.test(nc);
                const owner = dup ? employees.find(e => String(e.hrCode || '').trim().toLowerCase() === nc.toLowerCase()) : null;
                return (
                  <div className="sm:col-span-2">
                    <label className="text-xs font-bold text-slate-500">รหัสพนักงาน</label>
                    <input value={editEmp._newCode} onChange={e => setField('_newCode', e.target.value.trim())}
                      className={`mt-1 block w-full sm:w-64 border rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 ${dup || bad ? 'border-rose-400 focus:ring-rose-400 bg-rose-50' : 'border-slate-200 focus:ring-purple-500'}`} />
                    {dup && (
                      <p className="mt-1 text-xs font-semibold text-rose-600 flex items-center gap-1">
                        <AlertCircle size={13} /> รหัส {nc} มีอยู่แล้ว ({owner?.fullName || '-'}{owner?.status === 'ลาออก' ? ' · ลาออกแล้ว' : ''}) — ใช้ซ้ำไม่ได้
                      </p>
                    )}
                    {bad && !dup && <p className="mt-1 text-xs font-semibold text-rose-600">ใช้ได้เฉพาะตัวอักษรอังกฤษ ตัวเลข และ - ยาว 3-30 ตัว</p>}
                    {changedCode && !dup && !bad && (
                      <div className="mt-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-900 space-y-0.5">
                        <p className="font-bold">⚠️ เปลี่ยนรหัส {editEmp.hrCode} → {nc}</p>
                        <p>ระบบเปลี่ยนรหัสให้ในตารางงาน ค่าแรง ข้อมูลส่วนตัว เอกสาร ประวัติ และยูนิฟอร์มของคนนี้ทั้งหมด</p>
                        <p>แต่ <b>เครื่องสแกนหน้า (ZKBio) ต้องเปลี่ยนรหัสเองให้ตรงกัน</b> ไม่งั้นสแกนใหม่จะไม่ผูกกับคนนี้</p>
                        <p>เวลาสแกนก่อนวันนี้ยังอยู่ใต้รหัสเดิม — หน้าดูสแกนหน้า/การคิดสายของวันก่อน ๆ อาจไม่เจอเวลาสแกนของคนนี้</p>
                      </div>
                    )}
                  </div>
                );
              })()}
              {EDIT_FIELDS.filter(f => f.key !== 'fullName').map(f => (
                <div key={f.key}>
                  <label className="text-xs font-bold text-slate-500">{f.label}</label>
                  {f.type === 'branch' ? (
                    <select value={String(editEmp.branch || '').toUpperCase()} onChange={e => setField('branch', e.target.value)}
                      className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-500">
                      {[...new Set([String(editEmp._orig.branch || '').toUpperCase(), ...registry.map(b => String(b.code).toUpperCase())])].filter(Boolean).map(code => {
                        const b = registry.find(x => String(x.code).toUpperCase() === code);
                        const cur = code === String(editEmp._orig.branch || '').toUpperCase();
                        return <option key={code} value={code}>{code}{b?.name ? ` — ${b.name}` : ''}{cur ? ' (สาขาปัจจุบัน)' : ''}</option>;
                      })}
                    </select>
                  ) : f.type === 'select' ? (
                    <select value={editEmp[f.key]} onChange={e => setField(f.key, e.target.value)}
                      className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-500">
                      {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input value={editEmp[f.key]} onChange={e => setField(f.key, e.target.value)}
                      className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
                  )}
                  {f.hint && <p className="text-[10px] text-slate-400 mt-0.5">{f.hint}</p>}
                  {f.type === 'branch' && pendingMoves.get(String(editEmp.hrCode).trim().toLowerCase()) && (
                    <p className="text-[11px] text-amber-700 mt-1">มีรายการรอย้ายไป {pendingMoves.get(String(editEmp.hrCode).trim().toLowerCase()).toBranch.toUpperCase()} อยู่แล้ว — ยกเลิกได้ที่ประวัติสาขาด้านล่าง</p>
                  )}
                </div>
              ))}
              {!sameValue('branch', editEmp.branch, editEmp._orig.branch) && (
                <div className="sm:col-span-2 bg-cyan-50 border border-cyan-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <p className="sm:col-span-2 text-sm font-bold text-cyan-800">
                    ⇄ ย้ายสาขา {String(editEmp._orig.branch || '-').toUpperCase()} → {String(editEmp.branch || '').toUpperCase()}
                  </p>
                  <div>
                    <label className="text-xs font-bold text-slate-500">วันที่มีผล</label>
                    <input type="date" value={editEmp._moveDate} onChange={e => setField('_moveDate', e.target.value)}
                      className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500" />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-500">เหตุผล</label>
                    <input value={editEmp._moveReason} onChange={e => setField('_moveReason', e.target.value)} placeholder="เช่น ขอย้ายใกล้บ้าน"
                      className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500" />
                  </div>
                  <p className="sm:col-span-2 text-xs text-cyan-800">
                    {editEmp._moveDate > todayYmd()
                      ? `ยังอยู่สาขาเดิมจนถึงวันที่มีผล — ระบบย้ายให้เองวันที่ ${thShort(editEmp._moveDate)}`
                      : 'ย้ายทันทีเมื่อกดบันทึก'}
                    {' · '}ตารางงานเก่าอยู่ที่สาขาเดิม · เก็บประวัติการย้ายให้อัตโนมัติ
                  </p>
                </div>
              )}
        </div>
      </section>
    );
  };

  /** ส่วนประวัติสาขาในกล่องข้อมูลพนักงาน */
  const renderBranchHistory = () => {
    const emp = docTarget?.employee;
    if (!emp) return null;
    const pm = personMoves && personMoves.hrCode === emp.hrCode ? personMoves : null;
    const pill = (code) => <span className="inline-flex px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-xs font-bold">{String(code || '-').toUpperCase()}</span>;
    return (
      <section>
        <h4 className="text-xs font-bold text-gray-500 tracking-wide mb-2">ประวัติสาขา</h4>
        {!pm || pm.loading ? (
          <p className="text-sm text-slate-400 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> กำลังโหลด...</p>
        ) : pm.error ? (
          <p className="text-sm text-rose-600">{pm.error}</p>
        ) : (
          <ol className="relative border-l-2 border-slate-200 ml-2 space-y-3">
            {pm.data.filter(t => t.status !== 'cancelled').map(t => (
              <li key={t.id} className="ml-4">
                <span className={`absolute -left-[7px] mt-1.5 w-3 h-3 rounded-full ring-2 ring-white ${t.status === 'pending' ? 'bg-amber-400' : 'bg-teal-600'}`} />
                <div className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-slate-800">
                  {pill(t.fromBranch)} <span className="text-slate-400">→</span> {pill(t.toBranch)}
                  {t.status === 'pending' && <span className="ml-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[11px] font-bold">รอย้าย</span>}
                  {t.status === 'pending' && (
                    <button onClick={() => cancelMove(t)} disabled={cancellingMove === t.id}
                      className="ml-1 px-2 py-0.5 rounded-md border border-rose-200 text-rose-600 text-[11px] font-semibold hover:bg-rose-50 disabled:opacity-50">
                      {cancellingMove === t.id ? 'กำลังยกเลิก…' : 'ยกเลิกการย้าย'}
                    </button>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  {t.status === 'pending' ? 'จะย้าย' : 'มีผล'} {thShort(t.effectiveDate)}
                  {t.reason ? ` · ${t.reason}` : ''} · บันทึกโดย {t.requestedBy || '-'} เมื่อ {thStamp(t.requestedAt)}
                </p>
              </li>
            ))}
            <li className="ml-4">
              <span className="absolute -left-[7px] mt-1.5 w-3 h-3 rounded-full ring-2 ring-white bg-emerald-500" />
              <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                เข้าทำงาน{pm.joined?.branch ? <>ที่ {pill(pm.joined.branch)}</> : ''}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                {thShort(pm.joined?.startDate || emp.startDate)}{pm.joined?.recordedBy ? ` · บันทึกโดย ${pm.joined.recordedBy}` : ''}
              </p>
            </li>
          </ol>
        )}
      </section>
    );
  };
  const profileOf = (emp) => (emp?.hrCode ? profiles.get(String(emp.hrCode).trim().toLowerCase()) || null : null);
  const draftFrom = (p) => ({ ...emptyProfile(), ...Object.fromEntries(PROFILE_FIELDS.map(f => [f.key, p?.[f.key] || ''])) });

  /** เปิดกล่องข้อมูลพนักงาน — เตรียมค่าข้อมูลส่วนตัวของคนนั้นไว้ให้ช่องแก้ไข */
  /** เปิดกล่องข้อมูลพนักงาน — edit = เปิดมาในโหมดแก้ไขเลย (ปุ่ม "แก้ไข" ท้ายแถว) */
  const openPerson = (employee, doc, edit = false) => {
    setProfileDraft(draftFrom(profileOf(employee)));
    setEditEmp(employee ? buildEdit(employee) : null);
    setDocTarget({ employee, doc, edit });
    loadPersonMoves(employee?.hrCode);
  };

  /** ส่วนข้อมูลส่วนตัวในกล่องข้อมูลพนักงาน (renderExtra ของ EmployeeDocModal) */
  const renderProfile = (editing) => {
    const emp = docTarget?.employee;
    if (!emp) return null;
    const p = profileOf(emp);
    const inputCls = 'block w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500';
    return (
      <section>
        <h4 className="text-xs font-bold text-gray-500 tracking-wide mb-2 flex items-center gap-2">
          ข้อมูลส่วนตัว
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[11px]"><Lock className="w-3 h-3" /> เห็นเฉพาะออฟฟิศ</span>
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2.5 bg-amber-50/60 border border-amber-200 rounded-xl px-4 py-3">
          {PROFILE_FIELDS.map(f => (
            <div key={f.key} className={f.wide ? 'md:col-span-2' : ''}>
              <label className="block text-xs font-semibold text-amber-800 mb-0.5">{f.label}</label>
              {editing ? (
                f.wide
                  ? <textarea rows={2} value={profileDraft[f.key]} onChange={e => setProfileDraft(d => ({ ...d, [f.key]: e.target.value }))} className={inputCls} />
                  : <input type={f.type || 'text'} value={profileDraft[f.key]} onChange={e => setProfileDraft(d => ({ ...d, [f.key]: e.target.value }))} className={inputCls} />
              ) : (
                <p className="text-sm font-semibold text-slate-800 break-words">
                  {f.type === 'date' ? (p?.[f.key] ? formatDate(p[f.key]) : '-') : (p?.[f.key] || '-')}
                </p>
              )}
            </div>
          ))}
          {(p?.documents || (p?.attachments || []).length > 0) && (
            <div className="md:col-span-2 text-sm text-slate-600 border-t border-amber-200 pt-2">
              <span className="text-xs font-semibold text-amber-800">เอกสารที่ยื่นตอนรับเข้า: </span>{p.documents || '-'}
              {(p.attachments || []).map((a, i) => (
                <a key={i} href={fileHref(a.path || a.url)} target="_blank" rel="noopener noreferrer"
                  className="ml-2 inline-flex items-center gap-1 text-purple-700 hover:underline"><Paperclip className="w-3 h-3" />{a.name || `ไฟล์ ${i + 1}`}</a>
              ))}
            </div>
          )}
        </div>
      </section>
    );
  };

  /** นำเข้าครั้งเดียวตอนย้ายมา SQL: ไฟล์ .xlsx ที่ดาวน์โหลดจากสเปรดชีตพนักงาน (แท็บ DATA / พนักงานเข้า / พนักงานออก) */
  const handleSheetImport = async (file) => {
    if (!file) return;
    setImportingSheet(true);
    const toastId = hotToast.loading('กำลังอ่านไฟล์...');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
      const { employees: emps, movements, found, missing } = parseEmployeeWorkbook(XLSX, wb);
      if (found.length === 0) throw new Error('ไม่พบแท็บ DATA / พนักงานเข้า / พนักงานออก ในไฟล์นี้');
      const ins = movements.filter(m => m.kind === 'in').length;
      const outs = movements.length - ins;
      if (!window.confirm(
        `พบข้อมูล: รายชื่อพนักงาน ${emps.length} คน · ประวัติเข้า ${ins} แถว · ประวัติออก ${outs} แถว`
        + (missing.length ? `\n(ไม่พบแท็บ: ${missing.join(', ')})` : '')
        + '\n\nนำเข้าเลยไหม? รายชื่อ/ข้อมูลส่วนตัวจะอัปเดตตามไฟล์ (ช่องว่างไม่ทับของเดิม) และประวัติที่เคยนำเข้าจะถูกแทนที่ทั้งชุด'
      )) { hotToast.dismiss(toastId); return; }

      const send = async (body) => {
        const r = await fetch('/api/employee-hr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'import', ...body }) });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || j.status !== 'success') throw new Error([j?.message || `HTTP ${r.status}`, j?.hint].filter(Boolean).join(' — '));
        return j.data || {};
      };
      const CHUNK = 400;
      for (let i = 0; i < emps.length; i += CHUNK) {
        hotToast.loading(`กำลังนำเข้ารายชื่อ ${Math.min(i + CHUNK, emps.length)}/${emps.length}...`, { id: toastId });
        await send({ kind: 'employees', rows: emps.slice(i, i + CHUNK) });
      }
      let skipped = 0;
      if (found.includes('พนักงานเข้า') || found.includes('พนักงานออก')) {
        for (let i = 0; i === 0 || i < movements.length; i += CHUNK) {
          hotToast.loading(`กำลังนำเข้าประวัติ ${Math.min(i + CHUNK, movements.length)}/${movements.length}...`, { id: toastId });
          const d = await send({ kind: 'movements', rows: movements.slice(i, i + CHUNK), reset: i === 0 });
          skipped += Number(d.skipped) || 0;
        }
      }
      hotToast.success(`นำเข้าแล้ว: รายชื่อ ${emps.length} คน · ประวัติ ${movements.length - skipped} แถว`
        + (skipped ? ` (ข้าม ${skipped} แถวที่ไม่มีวันที่)` : ''), { id: toastId, duration: 9000 });
      await Promise.all([fetchEmployees(), loadProfiles()]);
    } catch (err) {
      hotToast.error(err?.message || 'นำเข้าไม่สำเร็จ', { id: toastId });
    } finally {
      setImportingSheet(false);
    }
  };

  // เอกสารเป็นข้อมูลเสริมของหน้า โหลดไม่ได้รายชื่อพนักงานยังต้องใช้งานได้ตามปกติ (แค่ไม่มีป้าย/แจ้งเตือน)
  const loadDocs = async () => {
    try {
      const res = await docsApi();
      setDocs(res.data || []);
    } catch (err) {
      console.warn('โหลดข้อมูลเอกสารพนักงานไม่สำเร็จ:', err?.message || err);
    }
  };
  useEffect(() => { loadDocs(); }, []);

  const hrKey = (v) => String(v || '').trim().toLowerCase();
  const docByHr = useMemo(() => new Map(docs.filter(d => d.hrCode).map(d => [hrKey(d.hrCode), d])), [docs]);
  const docOf = (emp) => (emp?.hrCode ? docByHr.get(hrKey(emp.hrCode)) || null : null);

  const handleDocSave = async (form) => {
    const emp = docTarget?.employee;
    const newName = String(form.fullName || '').trim();
    if (!newName) { hotToast.error('กรอกชื่อ - นามสกุล'); return false; }
    try {
      // ข้อมูลพนักงาน (รหัส/ชื่อ/สาขา/ตำแหน่ง/ค่าแรง ...) ก่อน — รหัสอาจเปลี่ยน ส่วนที่เหลือต้องใช้รหัสใหม่
      const core = emp && editEmp ? await saveEmployeeCore(newName) : null;
      const code = core?.code || emp?.hrCode || '';
      const res = await docsApi({
        ...form,
        action: 'save',
        docId: docTarget?.doc?.docId || 0,
        hrCode: code || docTarget?.doc?.hrCode || '',
        fullName: newName,
        branch: emp ? emp.branch : form.branch,
      });
      const saved = res.data?.doc;
      // ข้อมูลส่วนตัว (เบอร์โทร/ที่อยู่ ...) — บันทึกเฉพาะเมื่อมีการเปลี่ยน
      if (emp) {
        const before = draftFrom(profileOf(emp));
        if (PROFILE_FIELDS.some(f => String(profileDraft[f.key] || '').trim() !== String(before[f.key] || '').trim())) {
          const r = await fetch('/api/employee-hr', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'saveProfile', hrCode: code, ...profileDraft }),
          });
          const j = await r.json().catch(() => null);
          if (!r.ok || !j || j.status !== 'success') {
            throw new Error(`บันทึกข้อมูลอื่นแล้ว แต่ข้อมูลส่วนตัวไม่สำเร็จ: ${[j?.message || `HTTP ${r.status}`, j?.hint].filter(Boolean).join(' — ')}`);
          }
          const prof = j.data?.profile;
          if (prof) setProfiles(m => new Map(m).set(String(prof.hrCode).trim().toLowerCase(), prof));
        }
      }
      hotToast.success([core?.msg, res.message || 'บันทึกแล้ว'].filter(Boolean).join(' · '), { duration: core?.msg ? 8000 : 4000 });
      if (saved) setDocs(list => [...list.filter(d => d.docId !== saved.docId), saved]);
      else loadDocs();
      // แถวพนักงานล่าสุด (รหัส/สาขา/ชื่ออาจเปลี่ยน) — ให้กล่องแสดงค่าใหม่ และเตรียมฟอร์มรอบหน้าจากค่าใหม่
      const fresh = core?.changed ? await fetchEmployees() : null;
      const freshEmp = (fresh || []).find(e => hrKey(e.hrCode) === hrKey(code)) || (emp ? { ...emp, fullName: newName } : null);
      setDocTarget(t => (t ? { ...t, employee: freshEmp || t.employee, doc: saved || t.doc, edit: false } : t));
      if (freshEmp) { setEditEmp(buildEdit(freshEmp)); loadPersonMoves(freshEmp.hrCode); }
      return true;
    } catch (err) {
      hotToast.error(err?.message || 'บันทึกไม่สำเร็จ');
      return false;
    }
  };

  const handleDocLink = async (hrCode) => {
    const doc = docTarget?.doc;
    if (!doc) return false;
    try {
      const res = await docsApi({ action: 'link', docId: doc.docId, hrCode });
      hotToast.success(res.message || 'ผูกกับพนักงานแล้ว');
      const linked = { ...doc, hrCode };
      setDocs(list => list.map(d => (d.docId === doc.docId ? linked : d)));
      openPerson(employees.find(e => hrKey(e.hrCode) === hrKey(hrCode)) || null, linked);
      return true;
    } catch (err) {
      hotToast.error(err?.message || 'ผูกไม่สำเร็จ');
      return false;
    }
  };

  const handleDocDelete = async () => {
    const doc = docTarget?.doc;
    if (!doc) return false;
    try {
      const res = await docsApi({ action: 'delete', docId: doc.docId });
      hotToast.success(res.message || 'ลบแล้ว');
      setDocs(list => list.filter(d => d.docId !== doc.docId));
      setDocTarget(null);
      return true;
    } catch (err) {
      hotToast.error(err?.message || 'ลบไม่สำเร็จ');
      return false;
    }
  };

  /** นำเข้าไฟล์ Excel "DATA พนักงานต่างชาติ" — อ่านในเบราว์เซอร์แล้วส่งเป็นแถวไปให้ office-server จับคู่กับพนักงาน */
  const handleDocImport = async (file) => {
    if (!file) return;
    setImportingDocs(true);
    const toastId = hotToast.loading('กำลังอ่านไฟล์...');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
      const { rows, dateNotes } = parseForeignSheet(aoa, XLSX.SSF.parse_date_code);
      if (rows.length === 0) throw new Error('ไม่พบข้อมูลพนักงานในไฟล์ (ต้องเป็นไฟล์รูปแบบ DATA พนักงานต่างชาติ)');
      if (!window.confirm(`พบข้อมูล ${rows.length} คน — นำเข้าเลยไหม?\n(คนที่เคยนำเข้าแล้วจะถูกเขียนทับด้วยข้อมูลในไฟล์นี้)`)) {
        hotToast.dismiss(toastId);
        return;
      }
      hotToast.loading(`กำลังนำเข้า ${rows.length} คน...`, { id: toastId });
      const res = await docsApi({ action: 'import', rows });
      const note = dateNotes ? ` · วันที่อ่านไม่ออก ${dateNotes} ช่อง (ดูในหมายเหตุของคนนั้น)` : '';
      hotToast.success(`${res.message || 'นำเข้าแล้ว'}${note}`, { id: toastId, duration: 9000 });
      await loadDocs();
    } catch (err) {
      hotToast.error(err?.message || 'นำเข้าไม่สำเร็จ', { id: toastId });
    } finally {
      setImportingDocs(false);
    }
  };

  useEffect(() => { fetchEmployees(); }, []);

  // แก้ไขวันเริ่มงานให้อ่านง่ายในช่องกรอก (คงค่าเดิมถ้าไม่ใช่วันที่มาตรฐาน)
  const startDateForInput = (v) => {
    const d = parseThaiDate(v);
    if (!d) return v ?? '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getFullYear() + 543}`; // แสดงเป็น พ.ศ. d/m/yyyy
  };

  /** ค่าตั้งต้นของฟอร์มข้อมูลพนักงานจากแถวพนักงาน (_orig ไว้เทียบว่าช่องไหนถูกแก้) */
  const buildEdit = (emp) => {
    const base = {};
    EDIT_FIELDS.forEach(f => {
      base[f.key] = f.key === 'startDate' ? startDateForInput(emp[f.key]) : (emp[f.key] ?? '');
    });
    return { hrCode: emp.hrCode, _newCode: emp.hrCode, ...base, _orig: { ...base }, _moveDate: todayYmd(), _moveReason: '' };
  };

  const setField = (key, val) => setEditEmp(m => ({ ...m, [key]: val }));

  // เทียบค่าที่ส่งไปกับค่าที่อ่านกลับมา — วันเริ่มงานเทียบเป็น "วันเดียวกันไหม"
  // เพราะชีท/ฐานอาจเก็บคนละรูปแบบ (31/03/2545 กับ 2002-03-31 คือวันเดียวกัน)
  const sameValue = (key, a, b) => {
    if (key === 'startDate') {
      const da = parseThaiDate(a);
      const db = parseThaiDate(b);
      if (da && db) return da.getTime() === db.getTime();
    }
    if (key === 'dailyWage') return Number(String(a ?? '').replace(/,/g, '') || 0) === Number(String(b ?? '').replace(/,/g, '') || 0);
    // สาขาเก็บตัวพิมพ์เล็กในฐาน แต่แสดงตัวพิมพ์ใหญ่ — เทียบแบบไม่สนตัวพิมพ์
    if (key === 'branch') return String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();
    return String(a ?? '').trim() === String(b ?? '').trim();
  };

  /** รหัสนี้มีคนใช้อยู่แล้วหรือยัง (รวมคนที่ลาออก) — เทียบแบบไม่สนตัวพิมพ์ ไม่นับตัวเอง */
  const codeTaken = (code, self) => {
    const c = String(code || '').trim().toLowerCase();
    return !!c && employees.some(e => String(e.hrCode || '').trim().toLowerCase() === c
      && String(e.hrCode || '').trim().toLowerCase() !== String(self || '').trim().toLowerCase());
  };

  /**
   * บันทึกข้อมูลพนักงานจาก editEmp — เรียกจาก handleDocSave ตอนกด "บันทึก" ของกล่องข้อมูลพนักงาน
   * ลำดับ: เปลี่ยนรหัส -> ช่องอื่น (saveEmployee) -> ย้ายสาขา · พลาดตรงไหนโยน Error ให้ผู้เรียกแจ้งผู้ใช้
   * @returns {{ code: string, msg: string, changed: boolean }}
   */
  const saveEmployeeCore = async (newName) => {
    {
      // ส่งเฉพาะฟิลด์ที่เปลี่ยน (กันเขียนทับค่าเดิมโดยไม่ตั้งใจ)
      const changed = {};
      EDIT_FIELDS.forEach(f => {
        if (f.key !== 'fullName' && String(editEmp[f.key] ?? '') !== String(editEmp._orig[f.key] ?? '')) changed[f.key] = editEmp[f.key];
      });
      // ชื่อมาจากช่องชื่อบนสุดของกล่อง
      if (newName && newName !== String(editEmp._orig.fullName ?? '').trim()) changed.fullName = newName;
      // สาขาไม่เขียนตรง — ไปเป็นรายการย้ายสาขาที่มีวันที่มีผลแทน (ย้ายทันทีถ้าเป็นวันนี้/ย้อนหลัง)
      const moveTo = changed.branch !== undefined && !sameValue('branch', changed.branch, editEmp._orig.branch) ? changed.branch : '';
      delete changed.branch;
      if (moveTo && !/^\d{4}-\d{2}-\d{2}$/.test(editEmp._moveDate || '')) throw new Error('ระบุวันที่มีผลของการย้ายสาขา');
      // รหัสพนักงาน — เปลี่ยนก่อนอย่างอื่น แล้วช่องที่เหลือบันทึกด้วยรหัสใหม่ (office-server renameEmployeeCode)
      const newCode = String(editEmp._newCode || '').trim();
      const codeChanged = newCode !== String(editEmp.hrCode || '').trim();
      if (codeChanged && codeTaken(newCode, editEmp.hrCode)) throw new Error(`รหัส ${newCode} มีอยู่แล้ว — ใช้ซ้ำไม่ได้`);
      if (codeChanged && !/^[A-Za-z0-9-]{3,30}$/.test(newCode)) throw new Error('รหัสพนักงานใช้ได้เฉพาะตัวอักษรอังกฤษ ตัวเลข และ - ยาว 3-30 ตัว');
      if (Object.keys(changed).length === 0 && !moveTo && !codeChanged) return { code: editEmp.hrCode, msg: '', changed: false };

      let code = editEmp.hrCode;
      let codeMsg = '';
      if (codeChanged) {
        const j = await hrPost({ action: 'renameCode', oldCode: code, newCode });
        code = newCode;
        codeMsg = j.data?.message || `เปลี่ยนรหัสเป็น ${newCode} แล้ว`;
        // ฟอร์มยังเปิดอยู่ถ้าช่องอื่นบันทึกพลาด — ให้ใช้รหัสใหม่ต่อ ไม่ไปเปลี่ยนซ้ำ
        setEditEmp(m => (m ? { ...m, hrCode: newCode, _newCode: newCode, _orig: { ...m._orig } } : m));
        await Promise.all([loadProfiles(), loadPendingMoves(), loadDocs()]);
      }

      let wrote = 0;
      let skipped = [];
      if (Object.keys(changed).length > 0) {
      const res = await apiCall('saveEmployee', { hrCode: code, ...changed });

      // บอกตามที่เขียนลงฐานได้จริง ไม่ใช่ตามจำนวนช่องที่ผู้ใช้แก้
      // ฝั่ง API คืน updated = ช่องที่เขียนได้ · skipped = ช่องที่ตารางไม่มีคอลัมน์รองรับ
      const d = res.data || {};
      wrote = Array.isArray(d.updated) ? d.updated.length : (Number(d.updated) ? Object.keys(changed).length : 0);
      skipped = Array.isArray(d.skipped) ? d.skipped : [];
      if (wrote === 0) {
        throw new Error(skipped.length
          ? `ไม่มีช่องไหนถูกบันทึก — ตารางพนักงานไม่มีคอลัมน์ของ ${skipped.map(k => LABEL_OF[k] || k).join(', ')}`
          : 'ไม่มีช่องไหนถูกบันทึกลงฐานข้อมูล (ลองใหม่อีกครั้ง)');
      }

      // แล้วอ่านรายชื่อใหม่มาเทียบว่า "ค่าที่เพิ่งส่งไปติดจริงไหม"
      // ทั้งอ่านและเขียนไปตารางเดียวกัน ปกติต้องตรงกันเสมอ — ไม่ตรง = ต้องขึ้นแดง ไม่ใช่ปิดฟอร์มเงียบ ๆ
      const fresh = await fetchEmployees();
      if (fresh) {
        const after = fresh.find(e => String(e.hrCode ?? '') === String(code ?? ''));
        const stale = Object.keys(changed).filter(k => !sameValue(k, after ? after[k] : undefined, changed[k]));
        if (!after || stale.length) {
          throw new Error((after
            ? `กดบันทึกแล้วแต่ค่าที่อ่านกลับมาจากฐานยังเป็นของเดิม: ${stale.map(k => LABEL_OF[k] || k).join(', ')}`
            : `บันทึกแล้วแต่หารหัส ${code} ในฐานข้อมูลไม่เจอ`)
            + ' — ลองใหม่อีกครั้ง ถ้ายังเป็นเหมือนเดิมให้แจ้ง IT ตรวจ narai_hr.dbo.hr_employee');
        }
      }
      }

      let moveMsg = '';
      if (moveTo) {
        try {
          const j = await hrPost({ action: 'transfer', hrCode: code, toBranch: moveTo, effectiveDate: editEmp._moveDate, reason: editEmp._moveReason });
          moveMsg = j.data?.message || 'บันทึกการย้ายสาขาแล้ว';
        } catch (err) {
          throw new Error(`${wrote ? `บันทึกช่องอื่นแล้ว ${wrote} ช่อง แต่` : ''}ย้ายสาขาไม่สำเร็จ: ${err.message}`);
        }
        await Promise.all([fetchEmployees(), loadPendingMoves()]);
      }

      if (wrote || codeChanged) await fetchEmployees();
      return {
        code,
        changed: true,
        msg: [codeMsg, wrote ? `บันทึกข้อมูลพนักงาน ${wrote} ช่อง` : '', moveMsg].filter(Boolean).join(' · ')
          + (skipped.length ? ` · ตารางไม่มีคอลัมน์: ${skipped.map(k => LABEL_OF[k] || k).join(', ')}` : ''),
      };
    }
  };

  const fetchEmployees = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await apiCall('getEmployees', { branch: 'all' });
      const list = (res.data || []).filter(emp => {
        const code = String(emp.hrCode ?? '').trim();
        // ตัดแถว header และแถวว่างออก
        if (!code && !emp.fullName) return false;
        if (HEADER_HRCODES.includes(code.toLowerCase())) return false;
        if (String(emp.fullName ?? '').trim() === 'ชื่อ - สกุล') return false;
        return true;
      });
      setEmployees(list);
      return list;
    } catch (err) {
      setError(err.message || 'เกิดข้อผิดพลาดในการดึงข้อมูลพนักงาน');
      return null;
    } finally {
      setLoading(false);
    }
  };

  const uniqueStatuses = ['ทำงาน', 'ลาออก'];
  const uniqueTypes = useMemo(
    () => [...new Set(employees.map(e => e.type || '-'))].filter(t => t && t !== '-'),
    [employees]
  );
  const uniqueBranches = useMemo(
    () => [...new Set(employees.map(e => e.branch || '-'))].filter(b => b && b !== '-'),
    [employees]
  );

  const filteredEmployees = useMemo(() => {
    const search = searchTerm.toLowerCase();
    return employees.filter(emp => {
      const hrCode = String(emp.hrCode ?? '').toLowerCase();
      const fullName = String(emp.fullName ?? '').toLowerCase();
      const position = String(emp.position ?? '').toLowerCase();
      const loga = String(emp.loga ?? '').toLowerCase();
      const matchesSearch =
        hrCode.includes(search) ||
        fullName.includes(search) ||
        position.includes(search) ||
        loga.includes(search);
      const matchesStatus = statusFilter
        ? String(emp.status).toLowerCase() === statusFilter.toLowerCase()
        : true;
      const matchesType = typeFilter ? emp.type === typeFilter : true;
      const matchesBranch = branchFilter ? emp.branch === branchFilter : true;
      const doc = emp.hrCode ? docByHr.get(String(emp.hrCode).trim().toLowerCase()) || null : null;
      const matchesNat = natFilter === 'thai' ? !isForeign(doc)
        : natFilter === 'foreign' ? isForeign(doc)
          : natFilter === 'alert' ? docIssues(doc).length > 0
            : true;
      return matchesSearch && matchesStatus && matchesType && matchesBranch && matchesNat;
    }).sort((a, b) => {
      if (a.status === 'ทำงาน' && b.status !== 'ทำงาน') return -1;
      if (a.status !== 'ทำงาน' && b.status === 'ทำงาน') return 1;
      return 0;
    });
  }, [employees, searchTerm, statusFilter, typeFilter, branchFilter, natFilter, docByHr]);

  const anniversaryEmployees = useMemo(() => {
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    return employees.filter(emp => {
      if (emp.status !== 'ทำงาน' || !emp.startDate) return false;
      const start = parseThaiDate(emp.startDate);
      if (!start) return false;
      return start.getMonth() === currentMonth && (currentYear - start.getFullYear()) >= 1;
    }).map(emp => ({ ...emp, yearsWorked: currentYear - parseThaiDate(emp.startDate).getFullYear() }));
  }, [employees]);

  /* รายการที่เข้ากล่องแจ้งเตือนเอกสาร: พนักงานที่ยังทำงานอยู่ + แถวจาก Excel ที่ยังไม่ผูกกับใคร
     (ไม่ผูกก็ต้องเตือน ไม่งั้นเอกสารของคนที่ชื่อสะกดไม่ตรงจะหมดอายุไปเงียบๆ) กรองสาขาอยู่ = เห็นเฉพาะสาขานั้น */
  const filterCodes = branchCodesOf(branchFilter);
  const inBranchFilter = (branch) => filterCodes.length === 0 || branchCodesOf(branch).some(c => filterCodes.includes(c));
  const docAlertEntries = [
    ...employees
      .filter(emp => emp.status !== 'ลาออก' && docOf(emp) && inBranchFilter(emp.branch))
      .map(emp => ({ key: `e-${emp.hrCode}`, name: emp.fullName, branch: emp.branch, doc: docOf(emp), employee: emp })),
    ...docs
      .filter(d => !d.hrCode && inBranchFilter(d.branch))
      .map(d => ({ key: `d-${d.docId}`, name: d.fullName, branch: d.branch, doc: d, employee: null, unlinked: true })),
  ];

  /** พนักงานที่ผูกกับแถวเอกสารนี้ได้: ยังทำงานอยู่ ยังไม่มีแถวเอกสาร และอยู่สาขาเดียวกัน (หาไม่เจอเลยค่อยให้เลือกจากทุกคน) */
  const linkCandidatesFor = (doc) => {
    const free = employees.filter(emp => emp.hrCode && emp.status !== 'ลาออก' && !docOf(emp));
    const codes = branchCodesOf(doc?.branch);
    const same = free.filter(emp => branchCodesOf(emp.branch).some(c => codes.includes(c)));
    return (same.length ? same : free).slice().sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
  };

  const foreignCount = employees.filter(emp => emp.status !== 'ลาออก' && isForeign(docOf(emp))).length;

  return (
    <div className="w-full">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        {/* Header */}
        <div className="p-6 md:p-8 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-purple-100 text-purple-600 rounded-xl">
              <Users className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-slate-800">รายชื่อพนักงาน</h2>
              <p className="text-sm text-slate-500 mt-1">ข้อมูลพนักงานทุกสาขา · แก้ไขได้</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {toast && (
              <span className={`inline-flex items-center gap-1 text-xs font-semibold ${toast.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                {toast.ok ? <CheckCircle size={13} /> : <AlertCircle size={13} />}{toast.msg}
              </span>
            )}
            <div className="bg-purple-50 text-purple-700 px-4 py-2 rounded-lg font-medium text-sm border border-purple-100 shadow-sm">
              {/* นับเฉพาะคนที่ยังทำงานอยู่ (สถานะว่างถือเป็นทำงาน — ตารางแสดงแบบเดียวกัน) ตามตัวกรองที่เลือก */}
              พนักงานที่ทำงานอยู่ {filteredEmployees.filter(emp => emp.status !== 'ลาออก').length} คน
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="m-6 p-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-sm flex items-center gap-2">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}

        <DocAlertPanel
          entries={docAlertEntries}
          showBranch
          onOpen={(entry) => openPerson(entry.employee, entry.doc)}
        />

        {/* Anniversary box */}
        {anniversaryEmployees.length > 0 && (
          <div className="bg-gradient-to-r from-purple-50 to-pink-50 border border-purple-100 rounded-2xl p-6 m-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="p-3 bg-white shadow-sm text-purple-600 rounded-xl flex-shrink-0">
                <Gift className="w-6 h-6" />
              </div>
              <div className="w-full">
                <h3 className="text-lg font-bold text-purple-900 mb-1">🎉 เดือนนี้มีพนักงานทำงานครบรอบปี {anniversaryEmployees.length} คน</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
                  {anniversaryEmployees.map((emp, i) => (
                    <div key={`${emp.hrCode}-${i}`} className="bg-white/80 backdrop-blur rounded-lg p-3 border border-purple-100 shadow-sm flex flex-col hover:shadow-md transition-shadow">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-bold text-slate-800 truncate pr-2">{emp.fullName}</span>
                        <span className="text-[11px] font-bold bg-purple-100 text-purple-700 px-2 py-1 rounded-full whitespace-nowrap">ครบ {emp.yearsWorked} ปี</span>
                      </div>
                      <div className="text-xs text-slate-500">รหัส: <span className="font-medium text-slate-700">{emp.hrCode}</span></div>
                      <div className="text-xs text-slate-500 truncate">ตำแหน่ง: {emp.position}</div>
                      <div className="text-xs text-slate-500">เข้าทำงาน: <span className="font-medium text-purple-700">{formatDate(emp.startDate)}</span></div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Search */}
        <div className="p-6 border-b border-slate-100 flex flex-wrap items-center gap-3">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-slate-400" />
            </div>
            <input
              type="text"
              placeholder="ค้นหาชื่อ, รหัส, ตำแหน่ง, เลข LOGA..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="block w-full md:w-80 pl-10 pr-3 py-2 border border-slate-200 rounded-xl leading-5 bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 sm:text-sm transition-colors"
            />
          </div>
          <label
            title="นำเข้าไฟล์ Excel DATA พนักงานต่างชาติ (สัญชาติ + เอกสาร + วันหมดอายุ)"
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border transition-colors shadow-sm ${importingDocs ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-wait' : 'bg-white text-purple-700 border-purple-200 hover:bg-purple-50 cursor-pointer'}`}
          >
            {importingDocs ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            นำเข้า Excel ต่างชาติ
            <input
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              disabled={importingDocs}
              onChange={(e) => { handleDocImport(e.target.files[0]); e.target.value = ''; }}
            />
          </label>
          <button
            onClick={() => setShowMovements(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-teal-600 text-white hover:bg-teal-700 shadow-sm"
          >
            <ArrowLeftRight className="w-4 h-4" /> พนักงานเข้า-ออก
          </button>
          <label
            title="นำเข้าครั้งเดียวตอนย้ายมา SQL: ไฟล์ .xlsx ที่ดาวน์โหลดจากสเปรดชีตพนักงาน (แท็บ DATA / พนักงานเข้า / พนักงานออก)"
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border transition-colors shadow-sm ${importingSheet ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-wait' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 cursor-pointer'}`}
          >
            {importingSheet ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
            นำเข้าชีทพนักงาน
            <input type="file" accept=".xlsx,.xls" className="hidden" disabled={importingSheet}
              onChange={(e) => { handleSheetImport(e.target.files[0]); e.target.value = ''; }} />
          </label>
          <div className="inline-flex border border-slate-200 rounded-xl overflow-hidden md:ml-auto">
            {[['', 'ทั้งหมด'], ['thai', 'คนไทย'], ['foreign', `ต่างชาติ${foreignCount ? ` ${foreignCount}` : ''}`], ['alert', 'เอกสารใกล้หมดอายุ']].map(([value, label]) => (
              <button
                key={value || 'all'}
                onClick={() => setNatFilter(value)}
                className={`px-3.5 py-2 text-sm font-semibold border-l first:border-l-0 border-slate-200 transition-colors ${natFilter === value ? 'bg-purple-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
              >{label}</button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-2 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">ลำดับ</th>
                <th className="px-2 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">รหัส HR</th>
                <th className="px-2 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">ชื่อ - นามสกุล</th>
                <th className="px-2 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">สัญชาติ</th>
                <th className="px-2 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <div className="flex flex-col gap-2">
                    <span>สาขา</span>
                    <select
                      className="block w-full text-xs py-1 px-2 border border-slate-200 rounded-lg bg-white focus:ring-purple-500 focus:border-purple-500 font-normal"
                      value={branchFilter}
                      onChange={(e) => setBranchFilter(e.target.value)}
                    >
                      <option value="">ทั้งหมด</option>
                      {uniqueBranches.map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </div>
                </th>
                <th className="px-2 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <div className="flex flex-col gap-2">
                    <span>สถานะ</span>
                    <select
                      className="block w-full text-xs py-1 px-2 border border-slate-200 rounded-lg bg-white focus:ring-purple-500 focus:border-purple-500 font-normal"
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                    >
                      <option value="">ทั้งหมด</option>
                      {uniqueStatuses.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </th>
                <th className="px-2 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <div className="flex flex-col gap-2">
                    <span>ประเภท</span>
                    <select
                      className="block w-full text-xs py-1 px-2 border border-slate-200 rounded-lg bg-white focus:ring-purple-500 focus:border-purple-500 font-normal"
                      value={typeFilter}
                      onChange={(e) => setTypeFilter(e.target.value)}
                    >
                      <option value="">ทั้งหมด</option>
                      {uniqueTypes.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </th>
                <th className="px-2 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">ตำแหน่ง</th>
                <th className="px-2 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">วันเริ่มทำงาน</th>
                <th className="px-2 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">ระยะเวลาทำงาน</th>
                <th className="px-2 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">เอกสาร</th>
                <th className="px-2 py-2 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">ค่าแรง/วัน</th>
                <th className="px-2 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">เลขที่ LOGA</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">รูป</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">แก้ไข</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={15} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center justify-center text-slate-500">
                      <Loader2 className="w-8 h-8 animate-spin text-purple-500 mb-2" />
                      <p>กำลังโหลดข้อมูล...</p>
                    </div>
                  </td>
                </tr>
              ) : filteredEmployees.length === 0 ? (
                <tr>
                  <td colSpan={15} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center justify-center text-slate-500">
                      <Users className="w-12 h-12 text-slate-300 mb-3" />
                      <p className="text-lg font-medium text-slate-900">ไม่พบข้อมูลพนักงาน</p>
                      <p className="text-sm mt-1">ลองปรับคำค้นหา หรือตัวกรองใหม่</p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredEmployees.map((emp, index) => (
                  <tr key={`${emp.hrCode}-${index}`} className="hover:bg-slate-50 transition-colors">
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-slate-500 text-center font-medium">{index + 1}</td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm font-medium text-purple-600">{emp.hrCode || '-'}</td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm font-medium">
                      {/* กดที่ชื่อ = เปิดกล่องข้อมูลพนักงาน (สัญชาติ + เอกสาร + วันหมดอายุ) */}
                      <button
                        type="button"
                        onClick={() => openPerson(emp, docOf(emp))}
                        title="ดูข้อมูลพนักงาน"
                        className="text-slate-900 underline decoration-purple-300 underline-offset-4 hover:text-purple-700 text-left"
                      >{emp.fullName || '-'}</button>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm"><NatBadge doc={docOf(emp)} /></td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm font-medium text-indigo-600">
                      {emp.branch || '-'}
                      {pendingOf(emp) && (
                        <span title={`ตั้งย้ายไว้ · ${pendingOf(emp).reason || ''}`}
                          className="ml-1.5 inline-flex px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-800 text-[10px] font-bold align-middle">
                          รอย้าย → {pendingOf(emp).toBranch.toUpperCase()} {thShort(pendingOf(emp).effectiveDate)}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm">
                      {emp.status === 'ลาออก' ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-100 text-rose-800">{emp.status}</span>
                      ) : (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">{emp.status || 'ทำงาน'}</span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-slate-500">
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">{emp.type || '-'}</span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-slate-500">{emp.position || '-'}</td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-slate-500">{formatDate(emp.startDate)}</td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-slate-900 font-medium">{calculateDuration(emp.startDate)}</td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm">
                      {emp.status === 'ลาออก' ? <span className="text-xs text-slate-300">—</span> : <DocStatusBadge doc={docOf(emp)} />}
                    </td>
                    <td className={`px-2 py-2 whitespace-nowrap text-sm text-right tabular-nums ${Number(emp.dailyWage) > 0 ? 'text-slate-900' : emp.status === 'ลาออก' ? 'text-slate-300' : 'text-rose-600 font-semibold'}`}
                      title={Number(emp.dailyWage) > 0 ? '' : 'ยังไม่ได้ตั้งค่าแรง — หน้าลงตารางงานจะคิดค่าแรงคนนี้เป็น 0'}>
                      {Number(emp.dailyWage) > 0 ? Number(emp.dailyWage).toLocaleString('th-TH') : (emp.status === 'ลาออก' ? '-' : 'ยังไม่ตั้ง')}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm font-mono text-slate-900">{emp.loga || '-'}</td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-center">
                      {emp.photoUrl ? (
                        <a href={fileHref(emp.photoUrl)} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs text-emerald-600 hover:text-emerald-800" title="ดูรูป">
                          <ImageIcon className="w-3.5 h-3.5" /> ดูรูป
                        </a>
                      ) : (
                        <span className="text-slate-300">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-center">
                      <button onClick={() => openPerson(emp, docOf(emp), true)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-purple-50 hover:text-purple-700 hover:border-purple-200 transition-colors">
                        <Pencil size={12} /> แก้ไข
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showMovements && (
        <EmployeeMovements
          branches={[...new Set(employees.flatMap(e => branchCodesOf(e.branch)))].sort()}
          onClose={() => setShowMovements(false)}
        />
      )}

      {/* กล่องข้อมูลพนักงาน — เปิดจากการกดที่ชื่อ หรือกดรายการในกล่องแจ้งเตือนเอกสาร */}
      {docTarget && (
        <EmployeeDocModal
          key={`${docTarget.employee?.hrCode || ''}-${docTarget.doc?.docId || 0}-${docTarget.edit ? 'e' : 'v'}`}
          employee={docTarget.employee}
          doc={docTarget.doc}
          onSave={handleDocSave}
          nameEditable
          initialEditing={!!docTarget.edit}
          renderExtra={(editing) => <>{renderEmployeeForm(editing)}{renderBranchHistory()}{renderProfile(editing)}</>}
          onCancelEdit={() => {
            setProfileDraft(draftFrom(profileOf(docTarget.employee)));
            if (docTarget.employee) setEditEmp(buildEdit(docTarget.employee));
          }}
          onClose={() => setDocTarget(null)}
          linkCandidates={docTarget.employee ? [] : linkCandidatesFor(docTarget.doc)}
          onLink={handleDocLink}
          onDelete={handleDocDelete}
        />
      )}

    </div>
  );
}
