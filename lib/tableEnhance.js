// ตารางที่กว้างเกินจอ — เพิ่มให้ "ทุกตารางทุกหน้า" จากที่เดียว (เรียกใน pages/_app.js)
//
//   1) แถบเลื่อนซ้าย-ขวาเหนือหัวตาราง ขยับพร้อมแถบล่างของกล่องตาราง
//      (ของเดิมต้องเลื่อนลงไปล่างสุดของตารางก่อนถึงจะเลื่อนข้างได้)
//      ขึ้นเฉพาะตอนตารางกว้างกว่ากล่อง ย่อ/ขยายจอแล้วขึ้น-หายเอง
//   2) หมุด 📌 ที่หัวคอลัมน์ — กดแล้วคอลัมน์นั้นและทุกคอลัมน์ทางซ้ายค้างอยู่ตอนเลื่อนข้าง
//      จำแยกต่อตาราง (หน้า + ชื่อหัวคอลัมน์) ไว้ในเครื่องของคนนั้น
//
// ทำผ่าน DOM แทนการไล่แก้คอมโพเนนต์ทีละหน้า (ตารางเลื่อนข้างได้มีอยู่ราว 80 จุด)
// กติกาที่ต้องรักษาไว้เพื่อไม่ชนกับ React:
//   - ไม่ย้าย/ห่อโหนดที่ React สร้าง — แถบบนเป็นโหนดใหม่ที่แทรกไว้หน้ากล่องตาราง
//   - การล็อกคอลัมน์ใช้ <style> ต่อตาราง (เลือกด้วย data-te-id + nth-child) แถวที่ React
//     วาดใหม่ทีหลังจึงค้างตามเองโดยไม่ต้องไปแตะ style ของทุกช่อง
//   - หมุดในหัวคอลัมน์ถ้า React เขียนทับหาย MutationObserver จะใส่กลับให้
// ไม่อยากให้ตารางไหนมีของพวกนี้: ใส่ data-no-table-enhance ที่ตารางหรือกล่องที่ครอบ

const BAR = 'tbl-topbar';
const PIN = 'tbl-pin';
const STORE = 'tblLock:';
let seq = 0;

// กล่องตารางที่ตั้งใจให้เลื่อนข้าง (overflow-x-auto / overflow-auto) — ไม่นับกล่องเลื่อนหน้า
// แบบ overflow-y-auto ซึ่งเบราว์เซอร์ถือว่า overflow-x เป็น auto ไปด้วย (ไม่งั้นแถบจะไปโผล่เหนือทั้งหน้า)
const SCROLL_X_CLASS = /(^|\s)(overflow-x-(auto|scroll)|overflow-(auto|scroll))(\s|$)/;
const isScrollX = (el) => {
  if (!SCROLL_X_CLASS.test(el.getAttribute('class') || '') && !/overflow(-x)?\s*:\s*(auto|scroll)/.test(el.getAttribute('style') || '')) return false;
  const o = getComputedStyle(el).overflowX;
  return o === 'auto' || o === 'scroll';
};

/** กล่องที่เลื่อนข้างได้ซึ่งครอบตารางนี้ (ไล่ขึ้นไปไม่เกิน 6 ชั้น) */
function scrollBoxOf(table) {
  let el = table.parentElement;
  for (let i = 0; el && el !== document.body && i < 6; i++, el = el.parentElement) {
    if (isScrollX(el)) return el;
  }
  return null;
}

/** แทรกแถบบนได้ไหม — พ่อแม่ที่เป็น flex แนวนอน/grid จะดันแถบไปอยู่ข้าง ๆ แทนที่จะอยู่บน */
function canInsertAbove(box) {
  const p = box.parentElement;
  if (!p) return false;
  const cs = getComputedStyle(p);
  if (cs.display.includes('grid')) return false;
  if (cs.display.includes('flex') && !cs.flexDirection.startsWith('column')) return false;
  return true;
}

/* ───────────── แถบเลื่อนด้านบน ───────────── */

