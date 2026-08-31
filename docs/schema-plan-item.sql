/* ============================================================================
   ทะเบียนไอเทมหมวดแพลน (หน้า จัดซื้อ → แพลนสินค้า → จัดการรายการ)
   ฐานข้อมูล InventoryNarai — ตัวเดียวกับที่ QC/RD, ทะเบียนสาขา และหน้านับสต๊อกใช้อยู่

   ตารางนี้เก็บแค่ "รายชื่อรหัสสินค้าที่นับเป็นหมวดแพลน" ไม่ได้เก็บยอดสั่งของ
   ยอดสั่งจริงอ่านสดจาก POS (myfbdata.orderd) ทุกครั้ง — ดู lib/planLive.js

   วิธีรัน (บนเครื่องที่ต่อ SQL Server ได้):
     sqlcmd -S localhost\SQLEXPRESS -U sa -P '<รหัสผ่าน>' -i docs\schema-plan-item.sql
   หรือกดปุ่ม "สร้างตาราง" ในหน้าจัดการรายการ (ต้องให้ login มีสิทธิ์ db_ddladmin)
   รันซ้ำได้ ไม่ทับข้อมูลเดิม

   หมายเหตุการออกแบบ
   ---------------------------------------------------------------------------
   1) item_code เก็บแบบ "ตัด 0 นำหน้าออกแล้ว" เสมอ เพราะฝั่ง POS เก็บมาไม่เหมือนกันทุกแถว
      (บางแถว 011000265 บางแถว 11000265) ถ้าเก็บดิบ ๆ จะจับคู่ไม่เจอ
      ตัวแปลงอยู่ที่ normItemCode ใน lib/planItems.js — ฝั่งเว็บกับฝั่งนี้ต้องใช้ตัวเดียวกัน
   2) ไม่ผูก foreign key ไปตารางสินค้าใด ๆ เพราะรายการสินค้าอยู่ฝั่ง POS (คนละฐาน คนละเครื่อง)
      รหัสที่ยังไม่เคยมีใบสั่งจึงใส่ไว้ล่วงหน้าได้ ไม่ต้องรอให้สาขาสั่งก่อน
   3) status = 'active' | 'inactive' — เลิกใช้ให้ปิดสถานะไว้ ไม่ต้องลบทิ้ง
      จะได้ยังรู้ว่าเคยอยู่ในแพลนช่วงไหน (ลบจริงก็ทำได้จากหน้าเว็บ)
   4) ข้อมูลตั้งต้นไม่ได้อยู่ในไฟล์นี้ — ปุ่ม "สร้างตาราง" จะหยอดรายการตั้งต้นจาก
      PLAN_ITEMS ใน lib/planItems.js ให้เอง เก็บรายชื่อไว้ที่เดียวจะได้ไม่หลุดกัน
   ============================================================================ */

IF OBJECT_ID(N'dbo.plan_item', N'U') IS NULL
CREATE TABLE dbo.plan_item (
    item_code   VARCHAR(32)   NOT NULL,
    item_name   NVARCHAR(200) NULL,
    status      VARCHAR(16)   NOT NULL CONSTRAINT DF_plan_item_status  DEFAULT ('active'),
    note        NVARCHAR(400) NULL,
    sort_order  INT           NOT NULL CONSTRAINT DF_plan_item_sort    DEFAULT (0),
    created_at  DATETIME2(0)  NOT NULL CONSTRAINT DF_plan_item_created DEFAULT (SYSDATETIME()),
    updated_at  DATETIME2(0)  NOT NULL CONSTRAINT DF_plan_item_updated DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_plan_item PRIMARY KEY (item_code)
);
GO
