// ตัวช่วยฝั่งหน้าเว็บ — ดึงทะเบียนสาขาจาก /api/branches มาเติม dropdown
//
// ใช้ที่หน้า "ดูสแกนหน้า", QC/RD วัตถุดิบ และค่าใช้จ่ายอื่นๆ ให้ทั้งสามหน้าเห็นสาขาชุดเดียวกัน
// แก้ทะเบียนที่หน้า HR → จัดการสาขา ที่เดียว ทุกหน้าตามทันที ไม่ต้องแก้โค้ดแล้ว deploy
//
// /api/branches ถอยไปใช้รายชื่อสำรองให้เองอยู่แล้วเมื่อต่อฐานไม่ได้ ตัวนี้จึงถอยซ้ำอีกชั้น
// เฉพาะตอนที่ยิง API ไม่ถึงเลย (เน็ตหลุด/ฟังก์ชันล่ม) — dropdown สาขาต้องไม่มีวันว่าง
import { useState, useEffect } from 'react';
import { FALLBACK_BRANCH_CODES, STATUS_INACTIVE } from './branches';

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
    fetch('/api/branches')
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
