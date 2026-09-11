// ตรรกะฝั่ง SQL ของ "หน้านับสต๊อกและขอเบิก" กับ "ดูยอดรวมทุกสาขา"
// (ฐาน InventoryNarai — ตาราง dbo.stock_item / stock_count / stock_balance / stock_request)
//
// ทำไมต้องมี: หน้าสาขา (โปรเจกต์ Narai-branch — narai-branch.vercel.app/stock/list) ย้ายทั้ง
// "อ่านและเขียน" ของเมนูสต๊อกไปอยู่บน SQL Server หมดแล้ว ชีท 'ข้อมูลนับสตอค' ที่ฝั่งนี้อ่าน
// ผ่าน Apps Script จึงหยุดรับยอดนับตั้งแต่วันที่สาขาสลับไปใช้ระบบใหม่ — หน้าออฟฟิศเลยค้าง
// อยู่ที่ข้อมูลเดือนสิงหาทั้งที่สาขานับทุกวัน
//
// query กับรูปแบบคำตอบพอร์ตมาจาก office-server/stock.js ของ Narai-branch ตรง ๆ
// (ซึ่งพอร์ตมาจาก Apps Script เดิมอีกที) ชื่อฟิลด์จึงเหมือนที่หน้าเว็บฝั่งนี้ใช้อยู่แล้วทุกตัว
//
// ไฟล์นี้ไม่รู้ว่า "ต่อฐานยังไง" — รับตัวยิง query (q) เข้ามา แนวเดียวกับ lib/sheetsSql.mjs
//   lib/sheetsSource.js      ฝั่ง Vercel ที่ต่อ SQL ตรง (pool ใน lib/qcrdPool.js)
//   host-server/sheets-db.js ฝั่งเครื่องออฟฟิศ ที่เปิดเป็น /sheets/stock-* ให้เรียกผ่าน tunnel

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * รหัสสาขาในทะเบียนสินค้าเขียนว่า SJP แต่ผู้ใช้ล็อกอินด้วย zjp
 * ใช้เฉพาะตอนหาว่าสินค้าตัวไหนเป็นของสาขานี้ — ข้อมูลนับ/ยอดยกมา/ใบเบิกเก็บด้วยรหัสที่ส่งมา
 * ห้ามแปลง ไม่งั้นจะหาข้อมูลของสาขานั้นไม่เจอเลย (กติกาเดียวกับฝั่งสาขา)
 */
const ITEM_BRANCH_ALIAS = { zjp: 'sjp', zip: 'sjp' };
const itemBranchOf = (branch) => {
  const b = str(branch).toLowerCase();
  return ITEM_BRANCH_ALIAS[b] || b;
};

/**
 * ค่าตั้งเบิกของสาขา (dbo.stock_avg_per_head) เคยถูกบันทึกไว้ทั้งชื่อ zjp และ sjp
 * อ่านทั้งสองชื่อเสมอ ไม่งั้นสาขานั้นจะเห็นค่าตั้งเบิกว่างทั้งที่ตั้งไว้แล้ว
 * (กติกาเดียวกับ branchAliases ใน office-server/stock.js ของ Narai-branch)
 */
const avgBranchAliases = (branch) => {
  const b = str(branch).toLowerCase();
  return (b === 'zjp' || b === 'sjp') ? ['zjp', 'sjp'] : [b, b];
};

/** โหมดคิดยอดเบิก — ค่าอื่นถือว่าไม่ได้ระบุ แล้วตกเป็น 'avg' ตามค่าตั้งต้นของตาราง */
const calcModeOf = (v) => (str(v).toLowerCase() === 'par' ? 'par' : 'avg');

/**
 * '2026-08-20 14:05' (จาก CONVERT แบบ 120) -> '20/08/2026 14:05'
 * แปลงเป็นข้อความตั้งแต่ใน SQL แล้วค่อยจัดรูปที่นี่ ไม่แปลงผ่าน Date ของ JS
 * เพราะ driver คืน DATETIME2 มาเป็น Date ที่ตีความเป็น UTC เวลาที่โชว์จะเลื่อนไป 7 ชั่วโมง
 */
