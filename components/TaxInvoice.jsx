// ACC › ใบกำกับภาษี (เต็มรูป)
//
// ตอบคำถามเดียว: "ใบกำกับภาษีที่ออกไปแล้วมีใบไหนบ้าง ใบล่าสุดเลขอะไร ของบิลวันไหน ยอดเท่าไหร่"
//
// ที่มาของข้อมูล: คอลัมน์ FullTaxInvNo ของบิลที่หน้า index โหลดไว้แล้ว (prop bills = salesAllRaw)
// หน้านี้ "ไม่ยิง API เอง" — ใช้แผงกรองช่วงวันที่/สาขาและข้อมูลชุดเดียวกับแดชบอร์ดและหน้ายอดขาย
// กดค้นหาทีเดียวได้ครบทุกหน้าในกลุ่ม (ดู SALES_TABS ใน pages/index.js)
// บิลไหนไม่มีเลขในคอลัมน์นี้แปลว่าไม่ได้ออกใบกำกับเต็มรูป จึงไม่ขึ้นในหน้านี้
// (บิลปกติออกแค่ใบเสร็จ/ใบกำกับอย่างย่อ = TaxInvNo)
//
// เรียง "ใบล่าสุดขึ้นก่อน" ตามวันเวลาปิดบิลจริง (เวลาที่ออกใบ) ใหม่สุดอยู่บนสุด
// เวลาซ้ำกันค่อยดูเลขวิ่งใน FullTaxInvNo — เทียบเฉพาะเลขวิ่ง ไม่เอารหัสสาขามาเทียบด้วย
// กดหัวคอลัมน์เพื่อเรียงแบบอื่นได้ แต่เปิดหน้ามาจะเจอใบล่าสุดอยู่บนสุดเสมอ
//
// หมายเหตุ: หน้านี้ใช้บิลชุด "ครบทุกแถว" ไม่ตัดโต๊ะ/บิลที่ยอดขายไม่นับ (เช่นโต๊ะ 600) ออก
// เพราะใบกำกับที่ออกไปแล้วคือเอกสารที่ลูกค้าถืออยู่จริง ต้องเห็นครบทุกใบ
// ยอดรวมของหน้านี้จึงไม่จำเป็นต้องเท่ากับยอดขายในหน้ารายงาน
import React, { useState, useMemo } from 'react';
import { FileText, Search, Eye, AlertCircle, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import * as XLSX from 'xlsx-js-style';
import { dateFromRow } from '../lib/salesFetch';
import { useBranches } from '../lib/useBranches';

const PAGE_SIZE = 50;

const fmtMoney = v => {
  const n = parseFloat(v);
  return isNaN(n) ? '-' : n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/**
 * เลขที่ใบกำกับที่ "ว่างจริง" — ทั้งช่องว่าง, ขีด และเลขศูนย์ล้วน
 * (บางสาขาเซ็ตให้ POS เขียน 0 ลงคอลัมน์แทนการปล่อยว่าง ถ้าไม่กันไว้จะกลายเป็นใบกำกับปลอม ๆ เต็มหน้า)
 */
const hasInvNo = v => {
  const s = String(v ?? '').trim();
  return s !== '' && s !== '-' && !/^0+$/.test(s);
};

/**
 * เลขวิ่งของใบกำกับ — ตัดรหัสสาขาที่นำหน้าอยู่ทิ้งก่อน แล้วค่อยเหลือไว้แต่ตัวเลข
 * (ถ้าเอารหัสสาขามาเทียบด้วยจะกลายเป็นเรียงตามสาขาก่อน ไม่ใช่เรียงใบล่าสุดก่อน)
 *
 * ต้องตัดด้วย "รหัสสาขาของแถวนั้น" ไม่ใช่ลบตัวอักษรทิ้งเฉย ๆ เพราะรหัสสาขาบางอันมีตัวเลขปนอยู่
 * (P90 → ถ้าลบแค่ตัวอักษร เลข 90 จะติดมาเป็นหลักหน้า ทำให้ใบของ P90 ลอยขึ้นบนสุดทุกที)
 * รหัสที่เป็นตัวเลขล้วน (สาขาที่ยังไม่ได้ลงทะเบียน เลยใช้เลข outlet แทนชื่อ) ไม่ตัด — เดี๋ยวจะไปกินเลขจริง
 */
const invSeqOf = (invNo, branchCode) => {
  let s = String(invNo ?? '').trim();
  const code = String(branchCode ?? '').trim();
  if (code && /[A-Za-z]/.test(code) && s.toUpperCase().startsWith(code.toUpperCase())) s = s.slice(code.length);
  return s.replace(/\D+/g, '');
};

/**
 * เทียบเลขวิ่ง: คืนค่าบวกเมื่อ a เป็นเลขที่มากกว่า (= ใบใหม่กว่า)
 * เทียบความยาวก่อนแล้วค่อยเทียบทีละตัวอักษร — ได้ผลเหมือนเทียบค่าตัวเลข
 * แต่ไม่ตกขอบเมื่อเลขยาวเกินที่ Number เก็บได้ และเลข 0 นำหน้าก็ไม่กวน
 */
const compareSeq = (a, b) => (a.length - b.length) || a.localeCompare(b);

/* คอลัมน์ในตาราง — sortVal คืนค่าที่เอาไปเรียง (ไม่มี sortVal = เรียงด้วยเลขวิ่งของใบ) */
const COLUMNS = [
  { key: 'invNo', label: 'เลขที่ใบกำกับภาษี', align: 'left' },
  { key: 'billTime', label: 'วันที่/เวลาปิดบิล', align: 'left', sortVal: r => r.billTime },
  { key: 'taxDate', label: 'วันที่ออกใบ', align: 'left', sortVal: r => r.taxDate || '' },
  { key: 'branch', label: 'สาขา', align: 'left', sortVal: r => r.branch },
  { key: 'checkID', label: 'เลขที่บิล', align: 'left', sortVal: r => String(r.checkID ?? '') },
  { key: 'checkDesc', label: 'รายละเอียด (Check Desc)', align: 'left', sortVal: r => r.checkDesc },
  { key: 'beforeVat', label: 'ยอดก่อน VAT', align: 'right', sortVal: r => r.beforeVat },
  { key: 'vat', label: 'VAT', align: 'right', sortVal: r => r.vat },
  { key: 'amount', label: 'ยอดขาย (รวม VAT)', align: 'right', sortVal: r => r.amount },
];

export default function TaxInvoice({
  bills = [],          // บิลทั้งช่วงที่หน้า index โหลดไว้ (salesAllRaw)
  loaded = false,      // กดค้นหาแล้วหรือยัง
  startDate = '',
  endDate = '',
  selectedOutlet = '',
  onOpenDetail,        // เปิดหน้าต่างรายการในบิล — ตัวเดียวกับที่หน้ารายงานยอดการขายใช้
}) {
  const [search, setSearch] = useState('');
  // ค่าตั้งต้น = ใบล่าสุดอยู่บนสุด (col: null คือใช้ลำดับ "ใบล่าสุดก่อน" ที่คำนวณไว้แล้ว)
  const [sort, setSort] = useState({ col: null, asc: false });
  const [page, setPage] = useState(1);

  // ทะเบียนสาขากลาง (HR → จัดการสาขา) — แปลง outletID เป็นรหัสสาขา และใช้ตัดรหัสออกจากเลขที่ใบ
  const { branches } = useBranches();
  const branchByOutlet = useMemo(() => {
    const m = {};
    branches.forEach(b => { if (b.outletId) m[String(b.outletId)] = b.code; });
    return m;
  }, [branches]);

  const rows = useMemo(() => {
    const list = bills
      .filter(b => hasInvNo(b.fullTaxInvNo))
      // สาขาถูกกรองที่ฝั่ง API ตอนดึงอยู่แล้ว กรองซ้ำเผื่อผู้ใช้เปลี่ยน dropdown โดยยังไม่กดค้นหาใหม่
      .filter(b => !selectedOutlet || String(b.outletID) === String(selectedOutlet))
      .map(b => {
        const amount = parseFloat(b.amount ?? 0) || 0;
        const vat = parseFloat(b.vat ?? 0) || 0;
        const branch = branchByOutlet[String(b.outletID)] || String(b.outletID ?? '-');
        return {
          raw: b,                                            // ไว้ส่งต่อให้ปุ่ม "ดูบิล"
          invNo: String(b.fullTaxInvNo).trim(),
          seq: invSeqOf(b.fullTaxInvNo, branch),
          billDate: dateFromRow(b),                          // วันที่เปิดบิล (ยึดเหมือนทุกหน้า)
          // เวลาปิดบิล = เวลาที่ออกใบกำกับจริง ใช้เป็นตัวเรียงหลัก
          // (FullTaxDate เป็นคอลัมน์วันที่ล้วน เวลาเป็น 00:00:00 เสมอ เรียงละเอียดระดับเวลาไม่ได้)
          billTime: String(b.date || b.startTime || '').slice(0, 19),
          taxDate: String(b.fullTaxDate ?? '').slice(0, 10),
          outletID: b.outletID,
          branch,
          checkID: b.checkID,
          checkDesc: String(b.checkDesc ?? '').trim(),
          accID: String(b.fullTaxAccID ?? '').trim(),
          amount,
          vat,
          beforeVat: amount - vat,
        };
      });

    // ใบล่าสุดก่อน: ปิดบิลทีหลัง = ใบใหม่กว่า · เวลาซ้ำกันค่อยดูเลขวิ่ง (ไม่สนว่าเป็นใบของสาขาไหน)
    list.sort((a, b) => b.billTime.localeCompare(a.billTime) || compareSeq(b.seq, a.seq));
    return list;
  }, [bills, selectedOutlet, branchByOutlet]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = q
      ? rows.filter(r => [r.invNo, r.checkID, r.branch, r.billDate, r.taxDate, r.checkDesc, r.accID]
          .some(v => String(v ?? '').toLowerCase().includes(q)))
      : rows;

    if (sort.col) {
      const col = COLUMNS.find(c => c.key === sort.col);
      const dir = sort.asc ? 1 : -1;
      // เรียงจากสำเนา — rows ต้องคงลำดับ "ใบล่าสุดก่อน" ไว้เผื่อผู้ใช้กดกลับ
      list = [...list].sort((a, b) => {
        if (!col?.sortVal) return dir * compareSeq(a.seq, b.seq);
        const x = col.sortVal(a);
        const y = col.sortVal(b);
        if (typeof x === 'number' && typeof y === 'number') return dir * (x - y);
        return dir * String(x).localeCompare(String(y), 'th');
      });
    }
    return list;
  }, [rows, search, sort]);

  const totals = useMemo(() => visible.reduce(
    (s, r) => ({ amount: s.amount + r.amount, vat: s.vat + r.vat, beforeVat: s.beforeVat + r.beforeVat }),
    { amount: 0, vat: 0, beforeVat: 0 },
  ), [visible]);

  // ใบล่าสุดของแต่ละสาขา — เลขวิ่งเป็นของใครของมัน ดูรวมกันทั้งกองแล้วบอกไม่ได้ว่าสาขาไหนถึงเลขไหน
  // (rows เรียงใบล่าสุดไว้บนสุดแล้ว ตัวแรกที่เจอของแต่ละสาขาจึงเป็นใบล่าสุดของสาขานั้น)
  const latestByBranch = useMemo(() => {
    const seen = new Map();
    rows.forEach(r => { if (!seen.has(r.branch)) seen.set(r.branch, r); });
    return [...seen.values()];
  }, [rows]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  // กดหัวคอลัมน์วนสามจังหวะ: มาก→น้อย · น้อย→มาก · กลับไปลำดับตั้งต้น "ใบล่าสุดก่อน"
  const clickSort = key => {
    setSort(s => {
      if (s.col !== key) return { col: key, asc: false };
      if (!s.asc) return { col: key, asc: true };
      return { col: null, asc: false };
    });
    setPage(1);
  };

  function exportExcel() {
    if (!visible.length) return;
    const aoa = [
      ['ใบกำกับภาษี (เต็มรูป)', `${startDate} ถึง ${endDate}`,
        selectedOutlet ? `สาขา ${branchByOutlet[String(selectedOutlet)] || selectedOutlet}` : 'ทุกสาขา'],
      [],
      ['เลขที่ใบกำกับภาษี', 'วันที่บิล', 'เวลาปิดบิล', 'วันที่ออกใบ', 'สาขา', 'เลขที่บิล', 'รายละเอียด (Check Desc)',
        'รหัสผู้ขอใบกำกับ', 'ยอดก่อน VAT', 'VAT', 'ยอดขาย (รวม VAT)'],
      ...visible.map(r => [r.invNo, r.billDate, r.billTime, r.taxDate || '', r.branch, String(r.checkID ?? ''),
        r.checkDesc, r.accID, Number(r.beforeVat.toFixed(2)), Number(r.vat.toFixed(2)), Number(r.amount.toFixed(2))]),
      [],
      ['รวม', '', '', '', '', `${visible.length} ใบ`, '', '',
        Number(totals.beforeVat.toFixed(2)), Number(totals.vat.toFixed(2)), Number(totals.amount.toFixed(2))],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 20 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 30 },
      { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ใบกำกับภาษี');
    XLSX.writeFile(wb, `tax-invoice_${startDate}_${endDate}.xlsx`);
  }

  if (!loaded) {
    return (
      <div className="flex flex-col items-center justify-center py-20 bg-white border border-slate-100 rounded-2xl shadow-sm text-slate-400">
        <FileText size={48} className="text-slate-300 mb-4 stroke-[1.5]" />
        <p className="text-sm">กรุณากดปุ่ม &quot;ค้นหาข้อมูล&quot; ด้านบน เพื่อแสดงใบกำกับภาษีของช่วงวันที่ที่เลือก</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* สรุป: ใบล่าสุด + จำนวนใบ + ยอดรวม */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bg-white border border-amber-200 rounded-2xl p-5 shadow-sm">
          <span className="text-xs text-slate-400 font-semibold block">ใบกำกับล่าสุด</span>
          {rows.length ? (
            <>
              <span className="text-xl font-bold text-amber-600 font-mono mt-0.5 block break-all">{rows[0].invNo}</span>
              <span className="text-xs text-slate-500 mt-1 block">
                {rows[0].branch} · ปิดบิล {rows[0].billTime || rows[0].billDate} · {fmtMoney(rows[0].amount)} บาท
              </span>
            </>
          ) : (
            <span className="text-sm text-slate-400 mt-2 block">ช่วงนี้ยังไม่มีใบกำกับเต็มรูป</span>
          )}
        </div>
        <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm">
          <span className="text-xs text-slate-400 font-semibold block">จำนวนใบกำกับ</span>
          <span className="text-xl font-bold text-slate-800 mt-0.5 block">{visible.length.toLocaleString('th-TH')} ใบ</span>
          <span className="text-xs text-slate-500 mt-1 block">{startDate} ถึง {endDate}</span>
        </div>
        <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm">
          <span className="text-xs text-slate-400 font-semibold block">ยอดขายรวม (รวม VAT)</span>
          <span className="text-xl font-bold text-emerald-600 mt-0.5 block">{fmtMoney(totals.amount)} บาท</span>
          <span className="text-xs text-slate-500 mt-1 block">
            ก่อน VAT {fmtMoney(totals.beforeVat)} · VAT {fmtMoney(totals.vat)}
          </span>
        </div>
      </div>

      {/* ใบล่าสุดของแต่ละสาขา — เลขวิ่งแยกกันคนละชุด ดูรวมกันแล้วบอกไม่ได้ว่าถึงเลขไหนแล้ว */}
      {latestByBranch.length > 1 && (
        <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">ใบล่าสุดของแต่ละสาขา</div>
          <div className="flex flex-wrap gap-2">
            {latestByBranch.map(r => (
              <div key={r.branch} className="px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-100 text-xs">
                <span className="font-bold text-slate-700">{r.branch}</span>
                <span className="mx-1.5 text-slate-300">·</span>
                <span className="font-mono text-amber-600 font-semibold">{r.invNo}</span>
                <span className="mx-1.5 text-slate-300">·</span>
                <span className="text-slate-500">{r.billDate}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ตารางใบกำกับ */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-700">รายการใบกำกับภาษีเต็มรูป</h2>
            <p className="text-[11px] text-slate-400 mt-0.5">
              คัดจากบิลที่มีเลขในคอลัมน์ FullTaxInvNo — เรียงใบล่าสุด (ปิดบิลทีหลังสุด) ขึ้นก่อน
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search className="h-4 w-4 text-slate-400" />
              </div>
              <input
                type="text" value={search}
                onChange={e => { setSearch(e.target.value); setPage(1); }}
                placeholder="ค้นหาเลขที่ใบ / เลขที่บิล / รายละเอียด..."
                className="pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm w-72 focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>
            <button
              onClick={exportExcel} disabled={!visible.length}
              className="px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-xl hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2 transition-colors"
            >
              <Download className="w-4 h-4" /> Export Excel
            </button>
          </div>
        </div>

        <div className="overflow-auto max-h-[70vh]">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 text-slate-500 font-bold sticky top-0">
                <th className="px-4 py-3 text-slate-600">ตัวช่วย</th>
                {COLUMNS.map(c => (
                  <th key={c.key} onClick={() => clickSort(c.key)}
                    className={`px-4 py-3 text-slate-600 cursor-pointer hover:bg-slate-100 hover:text-amber-600 transition-colors whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''}`}>
                    <div className={`flex items-center gap-1 ${c.align === 'right' ? 'justify-end' : ''}`}>
                      <span>{c.label}</span>
                      {sort.col === c.key && <span>{sort.asc ? '▲' : '▼'}</span>}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length + 1} className="py-16 text-center text-slate-400">
                    <AlertCircle className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                    ช่วงนี้ไม่มีบิลที่ออกใบกำกับภาษีเต็มรูป
                  </td>
                </tr>
              ) : pageRows.map((r, i) => (
                <tr key={`${r.invNo}-${r.checkID}-${i}`} className="hover:bg-amber-50/40 transition-colors">
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => onOpenDetail?.(r.raw)}
                      className="flex items-center gap-1 px-2.5 py-1 border border-amber-200 hover:bg-amber-50 text-amber-700 font-semibold rounded-lg text-[10px] transition-colors"
                    >
                      <Eye size={12} />
                      <span>ดูบิล</span>
                    </button>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap font-mono font-bold text-amber-600">{r.invNo}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div>{r.billTime ? r.billTime.slice(0, 10) : r.billDate}</div>
                    {r.billTime && <div className="text-[10px] text-slate-400">{r.billTime.slice(11)}</div>}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-500">{r.taxDate || '-'}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap font-semibold">{r.branch}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap font-mono text-slate-500">{r.checkID ?? '-'}</td>
                  <td className="px-4 py-2.5 max-w-[240px] truncate text-slate-600" title={r.checkDesc}>{r.checkDesc || '-'}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-slate-600">{fmtMoney(r.beforeVat)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono text-slate-500">{fmtMoney(r.vat)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-right font-mono font-bold text-emerald-600">{fmtMoney(r.amount)}</td>
                </tr>
              ))}
            </tbody>
            {visible.length > 0 && (
              <tfoot>
                <tr className="bg-slate-50 border-t border-slate-200 font-bold text-slate-700">
                  <td className="px-4 py-3" colSpan={7}>รวม {visible.length.toLocaleString('th-TH')} ใบ</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtMoney(totals.beforeVat)}</td>
                  <td className="px-4 py-3 text-right font-mono">{fmtMoney(totals.vat)}</td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-700">{fmtMoney(totals.amount)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <span>
            แสดง {visible.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, visible.length)} จาก {visible.length.toLocaleString('th-TH')} ใบ
          </span>
          <div className="flex gap-1.5">
            <button disabled={safePage === 1} onClick={() => setPage(safePage - 1)}
              className="p-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40">
              <ChevronLeft size={16} />
            </button>
            <span className="flex items-center px-3 font-semibold text-slate-700">
              หน้า {visible.length === 0 ? 0 : safePage} จาก {totalPages}
            </span>
            <button disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}
              className="p-1.5 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40">
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
