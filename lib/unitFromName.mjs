// อ่านหน่วยจาก "ชื่อไอเทม" — ธรรมเนียมการตั้งชื่อของทะเบียนสต๊อก/POS ที่ร้านใช้กันมาตลอด
//
//   <ชื่อ>(<ขนาดบรรจุ>)<หน่วยสต๊อก>
//   FCซอสสไปซี่โอชา(400กรัม/ถุง) ถุง              1 ถุง = 400 กรัม
//   FCน้ำจิ้มอาจาด(0.5กก./ถุง) กก.                 หน่วยสต๊อกเป็น กก. → หน่วยใช้ = กรัม (1 กก. = 1000)
//   FCน้ำซอสนึ่งซีอิ้ว(0.15กก./ที่ 5ที่/ถุง) ที่     1 ที่ = 0.15 กก. = 150 กรัม
//   FCชีสสไลซ์สีขาว เบก้า(21แผ่น/แพ็ค) แพ็ค          1 แพ็ค = 21 แผ่น
//   FCแป้งพิซซ่าS(บรรจุ10ก้อน/ถุง) ก้อน             หน่วยสต๊อกเป็นหน่วยเล็กสุดอยู่แล้ว → 1
//   FCลูกชิ้นหมูเสียบไม้(20ไม้/ถุง(3ลูก/ไม้(12g.ลูก) ถุง  1 ถุง = 20 ไม้ = 60 ลูก = 720 กรัม
//
// ใช้ทำอะไร: ตรวจ "สัดส่วน/หน่วย" (Itm Rcpportion) ของสูตร POS ตอนคัดลอกลงฐาน — ค่านั้นคือ
// หน่วยใช้ต่อ 1 หน่วยสต๊อก (ชีท Kios Dtls คิดต้นทุนต่อหน่วยใช้ = ราคา 8.2 ÷ ค่านี้) จึงควรตรงกับ
// ตัวเลขใดตัวหนึ่งที่ชื่อบอกไว้ ไม่ตรงเลยแปลว่าน่าจะคีย์ผิด (ชีทเองก็มีคอลัมน์ "@ ผิด คีย์ช่องนี้"
// ไว้แก้เคสแบบนี้) · และใช้เดาตัวแปลงเมื่อ POS ไม่ได้ใส่มา
//
// ⚠️ คืน "ทุกตัวเลือก" ไม่ใช่คำตอบเดียว — ชื่อบอกได้หลายชั้น (ถุง → ไม้ → ลูก → กรัม) และแต่ละสูตร
//    ใช้คนละชั้นได้จริง จะใช้ชั้นไหนต้องดูจากตัวเลขของสูตรประกอบ ไม่ใช่เดาจากชื่ออย่างเดียว
//
// ตรวจกับชื่อไอเทมจริง 877 ตัวในแท็บ 8.2 ของชีท Kios Dtls (ก.ย. 2026): อ่านหน่วยสต๊อกได้ 786 ตัว (90%)
// ได้ขนาดด้วย 615 ตัว (70%) · อีก 171 ตัวหน่วยสต๊อกเป็นหน่วยเล็กสุดเอง (ก้อน/ขวดที่ไม่บอกขนาด)
// · 91 ตัวชื่อไม่มีหน่วยเลย (ผักสด เช่น ข่า ตะไคร้ และของใช้) — กลุ่มนี้คืนค่าว่าง ไม่เดา

