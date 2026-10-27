import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  AlertTriangle, Loader2, RefreshCw, TrendingUp, Eye, X, Search, ChevronLeft, ChevronRight,
  Layers, FileText, ClipboardList, FileSpreadsheet,
} from 'lucide-react';
import {
  kitchenCall, fetchQcrdRecipe, fetchQcrdMenus, todayYmd, shiftYmd, formatThaiDate, formatQty, formatBaht,
  quickRange, QUICK_LABEL,
} from '../lib/kitchenClient';
import { runUsage, orderTotals, round3, batchesOf, parseRecipeSnapshot } from '../lib/kitchenUsage';
import { exportReportExcel } from '../lib/kitchenExport';

/**
 * ปุ่มลัดช่วงวันที่ — RangeQuick ของ narai-storefct (components/kitchen/DateQuick.jsx) ปุ่มที่ตรงกับช่วงปัจจุบันจะไฮไลต์
 */
function RangeQuick({ from, to, onChange, presets }) {
  const today = todayYmd();
  return (
    <div className="flex flex-wrap gap-1 p-1 bg-slate-50 border border-slate-200 rounded-lg w-fit" role="group" aria-label="ช่วงวันที่ลัด">
      {presets.map((k) => {
        const [f, t] = quickRange(k, today);
        const active = f === from && t === to;
        return (
          <button key={k} type="button" onClick={() => onChange(f, t)}
            className={`px-2.5 py-1 rounded-md text-xs whitespace-nowrap border ${active
              ? 'bg-amber-50 text-amber-800 border-amber-300'
              : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100 border-transparent'}`}>
            {QUICK_LABEL[k]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * QC/RD › รายงานการผลิต — หน้า "รายงานการผลิต" ของครัวกลาง (narai-storefct: src/pages/kitchen/ProductionReport.jsx)
 * ยกมาทั้งหน้า ข้อมูลชุดเดียวกัน (office-server action เดียวกัน ผ่าน /api/kitchen-report) ตรรกะคำนวณเหมือนกันทุกบรรทัด
 * ต่างกันแค่สองเรื่อง: สีตามธีมของ NARAI OFFICE และ **ดูอย่างเดียว** — ไม่มีปุ่มลบบันทึกการผลิต
 * (ลบ/แก้ทำที่หน้าครัวกลางเท่านั้น ฝั่ง API ก็เปิดให้แค่ action อ่าน ดู lib/kitchenReport.js)
 * แก้ตรรกะที่ฝั่งครัวกลางเมื่อไหร่ ต้องยกมาแก้ที่นี่ด้วย ไม่งั้นสองหน้าจะเห็นตัวเลขไม่ตรงกัน
 *
 * ---- คำอธิบายเดิมของหน้าครัวกลาง ----
 *
 * สองมุมจากข้อมูลชุดเดียว: ยอดรวมต่อสินค้า (ผลิตไปเท่าไหร่ เสียเท่าไหร่) และรายการดิบทีละครั้ง
 * ยอดรวมคำนวณฝั่ง SQL ไม่ใช่ให้เบราว์เซอร์บวกเอง เพราะช่วงวันที่กว้างๆ แถวเยอะได้
 *
 * ต้นทุนวัตถุดิบ office-server คิดจากใบเบิกของคำสั่งผลิต (ราคา ณ ตอนเบิก รวมของสูญเสีย)
 * แล้วแบ่งให้แต่ละครั้งที่ผลิตตามสัดส่วนจำนวนที่ได้ — ดู getProductionReport ใน office-server/kitchen.js
 * ต้นทุนต่อหน่วยของสินค้า = ต้นทุนรวม ÷ จำนวนที่ผลิตเฉพาะครั้งที่มีต้นทุน (costed_qty)
 *
 * ดูรายละเอียด (ปุ่มตาในรายการผลิต / กดแถวสรุปต่อสินค้า) = ยอดวัตถุดิบตามสูตร QC/RD เทียบใช้จริงจากใบเบิก
 * ของคำสั่งผลิต (ดู services/kitchenUsage.js) · สรุปต่อสินค้าที่ผลิตหลายครั้ง แสดงเป็นค่าเฉลี่ย
 *
 * จำนวนสูตร / ต้นทุนตามสูตร — จากเมนู QC/RD (ผลผลิตต่อสูตร, cost = ต้นทุนสูตร 1 ชุด) กติกาเดียวกับหน้าสถานะการผลิต
 * จำนวนสูตรของครั้งหนึ่ง = จำนวนสูตรของคำสั่ง × สัดส่วนที่ครั้งนี้ผลิตได้ (ผลิตนอกคำสั่ง = ผลิตได้ ÷ ผลผลิตต่อสูตร)
 * แบ่งแบบเดียวกับต้นทุนจริง ต้นทุนตามสูตรกับต้นทุนจริงของครั้งเดียวกันจึงเทียบกันได้
 *
 * "ตามสูตร" ทั้งหมดคิดจากสูตร ณ วันผลิตที่เก็บไว้กับคำสั่งผลิต (recipe_snapshot) — แก้สูตรใน QC/RD ทีหลัง
 * ตัวเลขย้อนหลังไม่ขยับ · คำสั่งรุ่นก่อนเริ่มเก็บ / ผลิตนอกคำสั่ง ไม่มีสูตรเก็บไว้ จึงใช้สูตรปัจจุบันแทน
 * แล้วติดเครื่องหมาย * ไว้ (ตัวเลขพวกนี้ยังขยับตามสูตรปัจจุบัน)
 *
 * มุมมอง "ดูทีละเมนู" (MenuView) — เลือกเมนูหนึ่งตัว: การ์ดสรุป (ต้นทุนรวม/เฉลี่ย/ต่ำสุด–สูงสุดต่อหน่วย)
 * + ตารางทุกครั้งที่ผลิตของเมนูนั้นพร้อมแถวรวม + สรุปวัตถุดิบรวมทุกครั้ง (ข้อมูลเดียวกับป๊อปอัพรายละเอียด)
 */
export default function QcRdProduction() {
  const [dateFrom, setDateFrom] = useState(() => shiftYmd(todayYmd(), -30));
  const [dateTo, setDateTo] = useState(() => todayYmd());
  // ดูตามวันที่ผลิตเสร็จ (ตั้งต้น) หรือวันผลิตตามคำสั่ง — office-server กรอง/เรียงตามวันที่นี้
  const [basis, setBasis] = useState('finish');
  const [view, setView] = useState('all'); // 'all' = ภาพรวมทุกเมนู · 'menu' = ดูทีละเมนู
  const [menuKey, setMenuKey] = useState('');
  const [runs, setRuns] = useState([]);
  const [summary, setSummary] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await kitchenCall('getProductionReport', { dateFrom, dateTo, dateBasis: basis });
      // recipe = สูตร ณ วันผลิตของคำสั่ง (null = ไม่ได้เก็บ ใช้สูตรปัจจุบันของ QC/RD แทน)
      setRuns((res.runs || []).map((r) => ({ ...r, recipe: parseRecipeSnapshot(r.recipe_snapshot) })));
      setSummary(res.summary || []);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, basis]);

  useEffect(() => { load(); }, [load]);

  // ยอดวัตถุดิบ — โหลดเมื่อเปิดรายละเอียดครั้งแรก ไม่ถ่วงการเปิดรายงาน
  // ใบเบิกดึงตามวันที่เบิก ซึ่งอาจก่อนวันผลิตได้ จึงย้อนกว้างกว่าช่วงรายงาน แล้วจับด้วยเลขคำสั่ง
  const [detail, setDetail] = useState(null); // { kind: 'run', run } | { kind: 'product', productKey }
  const [issuesByOrder, setIssuesByOrder] = useState(null);
  const [recipes, setRecipes] = useState({});
  const [usageError, setUsageError] = useState('');
  const issuesRange = useRef('');
  const totals = useMemo(() => orderTotals(runs), [runs]);

  // เมนู QC/RD (ผลผลิต/ต้นทุนต่อสูตร) — โหลดครั้งเดียว โหลดไม่ได้ = คอลัมน์ตามสูตรขึ้น "-"
  const [menus, setMenus] = useState(null);
  useEffect(() => {
    fetchQcrdMenus()
      .then((res) => setMenus(new Map((res.menus || []).map((m) => [m.key, m]))))
      .catch(() => setMenus(new Map()));
  }, []);

  /** จำนวนสูตรและต้นทุนตามสูตรของการผลิตครั้งหนึ่ง */
  const recipeOf = useCallback((r) => {
    const menu = r.recipe?.menu || menus?.get(r.product_key);
    const produced = Number(r.qty_produced) || 0;
    const share = r.order_id ? produced / (totals.get(String(r.order_id)) || produced || 1) : 1;
    const base = r.order_id ? batchesOf(r.order_qty, r.unit, menu) : batchesOf(produced, r.unit, menu);
    const batches = base === null ? null : base * (r.order_id ? share : 1);
    const cost = Number(menu?.cost);
    const unit = String(r.unit || '');
    const perBatchQty = Number(menu?.yieldQty) > 0 && (!unit || !menu.yieldUnit || unit === menu.yieldUnit) ? Number(menu.yieldQty) : 1;
    const hasCost = cost > 0 && batches !== null;
    // ยอดที่ควรได้ตามสูตร = จำนวนสูตร × ผลผลิตต่อสูตร (หน่วยต้องตรงสูตร) — ตัวเทียบ "ได้มากขึ้น/ลดลงต่อสูตร"
    const yieldOk = Number(menu?.yieldQty) > 0 && (!unit || !menu.yieldUnit || unit === menu.yieldUnit);
    return {
      batches,
      perBatchYield: yieldOk ? Number(menu.yieldQty) : null,
      expected: batches !== null && yieldOk ? batches * Number(menu.yieldQty) : null,
      recipeCost: hasCost ? batches * cost : null,
      recipePerUnit: hasCost ? cost / perBatchQty : null,
    };
  }, [menus, totals]);

  const recipeByProduct = useMemo(() => {
    const m = new Map();
    for (const r of runs) {
      const x = recipeOf(r);
      if (!m.has(r.product_key)) m.set(r.product_key, { batches: 0, known: 0, recipeCost: 0, costed: 0, recipePerUnit: null });
      const a = m.get(r.product_key);
      if (x.batches !== null) { a.batches += x.batches; a.known += 1; }
      if (x.recipeCost !== null) { a.recipeCost += x.recipeCost; a.costed += 1; a.recipePerUnit = x.recipePerUnit; }
    }
    return m;
  }, [runs, recipeOf]);

  const ensureUsage = async (productRuns) => {
    const range = `${dateFrom}|${dateTo}`;
    const jobs = [];
    if (issuesRange.current !== range) {
      issuesRange.current = range;
      setIssuesByOrder(null);
      setUsageError('');
      jobs.push(kitchenCall('getMaterialIssues', { dateFrom: shiftYmd(dateFrom, -60), dateTo: shiftYmd(dateTo, 1) })
        .then((res) => {
          const m = new Map();
          for (const it of res.issues || []) {
            if (!it.order_id) continue;
            const k = String(it.order_id);
            if (!m.has(k)) m.set(k, []);
            m.get(k).push(it);
          }
          setIssuesByOrder(m);
        })
        .catch((err) => { setIssuesByOrder(new Map()); setUsageError(`โหลดใบเบิกไม่ได้: ${err.message}`); }));
    }
    // สูตรปัจจุบันโหลดเฉพาะสินค้าที่มีครั้งไหนไม่ได้เก็บสูตรไว้
    const need = [...new Map(productRuns.filter((r) => !r.recipe).map((r) => [r.product_key, r])).values()]
      .filter((r) => !(r.product_key in recipes));
    if (need.length) {
      jobs.push(Promise.all(need.map((r) => fetchQcrdRecipe(r.product_code || r.product_key)
        .then((res) => [r.product_key, res])
        .catch(() => [r.product_key, null])))
        .then((pairs) => setRecipes((prev) => ({ ...prev, ...Object.fromEntries(pairs) }))));
    }
    await Promise.all(jobs);
  };

  const openRun = (run) => { setDetail({ kind: 'run', run }); ensureUsage([run]); };
  const openProduct = (productKey) => {
    setDetail({ kind: 'product', productKey });
    ensureUsage(runs.filter((r) => r.product_key === productKey));
  };

  const totalProduced = summary.reduce((sum, s) => sum + Number(s.total_produced || 0), 0);
  const totalWaste = summary.reduce((sum, s) => sum + Number(s.total_waste || 0), 0);
  // office-server รุ่นก่อนมีต้นทุนไม่ส่งคอลัมน์ cost มาเลย — ซ่อนคอลัมน์ต้นทุนแล้วบอกให้อัปเดต
  const hasCost = runs.some((r) => r.cost !== undefined);
  const totalCost = summary.reduce((sum, s) => sum + Number(s.total_cost || 0), 0);
  const totalLossCost = summary.reduce((sum, s) => sum + Number(s.total_loss_cost || 0), 0);
  const totalRecipeCost = [...recipeByProduct.values()].reduce((sum, a) => sum + a.recipeCost, 0);
  // ครั้งที่ไม่มีสูตร ณ วันผลิต (คำสั่งรุ่นก่อนเริ่มเก็บ / ผลิตนอกคำสั่ง) — "ตามสูตร" ใช้สูตรปัจจุบัน
  const liveRecipeRuns = runs.filter((r) => !r.recipe).length;

  // เมนูที่ดูอยู่ในมุมมองทีละเมนู (ยังไม่เลือก = ผลิตบ่อยสุด) — ปุ่ม Export ของมุมมองนี้ออกเฉพาะเมนูนี้
  const activeMenu = summary.find((m) => m.product_key === menuKey)
    || [...summary].sort((a, b) => Number(b.run_count) - Number(a.run_count))[0];

  const [exporting, setExporting] = useState(false);
  const exportExcel = async () => {
    const onlyMenu = view === 'menu' && activeMenu ? activeMenu.product_key : null;
    const pickRuns = onlyMenu ? runs.filter((r) => r.product_key === onlyMenu) : runs;
    const products = onlyMenu ? [activeMenu] : summary;
    if (pickRuns.length === 0) { toast.error('ไม่มีข้อมูลให้ export'); return; }
    setExporting(true);
    try {
      const n = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 10000) / 10000);
      const pctOf = (produced, expected) => (expected > 0 ? (produced - expected) / expected : null);
      const d = (v) => (v ? formatThaiDate(v) : '');
      const BAHT = '#,##0.00';
      const QTY = '#,##0.###';
      const PCT = '+0.0%;-0.0%;0.0%';
      const summaryRows = products.map((m) => {
        const st = menuStats(runs.filter((r) => r.product_key === m.product_key), recipeOf);
        return [
          m.product_name, m.product_code, Number(m.run_count) || 0, n(st.produced), m.unit || '',
          st.batchesKnown ? n(st.batches) : null, pctOf(st.expectedProduced, st.expected),
          n(st.waste), st.wastePct / 100,
          st.recipeRuns ? n(st.recipeCost) : null, n(st.recipePerUnit),
          st.costedRuns ? n(st.cost) : null, n(st.avg), n(st.min), n(st.max),
        ];
      });
      const all = menuStats(pickRuns, recipeOf);
      const runRows = pickRuns.map((r) => {
        const rec = recipeOf(r);
        const qty = Number(r.qty_produced) || 0;
        const cost = r.cost === null || r.cost === undefined ? null : Number(r.cost);
        return [
          d(r.finish_date || r.produce_date), d(r.produce_date), d(r.ordered_at),
          r.finish_date ? Math.max(dayDiff(r.produce_date, r.finish_date), 0) : null,
          r.product_name, r.product_code, r.order_doc_no || 'ผลิตนอกคำสั่ง',
          rec.batches === null ? null : n(rec.batches), n(qty), r.unit || '',
          rec.expected === null ? null : n(rec.expected), pctOf(qty, rec.expected),
          n(r.qty_waste), rec.recipeCost === null ? null : n(rec.recipeCost),
          cost, cost !== null && qty > 0 ? n(cost / qty) : null, r.recorder || '',
        ];
      });
      const basisLabel = basis === 'finish' ? 'วันที่ผลิตเสร็จ' : 'วันผลิต (ตามคำสั่ง)';
      const meta = [
        `ช่วงวันที่: ${formatThaiDate(dateFrom)} ถึง ${formatThaiDate(dateTo)} · ดูตาม${basisLabel}`,
        ...(onlyMenu ? [`เมนู: ${activeMenu.product_name} (${activeMenu.product_code || ''})`] : []),
      ];
      await exportReportExcel({
        filename: `รายงานการผลิต_${onlyMenu ? `${activeMenu.product_name}_` : ''}${dateFrom}_${dateTo}`.replace(/[\\/:*?"<>|]/g, '-'),
        meta,
        sheets: [
          {
            name: 'สรุปต่อสินค้า',
            title: onlyMenu ? `สรุปการผลิต · ${activeMenu.product_name}` : 'รายงานการผลิต · สรุปต่อสินค้า',
            cols: [
              { label: 'สินค้า', wch: 34 }, { label: 'รหัส', wch: 10 }, { label: 'ผลิตกี่ครั้ง', wch: 8 },
              { label: 'ผลิตได้รวม', wch: 11, z: QTY }, { label: 'หน่วย', wch: 7 }, { label: 'จำนวนสูตร', wch: 9, z: QTY },
              { label: 'เทียบสูตร', wch: 9, z: PCT }, { label: 'ของเสีย', wch: 9, z: QTY }, { label: 'เสีย %', wch: 7, z: '0.0%' },
              { label: 'ต้นทุนตามสูตร', wch: 13, z: BAHT }, { label: 'ตามสูตร/หน่วย', wch: 11, z: BAHT },
              { label: 'ต้นทุนจริงรวม', wch: 13, z: BAHT }, { label: 'ต้นทุนจริงเฉลี่ย/หน่วย', wch: 12, z: BAHT },
              { label: 'ต่ำสุด/หน่วย', wch: 10, z: BAHT }, { label: 'สูงสุด/หน่วย', wch: 10, z: BAHT },
            ],
            rows: summaryRows,
            total: onlyMenu ? undefined : [
              `รวม ${products.length} สินค้า`, '', pickRuns.length, null, '', null, null, null, null,
              all.recipeRuns ? n(all.recipeCost) : null, null, all.costedRuns ? n(all.cost) : null, null, null, null,
            ],
          },
          {
            name: 'รายการผลิต',
            title: onlyMenu ? `รายละเอียดการผลิตทุกรายการ · ${activeMenu.product_name}` : 'รายงานการผลิต · รายการผลิตทีละครั้ง',
            cols: [
              { label: 'วันที่เสร็จ', wch: 13 }, { label: 'วันผลิต', wch: 13 }, { label: 'สั่งเมื่อ', wch: 13 },
              { label: 'ค้าง (วัน)', wch: 7 }, { label: 'สินค้า', wch: 32 }, { label: 'รหัส', wch: 10 },
              { label: 'คำสั่งผลิต', wch: 18 }, { label: 'จำนวนสูตร', wch: 9, z: QTY }, { label: 'ผลิตได้', wch: 9, z: QTY },
              { label: 'หน่วย', wch: 7 }, { label: 'ควรได้ตามสูตร', wch: 10, z: QTY }, { label: 'เทียบสูตร', wch: 9, z: PCT },
              { label: 'ของเสีย', wch: 8, z: QTY }, { label: 'ต้นทุนตามสูตร', wch: 12, z: BAHT },
              { label: 'ต้นทุนจริง', wch: 12, z: BAHT }, { label: 'ต้นทุนจริง/หน่วย', wch: 11, z: BAHT }, { label: 'ผู้บันทึก', wch: 14 },
            ],
            rows: runRows,
            total: [
              `รวม ${pickRuns.length} ครั้ง`, '', '', null, '', '', '',
              all.batchesKnown ? n(all.batches) : null, onlyMenu ? n(all.produced) : null, onlyMenu ? activeMenu.unit || '' : '',
              onlyMenu && all.expected ? n(all.expected) : null, onlyMenu ? pctOf(all.expectedProduced, all.expected) : null,
              onlyMenu ? n(all.waste) : null, all.recipeRuns ? n(all.recipeCost) : null,
              all.costedRuns ? n(all.cost) : null, onlyMenu ? n(all.avg) : null, '',
            ],
          },
        ],
      });
      toast.success('ดาวน์โหลดไฟล์ Excel แล้ว');
    } catch (err) {
      toast.error(`export ไม่สำเร็จ: ${err.message}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="w-full space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-slate-500">
            ผลิตอะไรไปเท่าไหร่ เสียเท่าไหร่ ต้นทุนวัตถุดิบเท่าไหร่ ในช่วงที่เลือก
          </p>
          <span className="text-[11px] font-semibold text-cyan-700 bg-cyan-50 border border-cyan-200 rounded-full px-2.5 py-0.5">
            ข้อมูลชุดเดียวกับหน้า &quot;รายงานการผลิต&quot; ของครัวกลาง · ดูอย่างเดียว
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportExcel} disabled={loading || exporting || runs.length === 0}
            title={view === 'menu' ? 'Export เฉพาะเมนูที่ดูอยู่' : 'Export ทุกเมนูในช่วงวันที่นี้'}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 disabled:opacity-40"
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
            Export Excel{view === 'menu' && activeMenu ? ' (เมนูนี้)' : ''}
          </button>
          <button
            onClick={load}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200"
          >
            <RefreshCw className="w-3.5 h-3.5" /> รีเฟรช
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-end gap-3 bg-white border border-slate-100 shadow-sm rounded-xl p-4">
        <div>
          <label className="block text-[11px] text-slate-500 mb-1">ดูตาม</label>
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs">
            {[['finish', 'วันที่ผลิตเสร็จ'], ['produce', 'วันผลิต (ตามคำสั่ง)']].map(([k, label]) => (
              <button key={k} onClick={() => setBasis(k)}
                className={`px-3 py-1.5 ${basis === k ? 'bg-amber-100 text-amber-800 font-semibold' : 'text-slate-500 hover:text-slate-800'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-[11px] text-slate-500 mb-1">ตั้งแต่วันที่</label>
          <input
            type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:border-amber-400"
          />
        </div>
        <div>
          <label className="block text-[11px] text-slate-500 mb-1">ถึงวันที่</label>
          <input
            type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:border-amber-400"
          />
        </div>
        <RangeQuick from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} presets={['yesterday', 'today', 'lastWeek', 'week', 'lastMonth', 'month']} />
      </div>

      <div className="flex flex-wrap gap-2">
        {[['all', 'ภาพรวมทุกเมนู', Layers], ['menu', 'ดูทีละเมนู', FileText]].map(([k, label, Icon]) => (
          <button key={k} onClick={() => setView(k)}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm border ${view === k
              ? 'bg-amber-100 text-amber-800 border-amber-300 font-semibold'
              : 'text-slate-500 border-slate-200 hover:text-slate-800'}`}>
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-500 gap-2">
          <Loader2 className="w-5 h-5 animate-spin text-amber-500" /> กำลังโหลดรายงาน...
        </div>
      ) : runs.length === 0 ? (
        <div className="py-20 text-center text-slate-500 text-sm">ไม่มีการผลิตในช่วงวันที่นี้</div>
      ) : view === 'menu' ? (
        <MenuView
          runs={runs} summary={summary} menuKey={menuKey} onMenuKey={setMenuKey}
          recipeOf={recipeOf} hasCost={hasCost} menusReady={menus !== null}
          usage={{ issuesByOrder, recipes, totals, error: usageError }} ensureUsage={ensureUsage}
          onOpenRun={openRun} onOpenProduct={openProduct}
        />
      ) : (
        <>
          <div className={`grid grid-cols-2 gap-3 ${hasCost ? 'md:grid-cols-5' : 'md:grid-cols-4'}`}>
            <StatCard label="ผลิตทั้งหมด" value={formatQty(totalProduced)} tone="teal" />
            <StatCard label="ของเสียทั้งหมด" value={formatQty(totalWaste)} tone="rose" />
            <StatCard
              label="ต้นทุนตามสูตรรวม"
              value={menus === null ? '…' : formatBaht(totalRecipeCost)}
              sub={liveRecipeRuns > 0 ? `* ${liveRecipeRuns} ครั้งใช้สูตรปัจจุบัน` : 'ต้นทุนสูตร ณ วันผลิต × จำนวนสูตร'}
              tone="slate"
            />
            {hasCost && (
              <StatCard
                label="ต้นทุนวัตถุดิบจริงรวม"
                value={formatBaht(totalCost)}
                sub={totalLossCost > 0 ? `จากของสูญเสีย ${formatBaht(totalLossCost)}` : ''}
                tone="amber"
              />
            )}
            <StatCard label="จำนวนครั้งที่ผลิต" value={runs.length} tone="slate" />
          </div>

          {liveRecipeRuns > 0 && (
            <div className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
              <AlertTriangle className="w-4 h-4 shrink-0 text-slate-500" />
              <span>
                ตัวเลข "ตามสูตร" คิดจากสูตร ณ วันผลิตที่เก็บไว้กับคำสั่งผลิต — แก้สูตรใน QC/RD ทีหลังไม่ขยับตาม
                · ยกเว้น {liveRecipeRuns} ครั้งที่ติด <span className="text-amber-700">*</span> (คำสั่งก่อนเริ่มเก็บสูตร หรือผลิตนอกคำสั่ง)
                ซึ่งยังใช้สูตรปัจจุบันของ QC/RD
              </span>
            </div>
          )}

          {!hasCost && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              ยังไม่มีคอลัมน์ต้นทุน — ต้องรัน update-office-server.bat ที่เครื่องออฟฟิศก่อน
            </div>
          )}

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-amber-500" /> สรุปต่อสินค้า
            </h2>
            <div className="bg-white border border-slate-100 shadow-sm rounded-xl overflow-x-auto">
              <table className={`w-full text-sm ${hasCost ? 'min-w-[1080px]' : 'min-w-[820px]'}`}>
                <thead className="bg-slate-50 text-slate-500 text-xs">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">สินค้า</th>
                    <th className="text-center px-4 py-3 font-medium">ผลิตกี่ครั้ง</th>
                    <th className="text-right px-4 py-3 font-medium">ผลิตได้รวม</th>
                    <th className="text-right px-4 py-3 font-medium">จำนวนสูตร</th>
                    <th className="text-right px-4 py-3 font-medium">ของเสีย</th>
                    <th className="text-right px-4 py-3 font-medium">เสีย %</th>
                    <th className="text-right px-4 py-3 font-medium">ต้นทุนตามสูตร<div className="font-normal text-slate-500">รวม / ต่อหน่วย</div></th>
                    {hasCost && <th className="text-right px-4 py-3 font-medium">ต้นทุนจริง</th>}
                    {hasCost && <th className="text-right px-4 py-3 font-medium">ต้นทุนจริงเฉลี่ย/หน่วย</th>}
                  </tr>
                </thead>
                <tbody>
                  {summary.map((s) => {
                    const produced = Number(s.total_produced) || 0;
                    const waste = Number(s.total_waste) || 0;
                    // คิดเป็นสัดส่วนของที่ทำออกมาทั้งหมด (ดีที่ขาย + ที่ทิ้ง) ไม่ใช่ของที่ดีอย่างเดียว
                    // ไม่งั้นทำ 10 ทิ้ง 10 จะได้ 100% ทั้งที่ของจริงคือเสียครึ่งหนึ่ง
                    const pct = produced + waste > 0 ? (waste / (produced + waste)) * 100 : 0;
                    const rec = recipeByProduct.get(s.product_key);
                    return (
                      <tr key={s.product_key} onClick={() => openProduct(s.product_key)}
                        title="กดเพื่อดูยอดวัตถุดิบเฉลี่ย ตามสูตรเทียบใช้จริง"
                        className="border-t border-slate-100 hover:bg-amber-50/60 cursor-pointer">
                        <td className="px-4 py-3">
                          <div className="text-slate-800 flex items-center gap-1.5">
                            {s.product_name}
                            <Eye className="w-3.5 h-3.5 text-slate-400" />
                          </div>
                          <div className="text-[11px] text-slate-500">{s.product_code}</div>
                        </td>
                        <td className="px-4 py-3 text-center text-slate-500">{s.run_count}</td>
                        <td className="px-4 py-3 text-right text-teal-700">
                          {formatQty(produced)} <span className="text-slate-500 text-xs">{s.unit || ''}</span>
                        </td>
                        <td className="px-4 py-3 text-right text-slate-700 font-mono">
                          {rec?.known ? formatQty(round3(rec.batches)) : <span className="text-slate-400">-</span>}
                          {rec && rec.known > 0 && rec.known < Number(s.run_count) && (
                            <div className="text-[10px] text-slate-500 font-sans" title="บางครั้งคิดจำนวนสูตรไม่ได้ (หน่วยไม่ตรงสูตร / ไม่มีผลผลิตต่อสูตร)">
                              คิดได้ {rec.known}/{s.run_count} ครั้ง
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right text-rose-600">
                          {waste ? formatQty(waste) : '-'}
                        </td>
                        <td className={`px-4 py-3 text-right ${pct >= 10 ? 'text-rose-600' : 'text-slate-500'}`}>
                          {pct ? `${pct.toFixed(1)}%` : '-'}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {rec?.costed ? (
                            <>
                              <div className="text-slate-700">{formatBaht(rec.recipeCost)}</div>
                              <div className="text-[11px] text-slate-500">{formatBaht(rec.recipePerUnit)}/{s.unit || 'หน่วย'}</div>
                            </>
                          ) : <span className="text-slate-400" title="เมนูนี้ไม่มีต้นทุนหรือผลผลิตต่อสูตรใน QC/RD">-</span>}
                        </td>
                        {hasCost && <SummaryCost s={s} recipePerUnit={rec?.recipePerUnit ?? null} />}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-700">รายการผลิตทีละครั้ง</h2>
            <div className="bg-white border border-slate-100 shadow-sm rounded-xl overflow-x-auto">
              <table className={`w-full text-sm ${hasCost ? 'min-w-[1280px]' : 'min-w-[1000px]'}`}>
                <thead className="bg-slate-50 text-slate-500 text-xs">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">วันที่เสร็จ<div className="font-normal text-slate-500">วันผลิต · สั่งเมื่อ</div></th>
                    <th className="text-left px-4 py-3 font-medium">สินค้า</th>
                    <th className="text-left px-4 py-3 font-medium">คำสั่งผลิต</th>
                    <th className="text-right px-4 py-3 font-medium">ผลิตได้</th>
                    <th className="text-right px-4 py-3 font-medium">จำนวนสูตร</th>
                    <th className="text-right px-4 py-3 font-medium">ของเสีย</th>
                    <th className="text-right px-4 py-3 font-medium">ต้นทุนตามสูตร<div className="font-normal text-slate-500">รวม / ต่อหน่วย</div></th>
                    {hasCost && <th className="text-right px-4 py-3 font-medium">ต้นทุนจริง</th>}
                    {hasCost && <th className="text-right px-4 py-3 font-medium">ต้นทุนจริง/หน่วย</th>}
                    <th className="text-left px-4 py-3 font-medium">ผู้บันทึก</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => {
                    const rec = recipeOf(r);
                    return (
                    <tr key={r.run_id} className="border-t border-slate-100 hover:bg-amber-50/60">
                      <td className="px-4 py-3 text-xs whitespace-nowrap">
                        <div className="text-emerald-700">{formatThaiDate(r.finish_date || r.produce_date)}</div>
                        <div className={`text-[11px] ${r.finish_date && String(r.finish_date).slice(0, 10) !== String(r.produce_date).slice(0, 10) ? 'text-amber-600' : 'text-slate-500'}`}>
                          ผลิต {formatThaiDate(r.produce_date)}
                        </div>
                        {r.ordered_at && <div className="text-[11px] text-slate-400">สั่ง {formatThaiDate(r.ordered_at)}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-slate-800">{r.product_name}</div>
                        <div className="text-[11px] text-slate-500">{r.product_code}</div>
                      </td>
                      <td className="px-4 py-3">
                        {r.order_doc_no ? (
                          <span className="font-mono text-[11px] text-amber-700">{r.order_doc_no}</span>
                        ) : (
                          <span className="text-[11px] text-slate-400">ผลิตนอกคำสั่ง</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-teal-700">
                        {formatQty(r.qty_produced)} <span className="text-slate-500 text-xs">{r.unit || ''}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700">
                        {rec.batches === null ? <span className="text-slate-400" title="คิดไม่ได้ — หน่วยไม่ตรงสูตร หรือเมนูไม่มีผลผลิตต่อสูตรใน QC/RD">-</span> : formatQty(round3(rec.batches))}
                        {!r.recipe && rec.batches !== null && <span className="text-amber-700" title="ไม่มีสูตร ณ วันผลิตเก็บไว้ — คิดจากสูตรปัจจุบันของ QC/RD"> *</span>}
                      </td>
                      <td className="px-4 py-3 text-right text-rose-600">
                        {Number(r.qty_waste) ? formatQty(r.qty_waste) : '-'}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {rec.recipeCost === null ? <span className="text-slate-400">-</span> : (
                          <>
                            <div className="text-slate-700">{formatBaht(rec.recipeCost)}</div>
                            <div className="text-[11px] text-slate-500">{formatBaht(rec.recipePerUnit)}/{r.unit || 'หน่วย'}</div>
                          </>
                        )}
                      </td>
                      {hasCost && <RunCost r={r} recipePerUnit={rec.recipePerUnit} />}
                      <td className="px-4 py-3 text-xs text-slate-500">{r.recorder || '-'}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button
                          onClick={() => openRun(r)}
                          className="p-1.5 text-slate-500 hover:text-amber-600"
                          title="ดูยอดวัตถุดิบ ตามสูตรเทียบใช้จริง"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {detail && (
        <UsageModal
          detail={detail}
          runs={runs}
          totals={totals}
          issuesByOrder={issuesByOrder}
          recipes={recipes}
          error={usageError}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

/**
 * ยอดวัตถุดิบรวมของการผลิตหลายครั้ง (สินค้าเดียวกัน) — ใช้ทั้ง UsageModal และกล่องสรุปวัตถุดิบของ MenuView
 * rows = ผลรวมจากชุด pool: ครั้งที่มีใบเบิก (ถ้ามี) ไม่งั้นทุกครั้ง — ตามสูตรกับใช้จริงต้องมาจากชุดเดียวกัน
 */
function aggregateUsage(targetRuns, { issuesByOrder, recipes, totals }) {
  const live = recipes[targetRuns[0]?.product_key];
  const recipeOfRun = (r) => r.recipe || live;
  const recipe = targetRuns.map(recipeOfRun).find(Boolean) || null;
  const perRun = targetRuns.map((r) => runUsage(r, {
    recipe: recipeOfRun(r), issues: r.order_id ? issuesByOrder.get(String(r.order_id)) || [] : [], totals,
  }));
  const agg = new Map();
  let batchesAll = 0; let batchesIssued = 0;
  const nIssued = perRun.filter((u) => u.hasIssues).length;
  const pool = nIssued > 0 ? perRun.filter((u) => u.hasIssues) : perRun;
  perRun.forEach((u) => { if (u.batches !== null) batchesAll += u.batches; });
  pool.forEach((u) => {
    if (u.batches !== null) batchesIssued += u.batches;
    for (const l of u.lines.values()) {
      if (!agg.has(l.key)) agg.set(l.key, { ...l, recipe: 0, actual: 0, loss: 0, cost: 0 });
      const a = agg.get(l.key);
      a.recipe += l.recipe; a.actual += l.actual; a.loss += l.loss; a.cost += l.cost;
      if (l.actual > 0) { a.unit = l.unit; a.name = l.name; }
    }
  });
  return {
    recipe, perRun, rows: [...agg.values()].sort((a, b) => a.name.localeCompare(b.name, 'th')),
    n: perRun.length, nIssued, nPool: pool.length, batchesAll, batchesIssued,
  };
}

/**
 * ผลิตได้จริงเทียบตามสูตร — +% เขียว = ได้มากกว่าสูตร · −% แดง = ได้น้อยกว่าสูตร · บรรทัดล่าง = ได้ต่อ 1 สูตร (สูตรกำหนด)
 */
function YieldDiff({ produced, expected, batches, perBatch }) {
  if (!(expected > 0)) return <span className="text-slate-400" title="คิดไม่ได้ — หน่วยไม่ตรงสูตร หรือเมนูไม่มีผลผลิตต่อสูตรใน QC/RD">-</span>;
  const diff = ((produced - expected) / expected) * 100;
  const tone = Math.abs(diff) < 0.05 ? 'text-slate-700' : diff > 0 ? 'text-emerald-700' : 'text-rose-600';
  return (
    <>
      <div className={`font-semibold ${tone}`}>{Math.abs(diff) < 0.05 ? '0%' : `${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(1)}%`}</div>
      {batches > 0 && (
        <div className="text-[11px] text-slate-500">
          {formatQty(round3(produced / batches))}/สูตร{perBatch !== null ? ` (สูตร ${formatQty(perBatch)})` : ''}
        </div>
      )}
    </>
  );
}

/**
 * ตัวเลขสรุปของการผลิตชุดหนึ่ง (เมนูเดียว) — การ์ดของ MenuView และชีทสรุปของไฟล์ Excel ใช้ตัวเดียวกัน
 * ต้นทุนเฉลี่ย = ต้นทุนรวม ÷ ยอดผลิตเฉพาะครั้งที่มีต้นทุน · expected = ยอดที่ควรได้ตามสูตร
 */
function menuStats(menuRuns, recipeOf) {
  const out = { expected: 0, expectedProduced: 0, produced: 0, waste: 0, cost: 0, costedQty: 0, costedRuns: 0, recipeCost: 0, recipeRuns: 0, batches: 0, batchesKnown: 0, recipePerUnit: null };
  const orders = new Map();
  const perUnits = [];
  for (const r of menuRuns) {
    const qty = Number(r.qty_produced) || 0;
    out.produced += qty;
    out.waste += Number(r.qty_waste) || 0;
    if (r.order_id) orders.set(String(r.order_id), Number(r.order_qty) || 0);
    if (r.cost !== null && r.cost !== undefined) {
      out.cost += Number(r.cost); out.costedQty += qty; out.costedRuns += 1;
      if (qty > 0) perUnits.push(Number(r.cost) / qty);
    }
    const rec = recipeOf(r);
    if (rec.batches !== null) { out.batches += rec.batches; out.batchesKnown += 1; }
    if (rec.expected !== null) { out.expected += rec.expected; out.expectedProduced += qty; }
    if (rec.recipeCost !== null) { out.recipeCost += rec.recipeCost; out.recipeRuns += 1; out.recipePerUnit = rec.recipePerUnit; }
  }
  out.orders = orders.size;
  out.ordered = [...orders.values()].reduce((a, b) => a + b, 0);
  out.avg = out.costedQty > 0 ? out.cost / out.costedQty : null;
  out.min = perUnits.length ? Math.min(...perUnits) : null;
  out.max = perUnits.length ? Math.max(...perUnits) : null;
  out.wastePct = out.produced + out.waste > 0 ? (out.waste / (out.produced + out.waste)) * 100 : 0;
  return out;
}

/** วันห่างระหว่างสองวันที่ (YYYY-MM-DD) */
const dayDiff = (from, to) => Math.round((Date.parse(`${String(to).slice(0, 10)}T00:00:00Z`)
  - Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`)) / 86400000);

/**
 * ดูทีละเมนู — เลือกเมนู (ค้นหา / ก่อนหน้า–ถัดไป / ผลิตบ่อยสุด) แล้วเห็นสรุปต้นทุน + ทุกครั้งที่ผลิต + วัตถุดิบรวม
 * ตัวเลขคิดจาก runs ชุดเดียวกับภาพรวม (ต้นทุนจริงต่อหน่วย = ต้นทุนรวม ÷ ยอดผลิตเฉพาะครั้งที่มีต้นทุน เหมือนสรุปต่อสินค้า)
 */
function MenuView({
  runs, summary, menuKey, onMenuKey, recipeOf, hasCost, menusReady, usage, ensureUsage, onOpenRun, onOpenProduct,
}) {
  // เมนูที่ผลิตในช่วงนี้ เรียงตามสรุปต่อสินค้า (ผลิตได้มากสุดก่อน)
  const list = summary;
  const current = list.find((m) => m.product_key === menuKey) || [...list].sort((a, b) => Number(b.run_count) - Number(a.run_count))[0];
  const key = current?.product_key;
  const idx = list.findIndex((m) => m.product_key === key);
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const searchRef = useRef(null);

  const menuRuns = useMemo(() => runs.filter((r) => r.product_key === key), [runs, key]);
  useEffect(() => { if (menuRuns.length) ensureUsage(menuRuns); }, [menuRuns]); // eslint-disable-line react-hooks/exhaustive-deps

  const frequent = useMemo(() => [...list].sort((a, b) => Number(b.run_count) - Number(a.run_count)).slice(0, 4), [list]);
  const matches = useMemo(() => {
    const words = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return list.filter((m) => words.every((w) => `${m.product_name || ''} ${m.product_code || ''}`.toLowerCase().includes(w))).slice(0, 30);
  }, [list, term]);
  const pick = (k) => { onMenuKey(k); setTerm(''); setOpen(false); };

  const st = useMemo(() => menuStats(menuRuns, recipeOf), [menuRuns, recipeOf]);

  const usageData = useMemo(() => {
    const live = menuRuns.some((r) => !r.recipe);
    if (!menuRuns.length || usage.issuesByOrder === null || (live && !(key in usage.recipes))) return null;
    return aggregateUsage(menuRuns, usage);
  }, [menuRuns, usage, key]);

  if (!current) return null;
  const unit = current.unit || 'หน่วย';
  const pct = (a, b) => (b > 0 ? `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(1)}%` : '');
  const bar = (v) => (st.min === null || st.max === st.min ? 60 : 15 + (85 * (v - st.min)) / (st.max - st.min));

  return (
    <div className="space-y-4">
      {/* เลือกเมนู */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-teal-200 bg-white px-4 py-3">
          <span className="text-xs text-slate-500">เมนู</span>
          <div className="relative flex-1 min-w-[220px]">
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 focus-within:border-amber-400 bg-white px-3 py-2">
              <Search className="w-4 h-4 text-slate-500 shrink-0" />
              <input ref={searchRef} value={open ? term : ''} onFocus={() => setOpen(true)}
                onBlur={() => setTimeout(() => setOpen(false), 150)}
                onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) pick(matches[0].product_key); if (e.key === 'Escape') e.currentTarget.blur(); }}
                placeholder={`${current.product_name} · ${current.product_code || ''}`}
                className="flex-1 bg-transparent text-sm text-slate-900 placeholder-slate-300 focus:outline-none" />
            </div>
            {open && (
              <ul className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl">
                {matches.length === 0 ? <li className="px-3 py-2 text-xs text-slate-500">ไม่พบเมนูที่ผลิตในช่วงนี้</li> : matches.map((m) => (
                  <li key={m.product_key}>
                    <button onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m.product_key)}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-100 ${m.product_key === key ? 'text-teal-700' : 'text-slate-800'}`}>
                      <span className="truncate">{m.product_name} <span className="text-[11px] text-slate-500">{m.product_code}</span></span>
                      <span className="text-[11px] text-slate-500 shrink-0">{m.run_count} ครั้ง</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex items-center gap-1 text-xs">
            <button onClick={() => pick(list[(idx - 1 + list.length) % list.length].product_key)} disabled={list.length < 2}
              className="flex items-center gap-0.5 px-2 py-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-30">
              <ChevronLeft className="w-3.5 h-3.5" /> ก่อนหน้า
            </button>
            <span className="text-slate-400">{idx + 1}/{list.length}</span>
            <button onClick={() => pick(list[(idx + 1) % list.length].product_key)} disabled={list.length < 2}
              className="flex items-center gap-0.5 px-2 py-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-30">
              ถัดไป <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-slate-500">ผลิตบ่อยสุด:</span>
          {frequent.map((m) => (
            <button key={m.product_key} onClick={() => pick(m.product_key)}
              className={`px-2.5 py-0.5 rounded-full border ${m.product_key === key
                ? 'border-teal-400 bg-teal-50 text-teal-700' : 'border-slate-200 text-slate-500 hover:text-slate-800'}`}>
              {m.product_name} <span className="font-mono text-slate-700">{m.run_count}</span>
            </button>
          ))}
          {list.length > frequent.length && (
            <button onClick={() => searchRef.current?.focus()} className="px-2.5 py-0.5 rounded-full border border-slate-200 text-slate-500 hover:text-slate-800">
              + อีก {list.length - frequent.length} เมนู
            </button>
          )}
        </div>
      </div>

      {/* การ์ดสรุป */}
      <div className={`grid grid-cols-2 gap-3 ${hasCost ? 'md:grid-cols-6' : 'md:grid-cols-3'}`}>
        <StatCard label="ผลิตกี่ครั้ง" value={menuRuns.length}
          sub={`${st.orders} คำสั่ง${st.batchesKnown ? ` · ${formatQty(round3(st.batches))} สูตร` : ''}`} tone="slate" />
        <StatCard label="ผลิตได้รวม" value={formatQty(st.produced)} tone="teal"
          sub={`${unit}${st.ordered > 0 ? ` · สั่ง ${formatQty(st.ordered)} (${Math.round((st.produced / st.ordered) * 100)}%)` : ''}`} />
        <StatCard label="ของเสีย" value={formatQty(st.waste)} tone="rose" sub={`${st.wastePct.toFixed(1)}% ของที่ทำออกมา`} />
        {hasCost && (
          <>
            <StatCard label="ต้นทุนจริงรวม" value={st.costedRuns ? formatBaht(st.cost) : '-'} tone="amber"
              sub={!menusReady ? 'ตามสูตร …' : st.recipeRuns ? `ตามสูตร ${formatBaht(st.recipeCost)}${st.costedRuns ? ` (${pct(st.cost, st.recipeCost)})` : ''}` : 'ไม่มีต้นทุนตามสูตร'} />
            <StatCard label={`ต้นทุนเฉลี่ย / ${unit}`} value={st.avg === null ? '-' : formatBaht(st.avg)} tone="emerald"
              sub={st.recipePerUnit !== null ? `ตามสูตร ${formatBaht(st.recipePerUnit)}` : (st.costedRuns < menuRuns.length ? `คิดจาก ${st.costedRuns}/${menuRuns.length} ครั้งที่มีต้นทุน` : '')} />
            <StatCard label={`ต่ำสุด – สูงสุด / ${unit}`} tone="slate"
              value={st.min === null ? '-' : <span className="text-base">{formatBaht(st.min)} – {formatBaht(st.max)}</span>}
              sub={st.min > 0 && st.max > st.min ? `ส่วนต่าง ${Math.round(((st.max - st.min) / st.min) * 100)}%` : ''} />
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        {/* ทุกครั้งที่ผลิต */}
        <section className="space-y-2 min-w-0">
          <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-amber-500" /> รายละเอียดการผลิตทุกรายการ · {current.product_name} ({menuRuns.length})
          </h2>
          <div className="bg-white border border-slate-100 shadow-sm rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[860px]">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="text-left px-3 py-3 font-medium">วันที่เสร็จ<div className="font-normal text-slate-500">วันผลิต · สั่งเมื่อ</div></th>
                  <th className="text-left px-3 py-3 font-medium">คำสั่งผลิต</th>
                  <th className="text-right px-3 py-3 font-medium">สูตร</th>
                  <th className="text-right px-3 py-3 font-medium">ผลิตได้</th>
                  <th className="text-right px-3 py-3 font-medium" title="ผลิตได้จริง เทียบยอดที่ควรได้ตามสูตร (จำนวนสูตร × ผลผลิตต่อสูตร)">
                    เทียบสูตร<div className="font-normal text-slate-500">ได้ต่อสูตร</div>
                  </th>
                  <th className="text-right px-3 py-3 font-medium">ของเสีย</th>
                  {hasCost && <th className="text-right px-3 py-3 font-medium">ต้นทุนจริง</th>}
                  {hasCost && <th className="text-right px-3 py-3 font-medium">ต้นทุน/{unit}</th>}
                  <th className="text-left px-3 py-3 font-medium">ผู้บันทึก</th>
                </tr>
              </thead>
              <tbody>
                {menuRuns.map((r) => {
                  const rec = recipeOf(r);
                  const qty = Number(r.qty_produced) || 0;
                  const cost = r.cost === null || r.cost === undefined ? null : Number(r.cost);
                  const per = cost !== null && qty > 0 ? cost / qty : null;
                  const late = r.finish_date ? dayDiff(r.produce_date, r.finish_date) : 0;
                  const extreme = per !== null && st.max > st.min ? (per === st.max ? 'text-rose-600' : per === st.min ? 'text-emerald-700' : 'text-slate-800') : 'text-slate-800';
                  return (
                    <tr key={r.run_id} onClick={() => onOpenRun(r)} title="กดเพื่อดูยอดวัตถุดิบ ตามสูตรเทียบใช้จริงของครั้งนี้"
                      className="border-t border-slate-100 hover:bg-amber-50/60 cursor-pointer">
                      <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                        <div className="text-emerald-700">{formatThaiDate(r.finish_date || r.produce_date)}</div>
                        <div className={`text-[11px] ${late > 0 ? 'text-amber-700' : 'text-slate-500'}`}>
                          ผลิต {formatThaiDate(r.produce_date)}{late > 0 ? ` (ค้าง ${late} วัน)` : ''}
                        </div>
                        {r.ordered_at && <div className="text-[11px] text-slate-400">สั่ง {formatThaiDate(r.ordered_at)}</div>}
                      </td>
                      <td className="px-3 py-2.5">
                        {r.order_doc_no
                          ? <span className="font-mono text-[11px] text-amber-700">{r.order_doc_no}</span>
                          : <span className="text-[11px] text-slate-400">ผลิตนอกคำสั่ง</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-700">
                        {rec.batches === null ? <span className="text-slate-400">-</span> : formatQty(round3(rec.batches))}
                        {!r.recipe && rec.batches !== null && <span className="text-amber-700" title="คิดจากสูตรปัจจุบันของ QC/RD"> *</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right text-teal-700">{formatQty(qty)}</td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <YieldDiff produced={qty} expected={rec.expected} batches={rec.batches} perBatch={rec.perBatchYield} />
                      </td>
                      <td className="px-3 py-2.5 text-right text-rose-600">{Number(r.qty_waste) ? formatQty(r.qty_waste) : '-'}</td>
                      {hasCost && (
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          {cost === null
                            ? <span className="text-[11px] text-slate-400">{!r.order_id ? '-' : Number(r.issue_lines) ? 'ไม่มีราคา' : 'ไม่มีใบเบิก'}</span>
                            : <span className="text-amber-700">{formatBaht(cost)}</span>}
                        </td>
                      )}
                      {hasCost && (
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          {per === null ? <span className="text-slate-400">-</span> : (
                            <span className="inline-flex items-center gap-2">
                              <span className={extreme}>{formatBaht(per)}</span>
                              <span className="w-16 h-2 rounded bg-slate-100 overflow-hidden">
                                <span className="block h-full rounded bg-amber-400" style={{ width: `${bar(per)}%` }} />
                              </span>
                            </span>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2.5 text-xs text-slate-500">{r.recorder || '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-slate-50 font-semibold text-slate-800">
                <tr className="border-t border-slate-200">
                  <td className="px-3 py-2.5 text-xs" colSpan={2}>รวม {menuRuns.length} ครั้ง</td>
                  <td className="px-3 py-2.5 text-right font-mono">{st.batchesKnown ? formatQty(round3(st.batches)) : '-'}</td>
                  <td className="px-3 py-2.5 text-right text-teal-700">{formatQty(st.produced)}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    <YieldDiff produced={st.expectedProduced} expected={st.expected || null} batches={st.batchesKnown ? st.batches : null}
                      perBatch={menuRuns.map((r) => recipeOf(r).perBatchYield).find((v) => v !== null) ?? null} />
                  </td>
                  <td className="px-3 py-2.5 text-right text-rose-600">{st.waste ? formatQty(st.waste) : '-'}</td>
                  {hasCost && <td className="px-3 py-2.5 text-right text-amber-700">{st.costedRuns ? formatBaht(st.cost) : '-'}</td>}
                  {hasCost && <td className="px-3 py-2.5 text-right whitespace-nowrap">{st.avg === null ? '-' : `เฉลี่ย ${formatBaht(st.avg)}`}</td>}
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-[11px] text-slate-500">
            กดแถว = ดูยอดวัตถุดิบตามสูตรเทียบใช้จริงของครั้งนั้น · ต้นทุน/{unit} สีแดง = สูงสุด สีเขียว = ต่ำสุดในช่วงนี้
            · ต้นทุนเฉลี่ย = ต้นทุนรวม ÷ ยอดผลิตเฉพาะครั้งที่มีต้นทุน
          </p>
        </section>

        {/* วัตถุดิบรวมทุกครั้ง */}
        <aside className="rounded-xl border border-slate-200 bg-white p-3 text-xs space-y-2 h-fit">
          <h3 className="font-semibold text-slate-800 flex items-center gap-1.5">🧾 สรุปวัตถุดิบของเมนูนี้ (รวมทุกครั้ง)</h3>
          {usage.error && <p className="text-rose-600">{usage.error}</p>}
          {!usageData ? (
            <div className="flex items-center gap-2 py-6 justify-center text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> กำลังโหลดใบเบิกและสูตร...</div>
          ) : usageData.rows.length === 0 ? (
            <p className="text-slate-500 py-4 text-center">ไม่มีข้อมูลวัตถุดิบ</p>
          ) : (
            <>
              <ul className="divide-y divide-dashed divide-slate-100">
                {usageData.rows.slice(0, 8).map((l) => {
                  const over = usageData.nIssued > 0 && l.recipe > 0 && l.actual > l.recipe;
                  return (
                    <li key={l.key} className="flex items-baseline justify-between gap-2 py-1.5">
                      <span className="text-slate-700 truncate" title={l.code}>{l.name}</span>
                      <span className="text-slate-500 whitespace-nowrap">
                        {l.recipe > 0 ? `ตามสูตร ${formatQty(round3(l.recipe))}` : 'ไม่มีในสูตร'}
                        {usageData.nIssued > 0 && <> · ใช้จริง <b className={over ? 'text-rose-600' : 'text-slate-900'}>{formatQty(round3(l.actual))}</b></>}
                        {' '}{l.unit}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="flex items-center justify-between pt-1">
                <span className="text-slate-500">
                  {usageData.nIssued > 0 ? `รวมจาก ${usageData.nIssued}/${usageData.n} ครั้งที่มีใบเบิก` : 'ไม่มีใบเบิก — เฉพาะตามสูตร'}
                </span>
                <button onClick={() => onOpenProduct(key)} className="text-teal-700 hover:text-amber-700">
                  {usageData.rows.length > 8 ? `ดูทั้งหมด ${usageData.rows.length} รายการ ›` : 'ดูละเอียด ›'}
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * ยอดวัตถุดิบ ตามสูตรเทียบใช้จริง
 *   ครั้งเดียว — ยอดของการผลิตครั้งนั้น (ส่วนแบ่งของคำสั่งตามจำนวนที่ได้)
 *   ต่อสินค้า — ทุกครั้งในช่วงรายงาน แสดงเป็นค่าเฉลี่ยต่อครั้ง หรือต่อ 1 สูตร
 *              ถ้ามีครั้งที่มีใบเบิก ทุกคอลัมน์เฉลี่ยจากครั้งเหล่านั้นชุดเดียวกัน (ครั้งที่ไม่มีใบเบิกไม่รู้ยอดใช้
 *              ไม่ใช่ใช้ 0 — ถ้าเอาไปรวมเฉพาะฝั่งสูตร ผลต่างจะเทียบคนละชุดกัน) · ไม่มีใบเบิกเลย = เฉลี่ยสูตรจากทุกครั้ง
 */
function UsageModal({ detail, runs, totals, issuesByOrder, recipes, error, onClose }) {
  const [per, setPer] = useState('run'); // 'run' | 'batch'
  const isRun = detail.kind === 'run';
  const targetRuns = useMemo(
    () => (isRun ? [detail.run] : runs.filter((r) => r.product_key === detail.productKey)),
    [isRun, detail, runs]
  );
  const first = targetRuns[0] || {};
  // ครั้งที่ไม่ได้เก็บสูตร ณ วันผลิต ต้องรอสูตรปัจจุบันจาก QC/RD
  const nLive = targetRuns.filter((r) => !r.recipe).length;
  const loading = issuesByOrder === null || (nLive > 0 && !(first.product_key in recipes));

  const data = useMemo(() => (loading ? null : aggregateUsage(targetRuns, { issuesByOrder, recipes, totals })),
    [loading, recipes, issuesByOrder, totals, targetRuns]);

  // ตัวหารของค่าเฉลี่ย — ครั้งเดียวไม่หาร
  const div = () => {
    if (isRun || !data) return 1;
    return per === 'batch' ? data.batchesIssued : data.nPool;
  };
  const avg = (v) => { const d = div(); return d > 0 ? round3(v / d) : null; };
  const label = isRun ? '' : per === 'batch' ? ' / 1 สูตร' : ' เฉลี่ย/ครั้ง';

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-start justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-4xl my-10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-200">
          <div className="min-w-0">
            <h2 className="font-semibold text-slate-900 text-sm">{first.product_name} · ยอดวัตถุดิบ ตามสูตรเทียบใช้จริง</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {isRun ? (
                <>ผลิต {formatThaiDate(first.produce_date)}{first.finish_date ? ` · เสร็จ ${formatThaiDate(first.finish_date)}` : ''} · ได้ {formatQty(first.qty_produced)} {first.unit || ''}
                  {first.order_doc_no ? ` · คำสั่ง ${first.order_doc_no}` : ' · ผลิตนอกคำสั่ง (ไม่มีใบเบิก)'}
                  {data?.perRun[0]?.batches !== null && data?.perRun[0]?.batches !== undefined && ` · ${formatQty(round3(data.perRun[0].batches))} สูตร`}
                  {data && data.perRun[0]?.share < 1 && ` · ส่วนแบ่ง ${Math.round(data.perRun[0].share * 100)}% ของคำสั่ง (ผลิตหลายครั้ง)`}</>
              ) : data ? (
                <>ผลิต {data.n} ครั้งในช่วงรายงาน · รวม {formatQty(round3(data.batchesAll))} สูตร · มีใบเบิก {data.nIssued} ครั้ง ·{' '}
                  {data.nIssued > 0
                    ? `เฉลี่ยจาก ${data.nIssued} ครั้งที่มีใบเบิก (${formatQty(round3(data.batchesIssued))} สูตร)`
                    : 'ไม่มีใบเบิก — เฉลี่ยเฉพาะยอดตามสูตร'}</>
              ) : 'กำลังโหลด...'}
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-slate-500 hover:text-slate-700"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3">
          {!isRun && (
            <div className="flex gap-1 p-1 bg-slate-50 border border-slate-200 rounded-lg w-fit text-xs">
              {[['run', 'เฉลี่ยต่อครั้งที่ผลิต'], ['batch', 'เฉลี่ยต่อ 1 สูตร']].map(([k, t]) => (
                <button key={k} onClick={() => setPer(k)}
                  className={`px-3 py-1.5 rounded-md ${per === k ? 'bg-teal-50 text-teal-700 border border-teal-200' : 'text-slate-500 hover:text-slate-800'}`}>
                  {t}
                </button>
              ))}
            </div>
          )}
          {error && <p className="text-xs text-rose-600">{error}</p>}
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin text-amber-500" /> กำลังโหลดใบเบิกและสูตร...</div>
          ) : (
            <>
              {!data.recipe && <p className="text-xs text-amber-700">ไม่พบสูตร BOM ของเมนูนี้ใน QC/RD — แสดงเฉพาะยอดใช้จริง</p>}
              {data.recipe && nLive > 0 && (
                <p className="text-xs text-amber-700">
                  * {isRun ? 'การผลิตนี้' : `${nLive} จาก ${targetRuns.length} ครั้ง`}ไม่มีสูตร ณ วันผลิตเก็บไว้ (คำสั่งก่อนเริ่มเก็บสูตร หรือผลิตนอกคำสั่ง) — ยอดตามสูตรคิดจากสูตรปัจจุบันของ QC/RD
                </p>
              )}
              {data.nIssued === 0 && <p className="text-xs text-amber-700">ไม่มีใบเบิกวัตถุดิบของการผลิตนี้ — แสดงเฉพาะยอดตามสูตร</p>}
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-sm min-w-[760px]">
                  <thead className="bg-slate-50 text-slate-500 text-xs">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">วัตถุดิบ</th>
                      <th className="text-left px-3 py-2 font-medium">หน่วย</th>
                      <th className="text-right px-3 py-2 font-medium">ตามสูตร{label}</th>
                      <th className="text-right px-3 py-2 font-medium">ใช้จริง{label}</th>
                      <th className="text-right px-3 py-2 font-medium">สูญเสีย{label}</th>
                      <th className="text-right px-3 py-2 font-medium">ใช้จริง − สูตร</th>
                      <th className="text-right px-3 py-2 font-medium">ต้นทุนใช้จริง{label}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.length === 0 ? (
                      <tr><td colSpan={7} className="py-10 text-center text-xs text-slate-500">ไม่มีข้อมูลวัตถุดิบ</td></tr>
                    ) : data.rows.map((r) => {
                      const rec = r.recipe > 0 ? avg(r.recipe) : null;
                      const act = data.nIssued > 0 ? avg(r.actual) : null;
                      const loss = data.nIssued > 0 ? avg(r.loss) : null;
                      const cost = data.nIssued > 0 && r.cost > 0 ? r.cost / (div() || 1) : null;
                      const d = rec !== null && act !== null ? round3(act - rec) : null;
                      const notInRecipe = r.recipe === 0 && r.actual > 0;
                      return (
                        <tr key={r.key} className="border-t border-slate-100">
                          <td className="px-3 py-2">
                            <div className="text-slate-800">{r.name}</div>
                            <div className="text-[10px] text-slate-500 font-mono">
                              {r.code}
                              {notInRecipe && <span className="ml-1.5 font-sans text-amber-700">· ไม่มีในสูตร</span>}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-500">{r.unit}</td>
                          <td className="px-3 py-2 text-right font-mono text-slate-500">{rec === null ? '-' : formatQty(rec)}</td>
                          <td className="px-3 py-2 text-right font-mono text-slate-900">{act === null ? '-' : formatQty(act)}</td>
                          <td className="px-3 py-2 text-right font-mono text-rose-600">{loss ? formatQty(loss) : '-'}</td>
                          <td className={`px-3 py-2 text-right font-mono text-xs ${d > 0 ? 'text-rose-600' : d < 0 ? 'text-emerald-700' : 'text-slate-500'}`}>
                            {d === null ? '-' : `${d > 0 ? '+' : ''}${formatQty(d)}`}
                          </td>
                          <td className="px-3 py-2 text-right text-xs text-amber-700">{cost === null ? '-' : formatBaht(cost)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-slate-500">
                ตามสูตร = สูตร BOM ของ QC/RD × จำนวนสูตรของคำสั่งผลิต · ใช้จริง = ใบเบิกวัตถุดิบของคำสั่ง (รวมของสูญเสียแล้ว)
                · คำสั่งที่ผลิตหลายครั้งแบ่งตามสัดส่วนจำนวนที่ได้ · ใช้จริง − สูตร แดง = ใช้เกินสูตร เขียว = ใช้น้อยกว่าสูตร
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** ต้นทุนรวมของสินค้า + ต้นทุนเฉลี่ยต่อหน่วย (สองช่องท้ายตารางสรุป) */
/** สีต้นทุนจริงต่อหน่วยเทียบต้นทุนตามสูตร — แดง = แพงกว่าสูตร เขียว = ไม่เกินสูตร */
const vsRecipe = (actual, recipe) => (recipe === null || recipe === undefined || actual === null
  ? 'text-amber-800' : actual > recipe ? 'text-rose-600' : 'text-emerald-700');

function SummaryCost({ s, recipePerUnit }) {
  const cost = s.total_cost === null || s.total_cost === undefined ? null : Number(s.total_cost);
  const lossCost = Number(s.total_loss_cost) || 0;
  const costedQty = Number(s.costed_qty) || 0;
  const perUnit = cost !== null && costedQty > 0 ? cost / costedQty : null;
  const uncosted = Number(s.uncosted_runs) || 0;
  const partial = Number(s.partial_runs) || 0;
  return (
    <>
      <td className="px-4 py-3 text-right whitespace-nowrap">
        {cost === null ? <span className="text-slate-400">-</span> : <div className="text-amber-700">{formatBaht(cost)}</div>}
        {lossCost > 0 && <div className="text-[11px] text-rose-500">สูญเสีย {formatBaht(lossCost)}</div>}
        {uncosted > 0 && (
          <div className="text-[11px] text-slate-500" title="คำสั่งผลิตไม่มีใบเบิก หรือผลิตนอกคำสั่ง — ไม่นับในต้นทุนเฉลี่ย">
            ไม่มีต้นทุน {uncosted} ครั้ง
          </div>
        )}
        {partial > 0 && (
          <div className="text-[11px] text-amber-600" title="บางบรรทัดในใบเบิกไม่มีราคา — ต้นทุนต่ำกว่าจริง">
            ราคาไม่ครบ {partial} ครั้ง
          </div>
        )}
      </td>
      <td className="px-4 py-3 text-right whitespace-nowrap">
        {perUnit === null ? <span className="text-slate-400">-</span> : (
          <>
            <span className={`font-semibold ${vsRecipe(perUnit, recipePerUnit)}`}
              title={recipePerUnit !== null ? 'แดง = แพงกว่าตามสูตร · เขียว = ไม่เกินตามสูตร' : undefined}>{formatBaht(perUnit)}</span>
            <span className="text-slate-500 text-xs">/{s.unit || 'หน่วย'}</span>
          </>
        )}
      </td>
    </>
  );
}

/** ต้นทุนของการผลิตครั้งเดียว — ส่วนแบ่งจากใบเบิกของคำสั่งผลิตตามจำนวนที่ได้ */
function RunCost({ r, recipePerUnit }) {
  const cost = r.cost === null || r.cost === undefined ? null : Number(r.cost);
  const qty = Number(r.qty_produced) || 0;
  const noPrice = Number(r.no_price_count) || 0;
  // ผลิตนอกคำสั่ง = ไม่มีทางรู้ต้นทุน · มีคำสั่งแต่ไม่มีใบเบิก หรือใบเบิกไม่มีราคาเลยสักบรรทัด
  const why = !r.order_id ? '-' : Number(r.issue_lines) ? 'ไม่มีราคา' : 'ไม่มีใบเบิก';
  return (
    <>
      <td className="px-4 py-3 text-right whitespace-nowrap">
        {cost === null ? (
          <span className={`text-[11px] ${why === 'ไม่มีราคา' ? 'text-amber-600' : 'text-slate-400'}`}>{why}</span>
        ) : (
          <>
            <div className="text-amber-700">{formatBaht(cost)}</div>
            {Number(r.loss_cost) > 0 && <div className="text-[11px] text-rose-500">สูญเสีย {formatBaht(r.loss_cost)}</div>}
            {noPrice > 0 && (
              <div className="text-[11px] text-amber-600" title="บรรทัดในใบเบิกที่ไม่มีราคา ไม่ได้รวมในต้นทุน">
                ไม่มีราคา {noPrice} รายการ
              </div>
            )}
          </>
        )}
      </td>
      <td className="px-4 py-3 text-right whitespace-nowrap">
        {cost === null || qty <= 0 ? <span className="text-slate-400">-</span> : (
          <>
            <span className={vsRecipe(cost / qty, recipePerUnit)}
              title={recipePerUnit !== null ? 'แดง = แพงกว่าตามสูตร · เขียว = ไม่เกินตามสูตร' : undefined}>{formatBaht(cost / qty)}</span>
            <span className="text-slate-500 text-xs">/{r.unit || 'หน่วย'}</span>
          </>
        )}
      </td>
    </>
  );
}

function StatCard({ label, value, sub, tone }) {
  const toneClass = {
    teal: 'text-teal-700 border-teal-200 bg-teal-50',
    rose: 'text-rose-600 border-rose-200 bg-rose-50',
    amber: 'text-amber-700 border-amber-200 bg-amber-50',
    emerald: 'text-emerald-700 border-emerald-200 bg-emerald-50',
    slate: 'text-slate-700 border-slate-200 bg-white',
  }[tone] || 'text-slate-700 border-slate-200 bg-white';

  return (
    <div className={`rounded-xl border px-4 py-3 ${toneClass}`}>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-xl font-bold mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}
