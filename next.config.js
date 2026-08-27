/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // /api/qcrd-migrate, /api/sheets-migrate และ /api/branches อ่านไฟล์สคีมาจากรีโปตอนรัน
  // ตัวไล่หา dependency ของ Next มองไม่เห็น path ที่ประกอบขึ้นตอนรัน จึงต้องสั่งแนบไฟล์เอง
  // ไม่งั้นบน Vercel จะขึ้น ENOENT ทั้งที่ไฟล์อยู่ในรีโป
  experimental: {
    outputFileTracingIncludes: {
      '/api/qcrd-migrate': ['./docs/schema-qcrd.sql'],
      '/api/sheets-migrate': ['./docs/schema-sheets.sql'],
      '/api/branches': ['./docs/schema-hr-branch.sql'],
    },
  },
};
module.exports = nextConfig;
