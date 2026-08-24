import { STORE_API_BASE } from './upstream.mjs';

// ไล่ทดสอบว่าต่อ TCP ถึงปลายทางไหนได้บ้าง — ไว้หาว่า SQL Server เปิดพอร์ตอะไรออกเน็ตจริง
//
// ใช้ร่วมกันสองที่ ให้รายชื่อปลายทางกับวิธีแปลผลเป็นชุดเดียว:
//   pages/api/qcrd-migrate.js   ?step=probe
//   pages/api/sheets-migrate.js ?step=probe
//
// มีไว้เพราะเวลาต่อไม่ติด error ที่ SQL Server ตอบมาคือ "timeout" เฉย ๆ ซึ่งแยกไม่ออกว่า
// พอร์ตปิด / firewall กัน / เครื่องดับ — probe ตอบได้ว่าปลายทางไหน "ต่อ TCP ติด" บ้าง
import net from 'node:net';

/** โฮสต์/พอร์ตที่ลองให้เสมอ — env ที่ตั้งไว้มาก่อน แล้วตามด้วยค่าที่ใช้กันบ่อย */
const DEFAULT_HOSTS = () => [...new Set([
  process.env.QCRD_DB_HOST, process.env.ZK_DB_HOST, process.env.HR_DB_HOST,
  '203.154.185.48', 'inventory.dyndns.tv', 'storenarai.dyndns.tv',
].filter(Boolean))];

const DEFAULT_PORTS = () => [...new Set([
  Number(process.env.QCRD_DB_PORT) || 0, Number(process.env.ZK_DB_PORT) || 0, Number(process.env.HR_DB_PORT) || 0,
  1433, 14322, 14333, 1435,
].filter(Boolean))];

/** @param extra ปลายทางเพิ่มเติมที่อยากลองด้วย — [{ host, port }] */
export async function probeEndpoints(extra = []) {
  const hosts = DEFAULT_HOSTS();
  const ports = DEFAULT_PORTS();
  const targets = [];
  hosts.forEach((h) => ports.forEach((p) => targets.push({ host: h, port: p })));
  extra.forEach((t) => targets.push(t));

  const tryOne = ({ host, port }) => new Promise((done) => {
    const t0 = Date.now();
    const sock = net.createConnection({ host, port, timeout: 4000 });
    const finish = (open, detail) => {
      sock.destroy();
      done({ target: `${host}:${port}`, open, ms: Date.now() - t0, detail });
    };
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false, 'timeout (พอร์ตไม่เปิด หรือ firewall กันไว้)'));
    sock.on('error', (e) => finish(false, e.code || e.message));
  });

  const results = await Promise.all(targets.map(tryOne));
  const open = results.filter((r) => r.open);

  // เช็กทางที่ 2 ไปด้วยเลย: host-server ที่เครื่องออฟฟิศ (ผ่าน tunnel) พร้อมใช้หรือยัง
  const apiBase = (process.env.QCRD_API_BASE || STORE_API_BASE).replace(/\/+$/, '');
  const hitApi = async (path) => {
    try {
      const r = await fetch(`${apiBase}${path}`, {
        signal: AbortSignal.timeout(8000),
        headers: { 'ngrok-skip-browser-warning': 'true' },
      });
      const text = (await r.text()).slice(0, 200);
      return `HTTP ${r.status} — ${text.replace(/\s+/g, ' ')}`;
    } catch (e) {
      return `ต่อไม่ได้: ${e.message}`;
    }
  };
  const [ping, qcrdPing] = await Promise.all([hitApi('/ping'), hitApi('/qcrd/ping')]);

  return {
    step: 'probe',
    openPorts: open.map((r) => `${r.target} (${r.ms}ms)`),
    tried: results.map((r) => `${r.open ? '✅' : '❌'} ${r.target} — ${r.open ? `ต่อได้ ${r.ms}ms` : r.detail}`),
    hostApi: { base: apiBase, ping, qcrdPing },
    hint: open.length
      ? `เจอปลายทางที่ต่อได้ — ตั้ง QCRD_DB_HOST/QCRD_DB_PORT บน Vercel ให้ตรงกับ ${open[0].target} แล้ว Redeploy` +
        ' (ถ้าต่อได้แต่ยัง query ไม่ผ่าน แปลว่าพอร์ตนั้นไม่ใช่ SQL Server)'
      : 'ต่อ SQL ตรงไม่ได้สักพอร์ต — ดูช่อง hostApi: ถ้า /ping ตอบ HTTP 200 แปลว่าเครื่องออฟฟิศออนไลน์อยู่ '
        + 'ให้ไปอัปเดตโค้ด host-server แล้วใช้ทางที่ 2 (ดู docs/qcrd-sql-migration.md) '
        + 'ส่วนการย้ายข้อมูลรันที่เครื่องออฟฟิศด้วย scripts/migrate-qcrd.ps1 ได้เลย',
  };
}

/**
 * แปลง ?host=…&port=… ของ request เป็นรายการปลายทางเพิ่มเติมให้ probeEndpoints
 *
 * มีไว้เพราะรายการพอร์ตที่เดาไว้ในโค้ด (1433/14322/14333/1435) เป็นแค่ค่าที่ใช้กันบ่อย
 * ถ้า router ที่ออฟฟิศ forward พอร์ตอื่น จะไม่มีทางรู้เลยถ้าระบุเองไม่ได้
 *   &port=1450            ลองพอร์ตนี้กับทุกโฮสต์ที่ probe ลองอยู่แล้ว
 *   &host=1.2.3.4         ลองโฮสต์นี้กับทุกพอร์ตมาตรฐาน
 *   &host=1.2.3.4&port=1450,1451   ระบุทั้งคู่ (พอร์ตใส่หลายตัวคั่นด้วย ,)
 */
export function extraTargets({ host, port } = {}) {
  const hosts = String(host || '').split(',').map((h) => h.trim()).filter(Boolean);
  const ports = String(port || '').split(',').map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  if (!hosts.length && !ports.length) return [];

  const useHosts = hosts.length ? hosts : DEFAULT_HOSTS();
  const usePorts = ports.length ? ports : DEFAULT_PORTS();
  const out = [];
  useHosts.forEach((h) => usePorts.forEach((p) => out.push({ host: h, port: p })));
  return out;
}
