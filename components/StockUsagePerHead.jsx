// STOCK › รายงานการใช้วัตถุดิบต่อหัว ของสาขา
//
// ตอบคำถามเดียว: "วัตถุดิบตัวนี้ แต่ละสาขาใช้ไปเท่าไหร่ และคิดเป็นเท่าไหร่ต่อลูกค้า 1 หัว"
// เอาไว้จับสาขาที่ใช้เปลืองผิดปกติ โดยเทียบกันได้ตรง ๆ แม้สาขาจะขายไม่เท่ากัน
//
// ที่มาของตัวเลข (ไม่มีการคิดสูตรใหม่ในไฟล์นี้ — ใช้ของที่ระบบคิดอยู่แล้วทุกตัว)
// "ยอดใช้" เลือกได้สองฐานจากปุ่มบนแถบเครื่องมือ ส่วน "ต่อหัว" คิดวิธีเดียวกันทั้งคู่ ต่างแค่ตัวตั้ง:
//
//   1) ยอดใช้จาก BOM (ค่าเริ่มต้น) = /api/usage-bom → ยอดขายจริง × สูตร BOM
//      (ชุดเดียวกับคอลัมน์ "ยอดใช้จากระบบ" ของหน้านับสต๊อก รวมกฎกันนับซ้ำใน lib/usageRules.js
//      ครบทุกข้อ) — คือของที่ "ควรใช้ตามสูตร"
//
//   2) ยอดจากปิดรอบ (Endding) = ยกมา + รับเข้า − ปิดรอบ — คือของที่ "หายไปจากสต๊อกจริง"
//        ยกมา    = ยอดปิดรอบของรอบเดือนก่อนหน้า  (/api/stock-month-end)
//        รับเข้า  = ใบรับของสาขาในช่วงเดียวกัน      (/api/orderd)
//        ปิดรอบ  = ยอดปิดรอบของรอบเดือนที่เลือก   (/api/stock-month-end)
//      ช่วงวันคิดทีละสาขา = วันถัดจากวันปิดรอบก่อนหน้า ถึงวันปิดรอบของรอบที่เลือก เพราะสาขา
//      ปิดรอบกันคนละวัน — ยอดรับเข้ากับจำนวนหัวจึงนับในช่วงเดียวกับที่ยอดสต๊อกขยับจริง
//      (สูตรเดียวกับคอลัมน์ "ยอดคงเหลือจากระบบ = ยกมา+รับ-ใช้" ของหน้านับสต๊อก แค่ย้ายข้างสมการ)
//
//   จำนวนหัว = meta.covers ของ /api/usage-bom — จานบุฟเฟต์ที่จ่ายจริง (ไม่รวมเด็กฟรี)
//             ยกเว้น WRM/WMT ที่ใช้ Cover All ของบิล (ดู lib/coverRules.js)
//
// ส่วนต่างของสองฐานนี้คือของที่หาย ตักเกินสูตร หรือตัดสต๊อกไม่ครบ — เปิดทีละฐานแล้วเทียบเอง
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { BarChart3, Search, Loader2, AlertCircle, Download, Users, Package, AlertTriangle, Store, ChevronDown, Calendar } from 'lucide-react';
import { toast } from 'react-hot-toast';
import * as XLSX from 'xlsx-js-style'; // fork ของ xlsx ที่ใส่สี/ฟอนต์ในเซลล์ได้ (API เดียวกัน)
import { apiRead } from '../lib/stockApi';

// ต้องตรงกับ normalizeId ใน /api/usage-bom เป๊ะ ไม่งั้นคีย์รหัสสินค้าจับคู่กันไม่ติด
const normalizeId = id => String(id ?? '').replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

// ยิงทีละชุดแทนการยิงทุกสาขาพร้อมกัน — เหตุผลเดียวกับหน้า "ดูยอดรวมทุกสาขา"
// (host API ช้าลงมากเมื่อโดนหลายสาขาพร้อมกัน และเบราว์เซอร์คิวเกิน ~6 คำขอต่อโดเมนอยู่แล้ว)
const BRANCH_BATCH = 5;

/** ต่างจากค่ากลางเกินกี่ % ถึงจะทาสีเตือน */
const DEVIATION_PCT = 15;

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

/** 'YYYY-MM' -> 'สิงหาคม 2569' — เรียกให้ตรงกับหน้า "ดูข้อมูลปิดรอบเดือน" (ปี พ.ศ.) */
const monthLabel = (m) => {
  const mt = String(m || '').match(/^(\d{4})-(\d{2})/);
  return mt ? `${TH_MONTHS[Number(mt[2]) - 1] || mt[2]} ${Number(mt[1]) + 543}` : String(m || '');
};

