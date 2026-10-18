// ACC > ค้นหาสมาชิก — ส่งต่อไป host-server (ฐาน NaraiPos สาขาหลัก) ทางเดียวกับ /api/sales
//
//   GET /api/members                                   → ทุกเลขสมาชิก + จำนวนบิล/ยอดรวม/ครั้งแรก/ล่าสุด
//   GET /api/members?member=…                          → ทุกบิลของสมาชิกคนนั้น
//   GET /api/members?outlet=…&check=…&day=YYYY-MM-DD   → รายการในบิลเดียว
//
// ค้นทั้งฐาน ไม่มีช่วงวันที่ — ตัวที่ทำให้เร็วคือ index บน Cpaid.MemberTel (docs/member-lookup-index.sql)
export const config = { maxDuration: 60 };

import { explainHostError, explainUpstreamError } from '../../lib/directRoute';

const STORE_API_BASE = process.env.STORE_API_BASE || 'https://api.khanoykorshabu.com';

export default async function handler(req, res) {
  const { member, outlet, check, day } = req.query;
  let path;
  if (check != null) {
    path = `/bill-lines?outlet=${encodeURIComponent(outlet ?? '')}&check=${encodeURIComponent(check)}&day=${encodeURIComponent(day ?? '')}`;
  } else if (member != null) {
    path = `/member-bills?member=${encodeURIComponent(member)}`;
  } else {
    path = '/members';
  }

  try {
    const upstream = await fetch(`${STORE_API_BASE}${path}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(55000),
      headers: { 'ngrok-skip-browser-warning': 'true' },
    });
    // host-server รุ่นเก่ายังไม่มีเส้นนี้ — บอกวิธีแก้ ไม่ใช่ขึ้นแค่ 404
    if (upstream.status === 404) {
      return res.status(502).json({
        error: 'host-server ที่เครื่องออฟฟิศยังไม่มีเมนูค้นหาสมาชิก — ที่เครื่องนั้น git pull แล้ว host-server\\start-narai.ps1 -Restart -NoTunnel',
      });
    }
    if (!upstream.ok) throw await explainUpstreamError(upstream, { base: STORE_API_BASE });
    return res.status(200).json(await upstream.json());
  } catch (err) {
    const explained = err?.explained
      ? err
      : explainHostError(err, { base: STORE_API_BASE, timeoutMs: 55000 });
    console.error('Members API proxy error:', explained.message);
    return res.status(502).json({ error: explained.message });
  }
}
