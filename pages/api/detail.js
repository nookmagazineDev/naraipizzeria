export default async function handler(req, res) {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });
  try {
    const url = `http://storenarai.dyndns.tv:14365/express/ctranbetweendate?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const upstream = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(60000),
    });
    if (!upstream.ok) throw new Error(`Upstream HTTP ${upstream.status}`);
    const data = await upstream.json();
    res.status(200).json(data);
  } catch (err) {
    console.error('Detail API proxy error:', err.message);
    res.status(502).json({ error: err.message });
  }
}
