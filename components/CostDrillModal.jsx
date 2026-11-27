import { useState, useEffect, useMemo } from 'react';
import { X, ArrowLeft, Loader2, AlertCircle, ChevronRight, Download } from 'lucide-react';
import { exportTableXlsx } from '../lib/exportTable';
import { dateFromRow } from '../lib/salesFetch';
import { isClearedRow, isWorkedRow, wageOf, laborTypeOf, scheduleCellOf } from '../lib/labor';

/*
 * กดตัวเลขในตาราง "แยกรายสาขา" ของการ์ดสรุปรวม (DashboardCostSummary) แล้วดูข้างใน
 *
 *   sales   ยอดขายก่อน VAT รายวัน → กดวัน → บิลของวันนั้น   (บิลชุดเดียวกับแดชบอร์ด ไม่ดึงใหม่)
 *   labor   ค่าแรงรายคน (ตำแหน่ง/ประเภท/วันทำงาน/หยุด/ลา) → กดคน → รายวัน   (/api/hr-schedule?branch=)
 *   food    ส่วนประกอบ Food Cost + ใบเบิกทีละใบ → กดใบ → รายการในใบ · Supplier/สต๊อกกดดูรายการได้
 *           (/api/withdrawals + /api/food-cost?branch=)
 *   other   ค่าใช้จ่ายอื่นๆ ทีละแถว (ประเภท/รหัส/มิเตอร์/ราคา) ของเดือนที่สรุปอยู่
 *
 * หน้าย่อยซ้อนกันเป็น stack — ปุ่มย้อนกลับพากลับหน้าก่อน · ปุ่ม Excel ส่งออกหน้าที่เปิดอยู่ (lib/exportTable.js)
 */

const fmt = (n) => (Number(n) || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n) => (n === '' || n === null || n === undefined ? '' : (Number(n) || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 }));
const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const txt = (v) => String(v ?? '').trim();

const TH = 'px-3 py-2 text-xs font-semibold text-slate-500 bg-slate-50 border-b border-slate-200 whitespace-nowrap';
const TD = 'px-3 py-2 border-b border-slate-100 whitespace-nowrap';

