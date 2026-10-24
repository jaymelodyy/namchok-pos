// =====================================================================
// seed-demo.mjs — ข้อมูล "เดโมปลอม" สำหรับทดสอบหน้าจอบนเครื่องเท่านั้น
//   * ราคา / ระยะประกัน / ลูกค้า / ทะเบียนรถทั้งหมด "ประดิษฐ์ขึ้น" — ไม่ใช่ข้อมูลของร้านจริง
//   * ห้ามนำไปรวมกับ supabase/seed.sql และห้ามรันกับฐานข้อมูลจริง (สคริปต์ปฏิเสธถ้าชื่อ DB ไม่ลงท้าย _demo)
// รัน: node tools/dev-api/seed-demo.mjs   (ต้องสร้างฐาน namchok_demo ด้วย migration + seed มาก่อน)
// =====================================================================
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DB = process.env.DEMO_DB ?? 'namchok_demo';
if (!DB.endsWith('_demo')) { console.error('ปฏิเสธ: ชื่อฐานข้อมูลต้องลงท้ายด้วย _demo'); process.exit(1); }

const c = new pg.Client({
  host: process.env.PGHOST ?? '127.0.0.1', port: Number(process.env.PGPORT ?? 54329),
  user: process.env.PGUSER ?? 'postgres', password: process.env.PGPASSWORD, database: DB,
});
await c.connect();

const USERS = [
  ['11111111-1111-4111-8111-111111111111', 'owner@demo.local', 'คุณเจ (เจ้าของ)', 'owner'],
  ['22222222-2222-4222-8222-222222222222', 'admin@demo.local', 'น้องแอดมิน', 'admin'],
  ['33333333-3333-4333-8333-333333333333', 'tech@demo.local', 'ช่างหนึ่ง', 'technician'],
  ['55555555-5555-4555-8555-555555555555', 'tech2@demo.local', 'ช่างสอง', 'technician'],
  ['44444444-4444-4444-8444-444444444444', 'stock@demo.local', 'พี่สต๊อก', 'warehouse'],
];
const branch = (await c.query("select id from branches where code = 'NTW'")).rows[0].id;
for (const [id, email, name, role] of USERS) {
  await c.query('insert into auth.users(id, email) values ($1, $2) on conflict (id) do nothing', [id, email]);
  await c.query('insert into users(id, branch_id, full_name, role) values ($1, $2, $3, $4) on conflict (id) do nothing', [id, branch, name, role]);
}

const U = { owner: USERS[0][0], admin: USERS[1][0], tech: USERS[2][0], tech2: USERS[3][0], stock: USERS[4][0] };

// ---- ราคาปลอม (ตัวเลขสมมติเพื่อดูหน้าจอ) ----
const FAKE = {
  'AC-CL-001': 1200, 'AC-CL-002': 600, 'AC-CL-003': 150, 'AC-CL-004': 350, 'AC-DG-001': 300, 'AC-DG-002': 400,
  'AC-EL-001': 800, 'AC-EL-002': 600, 'AC-EL-003': 700, 'AC-EL-004': 300, 'AC-RF-001': 200, 'AC-RF-002': 300,
  'AC-RF-003': 150, 'AC-RF-004': 900, 'AC-RP-001': 1500, 'AC-RP-002': 1000, 'AC-RP-003': 3500, 'AC-RP-004': 500,
  'AC-RP-005': 300, 'AC-RP-006': 600, 'BT-CK-001': 150, 'BT-CK-002': 100, 'BT-RP-001': 100,
  'FM-EX-001': 800, 'FM-EX-002': 700, 'OT-FE-001': 500, 'OT-FE-002': 400,
  'PT-AC-001': 7800, 'PT-AC-002': 3200, 'PT-AC-003': 4200, 'PT-AC-004': 650, 'PT-AC-005': 450, 'PT-AC-006': 900,
  'PT-BT-001': 2400, 'PT-CN-001': 450, 'PT-CN-002': 250, 'PT-CN-003': 350, 'PT-CN-004': 60,
};
const FILM_BASE = { 'FM-HK-001': 9000, 'FM-IR-001': 6500, 'FM-NS-001': 4200 };
const SIZE_X = { sedan: 1, suv: 1.25, pickup_cab: 0.9, pickup_4door: 1.15, van: 1.4 };
const POS_X = { full: 1, front: 0.3, side: 0.45, rear: 0.25, roof: 0.2 };