const thaiDateTime = (v) => {
  const s = str(v);
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
};

export function createStockCount({ q }) {
  /** รายการสินค้าของสาขา + ประวัติการนับ + ยอดยกมา + ใบเบิกล่าสุด (= action getStockItems เดิม) */
  async function readStockItems(branch) {
    const branchKey = str(branch).toLowerCase();
    if (!branchKey) return [];
    const itemBranch = itemBranchOf(branchKey);

    const [avgAlias0, avgAlias1] = avgBranchAliases(branchKey);
    const [items, counts, balances, requests, categories, calcSettings] = await Promise.all([
      q(`SELECT i.item_key, i.item_code, i.pos_item_id, i.item_name, i.unit, i.price,
                i.status, i.store_cat, i.plan_only
           FROM dbo.stock_item i
           JOIN dbo.stock_item_branch b ON b.item_key = i.item_key
          WHERE b.branch = @itemBranch
            AND ISNULL(i.status, N'') <> N'ปิดการใช้งาน'
          ORDER BY i.sort_order, i.item_code`, { itemBranch }),
      // ประวัติการนับทั้งหมดของสาขานี้ เรียงเก่า -> ใหม่ (หน้าเว็บใช้ทั้งชุด ไม่ใช่แค่ค่าล่าสุด)
      q(`SELECT item_key, remaining, counter_name,
                CONVERT(NVARCHAR(19), counted_at, 120) AS counted_text
           FROM dbo.stock_count
          WHERE branch = @branch
          ORDER BY item_key, counted_at, count_id`, { branch: branchKey }),
      q(`SELECT item_key, balance, CONVERT(NVARCHAR(19), updated_at, 120) AS updated_text
           FROM dbo.stock_balance
          WHERE branch = @branch`, { branch: branchKey }),
      // ใบเบิกครั้งล่าสุดต่อสินค้า — ตัดสินด้วย request_id (แถวที่ต่อท้ายทีหลังคือแถวใหม่สุด)
      // เวลาบันทึกของบางแถวที่ย้ายมาจากชีทว่าง ถ้าเรียงด้วยเวลาอย่างเดียวแถวพวกนั้นจะจมหาย
      q(`SELECT r.item_key, r.qty, r.requester,
                CONVERT(NVARCHAR(19), r.saved_at, 120) AS saved_text
           FROM dbo.stock_request r
           JOIN (SELECT item_key, MAX(request_id) AS request_id
                   FROM dbo.stock_request
                  WHERE branch = @branch
                  GROUP BY item_key) last_one
             ON last_one.request_id = r.request_id`, { branch: branchKey }),
      q(`SELECT item_key, category FROM dbo.stock_storage_category WHERE branch = @branch`,
        { branch: branchKey }),
      // ค่าตั้งเบิกที่สาขาตั้งไว้ในหน้านับสต๊อกของ Narai-branch — หน้านี้เอามาแสดงอย่างเดียว ไม่ได้แก้
      //   calc_mode = 'avg' -> avg_qty คือค่าเฉลี่ยยอดใช้ต่อหัวลูกค้า 1 คน
      //   calc_mode = 'par' -> par_qty คือค่าเติมเต็มสตอค (ของที่ยอดใช้ไม่ผูกกับจำนวนลูกค้า)
      // ตารางนี้เป็นของอีกโปรเจกต์ เครื่องที่ยังไม่ได้รันสคีมาใหม่จะไม่มี — ปล่อยให้คอลัมน์ว่าง
      // ดีกว่าทำให้ทั้งหน้านับสต๊อกอ่านไม่ได้
      q(`SELECT item_key, avg_qty, par_qty, calc_mode FROM dbo.stock_avg_per_head
          WHERE branch IN (@avgAlias0, @avgAlias1)`, { avgAlias0, avgAlias1 }).catch(() => []),
    ]);

    const historyByItem = new Map();
    counts.forEach(c => {
      const list = historyByItem.get(c.item_key) || [];
      list.push({ remaining: Number(c.remaining), date: thaiDateTime(c.counted_text), counter: str(c.counter_name) });
      historyByItem.set(c.item_key, list);
    });
    const balanceByItem = new Map(balances.map(b => [b.item_key, b]));
    const requestByItem = new Map(requests.map(r => [r.item_key, r]));
    const categoryByItem = new Map(categories.map(c => [c.item_key, str(c.category)]));
    const calcByItem = new Map(calcSettings.map(c => [c.item_key, c]));

    return items.map(it => {
      const history = historyByItem.get(it.item_key) || [];
      const last = history.length ? history[history.length - 1] : null;
      const prevCount = history.length > 1 ? history[history.length - 2] : null;
      const bal = balanceByItem.get(it.item_key) || null;
      const req = requestByItem.get(it.item_key) || null;
      const calc = calcByItem.get(it.item_key) || null;
      // avg_qty เป็น NOT NULL ของที่ตั้งแต่โหมด par ไว้จึงเป็น 0 — ถือว่า "ยังไม่ได้ตั้ง" ไม่ใช่ศูนย์จริง
      const avgQty = calc ? Number(calc.avg_qty) : 0;
      const parQty = calc && calc.par_qty !== null && calc.par_qty !== undefined
        ? Number(calc.par_qty) : null;

      // ยอดยกมา = ยอดนับ "ครั้งก่อนหน้า" ถ้ามี ไม่มีค่อยใช้ยอดยกมาที่บันทึกไว้
      // (ลำดับเดียวกับฝั่งสาขา สลับกันแล้วตัวเลขในหน้าจะเปลี่ยนทันที)
      const previous = prevCount
        || (bal ? { remaining: Number(bal.balance), date: thaiDateTime(bal.updated_text) } : null);

      return {
        productId: it.item_code,
        itemId: str(it.pos_item_id),
        name: it.item_name || '',
        unit: str(it.unit),
        price: it.price === null || it.price === undefined ? '' : Number(it.price),
        status: str(it.status),
        storeCat: str(it.store_cat),
        planOnly: Boolean(it.plan_only),
        storageCat: categoryByItem.get(it.item_key) ?? '',
        rdCat: '',   // ทะเบียนสินค้าไม่มีคอลัมน์นี้ — Apps Script ก็คืนค่าว่างมาตลอด
        previousBalance: previous ? previous.remaining : '',
        previousBalanceDate: previous ? previous.date : '',
        lastStock: last ? last.remaining : '',
        lastStockDate: last ? last.date : '',
        lastStockCounter: last ? last.counter : '',
        stockHistory: history,
        lastRequest: req ? Number(req.qty) : '',
        lastRequestDate: req ? thaiDateTime(req.saved_text) : '',
        lastRequester: req ? str(req.requester) : '',
        // ค่าตั้งเบิก — '' = ยังไม่ได้ตั้ง (หน้าเว็บขึ้น '-')
        calcMode: calcModeOf(calc?.calc_mode),
        avgPerHead: avgQty > 0 ? avgQty : '',
        parQty: parQty === null ? '' : parQty,
      };
    });
  }

  /**
   * ยอดคงเหลือรวมทุกสาขา (= action getStockTotal เดิม)
   * สาขาไหนเคยนับใช้ยอดนับล่าสุด สาขาที่ยังไม่เคยนับใช้ยอดยกมาแทน (ไม่บวกซ้ำกัน)
   * endDate = ดูย้อนหลังว่า ณ วันนั้นเหลือเท่าไหร่ (ไม่ส่ง = ล่าสุด)
   */
  async function readStockTotal(endDate) {
    // เทียบถึงสิ้นวันของวันที่เลือก ไม่ใช่เที่ยงคืนต้นวัน ไม่งั้นการนับของวันนั้นเองจะหลุดไปทั้งวัน
    const endText = /^\d{4}-\d{2}-\d{2}$/.test(str(endDate)) ? `${str(endDate)} 23:59:59` : null;

    const [items, counts, balances, categories] = await Promise.all([
      q(`SELECT item_key, item_code, item_name, unit, store_cat, storage_cat, rd_cat
           FROM dbo.stock_item_total
          ORDER BY sort_order, item_code`),
      q(`SELECT c.item_key, c.branch, c.remaining,
                CONVERT(NVARCHAR(19), c.counted_at, 120) AS counted_text
           FROM dbo.stock_count c
           JOIN (SELECT item_key, branch, MAX(counted_at) AS counted_at
                   FROM dbo.stock_count
                  WHERE @endText IS NULL OR counted_at <= CONVERT(DATETIME2(0), @endText, 120)
                  GROUP BY item_key, branch) last_one
             ON last_one.item_key = c.item_key
            AND last_one.branch = c.branch
            AND last_one.counted_at = c.counted_at`, { endText }),
      q(`SELECT item_key, branch, balance, CONVERT(NVARCHAR(19), updated_at, 120) AS updated_text
           FROM dbo.stock_balance`),
      // หมวดจัดเก็บของหน้ารวมใช้ "แถวแรกที่เจอ" เป็นตัวแทนของสินค้านั้น เพราะแต่ละสาขาตั้งไม่เหมือนกัน
      q(`SELECT s.item_key, s.category
           FROM dbo.stock_storage_category s
           JOIN (SELECT item_key, MIN(ISNULL(sheet_row, 2147483647)) AS sheet_row
                   FROM dbo.stock_storage_category
                  GROUP BY item_key) first_one
             ON first_one.item_key = s.item_key
            AND ISNULL(s.sheet_row, 2147483647) = first_one.sheet_row`),
    ]);

    const countsByItem = new Map();
    counts.forEach(c => {
      const list = countsByItem.get(c.item_key) || [];
      list.push(c);
      countsByItem.set(c.item_key, list);
    });
    const balancesByItem = new Map();
    balances.forEach(b => {
      const list = balancesByItem.get(b.item_key) || [];
      list.push(b);
      balancesByItem.set(b.item_key, list);
    });
    const categoryByItem = new Map();
    categories.forEach(c => { if (!categoryByItem.has(c.item_key)) categoryByItem.set(c.item_key, str(c.category)); });

    return items.map(it => {
      const branchDetails = [];
      const counted = new Set();
      let total = 0, hasAny = false, lastText = '';

      (countsByItem.get(it.item_key) || []).forEach(c => {
        total += num(c.remaining);
        counted.add(c.branch);
        hasAny = true;
        if (c.counted_text > lastText) lastText = c.counted_text;
        branchDetails.push({
          branch: c.branch, remaining: num(c.remaining),
          date: thaiDateTime(c.counted_text), type: 'นับล่าสุด',
        });
      });

      (balancesByItem.get(it.item_key) || []).forEach(b => {
        if (counted.has(b.branch)) return;   // สาขาไหนนับแล้วใช้ยอดนับ ไม่บวกยอดยกมาซ้ำ
        total += num(b.balance);
        hasAny = true;
        if (b.updated_text && b.updated_text > lastText) lastText = b.updated_text;
        branchDetails.push({
          branch: b.branch, remaining: num(b.balance),
          date: thaiDateTime(b.updated_text), type: 'ยอดยกมา',
        });
      });

      return {
        productId: it.item_code,
        name: it.item_name || '',
        unit: str(it.unit),
        storeCat: str(it.store_cat),
        storageCat: categoryByItem.get(it.item_key) ?? str(it.storage_cat),
        rdCat: str(it.rd_cat),
        totalRemaining: hasAny ? Number(total.toFixed(2)) : '',
        lastDate: thaiDateTime(lastText),
        branchDetails,
      };
    });
  }

  return { readStockItems, readStockTotal };
}