/** ตารางของหน้าย่อยหนึ่งหน้า — cols: [{ label, render, right, cls }] */
function Table({ cols, rows, onRow, foot, empty = 'ไม่มีรายการ' }) {
  if (!rows.length) return <div className="py-14 text-center text-slate-400 text-sm">{empty}</div>;
  return (
    <table className="w-full text-sm border-collapse">
      <thead className="sticky top-0 z-10">
        <tr>{cols.map((c) => <th key={c.label} className={`${TH} ${c.right ? 'text-right' : 'text-left'}`}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} onClick={onRow ? () => onRow(r) : undefined} className={onRow ? 'cursor-pointer hover:bg-amber-50' : ''}>
            {cols.map((c, j) => (
              <td key={c.label} className={`${TD} ${c.right ? 'text-right font-mono tabular-nums' : ''} ${c.cls || ''}`}>
                {c.render(r)}
                {onRow && j === cols.length - 1 && <ChevronRight size={13} className="inline ml-1 text-slate-300" />}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      {foot && (
        <tfoot className="sticky bottom-0">
          <tr className="bg-slate-50 font-bold">
            {cols.map((c, i) => <td key={c.label} className={`${TD} ${c.right ? 'text-right font-mono' : ''}`}>{foot[i] ?? ''}</td>)}
          </tr>
        </tfoot>
      )}
    </table>
  );
}

const sumOf = (rows, k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);

/* ───────────────────────── ยอดขาย ───────────────────────── */
function salesPages(bills, code) {
  const byDay = {};
  for (const r of bills) {
    const d = dateFromRow(r);
    const x = byDay[d] || (byDay[d] = { date: d, bills: 0, gross: 0, vat: 0, beforeVat: 0, list: [] });
    const gross = num(r.billTotal);
    const vat = num(r.vat ?? r.Vat);
    x.bills += 1; x.gross += gross; x.vat += vat; x.beforeVat += gross - vat;
    x.list.push({
      checkID: txt(r.checkID ?? r.CheckID), time: txt(r.startTime).slice(11, 16), table: txt(r.tableID ?? r.TableID),
      cashier: txt(r.cashierName), paid: txt(r.paidType), gross, vat, beforeVat: gross - vat,
    });
  }
  const days = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
  const dayPage = (d) => ({
    title: `บิลวันที่ ${d.date} — สาขา ${code}`, subtitle: `${d.bills} บิล`,
    rows: d.list.sort((a, b) => a.time.localeCompare(b.time)),
    cols: [
      { label: 'เวลา', render: (r) => r.time || '-' },
      { label: 'Check ID', render: (r) => r.checkID || '-' },
      { label: 'โต๊ะ', render: (r) => r.table || '-' },
      { label: 'ชำระ', render: (r) => r.paid || '-' },
      { label: 'Bill Total', right: true, render: (r) => fmt(r.gross) },
      { label: 'VAT', right: true, render: (r) => fmt(r.vat) },
      { label: 'ก่อน VAT', right: true, cls: 'text-emerald-700', render: (r) => fmt(r.beforeVat) },
    ],
    foot: ['รวม', '', '', '', fmt(d.gross), fmt(d.vat), fmt(d.beforeVat)],
  });
  return {
    title: `ยอดขายก่อน VAT — สาขา ${code}`, subtitle: `${days.length} วัน • ${bills.length} บิล • กดวันเพื่อดูบิล`,
    rows: days, onRow: (d) => dayPage(d),
    cols: [
      { label: 'วันที่', render: (r) => r.date },
      { label: 'จำนวนบิล', right: true, render: (r) => r.bills.toLocaleString('th-TH') },
      { label: 'Bill Total', right: true, render: (r) => fmt(r.gross) },
      { label: 'VAT', right: true, render: (r) => fmt(r.vat) },
      { label: 'ยอดขายก่อน VAT', right: true, cls: 'text-emerald-700 font-semibold', render: (r) => fmt(r.beforeVat) },
    ],
    foot: ['รวม', sumOf(days, 'bills').toLocaleString('th-TH'), fmt(sumOf(days, 'gross')), fmt(sumOf(days, 'vat')), fmt(sumOf(days, 'beforeVat'))],
  };
}

/* ───────────────────────── ค่าแรง ───────────────────────── */
function laborPages(rows, code, start, end) {
  const people = {};
  for (const r of rows) {
    if (isClearedRow(r)) continue;
    const d = String(r.workDate || '').slice(0, 10);
    if (!d || d < start || d > end) continue;
    const key = txt(r.hrCode) || `name:${txt(r.name)}`;
    const p = people[key] || (people[key] = {
      hrCode: txt(r.hrCode), name: txt(r.name) || '-', position: txt(r.position) || '-', type: laborTypeOf(r.empType),
      worked: 0, off: 0, leave: 0, unpaid: 0, wage: 0, days: [],
    });
    const cell = scheduleCellOf(r);
    if (isWorkedRow(r)) p.worked += 1;
    else if (cell.kind === 'unpaidLeave') p.unpaid += 1;
    else if (cell.kind === 'paidLeave') p.leave += 1;
    else p.off += 1;
    const wage = wageOf(r);
    p.wage += wage;
    p.days.push({
      date: d, kind: cell.kind, status: cell.kind === 'work' ? 'ทำงาน' : cell.title || '-',
      time: cell.kind === 'work' ? cell.title : '', wage,
    });
  }
  const list = Object.values(people).filter((p) => p.worked || p.wage).sort((a, b) => b.wage - a.wage);
  const personPage = (p) => ({
    title: `${p.name} — ${p.position}`, subtitle: `${p.hrCode ? `รหัส ${p.hrCode} • ` : ''}${p.type} • ทำงาน ${p.worked} วัน`,
    rows: p.days.sort((a, b) => a.date.localeCompare(b.date)),
    cols: [
      { label: 'วันที่', render: (r) => r.date },
      { label: 'สถานะ', x: (r) => r.status, render: (r) => <span className={r.kind === 'work' ? 'text-slate-700' : 'text-amber-600'}>{r.status}</span> },
      { label: 'เวลา', render: (r) => r.time || '-' },
      { label: 'ค่าแรง', right: true, cls: 'text-blue-700', render: (r) => fmt(r.wage) },
    ],
    foot: ['รวม', `${p.worked} วันทำงาน`, '', fmt(p.wage)],
  });
  return {
    title: `ค่าแรง — สาขา ${code}`, subtitle: `${list.length} คน • ${start} ถึง ${end} • กดชื่อเพื่อดูรายวัน`,
    rows: list, onRow: (p) => personPage(p),
    empty: 'ไม่มีตารางงานในช่วงนี้',
    cols: [
      { label: 'ชื่อ', render: (r) => r.name },
      { label: 'ตำแหน่ง', render: (r) => r.position },
      { label: 'ประเภท', render: (r) => r.type },
      { label: 'วันทำงาน', right: true, render: (r) => r.worked },
      { label: 'หยุด', right: true, render: (r) => r.off || '' },
      { label: 'ลา', right: true, render: (r) => r.leave || '' },
      { label: 'ลาไม่รับค่าแรง', right: true, render: (r) => r.unpaid || '' },
      { label: 'ค่าแรง', right: true, cls: 'text-blue-700 font-semibold', render: (r) => fmt(r.wage) },
    ],
    foot: ['รวม', '', '', sumOf(list, 'worked'), sumOf(list, 'off'), sumOf(list, 'leave'), sumOf(list, 'unpaid'), fmt(sumOf(list, 'wage'))],
  };
}

/* ───────────────────────── ยอดเบิกของ ───────────────────────── */
function foodPages(docs, fc, code) {
  const sum = fc?.branches?.find((b) => b.code === fc?.detail?.code) || null;
  const det = fc?.detail || {};
  const docPage = (d) => ({
    title: `ใบเบิก ${d.invNo || d.docNo} — ${d.docDate}`, subtitle: `${d.docType || ''} • ${d.items.length} รายการ`,
    rows: d.items,
    cols: [
      { label: 'รหัส', render: (r) => r.itemCode },
      { label: 'รายการ', render: (r) => r.itemName },
      { label: 'จำนวน', right: true, render: (r) => qty(r.qty) },
      { label: 'หน่วย', render: (r) => r.unit || '-' },
      { label: 'ราคา/หน่วย', right: true, render: (r) => fmt(r.unitPrice) },
      { label: 'มูลค่า', right: true, cls: 'text-rose-600', render: (r) => fmt(r.amount) },
    ],
    foot: ['', 'รวม', '', '', '', fmt(sumOf(d.items, 'amount'))],
  });
  const stockPage = (title, items) => ({
    title: `${title} — สาขา ${code}`, subtitle: `${items.length} รายการ`, rows: items,
    cols: [
      { label: 'รหัส', render: (r) => r.itemCode },
      { label: 'รายการ', render: (r) => r.itemName },
      { label: 'คงเหลือ', right: true, render: (r) => qty(r.qty) },
      { label: 'หน่วย', render: (r) => r.unit || '-' },
      { label: 'ราคา/หน่วย', right: true, render: (r) => (r.priced ? fmt(r.unitPrice) : 'ไม่มีราคา') },
      { label: 'มูลค่า', right: true, cls: 'text-rose-600', render: (r) => fmt(r.value) },
    ],
    foot: ['', 'รวม', '', '', '', fmt(sumOf(items, 'value'))],
  });
  const supPage = (items) => ({
    title: `รายจ่ายจาก Supplier — สาขา ${code}`, subtitle: `${items.length} รายการ`, rows: items,
    cols: [
      { label: 'วันที่', render: (r) => r.date },
      { label: 'รายการ', render: (r) => r.name },
      { label: 'จำนวน', right: true, render: (r) => qty(r.qty) },
      { label: 'หน่วย', render: (r) => r.unit || '-' },
      { label: 'ราคา/หน่วย', right: true, render: (r) => fmt(r.unitPrice) },
      { label: 'มูลค่า', right: true, cls: 'text-rose-600', render: (r) => fmt(r.amount) },
    ],
    foot: ['รวม', '', '', '', '', fmt(sumOf(items, 'amount'))],
  });

  const list = docs.map((d) => ({ ...d, items: d.items || [], total: sumOf(d.items || [], 'amount') }))
    .sort((a, b) => String(a.docDate).localeCompare(String(b.docDate)) || String(a.invNo).localeCompare(String(b.invNo)));
  const withdraw = sumOf(list, 'total');

  // ส่วนประกอบ Total Food Cost — ไว้หัวหน้า (กดดูรายการได้)
  const parts = sum ? [
    { label: 'ต้นทุนจากใบเบิก', v: withdraw, note: `${list.length} ใบ (รายการด้านล่าง)` },
    { label: '+ รายจ่ายจาก Supplier', v: sum.sup, note: `${sum.supCount} รายการ`, page: det.supCost?.items?.length ? () => supPage(det.supCost.items) : null },
    { label: '+ ยอดยกมาเดือนที่แล้ว', v: sum.prevStock, note: sum.prevDate ? `${sum.prevSource === 'closing' ? 'ปิดรอบ' : 'นับ'} ${sum.prevDate}` : '',
      page: det.previous?.items?.length ? () => stockPage('ยอดยกมาเดือนที่แล้ว', det.previous.items) : null },
    { label: '− ยอดมูลค่าสตอคปัจจุบัน', v: -sum.curStock, note: sum.curDate ? `นับ ${sum.curDate}` : 'ยังไม่นับ',
      page: det.current?.items?.length ? () => stockPage('ยอดมูลค่าสตอคปัจจุบัน', det.current.items) : null },
  ] : [];

  return {
    title: `ยอดเบิกของ — สาขา ${code}`, subtitle: `${list.length} ใบเบิก • กดใบเบิกเพื่อดูรายการ`,
    header: parts,
    total: sum ? sum.foodCost : null,
    rows: list, onRow: (d) => docPage(d),
    empty: 'ไม่มีใบเบิกในช่วงนี้',
    cols: [
      { label: 'วันที่', render: (r) => r.docDate },
      { label: 'เลขที่ใบเบิก', render: (r) => r.invNo || r.docNo || '-' },
      { label: 'ประเภท', render: (r) => r.docType || '-' },
      { label: 'จำนวนรายการ', right: true, render: (r) => r.items.length },
      { label: 'มูลค่า', right: true, cls: 'text-rose-600 font-semibold', render: (r) => fmt(r.total) },
    ],
    foot: ['รวม', `${list.length} ใบ`, '', sumOf(list.map((d) => ({ n: d.items.length })), 'n'), fmt(withdraw)],
  };
}

/* ───────────────────────── ค่าใช้จ่ายอื่นๆ ───────────────────────── */
function otherPages(rows, code, months) {
  const list = rows.slice().sort((a, b) => String(a.month).localeCompare(String(b.month)) || String(a.type).localeCompare(String(b.type), 'th'));
  return {
    title: `ค่าใช้จ่ายอื่นๆ — สาขา ${code}`, subtitle: `เดือน ${months.join(', ')} • ${list.length} รายการ`,
    rows: list, empty: 'ยังไม่ได้กรอกค่าใช้จ่ายของเดือนนี้',
    cols: [
      { label: 'เดือน', render: (r) => r.month },
      { label: 'ประเภท', render: (r) => r.type },
      { label: 'รหัส/มิเตอร์', render: (r) => r.code || '-' },
      { label: 'เลขเริ่ม', right: true, render: (r) => qty(r.start) },
      { label: 'เลขสิ้นสุด', right: true, render: (r) => qty(r.end) },
      { label: 'จำนวน', right: true, render: (r) => qty(r.qty) },
      { label: 'ราคา/หน่วย', right: true, render: (r) => (r.price === '' || r.price == null ? '' : fmt(r.price)) },
      { label: 'รวม', right: true, cls: 'text-violet-700 font-semibold', render: (r) => fmt(r.total) },
    ],
    foot: ['รวม', '', '', '', '', '', '', fmt(sumOf(list, 'total'))],
  };
}

/**
 * @param {object} p
 * @param {'sales'|'labor'|'food'|'other'} p.kind
 * @param {string} p.code รหัสสาขา (ตัวพิมพ์เล็ก)
 * @param {string} p.outletId
 * @param {string} p.start / p.end
 * @param {object[]} p.bills       บิลของสาขานี้ (kind = sales)
 * @param {object[]} p.expenses    แถวค่าใช้จ่ายของสาขานี้ (kind = other)
 * @param {string[]} p.months
 */
export default function CostDrillModal({ kind, code, outletId, start, end, bills = [], expenses = [], months = [], onClose }) {
  const CODE = code.toUpperCase();
  const [remote, setRemote] = useState({ loading: kind === 'labor' || kind === 'food', error: '', data: null });
  const [stack, setStack] = useState([]);   // หน้าย่อยที่กดเข้าไป (หน้าแรกคิดจาก base)

  useEffect(() => {
    let alive = true;
    const getJson = (u) => fetch(u).then((r) => r.json()).then((j) => {
      if (j?.status !== 'success') throw new Error(j?.message || 'โหลดไม่สำเร็จ');
      return j;
    });
    let job = null;
    if (kind === 'labor') {
      job = getJson(`/api/hr-schedule?start=${start}&end=${end}&branch=${encodeURIComponent(code)}`).then((j) => j.data || []);
    } else if (kind === 'food') {
      const qs = new URLSearchParams({ branch: code, startDate: start, endDate: end });
      if (outletId) qs.set('outletId', outletId);
      job = Promise.all([
        getJson(`/api/withdrawals?${qs}`).then((j) => j.data || []),
        getJson(`/api/food-cost?start=${start}&end=${end}&branch=${encodeURIComponent(code)}`).catch(() => null),
      ]);
    }
    if (job) {
      job.then((data) => alive && setRemote({ loading: false, error: '', data }))
        .catch((e) => alive && setRemote({ loading: false, error: e.message || 'โหลดไม่สำเร็จ', data: null }));
    }
    return () => { alive = false; };
  }, [kind, code, outletId, start, end]);

  const base = useMemo(() => {
    if (kind === 'sales') return salesPages(bills, CODE);
    if (kind === 'other') return otherPages(expenses, CODE, months);
    if (!remote.data) return null;
    if (kind === 'labor') return laborPages(remote.data, CODE, start, end);
    if (kind === 'food') return foodPages(remote.data[0], remote.data[1], CODE);
    return null;
  }, [kind, bills, expenses, months, remote.data, CODE, start, end]);

  const page = stack.length ? stack[stack.length - 1] : base;
  const push = (p) => setStack((s) => [...s, p]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/60" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[88vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 bg-slate-800 text-white flex items-center gap-3">
          {stack.length > 0 && (
            <button onClick={() => setStack((s) => s.slice(0, -1))} className="p-1 rounded hover:bg-slate-700" title="ย้อนกลับ"><ArrowLeft size={18} /></button>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="font-bold truncate">{page?.title || 'กำลังโหลด…'}</h3>
            {page?.subtitle && <p className="text-xs text-slate-300 truncate">{page.subtitle}</p>}
          </div>
          {page?.rows?.length > 0 && (
            <button
              onClick={() => exportTableXlsx(page)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-emerald-400 text-emerald-300 text-xs font-semibold hover:bg-emerald-500/20"
              title="ส่งออกหน้านี้เป็น Excel">
              <Download size={14} /> Excel
            </button>
          )}
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-700"><X size={18} /></button>
        </div>

        {remote.loading && !stack.length ? (
          <div className="py-20 text-center text-slate-400"><Loader2 className="animate-spin inline mr-2" size={18} />กำลังโหลด…</div>
        ) : remote.error && !stack.length ? (
          <div className="p-6 text-rose-600 text-sm flex gap-2"><AlertCircle size={18} />{remote.error}</div>
        ) : page && (
          <div className="flex-1 overflow-auto">
            {page.header?.length > 0 && (
              <div className="p-4 border-b border-slate-200 bg-rose-50/40">
                <table className="w-full text-sm">
                  <tbody>
                    {page.header.map((h) => (
                      <tr key={h.label} onClick={h.page ? () => push(h.page()) : undefined}
                        className={h.page ? 'cursor-pointer hover:bg-rose-100/50' : ''}>
                        <td className="py-1.5 px-2">{h.label} <span className="text-xs text-slate-400">{h.note}</span></td>
                        <td className={`py-1.5 px-2 text-right font-mono ${h.v < 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          ฿{fmt(h.v)}{h.page && <ChevronRight size={13} className="inline ml-1 text-slate-300" />}
                        </td>
                      </tr>
                    ))}
                    {page.total !== null && page.total !== undefined && (
                      <tr className="border-t-2 border-rose-200 font-bold text-rose-700">
                        <td className="py-2 px-2">Total Food Cost</td>
                        <td className="py-2 px-2 text-right font-mono">฿{fmt(page.total)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
            <Table cols={page.cols} rows={page.rows} foot={page.foot} empty={page.empty}
              onRow={page.onRow ? (r) => push(page.onRow(r)) : undefined} />
          </div>
        )}
      </div>
    </div>
  );
}
