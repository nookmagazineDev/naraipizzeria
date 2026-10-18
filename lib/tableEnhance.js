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

const isScrollX = (el) => {
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

const headCells = (table) => {
  const rows = table.tHead?.rows;
  if (!rows || rows.length !== 1) return null;   // หัวตาราง 2 ชั้น — ล็อกแล้วเพี้ยน ข้ามไป
  const cells = [...rows[0].cells];
  if (!cells.length || cells.some(c => c.colSpan > 1)) return null;
  return cells;
};

const labelOf = (th) => [...th.childNodes]
  .filter(n => !(n.nodeType === 1 && n.classList.contains(PIN)))
  .map(n => n.textContent).join('').trim();

const storeKey = (table) => {
  const sig = (headCells(table) || []).map(labelOf).join('|').slice(0, 300);
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

/** เขียน CSS ล็อก n คอลัมน์แรกของตารางนี้ (วัดความกว้างจริงจากหัวคอลัมน์) */
function paintLock(table) {
  const id = table.dataset.teId;
  const n = Number(table.dataset.teLock) || 0;
  const cells = headCells(table);
  const style = styleOf(id);
  if (!n || !cells) { style.textContent = ''; return; }
  const sel = `table[data-te-id="${id}"]`;
  const rowSel = (k) => ['thead', 'tbody', 'tfoot'].map(s => `${sel} > ${s} > tr > :nth-child(${k})`).join(', ');
  // หัวตารางต้องอยู่เหนือช่องที่ล็อกในตัวตาราง (ตอนเลื่อนลงแล้วหัวตารางค้างอยู่ด้านบน)
  let css = `${sel} > thead { z-index: 5; } ${sel} > thead > tr > * { z-index: 3; }\n`;
  let left = 0;
  for (let i = 0; i < Math.min(n, cells.length); i++) {
    css += `${rowSel(i + 1)} { position: sticky; left: ${left}px; z-index: 2; background-color: #fff; }\n`;
    left += cells[i].getBoundingClientRect().width;
  }
  const last = Math.min(n, cells.length);
  css += `${['thead'].map(s => `${sel} > ${s} > tr > :nth-child(-n+${last})`).join('')} { z-index: 4; background-color: #f8fafc; }\n`;
  css += `${rowSel(last)} { box-shadow: 4px 0 6px -3px rgba(15, 23, 42, .25); border-right: 1px solid #fcd34d; }\n`;
  css += `${sel} > thead > tr > :nth-child(-n+${last}) > .${PIN} { opacity: 1; filter: none; background: #fffbeb; border-color: #fcd34d; }\n`;
  style.textContent = css;
}

function setLock(table, n) {
  table.dataset.teLock = String(n);
  saveLock(table, n);
  paintLock(table);
}

const lockObservers = new Map();   // table → ResizeObserver (ความกว้างคอลัมน์เปลี่ยนตามข้อมูล)

function setupPins(table) {
  const cells = headCells(table);
  if (!cells) return;
  if (!table.dataset.teId) table.dataset.teId = `te${++seq}`;
  cells.forEach((th, i) => {
    if (th.querySelector(`:scope > .${PIN}`)) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = PIN;
    b.textContent = '📌';
    b.title = 'ล็อกคอลัมน์นี้และทุกคอลัมน์ทางซ้าย (กดอีกครั้งเพื่อปลดล็อก)';
    b.setAttribute('aria-label', `ล็อกคอลัมน์ถึง ${labelOf(th) || i + 1}`);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();   // หัวคอลัมน์บางหน้ากดแล้วเรียงข้อมูล — กดหมุดต้องไม่ไปเรียงด้วย
      const now = Number(table.dataset.teLock) || 0;
      const idx = [...(headCells(table) || [])].indexOf(th);
      setLock(table, now === idx + 1 ? 0 : idx + 1);
    });
    th.appendChild(b);
  });
  if (table.dataset.teRestored !== '1') {
    table.dataset.teRestored = '1';
    const n = readLock(table);
    if (n) setLock(table, n);
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
