// ทะเบียนสาขา (dbo.hr_branch + hr_branch_alias + hr_branch_target) — ตรรกะฝั่ง SQL ที่ใช้ร่วมกันสองฝั่ง
//
// แนวเดียวกับ lib/sheetsSql.mjs และ lib/scanEditSql.mjs — ไฟล์นี้ไม่รู้จักวิธีต่อฐาน
// รับ "ตัวยิงคำสั่ง" (q) เข้ามาแล้วคืนชุดฟังก์ชันให้ จึงใช้ได้ทั้ง:
//   lib/sheetsSource.js      ฝั่ง Vercel ที่ต่อ SQL ตรง (pool ใน lib/qcrdPool.js)
//   host-server/sheets-db.js ฝั่งเครื่องออฟฟิศ ที่เปิดเป็น endpoint /sheets/branch* ให้เรียกผ่าน tunnel
//
// ทำไมต้องมีสองทาง: ที่ร้าน SQL ไม่ได้เปิดพอร์ตออกเน็ต Vercel จึงต่อตรงไม่ติด
// ถ้ามีแต่ทางต่อตรง หน้า "จัดการสาขา" จะอ่านไม่ได้/บันทึกไม่ได้เลย (อาการที่เจออยู่)
//
// ⭐ ตารางนี้เป็น "ทะเบียนแม่" ของทั้งสามระบบแล้ว (โปรเจคนี้ · ระบบตารางงาน · ระบบสโตร์)
//    แผนและเหตุผลอยู่ใน docs/branch-hub.md — โครงตารางอยู่ใน docs/schema-hr-branch.sql
import {
  normalizeCode, normalizeOutletId, normalizeDate, normalizeMoney, normalizeRegion,
  validateCode, validateAlias, validateAliasTarget,
  STATUS_ACTIVE, STATUS_INACTIVE, sortBranches,
} from './branchCore.mjs';

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const bad = (msg) => Object.assign(new Error(msg), { badRequest: true });

/**
 * @param db.q ยิง query: (text, params) => rows
 * คืน: readBranches / readAliases + actions (saveBranch / deleteBranch / saveAlias / deleteAlias / saveTarget)
 */
