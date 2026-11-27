// ต้นทุนใบเบิกสาขา (Total Food Cost) ของทุกสาขาในช่วงวันที่ — หน้า ACC › ต้นทุนใบเบิกสาขา
// และการ์ด "ยอดเบิกของ" ในสรุปรวมของแดชบอร์ด
//
//   GET /api/food-cost?start=YYYY-MM-DD&end=YYYY-MM-DD[&branch=รหัสสาขา]
//   -> { status, start, end, curMonth, preMonth, aliases, warnings:[...],
//        branches: [{ code, outletId, cats:{central,food,...}, withdraw, sup, supCount,
//                     prevStock, prevDate, prevSource, curStock, curDate, curSource, curUnpriced, foodCost }],
//        detail?: { code, previous:{items}, current:{items}, supCost:{items} } }   // เมื่อระบุ branch
//
// Total Food Cost = ต้นทุนจากใบเบิก + รายจ่ายจาก Supplier + ยอดยกมาเดือนที่แล้ว − ยอดมูลค่าสตอคปัจจุบัน
// (สูตร/กติกาเดียวกับหน้า "สรุปกำไร / ขาดทุน" ของแดชบอร์ดสาขา — Narai-branch ProfitSummary.jsx)
//
// มาจากสองฐาน:
//   ใบเบิก   — MySQL myfbdata.trans (เกณฑ์เดียวกับ /api/withdrawals: TRF/RCV ที่ Trn_To = outlet ของสาขา)
//   สต๊อก/Supplier — SQL Server InventoryNarai (lib/foodCostSql.mjs ผ่าน lib/sheetsSource.js)
// ฝั่ง SQL Server อ่านไม่ได้ ยังคืนยอดใบเบิกให้ พร้อม warning (ยอดสต๊อก/Supplier เป็น 0)
//
// รายการใบเบิกทีละใบของสาขาเดียว (กดดูประวัติ) ใช้ /api/withdrawals ตัวเดิม
import mysql from 'mysql2/promise';
import { outletBranchMap, branchAliasMap } from '../../lib/branchRegistry';
import { readFoodCostStock } from '../../lib/sheetsSource';
import { isIncludedBranch } from '../../lib/excludedBranches';
import { foodCostCatOf, emptyCatTotals, totalFoodCostOf } from '../../lib/foodCostCats';

export const config = { maxDuration: 60 };

let pool;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || 'inventory.dyndns.tv',
      port: Number(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'myfbdata',
      waitForConnections: true,
      connectionLimit: 3,
      connectTimeout: 15000,
    });
  }
  return pool;
}

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * ยอดใบเบิกรวมต่อ (outlet, สินค้า) ของทุกสาขาในช่วงวันที่
 *
 * ตาราง trans ใหญ่และไม่มี index ตามวันที่ — บีบช่วงเลขเอกสาร (Trn_DocNo) จากตัวนับกลางใน config
 * ให้ MySQL ใช้ PRIMARY KEY ได้ (วิธีเดียวกับ api/withdrawals.js ของ Narai-branch) อ่านตัวนับไม่ได้ = คิวรีเต็มตาราง
 * มูลค่าต่อแถวปัดสองตำแหน่งก่อนรวม เหมือนหน้าสาขาที่รวมจาก amount ของแต่ละบรรทัด
 */