const bars = new Map();   // box → { bar, inner, ro }

function setupTopBar(box, table) {
  const have = bars.get(box);
  if (have) {
    if (!have.tables.has(table)) { have.tables.add(table); have.ro.observe(table); }
    have.update();
    return;
  }
  if (!canInsertAbove(box)) return;
  const bar = document.createElement('div');
  bar.className = BAR;
  bar.setAttribute('aria-hidden', 'true');
  const inner = document.createElement('div');
  bar.appendChild(inner);
  box.parentElement.insertBefore(bar, box);

  let from = null;   // กันสองกล่องสั่งกันไปมาไม่จบ
  bar.addEventListener('scroll', () => {
    if (from === box) { from = null; return; }
    from = bar;
    box.scrollLeft = bar.scrollLeft;
  }, { passive: true });
  const onBox = () => {
    if (from === bar) { from = null; return; }
    from = box;
    bar.scrollLeft = box.scrollLeft;
  };
  box.addEventListener('scroll', onBox, { passive: true });

  const update = () => {
    const over = box.scrollWidth > box.clientWidth + 1;
    bar.hidden = !over;
    if (!over) return;
    inner.style.width = `${box.scrollWidth}px`;
    // ให้แถบกว้างและเยื้องเท่ากล่องตาราง (กล่องอาจมี margin ซ้ายขวา)
    const cs = getComputedStyle(box);
    bar.style.marginLeft = cs.marginLeft;
    bar.style.marginRight = cs.marginRight;
    bar.style.width = `${box.offsetWidth}px`;
    bar.scrollLeft = box.scrollLeft;
  };
  const ro = new ResizeObserver(() => requestAnimationFrame(update));
  ro.observe(box);
  ro.observe(table);
  bars.set(box, { bar, inner, ro, update, tables: new Set([table]), onBox });
  update();
}

/** กล่องตารางที่ถูกถอดออกไปแล้ว (เปลี่ยนหน้า/ปิดป๊อปอัพ) — เก็บแถบของมันทิ้งด้วย */
function sweepBars() {
  for (const [box, b] of bars) {
    if (box.isConnected && b.bar.isConnected) continue;
    b.ro.disconnect();
    box.removeEventListener('scroll', b.onBox);
    b.bar.remove();
    bars.delete(box);
  }
}

/* ───────────── ล็อกคอลัมน์ ───────────── */

/**
 * โครงหัวตาราง — รองรับหัวหลายชั้น (rowSpan/colSpan) เช่นหน้าสแกนหน้าตอนเปิดเทียบตารางงาน
 * คืน { nCols, pos: Map(th → { start, span }), leaf: [th ของแต่ละคอลัมน์จริง] } หรือ null
 * leaf = หัวคอลัมน์ชั้นล่างสุดที่กินคอลัมน์เดียว (ตัวที่วางหมุด และใช้วัดความกว้างคอลัมน์)
 */
function headModel(table) {
  const rows = table.tHead?.rows;
  if (!rows || !rows.length) return null;
  const grid = [];
  const pos = new Map();
  [...rows].forEach((tr, r) => {
    grid[r] = grid[r] || [];
    let c = 0;
    [...tr.cells].forEach(cell => {
      while (grid[r][c]) c++;
      const span = Math.max(1, cell.colSpan || 1);
      const rs = Math.max(1, cell.rowSpan || 1);
      for (let rr = r; rr < r + rs; rr++) {
        grid[rr] = grid[rr] || [];
        for (let cc = c; cc < c + span; cc++) grid[rr][cc] = cell;
      }
      pos.set(cell, { start: c, span });
      c += span;
    });
  });
  const nCols = Math.max(...grid.map(g => g.length));
  if (!nCols) return null;
  const leaf = [];
  for (let c = 0; c < nCols; c++) {
    let th = null;
    for (let r = grid.length - 1; r >= 0 && !th; r--) {
      const cell = grid[r][c];
      if (cell && pos.get(cell).span === 1) th = cell;
    }
    if (!th) return null;   // คอลัมน์ที่ไม่มีหัวของตัวเอง — ไม่รู้จะวางหมุด/วัดความกว้างที่ไหน
    leaf.push(th);
  }
  return { nCols, pos, leaf };
}