/** 'YYYY-MM' บวก/ลบกี่เดือน (ใช้หา "รอบก่อนหน้า" ที่เอามาเป็นยอดยกมา) */
const shiftMonth = (m, delta) => {
  const mt = String(m || '').match(/^(\d{4})-(\d{2})$/);
  if (!mt) return '';
  const d = new Date(Date.UTC(Number(mt[1]), Number(mt[2]) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** 'YYYY-MM-DD' บวกกี่วัน — คิดที่ UTC จะได้ไม่โดนโซนเวลาเลื่อนวันตอนข้ามเดือน */
const addDays = (iso, n) => {
  const mt = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!mt) return '';
  const d = new Date(Date.UTC(Number(mt[1]), Number(mt[2]) - 1, Number(mt[3]) + n));
  return d.toISOString().slice(0, 10);
};

const fmtUsage = v => Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPerHead = v => Number(v).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const fmtInt = v => Number(v).toLocaleString();

export default function StockUsagePerHead() {
  const [items, setItems] = useState([]);          // ทะเบียนสินค้า (ชื่อ/หน่วย/หมวด) จากยอดรวมทุกสาขา
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [progress, setProgress] = useState(null);  // { done, total } ระหว่างไล่ยิงทีละชุด

  const [searchTerm, setSearchTerm] = useState('');
  // ตั้งต้นเรียงตามยอดใช้รวม — ตัวที่ใช้เยอะสุดคือตัวที่คุ้มกับการไล่ดูก่อน
  // (เรียงตามหมวดจัดเก็บยังเลือกได้ แต่ไม่เอาเป็นค่าเริ่มต้น เพราะคอลัมน์หมวดไม่ได้แสดงในตารางแล้ว)
  const [sortBy, setSortBy] = useState('usage');
  // สาขาที่เอามาเทียบกัน — ค่าเริ่มต้นคือทุกสาขาที่มี outletId (ติ๊กออกได้ทีละสาขา)
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [viewMode, setViewMode] = useState('both'); // 'both' | 'perHead' | 'usage'
  const [onlyUsed, setOnlyUsed] = useState(true);   // ซ่อนไอเทมที่ช่วงนี้ไม่มีการใช้เลย
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // ฐานที่ใช้คิดยอดใช้ : 'bom' = ยอดขายจริง × สูตร | 'closing' = ยกมา + รับเข้า − ปิดรอบ
  const [usageSource, setUsageSource] = useState('bom');
  const [closingMonth, setClosingMonth] = useState('');   // รอบเดือนที่เลือก ('YYYY-MM')
  const [monthOptions, setMonthOptions] = useState([]);
  const [loadingMonths, setLoadingMonths] = useState(false);
  // แถวปิดรอบที่ดึงมาแล้ว { 'YYYY-MM': data } — สลับรอบไปมา/กดคำนวณซ้ำจะได้ไม่ยิงซ้ำ
  const monthCacheRef = useRef({});

  // ผลการคำนวณรอบล่าสุด — เก็บช่วงวันที่ที่ใช้คำนวณไว้ด้วย จะได้ไม่โชว์เลขเก่าคู่กับวันที่ใหม่
  const [report, setReport] = useState(null); // { from, to, branches: [...], usage: {branch: {id: qty}} }
  const [detailItem, setDetailItem] = useState(null);
  const [showHotSpots, setShowHotSpots] = useState(false);  // กดการ์ด "จุดที่ใช้เกินค่ากลาง" แล้วไล่ดูทีละจุด

  // ค่าตั้งเบิกที่สาขาตั้งไว้ (ตาราง stock_avg_per_head) — โหลดตอนเปิดหน้าต่างรายละเอียดครั้งแรก
  const [settings, setSettings] = useState(null);
  const [loadingSettings, setLoadingSettings] = useState(false);

  useEffect(() => {
    const today = new Date();
    const local = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().split('T')[0];
    const first = local.slice(0, 8) + '01';
    setStartDate(first);
    setEndDate(local);
    loadInitial();
  }, []);

  const loadInitial = async () => {
    setLoading(true);
    try {
      const [branchRes, itemRes] = await Promise.all([
        apiRead('getBranches'),
        apiRead('getStockTotal', { endDate: '' }),
      ]);
      if (branchRes.status === 'success') {
        const list = (branchRes.data || []).filter(b => String(b.name).toLowerCase() !== 'all');
        setBranches(list);
        setSelectedKeys(list.filter(b => b.outletId).map(b => String(b.name).toLowerCase()));
      }
      if (itemRes.status === 'success') {
        setItems(itemRes.data || []);
        if (itemRes.warning) toast.error(itemRes.warning, { duration: 8000 });
      }
    } catch (err) {
      toast.error('โหลดทะเบียนสินค้า/สาขาไม่สำเร็จ: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  /** สาขาที่ติ๊กไว้และยิงข้อมูลได้จริง — ใช้ร่วมกันทั้งสองฐาน (null = ยังเลือกไม่ครบ) */
  const pickTargets = () => {
    // ดึงเฉพาะสาขาที่ติ๊กไว้ — เลือกน้อยลงก็รอสั้นลงจริง ไม่ใช่ดึงหมดแล้วมาซ่อนทีหลัง
    const targets = branches.filter(b => b.outletId && selectedKeys.includes(String(b.name).toLowerCase()));
    if (targets.length === 0) {
      toast.error(branches.some(b => b.outletId)
        ? 'ยังไม่ได้เลือกสาขาที่จะเทียบ — กดปุ่ม “สาขาที่เทียบ” แล้วติ๊กอย่างน้อย 1 สาขา'
        : 'ไม่พบสาขาที่มีรหัส outlet — ดึงยอดใช้ไม่ได้');
      return null;
    }
    return targets;
  };

  /** บอกให้ชัดว่าสาขาไหนไม่ได้ข้อมูล — ค่ากลางที่คิดได้จะไม่รวมสาขาพวกนั้น */
  const reportToast = (stats) => {
    const failed = stats.filter(s => !s.ok).map(s => s.name.toUpperCase());
    const noCovers = stats.filter(s => s.ok && !s.covers).map(s => s.name.toUpperCase());
    if (failed.length === 0 && noCovers.length === 0) {
      toast.success(`คำนวณครบ ${stats.length} สาขา`);
    } else if (failed.length === stats.length) {
      toast.error(`ดึงยอดใช้ไม่สำเร็จทั้ง ${stats.length} สาขา`, { duration: 7000 });
    } else {
      const parts = [];
      if (failed.length) parts.push(`ดึงไม่สำเร็จ ${failed.length} สาขา (${failed.slice(0, 4).join(', ')}${failed.length > 4 ? '…' : ''})`);
      if (noCovers.length) parts.push(`ไม่มีจำนวนหัว ${noCovers.length} สาขา (${noCovers.slice(0, 4).join(', ')}${noCovers.length > 4 ? '…' : ''}) — คิดต่อหัวไม่ได้`);
      toast(parts.join(' · '), { icon: '⚠️', duration: 8000 });
    }
  };

  /** กดปุ่มเดียว แต่ไปคนละทางตามฐานที่เลือกอยู่ */
  const fetchReport = () => (usageSource === 'closing' ? fetchClosingReport() : fetchBomReport());

  const fetchBomReport = async () => {
    if (!startDate || !endDate) { toast.error('กรุณาระบุช่วงวันที่ให้ครบถ้วน'); return; }
    if (startDate > endDate) { toast.error('วันที่เริ่มต้นอยู่หลังวันที่สิ้นสุด'); return; }
    const targets = pickTargets();
    if (!targets) return;

    setIsFetching(true);
    setProgress({ done: 0, total: targets.length });
    try {
      const stats = [];
      const usage = {};
      for (let i = 0; i < targets.length; i += BRANCH_BATCH) {
        const chunk = targets.slice(i, i + BRANCH_BATCH);
        const results = await Promise.all(chunk.map(b =>
          fetch(`/api/usage-bom?branch=${encodeURIComponent(b.name)}&outletId=${encodeURIComponent(b.outletId)}`
            + `&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`)
            .then(r => r.json())
            .catch(err => ({ status: 'error', message: err.message }))
        ));
        results.forEach((res, idx) => {
          const b = chunk[idx];
          const key = String(b.name).toLowerCase();
          const ok = res.status === 'success';
          const covers = ok && res.meta ? res.meta.covers : null;
          stats.push({
            name: String(b.name),
            key,
            outletId: b.outletId,
            ok,
            covers: covers === null || covers === undefined ? null : Number(covers),
            coversSource: ok && res.meta ? res.meta.coversSource : '',
            error: ok ? '' : (res.message || 'ดึงข้อมูลไม่สำเร็จ'),
          });
          const map = {};
          if (ok) Object.entries(res.data || {}).forEach(([id, u]) => { map[id] = Number(u.total) || 0; });
          usage[key] = map;
        });
        setProgress({ done: Math.min(i + BRANCH_BATCH, targets.length), total: targets.length });
      }

      stats.sort((a, b) => a.name.localeCompare(b.name));
      setReport({ source: 'bom', from: startDate, to: endDate, branches: stats, usage });
      reportToast(stats);
    } catch (err) {
      toast.error('เกิดข้อผิดพลาดในการคำนวณ: ' + err.message);
    } finally {
      setIsFetching(false);
      setProgress(null);
    }
  };

  /* ───────────────────── ฐานที่สอง : ยอดจากปิดรอบสิ้นเดือน ───────────────────── */

  /** แถวปิดรอบของรอบเดือนหนึ่ง (month ว่าง = รอบล่าสุดที่มีข้อมูล) — จำไว้ไม่ให้ยิงซ้ำ */
  const fetchMonthEnd = async (month) => {
    const cacheKey = month || 'latest';
    if (monthCacheRef.current[cacheKey]) return monthCacheRef.current[cacheKey];
    const res = await fetch(`/api/stock-month-end${month ? `?month=${encodeURIComponent(month)}` : ''}`);
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.message || 'ดึงข้อมูลปิดรอบเดือนไม่สำเร็จ');
    const data = json.data || {};
    monthCacheRef.current[cacheKey] = data;
    if (data.month) monthCacheRef.current[data.month] = data;   // ยิงแบบ 'latest' แล้วรู้ว่าเป็นรอบไหน
    return data;
  };

  /** รายชื่อรอบเดือนที่มีข้อมูล — โหลดตอนสลับมาฐานปิดรอบครั้งแรก */
  const loadMonths = async () => {
    setLoadingMonths(true);
    try {
      const data = await fetchMonthEnd('');
      if (data.months?.length) setMonthOptions(data.months);
      if (data.month) setClosingMonth(prev => prev || data.month);
    } catch (err) {
      toast.error('ดึงรายชื่อรอบเดือนไม่สำเร็จ: ' + err.message);
    } finally {
      setLoadingMonths(false);
    }
  };

  /** สลับฐานที่ใช้คิดยอดใช้ — ล้างผลเดิมทิ้ง เลขสองฐานนี้อยู่บนตารางเดียวกันไม่ได้ */
  const switchSource = (src) => {
    if (src === usageSource) return;
    setUsageSource(src);
    setReport(null);
    setDetailItem(null);
    setShowHotSpots(false);
    if (src === 'closing' && monthOptions.length === 0) loadMonths();
  };

  /**
   * ยอดปิดรอบรายสาขา: { สาขา: { date, items: { รหัส: ยอดคงเหลือ } } }
   * เอาเฉพาะแถวของ "วันที่ปิดล่าสุด" ในรอบนั้น — สาขาที่นับซ้ำหลายวันจะได้ไม่บวกกันมั่ว
   */
  const groupClosing = (rows) => {
    const lastDate = {};
    (rows || []).forEach(r => {
      const key = String(r.branch || '').toLowerCase();
      const date = String(r.date || '').slice(0, 10);
      if (!key || !date) return;
      if (!lastDate[key] || date > lastDate[key]) lastDate[key] = date;
    });

    const out = {};
    Object.entries(lastDate).forEach(([key, date]) => { out[key] = { date, items: {} }; });
    (rows || []).forEach(r => {
      const key = String(r.branch || '').toLowerCase();
      const slot = out[key];
      if (!slot || String(r.date || '').slice(0, 10) !== slot.date) return;
      // ไอเทมเดียวอาจมีหลายแถวในวันเดียว (นับแยกจุดเก็บ) — รวมเป็นยอดเดียว
      const id = normalizeId(r.itemKey || r.itemCode);
      if (!id) return;
      slot.items[id] = (slot.items[id] || 0) + (Number(r.balance) || 0);
    });
    return out;
  };

  /** เก็บเฉพาะช่องที่ตาราง/การ์ดใช้ — ยอดปิดรอบรายไอเทมไม่ต้องติดไปกับ state */
  const branchStat = ({ cur, prev, ...rest }) => rest;

  /**
   * ยอดใช้จากยอดปิดรอบสิ้นเดือน = ยกมา + รับเข้า − ปิดรอบ
   *
   * ยิงแถวปิดรอบแค่สองครั้ง (รอบที่เลือก + รอบก่อนหน้า) ได้ครบทุกสาขา แล้วค่อยไล่ยิงยอดรับเข้า
   * กับจำนวนหัวทีละชุด ตามช่วงวันปิดรอบของแต่ละสาขาซึ่งไม่ตรงกัน
   */
  const fetchClosingReport = async () => {
    const targets = pickTargets();
    if (!targets) return;

    setIsFetching(true);
    setProgress(null);
    try {
      const curData = await fetchMonthEnd(closingMonth);
      const month = curData.month || closingMonth;
      if (!month) throw new Error('ยังไม่มีข้อมูลปิดรอบเดือนในระบบ');
      if (curData.months?.length) setMonthOptions(curData.months);
      if (closingMonth !== month) setClosingMonth(month);

      const prevMonth = shiftMonth(month, -1);
      const prevData = await fetchMonthEnd(prevMonth);
      const cur = groupClosing(curData.rows);
      const prev = groupClosing(prevData.rows);

      // แต่ละสาขาปิดรอบคนละวัน ช่วงที่ต้องนับยอดรับเข้า/จำนวนหัวจึงคิดทีละสาขา
      const jobs = targets.map(b => {
        const key = String(b.name).toLowerCase();
        const base = {
          name: String(b.name), key, outletId: b.outletId,
          covers: null, coversSource: '', from: '', to: '', closeDate: '', prevDate: '', error: '',
        };
        const c = cur[key];
        const p = prev[key];
        if (!c) return { ...base, ok: false, error: `ยังไม่ได้ปิดรอบ${monthLabel(month)}` };
        if (!p) return { ...base, ok: false, error: `ไม่มียอดปิดรอบ${monthLabel(prevMonth)} — ไม่มียอดยกมาให้ตั้งต้น` };
        return {
          ...base, ok: true,
          closeDate: c.date, prevDate: p.date,
          from: addDays(p.date, 1), to: c.date,   // นับต่อจากวันที่ปิดรอบก่อนหน้า ไม่นับซ้ำวันนั้น
          cur: c.items, prev: p.items,
        };
      });

      const stats = [];
      const usage = {};
      jobs.filter(j => !j.ok).forEach(j => { stats.push(branchStat(j)); usage[j.key] = {}; });

      const runnable = jobs.filter(j => j.ok);
      setProgress({ done: 0, total: runnable.length });
      for (let i = 0; i < runnable.length; i += BRANCH_BATCH) {
        const chunk = runnable.slice(i, i + BRANCH_BATCH);
        const results = await Promise.all(chunk.map(j => {
          const qs = `branch=${encodeURIComponent(j.name)}&outletId=${encodeURIComponent(j.outletId)}`
            + `&startDate=${encodeURIComponent(j.from)}&endDate=${encodeURIComponent(j.to)}`;
          return Promise.all([
            fetch(`/api/orderd?${qs}`).then(r => r.json()).catch(err => ({ status: 'error', message: err.message })),
            // ยิงเพื่อเอา meta.covers อย่างเดียว — ยอดใช้ฝั่ง BOM ไม่ได้ใช้ในฐานนี้
            fetch(`/api/usage-bom?${qs}`).then(r => r.json()).catch(err => ({ status: 'error', message: err.message })),
          ]);
        }));

        results.forEach(([recRes, coverRes], idx) => {
          const j = chunk[idx];
          const recOk = recRes.status === 'success';
          const rec = recOk ? (recRes.data || {}) : {};
          const coverOk = coverRes.status === 'success' && coverRes.meta;
          const covers = coverOk ? coverRes.meta.covers : null;

          const map = {};
          if (recOk) {
            const ids = new Set([...Object.keys(j.prev), ...Object.keys(j.cur), ...Object.keys(rec)]);
            ids.forEach(id => {
              const used = (j.prev[id] || 0) + (Number(rec[id]?.total) || 0) - (j.cur[id] || 0);
              const q = Number(used.toFixed(2));
              if (q) map[id] = q;
            });
          }
          usage[j.key] = map;
          stats.push({
            ...branchStat(j),
            // ยอดรับเข้าพลาด = คิดยอดใช้ไม่ได้เลย (ของที่รับมาจะกลายเป็นของที่ใช้ไปทั้งก้อน)
            // แต่จำนวนหัวพลาด ยังเหลือคอลัมน์ "ยอดใช้" ให้ดูได้ จึงไม่ถือว่าสาขานี้ล้ม
            ok: recOk,
            covers: covers === null || covers === undefined ? null : Number(covers),
            coversSource: coverOk ? coverRes.meta.coversSource : '',
            error: recOk ? '' : `ดึงยอดรับเข้าไม่สำเร็จ: ${recRes.message || 'ไม่ทราบสาเหตุ'}`,
          });
        });
        setProgress({ done: Math.min(i + BRANCH_BATCH, runnable.length), total: runnable.length });
      }

      stats.sort((a, b) => a.name.localeCompare(b.name));
      const windows = stats.filter(s => s.from && s.to);
      setReport({
        source: 'closing',
        month,
        prevMonth,
        // ช่วงรวมของทุกสาขาไว้โชว์บนการ์ด/ชื่อไฟล์ — ช่วงจริงของแต่ละสาขาอยู่ในป้ายสาขา
        from: windows.reduce((a, s) => (!a || s.from < a ? s.from : a), ''),
        to: windows.reduce((a, s) => (s.to > a ? s.to : a), ''),
        branches: stats,
        usage,
      });
      reportToast(stats);
    } catch (err) {
      toast.error('คิดยอดจากปิดรอบไม่สำเร็จ: ' + err.message);
    } finally {
      setIsFetching(false);
      setProgress(null);
    }
  };

  /** สาขาที่อยู่ในผลคำนวณ และยังติ๊กอยู่ — ติ๊กออกทีหลังจะซ่อนคอลัมน์และคิดค่ากลางใหม่ทันที
      โดยไม่ต้องยิงข้อมูลซ้ำ (ของที่ดึงมาแล้วยังอยู่ครบ) */
  const activeBranches = useMemo(
    () => (report?.branches || []).filter(b => selectedKeys.includes(b.key)),
    [report, selectedKeys]
  );

  /** สาขาที่ติ๊กไว้แต่ยังไม่มีข้อมูลในผลรอบนี้ — ต้องกดคำนวณใหม่ถึงจะเห็น */
  const pendingKeys = useMemo(() => {
    if (!report) return [];
    return selectedKeys.filter(k => !report.branches.some(b => b.key === k));
  }, [report, selectedKeys]);

  /** สาขาที่เอาไปคิดค่ากลางได้ = ดึงยอดใช้สำเร็จ และรู้จำนวนหัว */
  const usableBranches = useMemo(
    () => activeBranches.filter(b => b.ok && b.covers > 0),
    [activeBranches]
  );

  /** หัวใจของหน้า — 1 แถวต่อ 1 วัตถุดิบ พร้อมตัวเลขรายสาขาที่คิดต่อหัวแล้ว */
  const rows = useMemo(() => {
    if (!report) return [];
    const cols = activeBranches;

    return items.map(item => {
      const id = normalizeId(item.productId);
      let totalUsage = 0;         // ยอดใช้รวมทุกสาขาที่ดึงได้
      let usableUsage = 0;        // เฉพาะสาขาที่เข้าเกณฑ์ค่ากลาง
      let usableCovers = 0;
      const cells = cols.map(b => {
        const qty = b.ok ? (report.usage[b.key]?.[id] || 0) : null;
        if (qty) totalUsage += qty;
        // นับเข้าค่ากลางเฉพาะสาขาที่ "ใช้ของตัวนี้จริง" — สาขาที่ไม่ได้สต๊อกไอเทมนี้เลย
        // ถ้าเอาจำนวนหัวไปรวมในตัวหารด้วย ค่ากลางจะถูกเจือจางจนสาขาที่ใช้จริงขึ้นแดงกันหมด
        // ฐานปิดรอบอาจได้ยอดติดลบ (นับได้มากกว่ายกมา+รับเข้า = จดพลาด/ของมาไม่ทันบันทึก)
        // เอาไปคิดค่ากลางไม่ได้ ตัดทิ้งเหมือนสาขาที่ไม่ได้ใช้ไอเทมนี้
        if (b.covers > 0 && qty > 0) { usableUsage += qty; usableCovers += b.covers; }
        return { branch: b, usage: qty, perHead: b.covers > 0 && qty !== null ? qty / b.covers : null };
      });

      // ค่ากลาง = ยอดใช้รวม ÷ จำนวนหัวรวม (ถ่วงน้ำหนักตามขนาดสาขา)
      // ไม่ใช่ค่าเฉลี่ยของ "ต่อหัวรายสาขา" ซึ่งสาขาเล็กจะมีน้ำหนักเท่าสาขาใหญ่ทั้งที่ขายต่างกันหลายเท่า
      const mean = usableCovers > 0 ? usableUsage / usableCovers : null;
      cells.forEach(c => {
        c.diffPct = mean && c.perHead !== null ? (c.perHead - mean) / mean * 100 : null;
      });
      const overCount = cells.filter(c => c.diffPct !== null && c.diffPct > DEVIATION_PCT).length;

      return { item, id, cells, totalUsage, mean, overCount };
    });
  }, [items, report, activeBranches]);

  const visibleRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    let result = rows.filter(r => {
      if (onlyUsed && !r.totalUsage) return false;
      if (!term) return true;
      return String(r.item.productId || '').toLowerCase().includes(term)
        || String(r.item.name || '').toLowerCase().includes(term)
        || String(r.item.storageCat || '').toLowerCase().includes(term);
    });

    result.sort((a, b) => {
      if (sortBy === 'usage') return b.totalUsage - a.totalUsage;
      if (sortBy === 'deviation') return b.overCount - a.overCount || b.totalUsage - a.totalUsage;
      if (sortBy === 'productId') return String(a.item.productId || '').localeCompare(String(b.item.productId || ''));
      if (sortBy === 'name') return String(a.item.name || '').localeCompare(String(b.item.name || ''), 'th');
      return String(a.item.storageCat || '').localeCompare(String(b.item.storageCat || ''), 'th')
        || String(a.item.productId || '').localeCompare(String(b.item.productId || ''));
    });
    return result;
  }, [rows, searchTerm, sortBy, onlyUsed]);

  /** ทุก "จุด" ที่ใช้เกินค่ากลาง — 1 จุด = 1 ไอเทมของ 1 สาขา เรียงจากเกินมากสุด
      แยกออกมาจาก summary เพราะการ์ดใช้แค่จำนวน ส่วนหน้าต่างรายละเอียดใช้ทั้งรายการ */
  const hotSpots = useMemo(() => {
    const out = [];
    rows.forEach(r => {
      r.cells.forEach(c => {
        if (c.diffPct === null || c.diffPct <= DEVIATION_PCT) return;
        out.push({
          row: r, branch: c.branch, perHead: c.perHead, usage: c.usage,
          mean: r.mean, diffPct: c.diffPct,
          // ใช้เกินค่ากลางไปกี่หน่วยในช่วงนี้ = (ต่อหัวที่ใช้จริง - ค่ากลาง) x จำนวนหัวของสาขานั้น
          // เป็นตัวเรียงที่ตรงกับ "เสียหายจริง" มากกว่า % เพราะของที่ใช้น้อยมาก ๆ เกิน 300% ก็ยังไม่กี่กรัม
          excessQty: (c.perHead - r.mean) * c.branch.covers,
        });
      });
    });
    return out.sort((a, b) => b.excessQty - a.excessQty);
  }, [rows]);

  const summary = useMemo(() => {
    if (!report) return null;
    const okCount = activeBranches.filter(b => b.ok).length;
    return {
      okCount,
      total: activeBranches.length,
      covers: usableBranches.reduce((s, b) => s + b.covers, 0),
      usedItems: rows.filter(r => r.totalUsage > 0).length,
      hotSpots: hotSpots.length,
    };
  }, [report, rows, usableBranches, activeBranches, hotSpots]);

  /** ค่าตั้งเบิกของทุกสาขา — ทะเบียนเดียวกับคอลัมน์ "ค่าเฉลี่ย" ของหน้านับสต๊อก
      getStockItems ของสาขาไหนก็คืน calcBranches ของ "ทุกสาขา" มาให้ จึงยิงสาขาเดียวพอ */
  const ensureSettings = async () => {
    if (settings || loadingSettings) return;
    const first = branches.find(b => b.outletId) || branches[0];
    if (!first) return;
    setLoadingSettings(true);
    try {
      const res = await apiRead('getStockItems', { branch: first.name });
      const map = {};
      (res.data || []).forEach(it => { map[normalizeId(it.productId)] = it.calcBranches || []; });
      setSettings(map);
    } catch {
      setSettings({});   // อ่านไม่ได้ก็ไม่เป็นไร — คอลัมน์ "ค่าที่ตั้งไว้" จะขึ้นขีด
    } finally {
      setLoadingSettings(false);
    }
  };

  const openDetail = (row) => {
    setDetailItem(row);
    ensureSettings();
  };

  /** สาขาที่เลือกได้จริง = ต้องมี outletId ไม่งั้นยิงยอดขายไม่ได้ */
  const selectableBranches = useMemo(() => branches.filter(b => b.outletId), [branches]);

  const toggleBranch = (key) => {
    setSelectedKeys(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  // ── Export Excel: แถว = ไอเทม · สาขาละ 2 คอลัมน์ (ยอดใช้ / ต่อหัว) ──
  const exportExcel = () => {
    if (!report || visibleRows.length === 0) { toast.error('ไม่มีรายการให้ export'); return; }
    const cols = activeBranches;
    const isClosing = report.source === 'closing';
    const h1 = ['รหัส', 'ชื่อสินค้า', 'หมวดจัดเก็บ', 'หน่วย',
      isClosing ? 'ยอดใช้รวม (ปิดรอบ)' : 'ยอดใช้รวม (BOM)', 'ต่อหัว (ค่ากลาง)'];
    const h2 = ['', '', '', '', '', ''];
    cols.forEach(b => {
      h1.push(`${b.name.toUpperCase()} (${b.covers ? fmtInt(b.covers) : '-'} หัว)`, '');
      h2.push('ยอดใช้', 'ต่อหัว');
    });
    const aoa = [h1, h2];
    visibleRows.forEach(r => {
      const line = [
        String(r.item.productId), r.item.name, r.item.storageCat || '', r.item.unit || '',
        Number(r.totalUsage.toFixed(2)), r.mean === null ? '' : Number(r.mean.toFixed(6)),
      ];
      r.cells.forEach(c => {
        line.push(c.usage === null ? '' : Number(c.usage.toFixed(2)));
        line.push(c.perHead === null ? '' : Number(c.perHead.toFixed(6)));
      });
      aoa.push(line);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = cols.map((_, i) => ({ s: { r: 0, c: 6 + i * 2 }, e: { r: 0, c: 7 + i * 2 } }));
    ws['!cols'] = [{ wch: 12 }, { wch: 42 }, { wch: 16 }, { wch: 8 }, { wch: 12 }, { wch: 14 },
      ...cols.flatMap(() => [{ wch: 11 }, { wch: 11 }])];
    const header = {
      font: { name: 'Tahoma', sz: 10, bold: true, color: { rgb: 'FFFFFF' } },
      fill: { patternType: 'solid', fgColor: { rgb: '7E22CE' } },
      alignment: { vertical: 'center', horizontal: 'center', wrapText: true },
    };
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = 0; r <= 1; r++) {
      for (let c = 0; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell) cell.s = header;
      }
    }
    // ต่อหัวเป็นเลขหลักหมื่นส่วน ถ้าไม่ตั้ง format Excel จะตัดเหลือ 2 ตำแหน่งแล้วดูเหมือน 0.00 ทั้งคอลัมน์
    for (let r = 2; r <= range.e.r; r++) {
      for (let c = 4; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        const isPerHead = c === 5 || (c >= 6 && (c - 6) % 2 === 1);
        cell.z = isPerHead ? '0.0000' : '0.00';
      }
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ใช้ต่อหัวรายสาขา');
    XLSX.writeFile(wb, isClosing
      ? `usage_per_head_closing_${report.month}.xlsx`
      : `usage_per_head_${report.from}_${report.to}.xlsx`);
    toast.success('Export สำเร็จ');
  };

  const cellTone = (diffPct) => {
    if (diffPct === null) return { text: 'text-gray-300', pill: '' };
    if (diffPct > DEVIATION_PCT) return { text: 'text-red-600', pill: 'bg-red-100 text-red-700' };
    if (diffPct < -DEVIATION_PCT) return { text: 'text-cyan-700', pill: 'bg-cyan-100 text-cyan-700' };
    return { text: 'text-slate-700', pill: 'bg-slate-100 text-slate-500' };
  };

  const showUsage = viewMode !== 'perHead';
  const showPerHead = viewMode !== 'usage';
  const colSpanPerBranch = (showUsage ? 1 : 0) + (showPerHead ? 1 : 0);

  return (
    <div className="max-w-full mx-auto pb-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-3">
          <div className="p-2 bg-fuchsia-100 text-fuchsia-600 rounded-xl">
            <BarChart3 className="w-6 h-6" />
          </div>
          รายงานการใช้วัตถุดิบต่อหัว ของสาขา
        </h1>
        <p className="text-gray-500 mt-1 ml-11 text-sm">
          {usageSource === 'closing'
            ? 'ยอดใช้ = ยกมา (ปิดรอบเดือนก่อน) + รับเข้า − ปิดรอบเดือนนี้ = ของที่หายไปจากสต๊อกจริง · ต่อหัว = ยอดใช้ ÷ จำนวนหัวลูกค้าในช่วงเดียวกัน'
            : 'ยอดใช้ = ยอดขายจริง × สูตร BOM (ชุดเดียวกับ “ยอดใช้จากระบบ”) · ต่อหัว = ยอดใช้ ÷ จำนวนหัวลูกค้าของสาขานั้นในช่วงที่เลือก'}
        </p>
      </div>

      {/* แถบเครื่องมือ — แถวบน: ฐานที่ใช้คิด / มุมมอง / สาขา / ช่วงเวลา / export */}
      <div className="flex flex-col xl:flex-row xl:flex-wrap gap-3 mb-3">
        {/* ฐานที่ใช้คิดยอดใช้ — คนละที่มา จึงล้างผลเดิมทุกครั้งที่สลับ */}
        <div className="flex shrink-0 bg-white border border-gray-200 rounded-xl overflow-hidden text-sm">
          {[['bom', 'ยอดใช้จาก BOM', 'ยอดขายจริง × สูตร BOM — ของที่ “ควรใช้ตามสูตร”'],
            ['closing', 'ยอดจากปิดรอบ (Endding)', 'ยกมา + รับเข้า − ปิดรอบสิ้นเดือน — ของที่ “หายไปจากสต๊อกจริง”']].map(([v, label, hint]) => (
            <button key={v} onClick={() => switchSource(v)} title={hint}
              className={`px-3 py-3 whitespace-nowrap transition-colors ${usageSource === v ? 'bg-indigo-600 text-white font-semibold' : 'text-gray-600 hover:bg-gray-50'}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="flex shrink-0 bg-white border border-gray-200 rounded-xl overflow-hidden text-sm">
          {[['both', 'ต่อหัว + ยอดใช้'], ['perHead', 'ต่อหัวอย่างเดียว'], ['usage', 'ยอดใช้อย่างเดียว']].map(([v, label]) => (
            <button key={v} onClick={() => setViewMode(v)}
              className={`px-3 py-3 whitespace-nowrap transition-colors ${viewMode === v ? 'bg-fuchsia-600 text-white font-semibold' : 'text-gray-600 hover:bg-gray-50'}`}>
              {label}
            </button>
          ))}
        </div>

        {/* เลือกสาขาที่จะเทียบ — ติ๊กได้หลายสาขา มีผลทั้งตอนดึงข้อมูลและตอนคิดค่ากลาง */}
        <div className="relative shrink-0">
          <button onClick={() => setBranchPickerOpen(o => !o)}
            className={`h-full w-full xl:w-auto px-3 py-3 border rounded-xl bg-white text-sm flex items-center gap-2 whitespace-nowrap transition-colors ${
              branchPickerOpen ? 'border-fuchsia-400 ring-1 ring-fuchsia-300' : 'border-gray-200 hover:border-fuchsia-300'}`}>
            <Store className="w-4 h-4 text-fuchsia-500" />
            <span className="text-gray-700">
              สาขาที่เทียบ :{' '}
              <b className="text-fuchsia-700">
                {selectedKeys.length === selectableBranches.length ? `ทุกสาขา (${selectedKeys.length})` : `${selectedKeys.length} สาขา`}
              </b>
            </span>
            <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${branchPickerOpen ? 'rotate-180' : ''}`} />
          </button>

          {branchPickerOpen && (
            <>
              {/* ฉากหลังใส ๆ ไว้กดปิด — ไม่งั้นต้องกดปุ่มเดิมซ้ำถึงจะปิดได้ */}
              <div className="fixed inset-0 z-30" onClick={() => setBranchPickerOpen(false)} />
              <div className="absolute z-40 mt-2 w-72 bg-white border border-fuchsia-100 rounded-xl shadow-xl overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-fuchsia-50/70 border-b border-fuchsia-100">
                  <span className="text-[11px] font-semibold text-fuchsia-800">เลือกสาขาที่จะเทียบกัน</span>
                  <div className="flex gap-1.5 text-[11px]">
                    <button onClick={() => setSelectedKeys(selectableBranches.map(b => String(b.name).toLowerCase()))}
                      className="px-2 py-0.5 rounded bg-fuchsia-600 text-white hover:bg-fuchsia-700">ทั้งหมด</button>
                    <button onClick={() => setSelectedKeys([])}
                      className="px-2 py-0.5 rounded bg-white border border-gray-200 text-gray-600 hover:bg-gray-50">ล้าง</button>
                  </div>
                </div>
                <div className="max-h-72 overflow-y-auto p-1">
                  {selectableBranches.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-gray-400">ยังไม่มีสาขาที่มีรหัส outlet</div>
                  ) : selectableBranches.map(b => {
                    const key = String(b.name).toLowerCase();
                    const checked = selectedKeys.includes(key);
                    const fetched = report?.branches.some(x => x.key === key);
                    return (
                      <label key={key}
                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer text-sm ${checked ? 'bg-fuchsia-50/60' : 'hover:bg-gray-50'}`}>
                        <input type="checkbox" checked={checked} onChange={() => toggleBranch(key)}
                          className="rounded border-gray-300 text-fuchsia-600 focus:ring-fuchsia-500" />
                        <span className={`font-mono font-semibold ${checked ? 'text-fuchsia-800' : 'text-gray-600'}`}>
                          {String(b.name).toUpperCase()}
                        </span>
                        {report && checked && !fetched && (
                          <span className="ml-auto text-[9.5px] text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-1.5">ยังไม่ได้ดึง</span>
                        )}
                      </label>
                    );
                  })}
                </div>
                <div className="px-3 py-2 bg-gray-50 border-t border-gray-100 text-[10.5px] text-gray-400 leading-relaxed">
                  ติ๊กออกหลังคำนวณแล้ว = ซ่อนคอลัมน์และคิดค่ากลางใหม่ทันที ไม่ต้องดึงซ้ำ ·
                  ติ๊กสาขาที่ยังไม่เคยดึงเข้ามา ต้องกด “คำนวณรายงาน” อีกครั้ง
                </div>
              </div>
            </>
          )}
        </div>

        {usageSource === 'closing' ? (
          /* ฐานปิดรอบไม่ได้เลือกวันเอง — ช่วงของแต่ละสาขามาจากวันที่สาขานั้นปิดรอบจริง */
          <div className="flex shrink-0 items-center gap-2 bg-gradient-to-r from-indigo-50 to-sky-50 border border-indigo-100 p-2 rounded-xl">
            <Calendar className="w-4 h-4 text-indigo-500 ml-1" />
            <span className="text-sm font-medium text-gray-700 whitespace-nowrap">รอบเดือน :</span>
            <select value={closingMonth} onChange={e => setClosingMonth(e.target.value)} disabled={loadingMonths}
              className="px-2 py-1.5 border border-gray-200 rounded-lg bg-white text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60">
              {loadingMonths && <option value="">กำลังโหลดรอบเดือน…</option>}
              {!loadingMonths && monthOptions.length === 0 && (
                <option value={closingMonth}>{closingMonth ? monthLabel(closingMonth) : 'รอบล่าสุดที่มีข้อมูล'}</option>
              )}
              {monthOptions.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
            <button onClick={fetchReport} disabled={isFetching || loading || loadingMonths}
              className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2 transition-colors whitespace-nowrap">
              {isFetching
                ? <><Loader2 className="w-4 h-4 animate-spin" />{progress ? `${progress.done}/${progress.total} สาขา` : 'กำลังคำนวณ'}</>
                : 'คำนวณรายงาน'}
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2 bg-gradient-to-r from-fuchsia-50 to-pink-50 border border-fuchsia-100 p-2 rounded-xl">
            <span className="text-sm font-medium text-gray-700 ml-2 whitespace-nowrap">วันที่ :</span>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-fuchsia-500" />
            <span className="text-gray-500 text-sm">-</span>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-fuchsia-500" />
            <button onClick={fetchReport} disabled={isFetching || loading}
              className="px-4 py-1.5 bg-fuchsia-600 text-white text-sm rounded-lg hover:bg-fuchsia-700 disabled:opacity-50 flex items-center gap-2 transition-colors whitespace-nowrap">
              {isFetching
                ? <><Loader2 className="w-4 h-4 animate-spin" />{progress ? `${progress.done}/${progress.total} สาขา` : 'กำลังคำนวณ'}</>
                : 'คำนวณรายงาน'}
            </button>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2 bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-100 p-2 rounded-xl">
          <button onClick={exportExcel} disabled={!report || visibleRows.length === 0}
            className="px-4 py-1.5 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2 transition-colors whitespace-nowrap">
            <Download className="w-4 h-4" /> Export Excel
          </button>
        </div>
      </div>

      {/* แถวล่าง: ค้นหา + การเรียง — แยกมาอีกบรรทัดให้ช่องค้นหากว้างพอพิมพ์ชื่อไอเทมยาว ๆ */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1 min-w-0">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search className="h-5 w-5 text-gray-400" />
          </div>
          <input type="text"
            className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl bg-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-fuchsia-500 focus:border-fuchsia-500 sm:text-sm"
            placeholder="ค้นหาด้วยรหัส / ชื่อสินค้า / หมวดจัดเก็บ..."
            value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
        </div>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          className="border border-gray-200 rounded-xl px-3 py-3 bg-white text-sm focus:outline-none focus:ring-1 focus:ring-fuchsia-500 text-gray-700 sm:w-auto">
          <option value="usage">เรียงตามยอดใช้รวม (มาก→น้อย)</option>
          <option value="deviation">เรียงตามจำนวนสาขาที่ใช้เกินค่ากลาง</option>
          <option value="storageCat">เรียงตามหมวดจัดเก็บ</option>
          <option value="productId">เรียงตามรหัสสินค้า</option>
          <option value="name">เรียงตามชื่อสินค้า</option>
        </select>
      </div>

      {/* ติ๊กสาขาเพิ่มหลังคำนวณไปแล้ว — บอกให้ชัดว่าคอลัมน์ยังไม่โผล่เพราะยังไม่ได้ดึง ไม่ใช่เพราะไม่มีข้อมูล */}
      {report && pendingKeys.length > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>
            ติ๊กเพิ่มไว้ {pendingKeys.length} สาขา ({pendingKeys.map(k => k.toUpperCase()).join(', ')}) แต่ยังไม่ได้ดึงข้อมูลของรอบนี้
          </span>
          <button onClick={fetchReport} disabled={isFetching}
            className="ml-auto px-3 py-1 rounded-lg bg-amber-600 text-white text-[11px] font-semibold hover:bg-amber-700 disabled:opacity-50 whitespace-nowrap">
            คำนวณรายงานใหม่
          </button>
        </div>
      )}

      {/* การ์ดสรุป + จำนวนหัวรายสาขา */}
      {summary && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            <div className="bg-white border border-fuchsia-100 rounded-2xl p-3">
              <div className="text-[11px] text-gray-500 flex items-center gap-1.5"><Package className="w-3.5 h-3.5" /> สาขาที่ดึงข้อมูลได้</div>
              <div className="text-xl font-bold text-fuchsia-600 mt-1">{summary.okCount} / {summary.total}</div>
              <div className="text-[10px] text-gray-400 mt-0.5">
                {report.source === 'closing' ? `รอบ${monthLabel(report.month)} · ` : ''}{report.from} ถึง {report.to}
              </div>
            </div>
            <div className="bg-white border border-purple-100 rounded-2xl p-3">
              <div className="text-[11px] text-gray-500 flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> จำนวนหัวลูกค้ารวม</div>
              <div className="text-xl font-bold text-purple-700 mt-1">{fmtInt(summary.covers)}</div>
              <div className="text-[10px] text-gray-400 mt-0.5">เฉพาะสาขาที่นับหัวได้ ({usableBranches.length} สาขา)</div>
            </div>
            <div className="bg-white border border-blue-100 rounded-2xl p-3">
              <div className="text-[11px] text-gray-500 flex items-center gap-1.5"><Package className="w-3.5 h-3.5" /> วัตถุดิบที่มีการใช้</div>
              <div className="text-xl font-bold text-blue-700 mt-1">{fmtInt(summary.usedItems)}</div>
              <div className="text-[10px] text-gray-400 mt-0.5">จากทั้งหมด {fmtInt(items.length)} รายการ</div>
            </div>
            {/* การ์ดเดียวในแถวที่กดได้ — เป็นตัวเลขที่คนดูอยากรู้ต่อเสมอว่า "จุดไหนบ้าง"
                ทำเป็นปุ่มจริง ๆ (ไม่ใช่ div ที่ผูก onClick) จะได้กด Tab/Enter ได้ด้วย */}
            <button
              type="button"
              onClick={() => summary.hotSpots > 0 && setShowHotSpots(true)}
              disabled={summary.hotSpots === 0}
              title={summary.hotSpots > 0 ? 'คลิกเพื่อดูว่าเป็นไอเทมไหนของสาขาไหนบ้าง' : 'ไม่มีจุดไหนเกินเกณฑ์'}
              className={`text-left bg-white border border-red-100 rounded-2xl p-3 transition-colors ${
                summary.hotSpots > 0
                  ? 'cursor-pointer hover:border-red-300 hover:bg-red-50/40 focus:outline-none focus:ring-2 focus:ring-red-300'
                  : 'cursor-default'}`}
            >
              <div className="text-[11px] text-gray-500 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> จุดที่ใช้เกินค่ากลาง &gt;{DEVIATION_PCT}%</div>
              <div className="text-xl font-bold text-red-600 mt-1">{fmtInt(summary.hotSpots)} จุด</div>
              <div className="text-[10px] text-gray-400 mt-0.5">
                {summary.hotSpots > 0
                  ? <span className="text-red-500 font-medium">คลิกดูรายละเอียด →</span>
                  : '1 จุด = 1 ไอเทมของ 1 สาขา'}
              </div>
            </button>
          </div>

          <div className="bg-white border border-fuchsia-100 rounded-2xl px-3 py-2.5 mb-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-gray-500 mr-1">จำนวนหัวลูกค้าที่ใช้หาร :</span>
            {activeBranches.map(b => (
              <span key={b.key}
                title={(b.ok
                  ? (b.covers ? `นับจาก${b.coversSource === 'coverAll' ? ' Cover All ของบิล' : 'จานบุฟเฟต์ที่จ่ายจริง'}` : 'ดึงยอดใช้ได้ แต่ไม่มีจำนวนหัว — คิดต่อหัวไม่ได้')
                  : b.error) + (b.from ? ` · ช่วง ${b.from} ถึง ${b.to}` : '')}
                className={`rounded-full px-2.5 py-0.5 text-[11px] border ${
                  !b.ok ? 'border-red-200 bg-red-50 text-red-700'
                    : b.covers ? 'border-purple-200 bg-purple-50 text-purple-700'
                    : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                {b.name.toUpperCase()}{' '}
                <b>{!b.ok ? 'ดึงไม่ได้' : b.covers ? fmtInt(b.covers) : 'ไม่มีหัว'}</b>
                {b.ok && b.covers ? ' หัว' : ''}
              </span>
            ))}
          </div>

          {report.source === 'closing' && (
            <div className="mb-3 flex items-start gap-2 rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-[11px] text-indigo-800 leading-relaxed">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>
                ยอดใช้รอบ{monthLabel(report.month)} = <b>ยกมา (ปิดรอบ{monthLabel(report.prevMonth)}) + รับเข้า − ปิดรอบ{monthLabel(report.month)}</b> ·
                แต่ละสาขาใช้ช่วงวันของตัวเอง (วันถัดจากวันที่ปิดรอบก่อนหน้า ถึงวันที่ปิดรอบของรอบนี้) ทั้งยอดรับเข้าและจำนวนหัว —
                ชี้ที่ชื่อสาขาเพื่อดูช่วงวันของสาขานั้น ·
                ยอดติดลบ = นับได้มากกว่ายกมา+รับเข้า (จดพลาด หรือของมาไม่ทันบันทึก) จะไม่ถูกนำไปคิดค่ากลาง
              </span>
            </div>
          )}
        </>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-fuchsia-100 overflow-hidden">
        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center text-fuchsia-600">
            <Loader2 className="w-10 h-10 animate-spin mb-4" />
            <p className="font-medium text-sm">กำลังโหลดทะเบียนสินค้าและสาขา...</p>
          </div>
        ) : !report ? (
          <div className="py-20 text-center text-gray-400">
            <BarChart3 className="w-10 h-10 mx-auto mb-3 text-gray-300" />
            <p className="text-sm">
              เลือกสาขาที่จะเทียบ {usageSource === 'closing' ? 'เลือกรอบเดือน' : 'ตั้งช่วงวันที่'} แล้วกด “คำนวณรายงาน”
            </p>
            <p className="text-xs mt-1 text-gray-400">ยิงทีละ {BRANCH_BATCH} สาขา · เลือกสาขาน้อยลงจะเร็วขึ้นตามจำนวนที่เลือก</p>
          </div>
        ) : activeBranches.length === 0 ? (
          <div className="py-20 text-center text-gray-400">
            <Store className="w-10 h-10 mx-auto mb-3 text-gray-300" />
            <p className="text-sm">ยังไม่ได้เลือกสาขาที่จะเทียบ</p>
            <p className="text-xs mt-1">กดปุ่ม “สาขาที่เทียบ” ด้านบนแล้วติ๊กอย่างน้อย 1 สาขา</p>
          </div>
        ) : (
          <>
            <div className="px-3 py-2 bg-fuchsia-50/60 border-b border-fuchsia-100 text-[11px] text-fuchsia-700 flex items-center justify-between gap-3 flex-wrap">
              <span>↔ เลื่อนตารางไปทางขวาเพื่อดูสาขาที่เหลือ ({activeBranches.length} สาขา) · คลิกที่ชื่อสินค้าเพื่อเทียบทุกสาขาแบบเต็ม</span>
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input type="checkbox" checked={onlyUsed} onChange={e => setOnlyUsed(e.target.checked)}
                  className="rounded border-fuchsia-300 text-fuchsia-600 focus:ring-fuchsia-500" />
                แสดงเฉพาะไอเทมที่มีการใช้
              </label>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50/50">
                  <tr>
                    <th rowSpan={2} className="px-3 py-2 text-left text-[10px] font-semibold text-gray-500 uppercase whitespace-nowrap">รหัส</th>
                    <th rowSpan={2} className="px-3 py-2 text-left text-[10px] font-semibold text-gray-500 uppercase">ชื่อสินค้า</th>
                    <th rowSpan={2} className="px-3 py-2 text-left text-[10px] font-semibold text-gray-500 uppercase">หน่วย</th>
                    <th colSpan={2} className="px-3 py-2 text-center text-[10px] font-semibold text-blue-700 uppercase bg-blue-50/60 whitespace-nowrap">รวมทุกสาขา</th>
                    {activeBranches.map(b => (
                      <th key={b.key} colSpan={colSpanPerBranch}
                        className="px-3 py-2 text-center text-[10px] font-semibold text-purple-700 uppercase bg-purple-50/50 border-l-2 border-purple-100 whitespace-nowrap">
                        {b.name.toUpperCase()}
                        <div className="font-normal text-[9px] text-purple-400 normal-case">
                          {b.ok ? (b.covers ? `${fmtInt(b.covers)} หัว` : 'ไม่มีจำนวนหัว') : 'ดึงไม่ได้'}
                        </div>
                      </th>
                    ))}
                  </tr>
                  <tr>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-blue-700 uppercase bg-blue-50/60 whitespace-nowrap">ยอดใช้</th>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-violet-700 uppercase bg-violet-50/60 whitespace-nowrap">ต่อหัว (ค่ากลาง)</th>
                    {activeBranches.map(b => (
                      <React.Fragment key={b.key}>
                        {showUsage && <th className="px-3 py-2 text-center text-[10px] font-semibold text-purple-600 uppercase bg-purple-50/40 border-l-2 border-purple-100 whitespace-nowrap">ยอดใช้</th>}
                        {showPerHead && <th className={`px-3 py-2 text-center text-[10px] font-semibold text-purple-600 uppercase bg-purple-50/40 whitespace-nowrap ${showUsage ? '' : 'border-l-2 border-purple-100'}`}>ต่อหัว</th>}
                      </React.Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-100">
                  {visibleRows.length === 0 ? (
                    <tr>
                      <td colSpan={5 + activeBranches.length * colSpanPerBranch} className="px-6 py-12 text-center text-gray-400">
                        <AlertCircle className="w-8 h-8 mx-auto mb-2" />
                        ไม่พบรายการสินค้าที่ตรงเงื่อนไข
                      </td>
                    </tr>
                  ) : visibleRows.map(r => (
                    <tr key={r.item.productId} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-3 py-2 whitespace-nowrap text-[11px] font-mono text-gray-600">{r.item.productId}</td>
                      <td className="px-3 py-2 text-sm text-gray-800 font-medium cursor-pointer hover:text-fuchsia-700 hover:underline"
                        onClick={() => openDetail(r)} title="คลิกเพื่อเทียบทุกสาขา">
                        {r.item.name}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-[11px] text-gray-500">{r.item.unit}</td>
                      <td className="px-3 py-2 text-center text-sm font-bold text-blue-700 bg-blue-50/40 whitespace-nowrap">
                        {r.totalUsage ? fmtUsage(r.totalUsage) : '-'}
                      </td>
                      <td className="px-3 py-2 text-center text-sm font-bold text-violet-700 bg-violet-50/40 whitespace-nowrap">
                        {r.mean ? fmtPerHead(r.mean) : '-'}
                      </td>
                      {r.cells.map((c, i) => {
                        const tone = cellTone(c.diffPct);
                        return (
                          <React.Fragment key={i}>
                            {showUsage && (
                              <td className={`px-3 py-2 text-center text-[12px] border-l-2 border-purple-100 whitespace-nowrap ${
                                c.usage < 0 ? 'text-amber-600 font-semibold' : 'text-slate-600'}`}
                                title={c.usage < 0 ? 'ยอดติดลบ = นับได้มากกว่ายกมา + รับเข้า (จดพลาด หรือของมาไม่ทันบันทึก)' : undefined}>
                                {c.usage === null ? <span className="text-gray-300">-</span> : c.usage ? fmtUsage(c.usage) : '0'}
                              </td>
                            )}
                            {showPerHead && (
                              <td className={`px-3 py-2 text-center whitespace-nowrap ${showUsage ? '' : 'border-l-2 border-purple-100'}`}>
                                {c.perHead === null ? <span className="text-gray-300 text-sm">-</span>
                                  : c.usage < 0 ? <span className="text-amber-500 text-sm" title="ยอดติดลบ — ไม่นำไปคิดค่ากลาง">ติดลบ</span>
                                  : !c.usage ? <span className="text-gray-300 text-sm" title="ช่วงนี้สาขานี้ไม่ได้ใช้ไอเทมนี้เลย — ไม่นำไปคิดค่ากลาง">0</span> : (
                                  <>
                                    <div className={`text-[12px] font-bold ${tone.text}`}>{fmtPerHead(c.perHead)}</div>
                                    {c.diffPct !== null && (
                                      <span className={`inline-block mt-0.5 px-1.5 rounded-full text-[9px] font-semibold ${tone.pill}`}>
                                        {c.diffPct > 0 ? '+' : ''}{c.diffPct.toFixed(1)}%
                                      </span>
                                    )}
                                  </>
                                )}
                              </td>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-3 py-2.5 border-t border-gray-100 bg-gray-50/50 flex flex-wrap items-center gap-4 text-[11px] text-gray-500">
              <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded bg-red-100 inline-block" /> ใช้ต่อหัวสูงกว่าค่ากลาง &gt; {DEVIATION_PCT}%</span>
              <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded bg-cyan-100 inline-block" /> ต่ำกว่าค่ากลาง &gt; {DEVIATION_PCT}%</span>
              <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded bg-slate-100 inline-block" /> ใกล้เคียงค่ากลาง</span>
              <span className="ml-auto">
                {report.source === 'closing' ? 'ยอดใช้ = ยกมา + รับเข้า − ปิดรอบ · ' : 'ยอดใช้ = ยอดขายจริง × สูตร BOM · '}
                ค่ากลาง = ยอดใช้รวม ÷ จำนวนหัวรวม ของสาขาที่ใช้ไอเทมนั้น (ถ่วงน้ำหนักตามขนาดสาขา)
              </span>
            </div>
          </>
        )}
      </div>

      {showHotSpots && (
        <HotSpotModal
          spots={hotSpots}
          report={report}
          deviationPct={DEVIATION_PCT}
          onPick={(spot) => { setShowHotSpots(false); openDetail(spot.row); }}
          onClose={() => setShowHotSpots(false)}
        />
      )}

      {detailItem && (
        <DetailModal
          row={detailItem}
          report={report}
          settings={settings}
          loadingSettings={loadingSettings}
          onClose={() => setDetailItem(null)}
        />
      )}
    </div>
  );
}

/**
 * หน้าต่าง "จุดที่ใช้เกินค่ากลาง" — ไล่ทีละจุด (1 จุด = 1 ไอเทมของ 1 สาขา)
 *
 * เรียงตาม "เกินไปกี่หน่วย" ไม่ใช่ % เพราะของที่ใช้น้อยมากเกิน 300% ก็ยังไม่กี่กรัม
 * ส่วนของที่ใช้เยอะเกินแค่ 20% อาจเป็นเงินหลักหมื่น — เรียงด้วย % จะดันตัวที่ไม่สำคัญขึ้นหัวตาราง
 *
 * กรองตามสาขาได้ เพราะคำถามที่ตามมาเสมอคือ "แล้วสาขานี้มีปัญหากี่ตัว"
 * กดที่แถว = เปิดหน้าต่างเทียบทุกสาขาของไอเทมนั้นต่อ (ตัวเดียวกับที่กดจากชื่อสินค้าในตาราง)
 */
function HotSpotModal({ spots, report, deviationPct, onPick, onClose }) {
  const [branchFilter, setBranchFilter] = useState('');

  // สาขาไหนมีจุดเกินกี่จุด — เรียงจากมากไปน้อย ใช้เป็นทั้งสรุปและปุ่มกรอง
  const byBranch = useMemo(() => {
    const m = new Map();
    spots.forEach(sp => {
      const k = sp.branch.key;
      const cur = m.get(k) || { key: k, name: sp.branch.name, count: 0 };
      cur.count += 1;
      m.set(k, cur);
    });
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [spots]);

  const shown = useMemo(
    () => (branchFilter ? spots.filter(sp => sp.branch.key === branchFilter) : spots),
    [spots, branchFilter]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl overflow-hidden animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-red-100 bg-red-50/50">
          <h3 className="font-bold text-red-900 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            จุดที่ใช้เกินค่ากลาง &gt;{deviationPct}%
            <span className="font-normal text-[11px] text-red-500">
              {fmtInt(spots.length)} จุด · {report?.from} ถึง {report?.to}
            </span>
          </h3>
          <button onClick={onClose} className="text-red-400 hover:text-red-700 font-bold text-xl leading-none">&times;</button>
        </div>

        <div className="p-4 max-h-[72vh] overflow-y-auto">
          {/* กรองตามสาขา — ตัวเลขข้างชื่อคือจำนวนจุดของสาขานั้น */}
          <div className="flex flex-wrap items-center gap-1.5 mb-3">
            <span className="text-[11px] font-semibold text-gray-500 mr-1">สาขา :</span>
            <button
              onClick={() => setBranchFilter('')}
              className={`rounded-full px-2.5 py-0.5 text-[11px] border transition-colors ${
                !branchFilter ? 'border-red-300 bg-red-100 text-red-800 font-semibold'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-red-200'}`}>
              ทุกสาขา <b>{fmtInt(spots.length)}</b>
            </button>
            {byBranch.map(b => (
              <button key={b.key}
                onClick={() => setBranchFilter(branchFilter === b.key ? '' : b.key)}
                className={`rounded-full px-2.5 py-0.5 text-[11px] border transition-colors ${
                  branchFilter === b.key ? 'border-red-300 bg-red-100 text-red-800 font-semibold'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-red-200'}`}>
                {b.name.toUpperCase()} <b>{fmtInt(b.count)}</b>
              </button>
            ))}
          </div>

          {shown.length === 0 ? (
            <div className="text-center py-10 text-gray-400 text-sm">ไม่มีจุดที่เกินเกณฑ์</div>
          ) : (
            <div className="overflow-x-auto border border-red-100 rounded-xl">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-red-50/70">
                    <th className="px-3 py-2 text-left text-[10px] font-bold text-red-800 uppercase whitespace-nowrap">สาขา</th>
                    <th className="px-3 py-2 text-left text-[10px] font-bold text-red-800 uppercase">วัตถุดิบ</th>
                    <th className="px-3 py-2 text-right text-[10px] font-bold text-red-800 uppercase whitespace-nowrap">ใช้ต่อหัว</th>
                    <th className="px-3 py-2 text-right text-[10px] font-bold text-red-800 uppercase whitespace-nowrap">ค่ากลาง</th>
                    <th className="px-3 py-2 text-right text-[10px] font-bold text-red-800 uppercase whitespace-nowrap">ต่างจากค่ากลาง</th>
                    <th className="px-3 py-2 text-right text-[10px] font-bold text-red-800 uppercase whitespace-nowrap"
                      title="(ใช้ต่อหัว − ค่ากลาง) × จำนวนหัวของสาขานั้น = ใช้เกินไปกี่หน่วยในช่วงนี้">เกินไป (หน่วย)</th>
                    <th className="px-3 py-2 text-right text-[10px] font-bold text-red-800 uppercase whitespace-nowrap">ยอดใช้รวม</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {shown.map((sp, i) => (
                    <tr key={`${sp.branch.key}-${sp.row.id}-${i}`}
                      className="hover:bg-red-50/40 cursor-pointer"
                      onClick={() => onPick(sp)}
                      title="คลิกเพื่อดูไอเทมนี้เทียบทุกสาขา">
                      <td className="px-3 py-2 whitespace-nowrap font-semibold text-gray-700">{sp.branch.name.toUpperCase()}</td>
                      <td className="px-3 py-2">
                        <div className="text-gray-800 hover:text-fuchsia-700 hover:underline">{sp.row.item.name}</div>
                        <div className="text-[10px] font-mono text-gray-400">
                          {sp.row.item.productId}{sp.row.item.unit ? ` · ${sp.row.item.unit}` : ''}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-red-600 whitespace-nowrap">{fmtPerHead(sp.perHead)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400 whitespace-nowrap">{sp.mean ? fmtPerHead(sp.mean) : '-'}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-bold ${
                          sp.diffPct >= 100 ? 'bg-red-600 text-white'
                            : sp.diffPct >= 50 ? 'bg-red-100 text-red-700'
                            : 'bg-amber-100 text-amber-700'}`}>
                          +{sp.diffPct.toFixed(0)}%
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-red-700 whitespace-nowrap">{fmtUsage(sp.excessQty)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-500 whitespace-nowrap">{fmtUsage(sp.usage)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
            เรียงจาก <span className="text-gray-600 font-medium">เกินไป (หน่วย)</span> มากไปน้อย —
            ไม่ได้เรียงด้วย % เพราะของที่ใช้น้อยมากเกิน 300% ก็ยังไม่กี่กรัม
            ส่วนของที่ใช้เยอะเกินแค่ 20% อาจเป็นเงินหลักหมื่น ·
            คลิกที่แถวเพื่อดูไอเทมนั้นเทียบทุกสาขาแบบเต็ม ·
            ค่ากลาง = ยอดใช้รวม ÷ จำนวนหัวรวม ของสาขาที่ใช้ไอเทมนั้น
          </p>
          <p className="text-[11px] text-gray-400 mt-1.5 leading-relaxed">
            เกินค่ากลางไม่ได้แปลว่าผิดเสมอไป — สูตรที่ต่างกัน เมนูขายดีคนละตัว หรือสาขาที่เพิ่งเปิด
            ก็ทำให้ต่างได้ ใช้เป็นจุดตั้งต้นในการไปดูหน้างานว่าตักเกินสูตร ของหาย หรือตัดสต๊อกไม่ครบ
          </p>
        </div>

        <div className="p-4 border-t border-gray-100 bg-gray-50 flex justify-between items-center gap-3">
          <span className="text-[11px] text-gray-400">
            แสดง {fmtInt(shown.length)} จาก {fmtInt(spots.length)} จุด
          </span>
          <button className="px-4 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-medium hover:bg-red-200 transition-colors"
            onClick={onClose}>
            ปิดหน้าต่าง
          </button>
        </div>
      </div>
    </div>
  );
}

/** หน้าต่างเทียบทุกสาขาของไอเทมเดียว — เรียงจากใช้ต่อหัวมากสุด + แท่งเทียบค่ากลาง */
function DetailModal({ row, report, settings, loadingSettings, onClose }) {
  const mean = row.mean;
  // เอาเฉพาะสาขาที่ใช้ไอเทมนี้จริง — สาขาที่ไม่ได้ใช้เลยไม่ได้เข้าค่ากลาง จะโชว์ -100% ให้ตกใจเล่น ๆ
  const lines = row.cells
    .filter(c => c.perHead !== null && c.usage > 0)
    .sort((a, b) => b.perHead - a.perHead);
  const idleBranches = row.cells.filter(c => c.branch.ok && !c.usage).map(c => c.branch.name.toUpperCase());
  const max = lines.length ? Math.max(...lines.map(l => l.perHead), mean || 0) : 1;
  const settingRows = settings ? (settings[row.id] || []) : null;
  const settingOf = (branchName) => {
    if (!settingRows) return null;
    return settingRows.find(s => String(s.branch).toLowerCase() === String(branchName).toLowerCase()) || null;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl overflow-hidden animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-fuchsia-100 bg-fuchsia-50/50">
          <h3 className="font-bold text-fuchsia-900">
            {row.item.name}
            <span className="ml-2 font-mono text-[11px] font-normal text-fuchsia-500">
              {row.item.productId} · {row.item.unit} · {row.item.storageCat || 'ไม่ระบุหมวด'}
            </span>
          </h3>
          <button onClick={onClose} className="text-fuchsia-400 hover:text-fuchsia-700 font-bold text-xl leading-none">&times;</button>
        </div>

        <div className="p-4 max-h-[72vh] overflow-y-auto">
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="border border-purple-100 bg-purple-50/50 rounded-xl p-3">
              <div className="text-[10px] text-purple-600">ค่ากลางต่อหัว (ทุกสาขา)</div>
              <div className="text-lg font-bold text-purple-900">{mean ? fmtPerHead(mean) : '-'}</div>
              <div className="text-[10px] text-purple-400">{row.item.unit || 'หน่วย'}/หัว</div>
            </div>
            <div className="border border-blue-100 bg-blue-50/50 rounded-xl p-3">
              <div className="text-[10px] text-blue-600">ยอดใช้รวม</div>
              <div className="text-lg font-bold text-blue-900">{fmtUsage(row.totalUsage)}</div>
              <div className="text-[10px] text-blue-400">
                {report.source === 'closing' ? `รอบ${monthLabel(report.month)}` : `${report.from} ถึง ${report.to}`}
              </div>
            </div>
            <div className="border border-red-100 bg-red-50/50 rounded-xl p-3">
              <div className="text-[10px] text-red-600">สาขาที่เกินค่ากลาง &gt;{DEVIATION_PCT}%</div>
              <div className="text-lg font-bold text-red-700">{row.overCount}</div>
              <div className="text-[10px] text-red-400">
                {lines.filter(l => l.diffPct > DEVIATION_PCT).map(l => l.branch.name.toUpperCase()).join(', ') || '—'}
              </div>
            </div>
          </div>

          {lines.length === 0 ? (
            <div className="text-center py-10 text-gray-400 text-sm">ช่วงนี้ไม่มีสาขาไหนคิดต่อหัวได้ (ไม่มียอดใช้ หรือไม่มีจำนวนหัว)</div>
          ) : (
            <div className="grid lg:grid-cols-2 gap-5">
              <div>
                <h4 className="text-xs font-bold text-slate-600 mb-2">เทียบทุกสาขา (เรียงจากใช้ต่อหัวมากสุด)</h4>
                <div className="border border-gray-100 rounded-xl overflow-hidden">
                  <table className="min-w-full text-[11.5px]">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-2.5 py-2 text-left font-bold text-gray-500 uppercase text-[9.5px]">สาขา</th>
                        <th className="px-2.5 py-2 text-right font-bold text-gray-500 uppercase text-[9.5px]">จำนวนหัว</th>
                        <th className="px-2.5 py-2 text-right font-bold text-gray-500 uppercase text-[9.5px]">ยอดใช้</th>
                        <th className="px-2.5 py-2 text-right font-bold text-gray-500 uppercase text-[9.5px]">ใช้ต่อหัว</th>
                        <th className="px-2.5 py-2 text-right font-bold text-gray-500 uppercase text-[9.5px]">ต่างจากค่ากลาง</th>
                        <th className="px-2.5 py-2 text-right font-bold text-gray-500 uppercase text-[9.5px]" title="ค่าเฉลี่ยต่อหัวที่สาขาตั้งไว้ในหน้านับสต๊อก">ค่าที่ตั้งไว้</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {lines.map((l, i) => {
                        const over = l.diffPct > DEVIATION_PCT;
                        const under = l.diffPct < -DEVIATION_PCT;
                        const set = settingOf(l.branch.name);
                        // เทียบกับค่าที่ตั้งไว้เฉพาะสาขาที่ใช้โหมด "ต่อหัว" — โหมดเติมเต็มเป็นคนละหน่วยความหมาย
                        const setVal = set && set.calcMode !== 'par' && set.avgPerHead !== '' ? Number(set.avgPerHead) : null;
                        const setOff = setVal ? Math.abs(l.perHead - setVal) / setVal * 100 > DEVIATION_PCT : false;
                        return (
                          <tr key={i}>
                            <td className="px-2.5 py-1.5 font-bold font-mono text-slate-700">{l.branch.name.toUpperCase()}</td>
                            <td className="px-2.5 py-1.5 text-right text-slate-500">{fmtInt(l.branch.covers)}</td>
                            <td className="px-2.5 py-1.5 text-right text-slate-600">{fmtUsage(l.usage)}</td>
                            <td className={`px-2.5 py-1.5 text-right font-bold ${over ? 'text-red-600' : under ? 'text-cyan-700' : 'text-slate-700'}`}>
                              {fmtPerHead(l.perHead)}
                            </td>
                            <td className="px-2.5 py-1.5 text-right">
                              <span className={`inline-block px-1.5 rounded-full text-[9.5px] font-semibold ${
                                over ? 'bg-red-100 text-red-700' : under ? 'bg-cyan-100 text-cyan-700' : 'bg-slate-100 text-slate-500'}`}>
                                {l.diffPct > 0 ? '+' : ''}{l.diffPct.toFixed(1)}%
                              </span>
                            </td>
                            <td className="px-2.5 py-1.5 text-right text-fuchsia-700">
                              {loadingSettings ? <Loader2 className="w-3 h-3 animate-spin inline text-fuchsia-300" />
                                : setVal ? <>{setVal}{setOff && <span title="ใช้จริงต่างจากค่าที่ตั้งไว้เกินเกณฑ์"> ⚠️</span>}</>
                                : set ? <span className="text-gray-400" title="สาขานี้ตั้งเป็นโหมดเติมเต็มสตอค ไม่ได้คิดต่อหัว">เติมเต็ม</span>
                                : <span className="text-gray-300">-</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {idleBranches.length > 0 && (
                  <div className="mt-2 text-[10.5px] text-gray-400">
                    ไม่ได้ใช้ไอเทมนี้เลยในช่วงนี้ ({idleBranches.length} สาขา) : {idleBranches.join(', ')}
                  </div>
                )}
              </div>

              <div>
                <h4 className="text-xs font-bold text-slate-600 mb-2">ใช้ต่อหัวรายสาขา เทียบค่ากลาง</h4>
                <div className="space-y-1.5">
                  {lines.map((l, i) => {
                    const over = l.diffPct > DEVIATION_PCT;
                    const under = l.diffPct < -DEVIATION_PCT;
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <span className="w-11 text-[11px] font-bold font-mono text-slate-600">{l.branch.name.toUpperCase()}</span>
                        <span className="flex-1 relative h-4 bg-slate-50 rounded-full">
                          <span className={`absolute left-0 top-0 h-4 rounded-full ${over ? 'bg-red-400' : under ? 'bg-cyan-300' : 'bg-purple-300'}`}
                            style={{ width: `${Math.min(100, l.perHead / max * 100)}%` }} />
                          {mean && (
                            <span className="absolute -top-0.5 -bottom-0.5 border-l-2 border-dashed border-slate-400"
                              style={{ left: `${Math.min(100, mean / max * 100)}%` }} />
                          )}
                        </span>
                        <span className="w-16 text-right text-[11px] text-slate-600">{fmtPerHead(l.perHead)}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 text-[10.5px] text-gray-400 leading-relaxed">
                  • เส้นประ = ค่ากลางต่อหัวของทุกสาขา{mean ? ` (${fmtPerHead(mean)})` : ''}<br />
                  • แท่งแดง = สูงกว่าค่ากลางเกิน {DEVIATION_PCT}% (เสี่ยงตักเกินสูตร / ของหาย / ตัดสต๊อกไม่ครบ)<br />
                  • แท่งฟ้า = ต่ำกว่าค่ากลางเกิน {DEVIATION_PCT}% (อาจขายส่วนผสมอื่นแทน หรือสูตร BOM ไม่ตรงของจริง)
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="p-3 border-t border-gray-100 bg-gray-50 flex items-center justify-between gap-3">
          <span className="text-[10.5px] text-gray-400">
            {report.source === 'closing'
              ? `ยอดใช้ = ยกมา (ปิดรอบ${monthLabel(report.prevMonth)}) + รับเข้า − ปิดรอบ${monthLabel(report.month)}`
              : 'ยอดใช้ = ยอดขายจริง × สูตร BOM'}
            {' · '}จำนวนหัว = จานบุฟเฟต์ที่จ่ายจริง (WRM/WMT ใช้ Cover All)
          </span>
          <button className="px-4 py-2 bg-fuchsia-100 text-fuchsia-700 rounded-lg text-sm font-medium hover:bg-fuchsia-200 transition-colors"
            onClick={onClose}>ปิดหน้าต่าง</button>
        </div>
      </div>
    </div>
  );
}
