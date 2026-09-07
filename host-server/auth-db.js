// ════════════════════════════════════════════════════════════
//  ผู้ใช้และสิทธิ์เมนู — ตาราง InventoryNarai.dbo.app_user
//  โครงตารางอยู่ใน docs/schema-app-user.sql · วิธีตั้งค่าอยู่ใน docs/login-permissions.md
//
//  ทำไมต้องมีทางนี้: หน้าเว็บบน Vercel ต่อ SQL ที่ร้านตรง ๆ ไม่ได้เป็นปกติ
//  (ไฟร์วอลล์เปิดให้เฉพาะ IP ในไทย — ดู lib/directRoute.js) ถ้าไม่มี endpoint ชุดนี้
//  หน้า "จัดการผู้ใช้" จะสร้างตารางไม่ได้ เพิ่มคนไม่ได้ และคนที่มีบัญชีจริงจะล็อกอินไม่ได้เลย
//
//  endpoint
//    GET  /auth/ping                     ต่อฐานได้ไหม + มีตาราง app_user แล้วหรือยัง
//    POST /auth/verify  { username, password }   ตรวจรหัสผ่าน (ต้องมี header x-api-key)
//    GET  /auth/users                    รายชื่อผู้ใช้ทั้งหมด (ต้องมี x-api-key)
//    POST /auth/save    { action, ... }  saveUser · deleteUser · resetPassword · createTable
//                                        · changeOwnPassword   (ต้องมี x-api-key)
//
//  ⚠️ ทุก endpoint ที่ไม่ใช่ ping ต้องมีกุญแจ — ชุดนี้แจกสิทธิ์เข้าถึงทุกเมนูของแดชบอร์ดได้
//     และ API ตัวนี้เปิดออกเน็ตผ่าน tunnel ไม่มีกุญแจ = ปิดทั้งชุด (ไม่ใช่เปิดให้อ่านอย่างเดียว)
//     ตั้ง env AUTH_API_KEY บนเครื่องนี้ แล้วตั้งค่าเดียวกันบน Vercel
//     ไม่ได้ตั้ง จะถอยไปใช้ QCRD_WRITE_KEY ที่มีอยู่แล้ว (เครื่องเดียวกัน ความเชื่อใจระดับเดียวกัน)
//
//  รหัสผ่านจริงถูกส่งมาที่ /auth/verify เพราะเครื่องนี้เป็นเจ้าของฐาน — ดีกว่าส่ง hash
//  ออกไปให้ Vercel ตรวจเอง (hash หลุดออกนอกเครื่องแล้วเอาไปไล่เดาออฟไลน์ได้)
// ════════════════════════════════════════════════════════════
const express = require('express');
const path = require('path');
const fs = require('fs');
const { q } = require('./qcrd-db'); // ฐาน InventoryNarai ตัวเดียวกันเป๊ะ ใช้ pool ร่วมกัน

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

// ตรรกะทั้งหมดอยู่ที่ lib/authSql.mjs ชุดเดียวกับที่ฝั่ง Vercel ใช้ตอนต่อ SQL ตรงได้
// (เหตุผลเดียวกับ getCore() ใน qcrd-db.js — ไม่ให้มีสองสำเนาให้แก้ตามกันทีหลัง)
async function importFirst(paths) {
  let lastErr;
  for (const p of paths) {
    try { return await import(p); } catch (err) { lastErr = err; }
  }
  throw new Error(`หาไฟล์ ${paths[0]} ไม่เจอ (ลองแล้ว: ${paths.join(', ')}) — ${lastErr?.message || ''}`);
}

let storePromise = null;
function getStore() {
  if (!storePromise) {
    storePromise = importFirst(['../lib/authSql.mjs', './authSql.mjs'])
      .then((m) => m.createAuthStore({ q }))
      .catch((err) => { storePromise = null; throw err; });
  }
  return storePromise;
}

