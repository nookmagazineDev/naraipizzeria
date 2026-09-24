import React, { useState, useEffect, useMemo } from 'react';
import { PackageSearch, Search, Loader2, AlertCircle, Save, CheckCircle, Info, Pencil, X, Plus, ArrowRightLeft, Trash2, AlertTriangle, UploadCloud, Download, Database, Copy } from 'lucide-react';
import { apiCall, syncNote, syncOk, syncSql } from '../lib/qcrdApi';
import { useBranches } from '../lib/useBranches';

/*
 * QC/RD — วัตถุดิบ: รหัส / ชื่อ / หน่วย / ราคาต้นทุน / สถานะ / ไอเทมทดแทน / หมวดสโตร์
 * ข้อมูลมาจากชีท item (1v8WRT…) หรือจากตาราง stock_item ใน SQL Server ตาม env QCRD_SOURCE
 * — /api/qcrd คืนรูปแบบเดียวกันทั้งสองทาง หน้านี้จึงไม่ต้องรู้ว่าอ่านมาจากไหน
 * - หน่วย (คอลัมน์ D) ว่าง → วิเคราะห์จากชื่ออัตโนมัติ (badge "วิเคราะห์") + ปุ่มบันทึกกลับ
 * - แก้ไขได้: ชื่อ (B), ราคา (C), สถานะ (E), ไอเทมทดแทนสูงสุด 3 ตัว (F–H), ตัวแปลงหน่วย (I),
 *   สาขาที่ใช้ (J), itemID ของ POS (K) + หน่วยเบิก (L), หมวดสโตร์ (N — ตำแหน่งจัดเก็บ เช่น ของแห้ง/ห้องผัก/ตู้1)
 *   ลบได้ (ทั้งแถว) — โหมดชีททั้งแก้ไขและลบส่ง _row ไประบุแถวเผื่อรหัสซ้ำ (ไม่งั้นโดนแถวแรกเสมอ),
 *   โหมด SQL คีย์ด้วยรหัสจึงไม่มีแถวซ้ำ
 *   ผ่าน action: saveItem / addItem / deleteItem (ดู lib/qcrdApi.js)
 * - ปุ่ม "เพิ่มจากฐานข้อมูล" ดึงวัตถุดิบที่มีอยู่จริงในข้อมูลที่ใช้งานอยู่ (ฐาน InventoryNarai:
 *   สูตรเมนู qcrd_bom · แพลนสั่งของ stock_plan · ปิดรอบ stock_closing) แต่ยังไม่มีในทะเบียนนี้
 *   ผ่าน /api/qcrd-item-source แล้วบันทึกด้วย action addItem ตัวเดิม — ดู ItemSourcePicker ท้ายไฟล์
 * - ปุ่ม "คัดลอกจากสาขาอื่น" (โหมด SQL) ให้สาขาหนึ่งมีวัตถุดิบชุดเดียวกับสาขาต้นแบบในครั้งเดียว
 *   ผ่าน action copyBranchItems — เพิ่มเข้าไป หรือให้เหมือนต้นแบบเป๊ะ (เอาตัวที่ต้นแบบไม่ใช้ออกด้วย)
 */

const fmt = v => (v === null || v === undefined || isNaN(v)) ? '—'
  : Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ค่าจากช่องกรอกเป็นสตริงเสมอ — ตารางกับตัวกรองคาดหวังตัวเลขหรือ null (ว่าง = ยังไม่ได้กรอก ไม่ใช่ 0)
