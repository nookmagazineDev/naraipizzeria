// ทะเบียนสาขา — ตัวช่วยที่ใช้ร่วมกันทั้งฝั่งหน้าเว็บและฝั่งเซิร์ฟเวอร์
//
// ตัวจริงอยู่ใน lib/branchCore.mjs — ต้องเป็น .mjs เพราะ lib/branchSql.mjs (ตรรกะ SQL
// ที่ host-server บนเครื่องออฟฟิศ import ตรง ๆ ด้วย node) เรียกใช้ helper ชุดเดียวกันนี้
// node โหลด .js ในโปรเจกต์นี้เป็น CommonJS จึง import จากไฟล์ .js ที่เขียนแบบ ESM ไม่ได้
//
// ไฟล์นี้เหลือไว้เป็นทางเข้าเดิม ตัวที่ import 'lib/branches' อยู่แล้วจึงไม่ต้องแก้สักที่
export * from './branchCore.mjs';
