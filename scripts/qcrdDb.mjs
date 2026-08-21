// ตัวต่อฐานข้อมูล InventoryNarai สำหรับสคริปต์ฝั่ง QC/RD (migrate-qcrd.mjs, run-sql.mjs)
//
// ต่อได้สองแบบ — เลือกเองตามว่ารันสคริปต์จากเครื่องไหน
//
//   ก) รันที่เครื่องออฟฟิศ (ค่าเริ่มต้น) — ต่อ localhost\SQLEXPRESS ไม่ต้องออกเน็ต
//   ข) รันจากเครื่องอื่น — ตั้ง QCRD_DB_HOST=inventory.dyndns.tv (อินสแตนซ์นี้ตรึง TCP 1433
//      และเปิดออกเน็ตอยู่แล้ว ตารางงาน/หน้าสแกนหน้าบน Vercel ก็ต่อทางนี้)
//      ใช้ login ชุดเดียวกับ HR_DB_USER/HR_DB_PASSWORD ได้เลย ขอแค่ให้สิทธิ์ใน InventoryNarai ด้วย
//
// env ที่ใช้ (ไล่จากซ้ายไปขวา ตัวไหนตั้งไว้ก่อนใช้ตัวนั้น)
//   เครื่อง:    QCRD_DB_SERVER (มี \instance ได้) · QCRD_DB_HOST · HR_DB_HOST · DB_SERVER
//   พอร์ต:     QCRD_DB_PORT · HR_DB_PORT · DB_PORT (ค่าเริ่มต้น 1433 — ใช้เมื่อไม่ใช่ named instance)
//   ฐานข้อมูล:  QCRD_DB_NAME · STOCK_DB_NAME (ค่าเริ่มต้น InventoryNarai)
//   ผู้ใช้:     QCRD_DB_USER / QCRD_DB_PASSWORD · HR_DB_USER / HR_DB_PASSWORD · DB_USER / DB_PASSWORD
import process from 'node:process';

export const DEFAULT_DB = process.env.QCRD_DB_NAME || process.env.STOCK_DB_NAME || 'InventoryNarai';
export const RAW_SERVER =
  process.env.QCRD_DB_SERVER ||
  process.env.QCRD_DB_HOST ||
  process.env.HR_DB_HOST ||
  process.env.DB_SERVER ||
  'localhost\\SQLEXPRESS';

export function describeTarget(dbName = DEFAULT_DB) {
  return `${RAW_SERVER}/${dbName}`;
}

/** โหลด driver แบบ lazy — โหมดที่ไม่แตะฐานข้อมูลจะได้ไม่ต้อง npm install ก่อน */
export async function loadMssql() {
  try {
    return (await import('mssql')).default;
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        "ยังไม่ได้ลง package 'mssql' — รัน npm install ที่โฟลเดอร์รีโปก่อน\n" +
        '  (โหมด --inspect กับ --dry-run ของ migrate-qcrd.mjs ใช้ได้เลยโดยไม่ต้องลง)'
      );
    }
    throw err;
  }
}

export async function openPool(dbName = DEFAULT_DB) {
  const mssql = await loadMssql();
  const [host, instance] = RAW_SERVER.split('\\');
  const config = {
    server: host,
    database: dbName,
    user: process.env.QCRD_DB_USER || process.env.HR_DB_USER || process.env.DB_USER || 'sa',
    password: process.env.QCRD_DB_PASSWORD || process.env.HR_DB_PASSWORD || process.env.DB_PASSWORD || '',
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
      ...(instance ? { instanceName: instance } : {}),
    },
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 180000,
  };
  if (!instance) {
    config.port = Number(process.env.QCRD_DB_PORT || process.env.HR_DB_PORT || process.env.DB_PORT) || 1433;
  }
  try {
    const pool = await new mssql.ConnectionPool(config).connect();
    pool.__mssql = mssql;
    return pool;
  } catch (err) {
    throw new Error(
      `ต่อ SQL Server (${describeTarget(dbName)}) ไม่ได้: ${err.message}\n` +
      '  · named instance ต้องเปิด service "SQL Server Browser" บนเครื่องด้วย\n' +
      '  · รันจากนอกออฟฟิศให้ตั้ง QCRD_DB_HOST=inventory.dyndns.tv (ต่อพอร์ต 1433 ตรง)\n' +
      '  · ตรวจว่า user/password ถูกต้อง และ login นั้นมีสิทธิ์ในฐาน InventoryNarai ด้วย'
    );
  }
}
