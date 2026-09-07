import { useEffect } from 'react';
import '../styles/globals.css';
import { Toaster } from 'react-hot-toast';

/**
 * ตั๋วเข้าระบบหมดอายุระหว่างเปิดหน้าค้างไว้ → /api/* จะเริ่มตอบ 401 (ดู middleware.js)
 * ถ้าปล่อยไว้ แต่ละหน้าจะขึ้น error คนละแบบว่าโหลดข้อมูลไม่ได้ ทั้งที่สาเหตุเดียวกัน
 * ครอบ fetch ไว้ที่เดียวตรงนี้ เจอ 401 เมื่อไหร่ก็โหลดหน้าใหม่ แล้ว pages/index.js
 * จะพาไปหน้าล็อกอินเอง (โหลดใหม่ไม่วน เพราะหน้าล็อกอินเรียกแค่ /api/auth ซึ่งตอบ 200 เสมอ)
 */
function useLogoutOn401() {
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const res = await original(...args);
      if (res.status === 401) {
        const url = String(args[0]?.url || args[0] || '');
        if (url.includes('/api/')) window.location.reload();
      }
      return res;
    };
    return () => { window.fetch = original; };
  }, []);
}

export default function App({ Component, pageProps }) {
  useLogoutOn401();
  return (
    <>
      <Component {...pageProps} />
      <Toaster position="top-right" />
    </>
  );
}