async function readWithdrawTotals(start, end) {
  const db = getPool();
  let docNoFilter = '';
  let docNoParams = [];
  try {
    const [cfg] = await db.query('SELECT Cfg_LstIss AS iss, Cfg_LstRcv AS rcv FROM config LIMIT 1');
    const lastIss = Number(cfg[0]?.iss) || 0;
    const lastRcv = Number(cfg[0]?.rcv) || 0;
    const days = Math.max(1, Math.ceil((new Date(end) - new Date(start)) / 86400000) + 1)
      + Math.max(0, Math.ceil((Date.now() - new Date(end)) / 86400000));
    // ใบเบิกของ "ทุกสาขา" เดินเลขจากตัวนับเดียวกัน (~15 เลข/วัน) เผื่อไว้ ~1.7 เท่าแบบเดียวกับฝั่งสาขา
    const span = days * 25 + 300;
    if (lastIss > 0 && lastRcv > 0) {
      docNoFilter = `AND ((Trn_Type = 'TRF' AND Trn_DocNo BETWEEN ? AND ?)
                       OR (Trn_Type = 'RCV' AND Trn_DocNo BETWEEN ? AND ?))`;
      docNoParams = [lastIss - span, lastIss + 50, lastRcv - span, lastRcv + 50];
    }
  } catch { /* อ่านตัวนับไม่ได้ → คิวรีเต็มตาราง */ }

  const [rows] = await db.query(
    `SELECT Trn_To AS outletId, Trn_itemCode AS itemCode,
            SUM(ROUND(Trn_InvQty * Trn_UnitPr, 2)) AS amount
       FROM trans
      WHERE Trn_Type IN ('TRF','RCV')
        ${docNoFilter}
        AND Trn_DocDate BETWEEN ? AND ?
      GROUP BY Trn_To, Trn_itemCode`,
    [...docNoParams, start, end]
  );
  return rows;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ status: 'error', message: 'GET only' });
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  const branch = String(req.query.branch || '').trim().toLowerCase();
  if (!isYmd(start) || !isYmd(end)) {
    return res.status(400).json({ status: 'error', message: 'ระบุวันที่เริ่มต้น/สิ้นสุดไม่ถูกต้อง (YYYY-MM-DD)' });
  }
  if (start > end) return res.status(400).json({ status: 'error', message: 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' });

  try {
    const [codeOfOutlet, aliasTo] = await Promise.all([
      outletBranchMap(),
      branchAliasMap().catch(() => ({})),
    ]);
    const canon = (b) => {
      const k = String(b || '').trim().toLowerCase();
      return aliasTo[k] || k;
    };
    const want = branch ? canon(branch) : '';

    const warnings = [];
    const [wdRows, stock] = await Promise.all([
      readWithdrawTotals(start, end),
      readFoodCostStock({ start, end, branch: want, aliasTo }).catch((err) => {
        console.error('food-cost: อ่านสต๊อก/Supplier ไม่ได้:', err.message);
        warnings.push(`อ่านยอดสต๊อกและรายจ่าย Supplier ไม่ได้ (${err.message}) — ตัวเลขด้านล่างเป็นยอดใบเบิกอย่างเดียว`);
        return null;
      }),
    ]);

    const outletOf = {};
    for (const [oid, code] of Object.entries(codeOfOutlet)) outletOf[canon(code)] = oid;

    const rows = {};
    const rowOf = (code) => rows[code] || (rows[code] = {
      code, outletId: outletOf[code] || '', cats: emptyCatTotals(), withdraw: 0,
      sup: 0, supCount: 0, prevStock: 0, prevDate: '', prevSource: '', curStock: 0, curDate: '', curSource: '', curUnpriced: 0,
    });

    // ใบเบิก — Trn_To ที่ไม่ใช่สาขาในทะเบียน (ครัวกลาง/คลัง ฯลฯ) ข้าม
    const unknownOutlets = new Set();
    for (const r of wdRows) {
      const code = codeOfOutlet[String(r.outletId)];
      if (!code) { unknownOutlets.add(String(r.outletId)); continue; }
      const x = rowOf(canon(code));
      const amt = Number(r.amount) || 0;
      x.cats[foodCostCatOf(r.itemCode)] += amt;
      x.withdraw += amt;
    }

    for (const [code, s] of Object.entries(stock?.branches || {})) {
      const x = rowOf(code);
      x.sup = s.supCost.total; x.supCount = s.supCost.count;
      x.prevStock = s.previous.total; x.prevDate = s.previous.countDate; x.prevSource = s.previous.source;
      x.curStock = s.current.total; x.curDate = s.current.countDate; x.curSource = s.current.source;
      x.curUnpriced = s.current.unpriced || 0;
    }

    const branches = Object.values(rows)
      .filter((x) => x.code && isIncludedBranch(x.code))
      // สาขาที่มีแต่สต๊อกค้าง (ปิดไปแล้ว ไม่มีเบิก/รายจ่ายในช่วงนี้) ไม่ต้องขึ้น
      .filter((x) => x.withdraw || x.sup || x.curStock || (x.code === want))
      .map((x) => {
        Object.keys(x.cats).forEach((k) => { x.cats[k] = r2(x.cats[k]); });
        const withdraw = r2(x.withdraw);
        return { ...x, withdraw, foodCost: r2(totalFoodCostOf({ withdraw, sup: x.sup, prevStock: x.prevStock, curStock: x.curStock })) };
      })
      .sort((a, b) => b.foodCost - a.foodCost);

    const d = want && stock?.branches?.[want];
    return res.status(200).json({
      status: 'success',
      start, end,
      curMonth: stock?.curMonth || end.slice(0, 7),
      preMonth: stock?.preMonth || '',
      aliases: aliasTo,
      warnings,
      unknownOutlets: [...unknownOutlets],
      branches,
      ...(want ? {
        detail: {
          code: want,
          previous: { items: d?.previous?.items || [] },
          current: { items: d?.current?.items || [] },
          supCost: { items: d?.supCost?.items || [] },
        },
      } : {}),
    });
  } catch (err) {
    console.error('food-cost error:', err);
    return res.status(500).json({ status: 'error', message: err.message || 'ดึงข้อมูลไม่สำเร็จ' });
  }
}
