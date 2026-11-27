import { useState, useEffect, useMemo } from 'react';
import { Loader2, AlertCircle, ChevronRight } from 'lucide-react';
import { apiCall as expenseApiCall } from '../lib/expenseApi';
import { isIncludedBranch } from '../lib/excludedBranches';
import { monthLabel } from '../lib/thaiDate';
import CostDrillModal from './CostDrillModal';

/*
 * แดชบอร์ดหลัก — การ์ดสรุปรวม: ยอดขายก่อน VAT − ค่าแรง − ยอดเบิกของ − ค่าใช้จ่ายอื่นๆ = คงเหลือ
 *
 *   ยอดขายก่อน VAT  ตัวเดียวกับการ์ด "ยอดขายรวมทั้งหมด" (Bill − VAT) — ส่งมาจากแดชบอร์ด ไม่ดึงซ้ำ
 *   ค่าแรง          /api/hr-schedule?summary=1 — ตัวเดียวกับการ์ดค่าแรงรวมในหน้าดูสแกนหน้า (ช่วงวันที่เดียวกัน)
 *   ยอดเบิกของ      /api/food-cost — Total Food Cost ของเมนู ACC › ต้นทุนใบเบิกสาขา
 *   ค่าใช้จ่ายอื่นๆ   ACC › ค่าใช้จ่ายอื่นๆ (getExpenses) — กรอกเป็นยอดทั้งเดือน จึงดึง "เต็มเดือน"
 *                   ของทุกเดือนที่ช่วงวันที่ครอบอยู่ ไม่เฉลี่ยตามจำนวนวัน
 *
 * แต่ละก้อนโหลดแยกกัน ก้อนไหนพังก็ขึ้นเตือนเฉพาะก้อนนั้น ที่เหลือยังแสดงได้
 *
 * ตัวเลขในตาราง "แยกรายสาขา" กดดูข้างในได้ (components/CostDrillModal.jsx)
 */

