# ใครเป็นเจ้าของ hostname ไหน (Cloudflare Tunnel)

> เขียนหลังเหตุการณ์ 22 ก.ย. 2026: หน้ายอดรายวันขึ้น "ไม่พบข้อมูล" ทั้งที่ฐานมีบิลครบทุกวัน
> ใช้เวลาไล่หลายชั่วโมงเพราะทุกชั้นดู "ปกติ" หมด — ต้นเหตุคือ hostname ถูก tunnel อื่นยึดไป

## กติกาข้อเดียวที่ต้องจำ

**หนึ่ง hostname ผูกกับ tunnel ได้ตัวเดียว** เมื่อสร้าง tunnel ใหม่แล้วใส่ Public hostname ซ้ำชื่อเดิม
Cloudflare จะ **เขียนทับ DNS record ให้ชี้ไป tunnel ใหม่ทันที ไม่มีคำเตือน**

ของเดิมไม่มีอะไรแสดงอาการเลย:

- tunnel เก่ายังขึ้น **Healthy** uptime เดินต่อปกติ
- แท็บ Routes ยังลิสต์ `api.khanoykorshabu.com → http://localhost:14365` ครบ
  (เพราะมันอ่านจาก config ในเครื่อง ซึ่งไม่ได้ถูกแก้) — แต่ **ไม่มี traffic วิ่งเข้ามาแล้ว**
- ปลายทางใหม่เป็น host-server ก๊อปปี้อีกชุด ตอบ 200 ทุกคำขอ ไม่มี error สักตัว

## ทะเบียนชื่อ (อัปเดตทุกครั้งที่เพิ่ม/ย้าย hostname)

| Hostname | Tunnel | Service | ใครใช้ |
|---|---|---|---|
| `api.khanoykorshabu.com` | `narai` (เครื่อง Narai-Pizzaria) | `http://localhost:14365` | แดชบอร์ดออฟฟิศ — `STORE_API_BASE` บน Vercel |
| `usage.khanoykorshabu.com` | `narai` | `http://localhost:8787` | `/usagemenu`, `/usagebytable` |
| `pos-api.khanoykorshabu.com` | `narai` | `http://localhost:8080` | API ของอีกระบบบนเครื่องเดียวกัน |

⚠️ โปรเจกต์อื่นที่ต้องเปิดออกเน็ตจากเครื่องเดียวกัน **ต้องตั้งชื่อของตัวเอง** เช่น
`humlai-api.khanoykorshabu.com` ห้ามใช้ชื่อในตารางนี้ซ้ำเด็ดขาด

## ตรวจใน 10 วินาทีว่าโดเมนยังชี้มาถูกที่

```powershell
Invoke-RestMethod https://api.khanoykorshabu.com/pos/latest
```

ต้องได้ `host = Narai-Pizzaria`, `dbName = NaraiPos`, `totalBills` ตรงกับที่ SSMS นับได้
`/pos/latest` มีเฉพาะ host-server ของรีโปนี้ (ดู `host-server/server.js`) เซิร์ฟเวอร์ชุดอื่น
จะตอบ `Cannot GET /pos/latest` — ปลอมไม่ได้ ต่างจาก `/sheets/ping` หรือ `/tables` ที่ก๊อปปี้
ชุดอื่นตอบเหมือนกันเป๊ะได้ ถ้ามันต่อฐาน InventoryNarai ตัวเดียวกัน (เคยหลอกเรามาแล้ว)

เทียบสองทางเมื่อสงสัย:

```powershell
curl.exe -s http://localhost:14365/pos/latest          # host-server ตัวจริงที่เครื่องร้าน
curl.exe -s https://api.khanoykorshabu.com/pos/latest  # สิ่งที่ Vercel เห็นจริง ๆ
```

ต่างกัน = โดเมนไม่ได้วิ่งมาที่เครื่องนี้ ไม่ต้องไปไล่ฐานข้อมูลหรือโค้ดหน้าเว็บให้เสียเวลา