const items = (await c.query('select id, code, item_type from catalog_items')).rows;
for (const it of items) {
  if (it.item_type === 'discount') continue;
  if (FILM_BASE[it.code]) {
    const ps = (await c.query('select id, position, vehicle_size from item_prices where item_id = $1', [it.id])).rows;
    for (const p of ps) {
      const v = Math.round((FILM_BASE[it.code] * SIZE_X[p.vehicle_size] * POS_X[p.position]) / 100) * 100;
      await c.query('update item_prices set price = $2 where id = $1', [p.id, v]);
    }
  } else if (FAKE[it.code] !== undefined) {
    await c.query('update item_prices set price = $2 where item_id = $1', [it.id, Math.round(FAKE[it.code])]);
  }
}
// ระยะประกันปลอม (ค่าจริงเจ้าของต้องกรอกเอง)
await c.query("update catalog_items set warranty_months = 60 where code like 'FM-%' and code <> 'FM-EX-001' and code <> 'FM-EX-002'");
await c.query("update catalog_items set warranty_months = 12 where code in ('PT-BT-001','PT-AC-001')");
await c.query("update catalog_items set warranty_months = 6 where code in ('AC-RP-001','AC-RP-003','PT-AC-002','PT-AC-003')");
// ค่าแรงช่างปลอม (ค่าจริงเจ้าของต้องกรอกเอง): ต่อ 1 หน่วยของรายการ ÷ จำนวนช่างที่ทำจริง
for (const [code, labor, crew] of [['AC-RF-001', 150, 1], ['AC-DG-001', 100, 1], ['AC-DG-002', 150, 2], ['AC-CL-001', 400, 2], ['AC-CL-004', 100, 1],
  ['AC-RP-001', 600, 2], ['BT-RP-001', 50, 1], ['FM-HK-001', 800, 2], ['FM-IR-001', 600, 2], ['FM-NS-001', 500, 2]]) {
  await c.query('update catalog_items set labor_rate = $2, crew_size = $3 where code = $1', [code, labor, crew]);
}
await c.query(`update branch_settings set discount_cap_percent = 10, tax_id = '0000000000000',
  shop_address = '(ที่อยู่ตัวอย่าง) อ.นาทวี จ.สงขลา', shop_phone = '000-000-0000',
  receipt_footer = 'DEMO — ข้อมูลทดสอบ ไม่ใช่ราคาและข้อมูลจริงของร้าน' where branch_id = $1`, [branch]);

// ---- ใบงานตัวอย่าง (ผ่าน RPC จริง ในบทบาทของแต่ละคน) ----
async function asUser(uid, fn) {
  await c.query('begin');
  try {
    await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
    const r = await fn((sql, args) => c.query(sql, args));
    await c.query('commit');
    return r;
  } catch (e) { await c.query('rollback'); throw e; }
}
const asOwner = (fn) => asUser(U.owner, fn);
const rpc = (q, name, args) => {
  const keys = Object.keys(args);
  return q(`select to_json(${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})) j`,
    keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))).then((r) => r.rows[0].j);
};

