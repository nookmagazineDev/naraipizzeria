export const config = {
  runtime: 'edge',
};

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
    const url = `http://storenarai.dyndns.tv:14365/express/ctranbetweendate?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const upstream = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(25000),
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