const fmt = (n) => (Number(n) || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = (n) => Math.round(Number(n) || 0).toLocaleString('th-TH');
const baht = (n) => `฿${fmt(n)}`;
const pct = (v, base) => (base > 0 ? `${((v / base) * 100).toFixed(2)}%` : '—');

/** ทุกเดือน "YYYY-MM" ที่ช่วง [start, end] ครอบ */
function monthsIn(start, end) {
  const out = [];
  let [y, m] = start.slice(0, 7).split('-').map(Number);
  const last = end.slice(0, 7);
  for (let i = 0; i < 36; i++) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    out.push(ym);
    if (ym >= last) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** ช่องตัวเลขที่กดดูรายละเอียดได้ */
const CELL_BTN = 'px-2 py-1.5 text-right font-mono tabular-nums cursor-pointer underline decoration-dotted decoration-slate-300 underline-offset-4 hover:bg-amber-50';

const COLORS = {
  sales: '#059669', labor: '#3b82f6', food: '#e11d48', other: '#8b5cf6', net: '#10b981',
};

/** โหลดก้อนข้อมูลหนึ่งก้อน — คืน { loading, error, data } */
function useChunk(key, loader) {
  const [st, setSt] = useState({ loading: false, error: '', data: null });
  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    setSt({ loading: true, error: '', data: null });
    loader()
      .then((data) => { if (alive) setSt({ loading: false, error: '', data }); })
      .catch((e) => { if (alive) setSt({ loading: false, error: e.message || 'โหลดไม่สำเร็จ', data: null }); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return st;
}

const getJson = async (url) => {
  const r = await fetch(url);
  const j = await r.json().catch(() => null);
  if (!j || j.status !== 'success') throw new Error(j?.message || `HTTP ${r.status}`);
  return j;
};

function Card({ label, value, color, sub, chips, source, onOpen, loading, error }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm flex flex-col" style={{ borderTop: `4px solid ${color}` }}>
      <span className="text-xs font-bold text-slate-600">{label}</span>
      {loading ? (
        <div className="py-3 text-slate-400 text-sm flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> กำลังโหลด…</div>
      ) : error ? (
        <div className="py-2 text-rose-600 text-xs flex gap-1"><AlertCircle size={14} className="flex-shrink-0" />{error}</div>
      ) : (
        <>
          <h3 className="text-xl font-bold font-mono tabular-nums mt-1 truncate" style={{ color }}>{baht(value)}</h3>
          <p className="text-[11px] text-slate-500">{sub}</p>
          {chips?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {chips.map((c) => (
                <span key={c} className="text-[10px] bg-slate-50 border border-slate-200 rounded-md px-1.5 py-0.5 text-slate-600">{c}</span>
              ))}
            </div>
          )}
        </>
      )}
      <div className="mt-auto pt-2 border-t border-slate-100 flex items-center justify-between text-[10px] text-slate-400" style={{ marginTop: 'auto' }}>
        <span>ที่มา: {source}</span>
        {onOpen && (
          <button type="button" onClick={onOpen} className="font-bold flex items-center" style={{ color }}>ดู <ChevronRight size={12} /></button>
        )}
      </div>
    </div>
  );
}

/**
 * @param {object} p
 * @param {string} p.start / p.end  ช่วงวันที่ที่แดชบอร์ดโหลดไว้
 * @param {Array<{outletID, beforeVat}>} p.salesRows  ยอดขายก่อน VAT ต่อสาขา (branchCardStats.rows)
 * @param {object[]} p.bills  บิลชุดเดียวกับที่คิด salesRows (salesRaw) — ไว้กดดูยอดขายรายวัน/รายบิล
 * @param {(outletId) => string} p.codeOfOutlet  outletID -> รหัสสาขา
 * @param {string} p.selectedCode  รหัสสาขาที่เลือกในแดชบอร์ด ('' = ทุกสาขา)
 * @param {(key) => boolean} p.can  สิทธิ์เมนู (ไว้ซ่อนปุ่ม "ดู" ของเมนูที่ไม่มีสิทธิ์)
 * @param {(key) => void} p.onOpen  เปลี่ยนไปเมนูนั้น
 */
export default function DashboardCostSummary({ start, end, salesRows, bills = [], codeOfOutlet, selectedCode, can, onOpen }) {
  const [drill, setDrill] = useState(null); // { kind, code }
  const rangeKey = start && end ? `${start}~${end}` : '';
  const months = useMemo(() => (rangeKey ? monthsIn(start, end) : []), [rangeKey, start, end]);

  const food = useChunk(rangeKey && `f${rangeKey}`, () => getJson(`/api/food-cost?start=${start}&end=${end}`));
  const labor = useChunk(rangeKey && `l${rangeKey}`, () => getJson(`/api/hr-schedule?start=${start}&end=${end}&summary=1`));
  const expense = useChunk(rangeKey && 'expenses', () => expenseApiCall('getExpenses', {}));

  const aliases = food.data?.aliases || {};
  const canon = (b) => {
    const k = String(b || '').trim().toLowerCase();
    return aliases[k] || k;
  };
  const want = selectedCode ? canon(selectedCode) : '';

  const view = useMemo(() => {
    const rows = {};
    const rowOf = (code) => rows[code] || (rows[code] = { code, sales: 0, labor: 0, people: 0, food: 0, other: 0, hasStore: false });

    for (const s of salesRows || []) {
      const code = canon(codeOfOutlet(s.outletID));
      if (!code) continue;
      const x = rowOf(code);
      x.sales += Number(s.beforeVat) || 0;
      x.hasStore = true;
    }
    for (const b of food.data?.branches || []) {
      const x = rowOf(canon(b.code));
      x.food += Number(b.foodCost) || 0;
      x.hasStore = true;
    }
    for (const l of labor.data?.data || []) {
      const x = rowOf(canon(l.branch));
      x.labor += Number(l.wage) || 0;
      x.people += Number(l.people) || 0;
    }
    const byType = {};
    const expenseRows = {};
    for (const e of expense.data?.data || []) {
      if (!months.includes(String(e.month))) continue;
      const amt = Number(e.total) || 0;
      if (!amt) continue;
      const code = canon(e.branch);
      if (want && code !== want) continue;
      rowOf(code).other += amt;
      (expenseRows[code] || (expenseRows[code] = [])).push(e);
      byType[e.type] = (byType[e.type] || 0) + amt;
    }

    // ค่าแรงของพื้นที่ที่ไม่ใช่ร้าน (OFFICE ฯลฯ) ไม่เอาเข้าสรุปกำไรสาขา — บอกไว้ใต้ตารางแทน
    const all = Object.values(rows).filter((x) => isIncludedBranch(x.code));
    const nonStore = all.filter((x) => !x.hasStore && !x.other && x.labor);
    const list = all
      .filter((x) => x.hasStore || x.other)
      .filter((x) => !want || x.code === want)
      .map((x) => ({ ...x, net: x.sales - x.labor - x.food - x.other }))
      .sort((a, b) => b.sales - a.sales);
    const total = list.reduce((t, x) => {
      ['sales', 'labor', 'people', 'food', 'other', 'net'].forEach((k) => { t[k] += x[k]; });
      return t;
    }, { sales: 0, labor: 0, people: 0, food: 0, other: 0, net: 0 });
    // รหัสสาขา -> outletID (ไว้ดึงใบเบิก/กรองบิลตอนกดดูรายละเอียด)
    const outletOf = {};
    for (const b of food.data?.branches || []) if (b.outletId) outletOf[canon(b.code)] = String(b.outletId);
    for (const r of salesRows || []) {
      const c = canon(codeOfOutlet(r.outletID));
      if (c && !outletOf[c]) outletOf[c] = String(r.outletID);
    }
    return {
      list, total, nonStore: want ? [] : nonStore, expenseRows, outletOf,
      byType: Object.entries(byType).sort((a, b) => b[1] - a[1]),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesRows, food.data, labor.data, expense.data, months, want]);

  if (!rangeKey) return null;
  const { list, total, nonStore, byType, expenseRows, outletOf } = view;
  const base = total.sales;
  const anyLoading = food.loading || labor.loading || expense.loading;
  const monthText = months.map(monthLabel).join(', ');
  const foodRows = food.data?.branches || [];
  const foodSum = (k) => foodRows.filter((b) => !want || canon(b.code) === want).reduce((s, b) => s + (Number(b[k]) || 0), 0);

  const parts = [
    { key: 'labor', v: total.labor, color: COLORS.labor, label: 'ค่าแรง' },
    { key: 'food', v: total.food, color: COLORS.food, label: 'ยอดเบิกของ' },
    { key: 'other', v: total.other, color: COLORS.other, label: 'ค่าใช้จ่ายอื่นๆ' },
    { key: 'net', v: Math.max(total.net, 0), color: COLORS.net, label: 'คงเหลือ' },
  ];
  const partSum = parts.reduce((s, p) => s + Math.max(p.v, 0), 0);

  return (
    <div className="bg-amber-50/40 border border-amber-200 rounded-2xl p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-bold text-slate-800">
          สรุปรวม — ยอดขาย vs ต้นทุนสาขา {want ? <span className="uppercase">· {want}</span> : '· ทุกสาขา'}
        </h3>
        <span className="text-[11px] text-slate-500 flex items-center gap-1">
          {anyLoading && <Loader2 size={12} className="animate-spin" />}
          {start} ถึง {end} · ค่าใช้จ่ายอื่นๆ เต็มเดือน {monthText}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <Card label="ยอดขายก่อน VAT" value={total.sales} color={COLORS.sales} sub="ฐาน 100%"
          source="แดชบอร์ด (Bill − VAT)" />
        <Card label="ค่าแรง" value={total.labor} color={COLORS.labor} sub={`${pct(total.labor, base)} ของยอดขาย`}
          chips={total.people ? [`พนักงาน ${fmt0(total.people)} คน`] : []}
          source="HR › ดูสแกนหน้า" loading={labor.loading} error={labor.error}
          onOpen={can('attendance') ? () => onOpen('attendance') : undefined} />
        <Card label="ยอดเบิกของ (Food Cost)" value={total.food} color={COLORS.food} sub={`${pct(total.food, base)} ของยอดขาย`}
          chips={food.data ? [`ใบเบิก ฿${fmt0(foodSum('withdraw'))}`, `Supplier ฿${fmt0(foodSum('sup'))}`] : []}
          source="ACC › ต้นทุนใบเบิกสาขา" loading={food.loading} error={food.error}
          onOpen={can('foodCost') ? () => onOpen('foodCost') : undefined} />
        <Card label="ค่าใช้จ่ายอื่นๆ (รายเดือน)" value={total.other} color={COLORS.other} sub={`${pct(total.other, base)} ของยอดขาย`}
          chips={byType.map(([t, v]) => `${t} ฿${fmt0(v)}`)}
          source="ACC › ค่าใช้จ่ายอื่นๆ" loading={expense.loading} error={expense.error}
          onOpen={can('otherExpense') ? () => onOpen('otherExpense') : undefined} />
      </div>

      {(food.data?.warnings || []).map((w) => (
        <div key={w} className="text-xs text-amber-800 bg-amber-100/60 rounded-lg px-3 py-2">{w}</div>
      ))}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.6fr] gap-4 items-start">
        {/* สรุปรวม */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <h4 className="text-sm font-bold text-slate-700 mb-2">สรุปรวม{want ? '' : 'ทุกสาขา'}</h4>
          <table className="w-full text-sm">
            <tbody>
              {[
                ['ยอดขายก่อน VAT', total.sales, COLORS.sales, '100%'],
                ['− ค่าแรง', total.labor, COLORS.labor, pct(total.labor, base)],
                ['− ยอดเบิกของ', total.food, COLORS.food, pct(total.food, base)],
                ['− ค่าใช้จ่ายอื่นๆ', total.other, COLORS.other, pct(total.other, base)],
              ].map(([l, v, c, p]) => (
                <tr key={l}>
                  <td className="py-1.5">{l}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums" style={{ color: c }}>{baht(v)}</td>
                  <td className="py-1.5 text-right font-mono text-xs text-slate-400 w-16">{p}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-slate-200">
                <td className="py-2 font-bold">= คงเหลือ</td>
                <td className={`py-2 text-right font-mono tabular-nums text-lg font-bold ${total.net >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{baht(total.net)}</td>
                <td className={`py-2 text-right font-mono text-xs font-bold ${total.net >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{pct(total.net, base)}</td>
              </tr>
            </tbody>
          </table>
          {partSum > 0 && (
            <>
              <div className="flex h-4 rounded-md overflow-hidden mt-3">
                {parts.map((p) => p.v > 0 && (
                  <div key={p.key} style={{ width: `${(p.v / partSum) * 100}%`, background: p.color }} title={`${p.label} ${baht(p.v)}`} />
                ))}
              </div>
              <div className="flex flex-wrap gap-3 mt-1.5 text-[10px] text-slate-500">
                {parts.map((p) => (
                  <span key={p.key} className="flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-sm" style={{ background: p.color }} />{p.label}</span>
                ))}
              </div>
            </>
          )}
        </div>

        {/* แยกรายสาขา */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 min-w-0">
          <h4 className="text-sm font-bold text-slate-700 mb-2">แยกรายสาขา <span className="text-[11px] font-normal text-slate-400">· กดตัวเลขเพื่อดูรายละเอียด</span></h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-slate-500 bg-slate-50">
                  {['สาขา', 'ยอดขายก่อน VAT', 'ค่าแรง', 'ยอดเบิกของ', 'ค่าใช้จ่ายอื่นๆ', 'คงเหลือ'].map((h, i) => (
                    <th key={h} className={`px-2 py-2 font-semibold whitespace-nowrap ${i ? 'text-right' : 'text-left'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.map((x) => (
                  <tr key={x.code} className="border-b border-slate-100">
                    <td className="px-2 py-1.5 font-semibold uppercase">{x.code}</td>
                    <td className={`${CELL_BTN} hover:text-emerald-700`} onClick={() => setDrill({ kind: 'sales', code: x.code })} title="กดดูยอดขายรายวัน">
                      {fmt0(x.sales)}
                    </td>
                    {[['labor', x.labor, 'hover:text-blue-700', 'กดดูค่าแรงรายคน'],
                      ['food', x.food, 'hover:text-rose-700', 'กดดูใบเบิก'],
                      ['other', x.other, 'hover:text-violet-700', 'กดดูรายการค่าใช้จ่าย']].map(([k, v, hov, tip]) => (
                      <td key={k} className={`${CELL_BTN} ${hov}`} onClick={() => setDrill({ kind: k, code: x.code })} title={tip}>
                        {fmt0(v)}<span className="block text-[10px] text-slate-400">{pct(v, x.sales)}</span>
                      </td>
                    ))}
                    <td className={`px-2 py-1.5 text-right font-mono tabular-nums font-bold ${x.net >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {fmt0(x.net)}<span className="block text-[10px] font-normal opacity-70">{pct(x.net, x.sales)}</span>
                    </td>
                  </tr>
                ))}
                {list.length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-slate-400">ไม่มีข้อมูล</td></tr>
                )}
              </tbody>
              {list.length > 1 && (
                <tfoot>
                  <tr className="bg-slate-50 font-bold">
                    <td className="px-2 py-2">รวม</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt0(total.sales)}</td>
                    {[total.labor, total.food, total.other].map((v, i) => (
                      <td key={i} className="px-2 py-2 text-right font-mono">{fmt0(v)}<span className="block text-[10px] text-slate-400 font-normal">{pct(v, base)}</span></td>
                    ))}
                    <td className={`px-2 py-2 text-right font-mono ${total.net >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {fmt0(total.net)}<span className="block text-[10px] font-normal opacity-70">{pct(total.net, base)}</span>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>

      {drill && (
        <CostDrillModal
          kind={drill.kind}
          code={drill.code}
          outletId={outletOf[drill.code] || ''}
          start={start}
          end={end}
          bills={drill.kind === 'sales'
            ? bills.filter((r) => canon(codeOfOutlet(r.outletID ?? r.OutletID)) === drill.code)
            : []}
          expenses={expenseRows[drill.code] || []}
          months={months}
          onClose={() => setDrill(null)}
        />
      )}

      <p className="text-[10.5px] text-slate-400 leading-relaxed">
        * ยอดขายก่อน VAT = Bill − VAT (ตัวเดียวกับการ์ด &quot;ยอดขายรวมทั้งหมด&quot;) · ค่าแรง = ค่าแรงจากตารางงานที่สาขาลงไว้ (ตัวเดียวกับการ์ดค่าแรงรวมในหน้าดูสแกนหน้า)
        <br />* ยอดเบิกของ = Total Food Cost (ใบเบิก + Supplier + ยอดยกมา − สต๊อกคงเหลือ) · ค่าใช้จ่ายอื่นๆ เป็นยอดทั้งเดือนของ {monthText}
        {nonStore.length > 0 && (
          <><br />* ไม่รวมค่าแรงของพื้นที่ที่ไม่ใช่ร้าน: {nonStore.map((x) => `${x.code.toUpperCase()} ฿${fmt0(x.labor)}`).join(', ')}</>
        )}
      </p>
    </div>
  );
}
