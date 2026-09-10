/* ============================================================================
   แก้ปัญหาดึงยอดขายช้า — สร้าง index ให้ตรงกับคอลัมน์ที่ query ใช้กรองจริง

   ⚠️⚠️ ต้องรันตอน "ปิดร้าน" เท่านั้น ⚠️⚠️
   SQL Server Express สร้าง index แบบ ONLINE ไม่ได้ ระหว่างสร้าง "ตารางจะถูกล็อก"
   ทำตอนร้านเปิด = POS ทุกสาขาขายไม่ได้จนกว่าจะเสร็จ

   ที่มา (วัดจากเครื่องจริง NARAI-PIZZARIA\SQLEXPRESS):
     - /cpaidbetweendate ขอข้อมูลวันเดียว ใช้เวลา 125 วินาที
     - dbo.Cpaid  341,018 แถว — ไม่มี index บน [Date] เลย (มีแต่ PK ที่เรียงตาม OutletID)
     - dbo.Ctrans 7,506,397 แถว — มี index บน StartTime แต่ query กรองด้วย PostTime
                                   index ที่มีจึงใช้ไม่ได้ ต้องสแกน 7.5 ล้านแถว
     - เครื่อง 2 คอร์ / RAM 4 GB / Express แคชได้ ~1.4 GB แต่ฐานใหญ่ 4.6 GB
       สแกนทีไรต้องอ่านดิสก์ใหม่หมด แคชช่วยไม่ได้

   วิธีรัน (เลือกทางใดทางหนึ่ง):
     ก) ไม่ต้องเปิด SSMS — ที่เครื่องออฟฟิศ เปิด PowerShell ที่โฟลเดอร์รีโปแล้วรัน
          powershell -ExecutionPolicy Bypass -File .\scripts\fix-sales-index.ps1
        ตัวสคริปต์เช็กให้ว่ามี index หรือยัง สร้างเฉพาะ Cpaid (ขั้น 1 — เร็ว เสี่ยงน้อย)
        แล้วจับเวลาก่อน/หลังให้ดู ; ขั้น Ctrans ต้องสั่ง -Ctrans เองตอนปิดร้าน
     ข) เปิดไฟล์นี้ใน SSMS แล้วรันทีละบล็อก (อย่ารันรวดเดียว จะได้คุมเวลาเองได้)
   ============================================================================ */
USE NaraiPos;
GO

/* ══════════ ขั้น 0: เช็กก่อนลงมือ ══════════ */

/* recovery model — ถ้าเป็น FULL และไม่ได้ backup log ประจำ การสร้าง index จะทำให้ log โต
   ตอนนี้ log 264 MB ถ้าโตพรวดจนดิสก์เต็ม POS จะเขียนไม่ได้ ดูค่าก่อนแล้วค่อยตัดสินใจ */
SELECT name, recovery_model_desc, log_reuse_wait_desc
FROM sys.databases WHERE name = 'NaraiPos';

/* ที่ว่างในดิสก์ที่ไฟล์ฐานอยู่ */
SELECT DISTINCT
    vs.volume_mount_point,
    vs.total_bytes  / 1024 / 1024 AS total_mb,
    vs.available_bytes / 1024 / 1024 AS free_mb
FROM sys.master_files mf
CROSS APPLY sys.dm_os_volume_stats(mf.database_id, mf.file_id) vs
WHERE mf.database_id = DB_ID('NaraiPos');
GO

/* จับเวลา "ก่อนแก้" ไว้เทียบ (เปลี่ยนวันที่เป็นวันที่มีข้อมูลจริง) */
SET STATISTICS TIME ON;
SELECT COUNT(*) AS n FROM dbo.Cpaid
WHERE [Date] >= '2026-09-09 00:00:00' AND [Date] <= '2026-09-09 23:59:59';
SELECT COUNT(*) AS n FROM dbo.Ctrans
WHERE PostTime >= '2026-09-09 00:00:00' AND PostTime <= '2026-09-09 23:59:59';
SET STATISTICS TIME OFF;
GO


/* ══════════ ขั้น 1: Cpaid (เล็ก เสี่ยงน้อย ทำก่อน) ══════════
   341,018 แถว — น่าจะเสร็จในไม่กี่วินาที ล็อกสั้นมาก
   ทำขั้นนี้ก่อนแล้ววัดผล ถ้าหน้ายอดขายดีขึ้นชัดเจนค่อยไปขั้น 2 */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_Cpaid_Date' AND object_id = OBJECT_ID('dbo.Cpaid'))
BEGIN
    PRINT N'กำลังสร้าง IX_Cpaid_Date ...';
    CREATE NONCLUSTERED INDEX IX_Cpaid_Date ON dbo.Cpaid ([Date]);
    PRINT N'เสร็จ';
END
ELSE PRINT N'IX_Cpaid_Date มีอยู่แล้ว ข้าม';
GO


/* ══════════ ขั้น 2: Ctrans (ใหญ่ 7.5 ล้านแถว — ตัวที่ต้องระวังที่สุด) ══════════
   ⚠️ ล็อกตารางนานหลายนาที · ตารางนี้คือที่ POS เขียนรายการขายลงทุกบิล
      ห้ามรันตอนร้านเปิดเด็ดขาด
   ⚠️ กินที่เพิ่มราว 150-250 MB */
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = 'IX_Ctrans_PostTime' AND object_id = OBJECT_ID('dbo.Ctrans'))
BEGIN
    PRINT N'กำลังสร้าง IX_Ctrans_PostTime (อาจใช้เวลาหลายนาที) ...';
    CREATE NONCLUSTERED INDEX IX_Ctrans_PostTime ON dbo.Ctrans (PostTime);
    PRINT N'เสร็จ';
END
ELSE PRINT N'IX_Ctrans_PostTime มีอยู่แล้ว ข้าม';
GO


/* ══════════ ขั้น 3: วัดผลหลังแก้ (ต้องเร็วขึ้นชัดเจน) ══════════ */
SET STATISTICS TIME ON;
SELECT COUNT(*) AS n FROM dbo.Cpaid
WHERE [Date] >= '2026-09-09 00:00:00' AND [Date] <= '2026-09-09 23:59:59';
SELECT COUNT(*) AS n FROM dbo.Ctrans
WHERE PostTime >= '2026-09-09 00:00:00' AND PostTime <= '2026-09-09 23:59:59';
SET STATISTICS TIME OFF;
GO


/* ══════════ ถ้าต้องถอยกลับ ══════════
   index ไม่แก้ข้อมูลสักแถว ลบทิ้งได้ทันทีถ้าไม่ชอบ (ลบเร็วกว่าสร้างมาก)

   DROP INDEX IX_Cpaid_Date ON dbo.Cpaid;
   DROP INDEX IX_Ctrans_PostTime ON dbo.Ctrans;
   ============================================================================ */