## เอา hostname ที่ถูกยึดกลับคืน

1. **ปลดออกจาก tunnel ที่ยึดไปก่อน** — Zero Trust → Networks → Tunnels → tunnel ตัวใหม่ →
   Public Hostname → ลบแถวที่ชื่อซ้ำ แล้วตั้งชื่อใหม่ให้มัน
   (ข้ามขั้นนี้แล้วไปแก้ DNS เลย จะโดนยึดคืนรอบหน้าที่มีคนแก้ tunnel นั้น)
2. **ชี้ DNS กลับ** — หา UUID ของ tunnel `narai` จากไฟล์ config ที่เครื่อง:
   ```powershell
   Get-Content C:\ProgramData\cloudflared\*.yml
   Get-Content "$env:USERPROFILE\.cloudflared\config.yml"
   ```
   บรรทัด `tunnel: <uuid>` คือค่าที่ต้องใช้ แล้วตั้งที่ DNS → Records:
   `api` · CNAME · `<uuid>.cfargotunnel.com` · Proxied
3. **ยืนยัน** ด้วยคำสั่งตรวจ 10 วินาทีข้างบน

## ทางลัดฉุกเฉิน (ใช้ระหว่างรอแก้ DNS)

```powershell
Remove-Item Env:PORT -ErrorAction SilentlyContinue
cd C:\naraipizzeria\host-server
powershell -ExecutionPolicy Bypass -File .\start-narai.ps1     # ไม่ใส่ -NoTunnel = เปิด quick tunnel
```

เอา URL `https://xxxx.trycloudflare.com` ที่ได้ไปตั้งเป็น `STORE_API_BASE` บน Vercel แล้ว Redeploy
ยอดขายกลับมาทันที — แต่ URL เปลี่ยนทุกครั้งที่เปิดใหม่ ใช้ประคองเท่านั้น พอ DNS กลับมาถูกแล้ว
ให้ตั้ง `STORE_API_BASE` กลับเป็น `https://api.khanoykorshabu.com`

## ไทม์ไลน์ของเหตุการณ์ (ไว้จำว่าอาการหน้าตาเป็นยังไง)

| สิ่งที่เห็น | ตีความผิดว่า | ความจริง |
|---|---|---|
| หน้ายอดรายวัน "ไม่พบข้อมูลของช่วง 2026-09-21" | ฐานไม่มีข้อมูล / POS ไม่ส่งบิล | โดเมนไปคุยกับเซิร์ฟเวอร์คนละตัว |
| `/cpaidbetweendate` ผ่านโดเมน = `{"data":[]}` สถานะ 200 | ช่วงวันนั้นไม่มีบิลจริง | ปลายทางอีกชุดตอบ ฐานคนละตัว |
| `/sheets/ping` ผ่านโดเมน ตัวเลขตรงกับ localhost เป๊ะ | ต้องเป็นเซิร์ฟเวอร์ตัวเดียวกันแน่ ๆ | ก๊อปปี้อีกชุดที่ต่อ InventoryNarai ร่วมกัน |
| `/tables` ทั้งสองทางได้ 8 ตารางเท่ากัน | ฐานเดียวกัน | ฐาน InventoryNarai ร่วมกัน แต่ฐาน POS คนละตัว |
| tunnel `narai` Healthy · Routes ชี้ `localhost:14365` | เส้นทางถูกแล้ว | DNS ชี้ไป tunnel อื่น route จึงไม่ถูกใช้ |
| ดึงทั้งเดือนได้ข้อมูลบางวัน | ข้อมูลหายเป็นช่วง ๆ | ฐานของอีกชุดมีข้อมูลบางวัน |

บทเรียน: **เมื่อ "ข้อมูลหาย" ให้ถามก่อนว่าคำขอไปถึงเครื่องไหน** อย่าเพิ่งไปไล่ฐานหรือโค้ด —
เส้น `/pos/latest` มีไว้ตอบคำถามนั้นข้อเดียว