// ชื่อหน่วยที่เขียนกันหลายแบบ → ชื่อกลางตัวเดียว (คีย์ = ตัวพิมพ์เล็ก ไม่มีจุดท้าย)
const ALIAS = {
  'กก': 'กก.', 'กิโล': 'กก.', 'กิโลกรัม': 'กก.', 'kg': 'กก.', 'kgs': 'กก.',
  'กรัม': 'กรัม', 'g': 'กรัม', 'gm': 'กรัม', 'gr': 'กรัม', 'grams': 'กรัม',
  'ลิตร': 'ลิตร', 'l': 'ลิตร', 'lt': 'ลิตร', 'ltr': 'ลิตร',
  'มล': 'มล.', 'มิล': 'มล.', 'มิลลิลิตร': 'มล.', 'ml': 'มล.', 'cc': 'มล.', 'ซีซี': 'มล.', 'ซซ': 'มล.',
  'แพ็ค': 'แพ็ค', 'แพ๊ค': 'แพ็ค', 'แพค': 'แพ็ค', 'pack': 'แพ็ค', 'pk': 'แพ็ค', 'p': 'แพ็ค',
  'ชิ้น': 'ชิ้น', 'pc': 'ชิ้น', 'pcs': 'ชิ้น',
  'กล': 'แกลลอน', 'แกลลอน': 'แกลลอน', 'แกลอน': 'แกลลอน', 'gal': 'แกลลอน',
  'กป': 'กระป๋อง', 'กระป๋อง': 'กระป๋อง',
  'หึบ': 'หีบ', 'ctn': 'ลัง', 'ca': 'ลัง',
};
// หน่วยชั่ง/ตวง: แปลงเป็นหน่วยเล็กสุดของมันเองได้เสมอ ไม่ต้องให้ชื่อบอก
const BASE = { 'กก.': ['กรัม', 1000], 'ลิตร': ['มล.', 1000] };
const MEASURE = new Set(['กก.', 'กรัม', 'ลิตร', 'มล.']);
// หน่วยนับ/ภาชนะที่เจอจริงในชื่อ — ใช้ตัดสินว่าคำท้ายชื่อเป็น "หน่วย" ไม่ใช่ชื่อสินค้า
const COUNT_UNITS = new Set([
  'ถุง', 'แพ็ค', 'ชิ้น', 'ขวด', 'ใบ', 'แกลลอน', 'กระป๋อง', 'ที่', 'กล่อง', 'ม้วน', 'แผ่น', 'ซอง', 'ชุด',
  'ก้อน', 'ถ้วย', 'แท่ง', 'คู่', 'ถาด', 'หลอด', 'ถัง', 'ดวง', 'ฝา', 'เล่ม', 'ฟอง', 'ลูก', 'ไม้', 'ตัว',
  'เส้น', 'ปี๊บ', 'ลัง', 'หีบ', 'กระสอบ', 'โหล', 'อัน', 'ถาดฟอยส์', 'หัว', 'กำ', 'มัด', 'ห่อ', 'ตลับ',
  'กระปุก', 'ขีด', 'กะละมัง', 'ชาม', 'จาน', 'แก้ว', 'ผืน', 'คัน',
]);
// คำที่ตามหลังตัวเลขได้แต่ไม่ใช่หน่วย (ขนาด/มิติ/ความเข้มข้น)
const NOT_UNIT = /^(x|นิ้ว|cm|ซม|mm|มม|oz|ชั้น|ช่อง|ปี|เบอร์|no|nw|size|%)$/i;

/** ชื่อหน่วยกลาง ('' = ไม่ใช่หน่วย) */
export function normUnit(u) {
  const s = String(u ?? '').trim().replace(/^[[(/]+|[\])]+$/g, '').replace(/[.‡]+$/g, '').trim();
  if (!s || /\d/.test(s) || NOT_UNIT.test(s)) return '';
  return ALIAS[s.toLowerCase()] || s;
}
const isKnownUnit = (u) => MEASURE.has(u) || COUNT_UNITS.has(u);

// คำที่เขียนเป็นหน่วยได้ทั้งหมด (ชื่อกลาง + ชื่อเล่น) ยาวก่อนสั้น — ไว้หาหน่วยที่ "ติดท้าย" คำยาว
// ("ซอสพริกแกลลอน(5kg.)" → แกลลอน) โดยไม่ตัดคำกลางคำมั่ว ๆ แบบ "กรัม" → "กร"+"ัม"
// เฉพาะคำไทย — ชื่อเล่นภาษาอังกฤษสั้นแค่ตัวเดียว (g / p / l) ถ้าให้จับท้ายคำด้วย "Heinz…p" จะกลายเป็นแพ็ค
const UNIT_WORDS = [...new Set([...Object.keys(ALIAS), ...MEASURE, ...COUNT_UNITS].map(w => w.replace(/\.$/, '')))]
  .filter(w => /^[ก-๙]+$/.test(w))
  .sort((a, b) => b.length - a.length);
