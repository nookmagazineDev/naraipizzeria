// ตัวช่วยฝั่งหน้าเว็บ — ดึงทะเบียนสาขาจาก /api/branches มาเติม dropdown
//
// ใช้ที่หน้า "ดูสแกนหน้า", QC/RD วัตถุดิบ และค่าใช้จ่ายอื่นๆ ให้ทั้งสามหน้าเห็นสาขาชุดเดียวกัน
// แก้ทะเบียนที่หน้า HR → จัดการสาขา ที่เดียว ทุกหน้าตามทันที ไม่ต้องแก้โค้ดแล้ว deploy
//
// /api/branches ถอยไปใช้รายชื่อสำรองให้เองอยู่แล้วเมื่อต่อฐานไม่ได้ ตัวนี้จึงถอยซ้ำอีกชั้น
// เฉพาะตอนที่ยิง API ไม่ถึงเลย (เน็ตหลุด/ฟังก์ชันล่ม) — dropdown สาขาต้องไม่มีวันว่าง
import { useState, useEffect } from 'react';
import { FALLBACK_BRANCH_CODES, STATUS_INACTIVE } from './branches';

// ── กันไม่ให้ dropdown ค้างสาขาที่เพิ่งแก้ไป โดยไม่ทิ้งแคชของ CDN ────────────────────
//
// /api/branches แคชไว้ที่ CDN (s-maxage=30 + stale-while-revalidate=120) ถ้ายิง URL เดิมเฉย ๆ
// หลังปิด/เพิ่มสาขาที่หน้า "จัดการสาขา" หน้าอื่นจะยังเห็นทะเบียนชุดเก่าได้ถึงสองนาทีครึ่ง
//
// ทางที่ง่ายที่สุดคือต่อ ?t=<เวลา> ทุกครั้ง แต่แบบนั้นแคชตายสนิท — ทุกหน้าที่มี dropdown สาขา
// (ดูสแกนหน้า · QC/RD วัตถุดิบ · ค่าใช้จ่ายอื่นๆ · ใบกำกับภาษี · เงินเดือน · ปิดรอบสิ้นเดือน ·
// บัญชีของสาขา) จะต้องวิ่งไปถึงฐานที่ร้านใหม่ทุกครั้งที่เปิด
//
// จึงใช้ "ตราเวลา" แทน: หน้าจัดการสาขาบันทึกสำเร็จเมื่อไหร่ ประทับเวลาไว้ใน localStorage
// ทุกหน้าเอาค่านั้นมาต่อท้าย URL — ไม่มีใครแก้ทะเบียน URL ก็คงเดิม แคชทำงานตามปกติ
// พอมีคนแก้ URL เปลี่ยนทันที ทุกหน้าที่เปิดหลังจากนั้นในเบราว์เซอร์นี้จึงได้ของใหม่แน่นอน
//
// ⚠️ ตราเวลาอยู่ในเบราว์เซอร์ของคนที่กดแก้เท่านั้น เครื่องอื่นยังได้ของเก่าได้ไม่เกิน 150 วิ
//    ตามอายุแคช ซึ่งรับได้สำหรับตัวเติม dropdown (ไม่ใช่ข้อมูลที่เอาไปคิดเลข)
const STAMP_KEY = 'naraiBranchRegistryStamp';

/** ค่าตราเวลาปัจจุบัน — อ่านไม่ได้ (โหมดส่วนตัว/ปิดที่เก็บไว้) ถือว่ายังไม่เคยมีใครแก้ */
export const branchRegistryStamp = () => {
  try { return window.localStorage.getItem(STAMP_KEY) || ''; } catch { return ''; }
};

/** ส่วนท้าย URL ที่ต้องต่อเวลาเรียก /api/branches เอง (หน้าที่ไม่ได้ใช้ useBranches) */
export const branchRegistryQuery = () => {
  const stamp = branchRegistryStamp();
  return stamp ? `?v=${stamp}` : '';
};

/**
 * ประทับเวลาว่าทะเบียนสาขาเพิ่งเปลี่ยน — เรียกหลังบันทึก/ลบสำเร็จที่หน้าจัดการสาขา
 * หน้าที่เปิดหลังจากนี้จะข้ามแคชที่ค้างอยู่ให้เอง
 */
export function markBranchRegistryChanged() {
  try { window.localStorage.setItem(STAMP_KEY, String(Date.now())); } catch { /* เก็บไม่ได้ก็ช่างมัน */ }
}

/**
 * @param {{ activeOnly?: boolean }} opts activeOnly = ตัดสาขาที่ปิดการใช้งานออก (ค่าเริ่มต้น: ตัด)
 * @returns {{ branches: Array, codes: string[], loading: boolean, warning: string }}
 *   branches = [{ code, name, outletId, status, note, sortOrder }] เรียงตามลำดับในทะเบียนแล้ว
 *   codes    = รหัสสาขาอย่างเดียว ใช้แทนค่าคงที่ BRANCHES ที่เคย hardcode ไว้ได้เลย
 */
export function useBranches({ activeOnly = true } = {}) {
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [warning, setWarning] = useState('');

  useEffect(() => {
    let alive = true;   // เปลี่ยนหน้าไปก่อนโหลดเสร็จ = อย่า setState ใส่คอมโพเนนต์ที่ถูกถอดไปแล้ว
    fetch(`/api/branches${branchRegistryQuery()}`)
      .then((r) => r.json())
      .then((res) => {
        if (!alive) return;
        setBranches(Array.isArray(res.data) ? res.data : []);
        setWarning(res.warning || '');
      })
      .catch((err) => {
        if (!alive) return;
        // ยิง API ไม่ถึง — ใช้รายชื่อที่ฝังไว้ในโค้ด ดีกว่าปล่อย dropdown ว่าง
        setBranches(FALLBACK_BRANCH_CODES.map((code, i) => ({
          code, name: '', outletId: null, status: 'ใช้งาน', note: '', sortOrder: i + 1,
        })));
        setWarning(`โหลดทะเบียนสาขาไม่ได้ (${err.message}) — ใช้รายชื่อสำรองในโค้ดแทน`);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const usable = activeOnly ? branches.filter((b) => b.status !== STATUS_INACTIVE) : branches;
  return { branches: usable, codes: usable.map((b) => b.code), loading, warning };
}
