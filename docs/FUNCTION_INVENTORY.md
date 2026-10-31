# รายการฟังก์ชันเดิม (Function Inventory)

ใช้ตรวจว่าการปรับดีไซน์ (prompt ข้อ A) และงานช่างหลายคน (ข้อ C) ไม่ทำให้ฟังก์ชันเดิมหายหรือเสีย
อัปเดต: 2026-10-31 บน branch `feat/ui-refresh`

**ผลตรวจหมายถึงอะไร**

- **ผ่าน (DB)** = ทดสอบระดับฐานข้อมูลด้วยบทบาทจริงใน `supabase/tests/run.mjs` (119/119 ผ่าน บน Postgres 16 ในเครื่องทดสอบ) — ระบุกลุ่มทดสอบ
- **ผ่าน (จอ)** = ทดสอบผ่านหน้าจอจริงด้วย Playwright ใน `tools/e2e/` บนฐานข้อมูลเดโม + dev-api (ตัวจำลอง Supabase) — ระบุสคริปต์
- **ยังไม่ได้ทดสอบ** = ยังไม่มีหลักฐานจากการรันจริง
- ทุกข้อ **ไม่ได้** ทดสอบกับ Supabase Auth/Realtime ตัวจริง และไม่ได้ทดสอบบนมือถือจริง

## หน้าจอ (routes)

| รหัส | ฟังก์ชันเดิม | ไฟล์ | บทบาทที่ใช้ | ผลตรวจ |
|---|---|---|---|---|
| R01 | เข้าสู่ระบบ | `app/login/page.tsx` | ทุกบทบาท | ผ่าน (จอ) ทุกสคริปต์ |
| R02 | หน้าแรก: ค้นทะเบียน + เปิดใบงานใหม่ + ประวัติรถ | `app/(app)/page.tsx` | owner, admin | ผ่าน (จอ) open-job, full-flow, fix-province-photos ; ผ่าน (DB) กลุ่ม 3 |
| R03 | บอร์ดใบงาน + ค้นหา + ปุ่ม "เปิดใบงานใหม่" | `app/(app)/jobs/page.tsx`, `components/job-board.tsx` | owner, admin | ผ่าน (จอ) p2-realtime, audit |
| R04 | รายละเอียดใบงาน + แถบปุ่มติดล่าง | `app/(app)/jobs/[id]/page.tsx` | ทุกบทบาท (เห็นตามสิทธิ์) | ผ่าน (จอ) full-flow, flow-2, flow-3, flow-5, flow-6, p2-* |
| R05 | มุมมอง 2 คอลัมน์บนจอคอม (รายการซ้าย + รายละเอียดขวา) — **ใหม่** | `app/(app)/jobs/[id]/layout.tsx`, `components/job-side-list.tsx` | owner, admin (จอ ≥1280px) | ผ่าน (จอ) สคริปต์ตรวจจอ 1440/390px นอก repo ; ไม่มีสคริปต์ใน `tools/e2e` |
| R06 | เช็คสภาพรถ (ฟอร์ม รูป ลายเซ็น) | `app/(app)/jobs/[id]/check/[tpl]/page.tsx` | owner, admin | ผ่าน (จอ) full-flow, fix-province-photos ; ผ่าน (DB) กลุ่ม 5 |
| R07 | ใบเสร็จ / ใบรับประกัน (พิมพ์) | `app/(app)/jobs/[id]/receipt/page.tsx` | owner, admin | ผ่าน (จอ) flow-5, p2-qc-close, audit ; ผ่าน (DB) กลุ่ม 6, 16 |
| R08 | งานของช่าง: รับงาน / เข้าร่วม / ค้นทะเบียน | `app/(app)/work/page.tsx` | technician | ผ่าน (จอ) p2-accept-race, p2-visibility, p2-realtime ; ผ่าน (DB) กลุ่ม 11, 17 |
| R09 | เบิกอะไหล่ (คลัง) | `app/(app)/requisitions/page.tsx` | owner, admin, storekeeper | ผ่าน (DB) กลุ่ม 12 ; หน้าจอ: audit เปิดหน้าได้เท่านั้น ยังไม่ได้ทดสอบการกดผ่านจอ |
| R10 | ค่าแรงช่าง (จ่าย/ยกเลิกจ่าย) | `app/(app)/labor/page.tsx` | owner, technician (เห็นของตัวเอง) | ผ่าน (จอ) p2-qc-close, p2-visibility ; ผ่าน (DB) กลุ่ม 14 |
| R11 | รายงานรายได้ / VAT / คืนเงิน | `app/(app)/reports/page.tsx` | owner | ผ่าน (จอ) audit, p2-visibility ; ผ่าน (DB) กลุ่ม 8, 9, 16 |
| R12 | ตั้งค่า + ผู้ใช้ + audit log + ลิงก์แคตตาล็อก (มือถือ) | `app/(app)/settings/page.tsx` | owner | หน้าจอ: audit เปิดหน้าได้ ; ผ่าน (DB) กลุ่ม 7, 10 ; ยังไม่ได้ทดสอบการแก้ค่าผ่านจอ |
| R13 | แคตตาล็อก (แก้ราคา/เพิ่มรายการ) | `app/(app)/catalog/page.tsx` | owner | ผ่าน (DB) กลุ่ม 2 ; หน้าจอ: audit เปิดหน้าได้เท่านั้น |
| R14 | เมนูล่าง ≤5 ปุ่มต่อบทบาท / เมนูข้างบนคอม | `components/app-shell.tsx` | ทุกบทบาท | ผ่าน (จอ) audit (เมนูตามบทบาท, ไม่มี horizontal scroll ที่ 320/360/390px) |
| R15 | แจ้งเตือนเรียลไทม์ (toast + สั่น) | `components/live-notifier.tsx` | ทุกบทบาท | ช่องทาง realtime ผ่าน (จอ) p2-realtime (ตัวจำลอง) ; **แจ้งเตือน "ถูกมอบหมาย/ถูกเอาออก" ของช่าง (ใหม่) ยังไม่ได้ทดสอบ** ; ทำงานเฉพาะตอนเปิดแอปอยู่ |