/** หน่วยที่รู้จักเท่านั้น ('' = ไม่ใช่) */
const knownUnit = (w) => { const n = normUnit(w); return isKnownUnit(n) ? n : ''; };
/** หน่วยที่คำนี้เป็น หรือลงท้าย ('' = ไม่ใช่หน่วย) */
function unitSuffix(word) {
  const whole = knownUnit(word);
  if (whole) return whole;
  const w = String(word ?? '').replace(/\.$/, '');
  const hit = UNIT_WORDS.find(u => w.endsWith(u));
  return hit ? knownUnit(hit) : '';
}

// ตัวเลข: 1,500 / 0.5 / ช่วง 1700-2000 (ใช้ค่ากลาง)
const NUM = '(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)(?:\\s*-\\s*(\\d+(?:\\.\\d+)?))?';
const WORD = '([ก-๙A-Za-z]+)\\.?';
const toNum = (a, b) => {
  const lo = parseFloat(String(a).replace(/,/g, ''));
  return b ? (lo + parseFloat(b)) / 2 : lo;
};

/**
 * หน่วยสต๊อก = คำท้ายชื่อ ("…(0.5กก./ถุง) กก." → กก.) ต้องเป็นหน่วยที่รู้จักเท่านั้น
 * ลองตามลำดับ: หลังวงเล็บปิดตัวสุดท้าย → "/ หน่วย" ท้ายชื่อ → คำสุดท้ายหลังช่องว่าง/ติดท้าย
 * → วงเล็บท้ายชื่อที่มีแต่หน่วย ("หมูสันนอก (กก.)") — วงเล็บหมายเหตุท้ายสุด เช่น "(ฟรีจากซัพ)" ข้ามไป
 */
export function stockUnitOf(name) {
  let s = String(name ?? '').trim().replace(/\\/g, '/');
  for (let guard = 0; guard < 3; guard++) {
    const onlyParen = /\(\s*([^\d()\s]+)\s*\)\s*$/.exec(s);
    const cand = [
      /\)\s*([^\s()]+)\s*$/.exec(s)?.[1],       // …) กก.
      /\/\s*([^\s/()]+)\s*\)?\s*$/.exec(s)?.[1],  // …/ถุง  ·  …(1070กรัม/ขวด)
      /\s([^\s()/]+)\s*$/.exec(s)?.[1],          // … ขวด
      onlyParen?.[1],                             // …(กก.)
    ].map(normUnit).find(isKnownUnit);
    if (cand) return cand;
    // ติดท้ายชื่อโดยไม่เว้นวรรค: "สะโพกเนื้อวัวกก." — รับเฉพาะหน่วยชั่งตวงที่ไม่มีตัวเลขนำหน้า
    const glued = /[^\d\s.](กก\.?|กิโล)\s*$/.exec(s);
    if (glued) return 'กก.';
    // วงเล็บหมายเหตุท้ายสุดที่ไม่ใช่หน่วย → ตัดทิ้งแล้วลองใหม่
    if (onlyParen && !isKnownUnit(normUnit(onlyParen[1]))) { s = s.slice(0, onlyParen.index).trim(); continue; }
    break;
  }
  return '';
}

