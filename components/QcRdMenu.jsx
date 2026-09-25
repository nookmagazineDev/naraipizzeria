import React, { useState, useEffect, useMemo } from 'react';
import { FileText, Search, Loader2, AlertCircle, CheckCircle, Plus, Pencil, X, Trash2, ChevronLeft, ChevronRight, Info, Power, AlertTriangle, ArrowRightLeft, ClipboardList, Save, Database } from 'lucide-react';
import { apiCall, syncNote, syncOk } from '../lib/qcrdApi';
import { rcpNameKey, rcpItemKey } from '../lib/rcpMatch';
import { patchSavedMenu, bomRowsFromForm } from '../lib/qcrdPatch.mjs';

/*
 * QC/RD — เมนู: รายชื่อเมนู + สูตร (BOM) ของแต่ละเมนู
 * กดแถวเพื่อดูสูตร · ปุ่ม "เพิ่มเมนู" / "แก้ไข" เปิดฟอร์มจัดการวัตถุดิบในสูตร
 * ในฟอร์มเลือกหมวดหมู่ได้ และ "ดึงสูตรจากเมนูอื่น" เพื่อรวมวัตถุดิบของเมนูนั้นเข้ามา
 * ข้อมูลอ่าน/บันทึกผ่าน /api/qcrd + /api/qcrd-save ซึ่งวิ่งไป SQL Server หรือ Apps Script
 * ตาม env QCRD_SOURCE (ดู docs/qcrd-sql-migration.md) — action ชื่อเดียวกันทั้งสองทาง
 *
 * เมนูที่ยังไม่มีสูตรในแท็บ BOM จะไปหยิบสูตรฝั่ง POS (RcpDtls) มาแสดงแทนผ่าน /api/rcp
 * จับคู่ด้วยชื่อเมนู (rcpNameKey) เพราะ RcpDtls ไม่มีคอลัมน์รหัสเมนูให้ join — ดู lib/rcpMatch.js
 * สูตรชุดนั้น "อ่านอย่างเดียว" แก้ไม่ได้จากหน้านี้ เพราะเป็นข้อมูลของฝั่ง POS ไม่ใช่ของชีทต้นทุนเมนู
 *
 * ปุ่ม "เพิ่มจากฐานข้อมูล" เปิดตัวเลือกเมนูจาก POS ฐานอื่น (Aoringo / HumlaiPOS / NaraiPos)
 * ผ่าน /api/qcrd-menu-source แล้วบันทึกด้วย action saveMenu ตัวเดิม — ดู MenuSourcePicker ท้ายไฟล์
 */

const fmt = (v, d = 2) => (v === null || v === undefined || isNaN(v)) ? '—'
  : Number(v).toLocaleString('th-TH', { minimumFractionDigits: d, maximumFractionDigits: d });

// ปริมาณ: โชว์ทศนิยมเท่าที่มีจริง (5.2 → "5.2", 5 → "5") ไม่ปัดทิ้งเหมือน fmt(v, 0)
const fmtQty = (v) => (v === null || v === undefined || v === '' || isNaN(v)) ? '—'
  : Number(v).toLocaleString('th-TH', { maximumFractionDigits: 4 });

const roundQty = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

// ข้อความอธิบายตอนหน้าถูกล็อกไม่ให้แก้ (โหมด SQL ที่อ่านไม่ได้แล้วถอยไปอ่านชีท)
const LOCK_HINT = 'ตอนนี้อ่านข้อมูลจาก SQL ไม่ได้ กำลังแสดงข้อมูลจากชีทแทน — ' +
  'ถ้าบันทึกตอนนี้จะเขียนทับของจริงด้วยข้อมูลที่อาจเก่ากว่า จึงล็อกไว้ก่อน (กดรีเฟรชเมื่อ SQL กลับมา)';

const PAGE_SIZE = 50;
const NEW_GROUP = '__new__'; // ค่าใน dropdown หมวดหมู่ = สร้างหมวดใหม่
// แท็กของวัตถุดิบในสูตร มีแค่ 2 อย่าง — ใช้คำเดียวกับ "ประเภท" ในหน้าวัตถุดิบ จะได้ไขว้ข้อมูลกันได้
const TAG_MATERIAL = 'วัตถุดิบ';
const TAG_PACKAGING = 'แพ็กเกจจิ้ง';
const TAG_OPTIONS = [TAG_MATERIAL, TAG_PACKAGING];

// หน่วยของ "ปริมาณที่ได้" ที่ใช้บ่อย (พิมพ์หน่วยอื่นเองได้)
const YIELD_UNITS = ['ชิ้น', 'ถาด', 'จาน', 'ที่', 'ชุด', 'แก้ว', 'ถ้วย', 'ถุง', 'กรัม', 'กก.', 'มล.', 'ลิตร'];