const numOrNull = (v) => {
  const t = String(v ?? '').trim();
  if (t === '') return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * แถวในตารางที่สะท้อนค่าที่เพิ่งบันทึก — ใช้แปะทับทันทีโดยไม่ต้องรอโหลดข้อมูลใหม่ทั้งชุด
 *
 * "สาขาที่ใช้" เอาชุดที่ฝั่งเซิร์ฟเวอร์อ่านกลับมาจากฐาน/ชีทหลังเขียนเสร็จก่อนเสมอ (saved.branches)
 * ไม่ใช่ค่าที่กรอกในฟอร์ม — ที่เห็นบนตารางจึงเป็นของจริงที่เข้าไปแล้ว ไม่ใช่การเดา
 * (เซิร์ฟเวอร์รุ่นเก่าที่ยังไม่คืนช่องนี้มา ค่อยถอยไปใช้ค่าที่ส่งไป แล้วให้การโหลดรอบถัดไปแก้ให้)
 *
 * @param {object} sent    payload ชุดเดียวกับที่ยิงไป /api/qcrd-save
 * @param {object} saved   res.data ที่ตอบกลับมา
 * @param {{source?: string, prev?: object|null}} opts
 */
export function savedItemRow(sent, saved = {}, { source = 'sheet', prev = null } = {}) {
  const unit = String(sent.unit || '').trim();
  return {
    ...(prev || {}),
    code: String(sent.code || '').trim(),
    name: String(sent.name || '').trim(),
    price: numOrNull(sent.price),
    unit: unit || (prev?.unit || ''),
    // กรอกหน่วยเองแล้ว = ไม่ใช่หน่วยที่ระบบวิเคราะห์ให้อีกต่อไป (ป้าย "วิเคราะห์" ต้องหาย)
    unitSource: unit ? (source === 'sql' ? 'sql' : 'sheet') : (prev?.unitSource || 'auto'),
    status: sent.status || 'ใช้งาน',
    subs: [...(sent.subs || [])],
    converter: numOrNull(sent.converter),
    usedBranches: Array.isArray(saved.branches) ? [...saved.branches] : [...(sent.branches || [])],
    storeCategory: String(sent.storeCategory || '').trim(),
    posItemId: String(sent.posItemId || '').trim(),
    requestUnit: String(sent.requestUnit || '').trim(),
    itemType: sent.itemType || '',
    usedWhen: sent.usedWhen || '',
    useUnit: String(sent.useUnit || '').trim(),
    _row: saved.row ?? prev?._row,
  };
}

/** เทียบรายชื่อสาขาแบบไม่สนลำดับ — ใช้ตรวจว่าที่อ่านกลับมาตรงกับที่เพิ่งบันทึกไหม */
const sameBranches = (a = [], b = []) =>
  [...a].map(String).sort().join(',') === [...b].map(String).sort().join(',');

// เทียบรหัสแบบมองข้ามเลข 0 นำหน้า — ระบบคลังใช้ 01000078 แต่ชีท item เก็บ 1000078
const codeMatch = (code, q) => {
  const c = String(code).toLowerCase(), s = q.toLowerCase();
  return c.includes(s) || c.replace(/^0+/, '').includes(s.replace(/^0+/, ''));
};

// รหัสเดียวกันในสองที่เขียนไม่เหมือนกัน (01000078 กับ 1000078) — เทียบด้วยรูปที่ตัด 0 นำหน้าแล้ว
// ชุดเดียวกับ item_key ที่ฝั่ง SQL ใช้จับคู่ ตัวเลือก "เพิ่มจากฐานข้อมูล" ใช้กันไม่ให้เลือกตัวที่มีอยู่แล้ว
const normKey = (code) => String(code || '').trim().replace(/^0+/, '').toLowerCase();

// ประเภท (ชีท item คอลัมน์ O) มีแค่ 2 ค่า: วัตถุดิบ (ค่าเริ่มต้นเสมอ) หรือ แพ็กเกจจิ้ง
// ใช้กับ (คอลัมน์ P) มีความหมายเฉพาะกับแพ็กเกจจิ้ง: ไว้แยกต้นทุนทานที่ร้าน vs ห่อกลับบ้านตอนตัดสูตร
// ของเดิมในชีทที่คอลัมน์ O ยังว่าง ถือเป็น "วัตถุดิบ" และจะถูกเขียนค่าลงไปเมื่อบันทึกครั้งถัดไป
const MATERIAL = 'วัตถุดิบ';
const PACKAGING = 'แพ็กเกจจิ้ง';
const USED_WHEN = ['ทั้งสอง', 'ทานที่ร้าน', 'ห่อกลับบ้าน'];
// ค่าใน dropdown ประเภทที่แปลว่า "ขอพิมพ์ชื่อใหม่" — ตั้งชื่อประเภทเองได้ตามกลุ่มที่ร้านใช้จริง
// (เนื้อสัตว์ · ผัก · เครื่องปรุง ฯลฯ) ส่วน 'แพ็กเกจจิ้ง' ยังมีความหมายพิเศษเหมือนเดิม
const NEW_TYPE = '__newtype__';
// หน่วยใช้ที่เจอบ่อยในสูตร — พิมพ์หน่วยอื่นเองได้ ช่องนี้เป็น datalist ไม่ใช่ dropdown ตายตัว
const USE_UNITS = ['กรัม', 'มล.', 'ชิ้น', 'ใบ', 'ฟอง', 'แผ่น', 'ซอง', 'ที่', 'ลูก', 'ตัว'];

// ข้อความอธิบายตอนหน้าถูกล็อกไม่ให้แก้ (โหมด SQL ที่อ่านไม่ได้แล้วถอยไปอ่านชีท) — ชุดเดียวกับหน้าเมนู QC/RD
const LOCK_HINT = 'ตอนนี้อ่านข้อมูลจาก SQL ไม่ได้ กำลังแสดงข้อมูลจากชีทแทน — ' +
  'ถ้าบันทึกตอนนี้จะเขียนทับของจริงด้วยข้อมูลที่อาจเก่ากว่า จึงล็อกไว้ก่อน (กดรีเฟรชเมื่อ SQL กลับมา)';

// รายชื่อสาขาสำหรับเลือก "สาขาที่ใช้ไอเทม" มาจากทะเบียนกลาง (HR → จัดการสาขา)
// ชุดเดียวกับหน้าค่าใช้จ่ายและหน้าดูสแกนหน้า — ดู lib/useBranches.js

export default function QcRdItems() {
  // ปิดการใช้งานสาขาไหนในทะเบียน สาขานั้นจะหายจากตัวเลือกนี้ แต่ค่าที่เคยติ๊กไว้ในชีทยังอยู่เหมือนเดิม
  const { codes: BRANCHES } = useBranches();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [unitFilter, setUnitFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [storeFilter, setStoreFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');   // '' = ทุกประเภท · ที่เหลือเทียบกับชื่อประเภทตรง ๆ
  const [branchFilter, setBranchFilter] = useState(''); // '' = ทุกสาขา, รหัสสาขา, NO_BRANCH
  const [posFilter, setPosFilter] = useState('');     // '' = ทุกรายการ, NO_POS, DUP_POS
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null); // { ok, msg }
  // ข้อความผลการบันทึก/ลบ "ในกล่อง" — กล่องเป็น fixed inset-0 z-50 คลุมทั้งจอพร้อมฉากดำ
  // แถบเตือนของหน้า (toast) จึงไปอยู่ข้างหลังกล่อง คนกดไม่เห็นเลยว่าบันทึกไม่ผ่านเพราะอะไร
  // อาการที่เจอคือ "กดบันทึกแล้วเงียบ ไม่ไปไหน" ทั้งที่มีเหตุผลรออ่านอยู่
  // (หน้าเมนู QC/RD ใช้ formMsg แบบนี้อยู่แล้ว — ดู components/QcRdMenu.jsx)
  const [formMsg, setFormMsg] = useState(null); // { ok, msg }
  const [editItem, setEditItem] = useState(null); // { code, name, status, subs[] }
  const [savingItem, setSavingItem] = useState(false);
  const [srcModal, setSrcModal] = useState(false);   // ตัวเลือกวัตถุดิบจากข้อมูลจริง (ดู ItemSourcePicker)
  const [deleteTarget, setDeleteTarget] = useState(null); // { code, name, row }
  const [deleting, setDeleting] = useState(false);
  const [source, setSource] = useState('sheet');   // ข้อมูลชุดนี้มาจากชีทหรือ SQL
  // โหมด SQL ที่อ่านฐานไม่ได้แล้วถอยไปอ่านชีท — ที่เห็นบนจอเป็นของชีท แต่ปุ่มบันทึกเขียนลง SQL
  // บันทึกไปก็ไม่เห็นผลบนจอ (จอโหลดจากชีท) = อาการ "บันทึกสำเร็จแต่ข้อมูลไม่เปลี่ยน" จึงล็อกไว้เลย
  const [degraded, setDegraded] = useState(false);
  const [syncing, setSyncing] = useState(false);   // กำลังดันชีทขึ้น SQL เอง (ปุ่ม "อัพขึ้น SQL")
  // คัดลอกวัตถุดิบจากสาขาต้นแบบไปอีกสาขา — { from, to, mode: 'add' | 'replace' } (ดู copyBranch)
  const [copyForm, setCopyForm] = useState(null);
  const [copying, setCopying] = useState(false);

  // quiet = โหลดใหม่เบื้องหลัง ไม่ขึ้นสปินเนอร์คลุมทั้งตาราง (ใช้หลังกดบันทึก — ตารางเดิมยังอ่านได้ระหว่างรอ)
  //
  // ต่อ ?t= ทุกครั้ง (ไม่ใช่เฉพาะตอนโหลดหลังบันทึก) เพราะ /api/qcrd ตั้งแคชไว้ที่ CDN
  // s-maxage=30 + stale-while-revalidate=120 — เปิดหน้านี้ใหม่/กด F5 หลังเพิ่งบันทึก
  // จึงมีสิทธิ์ได้ของก่อนบันทึกกลับมาเป็นนาที ๆ ซึ่งดูเหมือน "บันทึกแล้วข้อมูลไม่เปลี่ยน"
  // หน้านี้เป็นหน้าแก้ไข ต้องเห็นของจริงเสมอ ยอมเสียเวลาโหลดชีทใหม่ทุกรอบ
  const load = ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    fetch(`/api/qcrd?sheet=item&t=${Date.now()}`)
      .then(r => r.json())
      .then(res => {
        if (res.status === 'success') {
          const data = res.data || [];
          setItems(data);
          setSource(res.source || 'sheet');
          setDegraded(Boolean(res.degraded));
          setError('');
          // โหมด SQL ที่อ่านไม่ได้แล้วถอยไปอ่านชีท — ต้องบอก ไม่งั้นแก้ไปแล้วเห็นข้อมูลเก่าจะงง
          // (ตั้งเฉพาะตอนมี warning จริง ไม่งั้นจะไปลบข้อความ "บันทึกสำเร็จ" ที่เพิ่งขึ้นมา)
          if (res.warning) setToast({ ok: false, msg: res.warning });
        }
        else setError(res.message || 'โหลดข้อมูลไม่สำเร็จ');
      })
      .catch(err => setError(err.message))
      .finally(() => { if (!quiet) setLoading(false); });
  };
  useEffect(() => { load(); }, []);

  /**
   * ตรวจหลังบันทึกว่าของที่อ่านจากต้นทางตรงกับที่เพิ่งเขียนไหม — ขอมาแค่รหัสเดียว
   *
   * เดิมตรงนี้โหลดทะเบียนใหม่ทั้งชุดเพื่อดูแถวเดียว: JSON 1.17 MB (2,657 รายการ) + ให้ SQL
   * สแกน stock_item ทั้งตารางกับ stock_item_branch อีกสองหมื่นกว่าแถว ทุกครั้งที่กดบันทึก
   * ขอเฉพาะรหัสนั้น (?code=) เหลือไม่ถึง 1 KB และฐานอ่านแถวเดียว
   *
   * ไม่ตรง = เขียนไม่เข้าจริง (หรืออ่านมาคนละที่กับที่เขียน) ต้องบอก ไม่ใช่ปล่อยให้ค่าเก่า
   * เด้งกลับมาทับเงียบ ๆ แล้วคนใช้มานั่งงงว่าทำไมกดบันทึกแล้วไม่อัพเดท
   */
  const verifySaved = (code, branches) =>
    fetch(`/api/qcrd?sheet=item&code=${encodeURIComponent(code)}&t=${Date.now()}`)
      .then(r => r.json())
      .then(res => {
        if (res.status !== 'success') return;
        const row = (res.data || []).find(i => String(i.code).trim() === code);
        if (!row) {
          setToast({ ok: false, msg: `บันทึก ${code} ขึ้นว่าสำเร็จ แต่อ่านกลับมาไม่เจอรหัสนี้ในทะเบียน — ข้อมูลอาจไม่ได้เข้าจริง` });
          return;
        }
        // ของจริงจากต้นทางมาแล้ว เอาทับแถวที่แปะไว้ตอนกดบันทึก (ปกติเหมือนกันเป๊ะ)
        setItems(prev => prev.map(i => (String(i.code).trim() === code ? { ...i, ...row } : i)));
        if (!sameBranches(row.usedBranches || [], branches)) {
          setToast({
            ok: false,
            msg: `บันทึก ${code} ขึ้นว่าสำเร็จ แต่สาขาที่อ่านกลับมาเป็น `
              + `"${(row.usedBranches || []).join(', ') || '(ไม่มี)'}" ไม่ใช่ "${branches.join(', ') || '(ไม่มี)'}" `
              + '— ตอนนี้ตารางแสดงตามที่อ่านกลับมา ลองกดรีเฟรชอีกครั้ง '
              + 'ถ้ายังไม่ตรงแปลว่าที่เขียนกับที่อ่านไม่ใช่ที่เดียวกัน',
          });
        }
      })
      .catch(() => { /* ตรวจไม่ได้ไม่ใช่เหตุให้การบันทึกที่สำเร็จไปแล้วกลายเป็นล้มเหลว */ });

  const nameMap = useMemo(() => {
    const m = {};
    items.forEach(i => { m[i.code] = i.name; });
    return m;
  }, [items]);

  const units = useMemo(() => [...new Set(items.map(i => i.unit).filter(Boolean))].sort(), [items]);
  const autoCount = useMemo(() => items.filter(i => i.unitSource === 'auto' && i.unit).length, [items]);
  const inactiveCount = useMemo(() => items.filter(i => i.status === 'ปิดการใช้งาน').length, [items]);
  // รหัสที่มีในทะเบียนแล้ว (รูปที่ตัด 0 นำหน้า) — ตัวเลือก "เพิ่มจากฐานข้อมูล" ใช้กันไม่ให้เลือกตัวซ้ำ
  // ฝั่ง SQL กรองด้วย stock_item ให้แล้วชั้นหนึ่ง ชั้นนี้ไว้กันโหมดชีทที่ทะเบียนตัวจริงคือชีท ไม่ใช่ฐาน
  const existingKeys = useMemo(() => new Set(items.map(i => normKey(i.code)).filter(Boolean)), [items]);

  // ประเภทที่ทะเบียนใช้อยู่จริง + สองค่าพื้นฐานเสมอ — ใช้ทั้งตัวกรองด้านบนและ dropdown ในฟอร์ม
  // (ของเดิมมีแค่ วัตถุดิบ/แพ็กเกจจิ้ง ตอนนี้ตั้งชื่อประเภทเองได้ จึงต้องไล่จากข้อมูลจริง)
  const typeOptions = useMemo(() => {
    const set = new Set([MATERIAL, PACKAGING]);
    items.forEach(i => { const t = String(i.itemType || '').trim(); if (t) set.add(t); });
    return [...set].sort((a, b) => a.localeCompare(b, 'th'));
  }, [items]);

  // รายชื่อหมวดสโตร์ที่มีจริงในชีท (ใช้ทั้งกรองและแนะนำในฟอร์มแก้ไข — ชีทมีตัวสะกดไม่เป๊ะปนอยู่)
  const storeCategories = useMemo(
    () => [...new Set(items.map(i => i.storeCategory).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th')),
    [items]);
  const noStoreCount = useMemo(() => items.filter(i => !i.storeCategory).length, [items]);
  const packagingCount = useMemo(() => items.filter(i => i.itemType === PACKAGING).length, [items]);
  const NO_STORE = '__none__'; // ค่าพิเศษของตัวกรอง = แสดงเฉพาะรายการที่ยังไม่ได้ระบุหมวดสโตร์
  const NO_BRANCH = '__nobranch__'; // เช่นเดียวกัน = แสดงเฉพาะรายการที่ยังไม่ได้ระบุสาขา
  const NO_POS = '__nopos__';      // เฉพาะตัวที่ยังไม่ได้ผูก itemID ของ POS (ไว้ไล่เติมให้ครบ)
  const DUP_POS = '__duppos__';    // เฉพาะตัวที่ itemID ไปซ้ำกับวัตถุดิบตัวอื่น (ต้องสะสาง)

  // จำนวนไอเทมต่อสาขา — เอาไปโชว์ในตัวเลือกให้รู้ว่าสาขานั้นมีของกี่รายการก่อนกดเลือก
  const branchCounts = useMemo(() => {
    const c = {};
    items.forEach(i => (i.usedBranches || []).forEach(b => { c[b] = (c[b] || 0) + 1; }));
    return c;
  }, [items]);
  const noBranchCount = useMemo(() => items.filter(i => !(i.usedBranches || []).length).length, [items]);

  // ตัวเลือกสาขา = ทะเบียนกลางก่อน แล้วต่อด้วยสาขาที่มีในข้อมูลแต่ไม่อยู่ในทะเบียนแล้ว
  // (สาขาที่ถูกปิดการใช้งานยังมีไอเทมติ๊กค้างไว้ ถ้าไม่ใส่ไว้จะกรองหาของพวกนั้นไม่ได้เลย)
  const branchOptions = useMemo(() => {
    const extra = Object.keys(branchCounts).filter(b => !BRANCHES.includes(b)).sort();
    return [...BRANCHES.map(b => ({ code: b, retired: false })), ...extra.map(b => ({ code: b, retired: true }))];
  }, [BRANCHES, branchCounts]);

  // รหัสที่มีมากกว่า 1 แถวในชีท (กรอกซ้ำ) — เตือนไว้ เพราะฟีเจอร์แก้ไข/ลบด้วยรหัสอย่างเดียวจะโดนแค่แถวแรกเสมอ
  const duplicateCodes = useMemo(() => {
    const count = {};
    items.forEach(i => { count[i.code] = (count[i.code] || 0) + 1; });
    return new Set(Object.keys(count).filter(c => count[c] > 1));
  }, [items]);

  // itemID ที่ถูกผูกไว้กับวัตถุดิบมากกว่า 1 ตัว — ผูกซ้ำแล้วตอนตัดสต๊อกตามยอดขายจะไปลงผิดตัว
  // เตือนอย่างเดียว ไม่ห้ามบันทึก (บางทีต้องผูกซ้ำชั่วคราวระหว่างย้ายของ)
  const duplicatePos = useMemo(() => {
    const count = {};
    items.forEach(i => { if (i.posItemId) count[i.posItemId] = (count[i.posItemId] || 0) + 1; });
    return new Set(Object.keys(count).filter(c => count[c] > 1));
  }, [items]);
  const noPosCount = useMemo(() => items.filter(i => !i.posItemId).length, [items]);
  /** วัตถุดิบตัวอื่นที่ผูก itemID นี้ไว้อยู่แล้ว — ใช้เตือนตอนกรอกในฟอร์ม */
  const posOwner = (pos, exceptCode) => {
    const v = String(pos || '').trim();
    if (!v) return null;
    return items.find(i => i.posItemId === v && i.code !== exceptCode) || null;
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(i => {
      if (unitFilter && i.unit !== unitFilter) return false;
      if (statusFilter && i.status !== statusFilter) return false;
      if (storeFilter === NO_STORE) { if (i.storeCategory) return false; }
      else if (storeFilter && (i.storeCategory || '') !== storeFilter) return false;
      // ประเภทตั้งชื่อเองได้แล้ว จึงเทียบตรง ๆ — ยกเว้น "วัตถุดิบ" ที่ต้องรวมของเก่าที่ช่องยังว่างด้วย
      // (ทะเบียนเดิมปล่อยว่างไว้แปลว่าวัตถุดิบ ค่าจะถูกเขียนลงไปเมื่อบันทึกครั้งถัดไป)
      if (typeFilter) {
        const t = String(i.itemType || '').trim();
        if (typeFilter === MATERIAL ? (t && t !== MATERIAL) : t !== typeFilter) return false;
      }
      if (branchFilter === NO_BRANCH) { if ((i.usedBranches || []).length) return false; }
      else if (branchFilter && !(i.usedBranches || []).includes(branchFilter)) return false;
      if (posFilter === NO_POS && i.posItemId) return false;
      if (posFilter === DUP_POS && !(i.posItemId && duplicatePos.has(i.posItemId))) return false;
      if (!q) return true;
      // ค้นด้วย itemID ของ POS ได้ด้วย — คนคุมสต๊อกมักถือเลขนี้มาถามว่าคือวัตถุดิบตัวไหน
      return codeMatch(i.code, q) || i.name.toLowerCase().includes(q)
        || (i.posItemId && codeMatch(i.posItemId, q));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, search, unitFilter, statusFilter, storeFilter, typeFilter, branchFilter, posFilter, duplicatePos]);

  // ติ๊กครบทุกสาขาแล้วหรือยัง — ต้องมีสาขาในทะเบียนอย่างน้อยหนึ่งตัวถึงจะนับว่า "ครบ"
  // (ช่วงที่ทะเบียนยังโหลดไม่เสร็จ รายการว่าง ถ้าไม่กันไว้ปุ่มจะขึ้นเป็นเลือกครบทั้งที่ยังไม่ได้เลือก)
  // เทียบด้วย every() ไม่ใช่ความยาว เพราะไอเทมเก่าอาจติ๊กสาขาที่ถูกปิดการใช้งานไปแล้วค้างไว้
  // (สาขาพวกนั้นมีปุ่มของตัวเองต่อท้ายอยู่แล้ว ดู retiredOn ข้างล่าง — ไม่นับรวมใน "ครบทุกสาขา")
  const allBranchesOn = BRANCHES.length > 0 && BRANCHES.every(b => editItem?.branches?.includes(b));

  // สาขาที่ไอเทมนี้ติ๊กไว้ แต่ไม่อยู่ในทะเบียนที่ยังเปิดใช้งาน (สาขาปิดกิจการ เช่น HPS ก.ย. 2026
  // หรือถูกลบออกจากทะเบียนไปแล้ว) — ต้องมีปุ่มให้กดด้วย ไม่งั้น "เอาสาขาออก" ทำไม่ได้เลย:
  // ปุ่มมีแต่สาขาที่เปิดอยู่ ค่าของสาขาที่ปิดแล้วจึงถูกส่งกลับไปเขียนทับเหมือนเดิมทุกครั้ง
  // คนใช้เห็นเป็น "แก้สาขาแล้วกดบันทึก ขึ้นว่าสำเร็จ แต่ชิปในตารางไม่เปลี่ยน"
  // (ตัวกรองด้านบนรับมือกรณีนี้อยู่แล้ว — ดู branchOptions)
  // กัน BRANCHES.length === 0 (ทะเบียนยังโหลดไม่เสร็จ) ไม่งั้นสาขาของไอเทมจะถูกป้ายว่า "ปิดแล้ว" ยกแผง
  const retiredOn = BRANCHES.length === 0 ? []
    : (editItem?.branches || []).filter(b => !BRANCHES.includes(b)).sort();

  // ปุ่มสาขาในฟอร์ม: ทะเบียนที่เปิดอยู่ก่อน แล้วต่อด้วยสาขาที่ปิดแล้วซึ่งยังติ๊กค้างอยู่
  const branchButtons = [
    ...BRANCHES.map(code => ({ code, retired: false })),
    ...retiredOn.map(code => ({ code, retired: true })),
  ];

  // ดันทะเบียนวัตถุดิบทั้งชีทขึ้น dbo.stock_item / stock_item_branch เอง
  // ปกติ /api/qcrd-save ดันให้อัตโนมัติหลังบันทึกอยู่แล้ว ปุ่มนี้ไว้ใช้ตอนรอบนั้นดันไม่ขึ้น
  // (เครื่องออฟฟิศดับอยู่ตอนกดบันทึก) หรืออยากยืนยันว่าชีทกับฐานตรงกันแล้ว
  const pushToSql = async () => {
    setSyncing(true);
    setToast(null);
    try {
      const res = await syncSql('item', { verify: true });
      const check = (res.results || []).find(r => r.step === 'verify');
      const item = (check?.checks || []).find(c => c.label === 'วัตถุดิบ');
      setToast({
        ok: res.status === 'success',
        msg: res.status === 'success'
          ? `อัพวัตถุดิบขึ้น SQL แล้ว${item ? ` · ชีท ${item.sheet.toLocaleString()} · SQL ${item.sql.toLocaleString()} รายการ` : ''}`
          : res.message || 'อัพขึ้น SQL ไม่สำเร็จ',
      });
    } catch (err) {
      setToast({ ok: false, msg: err.message || 'อัพขึ้น SQL ไม่สำเร็จ' });
    } finally {
      setSyncing(false);
    }
  };

  /**
   * ตัวเลขตัวอย่างก่อนกดคัดลอก — นับจากตารางที่โหลดไว้แล้ว ให้เห็นก่อนว่าจะเพิ่ม/เอาออกกี่รายการ
   * ของจริงนับใหม่ที่ฐานตอนเขียน (copyBranchItems ใน lib/qcrdSql.mjs) ตัวเลขนี้ไว้ตัดสินใจเท่านั้น
   */
  const copyPreview = useMemo(() => {
    if (!copyForm?.from || !copyForm?.to || copyForm.from === copyForm.to) return null;
    const { from, to } = copyForm;
    let source = 0, add = 0, remove = 0;
    items.forEach(i => {
      const b = i.usedBranches || [];
      const hasFrom = b.includes(from), hasTo = b.includes(to);
      if (hasFrom) source++;
      if (hasFrom && !hasTo) add++;
      if (!hasFrom && hasTo) remove++;
    });
    return { source, add, remove: copyForm.mode === 'replace' ? remove : 0, keep: remove };
  }, [copyForm, items]);

  const openCopy = () => {
    setFormMsg(null);
    setCopyForm({ from: '', to: branchFilter && branchFilter !== NO_BRANCH ? branchFilter : '', mode: 'add' });
  };

  const copyBranch = async () => {
    if (degraded) { setFormMsg({ ok: false, msg: LOCK_HINT }); return; }
    const { from, to, mode } = copyForm;
    if (!from || !to) { setFormMsg({ ok: false, msg: 'เลือกสาขาต้นแบบและสาขาปลายทางก่อน' }); return; }
    if (from === to) { setFormMsg({ ok: false, msg: 'สาขาต้นแบบกับสาขาปลายทางต้องไม่ใช่สาขาเดียวกัน' }); return; }
    setCopying(true);
    setFormMsg(null);
    setToast(null);
    try {
      const res = await apiCall('copyBranchItems', { from, to, mode });
      const d = res.data || {};
      setToast({
        ok: true,
        msg: `คัดลอกวัตถุดิบ ${from} → ${to} แล้ว · เพิ่ม ${(d.added ?? 0).toLocaleString()}`
          + (mode === 'replace' ? ` · เอาออก ${(d.removed ?? 0).toLocaleString()}` : '')
          + (d.total != null ? ` · ${to} มีทั้งหมด ${d.total.toLocaleString()} รายการ` : ''),
      });
      setCopyForm(null);
      setBranchFilter(to);   // เปิดดูสาขาปลายทางให้เลย จะได้ตรวจของที่เพิ่งคัดลอกได้ทันที
      load({ quiet: true });
    } catch (err) {
      setFormMsg({ ok: false, msg: err.message || 'คัดลอกไม่สำเร็จ' });
    } finally {
      setCopying(false);
    }
  };

  const saveUnits = async () => {
    if (degraded) { setToast({ ok: false, msg: LOCK_HINT }); return; }
    setSaving(true);
    setToast(null);
    try {
      const units = items.filter(i => i.unitSource === 'auto' && i.unit).map(i => ({ code: i.code, unit: i.unit }));
      const res = await apiCall('updateItemUnits', { units });
      setToast({ ok: syncOk(res), msg: `บันทึกหน่วยแล้ว ${res.data?.updated ?? 0} รายการ${syncNote(res)}` });
      load({ quiet: true });
    } catch (err) {
      setToast({ ok: false, msg: err.message || 'บันทึกไม่สำเร็จ' });
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (i) => {
    setFormMsg(null);   // ข้อความจากการบันทึกครั้งก่อนต้องไม่ค้างมาที่กล่องใหม่
    setEditItem({
      isNew: false,
      // _row = เลขแถวจริงในชีท — ส่งไปกับตอนบันทึกด้วย ไม่งั้นรหัสที่ซ้ำกันจะถูกเขียนลงแถวแรกเสมอ
      // (ผู้ใช้แก้แถวที่สอง กดบันทึกขึ้นว่าสำเร็จ แต่แถวที่แก้ไม่เปลี่ยน เพราะของไปลงแถวแรกแทน)
      row: i._row,
      code: i.code, name: i.name, status: i.status || 'ใช้งาน', subs: [...(i.subs || [])],
      // หน่วยที่ระบบวิเคราะห์เองยังไม่ได้อยู่ในชีท — ใส่ให้เป็นค่าตั้งต้นในช่อง กดบันทึกแล้วจะลงชีทจริง
      price: i.price ?? '', unit: i.unit || '', converter: i.converter ?? '', branches: [...(i.usedBranches || [])],
      // itemID/หน่วยเบิก — ตั้งต้นจากค่าที่อ่านมาเสมอ (โหมด SQL = ค่าจาก dbo.stock_item)
      // ถ้าไม่เติมตรงนี้ กดบันทึกทีเดียวจะกลายเป็นส่งค่าว่างไปล้างของเดิมในฐานทิ้ง
      posItemId: i.posItemId || '', requestUnit: i.requestUnit || '',
      storeCategory: i.storeCategory || '', addingNewStore: false,
      // ประเภทเก็บค่าตามที่อยู่ในทะเบียนจริง (ว่าง = วัตถุดิบ) ไม่บีบให้เหลือ 2 ค่าอีกแล้ว
      itemType: i.itemType || MATERIAL, newTypeName: '', usedWhen: i.usedWhen || '',
      useUnit: i.useUnit || '',
    });
  };

  const openNew = () => {
    setFormMsg(null);   // ข้อความจากการบันทึกครั้งก่อนต้องไม่ค้างมาที่กล่องใหม่
    setEditItem({
      isNew: true,
      code: '', name: '', status: 'ใช้งาน', subs: [],
      price: '', unit: '', converter: '', branches: [], posItemId: '', requestUnit: '',
      storeCategory: '', addingNewStore: false,
      itemType: MATERIAL, newTypeName: '', usedWhen: '', useUnit: '',
    });
  };

  /**
   * เลือกจากตัวเลือก "เพิ่มจากฐานข้อมูล" ทีละตัว = เปิดฟอร์มที่กรอกให้แล้ว ยังไม่บันทึก
   * ช่องที่ต้นทางไม่มี (สาขาที่ใช้ · หมวดสโตร์ · itemID) ปล่อยว่างให้กรอกต่อเหมือนเพิ่มเอง
   */
  const openFromSource = (row) => {
    setFormMsg(null);
    const t = String(row.itemType || '').trim();
    setEditItem({
      isNew: true,
      code: String(row.code || '').trim(), name: String(row.name || '').trim(),
      status: 'ใช้งาน', subs: [],
      price: row.price === null || row.price === undefined ? '' : String(row.price),
      unit: String(row.unit || '').trim(),
      converter: row.converter === null || row.converter === undefined ? '' : String(row.converter),
      branches: [], posItemId: '', requestUnit: '',
      storeCategory: '', addingNewStore: false,
      // ต้นทางรู้จักแค่ 'วัตถุดิบ/แพ็กเกจจิ้ง' (แท็กในสูตร) ชื่อประเภทอื่นค่อยเลือกในฟอร์ม
      itemType: t === PACKAGING ? PACKAGING : MATERIAL, newTypeName: '',
      usedWhen: '', useUnit: '',
    });
  };

  /** ประเภทที่จะบันทึกจริง — เลือก "พิมพ์ชื่อใหม่" ก็เอาชื่อที่พิมพ์ ไม่งั้นเอาค่าที่เลือก */
  const itemTypeOf = (f) => (f.itemType === NEW_TYPE
    ? (String(f.newTypeName || '').trim() || MATERIAL)
    : (String(f.itemType || '').trim() || MATERIAL));

  const toggleBranch = (b) => setEditItem(m => ({
    ...m, branches: m.branches.includes(b) ? m.branches.filter(x => x !== b) : [...m.branches, b],
  }));

  const saveItem = async () => {
    if (degraded) { setFormMsg({ ok: false, msg: LOCK_HINT }); return; }
    const code = String(editItem.code || '').trim();
    if (editItem.isNew && !code) { setFormMsg({ ok: false, msg: 'กรุณากรอกรหัสวัตถุดิบ' }); return; }
    if (editItem.isNew && items.some(i => String(i.code).trim() === code)) {
      setFormMsg({ ok: false, msg: `มีรหัส ${code} อยู่แล้วในรายการ — ถ้าจะแก้ตัวเดิม ให้ปิดกล่องนี้แล้วกด "แก้ไข" ที่แถวนั้นแทน` }); return;
    }
    if (!editItem.name.trim()) { setFormMsg({ ok: false, msg: 'กรุณากรอกชื่อวัตถุดิบ' }); return; }
    setSavingItem(true);
    setToast(null);
    setFormMsg(null);
    const sent = {
      code, row: editItem.row, name: editItem.name.trim(),
      status: editItem.status, subs: editItem.subs.slice(0, 3),
      price: editItem.price, unit: (editItem.unit || '').trim(), converter: editItem.converter,
      branches: editItem.branches, storeCategory: (editItem.storeCategory || '').trim(),
      // itemID ของ POS + หน่วยเบิก — ฝั่งสต๊อก/ตัดยอดขายใช้สองช่องนี้ เดิมแก้ได้ที่ชีทเท่านั้น
      posItemId: (editItem.posItemId || '').trim(), requestUnit: (editItem.requestUnit || '').trim(),
      // ประเภท — ตั้งชื่อเองได้ ('แพ็กเกจจิ้ง' ยังมีความหมายพิเศษ ไว้แยกต้นทุนบรรจุภัณฑ์
      // ระหว่างทานที่ร้านกับห่อกลับบ้าน ส่วนชื่ออื่นถือเป็นวัตถุดิบธรรมดาตอนคิดต้นทุน)
      itemType: itemTypeOf(editItem),
      usedWhen: itemTypeOf(editItem) === PACKAGING ? (editItem.usedWhen || USED_WHEN[0]) : '',
      // หน่วยใช้ = หน่วยเล็กที่สูตรใช้จริง คู่กับตัวแปลงหน่วยซึ่งบอกแค่ตัวเลข
      useUnit: (editItem.useUnit || '').trim(),
    };
    const isNew = editItem.isNew;
    try {
      const res = await apiCall(isNew ? 'addItem' : 'saveItem', sent);

      // ── แปะแถวในตารางทันที ไม่ต้องรอโหลดข้อมูลใหม่ทั้ง 2,600 รายการ ──
      // ใช้ "สาขาที่เซิร์ฟเวอร์อ่านกลับมาจากฐานหลังเขียนเสร็จ" เป็นตัวตั้ง จึงเป็นของจริง ไม่ใช่การเดา
      const saved = res.data || {};
      const savedBranches = savedItemRow(sent, saved, { source }).usedBranches;
      setItems(prev => {
        const idx = prev.findIndex(i => String(i.code).trim() === code);
        if (idx < 0) return [...prev, savedItemRow(sent, saved, { source })];
        return prev.map((it, n) => (n === idx ? savedItemRow(sent, saved, { source, prev: it }) : it));
      });

      setToast({
        ok: syncOk(res),
        msg: (isNew ? `เพิ่มวัตถุดิบ ${code} สำเร็จ` : `บันทึก ${code} สำเร็จ`)
          + ` · ${savedBranches.length} สาขา` + syncNote(res),
      });
      setEditItem(null);
      setFormMsg(null);
      // ยืนยันอีกชั้นเบื้องหลังว่าที่อ่านจากต้นทางตรงกับที่เพิ่งเขียนจริง (ขอแค่รหัสเดียว)
      verifySaved(code, savedBranches);
    } catch (err) {
      // กล่องยังเปิดค้างพร้อมข้อมูลที่กรอกไว้ — บอกสาเหตุตรงนี้เลย จะได้แก้แล้วกดใหม่ได้ทันที
      setFormMsg({ ok: false, msg: err.message || 'บันทึกไม่สำเร็จ' });
    } finally {
      setSavingItem(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    if (degraded) { setFormMsg({ ok: false, msg: LOCK_HINT }); return; }
    setDeleting(true);
    setToast(null);
    setFormMsg(null);
    try {
      const res = await apiCall('deleteItem', { code: deleteTarget.code, row: deleteTarget.row });
      // ดันรายรายการเรียก deleteItem ฝั่ง SQL ด้วย ซึ่งลบแถวใน stock_item จริง การลบจึงตามขึ้นไป
      // (ต่างจากตอนดันทั้งชุดด้วยปุ่ม "อัพขึ้น SQL" ที่ใช้ MERGE แล้วไม่ลบอะไร)
      setToast({
        ok: syncOk(res),
        msg: `ลบ ${deleteTarget.code} สำเร็จ` + syncNote(res),
      });
      setDeleteTarget(null);
      setFormMsg(null);
      // ถอดแถวออกจากตารางเลย — ไม่ต้องลากทะเบียนทั้งชุดกลับมาเพื่อให้แถวเดียวหายไป
      setItems(prev => prev.filter(i => String(i.code).trim() !== String(deleteTarget.code).trim()));
    } catch (err) {
      setFormMsg({ ok: false, msg: err.message || 'ลบไม่สำเร็จ' });
    } finally {
      setDeleting(false);
    }
  };

  // โหลดรายการที่กรองอยู่เป็น CSV — ใช้ไล่เติม itemID ทีละล็อต หรือส่งให้คนอื่นช่วยกรอก
  // นำหน้าด้วย BOM ไม่งั้น Excel เปิดแล้วภาษาไทยเป็นตัวยึกยือ
  const exportCsv = () => {
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['รหัส', 'itemID (POS)', 'ชื่อ', 'หน่วย', 'หน่วยเบิก', 'ราคาต้นทุน', 'ตัวแปลง', 'หน่วยใช้', 'ประเภท', 'สถานะ', 'หมวดสโตร์', 'สาขาที่ใช้'];
    const body = filtered.map(i => [
      i.code, i.posItemId, i.name, i.unit, i.requestUnit, i.price ?? '', i.converter ?? '',
      i.useUnit || '', i.itemType || '',
      i.status, i.storeCategory, (i.usedBranches || []).join(' '),
    ].map(cell).join(','));
    const blob = new Blob(['\ufeff' + [head.map(cell).join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `วัตถุดิบ${posFilter === NO_POS ? '-ยังไม่ได้ผูก-itemID' : posFilter === DUP_POS ? '-itemID-ซ้ำ' : ''}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

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
              ที่แสดงอยู่เป็นข้อมูลจากชีท ซึ่งอาจไม่ตรงกับของจริงใน SQL — ถ้าบันทึกตอนนี้จะเขียนลง SQL
              แต่จอยังโหลดจากชีท จึงเห็นเป็น “บันทึกแล้วข้อมูลไม่เปลี่ยน” และเสี่ยงทับของจริงด้วยของเก่า
              จึงปิดปุ่มบันทึกทั้งหมดไว้ก่อน ดูได้แต่แก้ไม่ได้
            </p>
            <button onClick={() => load()}
              className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-rose-700 bg-white border border-rose-200 rounded-lg hover:bg-rose-100">
              ลองใหม่
            </button>
          </div>
        </div>
      )}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-6 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-emerald-100 text-emerald-600 rounded-xl"><PackageSearch className="w-6 h-6" /></div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">วัตถุดิบ (QC/RD)</h2>
              <p className="text-sm text-slate-500 mt-0.5">
                {items.length.toLocaleString()} รายการจาก{source === 'sql' ? 'ฐานข้อมูล SQL' : 'ชีท item'}
                {autoCount > 0 && ` · หน่วยวิเคราะห์อัตโนมัติ ${autoCount.toLocaleString()}`}
                {inactiveCount > 0 && ` · ปิดการใช้งาน ${inactiveCount}`}
                {duplicateCodes.size > 0 && (
                  <span className="text-amber-600 font-semibold"> · รหัสซ้ำ {duplicateCodes.size} รหัส</span>
                )}
                {noPosCount > 0 && ` · ยังไม่ได้ผูก itemID ${noPosCount.toLocaleString()}`}
                {duplicatePos.size > 0 && (
                  <span className="text-amber-600 font-semibold"> · itemID ซ้ำ {duplicatePos.size} เลข</span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* สำเร็จ = ข้อความสั้น โชว์ตรงหัวได้ / ล้มเหลว = ไปโชว์ในแถบเตือนเต็มความกว้างด้านล่าง
                เพราะข้อความบอกสาเหตุจาก GAS ยาวเกินกว่าจะอ่านรู้เรื่องในบรรทัดเดียว */}
            {toast?.ok && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
                <CheckCircle size={13} />{toast.msg}
              </span>
            )}
            {/* โหมด SQL ไม่ต้องมีปุ่มนี้ — ข้อมูลอยู่ในฐานอยู่แล้ว และการดันชีททับจะเอาของเก่ามาลบของใหม่ */}
            {source !== 'sql' && (
              <button onClick={pushToSql} disabled={syncing}
                title="ดันทะเบียนวัตถุดิบจากชีทขึ้น SQL (dbo.stock_item) เพื่อให้หน้านับสต๊อกของสาขาเห็นของที่แก้จากหน้านี้"
                className="inline-flex items-center gap-2 bg-white hover:bg-slate-50 disabled:text-slate-300 border border-slate-200 text-slate-600 font-semibold text-xs px-4 py-2 rounded-xl transition-all">
                {syncing ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />}
                อัพขึ้น SQL
              </button>
            )}
            <button onClick={exportCsv} disabled={loading || filtered.length === 0}
              title="โหลดรายการที่กรองอยู่ตอนนี้เป็นไฟล์ CSV (เปิดด้วย Excel ได้)"
              className="inline-flex items-center gap-2 bg-white hover:bg-slate-50 disabled:text-slate-300 border border-slate-200 text-slate-600 font-semibold text-xs px-4 py-2 rounded-xl transition-all">
              <Download size={14} /> โหลด CSV ({filtered.length.toLocaleString()})
            </button>
            {/* การเขียนทีละหลายพันแถวทำบนฐานทีเดียว — โหมดชีทไม่มีทางนี้ จึงแสดงเฉพาะโหมด SQL */}
            {source === 'sql' && (
              <button onClick={openCopy} disabled={degraded || loading}
                title={degraded ? LOCK_HINT : 'ให้สาขาหนึ่งมีวัตถุดิบชุดเดียวกับอีกสาขา — ไม่ต้องไล่ติ๊กสาขาทีละรายการ'}
                className="inline-flex items-center gap-2 bg-white hover:bg-sky-50 disabled:bg-slate-100 disabled:text-slate-400 text-sky-600 border border-sky-200 font-semibold text-xs px-4 py-2 rounded-xl transition-all">
                <Copy size={14} /> คัดลอกจากสาขาอื่น
              </button>
            )}
            <button onClick={() => setSrcModal(true)} disabled={degraded}
              title={degraded ? LOCK_HINT : 'ดึงวัตถุดิบที่มีอยู่จริงในสูตรเมนู / แพลนสั่งของ / ปิดรอบ แต่ยังไม่มีในทะเบียนนี้'}
              className="inline-flex items-center gap-2 bg-white hover:bg-emerald-50 disabled:bg-slate-100 disabled:text-slate-400 text-emerald-600 border border-emerald-200 font-semibold text-xs px-4 py-2 rounded-xl transition-all">
              <Database size={14} /> เพิ่มจากฐานข้อมูล
            </button>
            <button onClick={openNew} disabled={degraded}
              title={degraded ? LOCK_HINT : 'เพิ่มวัตถุดิบใหม่ลงทะเบียนวัตถุดิบ'}
              className="inline-flex items-center gap-2 bg-slate-800 hover:bg-slate-900 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
              <Plus size={14} /> เพิ่มวัตถุดิบ
            </button>
            {autoCount > 0 && (
              <button onClick={saveUnits} disabled={saving || degraded}
                title={degraded ? LOCK_HINT : 'บันทึกหน่วยที่วิเคราะห์ได้ลงช่องหน่วยของวัตถุดิบ (เฉพาะช่องที่ยังว่าง)'}
                className="inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold text-xs px-4 py-2 rounded-xl transition-all">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                บันทึกหน่วยที่วิเคราะห์ ({autoCount})
              </button>
            )}
          </div>
        </div>

        <div className="p-4 flex flex-wrap gap-3 border-b border-slate-100">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหารหัส / ชื่อวัตถุดิบ / itemID…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
          <select value={unitFilter} onChange={e => setUnitFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
            <option value="">ทุกหน่วย ({units.length})</option>
            {units.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
            <option value="">ทุกสถานะ</option>
            <option value="ใช้งาน">ใช้งาน</option>
            <option value="ปิดการใช้งาน">ปิดการใช้งาน</option>
          </select>
          <select value={storeFilter} onChange={e => setStoreFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
            <option value="">ทุกหมวดสโตร์ ({storeCategories.length})</option>
            {storeCategories.map(s => <option key={s} value={s}>{s}</option>)}
            {noStoreCount > 0 && <option value={NO_STORE}>— ไม่ได้ระบุ ({noStoreCount})</option>}
          </select>
          <select value={posFilter} onChange={e => setPosFilter(e.target.value)}
            title="ไล่ดูว่ายังเหลือวัตถุดิบตัวไหนที่ยังไม่ได้ผูกกับ itemID ของ POS"
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
            <option value="">itemID: ทุกรายการ</option>
            {noPosCount > 0 && <option value={NO_POS}>— ยังไม่ได้ผูก ({noPosCount.toLocaleString()})</option>}
            {duplicatePos.size > 0 && <option value={DUP_POS}>— ผูกซ้ำกัน ({duplicatePos.size})</option>}
          </select>
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
            <option value="">ทุกประเภท</option>
            {typeOptions.map(t => (
              <option key={t} value={t}>{t === PACKAGING ? `${t} (${packagingCount})` : t}</option>
            ))}
          </select>
          {/* กรองตามสาขาที่ใช้ไอเทม — จัดของทีละสาขาได้โดยไม่ต้องไล่หาในรายการรวมห้าพันกว่าแถว */}
          <select value={branchFilter} onChange={e => setBranchFilter(e.target.value)}
            className={`border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 ${branchFilter
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 font-semibold' : 'border-slate-200 bg-white'}`}>
            <option value="">ทุกสาขา</option>
            {branchOptions.map(b => (
              <option key={b.code} value={b.code}>
                {b.code} ({(branchCounts[b.code] || 0).toLocaleString()}){b.retired ? ' — ปิดแล้ว' : ''}
              </option>
            ))}
            {noBranchCount > 0 && <option value={NO_BRANCH}>— ยังไม่ได้ระบุสาขา ({noBranchCount.toLocaleString()})</option>}
          </select>
        </div>

        {(error || (toast && !toast.ok)) && (
          <div className="m-4 p-3 bg-rose-50 border border-rose-100 rounded-xl text-sm text-rose-700 flex items-start gap-2">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <span className="break-words">{error || toast.msg}</span>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 sticky top-0">
              <tr className="text-xs font-bold uppercase tracking-wide">
                <th className="px-4 py-3 text-left">รหัส</th>
                <th className="px-3 py-3 text-left">itemID (POS)</th>
                <th className="px-4 py-3 text-left">ชื่อ</th>
                <th className="px-4 py-3 text-center">หน่วย</th>
                <th className="px-4 py-3 text-right">ราคาต้นทุน</th>
                <th className="px-3 py-3 text-right">ตัวแปลง</th>
                <th className="px-3 py-3 text-left">สาขาที่ใช้</th>
                <th className="px-3 py-3 text-left">หมวดสโตร์</th>
                <th className="px-4 py-3 text-center">สถานะ</th>
                <th className="px-4 py-3 text-left">ไอเทมทดแทน</th>
                <th className="px-4 py-3 text-center">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={11} className="px-4 py-10 text-center text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" />กำลังโหลดข้อมูล…
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={11} className="px-4 py-10 text-center text-slate-400">ไม่พบรายการ</td></tr>
              ) : filtered.map(i => (
                <tr key={i._row ?? i.code} className={`hover:bg-slate-50/60 ${i.status === 'ปิดการใช้งาน' ? 'bg-rose-50/40 text-slate-400' : ''}`}>
                  <td className="px-4 py-2 font-mono text-xs text-slate-500 whitespace-nowrap">
                    {i.code}
                    {duplicateCodes.has(i.code) && (
                      <span title="รหัสนี้มีมากกว่า 1 แถวในชีท" className="ml-1 inline-flex items-center gap-0.5 px-1 py-0.5 bg-amber-50 text-amber-600 border border-amber-200 rounded text-[9px] font-bold align-middle">
                        <AlertTriangle size={9} />ซ้ำ
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                    {i.posItemId ? (
                      <span className={duplicatePos.has(i.posItemId) ? 'text-amber-600 font-bold' : 'text-slate-500'}>
                        {i.posItemId}
                        {duplicatePos.has(i.posItemId) && (
                          <span title="itemID นี้ถูกผูกไว้กับวัตถุดิบมากกว่า 1 ตัว" className="ml-1 inline-flex items-center gap-0.5 px-1 py-0.5 bg-amber-50 border border-amber-200 rounded text-[9px] align-middle">
                            <AlertTriangle size={9} />ซ้ำ
                          </span>
                        )}
                      </span>
                    ) : <span className="text-slate-300" title="ยังไม่ได้ผูกกับ itemID ของ POS">—</span>}
                    {i.requestUnit && (
                      <span title="หน่วยเบิก" className="ml-1 inline-block px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[10px] font-sans align-middle">
                        เบิก: {i.requestUnit}
                      </span>
                    )}
                  </td>
                  <td className={`px-4 py-2 ${i.status === 'ปิดการใช้งาน' ? '' : 'text-slate-800'}`}>
                    {i.name}
                    {i.itemType === PACKAGING && (
                      <span title={`บรรจุภัณฑ์${i.usedWhen ? ` · ใช้กับ${i.usedWhen}` : ''}`}
                        className="ml-1.5 inline-block px-1.5 py-0.5 bg-violet-50 text-violet-700 border border-violet-200 rounded-full text-[10px] font-bold align-middle">
                        {PACKAGING}{i.usedWhen && i.usedWhen !== USED_WHEN[0] ? ` · ${i.usedWhen}` : ''}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-center whitespace-nowrap">
                    {i.unit ? (
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${i.unitSource === 'auto' ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-slate-100 text-slate-600'}`}>
                        {i.unit}{i.unitSource === 'auto' && <span className="text-[9px] opacity-70">วิเคราะห์</span>}
                      </span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{fmt(i.price)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">
                    {i.converter != null && !isNaN(i.converter) ? Number(i.converter).toLocaleString() : <span className="text-slate-300">—</span>}
                    {i.useUnit && (
                      <span title="หน่วยใช้ (หน่วยเล็กในสูตร)" className="ml-1 inline-block px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[10px] font-sans align-middle">
                        {i.useUnit}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {/* กรองสาขาอยู่ = ดันสาขานั้นขึ้นมาไว้หน้าสุดแล้วเน้นสี ไม่งั้นอาจโดนตัดอยู่ใน "+n" */}
                    {(i.usedBranches || []).length === 0 ? <span className="text-slate-300 text-xs">—</span> : (
                      <div className="flex flex-wrap gap-1 max-w-[180px]" title={i.usedBranches.join(', ')}>
                        {(branchFilter && branchFilter !== NO_BRANCH
                          ? [...i.usedBranches].sort((a, b) => (a === branchFilter ? -1 : b === branchFilter ? 1 : 0))
                          : i.usedBranches
                        ).slice(0, 4).map(b => (
                          <span key={b} className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${b === branchFilter
                            ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300' : 'bg-slate-100 text-slate-600'}`}>{b}</span>
                        ))}
                        {i.usedBranches.length > 4 && (
                          <span className="inline-block px-1.5 py-0.5 bg-slate-200 text-slate-500 rounded text-[10px] font-bold">+{i.usedBranches.length - 4}</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {i.storeCategory ? (
                      <span className="inline-block px-2 py-0.5 bg-violet-50 text-violet-700 border border-violet-100 rounded-full text-[11px] font-medium">{i.storeCategory}</span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2 text-center whitespace-nowrap">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${i.status === 'ปิดการใช้งาน' ? 'bg-rose-100 text-rose-600' : 'bg-emerald-50 text-emerald-600'}`}>
                      {i.status}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {(i.subs || []).length === 0 ? <span className="text-slate-300 text-xs">—</span> : (
                      <div className="flex flex-wrap gap-1">
                        {i.subs.map(c => (
                          <span key={c} title={nameMap[c] || c}
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-sky-50 text-sky-700 border border-sky-100 rounded-full text-[11px] max-w-[180px] truncate">
                            <ArrowRightLeft size={9} className="flex-shrink-0" />{nameMap[c] || c}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <div className="inline-flex items-center gap-1.5">
                      <button onClick={() => openEdit(i)} disabled={degraded} title={degraded ? LOCK_HINT : ''}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:text-slate-300 disabled:hover:bg-white">
                        <Pencil size={12} /> แก้ไข
                      </button>
                      <button onClick={() => { setFormMsg(null); setDeleteTarget({ code: i.code, name: i.name, row: i._row }); }}
                        disabled={degraded} title={degraded ? LOCK_HINT : 'ลบวัตถุดิบนี้'}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-rose-500 bg-white border border-slate-200 rounded-lg hover:bg-rose-50 hover:border-rose-200 disabled:text-slate-300 disabled:hover:bg-white disabled:hover:border-slate-200">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && (
          <div className="px-4 py-3 border-t border-slate-100 text-xs text-slate-400 flex items-center gap-2">
            <Info size={13} />
            แสดง {filtered.length.toLocaleString()} / {items.length.toLocaleString()} รายการ
            {branchFilter && (
              <span className="text-emerald-600 font-semibold">
                {' · เฉพาะ'}{branchFilter === NO_BRANCH ? 'รายการที่ยังไม่ได้ระบุสาขา' : `สาขา ${branchFilter}`}{' '}
                <button onClick={() => setBranchFilter('')} className="ml-1 underline hover:text-emerald-800">ล้าง</button>
              </span>
            )}
            {' · '}หน่วยสีเหลือง = วิเคราะห์จากชื่อโดยระบบ (ยังไม่ได้เขียนลงชีท)
          </div>
        )}
      </div>

      {/* ───── Modal แก้ไขวัตถุดิบ ───── */}
      {editItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => !savingItem && setEditItem(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-800">
                {editItem.isNew
                  ? <>➕ เพิ่มวัตถุดิบใหม่</>
                  : <>✏️ แก้ไขวัตถุดิบ <span className="font-mono text-sm text-slate-400">{editItem.code}</span></>}
              </h3>
              <button onClick={() => setEditItem(null)} className="text-slate-400 hover:text-slate-700"><X size={20} /></button>
            </div>

            <div className="p-5 overflow-auto space-y-4">
              {editItem.isNew && (
                <div>
                  <label className="text-xs font-bold text-slate-500">รหัสวัตถุดิบ</label>
                  <input value={editItem.code} onChange={e => setEditItem(m => ({ ...m, code: e.target.value }))}
                    placeholder="เช่น 1000078"
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
              )}
              <div>
                <label className="text-xs font-bold text-slate-500">ชื่อวัตถุดิบ</label>
                <input value={editItem.name} onChange={e => setEditItem(m => ({ ...m, name: e.target.value }))}
                  className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-500">ราคาต้นทุน (บาท/หน่วยซื้อ)</label>
                  <input type="number" inputMode="decimal" value={editItem.price}
                    onChange={e => setEditItem(m => ({ ...m, price: e.target.value }))} placeholder="0.00"
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500">หน่วย <span className="font-normal">(หน่วยซื้อ เช่น กก. / ถุง / ขวด)</span></label>
                  <input list="qcrd-units" value={editItem.unit}
                    onChange={e => setEditItem(m => ({ ...m, unit: e.target.value }))} placeholder="เช่น กก."
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                  <datalist id="qcrd-units">
                    {units.map(u => <option key={u} value={u} />)}
                  </datalist>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500">ตัวแปลงหน่วย <span className="font-normal">(หน่วยเล็กต่อ 1 หน่วยซื้อ เช่น 1000)</span></label>
                  <input type="number" inputMode="decimal" value={editItem.converter}
                    onChange={e => setEditItem(m => ({ ...m, converter: e.target.value }))} placeholder="เช่น 1000"
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono text-right focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
                <div>
                  {/* หน่วยใช้ = หน่วยของตัวเลขในช่องตัวแปลงหน่วย และเป็นหน่วยที่กรอกยอดใช้ในสูตร
                      ของเดิมมีแต่ตัวเลข 1000 โดยไม่บอกว่ากรัมหรือมิลลิลิตร ต้องจำกันเอง */}
                  <label className="text-xs font-bold text-slate-500">หน่วยใช้ <span className="font-normal">(หน่วยเล็กในสูตร เช่น กรัม / มล.)</span></label>
                  <input list="qcrd-use-units" value={editItem.useUnit || ''}
                    onChange={e => setEditItem(m => ({ ...m, useUnit: e.target.value }))} placeholder="เช่น กรัม"
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                  <datalist id="qcrd-use-units">
                    {USE_UNITS.map(u => <option key={u} value={u} />)}
                  </datalist>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500">หน่วยเบิก <span className="font-normal">(หน่วยที่สาขาใช้เบิกของ)</span></label>
                  <input value={editItem.requestUnit}
                    onChange={e => setEditItem(m => ({ ...m, requestUnit: e.target.value }))} placeholder="เช่น ถุง"
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                </div>
              </div>

              {/* itemID ของ POS — ฝั่งตัดสต๊อกตามยอดขายใช้เลขนี้จับคู่ ผูกซ้ำ/ผิดตัวแล้วยอดจะไปลงผิดวัตถุดิบ
                  เตือนอย่างเดียวไม่ห้ามบันทึก เพราะบางช่วงต้องผูกซ้ำชั่วคราวระหว่างสลับของ */}
              <div>
                <label className="text-xs font-bold text-slate-500">itemID (POS) <span className="font-normal">— เลขที่ใช้จับคู่กับระบบขายหน้าร้าน</span></label>
                <input value={editItem.posItemId}
                  onChange={e => setEditItem(m => ({ ...m, posItemId: e.target.value }))} placeholder="เว้นว่างได้ถ้ายังไม่ผูก"
                  className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                {(() => {
                  const owner = posOwner(editItem.posItemId, editItem.isNew ? null : editItem.code);
                  return owner ? (
                    <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                      <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
                      <span>itemID นี้ผูกกับ <span className="font-mono">{owner.code}</span> {owner.name} อยู่แล้ว —
                        ถ้าผูกซ้ำ ตอนตัดสต๊อกตามยอดขายจะไปลงตัวใดตัวหนึ่งเท่านั้น (บันทึกได้ แต่ควรเช็คก่อน)</span>
                    </p>
                  ) : null;
                })()}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-500">ประเภท</label>
                  <select value={editItem.itemType}
                    onChange={e => setEditItem(m => ({
                      ...m,
                      itemType: e.target.value,
                      newTypeName: e.target.value === NEW_TYPE ? m.newTypeName : '',
                      usedWhen: e.target.value === PACKAGING ? (m.usedWhen || USED_WHEN[0]) : '',
                    }))}
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
                    {/* ประเภทที่ร้านใช้อยู่จริงทั้งหมด (รวม 2 ค่าเดิมเสมอ) + ตัวเลือกพิมพ์ชื่อใหม่ */}
                    {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
                    <option value={NEW_TYPE}>＋ พิมพ์ชื่อประเภทใหม่…</option>
                  </select>
                  {editItem.itemType === NEW_TYPE && (
                    <input autoFocus value={editItem.newTypeName || ''}
                      onChange={e => setEditItem(m => ({ ...m, newTypeName: e.target.value }))}
                      placeholder="ชื่อประเภทใหม่ เช่น เนื้อสัตว์"
                      className="mt-2 w-full border border-emerald-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                  )}
                </div>
                {itemTypeOf(editItem) === PACKAGING && (
                  <div>
                    <label className="text-xs font-bold text-slate-500">ใช้กับ</label>
                    <select value={editItem.usedWhen || USED_WHEN[0]}
                      onChange={e => setEditItem(m => ({ ...m, usedWhen: e.target.value }))}
                      className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
                      {USED_WHEN.map(w => <option key={w} value={w}>{w}</option>)}
                    </select>
                  </div>
                )}
              </div>
              {itemTypeOf(editItem) === PACKAGING && (
                <p className="-mt-1 text-[11px] text-violet-600">
                  ทำเครื่องหมายเป็นบรรจุภัณฑ์ไว้ เพื่อให้แยกต้นทุนระหว่างลูกค้าทานที่ร้านกับห่อกลับบ้านได้ในอนาคต
                </p>
              )}

              <div>
                <label className="text-xs font-bold text-slate-500">หมวดสโตร์ <span className="font-normal">(ตำแหน่งจัดเก็บ เช่น ของแห้ง / ห้องผัก / ตู้1)</span></label>
                {editItem.addingNewStore ? (
                  <div className="mt-1 flex gap-2">
                    <input autoFocus value={editItem.storeCategory}
                      onChange={e => setEditItem(m => ({ ...m, storeCategory: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); setEditItem(m => ({ ...m, addingNewStore: false })); } }}
                      placeholder="พิมพ์ชื่อหมวดใหม่…"
                      className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                    <button type="button" onClick={() => setEditItem(m => ({ ...m, addingNewStore: false }))}
                      className="px-3 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl hover:bg-emerald-100">
                      ✓ เสร็จ
                    </button>
                  </div>
                ) : (
                  <select value={editItem.storeCategory}
                    onChange={e => {
                      if (e.target.value === '__new__') setEditItem(m => ({ ...m, addingNewStore: true, storeCategory: '' }));
                      else setEditItem(m => ({ ...m, storeCategory: e.target.value }));
                    }}
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500">
                    <option value="">— ไม่ระบุ —</option>
                    {/* ถ้าค่าปัจจุบันเป็นหมวดที่พิมพ์ใหม่ (ยังไม่มีในชีท) ให้โผล่เป็นตัวเลือกด้วย จะได้ไม่หายตอนสลับกลับมาดู */}
                    {editItem.storeCategory && !storeCategories.includes(editItem.storeCategory) && (
                      <option value={editItem.storeCategory}>{editItem.storeCategory} (ใหม่)</option>
                    )}
                    {storeCategories.map(s => <option key={s} value={s}>{s}</option>)}
                    <option value="__new__">+ เพิ่มหมวดใหม่…</option>
                  </select>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-slate-500">สาขาที่ใช้ไอเทมนี้</label>
                  <span className="text-[11px] text-slate-400">
                    เลือกแล้ว {editItem.branches.length} สาขา
                    {editItem.branches.length > 0 && (
                      <button onClick={() => setEditItem(m => ({ ...m, branches: [] }))} className="ml-2 text-rose-400 hover:text-rose-600 underline">ล้าง</button>
                    )}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {/* ปุ่มเลือก/ยกเลิกทุกสาขาในคลิกเดียว
                      เทียบ BRANCHES.length > 0 ด้วย เพราะช่วงที่ทะเบียนสาขายังโหลดไม่เสร็จ
                      รายการจะว่าง แล้ว 0 === 0 จะทำให้ปุ่มขึ้นเป็น "เลือกครบแล้ว" ทั้งที่ยังไม่ได้เลือกอะไร */}
                  <button
                    disabled={BRANCHES.length === 0}
                    onClick={() => setEditItem(m => ({
                      ...m,
                      // เลือกครบ = ทะเบียนที่เปิดอยู่ + คงสาขาที่ปิดแล้วซึ่งติ๊กไว้ก่อนหน้า
                      // (จะเอาออกให้กดปุ่มสาขานั้นตรง ๆ ไม่ใช่ให้หายไปเองตอนกดปุ่มนี้)
                      branches: allBranchesOn ? [] : [...BRANCHES, ...m.branches.filter(b => !BRANCHES.includes(b))],
                    }))}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition-all disabled:opacity-40 ${allBranchesOn
                      ? 'bg-emerald-600 border-emerald-600 text-white'
                      : 'bg-emerald-50 border-emerald-300 text-emerald-700 hover:bg-emerald-100'}`}>
                    ✓ ทุกสาขา
                  </button>
                  {branchButtons.map(({ code: b, retired }) => {
                    const on = editItem.branches.includes(b);
                    return (
                      <button key={b} onClick={() => toggleBranch(b)}
                        title={retired ? `${b} ไม่อยู่ในทะเบียนสาขาที่เปิดใช้งานแล้ว — กดเพื่อเอาออกจากไอเทมนี้` : b}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${on
                          ? (retired
                            ? 'bg-amber-500 border-amber-500 text-white'
                            : 'bg-emerald-500 border-emerald-500 text-white')
                          : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                        {b}{retired && <span className="ml-1 text-[9px] font-normal opacity-80">ปิดแล้ว</span>}
                      </button>
                    );
                  })}
                </div>
                {retiredOn.length > 0 && (
                  <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                    <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
                    <span>ไอเทมนี้ยังติ๊กสาขาที่ไม่อยู่ในทะเบียนที่เปิดใช้งานแล้ว {retiredOn.length} สาขา
                      ({retiredOn.join(', ')}) — กดปุ่มสีส้มเพื่อเอาออก แล้วกดบันทึก</span>
                  </p>
                )}
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500">สถานะ</label>
                <div className="mt-1 flex gap-2">
                  {['ใช้งาน', 'ปิดการใช้งาน'].map(s => (
                    <button key={s} onClick={() => setEditItem(m => ({ ...m, status: s }))}
                      className={`px-4 py-2 rounded-xl text-sm font-semibold border transition-all ${editItem.status === s
                        ? (s === 'ใช้งาน' ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-rose-500 border-rose-500 text-white')
                        : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-slate-500">ไอเทมทดแทน (สูงสุด 3 รายการ)</label>
                  <span className="text-[11px] text-slate-400">{editItem.subs.length}/3</span>
                </div>
                <div className="space-y-2">
                  {editItem.subs.map((c, idx) => (
                    <div key={idx} className="flex items-center justify-between gap-2 px-3 py-2 bg-sky-50/60 border border-sky-100 rounded-xl text-sm">
                      <span className="truncate">
                        <span className="font-mono text-xs text-slate-400 mr-1.5">{c}</span>{nameMap[c] || '(ไม่พบชื่อในชีท)'}
                      </span>
                      <button onClick={() => setEditItem(m => ({ ...m, subs: m.subs.filter((_, i2) => i2 !== idx) }))}
                        className="text-slate-300 hover:text-rose-500 flex-shrink-0"><X size={14} /></button>
                    </div>
                  ))}
                  {editItem.subs.length < 3 && (
                    <SubPicker items={items} exclude={[editItem.code, ...editItem.subs]}
                      onPick={code => setEditItem(m => ({ ...m, subs: [...m.subs, code] }))} />
                  )}
                </div>
              </div>
            </div>

            <div className="p-5 border-t border-slate-100 space-y-3">
              {formMsg && <FormMsg {...formMsg} />}
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setEditItem(null)} disabled={savingItem}
                  className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">ยกเลิก</button>
                <button onClick={saveItem} disabled={savingItem || degraded} title={degraded ? LOCK_HINT : ''}
                  className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-200 disabled:text-slate-400 rounded-xl">
                  {savingItem ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle size={15} />}
                  {savingItem ? 'กำลังบันทึก…' : (editItem.isNew ? 'เพิ่มวัตถุดิบ' : 'บันทึก')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ───── Modal ยืนยันลบวัตถุดิบ ───── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="p-5 flex items-start gap-3">
              <div className="p-2 bg-rose-50 text-rose-500 rounded-xl flex-shrink-0"><AlertTriangle size={20} /></div>
              <div>
                <h3 className="font-bold text-slate-800">ลบวัตถุดิบนี้?</h3>
                <p className="text-sm text-slate-500 mt-1">
                  <span className="font-mono text-xs text-slate-400">{deleteTarget.code}</span> {deleteTarget.name}
                </p>
                <p className="text-xs text-rose-500 mt-2">
                  ลบออกจาก{source === 'sql' ? 'ทะเบียนวัตถุดิบใน SQL (dbo.stock_item)' : 'ชีท item ทั้งแถว'}ทันที — ย้อนกลับไม่ได้
                </p>
              </div>
            </div>
            <div className="p-4 border-t border-slate-100 space-y-3">
              {formMsg && <FormMsg {...formMsg} />}
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setDeleteTarget(null)} disabled={deleting}
                  className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">ยกเลิก</button>
                <button onClick={confirmDelete} disabled={deleting || degraded} title={degraded ? LOCK_HINT : ''}
                  className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-rose-500 hover:bg-rose-600 disabled:bg-slate-200 disabled:text-slate-400 rounded-xl">
                  {deleting ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                  {deleting ? 'กำลังลบ…' : 'ลบเลย'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {copyForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => !copying && setCopyForm(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-sky-50 text-sky-600 rounded-xl"><Copy size={18} /></div>
                <h3 className="font-bold text-slate-800">คัดลอกวัตถุดิบจากสาขาอื่น</h3>
              </div>
              <button onClick={() => setCopyForm(null)} disabled={copying} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-semibold text-slate-500">สาขาต้นแบบ</span>
                  <select value={copyForm.from} onChange={e => setCopyForm(f => ({ ...f, from: e.target.value }))}
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sky-500">
                    <option value="">— เลือก —</option>
                    {branchOptions.map(b => (
                      <option key={b.code} value={b.code}>
                        {b.code} ({(branchCounts[b.code] || 0).toLocaleString()}){b.retired ? ' — ปิดแล้ว' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-semibold text-slate-500">ไปที่สาขา</span>
                  <select value={copyForm.to} onChange={e => setCopyForm(f => ({ ...f, to: e.target.value }))}
                    className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sky-500">
                    <option value="">— เลือก —</option>
                    {BRANCHES.filter(b => b !== copyForm.from).map(b => (
                      <option key={b} value={b}>{b} ({(branchCounts[b] || 0).toLocaleString()})</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="space-y-2">
                {[
                  ['add', 'เพิ่มเข้าไป', 'ของที่สาขาปลายทางมีอยู่แล้วเก็บไว้เหมือนเดิม'],
                  ['replace', 'ให้เหมือนต้นแบบเป๊ะ', 'ตัวที่สาขาต้นแบบไม่ใช้ จะเอาสาขาปลายทางออกด้วย'],
                ].map(([v, label, hint]) => (
                  <label key={v} className={`flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer ${copyForm.mode === v ? 'border-sky-300 bg-sky-50' : 'border-slate-200'}`}>
                    <input type="radio" name="copyMode" checked={copyForm.mode === v}
                      onChange={() => setCopyForm(f => ({ ...f, mode: v }))} className="mt-0.5" />
                    <span>
                      <span className="block text-sm font-semibold text-slate-700">{label}</span>
                      <span className="block text-xs text-slate-500">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {copyPreview && (
                <div className="text-sm p-3 rounded-xl bg-slate-50 border border-slate-100 text-slate-600">
                  {copyForm.from} ใช้ {copyPreview.source.toLocaleString()} รายการ →
                  เพิ่มให้ {copyForm.to} <b className="text-emerald-600">{copyPreview.add.toLocaleString()}</b> รายการ
                  {copyForm.mode === 'replace'
                    ? <> · เอาออก <b className="text-rose-600">{copyPreview.remove.toLocaleString()}</b> รายการ</>
                    : copyPreview.keep > 0 && <> · มีเฉพาะ {copyForm.to} อยู่แล้ว {copyPreview.keep.toLocaleString()} รายการ (คงไว้)</>}
                  <p className="text-xs text-slate-400 mt-1">เปลี่ยนเฉพาะสาขา {copyForm.to} สาขาอื่นของแต่ละวัตถุดิบไม่เปลี่ยน</p>
                </div>
              )}
            </div>
            <div className="p-4 border-t border-slate-100 space-y-3">
              {formMsg && <FormMsg {...formMsg} />}
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setCopyForm(null)} disabled={copying}
                  className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">ยกเลิก</button>
                <button onClick={copyBranch}
                  disabled={copying || degraded || !copyPreview || !copyPreview.source || (!copyPreview.add && !copyPreview.remove)}
                  title={degraded ? LOCK_HINT : ''}
                  className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 disabled:bg-slate-200 disabled:text-slate-400 rounded-xl">
                  {copying ? <Loader2 size={15} className="animate-spin" /> : <Copy size={15} />}
                  {copying ? 'กำลังคัดลอก…' : 'คัดลอก'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {srcModal && (
        <ItemSourcePicker
          existing={existingKeys}
          onClose={() => setSrcModal(false)}
          onPick={(row) => { setSrcModal(false); openFromSource(row); }}
          onSaved={(n) => {
            setToast({ ok: true, msg: `เพิ่มวัตถุดิบจากฐานข้อมูล ${n} รายการแล้ว` });
            load({ quiet: true });
          }} />
      )}
    </div>
  );
}

// ข้อความผลการบันทึก/ลบ ที่อยู่ "ในกล่อง" — ข้อความจากเซิร์ฟเวอร์ยาวได้ (เช่น สาเหตุที่ต่อ SQL ไม่ติด)
// จึงให้ขึ้นบรรทัดได้และจำกัดความสูงไว้ ไม่ให้ดันปุ่มตกจอ
function FormMsg({ ok, msg }) {
  return (
    <div className={`flex items-start gap-1.5 text-xs font-semibold max-h-28 overflow-auto ${ok ? 'text-emerald-600' : 'text-rose-600'}`}>
      {ok ? <CheckCircle size={13} className="flex-shrink-0 mt-0.5" /> : <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />}
      <span className="break-words whitespace-pre-wrap">{msg}</span>
    </div>
  );
}

// ช่องค้นหาเพื่อเพิ่มไอเทมทดแทน
function SubPicker({ items, exclude, onPick }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return items
      .filter(i => !exclude.includes(i.code) && i.status !== 'ปิดการใช้งาน')
      .filter(i => codeMatch(i.code, q) || i.name.toLowerCase().includes(q))
      .slice(0, 12);
  }, [items, exclude, query]);

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <Plus size={14} className="text-sky-500 flex-shrink-0" />
        <input value={query} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          placeholder="เพิ่มไอเทมทดแทน — พิมพ์ค้นหารหัส/ชื่อ…"
          className="flex-1 px-3 py-2 border border-dashed border-sky-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-sky-400" />
      </div>
      {open && suggestions.length > 0 && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-56 overflow-auto">
          {suggestions.map(s => (
            <button key={s.code} onMouseDown={() => { onPick(s.code); setQuery(''); setOpen(false); }}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-sky-50">
              <span className="font-mono text-xs text-slate-400 mr-1.5">{s.code}</span>{s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── เพิ่มวัตถุดิบจากฐานข้อมูล ───────────────────────
   ต้นทางคือข้อมูลที่ใช้งานอยู่จริงในฐาน InventoryNarai ฐานเดียวกับทะเบียนวัตถุดิบ:
     สูตรเมนู (qcrd_bom) · แพลนสั่งของ (stock_plan) · ปิดรอบสิ้นเดือน (stock_closing)
   ฝั่ง SQL คัด "ตัวที่ยังไม่มีใน stock_item" มาให้แล้ว (ดู lib/itemSourceSql.mjs)
   ที่นี่กรองซ้ำด้วยรายการที่หน้านี้โหลดมาจริงอีกชั้น เผื่อโหมดชีทที่ทะเบียนตัวจริงคือชีท

   กดที่แถว = เปิดฟอร์มเพิ่มวัตถุดิบที่กรอกให้แล้ว (ยังไม่บันทึก — ต้องเลือกสาขา/หน่วยใช้ต่อ)
   ติ๊กช่องซ้าย = เลือกหลายตัวแล้วบันทึกรวดเดียว ด้วย action addItem ตัวเดิมทีละรายการ   */
const ITEM_SRC_TABS = [
  { id: 'bom', label: 'สูตรเมนู' },
  { id: 'plan', label: 'แพลนสั่งของ' },
  { id: 'closing', label: 'ปิดรอบสิ้นเดือน' },
];

async function askItemSource(params) {
  const res = await fetch(`/api/qcrd-item-source?${params}`, { cache: 'no-store' });
  const json = await res.json().catch(() => ({ status: 'error', message: 'เซิร์ฟเวอร์ตอบกลับมาไม่ใช่ JSON' }));
  if (json.status !== 'success') throw new Error(json.message || 'อ่านข้อมูลไม่สำเร็จ');
  return json.data;
}

function ItemSourcePicker({ existing, onClose, onPick, onSaved }) {
  const [schema, setSchema] = useState(null);      // ต้นทางไหนอ่านได้ + เหลือให้เพิ่มกี่ตัว
  const [schemaErr, setSchemaErr] = useState('');  // อ่านสรุปไม่ได้ — ไม่ควรบังตารางที่ยังใช้ได้
  const [tab, setTab] = useState('bom');
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');          // ค่าที่หน่วงแล้ว (ยิงจริงด้วยตัวนี้)
  const [result, setResult] = useState(null);      // { rows, limited, source }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState({});        // 'src:code' -> แถวที่เลือกไว้ (ข้ามแท็บได้)
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(null);  // { done, total, name }
  const [saved, setSaved] = useState(null);        // { ok: [], fail: [] }

  useEffect(() => {
    let alive = true;
    askItemSource('schema=1')
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
    askItemSource(qs.toString())
      .then(d => { if (alive) { setResult(d); setLoading(false); } })
      .catch(err => { if (alive) { setError(err.message); setResult(null); setLoading(false); } });
    return () => { alive = false; };
  }, [tab, query]);

  const src = result?.source || {};
  const keyOf = (r, id = src.id) => `${id}:${r.code}`;
  const isDup = (r) => existing.has(normKey(r.code));
  // ต้นทางส่งมาเฉพาะตัวที่ไม่มีใน stock_item — ที่เหลือเป็นตัวซ้ำเฉพาะโหมดชีท ซ่อนไปเลยไม่ต้องอธิบาย
  const rows = (result?.rows || []).filter(r => !isDup(r));
  const hiddenDup = (result?.rows || []).length - rows.length;

  const pickedList = Object.values(picked);
  const allPicked = rows.length > 0 && rows.every(r => picked[keyOf(r)]);

  const toggle = (r) => setPicked(prev => {
    const k = keyOf(r);
    const next = { ...prev };
    if (next[k]) delete next[k];
    else next[k] = { ...r, srcId: src.id };   // จำต้นทางไว้ในตัวมันเอง (เลือกข้ามแท็บได้)
    return next;
  });
  const toggleAll = () => setPicked(prev => {
    const next = { ...prev };
    if (allPicked) rows.forEach(r => delete next[keyOf(r)]);
    else rows.forEach(r => { next[keyOf(r)] = { ...r, srcId: src.id }; });
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
      try {
        // ช่องเดียวกับฟอร์ม "เพิ่มวัตถุดิบ" ทุกช่อง — ที่ต้นทางไม่มีก็ว่างไว้ให้ไปแก้ต่อในทะเบียน
        await apiCall('addItem', {
          code: row.code, name: row.name, status: 'ใช้งาน', subs: [],
          price: row.price === null || row.price === undefined ? '' : String(row.price),
          unit: row.unit || '',
          converter: row.converter === null || row.converter === undefined ? '' : String(row.converter),
          branches: [], storeCategory: '', posItemId: '', requestUnit: '',
          itemType: row.itemType === PACKAGING ? PACKAGING : MATERIAL, usedWhen: '', useUnit: '',
        });
        ok.push(row);
      } catch (err) {
        fail.push({ row, msg: err.message || 'บันทึกไม่สำเร็จ' });
      }
    }
    setProgress(null);
    setSaving(false);
    setSaved({ ok, fail });
    // เอาตัวที่เข้าแล้วออกจากรายการที่เลือกไว้ เหลือไว้เฉพาะตัวที่ยังไม่ผ่าน กดซ้ำได้เลย
    setPicked(Object.fromEntries(fail.map(f => [keyOf(f.row, f.row.srcId), f.row])));
    if (ok.length) onSaved(ok.length);
  };

  const active = (schema || []).find(s => s.id === tab);

  return (
    <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <Database size={18} className="text-emerald-500" /> เพิ่มวัตถุดิบจากฐานข้อมูล
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              ของที่ <b>มีอยู่จริงในข้อมูลที่ใช้งานอยู่</b> แต่ยังไม่มีในทะเบียนวัตถุดิบ ·
              <b> กดที่แถว</b> = เปิดฟอร์มที่กรอกรหัส/ชื่อ/หน่วย/ราคาให้แล้ว เลือกสาขาและหน่วยใช้ต่อได้เลย
              · <b>ติ๊กช่องซ้าย</b> = เลือกหลายตัวแล้วบันทึกรวดเดียว (ยังไม่มีสาขา ค่อยมาใส่ทีหลัง)
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 flex-shrink-0"><X size={20} /></button>
        </div>

        {/* แท็บต้นทาง — ต้นทางที่อ่านไม่ได้ยังกดเข้าไปดูสาเหตุได้ ไม่ซ่อนทิ้งเฉย ๆ */}
        <div className="px-5 pt-3 flex flex-wrap gap-2">
          {(schema || ITEM_SRC_TABS).map(sc => (
            <button key={sc.id} onClick={() => setTab(sc.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${
                tab === sc.id ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
              {sc.label}
              {sc.ok === false && <span className="ml-1.5 text-rose-500">• อ่านไม่ได้</span>}
              {sc.ok && <span className="ml-1.5 font-mono text-[10px] text-slate-400">{sc.missing?.toLocaleString?.() ?? ''}</span>}
            </button>
          ))}
        </div>

        <div className="px-5 pt-3 pb-3 flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="ค้นหารหัส / ชื่อวัตถุดิบในต้นทางนี้…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          </div>
          {active?.ok && <span className="text-[11px] text-slate-400">{active.note}</span>}
          {active?.ok && <span className="text-[11px] text-slate-400 font-mono">{active.table}</span>}
        </div>

        {error && (
          <div className="mx-5 mb-3 p-3 bg-rose-50 border border-rose-100 rounded-xl text-xs text-rose-700 whitespace-pre-wrap">{error}</div>
        )}
        {/* อ่านสรุปต้นทางไม่ได้ = แท็บไม่มีจำนวนให้ดู แต่การค้นหายังใช้ได้ตามปกติ
            จึงเป็นข้อความเตือนสีเหลือง ไม่ใช่กล่องแดงที่ดูเหมือนทั้งหน้าต่างใช้ไม่ได้ */}
        {!error && schemaErr && (
          <div className="mx-5 mb-3 p-3 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-700 whitespace-pre-wrap">
            ดูสรุปของแต่ละต้นทางไม่ได้ (ค้นหาและบันทึกยังใช้ได้ตามปกติ): {schemaErr}
          </div>
        )}
        {!error && active?.ok === false && (
          <div className="mx-5 mb-3 p-3 bg-rose-50 border border-rose-100 rounded-xl text-xs text-rose-700 whitespace-pre-wrap">{active.error}</div>
        )}

        <div className="flex-1 overflow-y-auto border-t border-slate-100">
          {loading ? (
            <div className="p-10 text-center text-slate-400 text-sm">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />กำลังอ่านข้อมูล…
            </div>
          ) : !rows.length ? (
            <div className="p-10 text-center text-slate-400 text-sm">
              {query ? `ไม่เจอวัตถุดิบที่ตรงกับ "${query}"`
                : 'ไม่มีตัวไหนในต้นทางนี้ที่ยังไม่มีในทะเบียน — ครบแล้ว'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0">
                <tr className="text-left text-[11px] uppercase text-slate-400">
                  <th className="px-4 py-2 w-10">
                    <input type="checkbox" checked={allPicked} onChange={toggleAll} className="rounded" title="เลือกทั้งหน้า" />
                  </th>
                  <th className="px-4 py-2">รหัส</th>
                  <th className="px-4 py-2">ชื่อวัตถุดิบ</th>
                  <th className="px-4 py-2">หน่วย</th>
                  <th className="px-4 py-2 text-right">ราคา</th>
                  <th className="px-4 py-2">เจอที่ไหน</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const on = Boolean(picked[keyOf(r)]);
                  return (
                    <tr key={keyOf(r)} onClick={() => onPick && onPick(r)}
                      title="กดเพื่อเปิดฟอร์มเพิ่มวัตถุดิบตัวนี้"
                      className={`border-b border-slate-50 cursor-pointer ${on ? 'bg-emerald-50/60' : 'hover:bg-slate-50'}`}>
                      {/* ติ๊กช่องนี้ = เลือกไว้บันทึกรวดเดียวหลายตัว (ไม่เปิดฟอร์ม) จึงต้องกันไม่ให้คลิกทะลุไปถึงแถว */}
                      <td className="px-4 py-2" onClick={e => { e.stopPropagation(); toggle(r); }}>
                        <input type="checkbox" checked={on} readOnly className="rounded"
                          title="เลือกไว้บันทึกพร้อมกันหลายตัว" />
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-500">{r.code}</td>
                      <td className="px-4 py-2">
                        {r.name || <span className="text-slate-300">(ไม่มีชื่อในต้นทาง)</span>}
                        {r.converter > 0 && (
                          <span className="ml-1.5 px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded-full text-[10px] font-mono align-middle">
                            ÷{r.converter}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-500">{r.unit || '—'}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs">{r.price === null ? '—' : fmt(r.price)}</td>
                      <td className="px-4 py-2 text-[11px] text-slate-400">
                        {tab === 'bom' ? `ใช้ใน ${r.uses} เมนู` : `${r.uses} ครั้ง${r.seen ? ` · ล่าสุด ${r.seen}` : ''}`}
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
                <span>เพิ่มแล้ว {saved.ok.length} รายการ: {saved.ok.map(r => r.code).join(', ')}</span>
              </p>
            )}
            {saved.fail.map(f => (
              <p key={keyOf(f.row, f.row.srcId)} className="text-rose-700 flex items-start gap-1.5">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
                <span>{f.row.code} {f.row.name} — {f.msg}</span>
              </p>
            ))}
          </div>
        )}

        <div className="p-4 border-t border-slate-100 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-slate-500">
            เลือกไว้ <b className="text-slate-700">{pickedList.length}</b> รายการ
            {hiddenDup > 0 && <span className="ml-1.5 text-slate-400">· ซ่อนตัวที่มีในทะเบียนแล้ว {hiddenDup}</span>}
            {progress && (
              <span className="ml-2 text-emerald-600">กำลังบันทึก {progress.done + 1}/{progress.total} — {progress.name}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-4 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">ปิด</button>
            <button onClick={doSave} disabled={!pickedList.length || saving}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-200 disabled:text-slate-400 rounded-xl">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              บันทึก {pickedList.length || ''} รายการ
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