/** หาไฟล์สคีมา — เครื่องที่ก๊อปมาเฉพาะไฟล์ (ไม่ได้เช็กเอาต์ทั้งรีโป) อาจไม่มี */
function readSchema() {
  const tries = [
    path.join(__dirname, '..', 'docs', 'schema-app-user.sql'),
    path.join(__dirname, 'schema-app-user.sql'),
  ];
  for (const f of tries) {
    try { return fs.readFileSync(f, 'utf8'); } catch { /* ลองที่ถัดไป */ }
  }
  throw new Error(
    'หาไฟล์ docs/schema-app-user.sql บนเครื่องนี้ไม่เจอ — git pull ที่เครื่องนี้ก่อน ' +
    'หรือรันไฟล์นั้นด้วย SQL Server Management Studio เองครั้งเดียว'
  );
}

function mountAuth(app) {
  // ใช้กุญแจของ QC/RD ได้ถ้ายังไม่ได้ตั้งของตัวเอง — เครื่องเดียวกัน ความเชื่อใจระดับเดียวกัน
  // จะได้ไม่ต้องไปตั้ง env เพิ่มอีกตัวทั้งสองฝั่งตอนเริ่มใช้
  const API_KEY = process.env.AUTH_API_KEY || process.env.QCRD_WRITE_KEY || '';

  const send = (res, promise, label) =>
    promise
      .then((data) => res.json({ status: 'success', data }))
      .catch((err) => {
        console.error(`auth ${label} error:`, err.message);
        res.status(err.badRequest ? 400 : 500).json({ status: 'error', message: err.message });
      });

  /** ไม่มีกุญแจ = ปิดทั้งชุด (ไม่ใช่เปิดให้อ่าน) เพราะรายชื่อผู้ใช้ก็เป็นข้อมูลอ่อนไหว */
  const requireKey = (req, res) => {
    if (!API_KEY) {
      res.status(503).json({
        status: 'error',
        message: 'ยังไม่ได้ตั้ง env AUTH_API_KEY (หรือ QCRD_WRITE_KEY) บนเครื่องโฮสต์ — ' +
          'ระบบผู้ใช้ผ่าน host API ถูกปิดไว้',
      });
      return false;
    }
    if (str(req.get('x-api-key')) !== API_KEY) {
      res.status(401).json({ status: 'error', message: 'x-api-key ไม่ถูกต้อง' });
      return false;
    }
    return true;
  };

  // ping ห้ามพัง — เป็นตัวที่คนเปิดจากเบราว์เซอร์เพื่อไล่ว่าติดตรงไหน
  // ต่อฐานไม่ได้ให้ตอบ 200 พร้อมบอกสาเหตุ ไม่ใช่ 500 เปล่า ๆ ที่ไล่ต่อไม่ถูก
  app.get('/auth/ping', async (req, res) => {
    const out = { ok: true, tableReady: false, hasKey: Boolean(API_KEY) };
    try {
      const store = await getStore();
      out.tableReady = await store.tableIsReady();
    } catch (err) {
      out.ok = false;
      out.message = err.message;
    }
    res.json({ status: 'success', data: out });
  });

  app.post('/auth/verify', express.json(), (req, res) => {
    if (!requireKey(req, res)) return;
    const body = req.body || {};
    return send(res, getStore().then((store) => store.verifyLogin(body.username, body.password)), 'verify');
  });

  app.get('/auth/users', (req, res) => {
    if (!requireKey(req, res)) return;
    return send(res, getStore().then((store) => store.listUsers()), 'users');
  });

  app.post('/auth/save', express.json({ limit: '1mb' }), (req, res) => {
    if (!requireKey(req, res)) return;
    const body = req.body || {};
    const action = str(body.action);
    const actor = str(body.actor);

    return send(res, getStore().then((store) => {
      if (action === 'createTable') return store.createTable(readSchema());
      if (action === 'saveUser') return store.saveUser(body, { actor });
      if (action === 'deleteUser') return store.deleteUser(body.username, { actor });
      if (action === 'resetPassword') return store.setPassword(body.username, body.password, { actor });
      if (action === 'changeOwnPassword') {
        return store.changeOwnPassword(body.username, body.currentPassword, body.newPassword);
      }
      throw Object.assign(new Error(`unknown action: ${action}`), { badRequest: true });
    }), action);
  });
}

module.exports = { mountAuth };