const labelOf = (th) => [...th.childNodes]
  .filter(n => !(n.nodeType === 1 && n.classList.contains(PIN)))
  .map(n => n.textContent).join('').trim();

const storeKey = (table) => {
  const m = headModel(table);
  const sig = (m ? m.leaf : []).map(labelOf).join('|').slice(0, 300);
  return `${STORE}${location.pathname}:${sig}`;
};

function readLock(table) {
  try { return Number(localStorage.getItem(storeKey(table))) || 0; } catch { return 0; }
}
function saveLock(table, n) {
  try {
    if (n > 0) localStorage.setItem(storeKey(table), String(n));
    else localStorage.removeItem(storeKey(table));
  } catch { /* เก็บไม่ได้ก็ล็อกได้แค่รอบนี้ */ }
}

const styleOf = (id) => {
  let el = document.getElementById(`te-style-${id}`);
  if (!el) {
    el = document.createElement('style');
    el.id = `te-style-${id}`;
    document.head.appendChild(el);
  }
  return el;
};

const EDGE_SHADOW = '4px 0 6px -3px rgba(15, 23, 42, .25)';
const isClear = (c) => c === 'transparent' || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c);

/** ล้างค่าที่เคยใส่ไว้ในหัวคอลัมน์ (ปลดล็อก/ล็อกน้อยลง) */
function clearHeadCell(th) {
  if (th.dataset.teLocked !== '1') return;
  delete th.dataset.teLocked;
  th.style.left = '';
  th.style.zIndex = '';
  th.style.boxShadow = '';
  if (th.dataset.teBg === '1') { th.style.backgroundColor = ''; delete th.dataset.teBg; }
  if (th.dataset.tePos === '1') { th.style.position = ''; delete th.dataset.tePos; }
}

/**
 * ล็อก n คอลัมน์แรก
 *   ตัวตาราง → <style> ต่อตาราง (nth-child) แถวที่ React วาดใหม่จึงค้างตามเอง
 *   หัวตาราง → ใส่ที่ช่องหัวโดยตรง เพราะหัวหลายชั้นใช้ nth-child ไม่ได้ (ลำดับในแต่ละชั้นไม่ตรงกับคอลัมน์)
 */
function paintLock(table) {
  const id = table.dataset.teId;
  const m = headModel(table);
  const want = Number(table.dataset.teLock) || 0;
  const style = styleOf(id);
  const n = m ? Math.min(want, m.nCols) : 0;
  if (m) m.pos.forEach((_, th) => { if (!n) clearHeadCell(th); });
  if (!n) { style.textContent = ''; return; }

  const widths = m.leaf.map(th => th.getBoundingClientRect().width);
  const offset = [0];
  widths.forEach((w, i) => { offset[i + 1] = offset[i] + w; });

  const sel = `table[data-te-id="${id}"]`;
  const bodySel = (k) => ['tbody', 'tfoot'].map(s => `${sel} > ${s} > tr > :nth-child(${k})`).join(', ');
  // หัวตารางต้องอยู่เหนือช่องที่ล็อกในตัวตาราง (ตอนเลื่อนลงแล้วหัวตารางค้างอยู่ด้านบน)
  let css = `${sel} > thead { z-index: 5; } ${sel} > thead > tr > * { z-index: 3; }\n`;
  for (let i = 0; i < n; i++) {
    css += `${bodySel(i + 1)} { position: sticky; left: ${offset[i]}px; z-index: 2; background-color: #fff; }\n`;
  }
  css += `${bodySel(n)} { box-shadow: ${EDGE_SHADOW}; border-right: 1px solid #fcd34d; }\n`;
  style.textContent = css;

  m.pos.forEach(({ start, span }, th) => {
    if (start + span > n) { clearHeadCell(th); return; }
    const cs = getComputedStyle(th);
    if (cs.position !== 'sticky') { th.style.position = 'sticky'; th.dataset.tePos = '1'; }
    if (isClear(cs.backgroundColor) || th.dataset.teBg === '1') { th.style.backgroundColor = '#f8fafc'; th.dataset.teBg = '1'; }
    th.style.left = `${offset[start]}px`;
    th.style.zIndex = '4';
    th.style.boxShadow = start + span === n ? EDGE_SHADOW : '';
    th.dataset.teLocked = '1';
  });
  m.leaf.forEach((th, i) => th.querySelector(`:scope > .${PIN}`)?.classList.toggle('on', i < n));
}