/**
 * ความสัมพันธ์ "1 <ภาชนะ> = Q <หน่วย>" ทุกคู่ที่ชื่อบอกไว้
 *   "400กรัม/ถุง"  "500กรัม/20ถุง/ลัง"  → 1 ถุง = 400/500 กรัม   (ตัวเลขกลาง = จำนวนต่อชั้นถัดไป ไม่ใช่ของชั้นนี้)
 *   "1ถุง/1กก"  "1ถุง\500กรัม"           → 1 ถุง = 1 กก. / 500 กรัม (เขียนกลับด้าน: ภาชนะอยู่หน้า)
 *   "1กล่อง/12ขวด"                        → 1 กล่อง = 12 ขวด
 *   "80กรัมx6ก้อน/แพ็ค"                   → 1 ก้อน = 80 กรัม (+ 1 แพ็ค = 6 ก้อน จากคู่ถัดไป)
 *   "ถุง24/ลัง"                            → 1 ลัง = 24 ถุง   (ตัวเลขไม่มีหน่วย = หน่วยก่อนหน้า)
 *   "ถุง(500g.)"                           → 1 ถุง = 500 กรัม
 *   "12g.ลูก"                              → 1 ลูก = 12 กรัม  (ลืมใส่ /)
 * @param {string} name
 * @param {string} [stockUnit] ใส่มา = ตัวเลขชั่งตวงลอย ๆ ในชื่อ ("มะกอกดำ 387กรัม(12ขวด/กล่อง) ขวด")
 *                            นับเป็นขนาดของหน่วยสต๊อก (เฉพาะเมื่อหน่วยสต๊อกไม่ใช่หน่วยชั่งตวงเอง)
 */
export function packRelations(name, stockUnit = '') {
  const s = String(name ?? '').replace(/\\/g, '/');
  const out = [];
  const used = [];   // ช่วงตัวอักษรที่ถูกอ่านเป็นความสัมพันธ์แล้ว — กันนับตัวเลขชั่งตวงซ้ำเป็น "ลอย ๆ"
  const push = (from, q, unit) => {
    from = knownUnit(from); unit = knownUnit(unit);
    if (!from || !unit || from === unit || !(q > 0)) return false;
    out.push({ from, q, unit });
    return true;
  };
  const mark = (m) => used.push([m.index, m.index + m[0].length]);

  // Q U x N V  (สินค้าบรรจุหลายหน่วยย่อย: "80กรัมx6ก้อน")
  for (const m of s.matchAll(new RegExp(`${NUM}\\s*${WORD}\\s*[xX*]\\s*(\\d+)\\s*${WORD}`, 'g'))) {
    if (push(m[5], toNum(m[1], m[2]), m[3])) mark(m);
  }
  // Q U / [N] V  และ  Q U.V (ลืม / แต่มีจุดคั่น: "12g.ลูก")
  // ตัวเลขกลาง N เป็นจุดเริ่มของคู่ถัดไปได้ด้วย ("500กรัม/20ถุง/กล่อง" = 500 กรัมต่อถุง · 20 ถุงต่อกล่อง)
  // จึงถอย lastIndex กลับไปที่ N ให้คู่ "20ถุง/กล่อง" ถูกอ่านต่อ (matchAll ไม่อ่านซ้อนกันให้)
  const main = new RegExp(`${NUM}\\s*([ก-๙A-Za-z]+)(?:\\.?\\s*/\\s*(?:(\\d+(?:\\.\\d+)?)\\s*)?|\\.\\s*)${WORD}`, 'gd');
  for (let m = main.exec(s); m; m = main.exec(s)) {
    const q = toNum(m[1], m[2]);
    const u = knownUnit(m[3]);
    const n = m[4] ? parseFloat(m[4]) : null;
    const v = knownUnit(m[5]) || unitSuffix(m[5]);
    if (n !== null) main.lastIndex = m.indices[4][0];
    if (!u || !v) continue;
    mark(m);
    if (q === 1 && n !== null && !MEASURE.has(u)) push(u, n, v);                        // 1กล่อง/12ขวด · 1ถุง/500กรัม · 1ถุง/1กก
    else if (q === 1 && !MEASURE.has(u) && MEASURE.has(v)) push(u, 1, v);               // 1ถุง/กก.
    else if (n !== null && !MEASURE.has(u) && MEASURE.has(v)) push(v, q / n, u);        // 38ชิ้น/500g = 38 ชิ้นต่อ 500 กรัม
    else push(v, q, u);                                                                 // 400กรัม/ถุง · 1ลิตร/6ขวด · 40ลูก/กก.
  }
  // U N / V  ("ถุง24/ลัง")
  for (const m of s.matchAll(new RegExp(`([ก-๙A-Za-z]+)\\.?\\s*(\\d+)\\s*/\\s*${WORD}`, 'g'))) {
    const u = unitSuffix(m[1]);
    if (u && !MEASURE.has(u)) push(m[3], parseFloat(m[2]), u);
  }
  // U(Q V)  ("ถุง(500g.)" · "ซอสพริกแกลลอน(5kg.)") — คำหน้าวงเล็บต้องลงท้ายด้วยหน่วย
  for (const m of s.matchAll(new RegExp(`([ก-๙A-Za-z]+)\\s*\\(\\s*${NUM}\\s*${WORD}\\s*\\)`, 'g'))) {
    const v = knownUnit(m[4]);
    if (MEASURE.has(v) && push(unitSuffix(m[1]), toNum(m[2], m[3]), v)) mark(m);
  }
  // ตัวเลขชั่งตวงลอย ๆ = ขนาดของหน่วยสต๊อก ("387กรัม(12ขวด/กล่อง) ขวด" · "(5kg.)แกลลอน")
  if (stockUnit && !MEASURE.has(stockUnit)) {
    for (const m of s.matchAll(new RegExp(`${NUM}\\s*${WORD}`, 'g'))) {
      const v = knownUnit(m[3]);
      if (!MEASURE.has(v)) continue;
      if (used.some(([a, b]) => m.index >= a && m.index < b)) continue;
      // ตามด้วยคู่จริง ("/ถุง" · "x6ก้อน") = ไม่ใช่ขนาดลอย ๆ · ตามด้วยตัวเลขเปล่า ("/10/ลัง" · "x12/ลัง") = ใช่
      if (/^\s*(?:\/\s*[ก-๙A-Za-z]|[xX*]\s*\d+\s*[ก-๙A-Za-z])/.test(s.slice(m.index + m[0].length))) continue;
      push(stockUnit, toNum(m[1], m[2]), v);
    }
  }
  return out;
}

