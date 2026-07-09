import React, { useState, useEffect, useMemo } from 'react';
import { apiCall } from '../lib/stockApi';
import { Users, Loader2, Search, Gift, Image as ImageIcon, AlertCircle, Pencil, X, CheckCircle } from 'lucide-react';

// ฟิลด์ที่แก้ไขได้ (hrCode เป็นคีย์ ไม่ให้แก้)
const EDIT_FIELDS = [
  { key: 'fullName', label: 'ชื่อ - นามสกุล', type: 'text' },
  { key: 'branch', label: 'สาขา', type: 'text' },
  { key: 'status', label: 'สถานะ', type: 'select', options: ['ทำงาน', 'ลาออก'] },
  { key: 'type', label: 'ประเภท', type: 'text' },
  { key: 'position', label: 'ตำแหน่ง', type: 'text' },
  { key: 'startDate', label: 'วันเริ่มทำงาน', type: 'text', hint: 'เช่น 31/03/2545 (พ.ศ.) หรือ 2002-03-31' },
  { key: 'loga', label: 'เลขที่ LOGA', type: 'text' },
  { key: 'newCode', label: 'รหัสใหม่', type: 'text' },
  { key: 'photoUrl', label: 'ลิงก์รูป', type: 'text' },
];

/*
 * NARAI OFFICE — รายชื่อพนักงาน (โหมดดูอย่างเดียว)
 * ดึงข้อมูลจาก Google Sheet (ชีต DATA) ผ่าน Apps Script proxy /api/stock-gas → action=getEmployees
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
  const [savingEmp, setSavingEmp] = useState(false);
  const [toast, setToast] = useState(null);       // { ok, msg }

  useEffect(() => { fetchEmployees(); }, []);

  // แก้ไขวันเริ่มงานให้อ่านง่ายในช่องกรอก (คงค่าเดิมถ้าไม่ใช่วันที่มาตรฐาน)
  const startDateForInput = (v) => {
    const d = parseThaiDate(v);
    if (!d) return v ?? '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getFullYear() + 543}`; // แสดงเป็น พ.ศ. d/m/yyyy
  };

  const openEdit = (emp) => {
    const base = {};
    EDIT_FIELDS.forEach(f => {
      base[f.key] = f.key === 'startDate' ? startDateForInput(emp[f.key]) : (emp[f.key] ?? '');
    });
    setEditEmp({ hrCode: emp.hrCode, ...base, _orig: { ...base } });
  };

  const setField = (key, val) => setEditEmp(m => ({ ...m, [key]: val }));

  const saveEmployee = async () => {
    setSavingEmp(true);
    setToast(null);
    try {
      // ส่งเฉพาะฟิลด์ที่เปลี่ยน (กันเขียนทับค่าเดิมโดยไม่ตั้งใจ)
      const changed = {};
      EDIT_FIELDS.forEach(f => {
        if (String(editEmp[f.key] ?? '') !== String(editEmp._orig[f.key] ?? '')) changed[f.key] = editEmp[f.key];
      });
      if (Object.keys(changed).length === 0) { setToast({ ok: false, msg: 'ไม่มีการเปลี่ยนแปลง' }); setSavingEmp(false); return; }
      const res = await apiCall('saveEmployee', { hrCode: editEmp.hrCode, ...changed });
      setToast({ ok: true, msg: `บันทึก ${editEmp.hrCode} สำเร็จ (${Object.keys(changed).length} ช่อง)` });
      setEditEmp(null);
      fetchEmployees();
    } catch (err) {
      const msg = /unknown action/.test(err.message || '')
        ? 'ยังไม่ได้เพิ่ม action saveEmployee ใน Apps Script (ดูวิธีในแชท)'
        : (err.message || 'บันทึกไม่สำเร็จ');
      setToast({ ok: false, msg });
    } finally {
      setSavingEmp(false);
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
    } catch (err) {
      setError(err.message || 'เกิดข้อผิดพลาดในการดึงข้อมูลพนักงาน');
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
      const matchesSearch =
        hrCode.includes(search) || fullName.includes(search) || position.includes(search);
      const matchesStatus = statusFilter
        ? String(emp.status).toLowerCase() === statusFilter.toLowerCase()
        : true;
      const matchesType = typeFilter ? emp.type === typeFilter : true;
      const matchesBranch = branchFilter ? emp.branch === branchFilter : true;
      return matchesSearch && matchesStatus && matchesType && matchesBranch;
    }).sort((a, b) => {
      if (a.status === 'ทำงาน' && b.status !== 'ทำงาน') return -1;
      if (a.status !== 'ทำงาน' && b.status === 'ทำงาน') return 1;
      return 0;
    });
  }, [employees, searchTerm, statusFilter, typeFilter, branchFilter]);

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

  return (
    <div className="max-w-7xl mx-auto">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        {/* Header */}
        <div className="p-6 md:p-8 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-purple-100 text-purple-600 rounded-xl">
              <Users className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-slate-800">รายชื่อพนักงาน</h2>
              <p className="text-sm text-slate-500 mt-1">ข้อมูลพนักงานทุกสาขา (ดึงจาก Google Sheet · ดูอย่างเดียว)</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {toast && (
              <span className={`inline-flex items-center gap-1 text-xs font-semibold ${toast.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                {toast.ok ? <CheckCircle size={13} /> : <AlertCircle size={13} />}{toast.msg}
              </span>
            )}
            <div className="bg-purple-50 text-purple-700 px-4 py-2 rounded-lg font-medium text-sm border border-purple-100 shadow-sm">
              พนักงานทั้งหมด {filteredEmployees.length} คน
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
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Search */}
        <div className="p-6 border-b border-slate-100">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-slate-400" />
            </div>
            <input
              type="text"
              placeholder="ค้นหาชื่อ, รหัส, ตำแหน่ง..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="block w-full md:w-80 pl-10 pr-3 py-2 border border-slate-200 rounded-xl leading-5 bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 sm:text-sm transition-colors"
            />
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
                <th className="px-2 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">เลขที่ LOGA</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">รูป</th>
                <th className="px-2 py-2 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">แก้ไข</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={12} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center justify-center text-slate-500">
                      <Loader2 className="w-8 h-8 animate-spin text-purple-500 mb-2" />
                      <p>กำลังโหลดข้อมูล...</p>
                    </div>
                  </td>
                </tr>
              ) : filteredEmployees.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-6 py-12 text-center">
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
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-slate-900 font-medium">{emp.fullName || '-'}</td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm font-medium text-indigo-600">{emp.branch || '-'}</td>
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
                    <td className="px-2 py-2 whitespace-nowrap text-sm font-mono text-slate-900">{emp.loga || '-'}</td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-center">
                      {emp.photoUrl ? (
                        <a href={emp.photoUrl} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs text-emerald-600 hover:text-emerald-800" title="ดูรูป">
                          <ImageIcon className="w-3.5 h-3.5" /> ดูรูป
                        </a>
                      ) : (
                        <span className="text-slate-300">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-center">
                      <button onClick={() => openEdit(emp)}
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

      {/* Modal แก้ไขข้อมูลพนักงาน */}
      {editEmp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => !savingEmp && setEditEmp(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-800">✏️ แก้ไขข้อมูลพนักงาน <span className="font-mono text-sm text-slate-400 ml-1">รหัส {editEmp.hrCode}</span></h3>
              <button onClick={() => setEditEmp(null)} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
            </div>

            <div className="p-5 overflow-auto grid grid-cols-1 sm:grid-cols-2 gap-4">
              {EDIT_FIELDS.map(f => (
                <div key={f.key} className={f.key === 'fullName' ? 'sm:col-span-2' : ''}>
                  <label className="text-xs font-bold text-slate-500">{f.label}</label>
                  {f.type === 'select' ? (
                    <select value={editEmp[f.key]} onChange={e => setField(f.key, e.target.value)}
                      className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-500">
                      {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input value={editEmp[f.key]} onChange={e => setField(f.key, e.target.value)}
                      className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
                  )}
                  {f.hint && <p className="text-[10px] text-slate-400 mt-0.5">{f.hint}</p>}
                </div>
              ))}
            </div>

            <div className="p-5 border-t border-slate-100 flex items-center justify-end gap-2">
              <button onClick={() => setEditEmp(null)} disabled={savingEmp}
                className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">ยกเลิก</button>
              <button onClick={saveEmployee} disabled={savingEmp}
                className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-purple-500 hover:bg-purple-600 disabled:bg-slate-200 disabled:text-slate-400 rounded-xl">
                {savingEmp ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle size={15} />}
                {savingEmp ? 'กำลังบันทึก…' : 'บันทึก'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