// ---- ไฟล์ตัวอย่าง (รูปเช็คสภาพ + ลายเซ็น) ให้ dev-api เสิร์ฟ ----
const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = path.resolve(process.env.DEV_FILES ?? path.join(here, '.data/files'), 'job-files');
const filesToRegister = [];
function demoImages() {
  const dir = path.join(FILES, '_demo'); fs.mkdirSync(dir, { recursive: true });
  execFileSync('python3', ['-I', '-c', `
from PIL import Image, ImageDraw
import sys
d = sys.argv[1]
im = Image.new('RGB', (800, 600), (38, 34, 26)); g = ImageDraw.Draw(im)
for y in range(600): g.line([(0, y), (800, y)], fill=(38 + y // 12, 34 + y // 14, 26 + y // 20))
g.rectangle([60, 60, 740, 540], outline=(210, 166, 64), width=4); g.text((90, 90), 'DEMO PHOTO', fill=(240, 213, 138))
im.save(d + '/photo.jpg', quality=70)
sg = Image.new('RGB', (600, 240), (255, 255, 255)); s = ImageDraw.Draw(sg)
s.line([(40, 170), (110, 60), (150, 190), (220, 70), (260, 180), (360, 100), (450, 170), (560, 80)], fill=(20, 20, 20), width=5)
sg.save(d + '/sig.png')
`, dir]);
}
demoImages();
const BR = branch;
async function completeChecks(q, id) {
  const reqs = (await q('select * from job_required_checks($1)', [id])).rows;
  for (const r of reqs) {
    const tpl = (await q('select checklist from condition_templates where id = $1', [r.template_id])).rows[0].checklist;
    const answers = Object.fromEntries(tpl.map((it) => [it.key, { state: 'ok' }]));
    const checkId = await rpc(q, 'save_condition_check', { p_job_id: id, p_template_id: r.template_id, p_answers: answers });
    for (let n = 1; n <= Math.max(1, r.min_photos); n++) {
      const p = `${BR}/${id}/photo/demo-${r.template_id.slice(0, 4)}-${n}.jpg`;
      await rpc(q, 'add_condition_photo', { p_check_id: checkId, p_path: p, p_caption: 'ตัวอย่าง' });
      filesToRegister.push([p, 'photo.jpg']);
    }
    const sp = `${BR}/${id}/signature/${r.template_id.slice(0, 4)}.png`;
    filesToRegister.push([sp, 'sig.png']);
    await rpc(q, 'complete_condition_check', { p_check_id: checkId, p_signature_path: sp, p_signed_by: 'ลูกค้าตัวอย่าง' });
  }
}
const itemId = (code) => items.find((i) => i.code === code).id;

// ---- ตัวช่วยขยับใบงานตามบทบาทจริง ----
const as = (uid, name, args) => asUser(uid, (q) => rpc(q, name, args));
/** คลังจัดเตรียม+ส่งมอบคำขอเบิกทุกใบที่ค้าง แล้วแอดมินกดไป "พร้อมทำ" ถ้ายังไม่ไป */
async function deliverParts(id) {
  const open = (await c.query("select id from requisitions where job_id = $1 and status in ('requested','prepared') order by created_at", [id])).rows;
  for (const r of open) { await as(U.stock, 'advance_requisition', { p_req_id: r.id }); await as(U.stock, 'advance_requisition', { p_req_id: r.id }); }
  const st = (await c.query('select status from job_orders where id = $1', [id])).rows[0].status;
  if (st === 'requisition') await as(U.admin, 'advance_job', { p_job_id: id });
}
async function newJob(plate, prov, brand, model, year, name, phone, src, complaint) {
  const j = await as(U.admin, 'open_job', { p_plate: plate, p_plate_province: prov, p_brand: brand, p_model: model, p_year: year, p_customer_name: name, p_phone: phone, p_source: src, p_complaint: complaint });
  return j.id ?? j;
}
const BATTERY = { 'ยี่ห้อ': 'GS', 'รุ่น': 'NS60 (ตัวอย่าง)', 'ขนาด': '45Ah' };
const addItem = (id, code, qty = 1) => as(U.admin, 'add_job_item', {
  p_job_id: id, p_item_id: itemId(code), p_qty: qty, ...(code === 'BT-RP-001' || code === 'PT-BT-001' ? { p_attributes: BATTERY } : {}),
});
async function toQuoting(id) {
  await as(U.admin, 'advance_job', { p_job_id: id });            // → condition_check
  await asUser(U.admin, (q) => completeChecks(q, id));
  await as(U.admin, 'advance_job', { p_job_id: id });            // → quoting
}
const QC_OK = { work_done: true, function_ok: true, clean: true, no_new_damage: true };