/**
 * ตัวแปลงที่ชื่อบอกได้: 1 <หน่วยสต๊อก> = กี่ <หน่วยย่อย> — ไล่ต่อกันเป็นทอด ๆ จนสุด
 * @returns {{ stockUnit: string, options: Array<{ unit: string, per: number }>, smallest: {unit, per} | null }}
 *   options  ทุกชั้นที่ไปถึงได้ เรียงจากใกล้ไปไกล
 *   smallest หน่วยเล็กที่สุด = ตัวที่ 1 หน่วยสต๊อกแตกได้จำนวนมากที่สุด
 *            (1 ถุง = 20 ไม้ = 60 ลูก = 720 กรัม → 720 กรัม) · ไม่มีอะไรย่อยลงไปอีก = หน่วยสต๊อกเอง × 1
 */
export function unitOptionsFromName(name, stockUnitHint = '') {
  // หน่วยสต๊อกที่รู้อยู่แล้วจากที่อื่น (เช่นหน่วยซื้อในทะเบียน) ใช้แทนคำท้ายชื่อได้
  const stockUnit = knownUnit(stockUnitHint) || stockUnitOf(name);
  if (!stockUnit) return { stockUnit, options: [], smallest: null };
  const rel = packRelations(name, stockUnit);
  const options = [];
  const seen = new Set([stockUnit]);
  let frontier = [{ unit: stockUnit, per: 1 }];
  for (let depth = 0; depth < 5 && frontier.length; depth++) {
    const next = [];
    for (const f of frontier) {
      const steps = rel.filter(r => r.from === f.unit).map(r => ({ unit: r.unit, per: f.per * r.q }));
      if (BASE[f.unit]) steps.push({ unit: BASE[f.unit][0], per: f.per * BASE[f.unit][1] });
      for (const st of steps) {
        if (seen.has(st.unit)) continue;
        seen.add(st.unit);
        const opt = { unit: st.unit, per: Math.round(st.per * 10000) / 10000 };
        options.push(opt);
        next.push(opt);
      }
    }
    frontier = next;
  }
  const smallest = options.reduce((best, o) => (o.per > best.per ? o : best), { unit: stockUnit, per: 1 });
  return { stockUnit, options, smallest };
}

