// รหัสผ่านของ "ผู้ใช้ฝั่งสาขา" (narai_hr.dbo.hr_user) — คนละรูปแบบกับ lib/authHash.mjs
//
// ⚠️⚠️ ไฟล์นี้ต้องตรงกับ Narai-branch/office-server/hr-password.js เป๊ะทุกตัวอักษร
//      คนที่ตรวจรหัสตอนสาขาล็อกอินคือไฟล์นั้น ไม่ใช่ไฟล์นี้ — เขียนคนละรูปแบบเมื่อไหร่
//      คือ "ตั้งรหัสใหม่จากหน้าออฟฟิศแล้วสาขาล็อกอินไม่ได้" ซึ่งรู้ตัวตอนสาขาโทรมาเท่านั้น
//
// ทำไมไม่ใช้ lib/authHash.mjs ที่มีอยู่แล้ว: สอง KDF ใช้ scrypt พารามิเตอร์เดียวกันทุกตัว
// (N=16384, r=8, p=1, key 32 ไบต์) แต่ "เก็บ" คนละรูปแบบ
//     lib/authHash.mjs (app_user ของแดชบอร์ดนี้)  scrypt$<N>$<salt hex>$<key hex>
//     ไฟล์นี้        (hr_user ของระบบตารางงาน)   scrypt$<N>$<r>$<p>$<salt b64>$<key b64>
// ตัวตรวจของแต่ละฝั่งนับจำนวนช่องที่คั่นด้วย $ แล้วปฏิเสธถ้าไม่ตรงจำนวน เอาไปสลับกันไม่ได้
//
// (ที่พารามิเตอร์ตรงกันแปลว่าถ้าวันหน้าจะรวมสองตารางเป็นตารางเดียวจริง ๆ แปลงข้ามกันได้
//  โดยไม่มีใครต้องตั้งรหัสใหม่ — แค่ถอด hex เป็น base64 ไม่ต้องรู้รหัสจริง)
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;
const PREFIX = 'scrypt$';

/** ค่านี้เข้ารหัสไว้แล้วหรือยัง — ที่ไม่ใช่คือข้อความล้วนที่ตกค้างมาจากตอนย้ายจากชีท */
export const isHashed = (stored) => typeof stored === 'string' && stored.startsWith(PREFIX);

/** แปลงรหัสเป็นค่าที่เก็บลงคอลัมน์ hr_user.password_hash ได้ */
export function hashHrPassword(plain) {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(String(plain), salt, KEYLEN, { N, r: R, p: P });
  return `${PREFIX}${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * ตรวจรหัสกับค่าที่เก็บไว้ — หน้าออฟฟิศไม่ได้ใช้ตรวจตอนล็อกอิน (ฝั่งสาขาตรวจเอง)
 * มีไว้ให้เทสต์ยืนยันว่ารูปแบบที่เขียนออกไปยังตรงกับที่อีกฝั่งอ่านได้อยู่
 * รูปแบบเสีย/ว่าง = ไม่ผ่าน ไม่ใช่ผ่านทุกคน
 */
export function verifyHrPassword(plain, stored) {
  const input = String(plain ?? '');
  const saved = String(stored ?? '');
  if (!input || !saved || !isHashed(saved)) return false;

  const parts = saved.slice(PREFIX.length).split('$');
  if (parts.length !== 5) return false;
  const [n, r, p, saltB64, hashB64] = parts;
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(cost.N) || !Number.isInteger(cost.r) || !Number.isInteger(cost.p)) return false;

  try {
    const want = Buffer.from(hashB64, 'base64');
    const got = scryptSync(input, Buffer.from(saltB64, 'base64'), want.length, cost);
    return want.length === got.length && timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

/**
 * รหัสผ่านที่ตั้งให้สาขาต้องยาวพอ — คืน '' ถ้าผ่าน หรือข้อความบอกสาเหตุ
 *
 * เกณฑ์หลวมกว่าบัญชีออฟฟิศ (lib/permissions.js → validatePassword) โดยตั้งใจ:
 * รหัสพวกนี้คนหน้าร้านหลายคนใช้ร่วมกันและต้องบอกกันทางโทรศัพท์ได้
 * บังคับอักขระพิเศษแล้วจะได้รหัสที่ถูกจดแปะไว้ข้างเครื่อง ซึ่งแย่กว่าเดิม
 */
export function validateHrPassword(pw) {
  const s = String(pw ?? '');
  if (!s) return 'ต้องกรอกรหัสผ่าน';
  if (s.length < 8) return 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัว';
  if (s.length > 100) return 'รหัสผ่านยาวเกินไป (ไม่เกิน 100 ตัว)';
  if (/\s/.test(s)) return 'รหัสผ่านต้องไม่มีช่องว่าง — พิมพ์ตอนล็อกอินแล้วพลาดง่าย';
  return '';
}
