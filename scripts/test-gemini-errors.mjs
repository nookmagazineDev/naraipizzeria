// ตรวจว่า error แบบไหนควรขยับไปโมเดลถัดไป และผู้ใช้จะเห็นข้อความอะไร
//
// มีไฟล์นี้เพราะเคยหลุดมาแล้ว: Gemini ตอบ 503 (โมเดลโหลดเต็ม) แต่โค้ดนับแค่ 429/400/404
// ว่า "ลองตัวถัดไปได้" 503 จึงโยน error ออกตั้งแต่โมเดลแรก ไม่ได้แตะโมเดลสำรองอีก 2 ตัวเลย
// แล้วส่งข้อความอังกฤษดิบของ Google ออกไปให้ผู้ใช้อ่าน
//
//   node scripts/test-gemini-errors.mjs
import { classifyGeminiError, friendlyGeminiError } from '../lib/geminiError.mjs';

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const isThai = (s) => /[฀-๿]/.test(s);

/* ─────────── ข้อความจริงที่ Gemini ส่งกลับมาในแต่ละกรณี ─────────── */
const CASES = {
  overloaded: {
    status: 503,
    message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
  },
  serverError: { status: 500, message: 'Internal error encountered.' },
  quota: { status: 429, message: 'Resource has been exhausted (e.g. check quota).' },
  badArg: { status: 400, message: 'Request contains an invalid argument.' },
  noModel: { status: 404, message: 'models/gemini-x is not found for API version v1beta' },
  unknown: { status: 418, message: 'อะไรสักอย่างที่ไม่เคยเจอ' },
};

console.log('\nจำแนก error');
{
  const c = classifyGeminiError(CASES.overloaded);
  check('503 โมเดลโหลดเต็ม → overloaded', c.overloaded);
  check('503 → ต้องขยับไปลองโมเดลถัดไป ไม่ใช่เลิกทั้งคำขอ', c.tryNextModel);
  check('503 → ไม่ถูกนับเป็นโควตาเต็มหรือคำขอผิด', !c.rateLimited && !c.badRequest);

  check('500 → ขยับไปโมเดลถัดไปได้เหมือนกัน', classifyGeminiError(CASES.serverError).tryNextModel);

  const q = classifyGeminiError(CASES.quota);
  check('429 โควตาเต็ม → rateLimited + ขยับต่อได้', q.rateLimited && q.tryNextModel);
  check('429 → ไม่ถูกจับเป็น overloaded', !q.overloaded);

  const b = classifyGeminiError(CASES.badArg);
  check('400 คำขอไม่ผ่าน → badRequest + ขยับต่อได้', b.badRequest && b.tryNextModel);
  check('404 ไม่มีโมเดลนี้ → badRequest + ขยับต่อได้',
    classifyGeminiError(CASES.noModel).badRequest && classifyGeminiError(CASES.noModel).tryNextModel);

  const u = classifyGeminiError(CASES.unknown);
  check('error ที่ไม่รู้จัก → ไม่ขยับต่อ (เด้งขึ้นไปให้เห็นของจริง)', !u.tryNextModel);

  check('ไม่มี status ก็ยังจับจากข้อความได้',
    classifyGeminiError({ message: 'The model is overloaded. Please try again later.' }).overloaded);
}

console.log('\nข้อความที่ผู้ใช้เห็น');
{
  const over = friendlyGeminiError(CASES.overloaded);
  check('503 → เป็นภาษาไทย ไม่ใช่ข้อความดิบของ Google', isThai(over) && !over.includes('Spikes in demand'), over);
  check('503 → บอกด้วยว่าไม่ใช่โควตาของร้านหมด', over.includes('ไม่ใช่โควตาของร้านหมด'), over);

  const quota = friendlyGeminiError(CASES.quota);
  check('429 → บอกว่าโควตาเต็ม ไม่ใช่ข้อความของ 503', quota.includes('โควตา AI เต็ม') && !quota.includes('โหลดเต็ม'), quota);

  check('400 → แนะนำให้ล้างบทสนทนา', friendlyGeminiError(CASES.badArg).includes('ล้างบทสนทนา'));
  check('404 → ชี้ไปที่ค่า GEMINI_MODEL', friendlyGeminiError(CASES.noModel).includes('GEMINI_MODEL'));
  check('error ที่ไม่รู้จัก → ส่งข้อความเดิมออกไปตรง ๆ ไม่กลบของจริง',
    friendlyGeminiError(CASES.unknown) === CASES.unknown.message);
  check('ไม่มีข้อความเลย → ไม่คืนค่าว่าง', friendlyGeminiError({}) === 'เกิดข้อผิดพลาดที่ไม่รู้จัก');
}

/* ─────────── จำลองลูป fallback ใน pages/api/ai-chat.js ─────────── */
console.log('\nลำดับการลองโมเดล (จำลองลูปใน ai-chat)');
{
  const CHAIN = ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'];
  /** @param {(model:string)=>void} attempt โยน error เพื่อจำลองความล้มเหลว */
  const runChain = (attempt) => {
    const tried = [];
    let lastErr = null;
    for (const model of CHAIN) {
      tried.push(model);
      try { attempt(model); return { ok: true, tried, model }; }
      catch (e) {
        lastErr = Object.assign(e, classifyGeminiError(e));
        if (e.tryNextModel) continue;
        break;
      }
    }
    return { ok: false, tried, error: friendlyGeminiError(lastErr) };
  };

  // โมเดลแรกโหลดเต็ม ตัวที่สองว่าง — ต้องได้คำตอบโดยผู้ใช้ไม่เห็น error เลย
  const r1 = runChain((m) => { if (m === CHAIN[0]) throw Object.assign(new Error(CASES.overloaded.message), { status: 503 }); });
  check('โมเดลแรก 503 → ไปต่อตัวที่สองแล้วสำเร็จ', r1.ok && r1.model === CHAIN[1], JSON.stringify(r1.tried));

  // โหลดเต็มทั้งสามตัว — ค่อยขึ้นข้อความไทยให้ผู้ใช้
  const r2 = runChain(() => { throw Object.assign(new Error(CASES.overloaded.message), { status: 503 }); });
  check('503 ทั้งสามตัว → ลองครบทุกตัวก่อนยอมแพ้', !r2.ok && r2.tried.length === 3, JSON.stringify(r2.tried));
  check('503 ทั้งสามตัว → ผู้ใช้เห็นข้อความไทย', isThai(r2.error) && !r2.error.includes('Spikes in demand'));

  // error ที่ไม่รู้จัก — ต้องหยุดทันที ไม่ไล่ยิงทุกโมเดลให้เปลืองโควตา
  const r3 = runChain(() => { throw Object.assign(new Error('บึ้ม'), { status: 418 }); });
  check('error ที่ไม่รู้จัก → หยุดที่โมเดลแรก ไม่ไล่ยิงต่อ', !r3.ok && r3.tried.length === 1);
}

console.log(`\n${fails.length ? '❌' : '✅'} ผ่าน ${pass} ข้อ · ไม่ผ่าน ${fails.length} ข้อ`);
if (fails.length) { fails.forEach(f => console.log(`   - ${f}`)); process.exit(1); }