/**
 * ตัวแปลง (portion) ตรงกับที่ชื่อบอกไหม — stockUnitHint = หน่วยที่ตัวแปลงนี้นับจาก (ไม่ใส่ = คำท้ายชื่อ)
 * @returns {{ ok: boolean|null, unit: string, expect: {unit, per} | null }}
 *   ok = null  ชื่อไม่ได้บอกขนาด เทียบไม่ได้
 *   unit       หน่วยใช้ที่ตัวเลขนั้นหมายถึง (portion 1000 ของ "…กก." → กรัม)
 *   expect     หน่วยเล็กสุดที่ชื่อบอก — ไว้บอกผู้ใช้ว่า "ชื่อบอกว่า 1 ถุง = 400 กรัม"
 */
export function checkConverter(name, converter, stockUnitHint = '') {
  const conv = Number(converter);
  const { stockUnit, options, smallest } = unitOptionsFromName(name, stockUnitHint);
  if (!stockUnit || !(conv > 0)) return { ok: null, unit: '', expect: null };
  if (conv === 1) return { ok: true, unit: stockUnit, expect: smallest };
  const hit = options.find(o => Math.abs(o.per - conv) <= Math.max(0.001, o.per * 0.001));
  if (hit) return { ok: true, unit: hit.unit, expect: smallest };
  return { ok: options.length ? false : null, unit: '', expect: options.length ? smallest : null };
}

/**
 * หน่วยใช้ที่ควรเป็นของวัตถุดิบหนึ่งตัว จากชื่อ + หน่วยซื้อ + ตัวแปลงในทะเบียน — ปุ่ม "เติมหน่วยใช้จากชื่อ"
 * หน้า QC/RD > วัตถุดิบ และตอนคัดลอกสูตร POS ใช้กติกาเดียวกัน
 *
 * @param {{ name: string, unit?: string, converter?: number|null }} item
 * @returns {{
 *   useUnit: string,            '' = ไม่เสนอ
 *   basis: 'match'|'name'|'',   match = ตัวแปลงของทะเบียนตรงกับขนาดที่ชื่อบอก (มั่นใจ)
 *                               name  = ทะเบียนยังไม่มีตัวแปลง ใช้หน่วยเล็กสุดที่ชื่อบอก
 *   per: number|null,           ตัวแปลงที่หน่วยนั้นคู่กัน (match = ของทะเบียน · name = ที่ชื่อบอก)
 *   ambiguous: boolean,         ชื่อแตกได้หลายชั้นที่เป็นหน่วยนับ (ถุง → ไม้ → ลูก → กรัม) สูตรอาจใช้ชั้นอื่น
 *   reason: ''|'mismatch'|'noinfo',  mismatch = ตัวแปลงไม่ตรงกับชื่อ (ควรแก้ตัวแปลงก่อน) · noinfo = ชื่อไม่บอก
 *   expect: {unit, per}|null,   ขนาดที่ชื่อบอก (ไว้แสดงคู่กับ mismatch)
 * }}
 */
export function suggestUseUnit({ name, unit = '', converter = null }) {
  const none = (reason, expect = null) => ({ useUnit: '', basis: '', per: null, ambiguous: false, reason, expect });
  const conv = Number(converter);
  if (conv > 0) {
    const chk = checkConverter(name, conv, unit);
    if (chk.ok) return { useUnit: chk.unit, basis: 'match', per: conv, ambiguous: false, reason: '', expect: chk.expect };
    return chk.ok === false ? none('mismatch', chk.expect) : none('noinfo');
  }
  const { options, smallest } = unitOptionsFromName(name, unit);
  if (!options.length) return none('noinfo');
  // กก. → กรัม / ลิตร → มล. เป็นการแปลงมาตรฐาน ไม่นับว่ากำกวม — กำกวมเมื่อมีหน่วยนับปนอยู่ด้วย
  const ambiguous = options.length > 1 && options.some(o => !MEASURE.has(o.unit));
  return { useUnit: smallest.unit, basis: 'name', per: smallest.per, ambiguous, reason: '', expect: smallest };
}
