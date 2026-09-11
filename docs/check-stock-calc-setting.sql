/* ตรวจว่าคอลัมน์ "ค่าตั้งเบิก" ในหน้าภาพรวมสต๊อกว่างเพราะอะไร
   (ค่าเฉลี่ยต่อหัว / ค่าเติมเต็มสตอค ตั้งจากหน้านับสต๊อกของสาขา ระบบ Narai-branch)

   รันบนเครื่องออฟฟิศ: SSMS -> เปิดไฟล์นี้ -> กด Execute
   ทีละข้อ อ่านผลแล้วดูว่าตกข้อไหน                                              */

USE InventoryNarai;
GO

/* ---- ข้อ 1: ตารางมีอยู่ไหม ----
   ไม่มีแถว = ยังไม่ได้รันสคีมาของ Narai-branch บนเครื่องนี้ (คอลัมน์จะว่างทุกสาขา) */
SELECT N'1. ตาราง' AS step,
       CASE WHEN OBJECT_ID(N'dbo.stock_avg_per_head', N'U') IS NULL
            THEN N'ไม่มีตาราง stock_avg_per_head' ELSE N'มีตาราง' END AS result;
GO

/* ---- ข้อ 2: สาขาไหนตั้งค่าไว้แล้วบ้าง ----
   ไม่มีแถวของสาขาที่เปิดดู = สาขานั้นยังไม่เคยตั้งค่าตั้งเบิก (คอลัมน์ว่างถูกแล้ว)
   avg_rows = จำนวนที่ตั้งค่าเฉลี่ยต่อหัว · par_rows = จำนวนที่ติ๊กเป็นเติมเต็มสตอค */
SELECT branch,
       COUNT(*)                                                  AS total_rows,
       SUM(CASE WHEN avg_qty > 0 THEN 1 ELSE 0 END)              AS avg_rows,
       SUM(CASE WHEN calc_mode = N'par' THEN 1 ELSE 0 END)       AS par_rows,
       SUM(CASE WHEN par_qty IS NOT NULL THEN 1 ELSE 0 END)      AS par_value_rows
  FROM dbo.stock_avg_per_head
 GROUP BY branch
 ORDER BY branch;
GO

/* ---- ข้อ 3: รหัสสินค้าจับคู่กับทะเบียนสินค้าติดไหม ----
   แก้ @branch เป็นสาขาที่เปิดดูอยู่ (ตัวพิมพ์เล็ก เช่น crm)
   คอลัมน์ matched ต้องเป็น 'จับคู่ได้' ถ้าขึ้น 'ไม่เจอในทะเบียนสินค้า' แปลว่า key ไม่ตรงกัน */
DECLARE @branch NVARCHAR(50) = N'crm';

SELECT TOP (30)
       a.branch, a.item_key, a.item_code, a.item_name,
       a.calc_mode, a.avg_qty, a.par_qty,
       CASE WHEN i.item_key IS NULL THEN N'ไม่เจอในทะเบียนสินค้า' ELSE N'จับคู่ได้' END AS matched,
       CASE WHEN b.branch  IS NULL THEN N'ไม่ได้ผูกกับสาขานี้'   ELSE N'อยู่ในสาขานี้' END AS in_branch
  FROM dbo.stock_avg_per_head a
  LEFT JOIN dbo.stock_item i         ON i.item_key = a.item_key
  LEFT JOIN dbo.stock_item_branch b  ON b.item_key = a.item_key AND b.branch = @branch
 WHERE a.branch = @branch
 ORDER BY a.item_code;
GO