function setLock(table, n) {
  table.dataset.teLock = String(n);
  saveLock(table, n);
  paintLock(table);
}

const lockObservers = new Map();   // table → ResizeObserver (ความกว้างคอลัมน์เปลี่ยนตามข้อมูล)

function setupPins(table) {
  const m = headModel(table);
  if (!m) return;
  if (!table.dataset.teId) table.dataset.teId = `te${++seq}`;
  let added = false;
  m.leaf.forEach((th) => {
    if (th.querySelector(`:scope > .${PIN}`)) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = PIN;
    b.textContent = '📌';
    b.title = 'ล็อกคอลัมน์นี้และทุกคอลัมน์ทางซ้าย (กดอีกครั้งเพื่อปลดล็อก)';
    b.setAttribute('aria-label', `ล็อกคอลัมน์ถึง ${labelOf(th)}`);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();   // หัวคอลัมน์บางหน้ากดแล้วเรียงข้อมูล — กดหมุดต้องไม่ไปเรียงด้วย
      const now = Number(table.dataset.teLock) || 0;
      const idx = (headModel(table)?.leaf || []).indexOf(th);
      if (idx < 0) return;
      setLock(table, now === idx + 1 ? 0 : idx + 1);
    });
    th.appendChild(b);
    added = true;
  });
  if (table.dataset.teRestored !== '1') {
    table.dataset.teRestored = '1';
    const n = readLock(table);
    if (n) setLock(table, n);
  } else if (added && Number(table.dataset.teLock)) {
    paintLock(table);   // หัวตารางถูกวาดใหม่ (เช่นสลับหัวชั้นเดียว/สองชั้น) — ใส่ล็อกให้หัวชุดใหม่
  }
  if (!lockObservers.has(table)) {
    const ro = new ResizeObserver(() => requestAnimationFrame(() => paintLock(table)));
    ro.observe(table);
    lockObservers.set(table, ro);
  }
}

function sweepLocks() {
  for (const [table, ro] of lockObservers) {
    if (table.isConnected) continue;
    ro.disconnect();
    lockObservers.delete(table);
    document.getElementById(`te-style-${table.dataset.teId}`)?.remove();
  }
}

/* ───────────── ไล่ทั้งหน้า ───────────── */

function scan() {
  sweepBars();
  sweepLocks();
  document.querySelectorAll('table').forEach(table => {
    if (table.closest('[data-no-table-enhance]')) return;
    const box = scrollBoxOf(table);
    if (!box) return;
    // ตารางที่ซ้อนอยู่ในช่องของตารางอื่น (เช่นรายการในบิล) ไม่ต้องมีแถบ/หมุดของตัวเอง
    if (table.parentElement?.closest('td, th')) return;
    setupTopBar(box, table);
    setupPins(table);
  });
}

/** เริ่มทำงาน — คืนฟังก์ชันหยุด */
export function startTableEnhance() {
  let timer = null;
  const later = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; scan(); }, 120);
  };
  const mo = new MutationObserver(later);
  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', later);
  scan();
  return () => {
    mo.disconnect();
    window.removeEventListener('resize', later);
    clearTimeout(timer);
  };
}