// 1) ใบงานที่ปิดแล้ว (เปิด VAT ราคารวมแล้ว + ช่างสองคน) เพื่อให้ค้นประวัติจากทะเบียน / ดูใบเสร็จ / ค่าแรงได้
await c.query('update branch_settings set vat_enabled = true where branch_id = $1', [branch]);
{
  const id = await newJob('กษ 4821', 'สงขลา', 'Toyota', 'Fortuner', 2018, 'คุณสมชาย (ตัวอย่าง)', '0800000001', 'line', 'แอร์ไม่เย็น มีเสียงดังตอนเปิดแอร์');
  await addItem(id, 'AC-RF-001'); await addItem(id, 'PT-CN-001'); await addItem(id, 'AC-CL-001');
  await toQuoting(id);
  await as(U.admin, 'approve_quote', { p_job_id: id });
  await deliverParts(id);
  await as(U.tech, 'accept_job', { p_job_id: id });
  await as(U.tech2, 'accept_job', { p_job_id: id });
  await as(U.tech, 'advance_job', { p_job_id: id });             // → in_progress
  await as(U.tech, 'advance_job', { p_job_id: id });             // → qc
  await as(U.admin, 'qc_pass', { p_job_id: id, p_answers: QC_OK, p_note: 'ตรวจแล้วเรียบร้อย' });
  const total = (await c.query('select balance from v_job_totals where job_id = $1', [id])).rows[0].balance;
  await as(U.admin, 'record_payment', { p_job_id: id, p_kind: 'payment', p_method: 'cash', p_amount: total });
  await as(U.admin, 'close_job', { p_job_id: id });
  console.log('ใบงานที่ปิดแล้ว:', id, 'ยอด', total);
}
await c.query('update branch_settings set vat_enabled = false where branch_id = $1', [branch]);

// 2) ใบงานค้างอยู่หลายสถานะ เพื่อดูหน้ารายการ / บอร์ด / หน้าช่าง / หน้าคลัง
const specs = [
  // [ทะเบียน, จังหวัด, ยี่ห้อ, รุ่น, ปี, ลูกค้า, โทร, ช่องทาง, อาการ, ขั้นที่ไปถึง]
  ['1กข 2468', 'กรุงเทพมหานคร', 'Honda', 'Civic', 2020, 'คุณนิดา (ตัวอย่าง)', '0800000002', 'facebook_ads', 'แอร์มีกลิ่นอับ', 'opened'],
  ['ขจ 7733', 'สงขลา', 'Isuzu', 'D-Max', 2016, 'คุณประสิทธิ์ (ตัวอย่าง)', '0800000003', 'walk_in', 'ฟิล์มเดิมลอก อยากติดใหม่', 'condition_check'],
  ['3ฒญ 5590', 'ปัตตานี', 'Mazda', 'CX-5', 2022, 'คุณอรทัย (ตัวอย่าง)', '0800000004', 'returning', 'แบตเตอรี่อ่อน สตาร์ทติดยาก', 'quoting'],
  ['กค 1199', 'สงขลา', 'Toyota', 'Hilux Revo', 2019, 'คุณวิชัย (ตัวอย่าง)', '0800000005', 'walk_in', 'แอร์ไม่เย็น ต้องเติมน้ำยาและเปลี่ยนไดเออร์', 'requisition'],
  ['นพ 3021', 'สงขลา', 'Nissan', 'Almera', 2021, 'คุณมาลี (ตัวอย่าง)', '0800000006', 'line', 'ล้างตู้แอร์ + ฆ่าเชื้อ', 'ready'],
  ['ฆง 8842', 'สตูล', 'Suzuki', 'Swift', 2017, 'คุณบุญเลิศ (ตัวอย่าง)', '0800000007', 'returning', 'เติมน้ำยาแอร์ + ตรวจรั่ว', 'in_progress'],
  ['2ขท 6610', 'สงขลา', 'Mitsubishi', 'Triton', 2020, 'คุณปรีชา (ตัวอย่าง)', '0800000008', 'facebook_ads', 'เปลี่ยนแบตเตอรี่', 'qc'],
];
const itemsFor = {
  opened: [], condition_check: [['AC-DG-001']], quoting: [['AC-DG-001'], ['BT-RP-001'], ['PT-BT-001']],
  requisition: [['AC-RF-001'], ['PT-CN-001'], ['PT-AC-005'], ['AC-RP-005']],
  ready: [['AC-CL-001'], ['AC-CL-004']],
  in_progress: [['AC-RF-001'], ['PT-CN-001'], ['AC-DG-001']],
  qc: [['BT-RP-001'], ['PT-BT-001']],
};
const jobIds = {};
for (const [plate, prov, brand, model, year, name, phone, src, complaint, upTo] of specs) {
  const id = await newJob(plate, prov, brand, model, year, name, phone, src, complaint);
  jobIds[upTo] = id;
  for (const [code, qty] of itemsFor[upTo]) await addItem(id, code, qty ?? 1);
  if (upTo === 'opened') continue;
  if (upTo === 'condition_check') { await as(U.admin, 'advance_job', { p_job_id: id }); continue; }
  await toQuoting(id);
  if (upTo === 'quoting') continue;
  await as(U.admin, 'approve_quote', { p_job_id: id });
  if (upTo === 'requisition') continue;           // คำขอเบิกอยู่สถานะ "ขอเบิก" ให้คลังเห็น
  await deliverParts(id);
  if (upTo === 'ready') continue;                  // พร้อมทำ — ช่างยังไม่มีใครรับ (มี 2 ที่ว่าง)
  if (upTo === 'in_progress') {                    // ช่างหนึ่งกำลังทำอยู่
    await as(U.tech, 'accept_job', { p_job_id: id }); await as(U.tech, 'advance_job', { p_job_id: id }); continue;
  }
  await as(U.tech2, 'accept_job', { p_job_id: id }); // รอ QC — ช่างสองส่งงานแล้ว
  await as(U.tech2, 'advance_job', { p_job_id: id });
  await as(U.tech2, 'advance_job', { p_job_id: id }); // → qc
}

