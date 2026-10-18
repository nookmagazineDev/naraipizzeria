/* ============================================================================
   เมนู ACC > ค้นหาสมาชิก — index บน Cpaid.MemberTel ให้ค้นทั้งฐานได้ในไม่ถึงวินาที

   ไม่สร้างก็ใช้ได้ แต่ทุกครั้งที่เปิดรายชื่อสมาชิก/กดดูบิลของสมาชิก SQL ต้องอ่าน Cpaid ทั้งตาราง
   (ราว 3.4 แสนแถว) บนเครื่องที่แรมน้อยกว่าขนาดฐาน = อ่านดิสก์ใหม่แทบทุกครั้ง

   ตาราง Cpaid เล็ก — สร้างเสร็จในไม่กี่วินาที ล็อกสั้นมาก (แบบเดียวกับ IX_Cpaid_Date
   ใน docs/fix-slow-sales-index.sql) แต่ถ้าทำได้ ทำตอนร้านปิดจะสบายใจที่สุด

   วิธีรัน: เปิด SSMS ที่เครื่องออฟฟิศ → New Query → วางทั้งไฟล์ → Execute (F5) — รันซ้ำได้
   รายการในบิล (Ctrans) ไม่ต้องสร้าง index เพิ่ม — ค้นผ่าน StartTime ซึ่งมี index อยู่แล้ว
   ============================================================================ */
USE NaraiPos;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_Cpaid_MemberTel' AND object_id = OBJECT_ID('dbo.Cpaid'))
BEGIN
    PRINT N'กำลังสร้าง IX_Cpaid_MemberTel ...';
    CREATE NONCLUSTERED INDEX IX_Cpaid_MemberTel ON dbo.Cpaid ([MemberTel])
        INCLUDE ([BillTotal], [Date], [OutletID]);
    PRINT N'เสร็จ';
END
ELSE PRINT N'IX_Cpaid_MemberTel มีอยู่แล้ว ข้าม';
GO

/* เช็กผล: ต้องเห็นแถว IX_Cpaid_MemberTel */
SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.Cpaid');
GO

/* ถอยกลับ (index ไม่แก้ข้อมูล ลบทิ้งได้ทันที):
   DROP INDEX IX_Cpaid_MemberTel ON dbo.Cpaid;  */
