export const config = {
  runtime: 'edge',
};

// ปลายทาง API บนโฮสต์ (SQL Server ผ่าน ngrok) — ตั้งทับด้วย env STORE_API_BASE ได้
const STORE_API_BASE =
  process.env.STORE_API_BASE || 'https://disparate-hurray-detective.ngrok-free.dev';

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const start = searchParams.get('start');
  const end = searchParams.get('end');

  if (!start || !end) {
    return new Response(JSON.stringify({ error: 'start and end required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  try {
    const url = `${STORE_API_BASE}/ctranbetweendate?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const upstream = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(25000),
      headers: { 'ngrok-skip-browser-warning': 'true' }, // ข้ามหน้าเตือนของ ngrok free
    });

    if (!upstream.ok) throw new Error(`Upstream HTTP ${upstream.status}`);
    const data = await upstream.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    console.error('Detail API proxy error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}