## ฟังก์ชันข้อมูล (`lib/api.ts`)

| รหัส | ฟังก์ชัน | ใช้ทำอะไร | ผลตรวจ |
|---|---|---|---|
| A01 | `loadProfile`, `loadSettings`, `saveSettings` | โปรไฟล์ผู้ใช้ / ค่าร้าน | ผ่าน (DB) กลุ่ม 10 ; `saveSettings` ผ่านจอ: ยังไม่ได้ทดสอบ |
| A02 | `listUsers`, `listAudit` | ผู้ใช้ / ประวัติการแก้ไข | ผ่าน (DB) กลุ่ม 7, 10 |
| A03 | `searchVehicles`, `openJob` | ค้นทะเบียน, เปิดใบงาน | ผ่าน (DB) กลุ่ม 3 ; ผ่าน (จอ) open-job |
| A04 | `listJobs`, `loadBoardData`, `loadWorkData`, `loadJob` | โหลดบอร์ด / งานช่าง / ใบงาน | ผ่าน (จอ) ทุก flow |
| A05 | `addItem`, `setItemPrice`, `setItemQty`, `removeItem`, `approveDiscounts` | รายการในใบงาน ราคา ส่วนลด | ผ่าน (DB) กลุ่ม 4 ; ผ่าน (จอ) flow-2, flow-3 |
| A06 | `loadCatalog`, `updateItemPrice`, `updateCatalogItem`, `createCatalogItem`, `invalidateCatalog` | แคตตาล็อก | ผ่าน (DB) กลุ่ม 2 |
| A07 | `loadTemplate`, `loadCheck`, `saveCheck`, `addCheckPhoto`, `completeCheck`, `reopenCheck` | เช็คสภาพรถ | ผ่าน (DB) กลุ่ม 5 ; ผ่าน (จอ) full-flow, fix-province-photos |
| A08 | `uploadFile`, `signedUrls` | รูป / สลิป | ผ่าน (จอ) full-flow, flow-5 (storage ของ dev-api ไม่ใช่ Supabase Storage จริง) |
| A09 | `advanceJob`, `approveQuote`, `revertJob`, `cancelJob`, `voidJob`, `closeJob`, `setDeliveryDate` | state machine ใบงาน | ผ่าน (DB) กลุ่ม 5, 6, 7, 16 ; ผ่าน (จอ) flow-3, flow-5, flow-6, p2-qc-close, p2-refund |
| A10 | `qcPass`, `qcFail`, `qcChecklist` | QC | ผ่าน (DB) กลุ่ม 13 ; ผ่าน (จอ) p2-qc-close |
| A11 | `acceptJob`, `releaseJob` | ช่างรับงาน / ถอนตัว (ไม่จำกัดจำนวนคน ตาม 0012) | ผ่าน (DB) กลุ่ม 11, 17 ; ผ่าน (จอ) p2-accept-race |
| A12 | `assignTechnician`, `removeTechnician`, `setJobCrew`, `addJobCrew`, `setCrewRequired`, `jobCrewInfo`, `technicianBoard` | มอบหมายช่างหลายคน | ผ่าน (DB) กลุ่ม 17 ; ผ่าน (จอ) p2-realtime, p2-visibility |
| A13 | `listRequisitions`, `advanceRequisition`, `revertRequisition`, `cancelRequisition` | เบิกอะไหล่ | ผ่าน (DB) กลุ่ม 12 ; ผ่านจอ: ยังไม่ได้ทดสอบ |
| A14 | `listLabor`, `markLaborPaid`, `unmarkLaborPaid` | ค่าแรงช่าง | ผ่าน (DB) กลุ่ม 14 ; ผ่าน (จอ) p2-qc-close |
| A15 | `recordPayment`, `voidPayment` | รับเงิน (หลายแบบ/มัดจำ) | ผ่าน (DB) กลุ่ม 6 ; ผ่าน (จอ) flow-5, p2-payment-live |
| A16 | `refundPayment`, `voidRefund` | คืนเงิน / คืนมัดจำ | ผ่าน (DB) กลุ่ม 15 ; ผ่าน (จอ) p2-refund |
| A17 | `revenueReport`, `vatSummary`, `refundsInRange`, `paymentsInRange` | รายงาน | ผ่าน (DB) กลุ่ม 8, 9, 16 ; ผ่าน (จอ) audit |
| A18 | `msSinceOwnWrite` | กันแจ้งเตือนซ้ำจากการกดของตัวเอง | ยังไม่ได้ทดสอบแยก (ใช้อยู่ใน p2-realtime โดยอ้อม) |

## ชื่อช่าง (prompt ข้อ B)

ชื่อช่างมาจากตาราง `profiles.full_name` ที่เดียว (ช่างหนุ่ม / ช่างกิ้ม / ช่างริด / ช่างวี) — migration 0011 ลงบน Supabase จริงแล้ว

## ที่ยังไม่ครอบคลุม (ต้องตรวจด้วยมือบนเครื่องจริง)

1. แจ้งเตือนช่างเมื่อถูกมอบหมาย/ถูกเอาออก (R15) — ลองโดยให้ admin มอบหมายช่าง แล้วดูจอช่างที่เปิดแอปอยู่
2. หน้าเบิกอะไหล่ ตั้งค่า แคตตาล็อก — กดใช้งานผ่านจอ
3. Supabase Auth / Realtime / Storage ตัวจริง และมือถือจริง (iOS Safari / Android Chrome)
