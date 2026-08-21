/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // /api/qcrd-migrate อ่าน docs/schema-qcrd.sql ตอนรัน (step=schema)
  // ตัวไล่หา dependency ของ Next มองไม่เห็น path ที่ประกอบขึ้นตอนรัน จึงต้องสั่งแนบไฟล์เอง
  // ไม่งั้นบน Vercel จะขึ้น ENOENT ทั้งที่ไฟล์อยู่ในรีโป
  experimental: {
    outputFileTracingIncludes: {
      '/api/qcrd-migrate': ['./docs/schema-qcrd.sql'],
    },
  },
};
module.exports = nextConfig;
