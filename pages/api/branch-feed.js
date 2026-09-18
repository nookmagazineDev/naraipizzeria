// เส้นจ่ายทะเบียนสาขาออกไปให้โปรเจคอื่น — อ่านอย่างเดียว ใช้กุญแจของระบบ
//
//   GET /api/branch-feed
//       header: x-branch-key: <BRANCH_FEED_KEY>   (หรือ ?key= สำหรับเครื่องมือที่ตั้ง header ไม่ได้)
//       -> { status, version, updatedAt, source, count, data: [...], aliases: {...} }
//
// ใครใช้: narai-storefct (ระบบสโตร์/ครัวกลาง) ที่เดิม hardcode ตาราง BRANCH_MAP ไว้เอง
//         ฝั่งระบบตารางงาน (Narai-branch) ไม่ได้ใช้เส้นนี้ — อยู่บนอินสแตนซ์ SQL เดียวกับ
//         ทะเบียนแม่อยู่แล้ว จึงอ่านข้ามฐานผ่าน view ตรง ๆ (ดู docs/branch-hub.md เฟส 3)
//
// ⚠️ ทำไมไม่ให้ใช้ /api/branches ที่มีอยู่แล้ว
//    เส้นนั้นอยู่หลังคุกกี้ล็อกอินของ "คน" (middleware.js) ถ้าเจาะรูให้กุญแจของ "ระบบ"
//    ผ่านด้วย จะกลายเป็นเส้นเดียวที่มีสองระบบสิทธิ์ปนกัน ซึ่งพลาดง่ายมากเวลามีคนมาแก้ทีหลัง
//    เส้นนี้ทำหน้าที่เดียว: จ่ายทะเบียนออกไปข้างนอก เขียนไม่ได้ ไม่มี POST
//
// ⚠️ เส้นนี้อยู่ใน PUBLIC_PATHS ของ middleware.js (ผ่านด่านล็อกอินไปได้) ตัวกันจริงคือ
//    การเทียบกุญแจในไฟล์นี้ — ไม่ได้ตั้ง BRANCH_FEED_KEY = ปิดเส้นนี้ทั้งเส้น ไม่ใช่เปิดโล่ง
import { createHash } from 'node:crypto';
import { readBranchRegistry, readBranchAliases } from '../../lib/sheetsSource';
import { FALLBACK_BRANCHES, FALLBACK_ALIASES, STATUS_ACTIVE } from '../../lib/branches';

export const config = { maxDuration: 30 };

// แคชที่ CDN ยาวกว่า /api/branches เพราะฝั่งที่กินข้อมูลเป็นเซิร์ฟเวอร์ที่แคชต่ออีกชั้นอยู่แล้ว
// ไม่ใช่หน้าเว็บที่คนเพิ่งกดบันทึกแล้วอยากเห็นผลทันที
const CACHE_OK = 'public, s-maxage=300, stale-while-revalidate=900';

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * เทียบกุญแจแบบใช้เวลาเท่ากันเสมอ — เทียบด้วย === ตรง ๆ จะหยุดที่ตัวอักษรตัวแรกที่ต่าง
 * ซึ่งเวลาที่ต่างกันนั้นวัดได้จากภายนอกและใช้เดากุญแจทีละตัวได้
 * (ยาวไม่เท่ากันถือว่าไม่ตรงทันที — ความยาวไม่ใช่ความลับ)
 */
function sameKey(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** ลายเซ็นของเนื้อทะเบียน — ฝั่งที่กินข้อมูลเอาไปเทียบว่าต้องล้างแคชไหม โดยไม่ต้องไล่ทีละแถว */
const versionOf = (payload) =>
  createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 12);

/** รายชื่อสำรองในโค้ด — รูปแบบเดียวกับที่อ่านจากฐาน ฝั่งที่กินข้อมูลจึงไม่ต้องรู้ว่ามาจากไหน */
const fallbackData = () =>
  FALLBACK_BRANCHES.map((b, i) => ({
    code: b.code, name: '', outletId: b.outletId,
    status: b.status || STATUS_ACTIVE, note: '', sortOrder: i + 1,
    region: '', openedAt: null, closedAt: null, posDbKey: '',
  }));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'GET เท่านั้น' });
  }

  const expected = str(process.env.BRANCH_FEED_KEY);
  if (!expected) {
    return res.status(503).json({
      status: 'error',
      message: 'ยังไม่ได้เปิดเส้นจ่ายทะเบียนสาขา — ตั้ง BRANCH_FEED_KEY บน Vercel ก่อน',
    });
  }
  const given = str(req.headers['x-branch-key']) || str(req.query.key);
  if (!sameKey(given, expected)) {
    return res.status(401).json({ status: 'error', message: 'x-branch-key ไม่ถูกต้อง' });
  }

  // ฝั่งที่กินข้อมูลเป็นเซิร์ฟเวอร์ที่ถอยไปใช้ตารางของตัวเองได้อยู่แล้ว การตอบรายชื่อสำรอง
  // ปน ๆ ไปจึงไม่ได้ช่วยอะไร แต่แนบ source มาด้วยเสมอเพื่อให้ฝั่งนั้นตัดสินใจเองได้ว่าจะเชื่อไหม
  let data;
  let aliasList;
  let source = 'sql';
  try {
    [data, aliasList] = await Promise.all([
      readBranchRegistry(),
      readBranchAliases().catch(() => null),
    ]);
    if (!data?.length) throw new Error('ทะเบียนสาขาว่างเปล่า');
  } catch (err) {
    console.error('branch-feed: อ่านทะเบียนสาขาไม่ได้:', err.message);
    data = fallbackData();
    aliasList = null;
    source = 'fallback';
  }

  const aliases = aliasList
    ? Object.fromEntries(aliasList.map((a) => [a.alias, a.branchCode]))
    : { ...FALLBACK_ALIASES };

  // เป้ายอด/เพดานค่าแรงไม่ได้ส่งออกไปด้วย — เป็นของระบบตารางงานซึ่งอ่านจากฐานตรงอยู่แล้ว
  // และเป็นตัวเลขเชิงธุรกิจที่ไม่ควรออกไปไกลกว่าที่จำเป็น
  const payload = data.map((b) => ({
    code: b.code, name: b.name, outletId: b.outletId, status: b.status,
    sortOrder: b.sortOrder, region: b.region, openedAt: b.openedAt, closedAt: b.closedAt,
    posDbKey: b.posDbKey,
  }));

  if (source === 'sql') res.setHeader('Cache-Control', CACHE_OK);
  return res.status(200).json({
    status: 'success',
    source,
    version: versionOf({ payload, aliases }),
    updatedAt: new Date().toISOString(),
    count: payload.length,
    data: payload,
    aliases,
  });
}
