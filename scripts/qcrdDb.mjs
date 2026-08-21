// ตัวต่อฐานข้อมูล InventoryNarai สำหรับสคริปต์ฝั่ง QC/RD (migrate-qcrd.mjs, run-sql.mjs)
//
// env ที่ใช้ (ถ้าไม่ตั้ง จะไล่ใช้ค่าของ host-server ที่ตั้งไว้อยู่แล้ว)
//   QCRD_DB_SERVER (หรือ DB_SERVER) · QCRD_DB_NAME (หรือ STOCK_DB_NAME) · QCRD_DB_USER (หรือ DB_USER)
//   QCRD_DB_PASSWORD (หรือ DB_PASSWORD) · QCRD_DB_PORT (หรือ DB_PORT — ใช้เมื่อไม่ใช่ named instance)
import process from 'node:process';

export const DEFAULT_DB = process.env.QCRD_DB_NAME || process.env.STOCK_DB_NAME || 'InventoryNarai';
export const RAW_SERVER = process.env.QCRD_DB_SERVER || process.env.DB_SERVER || 'localhost\\SQLEXPRESS';

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
    user: process.env.QCRD_DB_USER || process.env.DB_USER || 'sa',
    password: process.env.QCRD_DB_PASSWORD || process.env.DB_PASSWORD || '',
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
      ...(instance ? { instanceName: instance } : {}),
    },
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 180000,
  };
  if (!instance) config.port = Number(process.env.QCRD_DB_PORT || process.env.DB_PORT) || 1433;
  try {
    const pool = await new mssql.ConnectionPool(config).connect();
    pool.__mssql = mssql;
    return pool;
  } catch (err) {
    throw new Error(
      `ต่อ SQL Server (${describeTarget(dbName)}) ไม่ได้: ${err.message}\n` +
      '  · named instance ต้องเปิด service "SQL Server Browser" บนเครื่องด้วย\n' +
      '  · ตรวจว่า QCRD_DB_USER / QCRD_DB_PASSWORD (หรือ DB_USER / DB_PASSWORD) ถูกต้อง'
    );
  }
}