// 3) ใบงานสำหรับสคริปต์ทดสอบเฟส 2 (tools/e2e/p2-*.mjs) — แต่ละใบมีหน้าที่เฉพาะ
{
  // A: รออนุมัติราคา มีอะไหล่ → ทดสอบ "อนุมัติ → คำขอเบิกเด้งที่คลังทันที"
  const a = await newJob('กข 6001', 'สงขลา', 'Toyota', 'Yaris', 2021, 'คุณทดสอบเรียลไทม์ (ตัวอย่าง)', '0800000011', 'line', 'แอร์ไม่เย็น ต้องเติมน้ำยา');
  await addItem(a, 'AC-RF-001'); await addItem(a, 'PT-CN-001'); await toQuoting(a);
  // B: พร้อมทำ ต้องการช่าง 1 คน → ทดสอบ "ช่าง 2 คนกดรับพร้อมกัน"
  const b = await newJob('กข 6002', 'สงขลา', 'Honda', 'City', 2019, 'คุณทดสอบรับงาน (ตัวอย่าง)', '0800000012', 'walk_in', 'ดับกลิ่นแอร์');
  await addItem(b, 'AC-CL-004'); await toQuoting(b); await as(U.admin, 'approve_quote', { p_job_id: b }); await deliverParts(b);
  // C: เสนอราคา + รับมัดจำ 500 → ทดสอบคืนเงิน/ยกเลิก
  const c = await newJob('กข 6004', 'สงขลา', 'Mazda', 'Mazda2', 2020, 'คุณทดสอบคืนเงิน (ตัวอย่าง)', '0800000013', 'facebook_ads', 'ลูกค้าอาจยกเลิกงาน');
  await addItem(c, 'AC-DG-001'); await addItem(c, 'AC-CL-001'); await toQuoting(c);   // ยอดบิล 300 + 1,200 = 1,500 (มัดจำต้องไม่เกินยอดบิล)
  await as(U.admin, 'record_payment', { p_job_id: c, p_kind: 'deposit', p_method: 'cash', p_amount: 500 });
}

for (const [p, src] of filesToRegister) {
  const dest = path.join(FILES, p); fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(FILES, '_demo', src), dest);
  await c.query('insert into storage.objects(bucket_id, name) values ($1, $2)', ['job-files', p]);
}
const counts = (await c.query('select status, count(*) from job_orders group by 1 order by 1')).rows;
console.log('เดโมพร้อม — ใบงานตามสถานะ:', JSON.stringify(counts));
await c.end();
