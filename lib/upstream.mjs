// ตัวช่วยเรียก API ปลายทางทั้งหมดของโปรเจกต์ — ยกชุดเดียวกับ lib/upstream.js ของ Narai-branch
// (ที่นั่นเป็นนามสกุล .js — ที่นี่ใช้ .mjs เพราะสคริปต์ node ใน scripts/ ก็ import ผ่าน lib/*.mjs ด้วย)
// เพื่อให้ทั้งสองรีโปที่ยิงเข้าเครื่องออฟฟิศตัวเดียวกัน มี timeout / retry / ข้อความ error ชุดเดียวกัน
//
// ทำไมต้องมีไฟล์นี้: เดิม pages/api/*.js เรียก fetch() เปล่าๆ ไม่มี timeout ไม่มี retry
//  - ถ้าเครื่องออฟฟิศปิด/เน็ตออฟฟิศหลุด/IP dyndns เพิ่งเปลี่ยน -> fetch ค้างจนฟังก์ชัน Vercel หมดเวลา
//    แล้วตอบกลับเป็นหน้า error ของ Vercel (ไม่ใช่ JSON) -> ฝั่งเว็บอ่านไม่ออก เด้ง "ติดต่อเซิร์ฟเวอร์ไม่ได้"
//  - ช่วงเซิร์ฟเวอร์ที่ออฟฟิศเพิ่งรีสตาร์ท (กำลังอุ่น cache) จะช้าเป็นพักๆ ลองใหม่ครั้งเดียวก็มักผ่าน
//
// ปลายทางมีสองเครื่อง (คนละ process แต่เป็นเครื่องเดียวกันที่ออฟฟิศ):
//   USAGE_API_BASE  office-server ของ Narai-branch (พอร์ต 8787) — /usagebymenu, /usagebytable,
//                   /attendance, /schedule, /dashboard
//   STORE_API_BASE  host-server ของรีโปนี้ (host-server/server.js ผ่าน tunnel)
//                   — /cpaidbetweendate, /ctranbetweendate, /qcrd/*, /sheets/*
// ตั้ง env ทับได้ทั้งคู่เวลาเปลี่ยน dyndns/พอร์ต/tunnel

export const USAGE_API_BASE = (process.env.USAGE_API_BASE || 'http://storenarai.dyndns.tv:8787').replace(/\/+$/, '');
export const STORE_API_BASE = (process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com').replace(/\/+$/, '');

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 1000;

// สำหรับ endpoint ที่ปลายทางต้องคำนวณข้ามหลายวัน (sales / detail / usagebymenu / usage-bom):
// วันไหนยังไม่อยู่ในแคชรายวันต้องดึงจาก POS สด กินเวลาได้หลายสิบวินาที — timeout ดีฟอลต์ 20 วิ
// จะตัดการเชื่อมต่อทิ้งทั้งที่ปลายทางกำลังคำนวณใกล้เสร็จ ทำให้ข้อมูลไม่ขึ้น
// จึงให้รอยาวใกล้เพดาน maxDuration 60 วิ ของฟังก์ชัน Vercel แทน
// retries เผื่อไว้สำหรับ error ที่ล้มเร็ว (เช่นต่อไม่ติดชั่ววินาที) — deadlineMs กันลองใหม่จนเกินเพดานรวม
export const HEAVY_UPSTREAM_OPTS = { timeoutMs: 50000, retries: 2, deadlineMs: 55000 };

/** คำสั่งเขียน — ห้ามลองใหม่อัตโนมัติ เพราะคำสั่งอาจถึงปลายทางแล้วแต่คำตอบหายกลางทาง = เขียนซ้ำ */
export const WRITE_UPSTREAM_OPTS = { timeoutMs: 60000, retries: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class UpstreamError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'UpstreamError';
    this.cause = cause;
  }
}

const describe = (err, timedOut) => {
  if (timedOut) {
    return 'เซิร์ฟเวอร์ที่ออฟฟิศไม่ตอบสนองภายในเวลาที่กำหนด — เครื่องอาจกำลังโหลดข้อมูลอยู่ หรือเน็ตที่ออฟฟิศช้า กรุณาลองใหม่อีกครั้ง';
  }
  const code = err?.cause?.code || err?.code || '';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) {
    return 'หาที่อยู่เซิร์ฟเวอร์ที่ออฟฟิศไม่เจอ (dyndns อาจยังไม่อัปเดต IP ใหม่)';
  }
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT/.test(code)) {
    return 'ติดต่อเซิร์ฟเวอร์ที่ออฟฟิศไม่ได้ — เครื่องที่ออฟฟิศอาจปิดอยู่ หรือพอร์ตไม่ได้เปิด';
  }
  return 'ติดต่อเซิร์ฟเวอร์ที่ออฟฟิศไม่ได้ กรุณาลองใหม่อีกครั้ง';
};