export default function QcRdMenu() {
  const [menus, setMenus] = useState([]);
  const [bom, setBom] = useState({});
  const [items, setItems] = useState([]); // สำหรับ picker วัตถุดิบ
  const [groups, setGroups] = useState([]); // หมวดหมู่เมนูจากชีท menucodegroup
  // ดัชนีสูตรฝั่ง POS: name_key -> { rtsId, name, nItems } (ยังไม่มีบรรทัดวัตถุดิบ โหลดตอนกดดู)
  const [rcpIndex, setRcpIndex] = useState({});
  const [rcpWarn, setRcpWarn] = useState('');
  const [rcpLines, setRcpLines] = useState({});   // rtsId -> items[] (แคชไว้ ไม่โหลดซ้ำ)
  const [rcpLoading, setRcpLoading] = useState(false);
  const [groupModal, setGroupModal] = useState(false);
  const [srcModal, setSrcModal] = useState(false);   // ตัวเลือกเมนูจากฐานอื่น (ดู MenuSourcePicker)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [page, setPage] = useState(1);
  const [togglingCode, setTogglingCode] = useState(null);
  const [viewCode, setViewCode] = useState(null);   // เมนูที่กำลังดูสูตร
  const [editMenu, setEditMenu] = useState(null);   // { code, name, price, group, newGroupName, items[], sources[], isNew }
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [formMsg, setFormMsg] = useState(null);     // ข้อความในฟอร์ม (ผลการดึงสูตร/รวมรายการซ้ำ)
  // โหมด SQL ที่อ่าน SQL ไม่ได้แล้วถอยไปอ่านชีท — ที่เห็นบนจอไม่ใช่ข้อมูลที่ปุ่มบันทึกจะเขียนทับ
  // ล็อกการแก้ไขทั้งหน้าไว้ก่อน ไม่งั้นจะเกิดอาการ "บันทึกสำเร็จแต่ข้อมูลไม่เปลี่ยน" เหมือนที่เคยเจอ
  const [degraded, setDegraded] = useState(false);

  // quiet = โหลดใหม่เบื้องหลัง ไม่ขึ้นสปินเนอร์คลุมทั้งหน้า
  // only  = โหลดเฉพาะบางชุด (['bom'] ฯลฯ) — ไม่ระบุ = ทั้งหมด
  //
  // ตอนเปิดหน้าต้องโหลดครบทุกชุดอยู่แล้ว แต่หลังกดบันทึกไม่ต้อง — ดู handleSave
  // การลากสูตรทุกบรรทัดของพันกว่าเมนูกลับมาใหม่เพื่อแก้ตัวเลขไม่กี่ช่องคือเหตุผลเดียว
  // ที่ตารางอัปเดตช้าเป็นหลายวินาที
  //
  // ต่อ ?t= ทุกครั้ง ไม่ใช่เฉพาะตอนโหลดหลังบันทึก — /api/qcrd ตั้งแคชไว้ที่ CDN
  // s-maxage=30 + stale-while-revalidate=120 เปิดหน้านี้ใหม่/กด F5 หลังเพิ่งบันทึก
  // จึงมีสิทธิ์ได้ของก่อนบันทึกกลับมาได้ถึงสองนาทีครึ่ง = อาการ "บันทึกแล้วข้อมูลไม่เปลี่ยน"
  // และปุ่ม "ลองใหม่" ของแถบเตือนก็จะได้คำตอบเดิมที่แคชไว้กลับมา เหมือนกดแล้วไม่มีอะไรเกิดขึ้น
  // หน้านี้เป็นหน้าแก้ไข ต้องเห็นของจริงเสมอ — กติกาเดียวกับหน้าวัตถุดิบ (components/QcRdItems.jsx)
  const loadAll = ({ quiet = false, only = null } = {}) => {
    if (!quiet) setLoading(true);
    const want = (name) => !only || only.includes(name);
    const bust = `&t=${Date.now()}`;
    const get = (name, url) => (want(name)
      ? fetch(url).then(r => r.json()).catch(err => ({ status: 'error', message: err.message }))
      : Promise.resolve(null));

    return Promise.all([
      get('menu', `/api/qcrd?sheet=menu${bust}`),
      get('bom', `/api/qcrd?sheet=bom${bust}`),
      get('item', `/api/qcrd?sheet=item${bust}`),
      get('menugroup', `/api/qcrd?sheet=menugroup${bust}`),
      // ดัชนีสูตรฝั่ง POS — ล้มก็ไม่เป็นไร หน้าเมนูต้องใช้งานต่อได้จากข้อมูลหลักตามเดิม
      want('rcp')
        ? fetch(`/api/rcp?t=${Date.now()}`).then(r => r.json()).catch(() => ({}))
        : Promise.resolve(null),
    ]).then(([m, b, it, g, rc]) => {
      const loaded = [m, b, it, g].filter(Boolean);
      // โหมด SQL ที่อ่านไม่ได้แล้วถอยไปอ่านชีท — ขึ้นแถบเตือนค้างไว้ + ล็อกการแก้ไข
      if (loaded.length) setDegraded(loaded.some(r => r.degraded));

      // ชุดไหนพลาดต้องฟ้อง — ของเดิมข้ามเงียบ ๆ (if success เฉย ๆ ไม่มี else) ตารางจึงค้าง
      // ของเก่าไว้ถาวรโดยไม่มีอะไรบอก แยกจากอาการ "โหลดช้า" ด้วยตาไม่ออกเลย
      const failed = [];
      const take = (res, label, apply) => {
        if (!res) return;
        if (res.status === 'success') apply(res.data);
        else failed.push(`${label}${res.message ? ` (${res.message})` : ''}`);
      };
      take(m, 'รายการเมนู', d => setMenus(d || []));
      take(b, 'สูตร BOM', d => setBom(d || {}));
      take(it, 'วัตถุดิบ', d => setItems(d || []));
      take(g, 'หมวดหมู่', d => setGroups(d || []));
      if (rc) { setRcpIndex(rc.data || {}); setRcpWarn(rc.warning || ''); }

      if (m && m.warning) setToast({ ok: false, msg: m.warning });
      if (failed.length) {
        const msg = `โหลด${failed.join(' · ')} ไม่สำเร็จ — ตัวเลขที่เห็นอาจยังไม่ใช่ล่าสุด กดรีเฟรชหน้าอีกครั้ง`;
        if (m && m.status !== 'success') setError(m.message || msg); else setToast({ ok: false, msg });
      }
    }).catch(err => setError(err.message)).finally(() => { if (!quiet) setLoading(false); });
  };
  useEffect(() => { loadAll(); }, []);

  // ข้อมูลวัตถุดิบตามรหัส (สถานะ/ตัวทดแทน) ใช้ฟ้องในสูตรเมื่อวัตถุดิบถูกปิดใช้งาน
  const itemMap = useMemo(() => {
    const m = {};
    items.forEach(i => { m[i.code] = i; });
    return m;
  }, [items]);

  // ดัชนีเดียวกันแต่คีย์เป็นรหัสที่ตัด 0 นำหน้าออก — RcpDtls เขียนรหัสเป็น '01000077'
  // ส่วนชีท item เขียน '1000077' เทียบตรง ๆ จะไม่เจอ แล้วธงวัตถุดิบปิดใช้งานจะไม่ขึ้น
  const itemByKey = useMemo(() => {
    const m = {};
    items.forEach(i => { const k = rcpItemKey(i.code); if (k) m[k] = i; });
    return m;
  }, [items]);

  // หน่วยซื้อที่มีอยู่จริงในชีท item (ใช้เป็นตัวเลือกในช่องหน่วยของแถววัตถุดิบ)
  const itemUnits = useMemo(
    () => [...new Set(items.map(i => i.unit).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th')),
    [items]);

  // จำนวนบรรทัดสูตรของเมนูหนึ่ง — เมนูที่เพิ่งถูกคิดใหม่ตาม (cascade) จะมี count มาก่อน
  // เพราะบรรทัดชุดใหม่ยังโหลดไม่มา แต่จำนวนกับต้นทุนรู้แล้วจากคำตอบของการบันทึก
  const bomCount = (code) => bom[code]?.count ?? bom[code]?.items?.length ?? 0;

  const disabledIngredients = (code) =>
    (bom[code]?.items || []).filter(r => itemMap[r.itemCode]?.status === 'ปิดการใช้งาน');

  // สูตรฝั่ง POS (RcpDtls) ของเมนูนี้ — คืนค่าเฉพาะเมนูที่ "ยังไม่มีสูตรในแท็บ BOM"
  // ชีทต้นทุนเมนูเป็นเจ้าของสูตรเสมอ RcpDtls มาเติมเฉพาะช่องที่ยังว่าง ไม่ทับของเดิม
  const rcpFor = (m) => (bomCount(m.code) ? null : (rcpIndex[rcpNameKey(m.name)] || null));
  const hasRecipe = (m) => Boolean(bomCount(m.code)) || Boolean(rcpFor(m));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = menus.filter(m => {
      if (statusFilter && (m.status || 'ใช้งาน') !== statusFilter) return false;
      if (groupFilter && (m.groupName || '') !== groupFilter) return false;
      if (!q) return true;
      return m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
        || (m.groupName || '').toLowerCase().includes(q);
    });
    // เมนูที่มีสูตรขึ้นก่อน (นับสูตรจาก RcpDtls ด้วย) แล้วคงลำดับเดิมตามชีท menu
    const idx = new Map(menus.map((m, i) => [m.code, i]));
    return [...list].sort((a, b) =>
      ((hasRecipe(b) ? 1 : 0) - (hasRecipe(a) ? 1 : 0)) ||
      ((idx.get(a.code) ?? 0) - (idx.get(b.code) ?? 0)));
  }, [menus, bom, rcpIndex, search, statusFilter, groupFilter]);

  // เมนูที่ไม่มีสูตรในชีทแต่ไปเจอสูตรฝั่ง POS — ไว้บอกบนหัวหน้าว่าเติมให้ไปกี่เมนู
  const nFromRcp = useMemo(() => {
    if (!Object.keys(rcpIndex).length) return 0;
    return menus.reduce((n, m) => n + (rcpFor(m) ? 1 : 0), 0);
  }, [menus, bom, rcpIndex]);   // eslint-disable-line react-hooks/exhaustive-deps

  // รายชื่อหมวดหมู่ที่มีจริงในชีท (สำหรับ dropdown กรอง)
  const groupOptions = useMemo(
    () => [...new Set(menus.map(m => m.groupName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th')),
    [menus]);

  // ตัวเลือกหมวดหมู่ในฟอร์ม: จากชีท menucodegroup + รหัสหมวดที่เมนูใช้อยู่แต่ยังไม่มีชื่อในชีท
  const groupList = useMemo(() => {
    const map = new Map(groups.map(g => [g.code, g.name]));
    menus.forEach(m => { if (m.group && !map.has(m.group)) map.set(m.group, m.groupName || `หมวด ${m.group}`); });
    return [...map].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name, 'th'));
  }, [groups, menus]);

  // รหัสที่มีในทะเบียนแล้ว — ตัวเลือก "เพิ่มจากฐานข้อมูล" ใช้กันไม่ให้เลือกตัวซ้ำมาบันทึกทับ
  // เทียบแบบไม่สนตัวพิมพ์และมองข้าม 0 นำหน้า ด้วยเหตุผลเดียวกับ menu_key ในฐาน
  // (รหัสเดียวกันถูกเขียนทั้ง '00123' และ '123' มาตั้งแต่สมัยชีท)
  const existingCodes = useMemo(() => {
    const set = new Set();
    menus.forEach(m => { normCodeKeys(m.code).forEach(k => set.add(k)); });
    return set;
  }, [menus]);

  // เลขรันนิ่งล่าสุดของรหัสที่ระบบออกให้เอง (เช่น HM000042) แยกตามตัวนำหน้า
  // นับเฉพาะรูปแบบ "ตัวอักษร + ตัวเลข 6 หลักพอดี" — รหัสยาวกว่านั้นเป็นของคนละกติกา
  // (เช่น HM + id 13 หลักที่เคยเผลอบันทึกไว้) ไม่ควรดันเลขรันนิ่งให้กระโดดไปเป็นหลักล้านล้าน
  const runningBase = useMemo(() => {
    const max = {};
    menus.forEach(m => {
      const hit = /^([A-Za-z]+)(\d{6})$/.exec(String(m.code || '').trim());
      if (!hit) return;
      const p = hit[1].toUpperCase();
      const n = parseInt(hit[2], 10);
      if (Number.isFinite(n)) max[p] = Math.max(max[p] || 0, n);
    });
    return max;
  }, [menus]);

  // ชื่อเมนูที่มีอยู่แล้ว แยกตามตัวนำหน้ารหัส — ต้นทางที่ระบบออกรหัสให้เองเทียบรหัสซ้ำไม่ได้
  // (รหัสยังไม่เกิดจนกว่าจะกดบันทึก) จึงต้องกันซ้ำด้วยชื่อเมนูภายในตัวนำหน้าเดียวกันแทน
  const existingNames = useMemo(() => {
    const by = {};
    menus.forEach(m => {
      const p = (/^([A-Za-z]+)/.exec(String(m.code || '').trim())?.[1] || '').toUpperCase();
      (by[p] = by[p] || new Set()).add(normMenuName(m.name));
    });
    return by;
  }, [menus]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const pageRows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [search]);

  const openAdd = () => {
    setFormMsg(null);
    setEditMenu({
      code: '', name: '', price: '', group: '', newGroupName: '',
      yieldQty: '', yieldUnit: '', unitEdits: {}, isNew: true, items: [emptyIng()], sources: [],
    });
  };
  const openEdit = (m) => {
    const rows = (bom[m.code]?.items || []).map(r => ({
      itemCode: r.itemCode, itemName: r.itemName, qty: r.qty ?? '', converter: r.converter ?? 1000,
      // ที่มาที่บันทึกไว้ในชีท (คอลัมน์ O–R) — เอากลับมาโชว์และแก้สัดส่วนต่อได้
      srcCode: r.srcCode || undefined, srcName: r.srcName || undefined,
      srcBase: r.srcBase ?? undefined,
      tag: r.tag === TAG_PACKAGING ? TAG_PACKAGING : TAG_MATERIAL, noDeduct: Boolean(r.noDeduct),
    }));
    // สร้างชิป "เมนูที่ดึงมา" ใหม่จากที่มาของแต่ละแถว
    const sources = [];
    (bom[m.code]?.items || []).forEach(r => {
      if (!r.srcCode || sources.some(s => s.code === r.srcCode)) return;
      sources.push({ code: r.srcCode, name: r.srcName || r.srcCode, factor: String(r.srcFactor ?? 1) });
    });
    setFormMsg(null);
    setEditMenu({
      code: m.code, name: m.name, price: m.price ?? '', group: m.group || '', newGroupName: '',
      yieldQty: m.yieldQty ?? '', yieldUnit: m.yieldUnit || '', unitEdits: {},
      isNew: false, items: rows.length ? rows : [emptyIng()], sources,
    });
  };
  const emptyIng = () => ({ itemCode: '', itemName: '', qty: '', converter: 1000, tag: TAG_MATERIAL, noDeduct: false });

  // ───── ดึงวัตถุดิบจากเมนูอื่นเข้ามาในสูตรที่กำลังแก้ (ทำเมนูเซ็ต/เมนูรวม) ─────
  // factor = สัดส่วนของสูตรต้นทาง (1 = ทั้งสูตร, 0.2 = 20% ของสูตร, 2 = 2 เท่า)
  // เก็บยอดใช้เดิมไว้ที่ srcBase ของแต่ละแถว เพื่อคำนวณใหม่ได้เมื่อแก้สัดส่วนทีหลัง
  const importFromMenu = (src, factorInput = 1) => {
    const factor = parseFloat(factorInput);
    if (!(factor > 0)) { setFormMsg({ ok: false, msg: 'สัดส่วนต้องมากกว่า 0' }); return; }
    const srcRows = bom[src.code]?.items || [];
    if (!srcRows.length) { setFormMsg({ ok: false, msg: `"${src.name}" ยังไม่มีสูตรให้ดึง` }); return; }

    // ดึงเมนูเดิมซ้ำ = แก้สัดส่วนของชุดที่ดึงไว้แล้ว (ไม่ซ้อนเข้ามาอีกชุด)
    const already = editMenu?.sources.find(s => s.code === src.code);
    if (already) {
      if (already.locked) {
        setFormMsg({ ok: false, msg: `"${src.name}" ถูกรวมรายการซ้ำไปแล้ว ถ้าจะปรับสัดส่วนให้ลบชุดนี้ออกก่อนแล้วดึงใหม่` });
        return;
      }
      setSourceFactor(src.code, String(factor));
      setFormMsg({ ok: true, msg: `ปรับสัดส่วนของ "${src.name}" เป็น ×${factor} แล้ว` });
      return;
    }

    const rows = srcRows.map(r => {
      const base = parseFloat(r.qty) || 0;
      return {
        itemCode: r.itemCode, itemName: r.itemName, qty: roundQty(base * factor),
        converter: r.converter ?? 1000, srcCode: src.code, srcName: src.name, srcBase: base,
        tag: r.tag === TAG_PACKAGING ? TAG_PACKAGING : TAG_MATERIAL, noDeduct: Boolean(r.noDeduct),
      };
    });
    setEditMenu(m => ({
      ...m,
      items: [...m.items.filter(r => r.itemCode), ...rows],   // ทิ้งแถวว่างที่ยังไม่ได้เลือกวัตถุดิบ
      sources: [...m.sources, { code: src.code, name: src.name, factor: String(factor) }],
    }));
    setFormMsg({
      ok: true,
      msg: `ดึงวัตถุดิบจาก "${src.name}" มา ${rows.length} รายการ${factor !== 1 ? ` (×${factor} = ${Math.round(factor * 100)}% ของสูตร)` : ''}`,
    });
  };

  // แก้สัดส่วนของเมนูที่ดึงมา → คิดยอดใช้ใหม่จากสูตรเดิม (srcBase × สัดส่วน)
  const setSourceFactor = (code, value) => setEditMenu(m => {
    const f = parseFloat(value);
    return {
      ...m,
      sources: m.sources.map(s => s.code === code ? { ...s, factor: value } : s),
      items: f > 0
        ? m.items.map(r => (r.srcCode === code && r.srcBase !== undefined) ? { ...r, qty: roundQty(r.srcBase * f) } : r)
        : m.items,   // ระหว่างพิมพ์ (ว่าง/0/"0.") ยังไม่ต้องคิดใหม่ รอให้ใส่ค่าที่ใช้ได้ก่อน
    };
  });

  // ถอดวัตถุดิบที่ดึงมาจากเมนูนั้นออกทั้งชุด
  const removeSource = (code) => setEditMenu(m => {
    const rest = m.items.filter(r => r.srcCode !== code);
    return { ...m, items: rest.length ? rest : [emptyIng()], sources: m.sources.filter(s => s.code !== code) };
  });

  // จำนวนวัตถุดิบที่ซ้ำกัน (เกิดได้เมื่อดึงหลายเมนูที่ใช้วัตถุดิบเดียวกัน)
  const dupCount = useMemo(() => {
    if (!editMenu) return 0;
    const seen = new Set();
    return editMenu.items.reduce((n, r) => {
      if (!r.itemCode) return n;
      if (seen.has(r.itemCode)) return n + 1;
      seen.add(r.itemCode);
      return n;
    }, 0);
  }, [editMenu]);

  // รวมวัตถุดิบซ้ำเป็นบรรทัดเดียว (บวกยอดใช้เข้าด้วยกัน)
  const mergeDuplicates = () => {
    setEditMenu(m => {
      const out = [];
      const pos = {};
      m.items.forEach(r => {
        if (!r.itemCode) { out.push(r); return; }
        if (pos[r.itemCode] === undefined) { pos[r.itemCode] = out.length; out.push({ ...r }); return; }
        const t = out[pos[r.itemCode]];
        t.qty = roundQty((parseFloat(t.qty) || 0) + (parseFloat(r.qty) || 0));
        const names = [...new Set([t.srcName, r.srcName].filter(Boolean))];
        if (names.length) t.srcName = names.join(' + ');
      });
      // ยอดใช้ถูกยุบรวมแล้ว ย้อนไปคิดจากสัดส่วนของแต่ละเมนูไม่ได้อีก — ตัดสายจากต้นทางทั้งหมด
      // (ป้ายบอกที่มายังอยู่ ถ้าจะแก้สัดส่วนให้ลบชุดนั้นออกแล้วดึงใหม่)
      out.forEach(r => { delete r.srcCode; delete r.srcBase; });
      return { ...m, items: out, sources: m.sources.map(s => ({ ...s, locked: true })) };
    });
    setFormMsg({ ok: true, msg: `รวมวัตถุดิบซ้ำ ${dupCount} รายการเข้าด้วยกันแล้ว (ปรับสัดส่วนต่อไม่ได้แล้ว)` });
  };

  const priceMap = useMemo(() => {
    const map = {};
    items.forEach(i => { map[i.code] = i.price || 0; });
    return map;
  }, [items]);

  // ปริมาณที่ได้ต่อ 1 สูตรในฟอร์ม (ใช้หารต้นทุนให้เป็นต่อหน่วย)
  const perYield = parseFloat(editMenu?.yieldQty) || 0;

  // เมนูอื่นที่ดึงสูตรของเมนูที่กำลังแก้ไปใช้ — บันทึกแล้วจะถูกคิดยอดใหม่ตามไปด้วย
  const usedByMenus = useMemo(() => {
    const code = editMenu?.code?.trim();
    if (!code || editMenu.isNew) return [];
    return Object.entries(bom)
      .filter(([c, b]) => c !== code && (b.items || []).some(r => r.srcCode === code))
      .map(([c, b]) => ({ code: c, name: b.name || c }));
  }, [bom, editMenu]);

  const estCost = (rows) => rows.reduce((s, r) => {
    const p = priceMap[r.itemCode] || 0;
    const conv = parseFloat(r.converter) || 1000;
    const qty = parseFloat(r.qty) || 0;
    return s + (conv ? qty * (p / conv) : 0);
  }, 0);

  const handleSave = async () => {
    if (degraded) { setFormMsg({ ok: false, msg: LOCK_HINT }); return; }
    if (!editMenu.code.trim() || !editMenu.name.trim()) {
      setFormMsg({ ok: false, msg: 'กรุณากรอกรหัสและชื่อเมนู' });
      return;
    }
    const isNewGroup = editMenu.group === NEW_GROUP;
    if (isNewGroup && !editMenu.newGroupName.trim()) {
      setFormMsg({ ok: false, msg: 'กรุณากรอกชื่อหมวดหมู่ใหม่' });
      return;
    }
    setSaving(true);
    setToast(null);
    setFormMsg(null);
    try {
      const rows = editMenu.items.filter(r => r.itemCode && parseFloat(r.qty) > 0);
      const factorOf = (code) => editMenu.sources.find(s => s.code === code)?.factor ?? '';
      const res = await apiCall('saveMenu', {
        code: editMenu.code.trim(), name: editMenu.name.trim(), price: editMenu.price,
        group: isNewGroup ? '' : editMenu.group,
        newGroupName: isNewGroup ? editMenu.newGroupName.trim() : '',
        yieldQty: String(editMenu.yieldQty ?? '').trim(),
        yieldUnit: String(editMenu.yieldUnit || '').trim(),
        items: rows.map(r => ({
          itemCode: r.itemCode, itemName: r.itemName,
          qty: parseFloat(r.qty) || 0, converter: parseFloat(r.converter) || 1000,
          // ที่มาของวัตถุดิบ → ชีท BOM คอลัมน์ O–R (แยกจากคอลัมน์ที่ใช้คำนวณต้นทุน)
          srcCode: r.srcCode || '', srcName: r.srcName || '',
          srcFactor: r.srcCode ? factorOf(r.srcCode) : '',
          srcBase: r.srcBase ?? '',
          tag: r.tag === TAG_PACKAGING ? TAG_PACKAGING : TAG_MATERIAL, noDeduct: r.noDeduct ? 'Y' : '',
        })),
      });

      // หน่วยของวัตถุดิบที่แก้ในฟอร์ม → เขียนลงชีท item คอลัมน์ D (คนละชีทกับ BOM จึงยิงแยก)
      const usedCodes = new Set(rows.map(r => r.itemCode));
      const unitEdits = Object.entries(editMenu.unitEdits || {})
        .filter(([code, unit]) => code && usedCodes.has(code) && (itemMap[code]?.unit || '') !== String(unit).trim());
      let unitSaved = 0;
      for (const [code, unit] of unitEdits) {
        try { await apiCall('saveItem', { code, unit: String(unit).trim() }); unitSaved++; }
        catch { /* หน่วยบันทึกไม่ผ่านไม่ควรทำให้การบันทึกเมนูล้ม — รายงานรวมท้ายสุด */ }
      }
      // เมนูอื่นที่ดึงสูตรของเมนูนี้ไปใช้ ถูกคิดต้นทุนใหม่ให้ตามสูตรล่าสุดในรอบเดียวกัน
      const cascaded = res.data?.cascaded || [];
      setToast({
        ok: syncOk(res),
        msg: `บันทึก "${editMenu.name}" สำเร็จ (${res.data?.bomRows ?? rows.length} วัตถุดิบ`
          + `${unitEdits.length ? ` · หน่วย ${unitSaved}/${unitEdits.length} รายการ` : ''})`
          + (cascaded.length ? ` · อัปเดตเมนูที่ผูกไว้ ${cascaded.length} เมนู: ${cascaded.map(c => c.name || c.code).join(', ')}` : '')
          + syncNote(res),
      });
      // ── อัปเดตตารางทันทีจากคำตอบที่เพิ่งได้ ไม่ต้องโหลดข้อมูลใหม่ทั้งชุด ──
      // คำตอบบอกครบแล้วว่าอะไรเปลี่ยน (ต้นทุนใหม่ · จำนวนแถวสูตร · เมนูที่ผูกกันซึ่งคิดใหม่ตาม)
      // จึงแปะทับ state ได้เลย ตารางเด้งพร้อมข้อความ "บันทึกสำเร็จ" ไม่ใช่ตามมาอีกหลายวินาที
      const patched = patchSavedMenu({ menus, bom }, {
        code: editMenu.code.trim(),
        name: editMenu.name.trim(),
        price: String(editMenu.price ?? '').trim() === '' ? null : Number(editMenu.price),
        group: res.data?.group ?? (isNewGroup ? undefined : editMenu.group),
        groupName: isNewGroup
          ? editMenu.newGroupName.trim()
          : (groupList.find(g => g.code === editMenu.group)?.name ?? ''),
        cost: res.data?.totalCost ?? (rows.length ? estCost(rows) : null),
        yieldQty: String(editMenu.yieldQty ?? '').trim() === '' ? null : Number(editMenu.yieldQty),
        yieldUnit: String(editMenu.yieldUnit || '').trim(),
        rows: bomRowsFromForm(rows, priceMap),
        cascaded,
      });
      setMenus(patched.menus);
      setBom(patched.bom);
      setEditMenu(null);

      // เหลือเฉพาะชุดที่แปะเองไม่ได้จริง ๆ — ปกติไม่มีเลย จึงไม่มีการโหลดอะไรตามมา
      //   bom       บรรทัดสูตรของเมนูที่ผูกกัน (รู้แค่จำนวนกับต้นทุน ไม่ได้ส่งบรรทัดมาด้วย)
      //   menugroup เพิ่งสร้างหมวดใหม่
      //   item      เพิ่งแก้หน่วยของวัตถุดิบไปด้วย
      const refresh = [];
      if (patched.staleBom.length) refresh.push('bom');
      if (isNewGroup) refresh.push('menugroup');
      if (unitSaved) refresh.push('item');
      if (refresh.length) loadAll({ quiet: true, only: refresh });
    } catch (err) {
      setFormMsg({ ok: false, msg: err.message || 'บันทึกไม่สำเร็จ' });
    } finally {
      setSaving(false);
    }
  };

  // สลับสถานะเปิด/ปิดใช้งานเมนู (เขียนชีท menu คอลัมน์ F ผ่าน GAS)
  const toggleStatus = async (m) => {
    const next = (m.status || 'ใช้งาน') === 'ใช้งาน' ? 'ปิดการใช้งาน' : 'ใช้งาน';
    setTogglingCode(m.code);
    setToast(null);
    try {
      const res = await apiCall('saveMenuStatus', { code: m.code, status: next });
      setMenus(prev => prev.map(x => x.code === m.code ? { ...x, status: next } : x));
      setToast({
        ok: syncOk(res),
        msg: `${next === 'ใช้งาน' ? 'เปิด' : 'ปิด'}ใช้งาน "${m.name}" แล้ว` + syncNote(res),
      });
    } catch (err) {
      setToast({ ok: false, msg: err.message || 'เปลี่ยนสถานะไม่สำเร็จ' });
    } finally {
      setTogglingCode(null);
    }
  };

  const viewMenu = viewCode ? menus.find(m => m.code === viewCode) : null;
  const viewBom = viewCode ? (bom[viewCode]?.items || []) : [];
  // เมนูที่ไม่มีสูตรในชีท แต่จับคู่กับสูตรฝั่ง POS ได้ — ดัชนีมีแค่หัวสูตร
  // บรรทัดวัตถุดิบโหลดตอนกดเปิดดูเท่านั้น จะได้ไม่ต้องส่งสูตรหมื่นกว่าบรรทัดมาตั้งแต่เปิดหน้า
  const viewRcp = viewMenu && !viewBom.length ? rcpFor(viewMenu) : null;
  const viewRcpItems = viewRcp ? rcpLines[viewRcp.rtsId] : null;

  useEffect(() => {
    if (!viewRcp || rcpLines[viewRcp.rtsId]) return;
    const rtsId = viewRcp.rtsId;
    let cancelled = false;
    setRcpLoading(true);
    fetch(`/api/rcp?rtsId=${rtsId}`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        if (j.status === 'success' && j.data) setRcpLines(prev => ({ ...prev, [rtsId]: j.data.items || [] }));
        else setRcpLines(prev => ({ ...prev, [rtsId]: [] }));
      })
      .catch(() => { if (!cancelled) setRcpLines(prev => ({ ...prev, [rtsId]: [] })); })
      .finally(() => { if (!cancelled) setRcpLoading(false); });
    return () => { cancelled = true; };
  }, [viewRcp?.rtsId]);   // eslint-disable-line react-hooks/exhaustive-deps

  // เต็มความกว้างจอ — ตารางนี้มีสิบกว่าคอลัมน์ (สาขาที่ใช้ · หมวดสโตร์ · ไอเทมทดแทน)
  // การบีบไว้ที่ max-w-6xl ทำให้ต้องเลื่อนแนวนอนตลอดทั้งที่จอกว้างพอ
  return (
    <div className="w-full space-y-5">
      {/* แถบค้าง (ไม่ใช่ toast ที่หายไปเอง) — สถานะนี้ห้ามแก้ข้อมูล คนใช้ต้องเห็นตลอดเวลาที่เปิดหน้าอยู่ */}
      {degraded && (
        <div className="flex items-start gap-2.5 p-4 bg-rose-50 border border-rose-200 rounded-2xl">
          <AlertTriangle size={18} className="flex-shrink-0 text-rose-500 mt-0.5" />
          <div className="text-sm">
            <p className="font-bold text-rose-700">อ่านข้อมูลจาก SQL ไม่ได้ — ล็อกการแก้ไขไว้ชั่วคราว</p>
            <p className="text-rose-600 mt-0.5">
              ที่แสดงอยู่เป็นข้อมูลจากชีท ซึ่งอาจไม่ตรงกับของจริงใน SQL — ถ้าบันทึกตอนนี้จะเขียนทับของจริงด้วยของเก่า
              จึงปิดปุ่มบันทึกทั้งหมดไว้ก่อน ดูได้แต่แก้ไม่ได้
            </p>
            <button onClick={() => loadAll()}
              className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-rose-700 bg-white border border-rose-200 rounded-lg hover:bg-rose-100">
              ลองใหม่
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-6 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-indigo-100 text-indigo-600 rounded-xl"><FileText className="w-6 h-6" /></div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">เมนู (QC/RD)</h2>
              <p className="text-sm text-slate-500 mt-0.5">
                {menus.length.toLocaleString()} เมนูจากชีท menu · มีสูตร (BOM) {Object.keys(bom).length.toLocaleString()} เมนู
                {nFromRcp > 0 && (
                  <span className="text-amber-700"> · เติมจากสูตร POS อีก {nFromRcp.toLocaleString()} เมนู</span>
                )}
              </p>
              {rcpWarn && (
                <p title={rcpWarn} className="text-xs text-amber-700 mt-1 flex items-start gap-1 max-w-2xl">
                  <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                  <span className="line-clamp-2">สูตรฝั่ง POS (RcpDtls) ยังไม่ขึ้น: {rcpWarn}</span>
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {toast && (
              <span className={`inline-flex items-center gap-1 text-xs font-semibold ${toast.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                {toast.ok ? <CheckCircle size={13} /> : <AlertCircle size={13} />}{toast.msg}
              </span>
            )}
            <button onClick={() => setSrcModal(true)} disabled={degraded} title={degraded ? LOCK_HINT : 'ดึงเมนูจากฐาน Aoringo / HumlaiPOS / NaraiPos'}
              className="inline-flex items-center gap-2 bg-white hover:bg-indigo-50 disabled:bg-slate-100 disabled:text-slate-400 text-indigo-600 border border-indigo-200 font-semibold text-xs px-4 py-2 rounded-xl transition-all">
              <Database size={14} /> เพิ่มจากฐานข้อมูล
            </button>
            <button onClick={openAdd} disabled={degraded} title={degraded ? LOCK_HINT : ''}
              className="inline-flex items-center gap-2 bg-indigo-500 hover:bg-indigo-600 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
              <Plus size={14} /> เพิ่มเมนู
            </button>
          </div>
        </div>

        <div className="p-4 border-b border-slate-100 flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหารหัส / ชื่อเมนู / หมวดหมู่…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <select value={groupFilter} onChange={e => setGroupFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">ทุกหมวดหมู่ ({groupOptions.length})</option>
            {groupOptions.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">ทุกสถานะ</option>
            <option value="ใช้งาน">ใช้งาน</option>
            <option value="ปิดการใช้งาน">ปิดการใช้งาน</option>
          </select>
          <button onClick={() => setGroupModal(true)} disabled={degraded} title={degraded ? LOCK_HINT : ''}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-50">
            <Pencil size={13} /> จัดการหมวดหมู่
          </button>
        </div>

        {error && (
          <div className="m-4 p-3 bg-rose-50 border border-rose-100 rounded-xl text-sm text-rose-700 flex items-center gap-2">
            <AlertCircle size={16} /><span>{error}</span>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="text-xs font-bold uppercase tracking-wide">
                <th className="px-4 py-3 text-left">รหัส</th>
                <th className="px-4 py-3 text-left">ชื่อเมนู</th>
                <th className="px-4 py-3 text-left">หมวดหมู่</th>
                <th className="px-4 py-3 text-right">ราคาขาย</th>
                <th className="px-4 py-3 text-right">ต้นทุน</th>
                <th className="px-4 py-3 text-center">วัตถุดิบ</th>
                <th className="px-4 py-3 text-center">สถานะ</th>
                <th className="px-4 py-3 text-center">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />กำลังโหลดข้อมูล…
                </td></tr>
              ) : pageRows.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">ไม่พบเมนู</td></tr>
              ) : pageRows.map(m => {
                const nIng = bomCount(m.code);
                const rcp = nIng ? null : rcpFor(m);     // สูตรฝั่ง POS มาเติมเมื่อไม่มีสูตรในชีท
                const off = (m.status || 'ใช้งาน') === 'ปิดการใช้งาน';
                const nDisabled = disabledIngredients(m.code).length;
                return (
                  <tr key={m.code} className={`hover:bg-indigo-50/40 ${nIng || rcp ? 'cursor-pointer' : ''} ${off ? 'bg-rose-50/40' : ''}`}
                    onClick={() => (nIng || rcp) && setViewCode(m.code)}>
                    <td className={`px-4 py-2 font-mono text-xs whitespace-nowrap ${off ? 'text-slate-300' : 'text-slate-500'}`}>{m.code}</td>
                    <td className={`px-4 py-2 font-medium ${off ? 'text-slate-400' : 'text-slate-800'}`}>{m.name}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {m.groupName
                        ? <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${off ? 'bg-slate-100 text-slate-400' : 'bg-indigo-50 text-indigo-700'}`}>{m.groupName}</span>
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className={`px-4 py-2 text-right font-mono ${off ? 'text-slate-300' : ''}`}>{fmt(m.price, 0)}</td>
                    <td className={`px-4 py-2 text-right font-mono ${off ? 'text-slate-300' : 'text-slate-600'}`}>{fmt(m.cost)}</td>
                    <td className="px-4 py-2 text-center whitespace-nowrap">
                      {nIng ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="inline-block px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-full text-xs font-semibold">{nIng} รายการ</span>
                          {nDisabled > 0 && (
                            <span title={`มีวัตถุดิบถูกปิดใช้งาน ${nDisabled} รายการ`}
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-rose-50 text-rose-600 border border-rose-200 rounded-full text-[10px] font-bold">
                              <AlertTriangle size={9} />{nDisabled}
                            </span>
                          )}
                        </span>
                      ) : rcp ? (
                        <span title={`สูตรฝั่ง POS (RcpDtls): ${rcp.name}`}
                          className="inline-block px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-full text-xs font-semibold">
                          {rcp.nItems} รายการ · POS
                        </span>
                      ) : <span className="text-slate-300 text-xs">ไม่มีสูตร</span>}
                    </td>
                    <td className="px-4 py-2 text-center whitespace-nowrap" onClick={e => e.stopPropagation()}>
                      <button onClick={() => toggleStatus(m)} disabled={togglingCode === m.code || degraded}
                        title={degraded ? LOCK_HINT : (off ? 'กดเพื่อเปิดใช้งาน' : 'กดเพื่อปิดใช้งาน')}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border transition-all disabled:opacity-60 ${off
                          ? 'bg-rose-100 text-rose-600 border-rose-200 hover:bg-rose-200'
                          : 'bg-emerald-50 text-emerald-600 border-emerald-200 hover:bg-emerald-100'}`}>
                        {togglingCode === m.code ? <Loader2 size={11} className="animate-spin" /> : <Power size={11} />}
                        {off ? 'ปิดการใช้งาน' : 'ใช้งาน'}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-center whitespace-nowrap" onClick={e => e.stopPropagation()}>
                      <button onClick={() => openEdit(m)} disabled={degraded} title={degraded ? LOCK_HINT : ''}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50">
                        <Pencil size={12} /> แก้ไข
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!loading && totalPages > 1 && (
          <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
            <span>แสดง {pageRows.length} จาก {filtered.length.toLocaleString()} เมนู</span>
            <div className="flex items-center gap-2">
              <button disabled={pageSafe <= 1} onClick={() => setPage(p => p - 1)}
                className="p-1.5 border border-slate-200 rounded-lg disabled:opacity-30 hover:bg-slate-50"><ChevronLeft size={14} /></button>
              <span className="font-semibold">{pageSafe} / {totalPages}</span>
              <button disabled={pageSafe >= totalPages} onClick={() => setPage(p => p + 1)}
                className="p-1.5 border border-slate-200 rounded-lg disabled:opacity-30 hover:bg-slate-50"><ChevronRight size={14} /></button>
            </div>
          </div>
        )}
      </div>

      {/* ───── Modal ดูสูตร ───── */}
      {viewMenu && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => setViewCode(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-800">สูตร: {viewMenu.name} <span className="font-mono text-xs text-slate-400 ml-1">{viewMenu.code}</span>
                  {viewRcp && (
                    <span className="ml-2 inline-block px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-full text-[11px] font-semibold align-middle">
                      สูตรฝั่ง POS (RcpDtls)
                    </span>
                  )}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {viewMenu.groupName ? `${viewMenu.groupName} · ` : ''}ราคาขาย {fmt(viewMenu.price, 0)} บาท · ต้นทุนรวม {fmt(viewMenu.cost)} บาท
                  {viewMenu.yieldQty > 0 && (
                    <span> · ได้ {fmtQty(viewMenu.yieldQty)} {viewMenu.yieldUnit || 'หน่วย'}
                      {viewMenu.cost > 0 && ` (ต้นทุน ${fmt(viewMenu.cost / viewMenu.yieldQty)} บาท/${viewMenu.yieldUnit || 'หน่วย'})`}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => { openEdit(viewMenu); setViewCode(null); }} disabled={degraded}
                  title={degraded ? LOCK_HINT : (viewRcp ? 'เปิดฟอร์มสูตรของชีทต้นทุนเมนู (เริ่มจากว่าง) — สูตร POS ข้างล่างไม่ได้ถูกคัดลอกมาให้' : '')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 disabled:opacity-50">
                  <Pencil size={12} /> {viewRcp ? 'สร้างสูตรในชีท' : 'แก้ไขสูตร'}
                </button>
                <button onClick={() => setViewCode(null)} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
              </div>
            </div>
            <div className="overflow-auto p-5">
              {viewRcp ? (
                <>
                  <div className="mb-3 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                    <Info size={14} className="flex-shrink-0 mt-0.5" />
                    <div>
                      เมนูนี้ยังไม่มีสูตรในชีทต้นทุนเมนู — ที่เห็นคือสูตรฝั่ง POS จากแท็บ RcpDtls
                      (จับคู่ด้วยชื่อ &quot;{viewRcp.name}&quot; · rts_id {viewRcp.rtsId})
                      <div className="mt-1 text-amber-700">
                        อ่านอย่างเดียว แก้จากหน้านี้ไม่ได้ และไม่มีข้อมูลต้นทุน เพราะ RcpDtls ไม่ได้เก็บราคาไว้
                      </div>
                    </div>
                  </div>
                  {rcpLoading && !viewRcpItems ? (
                    <div className="py-10 text-center text-slate-400">
                      <Loader2 className="animate-spin inline mr-2" size={16} /> กำลังโหลดสูตร…
                    </div>
                  ) : !viewRcpItems || !viewRcpItems.length ? (
                    <div className="py-10 text-center text-slate-400 text-sm">โหลดบรรทัดวัตถุดิบไม่ได้</div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-slate-500">
                        <tr className="text-xs font-bold">
                          <th className="px-3 py-2 text-left">#</th>
                          <th className="px-3 py-2 text-left">รหัส</th>
                          <th className="px-3 py-2 text-left">วัตถุดิบ</th>
                          <th className="px-3 py-2 text-right">ปริมาณใช้</th>
                          <th className="px-3 py-2 text-right">ต่อสูตร</th>
                          <th className="px-3 py-2 text-right">สัดส่วน/หน่วย</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {viewRcpItems.map((r, i) => {
                          const info = itemByKey[r.itemKey];
                          const offItem = info?.status === 'ปิดการใช้งาน';
                          return (
                            <tr key={i} className={offItem ? 'bg-rose-50/50' : ''}>
                              <td className="px-3 py-1.5 text-slate-400">{r.seq ?? i + 1}</td>
                              <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{r.itemCode}</td>
                              <td className="px-3 py-1.5">
                                {r.itemName}
                                {!info && (
                                  <span title="รหัสนี้ไม่มีในชีทวัตถุดิบของ QC/RD"
                                    className="ml-1.5 inline-block px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded-full text-[10px] font-medium align-middle">
                                    ไม่มีในทะเบียน
                                  </span>
                                )}
                                {offItem && (
                                  <span className="ml-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-rose-100 text-rose-600 rounded-full text-[10px] font-bold align-middle">
                                    <AlertTriangle size={9} /> ปิดใช้งาน
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono">{fmtQty(r.qty)}</td>
                              <td className="px-3 py-1.5 text-right font-mono text-slate-400">{fmtQty(r.rcpQty)}</td>
                              <td className="px-3 py-1.5 text-right font-mono text-slate-400">{fmtQty(r.portion)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </>
              ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500">
                  <tr className="text-xs font-bold">
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">รหัส</th>
                    <th className="px-3 py-2 text-left">วัตถุดิบ</th>
                    <th className="px-3 py-2 text-right">ยอดใช้</th>
                    <th className="px-3 py-2 text-right">ตัวแปลงหน่วย</th>
                    <th className="px-3 py-2 text-right">ราคาวัตถุดิบ</th>
                    <th className="px-3 py-2 text-right">ต้นทุน</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {viewBom.map((r, i) => {
                    const info = itemMap[r.itemCode];
                    const offItem = info?.status === 'ปิดการใช้งาน';
                    const subs = offItem ? (info?.subs || []) : [];
                    return (
                      <tr key={i} className={/ยกเลิก/.test(r.itemName) ? 'text-slate-300 line-through' : offItem ? 'bg-rose-50/50' : ''}>
                        <td className="px-3 py-1.5 text-slate-400">{r.seq || i + 1}</td>
                        <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{r.itemCode}</td>
                        <td className="px-3 py-1.5">
                          {r.itemName}
                          {r.srcName && (
                            <span title={r.srcBase ? `สูตรเดิมของ "${r.srcName}" ใช้ ${r.srcBase}` : ''}
                              className="ml-1.5 inline-block px-1.5 py-0.5 bg-sky-50 text-sky-600 border border-sky-100 rounded-full text-[10px] font-medium align-middle">
                              จาก {r.srcName}{r.srcFactor && r.srcFactor !== 1 ? ` ×${fmtQty(r.srcFactor)}` : ''}
                            </span>
                          )}
                          {r.tag && (
                            <span className="ml-1.5 inline-block px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded-full text-[10px] font-medium align-middle">
                              #{r.tag}
                            </span>
                          )}
                          {r.noDeduct && (
                            <span title="ไม่ถูกตัดสต็อกตามสูตร (ต้นทุนยังคิดปกติ)"
                              className="ml-1.5 inline-block px-1.5 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-full text-[10px] font-bold align-middle">
                              ไม่ตัด BOM
                            </span>
                          )}
                          {offItem && (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-rose-100 text-rose-600 rounded-full text-[10px] font-bold align-middle">
                              <AlertTriangle size={9} /> ปิดใช้งาน
                            </span>
                          )}
                          {subs.length > 0 && (
                            <div className="mt-0.5 text-[11px] text-sky-600 flex items-center gap-1 flex-wrap">
                              <ArrowRightLeft size={10} className="flex-shrink-0" />
                              ทดแทน: {subs.map(c => itemMap[c]?.name || c).join(' / ')}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono">{fmt(r.qty, 2)}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-400">{fmt(r.converter, 0)}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{fmt(r.itemPrice)}</td>
                        <td className="px-3 py-1.5 text-right font-mono font-semibold">{fmt(r.lineCost)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-indigo-200 font-bold">
                    <td colSpan={6} className="px-3 py-2 text-right">ต้นทุนรวม</td>
                    <td className="px-3 py-2 text-right font-mono text-indigo-600">
                      {fmt(viewBom.reduce((s, r) => s + (r.lineCost || 0), 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ───── Modal เพิ่ม/แก้ไขเมนู ───── */}
      {editMenu && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => !saving && setEditMenu(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-800">{editMenu.isNew ? '➕ เพิ่มเมนูใหม่' : `✏️ แก้ไขเมนู ${editMenu.code}`}</h3>
              <button onClick={() => setEditMenu(null)} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
            </div>

            <div className="p-5 overflow-auto space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-500">รหัสเมนู (POS)</label>
                  <input value={editMenu.code} disabled={!editMenu.isNew}
                    onChange={e => setEditMenu(m => ({ ...m, code: e.target.value }))}
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono disabled:bg-slate-50 disabled:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500">ชื่อเมนู</label>
                  <input value={editMenu.name} onChange={e => setEditMenu(m => ({ ...m, name: e.target.value }))}
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500">หมวดหมู่</label>
                  <select value={editMenu.group}
                    onChange={e => setEditMenu(m => ({ ...m, group: e.target.value, newGroupName: e.target.value === NEW_GROUP ? m.newGroupName : '' }))}
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    <option value="">— ไม่ระบุหมวดหมู่ —</option>
                    {groupList.map(g => <option key={g.code} value={g.code}>{g.name}</option>)}
                    <option value={NEW_GROUP}>＋ เพิ่มหมวดหมู่ใหม่…</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500">ราคาขาย (บาท)</label>
                  <input type="number" value={editMenu.price} onChange={e => setEditMenu(m => ({ ...m, price: e.target.value }))}
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs font-bold text-slate-500" title="1 สูตรตามรายการวัตถุดิบข้างล่างนี้ ทำได้ปริมาณเท่าไร">
                    ปริมาณที่ได้ต่อ 1 สูตร
                  </label>
                  <div className="mt-1 flex items-center gap-2">
                    <input type="number" min="0" step="any" value={editMenu.yieldQty} placeholder="เช่น 10"
                      onChange={e => setEditMenu(m => ({ ...m, yieldQty: e.target.value }))}
                      className="w-24 border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                    <input list="qcrd-yield-units" value={editMenu.yieldUnit} placeholder="หน่วย เช่น ชิ้น"
                      onChange={e => setEditMenu(m => ({ ...m, yieldUnit: e.target.value }))}
                      className="flex-1 min-w-0 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                    <datalist id="qcrd-yield-units">
                      {YIELD_UNITS.map(u => <option key={u} value={u} />)}
                    </datalist>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">เว้นว่างได้ ถ้ากรอกไว้ระบบจะคำนวณต้นทุนต่อหน่วยให้</p>
                </div>
              </div>

              {editMenu.group === NEW_GROUP && (
                <div className="p-3 bg-amber-50/70 border border-amber-100 rounded-xl">
                  <label className="text-xs font-bold text-slate-500">ชื่อหมวดหมู่ใหม่ (จะถูกเพิ่มลงชีท menucodegroup)</label>
                  <input value={editMenu.newGroupName} autoFocus
                    onChange={e => setEditMenu(m => ({ ...m, newGroupName: e.target.value }))}
                    placeholder="เช่น พิซซ่าหน้าใหม่"
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              )}

              {/* ดึงสูตรจากเมนูอื่นเข้ามารวม (เมนูเซ็ต/เมนูรวม) */}
              <div className="p-3 bg-sky-50/60 border border-sky-100 rounded-xl space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs font-bold text-slate-600 flex items-center gap-1.5">
                    <ClipboardList size={14} /> เพิ่มเมนูอื่นเข้ามาในสูตรนี้ (ดึงวัตถุดิบของเมนูนั้นมาทั้งชุด)
                  </span>
                  {dupCount > 0 && (
                    <button onClick={mergeDuplicates}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-sky-700 bg-white border border-sky-200 rounded-lg px-2.5 py-1 hover:bg-sky-50">
                      รวมวัตถุดิบซ้ำ {dupCount} รายการ
                    </button>
                  )}
                </div>
                <MenuPicker menus={menus} bom={bom} excludeCode={editMenu.code.trim()} onPick={importFromMenu} />
                {editMenu.sources.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 items-center">
                    <span className="text-[11px] font-bold text-slate-500">เมนูที่ดึงมา:</span>
                    {editMenu.sources.map(s => (
                      <span key={s.code}
                        title={s.locked
                          ? 'รวมรายการซ้ำไปแล้ว ปรับสัดส่วนต่อไม่ได้ — ถ้าจะแก้ให้ลบชุดนี้ออกแล้วดึงใหม่'
                          : 'แก้สัดส่วนแล้วยอดใช้ของวัตถุดิบชุดนี้จะคิดใหม่จากสูตรเดิมทันที'}
                        className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 bg-white border border-sky-200 text-sky-700 rounded-full text-[11px] font-medium">
                        {s.name}
                        <span className="text-slate-400">×</span>
                        {s.locked ? (
                          <span className="font-mono text-slate-500 pr-1">{s.factor} <span className="text-slate-400 font-sans">(รวมแล้ว)</span></span>
                        ) : (
                          <>
                            <input type="number" min="0" step="any" value={s.factor}
                              onChange={e => setSourceFactor(s.code, e.target.value)}
                              className="w-12 px-1 py-0.5 border border-sky-200 rounded text-[11px] font-mono text-right bg-sky-50/60 focus:outline-none focus:ring-1 focus:ring-sky-400" />
                            <button onClick={() => removeSource(s.code)} title="เอาวัตถุดิบชุดนี้ออก"
                              className="text-sky-300 hover:text-rose-500"><X size={11} /></button>
                          </>
                        )}
                      </span>
                    ))}
                  </div>
                )}
                {formMsg && (
                  <div className={`text-xs font-semibold flex items-center gap-1 ${formMsg.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {formMsg.ok ? <CheckCircle size={12} /> : <AlertCircle size={12} />}{formMsg.msg}
                  </div>
                )}
              </div>

              {usedByMenus.length > 0 && (
                <div className="p-3 bg-amber-50/70 border border-amber-100 rounded-xl text-xs text-amber-800 flex items-start gap-2">
                  <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                  <span>
                    สูตรนี้ถูกดึงไปใช้ใน <b>{usedByMenus.length} เมนู</b> ({usedByMenus.map(x => x.name).join(', ')})
                    {' '}— กดบันทึกแล้วระบบจะคิดยอดวัตถุดิบและต้นทุนของเมนูเหล่านั้นใหม่ตามสัดส่วนเดิมให้อัตโนมัติ
                  </span>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold text-slate-500">วัตถุดิบในสูตร (ยอดใช้เป็นหน่วยเล็ก เช่น กรัม · ตัวแปลง = หน่วยเล็กต่อ 1 หน่วยซื้อ)</label>
                  <button onClick={() => setEditMenu(m => ({ ...m, items: [...m.items, emptyIng()] }))}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800">
                    <Plus size={13} /> เพิ่มวัตถุดิบ
                  </button>
                </div>
                <div className="hidden sm:flex items-center gap-2 px-2 text-[11px] font-bold text-slate-400 uppercase tracking-wide">
                  <span className="flex-1 min-w-[240px]">วัตถุดิบ</span>
                  <span className="w-24 text-right">ยอดใช้</span>
                  <span className="w-24">หน่วยซื้อ</span>
                  <span className="w-24 text-right">ตัวแปลงหน่วย</span>
                  <span className="w-8" />
                </div>
                <datalist id="qcrd-item-units">
                  {itemUnits.map(u => <option key={u} value={u} />)}
                </datalist>
                <div className="space-y-2">
                  {editMenu.items.map((r, idx) => (
                    <IngredientRow key={idx} row={r} items={items}
                      unit={editMenu.unitEdits?.[r.itemCode] ?? (itemMap[r.itemCode]?.unit || '')}
                      onUnitChange={u => setEditMenu(m => ({ ...m, unitEdits: { ...m.unitEdits, [r.itemCode]: u } }))}
                      onChange={next => setEditMenu(m => ({ ...m, items: m.items.map((x, i) => i === idx ? next : x) }))}
                      onRemove={() => setEditMenu(m => ({ ...m, items: m.items.filter((_, i) => i !== idx) }))} />
                  ))}
                </div>
                <p className="text-[11px] text-slate-400 mt-1.5">
                  ช่อง "หน่วยซื้อ" แก้แล้วจะบันทึกลงข้อมูลวัตถุดิบ (ชีท item) ใช้ร่วมกันทุกเมนูที่ใช้วัตถุดิบตัวนั้น
                </p>
              </div>

              <div className="p-3 bg-indigo-50/60 rounded-xl text-sm space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-600 flex items-center gap-1.5"><Info size={14} /> ต้นทุนทั้งสูตรโดยประมาณ (คำนวณจากราคาวัตถุดิบปัจจุบัน)</span>
                  <span className="font-mono font-bold text-indigo-700">฿{fmt(estCost(editMenu.items))}</span>
                </div>
                {perYield > 0 && (
                  <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-indigo-100">
                    <span className="text-slate-600">
                      ต้นทุนต่อ 1 {editMenu.yieldUnit.trim() || 'หน่วย'} (จาก {fmtQty(perYield)} {editMenu.yieldUnit.trim() || 'หน่วย'}ต่อสูตร)
                      {parseFloat(editMenu.price) > 0 && (
                        <span className="text-slate-400"> · ราคาขาย {fmt(editMenu.price, 0)} บาท</span>
                      )}
                    </span>
                    <span className="font-mono font-bold text-indigo-700">฿{fmt(estCost(editMenu.items) / perYield)}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="p-5 border-t border-slate-100 flex items-center justify-end gap-2">
              <button onClick={() => setEditMenu(null)} disabled={saving}
                className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">ยกเลิก</button>
              <button onClick={handleSave} disabled={saving || degraded} title={degraded ? LOCK_HINT : ''}
                className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-indigo-500 hover:bg-indigo-600 disabled:bg-slate-200 disabled:text-slate-400 rounded-xl">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle size={15} />}
                {saving ? 'กำลังบันทึก…' : 'บันทึกเมนู'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ───── Modal จัดการหมวดหมู่ ───── */}
      {/* เปลี่ยนชื่อ/เพิ่มหมวด กระทบแค่รายชื่อหมวดกับชื่อหมวดที่โชว์ในตารางเมนู
          onSaved จึงโหลดคืนแค่สองชุดนั้น ไม่ต้องลากสูตรทุกบรรทัดของพันกว่าเมนู
          กับทะเบียนวัตถุดิบกลับมาด้วย */}
      {groupModal && (
        <GroupManager groups={groupList} menus={menus}
          onClose={() => setGroupModal(false)}
          onSaved={() => loadAll({ quiet: true, only: ['menugroup', 'menu'] })} />
      )}

      {srcModal && (
        <MenuSourcePicker
          existing={existingCodes}
          existingNames={existingNames}
          runningBase={runningBase}
          groupList={groupList}
          onClose={() => setSrcModal(false)}
          onPick={(row) => {
            // เลือกทีละตัว = เปิดฟอร์มเพิ่มเมนูที่กรอกให้แล้ว ยังไม่บันทึก
            // ผู้ใช้ใส่สูตรต่อได้ทันทีแล้วค่อยกดบันทึกเอง (เมนูที่ดึงมายังไงก็ต้องมาใส่สูตรอยู่ดี)
            setSrcModal(false);
            setFormMsg(null);
            setEditMenu({
              code: row.code, name: row.name,
              price: row.price === null || row.price === undefined ? '' : String(row.price),
              group: row.group || '', newGroupName: '',
              yieldQty: '', yieldUnit: '', unitEdits: {}, isNew: true,
              items: [emptyIng()], sources: [],
            });
          }}
          onSaved={(n) => {
            setToast({ ok: true, msg: `เพิ่มเมนูจากฐานข้อมูล ${n} รายการแล้ว` });
            loadAll({ quiet: true, only: ['menu'] });
          }} />
      )}
    </div>
  );
}

/* ════════════════ เพิ่มเมนูจากฐานข้อมูลของ POS ตัวอื่น ════════════════
 *
 * ต้นทางสามฐานบนเครื่องที่ร้าน อ่านผ่าน /api/qcrd-menu-source (อ่านอย่างเดียว):
 *   Aoringo.dbo.MenuItem  → บันทึกด้วยรหัส AO + รหัสต้นทาง
 *   HumlaiPOS.dbo.Menu    → บันทึกด้วยรหัส HM + รหัสต้นทาง
 *   NaraiPos.dbo.Item     → ใช้รหัสเดิม ไม่เติมตัวนำหน้า
 * บวกต้นทางที่สี่ "ข้าวกล่อง" อ่านจาก Google Sheet (lib/bentoMenuSheet.js) → รหัส BX
 *
 * การบันทึกใช้ action saveMenu ตัวเดิม ทีละเมนูตามลำดับ ไม่ได้เปิดทางเขียนใหม่
 *   - ได้ทั้งโหมดชีทและโหมด SQL ฟรี ๆ (ทั้งสองทางรู้จัก saveMenu อยู่แล้ว)
 *   - พลาดกลางทางแล้วยังบอกได้ว่าเมนูไหนเข้าแล้ว เมนูไหนยัง ซึ่งการยิงก้อนเดียวบอกไม่ได้
 *
 * ⚠️ เมนูที่รหัสขึ้นต้นด้วย AO/HM จะไม่มีวันจับคู่กับเลขไอเทมที่ POS ของนารายณ์ส่งมา
 *    (ระบบจับคู่ด้วย menu_key) จึงเป็นเมนูไว้คิดต้นทุน/ทำสูตรเท่านั้น ไม่โผล่ในรายงานยอดใช้
 *    ส่วนของ NaraiPos ที่ไม่เติมตัวนำหน้าจะจับคู่ได้ตามปกติ
 */

/** คีย์เทียบรหัสซ้ำ — ตัวพิมพ์เล็ก และเวอร์ชันที่ตัด 0 นำหน้าออก (กติกาเดียวกับ menu_key) */
function normCodeKeys(code) {
  const s = String(code ?? '').trim().toLowerCase();
  if (!s) return [];
  const stripped = s.replace(/^0+/, '');
  return stripped && stripped !== s ? [s, stripped] : [s];
}

/** ชื่อเมนูสำหรับเทียบซ้ำ — ตัดช่องว่างหัวท้าย ยุบช่องว่างซ้ำ และไม่สนตัวพิมพ์ */
function normMenuName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** เลขรันนิ่ง 6 หลัก (1 -> '000001') */
const pad6 = (n) => String(n).padStart(6, '0');

const SOURCE_NOTE = {
  aoringo: 'บันทึกแล้วรหัสจะขึ้นต้นด้วย AO',
  humlai: 'ระบบออกรหัสให้เป็น HM + เลขรันนิ่ง 6 หลัก (ต้นทางมีแต่ id 13 หลัก)',
  naraipos: 'ใช้รหัสเดิมไม่เติมตัวนำหน้า จึงจับคู่กับยอดขายในรายงานได้',
  bento: 'เมนูข้าวกล่องจาก Google Sheet — บันทึกแล้วรหัสจะขึ้นต้นด้วย BX',
};

async function askMenuSource(params) {
  const res = await fetch(`/api/qcrd-menu-source?${params}`, { cache: 'no-store' });
  const json = await res.json().catch(() => ({ status: 'error', message: 'เซิร์ฟเวอร์ตอบกลับมาไม่ใช่ JSON' }));
  if (json.status !== 'success') throw new Error(json.message || 'อ่านข้อมูลไม่สำเร็จ');
  return json.data;
}

function MenuSourcePicker({ existing, existingNames, runningBase, groupList, onClose, onSaved, onPick }) {
  const [schema, setSchema] = useState(null);      // ผลการจับคู่ของทั้งสามต้นทาง
  const [schemaErr, setSchemaErr] = useState('');  // อ่านผลจับคู่ไม่ได้ — ไม่ควรบังตารางที่ยังใช้ได้
  const [tab, setTab] = useState('aoringo');
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');          // ค่าที่หน่วงแล้ว (ยิงจริงด้วยตัวนี้)
  const [includeInactive, setIncludeInactive] = useState(false);
  const [result, setResult] = useState(null);      // { rows, limited, hiddenInactive, source }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState({});        // newCode -> แถวที่เลือกไว้ (ข้ามแท็บได้)
  const [group, setGroup] = useState('');
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(null);  // { done, total, name }
  const [saved, setSaved] = useState(null);        // { ok: [], fail: [] }

  // ต้นทางไหนอ่านได้บ้าง + จับคู่คอลัมน์ได้อะไร — ถามครั้งเดียวตอนเปิด
  useEffect(() => {
    let alive = true;
    askMenuSource('schema=1')
      .then(d => { if (alive) { setSchema(d); setSchemaErr(''); } })
      .catch(err => { if (alive) setSchemaErr(err.message); });
    return () => { alive = false; };
  }, []);

  // หน่วงพิมพ์ก่อนยิง — ทุกครั้งที่ยิงคือคำสั่ง SQL ที่เครื่องร้าน ไม่ควรยิงทุกตัวอักษร
  useEffect(() => {
    const t = setTimeout(() => setQuery(typed.trim()), 350);
    return () => clearTimeout(t);
  }, [typed]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    const qs = new URLSearchParams({ src: tab, limit: '100' });
    if (query) qs.set('q', query);
    if (includeInactive) qs.set('includeInactive', '1');
    askMenuSource(qs.toString())
      .then(d => { if (alive) { setResult(d); setLoading(false); } })
      .catch(err => { if (alive) { setError(err.message); setResult(null); setLoading(false); } });
    return () => { alive = false; };
  }, [tab, query, includeInactive]);

  const rows = result?.rows || [];
  const src = result?.source || {};
  const running = src.codeMode === 'running6';   // ระบบออกรหัสให้เอง ไม่ได้ใช้รหัสของต้นทาง

  // คีย์ของแถวที่เลือกไว้ — ขึ้นต้นด้วยชื่อต้นทางเสมอ เพื่อไม่ให้กลายเป็นคีย์ตัวเลขล้วน
  // (คีย์ที่เป็นเลขล้วนจะถูกเรียงใหม่ตามค่า ทำให้ลำดับที่ผู้ใช้เลือกหายไป ซึ่งเลขรันนิ่งใช้ลำดับนั้น)
  const keyOf = (r, id = src.id) => `${id}:${r.code}`;

  // รหัสซ้ำ: ต้นทางปกติเทียบด้วยรหัส · ต้นทางที่ระบบออกรหัสให้เองเทียบด้วยชื่อเมนู
  // ภายในตัวนำหน้าเดียวกัน (รหัสยังไม่เกิดจนกว่าจะบันทึก จึงเอามาเทียบไม่ได้)
  const isDup = (r) => (running
    ? Boolean(existingNames?.[String(src.prefix || '').toUpperCase()]?.has(normMenuName(r.name)))
    : normCodeKeys(r.newCode).some(k => existing.has(k)));

  const pickable = rows.filter(r => !isDup(r));
  const pickedList = Object.values(picked);
  const allPicked = pickable.length > 0 && pickable.every(r => picked[keyOf(r)]);

  // เลขรันนิ่งที่จะออกให้ — ไล่ตามลำดับที่เลือก แยกนับตามตัวนำหน้า นับต่อจากที่มีในทะเบียนแล้ว
  // คิดจาก pickedList (ทุกแท็บ) ไม่ใช่จากแถวที่เห็นอยู่ เพราะผู้ใช้สลับแท็บแล้วกดบันทึกได้
  const assigned = useMemo(() => {
    const out = {};
    const counter = {};
    pickedList.forEach(r => {
      if (r.codeMode !== 'running6') return;
      const p = String(r.prefix || '').toUpperCase();
      counter[p] = (counter[p] === undefined ? (runningBase?.[p] || 0) : counter[p]) + 1;
      out[keyOf(r, r.srcId)] = `${p}${pad6(counter[p])}`;
    });
    return out;
  }, [pickedList, runningBase]);   // eslint-disable-line react-hooks/exhaustive-deps

  /** รหัสที่จะบันทึกจริงของแถวนั้น ('' = ยังไม่ได้เลือก จึงยังไม่ออกเลขให้) */
  const codeFor = (r) => (r.codeMode === 'running6' || running
    ? (assigned[keyOf(r, r.srcId || src.id)] || '')
    : r.newCode);

  /**
   * กดที่แถว = เอาเมนูตัวนั้นไปเปิดฟอร์มเลย (ไม่บันทึกทันที)
   * รหัสของต้นทางแบบ running6 ยังไม่ถูกจองจนกว่าจะบันทึกจริง จึงให้เลขถัดไปที่ว่างอยู่
   * ถ้ากดหลายตัวติดกันโดยยังไม่บันทึก จะได้เลขเดียวกัน — กันด้วยการปิดหน้าต่างทันทีที่กด
   */
  const pickOne = (r) => {
    if (!onPick) return;
    const p = String(src.prefix || '').toUpperCase();
    const code = running ? `${p}${pad6((runningBase?.[p] || 0) + 1)}` : r.newCode;
    // หมวดจากต้นทางใช้ได้ต่อเมื่อรหัสตรงกับหมวดที่มีในทะเบียนจริง (NaraiPos.MenuCode ตรง ส่วน
    // Aoringo เป็น CategoryId และ HumLai เป็นชื่อไทย ซึ่งไม่ใช่รหัสหมวดของที่นี่) ไม่ตรงก็ใช้ที่เลือกท้ายหน้าต่าง
    const presetGroup = groupList.some(g => g.code === r.group) ? r.group : group;
    onPick({ code, name: r.name, price: r.price, group: presetGroup });
  };

  const toggle = (r) => setPicked(prev => {
    const k = keyOf(r);
    const next = { ...prev };
    if (next[k]) delete next[k];
    // จำต้นทางของแถวไว้ในตัวมันเอง — ตอนกดบันทึกอ่านจาก pickedList ซึ่งข้ามแท็บกันได้
    else next[k] = { ...r, srcId: src.id, prefix: src.prefix, codeMode: src.codeMode };
    return next;
  });
  const toggleAll = () => setPicked(prev => {
    const next = { ...prev };
    if (allPicked) pickable.forEach(r => delete next[keyOf(r)]);
    else pickable.forEach(r => { next[keyOf(r)] = { ...r, srcId: src.id, prefix: src.prefix, codeMode: src.codeMode }; });
    return next;
  });

  const doSave = async () => {
    if (!pickedList.length) return;
    setSaving(true);
    setSaved(null);
    const ok = [];
    const fail = [];
    for (let i = 0; i < pickedList.length; i++) {
      const row = pickedList[i];
      setProgress({ done: i, total: pickedList.length, name: row.name });
      const code = row.codeMode === 'running6'
        ? (assigned[keyOf(row, row.srcId)] || row.newCode)
        : row.newCode;
      try {
        // ช่องเดียวกับฟอร์ม "เพิ่มเมนู" ทุกช่อง — เมนูที่เพิ่งเพิ่มยังไม่มีสูตร (items ว่าง)
        await apiCall('saveMenu', {
          code,
          name: row.name,
          price: row.price === null || row.price === undefined ? '' : String(row.price),
          group, newGroupName: '', yieldQty: '', yieldUnit: '', items: [],
        });
        ok.push({ ...row, savedCode: code });
      } catch (err) {
        fail.push({ row: { ...row, savedCode: code }, msg: err.message || 'บันทึกไม่สำเร็จ' });
      }
    }
    setProgress(null);
    setSaving(false);
    setSaved({ ok, fail });
    // เอาตัวที่เข้าแล้วออกจากรายการที่เลือกไว้ เหลือไว้เฉพาะตัวที่ยังไม่ผ่าน กดซ้ำได้เลย
    setPicked(Object.fromEntries(fail.map(f => [keyOf(f.row, f.row.srcId), f.row])));
    if (ok.length) onSaved(ok.length);
  };

  const tabInfo = (id) => (schema || []).find(s => s.id === id);
  const active = tabInfo(tab);

  return (
    <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <Database size={18} className="text-indigo-500" /> เพิ่มเมนูจากฐานข้อมูล
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              <b>กดที่แถว</b> = เปิดฟอร์มเมนูที่กรอกรหัส/ชื่อ/ราคาให้แล้ว ใส่สูตรต่อได้เลย (ยังไม่บันทึกจนกว่าจะกดบันทึกในฟอร์ม)
              · <b>ติ๊กช่องซ้าย</b> = เลือกไว้หลายเมนูแล้วบันทึกรวดเดียว (ยังไม่มีสูตร ค่อยมาใส่ทีหลัง)
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 flex-shrink-0"><X size={20} /></button>
        </div>

        {/* แท็บต้นทาง — ต้นทางที่อ่านไม่ได้ยังกดเข้าไปดูสาเหตุได้ ไม่ซ่อนทิ้งเฉย ๆ */}
        <div className="px-5 pt-3 flex flex-wrap gap-2">
          {(schema || [{ id: 'aoringo', label: 'Aoringo' }, { id: 'humlai', label: 'HumlaiPOS' }, { id: 'naraipos', label: 'NaraiPos' }, { id: 'bento', label: 'ข้าวกล่อง (ชีท)' }]).map(sc => (
            <button key={sc.id} onClick={() => setTab(sc.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${
                tab === sc.id ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
              {sc.label}
              {sc.ok === false && <span className="ml-1.5 text-rose-500">• อ่านไม่ได้</span>}
              {sc.ok && <span className="ml-1.5 font-mono text-[10px] text-slate-400">{sc.rows?.toLocaleString?.() ?? ''}</span>}
            </button>
          ))}
        </div>

        <div className="px-5 pt-3 pb-3 flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="ค้นหารหัส / ชื่อเมนูในฐานนี้…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
            <input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)} className="rounded" />
            แสดงเมนูที่ปิดในต้นทางด้วย
          </label>
          {active?.ok && (
            <span className="text-[11px] text-slate-400 font-mono">{active.table}</span>
          )}
        </div>

        {error && (
          <div className="mx-5 mb-3 p-3 bg-rose-50 border border-rose-100 rounded-xl text-xs text-rose-700 whitespace-pre-wrap">{error}</div>
        )}
        {/* อ่านผลจับคู่คอลัมน์ไม่ได้ = แท็บไม่มีจำนวนแถวให้ดู แต่การค้นหายังใช้ได้ตามปกติ
            จึงเป็นข้อความเตือนสีเหลือง ไม่ใช่กล่องแดงที่ดูเหมือนทั้งหน้าต่างใช้ไม่ได้ */}
        {!error && schemaErr && (
          <div className="mx-5 mb-3 p-3 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-700 whitespace-pre-wrap">
            ดูรายละเอียดตาราง/คอลัมน์ของต้นทางไม่ได้ (ค้นหาและบันทึกยังใช้ได้ตามปกติ): {schemaErr}
          </div>
        )}
        {!error && active?.ok === false && (
          <div className="mx-5 mb-3 p-3 bg-rose-50 border border-rose-100 rounded-xl text-xs text-rose-700 whitespace-pre-wrap">{active.error}</div>
        )}

        <div className="flex-1 overflow-y-auto border-t border-slate-100">
          {loading ? (
            <div className="p-10 text-center text-slate-400 text-sm">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />กำลังอ่านทะเบียนเมนู…
            </div>
          ) : !rows.length ? (
            <div className="p-10 text-center text-slate-400 text-sm">
              {query ? `ไม่เจอเมนูที่ตรงกับ "${query}"` : 'ไม่มีข้อมูลในต้นทางนี้'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0">
                <tr className="text-left text-[11px] uppercase text-slate-400">
                  <th className="px-4 py-2 w-10">
                    <input type="checkbox" checked={allPicked} onChange={toggleAll} className="rounded" title="เลือกทั้งหน้า" />
                  </th>
                  <th className="px-4 py-2">รหัสต้นทาง → รหัสที่จะบันทึก</th>
                  <th className="px-4 py-2">ชื่อเมนู</th>
                  <th className="px-4 py-2 text-right">ราคา</th>
                  <th className="px-4 py-2">สถานะ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const dup = isDup(r);
                  const on = Boolean(picked[keyOf(r)]);
                  const willBe = codeFor(r);
                  return (
                    <tr key={keyOf(r)}
                      onClick={() => !dup && pickOne(r)}
                      title={dup ? 'มีเมนูนี้ในทะเบียนแล้ว' : 'กดเพื่อเปิดฟอร์มใส่สูตรของเมนูนี้'}
                      className={`border-b border-slate-50 ${dup ? 'bg-slate-50/70 text-slate-400' : `cursor-pointer ${on ? 'bg-indigo-50/60' : 'hover:bg-slate-50'}`}`}>
                      {/* ติ๊กช่องนี้ = เลือกไว้บันทึกรวดเดียวหลายเมนู (ไม่เปิดฟอร์ม) จึงต้องกันไม่ให้คลิกทะลุไปถึงแถว */}
                      <td className="px-4 py-2" onClick={e => { e.stopPropagation(); if (!dup) toggle(r); }}>
                        <input type="checkbox" checked={on} disabled={dup} readOnly className="rounded"
                          title="เลือกไว้บันทึกพร้อมกันหลายเมนู (ยังไม่ใส่สูตร)" />
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">
                        <span className="text-slate-400">{r.code}</span>
                        <span className="mx-1.5 text-slate-300">→</span>
                        {willBe ? (
                          <span className="font-semibold text-indigo-600">{willBe}</span>
                        ) : (
                          // ต้นทางที่ระบบออกเลขให้: เลขจะรู้ก็ต่อเมื่อเลือกแล้ว เพราะไล่ตามลำดับที่เลือก
                          <span className="text-slate-300" title="เลือกแถวนี้แล้วระบบจะออกเลขรันนิ่งให้">
                            {String(src.prefix || '')}······
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2">{r.name}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs">{r.price === null ? '—' : fmt(r.price)}</td>
                      <td className="px-4 py-2">
                        {dup ? (
                          <span className="px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-full text-[10px] font-bold">มีในระบบแล้ว</span>
                        ) : !r.active ? (
                          <span className="px-2 py-0.5 bg-rose-50 text-rose-600 border border-rose-200 rounded-full text-[10px] font-bold">ปิดในต้นทาง</span>
                        ) : (
                          <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full text-[10px] font-bold">เพิ่มได้</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {result?.limited && (
            <p className="px-4 py-3 text-[11px] text-amber-700 bg-amber-50 border-t border-amber-100">
              แสดงได้สูงสุด 100 รายการต่อครั้ง — พิมพ์ค้นหาให้แคบลงถ้ายังไม่เจอตัวที่ต้องการ
            </p>
          )}
        </div>

        {saved && (
          <div className="px-5 py-3 border-t border-slate-100 text-xs space-y-1">
            {saved.ok.length > 0 && (
              <p className="text-emerald-700 flex items-start gap-1.5">
                <CheckCircle size={13} className="mt-0.5 flex-shrink-0" />
                <span>เพิ่มแล้ว {saved.ok.length} เมนู: {saved.ok.map(r => r.savedCode || r.newCode).join(', ')}</span>
              </p>
            )}
            {saved.fail.map(f => (
              <p key={keyOf(f.row, f.row.srcId)} className="text-rose-700 flex items-start gap-1.5">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
                <span>{f.row.savedCode || f.row.newCode} {f.row.name} — {f.msg}</span>
              </p>
            ))}
          </div>
        )}

        <div className="p-4 border-t border-slate-100 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-slate-500">
            เลือกไว้ <b className="text-slate-700">{pickedList.length}</b> เมนู
            {SOURCE_NOTE[tab] && <span className="ml-1.5 text-slate-400">· {SOURCE_NOTE[tab]}</span>}
            {progress && (
              <span className="ml-2 text-indigo-600">กำลังบันทึก {progress.done + 1}/{progress.total} — {progress.name}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <select value={group} onChange={e => setGroup(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="">ยังไม่จัดหมวด</option>
              {groupList.map(g => <option key={g.code} value={g.code}>{g.name}</option>)}
            </select>
            <button onClick={onClose} className="px-4 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">ปิด</button>
            <button onClick={doSave} disabled={!pickedList.length || saving}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-500 hover:bg-indigo-600 disabled:bg-slate-200 disabled:text-slate-400 rounded-xl">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              บันทึก {pickedList.length || ''} เมนู
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// แถววัตถุดิบในฟอร์ม: ค้นหาไอเทมจากชีท item + กรอกยอดใช้/หน่วยซื้อ/ตัวแปลง
// unit/onUnitChange = หน่วยซื้อของวัตถุดิบ (ชีท item คอลัมน์ D) แก้จากในฟอร์มเมนูได้เลย
//
// "หน่วยใช้" (หน่วยเล็กที่ช่องยอดใช้กรอกเป็นหน่วยนั้น) ดึงจากทะเบียนวัตถุดิบมาแสดงสด ๆ ทุกครั้ง
// ไม่ได้เก็บซ้ำไว้ในสูตร — แก้ที่ทะเบียนที่เดียวแล้วทุกเมนูที่ใช้วัตถุดิบตัวนั้นเปลี่ยนตามทันที
// (เก็บซ้ำเมื่อไหร่ = ต้องคอยซิงก์สองที่ ซึ่งไม่มีวันตรงกันได้จริง) สูตรเก่าจึงได้ไปด้วยเลย
// ไม่ต้องไล่แก้ย้อนหลัง ส่วนวัตถุดิบที่ยังไม่ได้ตั้งหน่วยใช้ ก็แค่ไม่ขึ้นอะไร ไม่มีอะไรพัง
function IngredientRow({ row, items, unit, onUnitChange, onChange, onRemove }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const info = items.find(i => i.code === row.itemCode);
  // ตัวแปลงหน่วยในสูตรไม่ตรงกับที่ตั้งไว้ในข้อมูลวัตถุดิบ → ฟ้องให้เห็น กดใช้ค่าจากวัตถุดิบได้
  const convMismatch = Boolean(row.itemCode && info?.converter && parseFloat(row.converter) !== info.converter);
  // หน่วยของตัวเลขในช่อง "ยอดใช้" — ของเดิมมีแต่ตัวเลขลอย ๆ ต้องเปิดไปดูทะเบียนเองว่ากรัมหรือมล.
  const useUnit = String(info?.useUnit || '').trim();

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    // เทียบรหัสมองข้าม 0 นำหน้า (ระบบคลังใช้ 01000078 / ชีท item เก็บ 1000078)
    const strip = s => s.replace(/^0+/, '');
    return items.filter(i =>
      i.code.toLowerCase().includes(q) || strip(i.code.toLowerCase()).includes(strip(q)) ||
      i.name.toLowerCase().includes(q)
    ).slice(0, 12);
  }, [items, query]);

  return (
    <div className="flex flex-wrap items-start gap-2 p-2 bg-slate-50/70 rounded-xl border border-slate-100">
      <div className="relative flex-1 min-w-[240px]">
        {row.itemCode ? (
          <div className="flex items-center justify-between gap-2 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm">
            <span className="truncate">
              <span className="font-mono text-xs text-slate-400 mr-1.5">{row.itemCode}</span>{row.itemName}
              {items.find(i => i.code === row.itemCode)?.status === 'ปิดการใช้งาน' && (
                <span className="ml-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-rose-100 text-rose-600 rounded-full text-[10px] font-bold align-middle">ปิดใช้งาน</span>
              )}
              {row.srcName && (
                <span title={row.srcBase !== undefined ? `สูตรเดิมใช้ ${row.srcBase}` : 'ยอดรวมจากหลายเมนู'}
                  className="ml-1.5 inline-block px-1.5 py-0.5 bg-sky-50 text-sky-600 border border-sky-100 rounded-full text-[10px] font-medium align-middle">
                  จาก {row.srcName}
                  {row.srcBase > 0 && parseFloat(row.qty) !== row.srcBase && ` (สูตรเดิม ${row.srcBase})`}
                </span>
              )}
            </span>
            <button onClick={() => { onChange({ ...row, itemCode: '', itemName: '' }); setQuery(''); }}
              className="text-slate-300 hover:text-rose-500 flex-shrink-0"><X size={14} /></button>
          </div>
        ) : (
          <>
            <input value={query} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
              onChange={e => { setQuery(e.target.value); setOpen(true); }}
              placeholder="พิมพ์ค้นหาวัตถุดิบ (รหัส/ชื่อ)…"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            {open && suggestions.length > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-56 overflow-auto">
                {suggestions.map(s => (
                  // เลือกวัตถุดิบแล้วดึงตัวแปลงหน่วยของวัตถุดิบนั้นมาให้เลย (ชีท item คอลัมน์ I)
                  <button key={s.code} onMouseDown={() => {
                    onChange({
                      ...row, itemCode: s.code, itemName: s.name,
                      converter: s.converter || row.converter || 1000,
                      // วัตถุดิบที่ตั้งประเภทเป็นแพ็กเกจจิ้งไว้ ให้ติดแท็กแพ็กเกจจิ้งให้เลย (เปลี่ยนเองได้)
                      tag: s.itemType === TAG_PACKAGING ? TAG_PACKAGING : TAG_MATERIAL,
                    });
                    setOpen(false);
                  }}
                    className="block w-full text-left px-3 py-2 text-sm hover:bg-indigo-50">
                    <span className="font-mono text-xs text-slate-400 mr-1.5">{s.code}</span>{s.name}
                    <span className="float-right text-xs text-slate-400 font-mono">
                      {s.converter ? `×${s.converter}` : ''}{s.useUnit ? ` ${s.useUnit}` : ''} {s.price != null ? s.price.toLocaleString() : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {/* หน่วยใช้แปะไว้ "ในช่อง" ทางซ้าย (ตัวเลขชิดขวาอยู่แล้ว จึงไม่ชนกัน) แทนที่จะเป็นช่องใหม่
          ไม่งั้นแถวที่วัตถุดิบยังไม่ได้ตั้งหน่วยใช้จะกว้างไม่เท่ากัน แล้วคอลัมน์เลื่อนไม่ตรงหัวตาราง */}
      <div className="relative w-24">
        <input type="number" value={row.qty} onChange={e => onChange({ ...row, qty: e.target.value })}
          placeholder="ยอดใช้"
          title={useUnit
            ? `ยอดใช้ต่อ 1 จาน หน่วยเป็น "${useUnit}" ตามที่ตั้งไว้ในทะเบียนวัตถุดิบ`
            : 'ยอดใช้ต่อ 1 จาน (หน่วยเล็ก) — ตั้ง "หน่วยใช้" ให้วัตถุดิบตัวนี้ในหน้าวัตถุดิบ แล้วหน่วยจะมาขึ้นตรงนี้'}
          className={`w-full py-2 pr-2 border border-slate-200 rounded-lg text-sm font-mono text-right bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 ${useUnit ? 'pl-9' : 'pl-2'}`} />
        {useUnit && (
          <span title="หน่วยใช้ของวัตถุดิบตัวนี้ (แก้ได้ที่หน้าวัตถุดิบ)"
            className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-slate-400 pointer-events-none max-w-[28px] truncate">
            {useUnit}
          </span>
        )}
      </div>
      <input list="qcrd-item-units" value={unit} disabled={!row.itemCode}
        onChange={e => onUnitChange(e.target.value)} placeholder="หน่วย"
        title="หน่วยซื้อของวัตถุดิบ (เช่น กก. / ถุง / ขวด) — บันทึกลงชีท item คอลัมน์ D ใช้ร่วมกันทุกเมนู"
        className="w-24 px-2 py-2 border border-slate-200 rounded-lg text-sm bg-white disabled:bg-slate-100 disabled:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      <input type="number" value={row.converter} onChange={e => onChange({ ...row, converter: e.target.value })} placeholder="ตัวแปลง" title="หน่วยเล็กต่อ 1 หน่วยซื้อ เช่น 1000 = ซื้อเป็น กก. ใช้เป็นกรัม"
        className={`w-24 px-2 py-2 border rounded-lg text-sm font-mono text-right bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 ${convMismatch ? 'border-amber-300 bg-amber-50/60' : 'border-slate-200'}`} />
      <button onClick={onRemove} className="p-2 text-slate-300 hover:text-rose-500"><Trash2 size={15} /></button>

      <div className="w-full flex flex-wrap items-center gap-2 pl-1">
        <select value={row.tag === TAG_PACKAGING ? TAG_PACKAGING : TAG_MATERIAL}
          onChange={e => onChange({ ...row, tag: e.target.value })}
          title="แท็กกำกับวัตถุดิบแถวนี้ (ชีท BOM คอลัมน์แยก) ไม่กระทบการคำนวณต้นทุน"
          className="flex-1 min-w-[200px] px-2 py-1 border border-slate-200 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
          {TAG_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <label title="ไม่ถูกตัดสต็อกตามสูตรเวลาขาย — ต้นทุนของแถวนี้ยังถูกคิดรวมในเมนูตามปกติ"
          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-semibold border cursor-pointer select-none ${row.noDeduct ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-white text-slate-500 border-slate-200'}`}>
          <input type="checkbox" checked={Boolean(row.noDeduct)}
            onChange={e => onChange({ ...row, noDeduct: e.target.checked })} className="accent-amber-500" />
          ไม่ตัด BOM
        </label>
        {useUnit && row.converter > 0 && (
          <span title="อ่านจากทะเบียนวัตถุดิบ (ตัวแปลงหน่วย + หน่วยใช้) — ไว้กันกรอกยอดใช้ผิดหน่วย"
            className="inline-block px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full text-[10px] font-medium">
            1 {unit || 'หน่วยซื้อ'} = {Number(row.converter).toLocaleString()} {useUnit}
          </span>
        )}
        {info?.itemType === 'แพ็กเกจจิ้ง' && (
          <span className="inline-block px-2 py-0.5 bg-violet-50 text-violet-700 border border-violet-200 rounded-full text-[10px] font-bold">
            แพ็กเกจจิ้ง{info.usedWhen && info.usedWhen !== 'ทั้งสอง' ? ` · ${info.usedWhen}` : ''}
          </span>
        )}
      </div>

      {convMismatch && (
        <div className="w-full flex items-center gap-1.5 pl-1 text-[11px] text-amber-700">
          <AlertTriangle size={11} className="flex-shrink-0" />
          ตัวแปลงหน่วยไม่ตรงกับข้อมูลวัตถุดิบ (ในชีท item ตั้งไว้ {info.converter.toLocaleString()})
          <button onClick={() => onChange({ ...row, converter: info.converter })}
            className="font-semibold underline hover:text-amber-900">ใช้ค่า {info.converter.toLocaleString()}</button>
        </div>
      )}
    </div>
  );
}

// ค้นหาเมนูที่มีสูตรอยู่แล้ว เพื่อดึงวัตถุดิบทั้งชุดเข้ามาในสูตรที่กำลังแก้
// factor = ดึงมากี่ส่วนของสูตรนั้น (1 = ทั้งสูตร, 0.2 = 20%)
function MenuPicker({ menus, bom, excludeCode, onPick }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [factor, setFactor] = useState('1');

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return menus
      .filter(m => m.code !== excludeCode && (bom[m.code]?.items?.length || 0) > 0)
      .filter(m => !q || m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
        || (m.groupName || '').toLowerCase().includes(q))
      .slice(0, 15);
  }, [menus, bom, query, excludeCode]);

  const f = parseFloat(factor);
  const pct = f > 0 ? Math.round(f * 100) : 0;

  return (
    <div>
      <div className="flex items-start gap-2">
        <div className="relative flex-1 min-w-0">
          <Search size={15} className="absolute left-3 top-[18px] -translate-y-1/2 text-slate-400" />
          <input value={query} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={e => { setQuery(e.target.value); setOpen(true); }}
            placeholder="พิมพ์ค้นหาเมนูที่ต้องการดึงสูตร (รหัส/ชื่อ/หมวดหมู่)…"
            className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sky-500" />
          {open && suggestions.length > 0 && (
            <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-60 overflow-auto">
              {suggestions.map(m => (
                <button key={m.code} onMouseDown={() => { onPick(m, factor); setQuery(''); setOpen(false); }}
                  className="block w-full text-left px-3 py-2 text-sm hover:bg-sky-50">
                  <span className="font-mono text-xs text-slate-400 mr-1.5">{m.code}</span>{m.name}
                  <span className="float-right text-xs text-slate-400">{bom[m.code].items.length} วัตถุดิบ</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex-shrink-0">
          <input type="number" min="0" step="any" value={factor} onChange={e => setFactor(e.target.value)}
            title="ดึงมากี่ส่วนของสูตรนั้น: 1 = ทั้งสูตร, 0.2 = 20% ของสูตร, 2 = 2 เท่า"
            className="w-20 px-2 py-2 border border-slate-200 rounded-lg text-sm font-mono text-right bg-white focus:outline-none focus:ring-2 focus:ring-sky-500" />
        </div>
      </div>
      <p className="text-[11px] text-slate-500 mt-1">
        ช่องขวา = สัดส่วนของสูตรที่จะดึงมา · 1 = ทั้งสูตร · 0.2 = 20% ของสูตร · 2 = 2 เท่า
        {f > 0 && f !== 1 && <span className="text-sky-600 font-semibold"> (ตอนนี้ {pct}% ของสูตร)</span>}
      </p>
    </div>
  );
}

// จัดการหมวดหมู่เมนู (ชีท menucodegroup): เปลี่ยนชื่อหมวดเดิม / เพิ่มหมวดใหม่
function GroupManager({ groups, menus, onClose, onSaved }) {
  const [drafts, setDrafts] = useState(() => Object.fromEntries(groups.map(g => [g.code, g.name])));
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const countByGroup = useMemo(() => {
    const c = {};
    menus.forEach(m => { if (m.group) c[m.group] = (c[m.group] || 0) + 1; });
    return c;
  }, [menus]);

  const run = async (key, payload, okMsg) => {
    setBusy(key);
    setMsg(null);
    try {
      const res = await apiCall('saveMenuGroup', payload);
      setMsg({ ok: syncOk(res), msg: okMsg + syncNote(res) });
      onSaved();
    } catch (err) {
      setMsg({ ok: false, msg: err.message || 'บันทึกไม่สำเร็จ' });
    } finally {
      setBusy('');
    }
  };

  const addGroup = async () => {
    const name = newName.trim();
    if (!name) { setMsg({ ok: false, msg: 'กรุณากรอกชื่อหมวดหมู่' }); return; }
    await run('__add__', { name }, `เพิ่มหมวดหมู่ "${name}" แล้ว`);
    setNewName('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-slate-800">จัดการหมวดหมู่เมนู</h3>
            <p className="text-xs text-slate-500 mt-0.5">{groups.length} หมวดในชีท menucodegroup</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
        </div>

        <div className="p-5 overflow-auto space-y-2">
          {groups.length === 0 && <p className="text-sm text-slate-400 text-center py-4">ยังไม่มีหมวดหมู่</p>}
          {groups.map(g => {
            const changed = (drafts[g.code] ?? g.name).trim() !== g.name;
            return (
              <div key={g.code} className="flex items-center gap-2">
                <span className="font-mono text-xs text-slate-400 w-10 flex-shrink-0">{g.code}</span>
                <input value={drafts[g.code] ?? g.name}
                  onChange={e => setDrafts(d => ({ ...d, [g.code]: e.target.value }))}
                  className="flex-1 min-w-0 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <span className="text-[11px] text-slate-400 w-14 text-right flex-shrink-0">{countByGroup[g.code] || 0} เมนู</span>
                <button disabled={!changed || Boolean(busy)}
                  onClick={() => run(g.code, { code: g.code, name: (drafts[g.code] || '').trim() }, `เปลี่ยนชื่อหมวดเป็น "${(drafts[g.code] || '').trim()}" แล้ว`)}
                  className="p-1.5 rounded-lg border border-slate-200 text-slate-500 disabled:opacity-30 hover:bg-slate-50 flex-shrink-0">
                  {busy === g.code ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                </button>
              </div>
            );
          })}
        </div>

        <div className="p-5 border-t border-slate-100 space-y-2">
          <label className="text-xs font-bold text-slate-500">เพิ่มหมวดหมู่ใหม่</label>
          <div className="flex items-center gap-2">
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="ชื่อหมวดหมู่"
              className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <button onClick={addGroup} disabled={Boolean(busy)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-indigo-500 hover:bg-indigo-600 disabled:bg-slate-200 rounded-xl">
              {busy === '__add__' ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} เพิ่ม
            </button>
          </div>
          {msg && (
            <div className={`text-xs font-semibold flex items-center gap-1 ${msg.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
              {msg.ok ? <CheckCircle size={12} /> : <AlertCircle size={12} />}{msg.msg}
            </div>
          )}
          <p className="text-[11px] text-slate-400">
            เปลี่ยนชื่อหมวดจะมีผลกับทุกเมนูในหมวดนั้นทันที · ถ้าต้องการย้ายเมนูไปหมวดอื่น ให้แก้ที่ฟอร์มของเมนูนั้น
          </p>
        </div>
      </div>
    </div>
  );
}