export function createBranches({ q }) {
  /* ------------------ ของใหม่มีในฐานแล้วหรือยัง ------------------
     โค้ดชุดนี้ deploy ได้ก่อนที่ใครจะไปรัน DDL ที่เครื่องออฟฟิศ (และตามลำดับงานจริง
     มันจะขึ้นก่อนเสมอ — Vercel deploy เองเมื่อ push ส่วน DDL ต้องมีคนเดินไปรัน)
     ถ้าถามหาคอลัมน์ที่ยังไม่มี SQL จะตอบ Invalid column name แล้วทั้งหน้า "จัดการสาขา"
     จะร่วงไปใช้รายชื่อสำรอง ทั้งที่ทะเบียนจริงอ่านได้อยู่ — ถามฐานก่อนว่ามีอะไรบ้าง
     แล้วค่อยประกอบคำสั่งให้พอดีกับที่มี

     แคช: ครบแล้วแคชยาว (คอลัมน์ไม่หายไปเอง) · ยังไม่ครบแคชสั้น จะได้เห็นผลทันทีหลังรัน DDL
     โดยไม่ต้องรีสตาร์ทเครื่องออฟฟิศหรือรอ Vercel เปลี่ยน instance                        */
  const READY_TTL_MS = 60 * 60 * 1000;
  const PENDING_TTL_MS = 30 * 1000;
  let capsCache = null;   // { at, ttl, value }

  async function caps() {
    if (capsCache && Date.now() - capsCache.at < capsCache.ttl) return capsCache.value;
    const rows = await q(
      `SELECT CASE WHEN COL_LENGTH('dbo.hr_branch', 'region')     IS NULL THEN 0 ELSE 1 END AS hasCols,
              CASE WHEN OBJECT_ID('dbo.hr_branch_alias',  'U')    IS NULL THEN 0 ELSE 1 END AS hasAlias,
              CASE WHEN OBJECT_ID('dbo.hr_branch_target', 'U')    IS NULL THEN 0 ELSE 1 END AS hasTarget`
    );
    const r = rows[0] || {};
    const value = {
      cols: Number(r.hasCols) === 1,
      alias: Number(r.hasAlias) === 1,
      target: Number(r.hasTarget) === 1,
    };
    const ready = value.cols && value.alias && value.target;
    capsCache = { at: Date.now(), ttl: ready ? READY_TTL_MS : PENDING_TTL_MS, value };
    return value;
  }

  /** ของใหม่ยังไม่มีในฐาน = บอกให้ไปรันสคีมา ไม่ใช่ปล่อยให้ SQL ตอบ Invalid object name ลอย ๆ */
  function needSchema(what) {
    return bad(`ยังไม่ได้สร้างตาราง${what}ในฐาน — รัน docs/schema-hr-branch.sql ที่เครื่องออฟฟิศก่อน ` +
      '(รันซ้ำได้ ไม่ทับข้อมูลเดิม)');
  }

  /** แถวในฐาน -> รูปแบบที่หน้าเว็บใช้ (ช่องเดิมต้องครบทุกช่อง โค้ดเก่าที่อ่านอยู่ห้ามพัง) */
  const rowToBranch = (r) => ({
    code: normalizeCode(r.branch_code),
    name: str(r.branch_name),
    outletId: normalizeOutletId(r.outlet_id),
    status: str(r.status) || STATUS_ACTIVE,
    note: str(r.note),
    sortOrder: Number(r.sort_order) || 0,
    // ช่องที่เพิ่มมาตอนยกเป็นทะเบียนแม่ — ฐานที่ยังไม่ได้รัน DDL จะไม่มีคีย์พวกนี้มา
    // คืนค่าว่างไว้เสมอ หน้าเว็บจะได้ไม่ต้องเช็ก undefined ทุกจุด
    region: normalizeRegion(r.region),
    openedAt: normalizeDate(r.opened_at instanceof Date ? r.opened_at.toISOString().slice(0, 10) : r.opened_at),
    closedAt: normalizeDate(r.closed_at instanceof Date ? r.closed_at.toISOString().slice(0, 10) : r.closed_at),
    posDbKey: str(r.pos_db_key),
    dailyTarget: normalizeMoney(r.daily_target),
    monthlyTarget: normalizeMoney(r.monthly_target),
    maxWage: normalizeMoney(r.max_wage),
  });

  async function readBranches() {
    const c = await caps();
    const extra = c.cols ? ', b.region, b.opened_at, b.closed_at, b.pos_db_key' : '';
    const targetCols = c.target
      ? ', t.daily_target, t.monthly_target, t.max_wage'
      : ', CAST(0 AS DECIMAL(14,2)) AS daily_target, CAST(0 AS DECIMAL(14,2)) AS monthly_target, CAST(0 AS DECIMAL(14,2)) AS max_wage';
    const join = c.target ? 'LEFT JOIN dbo.hr_branch_target t ON t.branch_code = b.branch_code' : '';

    const rows = await q(
      `SELECT b.branch_code, b.branch_name, b.outlet_id, b.status, b.note, b.sort_order${extra}${targetCols}
         FROM dbo.hr_branch b
         ${join}`
    );
    return sortBranches(rows.map(rowToBranch));
  }

  /**
   * รหัสพ้องทั้งหมด — [{ alias, branchCode, source, note }]
   *
   * ⚠️ ยังไม่มีตารางนี้ในฐาน คืน null (ไม่ใช่ลิสต์ว่าง) และไม่ใช่ error
   *    สองอย่างนี้ต้องแยกกันให้ออก เพราะ lib/branchRegistry.js ถอยไปใช้คู่ที่ฝังในโค้ด
   *    เมื่อ "อ่านไม่ได้" — ถ้าตารางว่างเปล่าแล้วคืนลิสต์ว่างเหมือนกัน การลบรหัสพ้อง
   *    ตัวสุดท้ายออกจะไม่มีผลจริง เพราะของสำรองจะโผล่กลับมาแทนที่ทันที
   */
  async function readAliases() {
    const c = await caps();
    if (!c.alias) return null;
    const rows = await q(
      'SELECT alias, branch_code, source, note FROM dbo.hr_branch_alias ORDER BY alias');
    return rows.map((r) => ({
      alias: normalizeCode(r.alias),
      branchCode: normalizeCode(r.branch_code),
      source: str(r.source),
      note: str(r.note),
    }));
  }

  /**
   * เพิ่มหรือแก้สาขาหนึ่งตัว — รหัสสาขาเป็นคีย์ แก้รหัสไม่ได้
   * (รหัสนี้ถูกอ้างในตารางงาน ข้อมูลสแกนหน้า ค่าใช้จ่าย คอลัมน์ "สาขาที่ใช้" ของวัตถุดิบ
   *  และตั้งแต่ยกเป็นทะเบียนแม่ก็ถูกอ้างจากอีกสองโปรเจคด้วย
   *  เปลี่ยนที่ทะเบียนที่เดียวจะทำให้ข้อมูลเก่ากำพร้าทันที — จะเปลี่ยนจริงให้เพิ่มตัวใหม่แล้วปิดตัวเก่า)
   */
  async function saveBranch(body) {
    const code = normalizeCode(body?.code);
    const err = validateCode(code);
    if (err) throw bad(err);

    const outletId = normalizeOutletId(body?.outletId);
    if (str(body?.outletId) && outletId === null) {
      throw bad('รหัสร้าน POS ต้องเป็นจำนวนเต็มบวก (เว้นว่างได้ถ้ายังไม่ได้เลขมา)');
    }
    const status = str(body?.status) === STATUS_INACTIVE ? STATUS_INACTIVE : STATUS_ACTIVE;

    // วันที่กรอกมาแต่แปลไม่ออก = บอกให้แก้ ไม่ใช่เขียน NULL ลงไปเงียบ ๆ แล้วคนกรอกนึกว่าบันทึกแล้ว
    for (const [key, label] of [['openedAt', 'วันเปิดสาขา'], ['closedAt', 'วันปิดสาขา']]) {
      if (str(body?.[key]) && normalizeDate(body[key]) === null) {
        throw bad(`${label}ต้องเป็นรูปแบบ ปี-เดือน-วัน เช่น 2026-09-18`);
      }
    }
    const openedAt = normalizeDate(body?.openedAt);
    const closedAt = normalizeDate(body?.closedAt);
    if (openedAt && closedAt && closedAt < openedAt) {
      throw bad('วันปิดสาขาต้องไม่มาก่อนวันเปิดสาขา');
    }

    const c = await caps();
    const params = {
      code,
      name: str(body?.name),
      outletId,
      status,
      note: str(body?.note),
      sortOrder: Number(body?.sortOrder) || 0,
    };
    /* ⚠️ ช่องใหม่แก้เฉพาะตัวที่ส่งมาจริง — กติกาเดียวกับ lib/sheetsSql.mjs
       ถ้า UPDATE ทุกช่องทุกครั้ง ตัวเรียกเก่าที่ยังไม่รู้จักช่องพวกนี้จะล้างของทิ้งเงียบ ๆ
       ซึ่งมีอยู่จริงหลายจุด: ปุ่ม "ปิดการใช้งานแทน" และ "เติมชื่อไทยจากตารางงาน" ใน
       components/BranchList.jsx ส่งมาแค่ code/name/outletId/status/note/sortOrder
       กดปุ่มเดียวแล้วโซนกับวันเปิดสาขาหายทั้งแถวโดยไม่มีอะไรบอก
       (ส่งมาเป็นค่าว่างถือว่า "ตั้งใจล้าง" ต่างจากไม่ส่งคีย์มาเลย)                    */
    let setExtra = '';
    let insCols = '';
    let insVals = '';
    if (c.cols) {
      const optional = [
        ['region', 'region', () => normalizeRegion(body?.region)],
        ['openedAt', 'opened_at', () => openedAt],
        ['closedAt', 'closed_at', () => closedAt],
        ['posDbKey', 'pos_db_key', () => str(body?.posDbKey)],
      ];
      for (const [key, column, valueOf] of optional) {
        insCols += `, ${column}`;
        if (body && key in body) {
          params[key] = valueOf();
          setExtra += `, ${column} = @${key}`;
          insVals += `, @${key}`;
        } else {
          // ไม่ได้ส่งมา: แถวเดิมไม่แตะ ส่วนแถวใหม่ใส่ค่าว่างตามดีฟอลต์ของคอลัมน์
          insVals += column === 'region' ? ", N''" : ', NULL';
        }
      }
    }

    await q(
      `MERGE dbo.hr_branch AS t
       USING (SELECT @code AS branch_code) AS s
          ON t.branch_code = s.branch_code
       WHEN MATCHED THEN UPDATE SET
          branch_name = @name, outlet_id = @outletId, status = @status,
          note = @note, sort_order = @sortOrder, updated_at = SYSDATETIME()${setExtra}
       WHEN NOT MATCHED THEN
          INSERT (branch_code, branch_name, outlet_id, status, note, sort_order${insCols})
          VALUES (@code, @name, @outletId, @status, @note, @sortOrder${insVals});`,
      params
    );
    return { code };
  }

  async function deleteBranch(body) {
    const code = normalizeCode(body?.code);
    if (!code) throw bad('ต้องระบุรหัสสาขาที่จะลบ');

    // รหัสพ้องที่ชี้มาที่สาขานี้ต้องไม่มีค้างอยู่ — FK จะเตะให้เองแต่ข้อความที่ได้อ่านไม่รู้เรื่อง
    // ("conflicted with the REFERENCE constraint FK_hr_branch_alias_branch") บอกไปตรง ๆ ดีกว่า
    const c = await caps();
    if (c.alias) {
      const used = await q(
        'SELECT alias FROM dbo.hr_branch_alias WHERE branch_code = @code', { code });
      if (used.length) {
        throw bad(`ลบสาขา ${code} ไม่ได้ — ยังมีรหัสพ้องชี้มาที่สาขานี้อยู่ ` +
          `(${used.map((r) => r.alias).join(', ')}) ลบรหัสพ้องพวกนั้นก่อน`);
      }
    }
    if (c.target) await q('DELETE FROM dbo.hr_branch_target WHERE branch_code = @code', { code });

    const rows = await q(
      'DELETE FROM dbo.hr_branch OUTPUT deleted.branch_code AS code WHERE branch_code = @code',
      { code }
    );
    if (!rows.length) throw bad(`ไม่พบสาขา ${code} ในทะเบียน`);
    return { code };
  }

  /** เพิ่ม/แก้รหัสพ้อง — alias เป็นคีย์ */
  async function saveAlias(body) {
    const c = await caps();
    if (!c.alias) throw needSchema('รหัสพ้อง (dbo.hr_branch_alias)');

    const alias = normalizeCode(body?.alias);
    const err = validateAlias(alias);
    if (err) throw bad(err);

    const branchCode = normalizeCode(body?.branchCode ?? body?.code);
    const all = await q('SELECT branch_code FROM dbo.hr_branch');
    const clash = validateAliasTarget(alias, all.map((r) => r.branch_code), branchCode);
    if (clash) throw bad(clash);

    await q(
      `MERGE dbo.hr_branch_alias AS t
       USING (SELECT @alias AS alias) AS s
          ON t.alias = s.alias
       WHEN MATCHED THEN UPDATE SET
          branch_code = @branchCode, source = @source, note = @note, updated_at = SYSDATETIME()
       WHEN NOT MATCHED THEN
          INSERT (alias, branch_code, source, note)
          VALUES (@alias, @branchCode, @source, @note);`,
      { alias, branchCode, source: str(body?.source), note: str(body?.note) }
    );
    return { alias, branchCode };
  }

  async function deleteAlias(body) {
    const c = await caps();
    if (!c.alias) throw needSchema('รหัสพ้อง (dbo.hr_branch_alias)');

    const alias = normalizeCode(body?.alias);
    if (!alias) throw bad('ต้องระบุรหัสพ้องที่จะลบ');
    const rows = await q(
      'DELETE FROM dbo.hr_branch_alias OUTPUT deleted.alias AS alias WHERE alias = @alias',
      { alias }
    );
    if (!rows.length) throw bad(`ไม่พบรหัสพ้อง ${alias}`);
    return { alias };
  }

  /**
   * เป้ายอด/เพดานค่าแรงของสาขา — ระบบตารางงาน (Narai-branch) อ่านค่าชุดนี้ไปโชว์บนการ์ด
   * ก่อนหน้านี้อยู่ที่ narai_hr.dbo.hr_branch ซึ่งไม่มีหน้าจอให้แก้ ต้องเปิด SSMS เอง
   */
  async function saveTarget(body) {
    const c = await caps();
    if (!c.target) throw needSchema('เป้ายอดขาย (dbo.hr_branch_target)');

    const code = normalizeCode(body?.code ?? body?.branchCode);
    if (!code) throw bad('ต้องระบุรหัสสาขา');
    const exists = await q(
      'SELECT branch_code FROM dbo.hr_branch WHERE branch_code = @code', { code });
    if (!exists.length) throw bad(`ไม่พบสาขา ${code} ในทะเบียน`);

    await q(
      `MERGE dbo.hr_branch_target AS t
       USING (SELECT @code AS branch_code) AS s
          ON t.branch_code = s.branch_code
       WHEN MATCHED THEN UPDATE SET
          daily_target = @daily, monthly_target = @monthly, max_wage = @wage, updated_at = SYSDATETIME()
       WHEN NOT MATCHED THEN
          INSERT (branch_code, daily_target, monthly_target, max_wage)
          VALUES (@code, @daily, @monthly, @wage);`,
      {
        code,
        daily: normalizeMoney(body?.dailyTarget),
        monthly: normalizeMoney(body?.monthlyTarget),
        wage: normalizeMoney(body?.maxWage),
      }
    );
    return { code };
  }

  return {
    readBranches,
    readAliases,
    actions: { saveBranch, deleteBranch, saveAlias, deleteAlias, saveTarget },
  };
}
