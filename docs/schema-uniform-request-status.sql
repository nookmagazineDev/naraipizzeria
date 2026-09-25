-- สถานะใบขอเบิกยูนิฟอร์ม (หน้า HR → ยูนิฟอร์ม → การ์ด "ขอเบิกยูนิฟอร์ม")
-- ฐาน InventoryNarai — ผูกกับ dbo.stock_request ด้วย request_id
--
-- ไม่ต้องรันเองก็ได้: กดอนุมัติครั้งแรกบนหน้าเว็บ ระบบสร้างตารางนี้ให้เอง (lib/uniformSql.mjs)
-- รันเองเมื่อ login ของแดชบอร์ดไม่มีสิทธิ์ CREATE TABLE (รันซ้ำได้ ไม่ทับข้อมูลเดิม)
--
-- ไม่มีแถว = รออนุมัติ · status: waiting_order = อนุมัติแล้ว รอสั่งสินค้า · shipping = อนุมัติแล้ว กำลังจัดส่ง
IF OBJECT_ID('dbo.uniform_request_status', 'U') IS NULL
CREATE TABLE dbo.uniform_request_status (
  request_id  BIGINT        NOT NULL PRIMARY KEY,
  status      NVARCHAR(20)  NOT NULL,
  updated_by  NVARCHAR(100) NULL,
  updated_at  DATETIME2(0)  NOT NULL CONSTRAINT DF_uniform_request_status_updated_at DEFAULT SYSDATETIME()
);