/**
 * fetch ไปเซิร์ฟเวอร์ที่ออฟฟิศ พร้อม timeout + ลองใหม่อัตโนมัติ
 * โยน UpstreamError ที่มีข้อความภาษาไทยบอกสาเหตุ เมื่อยังต่อไม่ได้หลังลองครบ
 * deadlineMs = เวลารวมทุกครั้งรวมกัน (กันการลองใหม่ลากยาวเกินเพดาน maxDuration ของฟังก์ชัน Vercel)
 *
 * หมายเหตุ: ใส่ ngrok-skip-browser-warning ให้ทุกคำขอ เพราะ tunnel ของ host-server บางตัว
 * จะแทรกหน้าเตือนเป็น HTML ถ้าไม่มี header นี้ แล้วฝั่งเราจะ parse JSON ไม่ผ่าน
 */
export async function fetchUpstream(url, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, deadlineMs, headers, ...init } = {}) {
  const deadline = deadlineMs ? Date.now() + deadlineMs : null;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const remaining = deadline ? deadline - Date.now() : Infinity;
    if (remaining < 1500) break; // เวลาที่เหลือน้อยเกินกว่าจะยิงอีกรอบให้ทันอยู่แล้ว
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        ...init,
        headers: { 'ngrok-skip-browser-warning': 'true', ...(headers || {}) },
        signal: controller.signal,
      });
      // 5xx ของปลายทาง = พลาดชั่วคราว (เช่นกำลังโหลด cache อยู่) ลองใหม่ได้
      if (res.status >= 500 && attempt < retries) {
        lastError = new UpstreamError(`เซิร์ฟเวอร์ที่ออฟฟิศตอบผิดพลาด (HTTP ${res.status})`);
      } else {
        return res;
      }
    } catch (err) {
      lastError = new UpstreamError(describe(err, controller.signal.aborted), err);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(RETRY_DELAY_MS);
  }
  throw lastError || new UpstreamError(describe(null, true));
}

/**
 * fetch ชีท Google (gviz/export) พร้อม timeout + ลองใหม่
 * Google เองก็มีจังหวะช้า/ตอบ 5xx เป็นครั้งคราว ถ้าไม่ลองใหม่จะกลายเป็น error เด้งใส่ผู้ใช้ทันที
 */
export async function fetchSheet(url, options = {}) {
  try {
    return await fetchUpstream(url, { timeoutMs: 15000, retries: 2, redirect: 'follow', ...options });
  } catch (err) {
    throw new UpstreamError('อ่านข้อมูลจาก Google Sheet ไม่ได้ กรุณาลองใหม่อีกครั้ง', err);
  }
}

/**
 * fetch Google Apps Script — เป็นคำสั่งเขียนเป็นส่วนใหญ่ จึงไม่ลองใหม่ให้เอง
 * (ยิงซ้ำ = อาจได้แถวซ้ำในชีท) ฝั่งอ่านล้วนส่ง retries เข้ามาเองได้
 */
export async function fetchScript(url, options = {}) {
  return fetchUpstream(url, { timeoutMs: 60000, retries: 0, redirect: 'follow', ...options });
}

/** ตั้ง CORS header ชุดเดียวกับที่ api/*.js ใช้อยู่ คืน true ถ้าเป็น preflight (จบ request แล้ว) */
export function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

/** ตอบ error กลับไปเป็น JSON เสมอ — ฝั่งเว็บจะได้โชว์สาเหตุจริงแทน "ติดต่อเซิร์ฟเวอร์ไม่ได้" ลอยๆ */
export function replyUpstreamError(res, error, context) {
  console.error(`${context} error:`, error);
  const isUpstream = error instanceof UpstreamError;
  const message = isUpstream ? error.message : (error?.message || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ');
  return res.status(isUpstream ? 503 : 500).json({
    status: 'error',
    message,
    // หน้าแดชบอร์ด (safeFetchJson ใน pages/index.js) อ่านสาเหตุจากคีย์ error
    error: message,
  });
}
