// ทดสอบ migration + RLS + RPC บน Postgres จริง
//   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=... node supabase/tests/run.mjs
// สร้างฐานข้อมูลชื่อ namchok_test ใหม่ทุกครั้ง (drop ของเดิมทิ้ง) — ห้ามชี้ไปที่ฐานข้อมูลจริง
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const DB = 'namchok_test';
const base = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 54329),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD,
};
const files = [
  'supabase/tests/00_supabase_stub.sql',
  'supabase/migrations/0001_schema.sql',
  'supabase/migrations/0002_rls.sql',
  'supabase/migrations/0003_rpc.sql',
  'supabase/migrations/0004_storage.sql',
  'supabase/migrations/0005_hide_money_from_non_finance.sql',
  'supabase/migrations/0006_phase2_amendments.sql',
  'supabase/migrations/0007_assignments_requisitions.sql',
  'supabase/migrations/0008_qc_labor.sql',
  'supabase/migrations/0009_realtime.sql',
  'supabase/migrations/0010_multi_technician_assignment.sql',
  'supabase/migrations/0011_owner_crew_control.sql',
  'supabase/seed.sql',
];

// ---------- mini test framework ----------
const results = [];
let currentGroup = '';
function group(name) { currentGroup = name; console.log(`\n# ${name}`); }
async function test(name, fn) {
  try {
    await fn();
    results.push({ group: currentGroup, name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ group: currentGroup, name, ok: false, err: e });
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}
function eq(actual, expected, msg = '') {
  const a = typeof actual === 'object' ? JSON.stringify(actual) : String(actual);
  const b = typeof expected === 'object' ? JSON.stringify(expected) : String(expected);
  if (a !== b) throw new Error(`${msg} expected ${b} but got ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
async function rejects(p, re, msg = '') {
  try { await p; } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`${msg} error message mismatch: got "${e.message}" want ${re}`);
    return e;
  }
  throw new Error(`${msg} expected an error ${re ?? ''} but the call succeeded`);
}

// ---------- DB helpers ----------
let sup; // superuser connection (setup + inspection)
async function connect() {
  const c = new pg.Client({ ...base, database: DB });
  await c.connect();
  return c;
}
/** รัน SQL เป็นผู้ใช้ (role authenticated + jwt sub) ใน transaction เดียว */
async function as(client, uid, sql, params = []) {
  await client.query('begin');
  try {
    await client.query(`set local role ${uid === 'anon' ? 'anon' : 'authenticated'}`);
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [uid === 'anon' ? '' : uid]);
    const r = await client.query(sql, params);
    await client.query('commit');
    return r;
  } catch (e) {
    await client.query('rollback');
    throw e;
  }
}
const sq = (sql, params) => sup.query(sql, params).then((r) => r.rows);
const one = async (sql, params) => (await sq(sql, params))[0];

/** เรียก RPC แบบ named args : rpc(uid,'open_job',{p_plate:'..'}) */
async function rpc(uid, fn, args = {}, { table = false, client = sup } = {}) {
  const keys = Object.keys(args);
  const placeholders = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k]));
  const sql = table ? `select * from ${fn}(${placeholders})` : `select ${fn}(${placeholders}) as r`;
  const r = await as(client, uid, sql, vals);
  return table ? r.rows : r.rows[0].r;
}

// ---------- fixtures ----------
const U = {}; // userId by name
let B;        // branch id
const ids = {}; // item ids by code
async function item(code) {
  if (!ids[code]) ids[code] = (await one('select id from catalog_items where code = $1', [code])).id;
  return ids[code];
}
async function setPrice(code, price, extra = {}) {
  await sq(`update item_prices set price = $2 where item_id = (select id from catalog_items where code = $1)
            and position is null and vehicle_size is null`, [code, price]);
  if (extra.warranty) await sq('update catalog_items set warranty_months = $2 where code = $1', [code, extra.warranty]);
}
const today = async () => (await one("select (now() at time zone 'Asia/Bangkok')::date::text as d")).d;
const jobTotals = (jobId) => one('select * from v_job_totals where job_id = $1', [jobId]);
const photoPath = (jobId, n = 1) => `${B}/${jobId}/photo/${n}.jpg`;
const sigPath = (jobId) => `${B}/${jobId}/signature/sig.png`;

/** ทำเช็คสภาพให้ครบทุกแบบฟอร์มที่ต้องใช้ (ช่างเป็นคนทำ) */
async function completeAllChecks(jobId, uid = U.tech) {
  const req = await rpc(U.admin, 'job_required_checks', { p_job: jobId }, { table: true });
  for (const r of req) {
    if (r.completed) continue;
    const tpl = await one('select checklist from condition_templates where id = $1', [r.template_id]);
    const answers = Object.fromEntries(tpl.checklist.map((i) => [i.key, { state: 'ok' }]));
    const checkId = await rpc(uid, 'save_condition_check', { p_job_id: jobId, p_template_id: r.template_id, p_answers: answers });
    if (Number(r.photo_count) < r.min_photos) {
      await rpc(uid, 'add_condition_photo', { p_check_id: checkId, p_path: photoPath(jobId, Math.random().toString(36).slice(2)), p_caption: 'ทดสอบ' });
    }
    await rpc(uid, 'complete_condition_check', { p_check_id: checkId, p_signature_path: sigPath(jobId), p_signed_by: 'ลูกค้าทดสอบ' });
  }
}

async function newJob(plate, extra = {}) {
  return rpc(U.admin, 'open_job', {
    p_plate: plate, p_plate_province: 'สงขลา', p_brand: 'Toyota', p_model: 'Vios', p_year: 2015, p_odometer: 100000,
    p_customer_name: 'ลูกค้าทดสอบ ' + plate, p_phone: null, ...extra,
  });
}
/** คลังจัดเตรียม+ส่งมอบคำขอเบิกทุกใบที่ค้าง ; ถ้าใบงานไม่มีอะไหล่ (ไม่มีคำขอ) แอดมินกดไปขั้น ready เอง */
async function deliverParts(jobId) {
  const open = await sq("select id from requisitions where job_id = $1 and status in ('requested','prepared') order by created_at", [jobId]);
  for (const r of open) {
    await rpc(U.wh, 'advance_requisition', { p_req_id: r.id });   // requested → prepared
    await rpc(U.wh, 'advance_requisition', { p_req_id: r.id });   // prepared → delivered
  }
  if ((await statusOf(jobId)) === 'requisition') await rpc(U.admin, 'advance_job', { p_job_id: jobId });
}
const QC_OK = { work_done: true, function_ok: true, clean: true, no_new_damage: true };
/** ตั้งแต่ quoting อนุมัติ → ส่งมอบอะไหล่ → ช่างรับงาน → เริ่ม → ส่ง QC (หยุดที่ qc) */
async function driveToQc(jobId, tech = U.tech) {
  await rpc(U.admin, 'approve_quote', { p_job_id: jobId });
  await deliverParts(jobId);
  await rpc(tech, 'accept_job', { p_job_id: jobId });
  await rpc(tech, 'advance_job', { p_job_id: jobId });   // in_progress
  await rpc(tech, 'advance_job', { p_job_id: jobId });   // qc
}
async function statusOf(jobId) { return (await one('select status from job_orders where id = $1', [jobId])).status; }

// =====================================================================
async function main() {
  // ---- สร้างฐานข้อมูลใหม่ + apply migration ทั้งหมด ----
  const admin = new pg.Client({ ...base, database: 'postgres' });
  await admin.connect();
  await admin.query(`drop database if exists ${DB} with (force)`);
  await admin.query(`create database ${DB}`);
  await admin.end();
  sup = await connect();
  for (const f of files) {
    try { await sup.query(fs.readFileSync(path.join(root, f), 'utf8')); }
    catch (e) { console.error(`✗ apply ${f}: ${e.message}`); process.exit(2); }
  }
  console.log(`apply ${files.length} ไฟล์สำเร็จ (stub + 9 migrations + seed)`);

  B = (await one("select id from branches where code = 'NTW'")).id;
  const B2 = (await one("insert into branches(code, name) values ('HYT','สาขาหาดใหญ่ (ทดสอบ)') returning id")).id;
  async function mkUser(name, role, branch = B) {
    const u = await one('insert into auth.users(email) values ($1) returning id', [`${name}@test.local`]);
    await sq('insert into users(id, branch_id, full_name, role) values ($1,$2,$3,$4)', [u.id, branch, name, role]);
    U[name] = u.id;
  }
  await mkUser('owner', 'owner'); await mkUser('admin', 'admin'); await mkUser('ช่าง 1', 'technician');
  await mkUser('wh', 'warehouse'); await mkUser('owner2', 'owner', B2);
  await mkUser('ช่าง 2', 'technician'); await mkUser('ช่าง 3', 'technician'); U.tech = U['ช่าง 1']; U.tech2 = U['ช่าง 2']; U.tech3 = U['ช่าง 3'];
  // จำลองบัญชีช่างคนที่ 4 ตามโปร덕ชัน (README: สร้างด้วย SQL บน Supabase จริง ไม่ใช่ seed)
  await sq("insert into auth.users(id, email) values ('00000000-0000-4000-8000-000000000004', 'tech4@test.local')");
  await sq("insert into users(id, branch_id, full_name, role) values ('00000000-0000-4000-8000-000000000004', $1, 'ช่าง 4', 'technician')", [B]);
  U.tech4 = '00000000-0000-4000-8000-000000000004';

  // =====================================================================
  group('1. Seed / โครงหมวดหมู่');
  await test('หมวดหลัก 5 + หมวดย่อย 17', async () => {
    eq((await one('select count(*)::int c from catalog_categories where parent_id is null')).c, 5);
    eq((await one('select count(*)::int c from catalog_categories where parent_id is not null')).c, 17);
  });
  await test('รหัสรายการไม่ซ้ำ และขึ้นต้นด้วยรหัสหมวดย่อยของตัวเองทุกรายการ', async () => {
    eq((await one('select count(*)::int c from (select code from catalog_items group by code having count(*)>1) x')).c, 0);
    eq((await one(`select count(*)::int c from catalog_items i join catalog_categories c on c.id = i.category_id
                    where i.code not like c.code || '-%'`)).c, 0);
  });
  await test('ทุกรายการอยู่ในหมวดย่อย (ไม่ใช่หมวดหลัก) หมวดเดียว', async () => {
    eq((await one(`select count(*)::int c from catalog_items i join catalog_categories c on c.id = i.category_id
                    where c.parent_id is null`)).c, 0);
  });
  await test('ฟิล์ม 3 รุ่น × 25 ตัวเลือก (5 ตำแหน่ง × 5 ขนาดรถ) ไม่ซ้ำ', async () => {
    const r = await sq(`select i.code, count(*)::int c, count(distinct (p.position, p.vehicle_size))::int d
                          from item_prices p join catalog_items i on i.id = p.item_id
                         where i.code in ('FM-HK-001','FM-IR-001','FM-NS-001') group by i.code order by 1`);
    eq(r.map((x) => [x.c, x.d]), [[25, 25], [25, 25], [25, 25]]);
  });
  await test('ไม่มีการแต่งราคา: ทุกราคา = 0 และ warranty_months ว่างทั้งหมด', async () => {
    eq((await one('select count(*)::int c from item_prices where price <> 0 or cost <> 0')).c, 0);
    eq((await one('select count(*)::int c from catalog_items where warranty_months is not null')).c, 0);
  });
  await test('OT-DP (มัดจำ) ไม่มีรายการ ; ส่วนลดอยู่ OT-DC เท่านั้น', async () => {
    eq((await one("select count(*)::int c from catalog_items i join catalog_categories c on c.id=i.category_id where c.code='OT-DP'")).c, 0);
    eq((await one("select count(*)::int c from catalog_items i join catalog_categories c on c.id=i.category_id where i.item_type='discount' and c.code <> 'OT-DC'")).c, 0);
  });
  await test('seed รันซ้ำได้ (idempotent)', async () => {
    const before = await one('select (select count(*) from catalog_items)::int i, (select count(*) from item_prices)::int p, (select count(*) from catalog_categories)::int c');
    await sup.query(fs.readFileSync(path.join(root, 'supabase/seed.sql'), 'utf8'));
    const after = await one('select (select count(*) from catalog_items)::int i, (select count(*) from item_prices)::int p, (select count(*) from catalog_categories)::int c');
    eq(after, before);
  });

  // =====================================================================
  group('2. กฎแคตตาล็อก (ห้ามมั่ว ห้ามซ้ำ) + สิทธิ์ owner');
  const cat = async (code) => (await one('select id from catalog_categories where code = $1', [code])).id;
  const insItem = (catCode, code, name, type) => sup.query(
    'insert into catalog_items(branch_id, category_id, code, name, item_type) values ($1, (select id from catalog_categories where code=$2), $3, $4, $5)',
    [B, catCode, code, name, type]);
  await test('ห้ามชื่อซ้ำในหมวดย่อยเดียวกัน (ไม่สนช่องว่าง/ตัวพิมพ์)', async () => {
    await rejects(insItem('AC-DG', 'AC-DG-050', '  ตรวจหารอยรั่วระบบแอร์ ', 'service'), /duplicate key|catalog_items_name_uk/);
  });
  await test('ชื่อเดียวกันอยู่คนละหมวดย่อยได้', async () => {
    await insItem('AC-CL', 'AC-CL-050', 'ตรวจหารอยรั่วระบบแอร์', 'service');
  });
  await test('รหัสไม่ตรงกับหมวดย่อย → ปฏิเสธ', async () => {
    await rejects(insItem('AC-DG', 'AC-RP-051', 'ทดสอบ', 'service'), /ไม่ตรงกับหมวดย่อย/);
  });
  await test('รูปแบบรหัสผิด → ปฏิเสธ', async () => {
    await rejects(insItem('AC-DG', 'AC-DG-1', 'ทดสอบ', 'service'), /check constraint/);
  });
  await test('อะไหล่ต้องเป็น part ในหมวด PT เท่านั้น ; ค่าแรงห้ามอยู่หมวด PT', async () => {
    await rejects(insItem('PT-AC', 'PT-AC-050', 'ค่าแรงมั่ว', 'service'), /PT/);
    await rejects(insItem('AC-DG', 'AC-DG-051', 'อะไหล่มั่ว', 'part'), /service หรือ bundle/);
  });
  await test('OT-DC รับเฉพาะ discount, OT-FE รับเฉพาะ fee, OT-DP ห้ามมีรายการ', async () => {
    await rejects(insItem('OT-DC', 'OT-DC-050', 'ทดสอบ', 'fee'), /discount/);
    await rejects(insItem('OT-FE', 'OT-FE-050', 'ทดสอบ', 'service'), /fee/);
    await rejects(insItem('OT-DP', 'OT-DP-001', 'มัดจำ', 'fee'), /มัดจำ/);
  });
  await test('หมวดย่อยต้องรหัสขึ้นต้นด้วยหมวดหลัก ; หมวดย่อยซ้อนหมวดย่อยไม่ได้', async () => {
    await rejects(sup.query(`insert into catalog_categories(branch_id, code, name, parent_id)
      values ($1,'FM-ZZ','x',(select id from catalog_categories where code='AC'))`, [B]), /ขึ้นต้นด้วย/);
    await rejects(sup.query(`insert into catalog_categories(branch_id, code, name, parent_id)
      values ($1,'AC-ZZ','x',(select id from catalog_categories where code='AC-DG'))`, [B]), /หมวดหลักเท่านั้น|ขึ้นต้นด้วย/);
  });
  await test('ห้ามแก้รหัส / ย้ายหมวด / เปลี่ยนประเภทของรายการเดิม', async () => {
    await rejects(sup.query("update catalog_items set code='AC-DG-099' where code='AC-DG-001'"), /ห้ามแก้รหัส/);
    await rejects(sup.query("update catalog_items set category_id=(select id from catalog_categories where code='AC-CL') where code='AC-DG-001'"), /ย้ายหมวดไม่ได้/);
    await rejects(sup.query("update catalog_items set item_type='fee' where code='AC-DG-001'"), /เปลี่ยนประเภท/);
  });
  await test('admin เพิ่ม/แก้แคตตาล็อกตรง ๆ ไม่ได้ (RLS) ; owner ทำได้', async () => {
    await rejects(as(sup, U.admin, `insert into catalog_items(branch_id, category_id, code, name, item_type)
      values ($1,(select id from catalog_categories where code='AC-DG'),'AC-DG-060','x','service')`, [B]), /row-level security/);
    const r = await as(sup, U.admin, "update item_prices set price = 999 where item_id = (select id from catalog_items where code='AC-DG-001')");
    eq(r.rowCount, 0, 'admin update item_prices แล้วต้องไม่มีแถวถูกแก้');
    const r2 = await as(sup, U.owner, "update item_prices set price = 0 where item_id = (select id from catalog_items where code='AC-DG-001')");
    eq(r2.rowCount, 1);
  });
  await test('catalog_create_item: owner เท่านั้น, รันรหัสถัดไปให้เอง, ฟิล์มสร้างตัวเลือก 25 แถว', async () => {
    await rejects(rpc(U.admin, 'catalog_create_item', { p_category_id: await cat('AC-DG'), p_name: 'ทดสอบ', p_item_type: 'service' }), /ไม่มีสิทธิ์/);
    const id1 = await rpc(U.owner, 'catalog_create_item', { p_category_id: await cat('AC-DG'), p_name: 'ตรวจเช็คใหม่', p_item_type: 'service' });
    eq((await one('select code from catalog_items where id=$1', [id1])).code, 'AC-DG-003');
    eq((await one('select count(*)::int c from item_prices where item_id=$1', [id1])).c, 1);
    const id2 = await rpc(U.owner, 'catalog_create_item', { p_category_id: await cat('FM-EX'), p_name: 'ฟิล์มงานเสริมใหม่', p_item_type: 'service', p_with_matrix: true });
    eq((await one('select code from catalog_items where id=$1', [id2])).code, 'FM-EX-003');
    eq((await one('select count(*)::int c from item_prices where item_id=$1', [id2])).c, 25);
    await rejects(rpc(U.owner, 'catalog_create_item', { p_category_id: await cat('AC'), p_name: 'x', p_item_type: 'service' }), /หมวดย่อย/);
  });

  // =====================================================================
  group('3. เปิดใบงานด้วยทะเบียน + ประวัติรถ');
  // ตั้งราคาทดสอบ (ในฐานข้อมูลทดสอบเท่านั้น)
  await setPrice('AC-RP-003', 1200, { warranty: 12 });
  await setPrice('PT-AC-003', 3500, { warranty: 6 });
  await setPrice('AC-CL-001', 800);
  await setPrice('OT-DC-001', 0);
  await setPrice('OT-FE-002', 0);
  await setPrice('BT-RP-001', 300);
  await setPrice('PT-BT-001', 2500, { warranty: 24 });
  await sq("update catalog_items set requires_condition_check = false where code = 'AC-RP-003' and false"); // no-op กัน lint

  let jobA, vehicleA;
  await test('admin เปิดใบงาน walk-in: ได้เลขใบงาน JO-YYYYMMDD-001 สถานะ opened', async () => {
    jobA = await rpc(U.admin, 'open_job', {
      p_plate: 'กข 1234', p_plate_province: 'สงขลา', p_brand: 'Toyota', p_model: 'Vios', p_year: 2015, p_odometer: 120000,
      p_customer_name: 'สมชาย ใจดี', p_phone: '0812345678', p_source: 'walk_in', p_complaint: 'แอร์ไม่เย็น',
    });
    const j = await one('select * from job_orders where id=$1', [jobA]);
    eq(j.status, 'opened');
    ok(/^JO-\d{8}-001$/.test(j.job_no), `job_no ${j.job_no}`);
    vehicleA = j.vehicle_id;
  });
  await test('ทะเบียนเดิม (พิมพ์ต่างรูปแบบ กข-1234) → ใช้รถ/ลูกค้าเดิม เด้งประวัติ 2 ใบงาน', async () => {
    const j2 = await rpc(U.admin, 'open_job', { p_plate: 'กข-1234', p_plate_province: 'สงขลา', p_odometer: 121000, p_phone: '0812345678', p_customer_name: null });
    const row = await one('select vehicle_id, customer_id from job_orders where id=$1', [j2]);
    eq(row.vehicle_id, vehicleA);
    const hist = await as(sup, U.admin, 'select job_no from v_jobs where vehicle_id=$1 order by created_at', [vehicleA]);
    eq(hist.rowCount, 2);
    eq((await one('select count(*)::int c from customers')).c, 1, 'ต้องไม่สร้างลูกค้าซ้ำ');
    eq((await one('select count(*)::int c from vehicles')).c, 1, 'ต้องไม่สร้างรถซ้ำ');
    eq((await one('select last_odometer from vehicles where id=$1', [vehicleA])).last_odometer, 121000);
    await rpc(U.admin, 'cancel_job', { p_job_id: j2, p_reason: 'เปิดซ้ำทดสอบ' });
  });
  await test('ค้นทะเบียนแบบพิมพ์บางส่วน (prefix) ได้ผลทันที', async () => {
    const r = await as(sup, U.admin, "select plate from vehicles where plate_norm like 'กข12%'");
    eq(r.rowCount, 1);
  });
  await test('จองคิว (scheduled_at ในอนาคต) → สถานะ booked แล้วกด "เปิดใบงาน" ไป opened', async () => {
    const jb = await rpc(U.admin, 'open_job', { p_plate: 'งง 9999', p_customer_name: 'คุณจอง', p_scheduled_at: new Date(Date.now() + 86400000).toISOString() });
    eq(await statusOf(jb), 'booked');
    eq(await rpc(U.admin, 'advance_job', { p_job_id: jb }), 'opened');
    await rpc(U.admin, 'cancel_job', { p_job_id: jb, p_reason: 'ทดสอบ' });
  });
  await test('ไม่กรอกทะเบียน/ชื่อลูกค้า → ปฏิเสธ ; technician เปิดใบงานไม่ได้', async () => {
    await rejects(rpc(U.admin, 'open_job', { p_plate: '  ', p_customer_name: 'x' }), /ทะเบียน/);
    await rejects(rpc(U.admin, 'open_job', { p_plate: 'ใหม่ 1', p_customer_name: null }), /ชื่อลูกค้า/);
    await rejects(rpc(U.tech, 'open_job', { p_plate: 'ช่าง 1', p_customer_name: 'x' }), /ไม่มีสิทธิ์/);
  });
  await test('เลขใบงานไม่ซ้ำเมื่อเปิดพร้อมกัน 10 ใบ (คนละ connection)', async () => {
    const clients = await Promise.all(Array.from({ length: 10 }, connect));
    const nos = await Promise.all(clients.map(async (c, i) => {
      const id = await rpc(U.admin, 'open_job', { p_plate: `พร้อม ${i}`, p_customer_name: `ลูกค้า ${i}` }, { client: c });
      return (await one('select job_no from job_orders where id=$1', [id])).job_no;
    }));
    await Promise.all(clients.map((c) => c.end()));
    eq(new Set(nos).size, 10);
  });

  // =====================================================================
  group('4. รายการในใบงาน: ค่าแรง/อะไหล่แยกบรรทัด, ราคา, ส่วนลด, ประเภทตัวเลือก');
  let lineLabor, linePart, lineDiscount;
  await test('เพิ่มค่าแรง + อะไหล่ แยกคนละบรรทัด ; ยอดรวมถูกต้อง', async () => {
    lineLabor = await rpc(U.admin, 'add_job_item', { p_job_id: jobA, p_item_id: await item('AC-RP-003') });
    linePart = await rpc(U.admin, 'add_job_item', { p_job_id: jobA, p_item_id: await item('PT-AC-003') });
    const rows = await sq('select item_type, unit_price::float p, warranty_months w from job_items where job_id=$1 order by sort_order', [jobA]);
    eq(rows, [{ item_type: 'service', p: 1200, w: 12 }, { item_type: 'part', p: 3500, w: 6 }]);
    const t = await jobTotals(jobA);
    eq([Number(t.gross), Number(t.discount), Number(t.net)], [4700, 0, 4700]);
  });
  await test('แก้ราคาจากแคตตาล็อกตอนเพิ่ม ต้องมีเหตุผล', async () => {
    await rejects(rpc(U.admin, 'add_job_item', { p_job_id: jobA, p_item_id: await item('AC-CL-001'), p_unit_price: 700 }), /ต้องระบุเหตุผล/);
    await rpc(U.admin, 'add_job_item', { p_job_id: jobA, p_item_id: await item('AC-CL-001'), p_unit_price: 700, p_reason: 'ลูกค้าประจำ' });
  });
  await test('ส่วนลดต้องมีเหตุผล + เก็บเป็นยอดติดลบ + ลดยอดสุทธิ', async () => {
    await rejects(rpc(U.admin, 'add_job_item', { p_job_id: jobA, p_item_id: await item('OT-DC-001'), p_unit_price: 200 }), /ส่วนลดต้องระบุเหตุผล|ต้องระบุเหตุผล/);
    await rejects(rpc(U.admin, 'add_job_item', { p_job_id: jobA, p_item_id: await item('OT-DC-001') }), /จำนวนเงินส่วนลด/);
    lineDiscount = await rpc(U.admin, 'add_job_item', { p_job_id: jobA, p_item_id: await item('OT-DC-001'), p_unit_price: 200, p_reason: 'ลูกค้าประจำ' });
    eq(Number((await one('select unit_price from job_items where id=$1', [lineDiscount])).unit_price), -200);
    const t = await jobTotals(jobA);
    eq([Number(t.gross), Number(t.discount), Number(t.net), Number(t.grand_total)], [5400, 200, 5200, 5200]);
  });
  await test('รายการที่มีหลายตัวเลือกราคา (ฟิล์ม) ต้องเลือกตัวเลือก ; เลือกแล้วใส่ label ตำแหน่ง·ขนาด', async () => {
    const jf = await newJob('ฟิล์ม 1');
    await rejects(rpc(U.admin, 'add_job_item', { p_job_id: jf, p_item_id: await item('FM-HK-001') }), /หลายตัวเลือกราคา/);
    const pr = await one(`select p.id from item_prices p join catalog_items i on i.id=p.item_id
                           where i.code='FM-HK-001' and p.position='full' and p.vehicle_size='suv'`);
    const l = await rpc(U.admin, 'add_job_item', { p_job_id: jf, p_item_id: await item('FM-HK-001'), p_price_id: pr.id, p_unit_price: 100, p_reason: 'ทดสอบ' });
    eq((await one('select variant_label from job_items where id=$1', [l])).variant_label, 'ทั้งคัน · SUV');
    await rpc(U.admin, 'cancel_job', { p_job_id: jf, p_reason: 'ทดสอบ' });
  });
  await test('แบตเตอรี่: ต้องบันทึกยี่ห้อ/รุ่น/ขนาด ถึงเพิ่มได้', async () => {
    const jb = await newJob('แบต 1');
    await rejects(rpc(U.admin, 'add_job_item', { p_job_id: jb, p_item_id: await item('PT-BT-001') }), /ยี่ห้อ/);
    await rejects(rpc(U.admin, 'add_job_item', { p_job_id: jb, p_item_id: await item('PT-BT-001'), p_attributes: { 'ยี่ห้อ': '3K', 'รุ่น': 'MF55' } }), /ขนาด/);
    const l = await rpc(U.admin, 'add_job_item', { p_job_id: jb, p_item_id: await item('PT-BT-001'), p_attributes: { 'ยี่ห้อ': '3K', 'รุ่น': 'MF55', 'ขนาด': '55D23L' } });
    eq((await one('select attributes from job_items where id=$1', [l])).attributes['ขนาด'], '55D23L');
    await rpc(U.admin, 'cancel_job', { p_job_id: jb, p_reason: 'ทดสอบ' });
  });
  await test('แก้ราคา/จำนวน/ลบรายการ: แก้ราคาต้องมีเหตุผล และบันทึก audit log (old/new + reason + actor)', async () => {
    await rejects(rpc(U.admin, 'set_job_item_price', { p_line_id: linePart, p_price: 3400, p_reason: '  ' }), /ต้องระบุเหตุผล/);
    await rpc(U.admin, 'set_job_item_price', { p_line_id: linePart, p_price: 3400, p_reason: 'ลูกค้าต่อรอง' });
    const a = await one(`select * from audit_logs where table_name='job_items' and record_id=$1 and action='UPDATE' order by id desc limit 1`, [linePart]);
    eq(a.reason, 'ลูกค้าต่อรอง'); eq(a.actor, U.admin);
    eq([Number(a.old_data.unit_price), Number(a.new_data.unit_price)], [3500, 3400]);
    await rpc(U.admin, 'set_job_item_price', { p_line_id: linePart, p_price: 3500, p_reason: 'คืนราคาเดิม' });
    await rpc(U.admin, 'set_job_item_qty', { p_line_id: lineLabor, p_qty: 2 });
    await rpc(U.admin, 'set_job_item_qty', { p_line_id: lineLabor, p_qty: 1 });
    await rejects(rpc(U.admin, 'remove_job_item', { p_line_id: lineDiscount }), /ต้องระบุเหตุผล/);
  });
  await test('ชุดบริการ (bundle) แตกเป็นบรรทัดย่อยตอนบันทึกใบงาน ; ราคารวม = ผลรวมบรรทัดย่อย ; ลบทั้งชุดได้', async () => {
    const b = await rpc(U.owner, 'catalog_create_item', { p_category_id: await cat('AC-CL'), p_name: 'แพ็กเกจล้างแอร์ครบชุด', p_item_type: 'bundle' });
    await as(sup, U.owner, `insert into catalog_bundle_components(branch_id, bundle_item_id, component_item_id, qty, unit_price)
      values ($1,$2,$3,1,500),($1,$2,$4,1,300)`, [B, b, await item('AC-CL-001'), await item('AC-CL-004')]);
    await rejects(as(sup, U.owner, `insert into catalog_bundle_components(branch_id, bundle_item_id, component_item_id, unit_price)
      values ($1,$2,$3,1)`, [B, await item('AC-CL-001'), await item('AC-CL-004')]), /ต้องเป็นประเภท bundle/);
    const jb = await newJob('ชุด 1');
    const header = await rpc(U.admin, 'add_job_item', { p_job_id: jb, p_item_id: b, p_qty: 2 });
    const rows = await sq('select item_code, item_type, is_bundle_header h, parent_id, qty::float q, unit_price::float p from job_items where job_id=$1 order by sort_order', [jb]);
    eq(rows.length, 3);
    ok(rows[0].h && rows[0].p === 0, 'หัวชุดต้องราคา 0');
    eq(rows.slice(1).map((r) => [r.item_code, r.q, r.p, r.parent_id === header]), [['AC-CL-001', 2, 500, true], ['AC-CL-004', 2, 300, true]]);
    eq(Number((await jobTotals(jb)).net), 1600);
    await rejects(rpc(U.admin, 'remove_job_item', { p_line_id: rows[1] && (await one('select id from job_items where job_id=$1 and item_code=$2', [jb, 'AC-CL-001'])).id }), /ลบทั้งชุด/);
    await rpc(U.admin, 'remove_job_item', { p_line_id: header });
    eq((await one('select count(*)::int c from job_items where job_id=$1', [jb])).c, 0);
    await rpc(U.admin, 'cancel_job', { p_job_id: jb, p_reason: 'ทดสอบ' });
  });

  // =====================================================================
  group('5. State machine: ห้ามข้ามขั้น + เช็คสภาพก่อนเริ่มงาน');
  await test('technician เห็นใบงานเฉพาะขั้นเช็คสภาพ→QC ; ยังไม่เห็น opened', async () => {
    eq((await as(sup, U.tech, 'select 1 from job_orders where id=$1', [jobA])).rowCount, 0);
  });
  await test('opened → condition_check ; แต่ข้ามไปอนุมัติใบเสนอราคา/เริ่มงานตรง ๆ ไม่ได้', async () => {
    await rejects(rpc(U.admin, 'approve_quote', { p_job_id: jobA }), /เฉพาะสถานะ "เสนอราคา"/);
    await rejects(rpc(U.admin, 'qc_pass', { p_job_id: jobA, p_answers: QC_OK }), /เฉพาะสถานะ "รอ QC"/);
    await rejects(rpc(U.admin, 'close_job', { p_job_id: jobA }), /รอชำระ/);
    eq(await rpc(U.admin, 'advance_job', { p_job_id: jobA }), 'condition_check');
    eq((await as(sup, U.tech, 'select 1 from job_orders where id=$1', [jobA])).rowCount, 1);
  });
  await test('ใบงานนี้ต้องเช็คสภาพ 2 แบบ (ทั่วไป + ก่อนรื้อคอนโซลเพราะมีงานเปลี่ยนตู้แอร์)', async () => {
    const r = await rpc(U.admin, 'job_required_checks', { p_job: jobA }, { table: true });
    eq(r.map((x) => x.template_name).sort(), ['ก่อนรื้อคอนโซล (เปลี่ยนตู้แอร์)', 'สภาพรถทั่วไป (ทุกคัน)'].sort());
  });
  await test('เช็คสภาพไม่ครบ → ออกจากขั้นเช็คสภาพไม่ได้', async () => {
    await rejects(rpc(U.admin, 'advance_job', { p_job_id: jobA }), /เช็คสภาพรถยังไม่ครบ/);
  });
  let genCheck;
  await test('ยืนยันเช็คสภาพ: ต้องตอบครบ, พบตำหนิต้องมีรายละเอียด, ต้องมีรูป, ต้องมีลายเซ็น', async () => {
    const gen = await one("select id, checklist from condition_templates where code='GEN'");
    const ans = Object.fromEntries(gen.checklist.map((i) => [i.key, { state: 'ok' }]));
    await rejects(rpc(U.tech, 'save_condition_check', { p_job_id: jobA, p_template_id: gen.id, p_answers: { body: { state: 'maybe' } } }), /ok \/ defect \/ na/);
    genCheck = await rpc(U.tech, 'save_condition_check', { p_job_id: jobA, p_template_id: gen.id, p_answers: { body: { state: 'ok' } } });
    await rejects(rpc(U.tech, 'complete_condition_check', { p_check_id: genCheck, p_signature_path: sigPath(jobA), p_signed_by: 'ลูกค้า' }), /ยังไม่ได้ตอบข้อ/);
    await rpc(U.tech, 'save_condition_check', { p_job_id: jobA, p_template_id: gen.id, p_answers: { ...ans, body: { state: 'defect' } } });
    await rejects(rpc(U.tech, 'complete_condition_check', { p_check_id: genCheck, p_signature_path: sigPath(jobA), p_signed_by: 'ลูกค้า' }), /พบตำหนิ/);
    await rpc(U.tech, 'save_condition_check', { p_job_id: jobA, p_template_id: gen.id, p_answers: { ...ans, body: { state: 'defect', note: 'รอยขีดข่วนประตูซ้าย' } } });
    await rejects(rpc(U.tech, 'complete_condition_check', { p_check_id: genCheck, p_signature_path: sigPath(jobA), p_signed_by: 'ลูกค้า' }), /แนบรูป/);
    await rejects(rpc(U.tech, 'add_condition_photo', { p_check_id: genCheck, p_path: `${B2}/x/y.jpg` }), /ตำแหน่งไฟล์/);
    await rpc(U.tech, 'add_condition_photo', { p_check_id: genCheck, p_path: photoPath(jobA, 'gen1') });
    await rejects(rpc(U.tech, 'complete_condition_check', { p_check_id: genCheck, p_signature_path: null, p_signed_by: 'ลูกค้า' }), /ลายเซ็น/);
    await rpc(U.tech, 'complete_condition_check', { p_check_id: genCheck, p_signature_path: sigPath(jobA), p_signed_by: 'สมชาย' });
    await rejects(rpc(U.tech, 'save_condition_check', { p_job_id: jobA, p_template_id: gen.id, p_answers: ans }), /ยืนยันแล้ว/);
  });
  await test('ยังขาดแบบฟอร์มที่สอง → ยังไปต่อไม่ได้ ; ทำครบแล้วไป quoting ได้', async () => {
    await rejects(rpc(U.admin, 'advance_job', { p_job_id: jobA }), /ก่อนรื้อคอนโซล/);
    await completeAllChecks(jobA);
    eq(await rpc(U.admin, 'advance_job', { p_job_id: jobA }), 'quoting');
  });
  await test('ใบเสนอราคา: ส่วนลดเกินเพดาน (เพดาน 0%) ต้องให้เจ้าของอนุมัติก่อน ; admin อนุมัติเองไม่ได้', async () => {
    await rejects(rpc(U.admin, 'approve_quote', { p_job_id: jobA }), /เพดาน/);
    await rejects(rpc(U.admin, 'approve_discounts', { p_job_id: jobA }), /ไม่มีสิทธิ์/);
    ok(await rpc(U.admin, 'job_discount_blocked', { p_job: jobA }) === true, 'ต้อง blocked');
  });
  await test('เจ้าของอนุมัติส่วนลด → อนุมัติใบเสนอราคาได้ → เบิกอะไหล่ ; ล็อกรายการหลังอนุมัติ', async () => {
    await rpc(U.owner, 'approve_discounts', { p_job_id: jobA, p_note: 'ok' });
    await rpc(U.admin, 'approve_quote', { p_job_id: jobA, p_note: 'ลูกค้าตกลงทางโทรศัพท์' });
    eq(await statusOf(jobA), 'requisition');
    await rejects(rpc(U.admin, 'add_job_item', { p_job_id: jobA, p_item_id: await item('AC-CL-001') }), /แก้ไขรายการไม่ได้/);
    await rejects(rpc(U.admin, 'set_job_item_price', { p_line_id: linePart, p_price: 1, p_reason: 'x' }), /แก้ราคาไม่ได้/);
    await rejects(rpc(U.tech, 'advance_job', { p_job_id: jobA }), /ช่างเปลี่ยนสถานะได้เฉพาะ/); // ช่างข้ามขั้นเบิกอะไหล่ไม่ได้
    // มีอะไหล่ในใบงาน → ระบบสร้างคำขอเบิกให้เอง ; แอดมินข้ามขั้นไม่ได้จนกว่าคลังจะส่งมอบ
    const rq = await sq('select r.id, r.status, r.req_no, r.job_no, r.plate from requisitions r where r.job_id=$1', [jobA]);
    eq(rq.length, 1); eq(rq[0].status, 'requested');
    ok(/^RQ-\d{8}-001$/.test(rq[0].req_no), rq[0].req_no);
    await rejects(rpc(U.admin, 'advance_job', { p_job_id: jobA }), /คำขอเบิกอะไหล่ที่คลังยังไม่ส่งมอบ/);
    await deliverParts(jobA);
    eq(await statusOf(jobA), 'ready');
  });
  await test('เริ่มงานไม่ได้ถ้าเช็คสภาพถูกเปิดแก้ค้างอยู่ (บล็อกการเริ่มงาน) ; ทำครบแล้วช่างเริ่มงานได้', async () => {
    const cc = await one(`select c.id from condition_checks c join condition_templates t on t.id=c.template_id where c.job_id=$1 and t.code='AC-EVAP'`, [jobA]);
    await rejects(rpc(U.tech, 'reopen_condition_check', { p_check_id: cc.id, p_reason: 'x' }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.admin, 'reopen_condition_check', { p_check_id: cc.id, p_reason: '' }), /ต้องระบุเหตุผล/);
    await rpc(U.admin, 'reopen_condition_check', { p_check_id: cc.id, p_reason: 'ลูกค้าขอแก้รายละเอียด' });
    await rejects(rpc(U.tech, 'advance_job', { p_job_id: jobA }), /ต้องกด "รับงาน" ก่อน/);   // ยังไม่ได้รับงาน
    await rejects(rpc(U.admin, 'advance_job', { p_job_id: jobA }), /เริ่มงานไม่ได้.*เช็คสภาพรถยังไม่ครบ/);
    await rpc(U.tech, 'accept_job', { p_job_id: jobA });
    await rejects(rpc(U.tech, 'advance_job', { p_job_id: jobA }), /เริ่มงานไม่ได้.*เช็คสภาพรถยังไม่ครบ/);
    await completeAllChecks(jobA);
    eq(await rpc(U.tech, 'advance_job', { p_job_id: jobA }), 'in_progress');
  });
  await test('ช่างส่งตรวจ QC ได้ แต่ผ่าน QC ไม่ได้ ; admin ผ่าน QC → รอชำระ', async () => {
    eq(await rpc(U.tech, 'advance_job', { p_job_id: jobA }), 'qc');
    await rejects(rpc(U.tech, 'qc_pass', { p_job_id: jobA, p_answers: QC_OK }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.tech, 'qc_fail', { p_job_id: jobA, p_note: 'x' }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.admin, 'advance_job', { p_job_id: jobA }), /บันทึกผล QC/);
    await rpc(U.admin, 'qc_pass', { p_job_id: jobA, p_answers: QC_OK, p_note: 'เย็นปกติ' });
    eq(await statusOf(jobA), 'awaiting_payment');
  });

  // =====================================================================
  group('6. รับชำระ (หลายแบบ/มัดจำ/จ่ายบางส่วน) + ปิดงาน + ใบเสร็จ + ใบรับประกัน');
  const slip = (n) => `${B}/${jobA}/slip/${n}.jpg`;
  await test('QR/โอนต้องแนบสลิป (path ของสาขาตัวเอง)', async () => {
    await rejects(rpc(U.admin, 'record_payment', { p_job_id: jobA, p_kind: 'payment', p_method: 'qr_promptpay', p_amount: 1000 }), /แนบสลิป/);
    await rejects(rpc(U.admin, 'record_payment', { p_job_id: jobA, p_kind: 'payment', p_method: 'transfer', p_amount: 1000, p_slip_path: `${B2}/x.jpg` }), /แนบสลิป/);
  });
  await test('ปิดงานไม่ได้เมื่อยังไม่รับเงิน/รับไม่ครบ', async () => {
    await rejects(rpc(U.admin, 'close_job', { p_job_id: jobA }), /รับเงินยังไม่ครบ.*5200/);
    await rpc(U.admin, 'record_payment', { p_job_id: jobA, p_kind: 'deposit', p_method: 'cash', p_amount: 1000 });
    await rpc(U.admin, 'record_payment', { p_job_id: jobA, p_kind: 'payment', p_method: 'qr_promptpay', p_amount: 2000, p_slip_path: slip(1), p_reference: 'REF1' });
    const t = await jobTotals(jobA);
    eq([Number(t.paid_total), Number(t.balance), t.payment_status], [3000, 2200, 'partial']);
    await rejects(rpc(U.admin, 'close_job', { p_job_id: jobA }), /ค้างชำระ.*2200/);
  });
  await test('รับเกินยอดค้างไม่ได้ ; technician/warehouse รับเงินไม่ได้', async () => {
    await rejects(rpc(U.admin, 'record_payment', { p_job_id: jobA, p_kind: 'payment', p_method: 'cash', p_amount: 2300 }), /รับเกินยอดค้าง/);
    await rejects(rpc(U.tech, 'record_payment', { p_job_id: jobA, p_kind: 'payment', p_method: 'cash', p_amount: 1 }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.wh, 'record_payment', { p_job_id: jobA, p_kind: 'payment', p_method: 'cash', p_amount: 1 }), /ไม่มีสิทธิ์/);
  });
  let receiptA;
  await test('รับครบด้วยวิธีที่ 3 (โอน) → ปิดงานได้ → ได้ใบเสร็จ RC-… + สถานะ closed', async () => {
    await rpc(U.admin, 'record_payment', { p_job_id: jobA, p_kind: 'payment', p_method: 'transfer', p_amount: 2200, p_slip_path: slip(2) });
    eq((await jobTotals(jobA)).payment_status, 'paid');
    receiptA = await rpc(U.admin, 'close_job', { p_job_id: jobA });
    eq(await statusOf(jobA), 'closed');
    const r = await one('select * from receipts where id=$1', [receiptA]);
    ok(/^RC-\d{8}-001$/.test(r.receipt_no), r.receipt_no);
    eq([Number(r.subtotal), Number(r.discount_total), Number(r.vat_amount), Number(r.grand_total)], [5400, 200, 0, 5200]);
    eq(r.snapshot.payments.length, 3);
    eq(r.snapshot.lines.map((l) => l.type), ['service', 'part', 'service', 'discount']);
    eq(r.snapshot.vehicle.plate, 'กข 1234');
  });
  await test('ใบรับประกันถูกสร้างอัตโนมัติ ตาม warranty_months ของแต่ละรายการ (12 และ 6 เดือน)', async () => {
    const w = await sq('select item_name, warranty_months, starts_on::text s, ends_on::text e, warranty_no from warranties where job_id=$1 order by warranty_months desc', [jobA]);
    eq(w.length, 2);
    eq(w.map((x) => x.warranty_months), [12, 6]);
    const d = await today();
    eq(w[0].s, d);
    eq(w[0].e, (await one("select (($1::date) + interval '12 months')::date::text e", [d])).e);
    ok(/^WR-\d{8}-00[12]$/.test(w[0].warranty_no), w[0].warranty_no);
  });
  await test('หลังปิดงาน: แก้รายการ/ย้อนสถานะ/รับเงินเพิ่ม/ปิดซ้ำ ไม่ได้ ; admin void การชำระของใบที่ปิดแล้วไม่ได้', async () => {
    await rejects(rpc(U.admin, 'add_job_item', { p_job_id: jobA, p_item_id: await item('AC-CL-001') }), /แก้ไขรายการไม่ได้/);
    await rejects(rpc(U.admin, 'revert_job', { p_job_id: jobA, p_target: 'quoting', p_reason: 'x' }), /ย้อนสถานะไม่ได้/);
    await rejects(rpc(U.admin, 'record_payment', { p_job_id: jobA, p_kind: 'payment', p_method: 'cash', p_amount: 1 }), /ปิด\/ยกเลิกแล้ว/);
    await rejects(rpc(U.admin, 'close_job', { p_job_id: jobA }), /รอชำระ/);
    const p = await one('select id from payments where job_id=$1 limit 1', [jobA]);
    await rejects(rpc(U.admin, 'void_payment', { p_payment_id: p.id, p_reason: 'x' }), /เฉพาะเจ้าของ/);
  });

  // =====================================================================
  group('7. ย้อนสถานะ / ยกเลิก / void (ห้ามลบ) / audit log');
  let jobB;
  await test('ย้อนสถานะ: เฉพาะ owner/admin + ต้องมีเหตุผล + ย้อนไปขั้นก่อนหน้าเท่านั้น + ล้างการอนุมัติเมื่อกลับไป quoting', async () => {
    jobB = await newJob('ย้อน 1');
    await rpc(U.admin, 'add_job_item', { p_job_id: jobB, p_item_id: await item('AC-CL-001') });
    await rpc(U.admin, 'advance_job', { p_job_id: jobB });
    await completeAllChecks(jobB);
    await rpc(U.admin, 'advance_job', { p_job_id: jobB });
    await rpc(U.admin, 'approve_quote', { p_job_id: jobB });
    eq(await statusOf(jobB), 'requisition');
    await rejects(rpc(U.admin, 'revert_job', { p_job_id: jobB, p_target: 'quoting', p_reason: '' }), /ต้องระบุเหตุผล/);
    await rejects(rpc(U.tech, 'revert_job', { p_job_id: jobB, p_target: 'quoting', p_reason: 'x' }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.admin, 'revert_job', { p_job_id: jobB, p_target: 'in_progress', p_reason: 'x' }), /ก่อนหน้า/);
    await rpc(U.admin, 'revert_job', { p_job_id: jobB, p_target: 'quoting', p_reason: 'ลูกค้าขอเพิ่มรายการ' });
    const j = await one('select status, quote_approved_at from job_orders where id=$1', [jobB]);
    eq(j.status, 'quoting'); eq(j.quote_approved_at, null);
    const log = await one("select reason from job_status_log where job_id=$1 and to_status='quoting' order by id desc limit 1", [jobB]);
    eq(log.reason, 'ลูกค้าขอเพิ่มรายการ');
    await rpc(U.admin, 'add_job_item', { p_job_id: jobB, p_item_id: await item('AC-CL-001') }); // แก้ได้อีกครั้ง
  });
  await test('เพดานส่วนลดที่ owner ตั้ง: ต่ำกว่าเพดาน admin ให้เองได้ ; เกินเพดานต้อง owner อนุมัติ', async () => {
    await as(sup, U.owner, 'update branch_settings set discount_cap_percent = 10');
    const l = await rpc(U.admin, 'add_job_item', { p_job_id: jobB, p_item_id: await item('OT-DC-001'), p_unit_price: 100, p_reason: 'ลด 6%' }); // 100/1600 = 6.25%
    ok(!(await rpc(U.admin, 'job_discount_blocked', { p_job: jobB })), 'ต่ำกว่าเพดานต้องไม่ถูกบล็อก');
    await rpc(U.admin, 'set_job_item_price', { p_line_id: l, p_price: 300, p_reason: 'ขอลดเพิ่ม' }); // 18.75%
    ok(await rpc(U.admin, 'job_discount_blocked', { p_job: jobB }), 'เกินเพดานต้องถูกบล็อก');
    await rejects(rpc(U.admin, 'approve_quote', { p_job_id: jobB }), /เพดาน/);
    await rpc(U.owner, 'approve_discounts', { p_job_id: jobB });
    ok(!(await rpc(U.admin, 'job_discount_blocked', { p_job: jobB })), 'owner อนุมัติแล้วต้องผ่าน');
    await as(sup, U.owner, 'update branch_settings set discount_cap_percent = 0');
  });
  await test('ใบงานที่มีรายการราคา 0 และไม่มีเหตุผล → อนุมัติใบเสนอราคาไม่ได้', async () => {
    const jz = await newJob('ศูนย์ 1');
    await rpc(U.admin, 'add_job_item', { p_job_id: jz, p_item_id: await item('AC-DG-002') });
    await rpc(U.admin, 'advance_job', { p_job_id: jz });
    await completeAllChecks(jz);
    await rpc(U.admin, 'advance_job', { p_job_id: jz });
    await rejects(rpc(U.admin, 'approve_quote', { p_job_id: jz }), /ราคา 0/);
    const l = await one('select id from job_items where job_id=$1', [jz]);
    await rpc(U.admin, 'set_job_item_price', { p_line_id: l.id, p_price: 0, p_reason: 'ตรวจฟรีให้ลูกค้าประจำ' });
    await rpc(U.admin, 'approve_quote', { p_job_id: jz });
    await rpc(U.admin, 'revert_job', { p_job_id: jz, p_target: 'opened', p_reason: 'ทดสอบ' });
    await rpc(U.admin, 'cancel_job', { p_job_id: jz, p_reason: 'ทดสอบ' });
  });
  await test('ยกเลิกใบงานที่มีมัดจำไม่ได้จนกว่าจะ void การชำระ ; void ต้องมีเหตุผล ; ยอดคงเหลือคำนวณใหม่', async () => {
    const jd = await newJob('มัดจำ 1');
    await rpc(U.admin, 'add_job_item', { p_job_id: jd, p_item_id: await item('AC-CL-001') });
    await rejects(rpc(U.admin, 'record_payment', { p_job_id: jd, p_kind: 'payment', p_method: 'cash', p_amount: 100 }), /รอชำระ/);
    const pay = await rpc(U.admin, 'record_payment', { p_job_id: jd, p_kind: 'deposit', p_method: 'cash', p_amount: 300 });
    await rejects(rpc(U.admin, 'record_payment', { p_job_id: jd, p_kind: 'deposit', p_method: 'cash', p_amount: 900 }), /มัดจำเกินยอดบิล/);
    await rejects(rpc(U.admin, 'cancel_job', { p_job_id: jd, p_reason: 'x' }), /void รายการชำระ/);
    await rejects(rpc(U.admin, 'cancel_job', { p_job_id: jd, p_reason: '' }), /ต้องระบุเหตุผล/);
    await rejects(rpc(U.admin, 'void_payment', { p_payment_id: pay, p_reason: ' ' }), /ต้องระบุเหตุผล/);
    await rpc(U.admin, 'void_payment', { p_payment_id: pay, p_reason: 'คืนเงินมัดจำ' });
    await rejects(rpc(U.admin, 'void_payment', { p_payment_id: pay, p_reason: 'ซ้ำ' }), /void ไปแล้ว/);
    eq(Number((await jobTotals(jd)).paid_total), 0);
    const a = await one(`select reason, actor from audit_logs where table_name='payments' and record_id=$1 and action='UPDATE' order by id desc limit 1`, [pay]);
    eq([a.reason, a.actor], ['คืนเงินมัดจำ', U.admin]);
    await rpc(U.admin, 'cancel_job', { p_job_id: jd, p_reason: 'ลูกค้าไม่ทำแล้ว' });
    eq(await statusOf(jd), 'cancelled');
    await rejects(rpc(U.admin, 'advance_job', { p_job_id: jd }), /ไปต่อไม่ได้/);
  });
  await test('ลบใบงาน/การชำระเงิน/ใบเสร็จ/ใบรับประกัน/audit log ไม่ได้ แม้เป็นเจ้าของหรือ superuser (trigger)', async () => {
    for (const t of ['job_orders', 'payments', 'receipts', 'warranties', 'condition_checks', 'customers', 'vehicles', 'job_status_log', 'audit_logs']) {
      await rejects(sup.query(`delete from ${t}`), /ห้ามลบข้อมูล/, t);
    }
    await rejects(sup.query("update audit_logs set reason = 'แก้'"), /แก้ไขย้อนหลังไม่ได้/);
  });
  await test('ผ่านบัญชีผู้ใช้: admin/owner สั่ง delete/update/insert ตารางธุรกรรมตรง ๆ ไม่ได้ (ต้องผ่าน RPC)', async () => {
    for (const who of [U.admin, U.owner]) {
      await rejects(as(sup, who, 'delete from payments'), /permission denied/);
      await rejects(as(sup, who, 'delete from job_orders'), /permission denied/);
      await rejects(as(sup, who, "update job_orders set status = 'closed'"), /permission denied/);
      await rejects(as(sup, who, "update payments set amount = 1"), /permission denied/);
      await rejects(as(sup, who, 'update receipts set grand_total = 1'), /permission denied/);
      await rejects(as(sup, who, 'insert into job_items(branch_id, job_id, item_code, item_name, item_type) select branch_id, id, \'x\',\'x\',\'service\' from job_orders limit 1'), /permission denied/);
      await rejects(as(sup, who, 'delete from audit_logs'), /permission denied/);
    }
  });
  await test('void ใบงาน: เฉพาะ owner + เหตุผล + ต้อง void การชำระก่อน', async () => {
    await rejects(rpc(U.admin, 'void_job', { p_job_id: jobA, p_reason: 'x' }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.owner, 'void_job', { p_job_id: jobA, p_reason: ' ' }), /ต้องระบุเหตุผล/);
    await rejects(rpc(U.owner, 'void_job', { p_job_id: jobA, p_reason: 'บันทึกผิดคัน' }), /void รายการชำระ\/คืนเงินทั้งหมดก่อน/);
  });
  await test('void ใบงานที่ปิดแล้ว (ใบแยก jobC): owner void การชำระ → void ใบงาน → ใบเสร็จ+ใบรับประกัน void ตาม ; ข้อมูลยังอยู่ ; ไม่นับในรายงาน', async () => {
    const jc = await newJob('วอยด์ 1');
    await rpc(U.admin, 'add_job_item', { p_job_id: jc, p_item_id: await item('PT-BT-001'), p_attributes: { 'ยี่ห้อ': '3K', 'รุ่น': 'MF55', 'ขนาด': '55D23L' } });
    await rpc(U.admin, 'advance_job', { p_job_id: jc });
    await completeAllChecks(jc);
    await rpc(U.admin, 'advance_job', { p_job_id: jc });          // quoting
    await driveToQc(jc);                                          // อนุมัติ → คลังส่งอะไหล่ → ช่างรับงาน → in_progress → qc
    await rpc(U.admin, 'qc_pass', { p_job_id: jc, p_answers: QC_OK });
    const pay = await rpc(U.admin, 'record_payment', { p_job_id: jc, p_kind: 'payment', p_method: 'cash', p_amount: 2500 });
    const rc = await rpc(U.admin, 'close_job', { p_job_id: jc });
    eq((await one('select count(*)::int c from warranties where job_id=$1 and voided_at is null', [jc])).c, 1);
    await rejects(rpc(U.owner, 'void_job', { p_job_id: jc, p_reason: 'บันทึกผิดคัน' }), /void รายการชำระ\/คืนเงินทั้งหมดก่อน/);
    await rpc(U.owner, 'void_payment', { p_payment_id: pay, p_reason: 'รับเงินผิดใบ' });
    await rpc(U.owner, 'void_job', { p_job_id: jc, p_reason: 'บันทึกผิดคัน' });
    const j = await one('select status, voided_at, void_reason from job_orders where id=$1', [jc]);
    eq(j.status, 'closed'); ok(j.voided_at, 'ต้องมี voided_at'); eq(j.void_reason, 'บันทึกผิดคัน');
    ok((await one('select voided_at from receipts where id=$1', [rc])).voided_at, 'ใบเสร็จต้องถูก void');
    eq((await one('select count(*)::int c from warranties where job_id=$1 and voided_at is null', [jc])).c, 0);
    eq((await one('select count(*)::int c from warranties where job_id=$1', [jc])).c, 1); // ข้อมูลไม่หาย
    await rejects(rpc(U.owner, 'void_job', { p_job_id: jc, p_reason: 'ซ้ำ' }), /void แล้ว/);
    await rejects(rpc(U.admin, 'add_job_item', { p_job_id: jc, p_item_id: await item('AC-CL-001') }), /void แล้ว/);
  });

  // =====================================================================
  group('8. รายงานรายได้แยกหมวด (ค่าแรง/อะไหล่แยกกัน, ยอดรวมตรงกับใบงาน)');
  await test('รายงานรายได้ของวันนี้ แยกหมวดหลัก/หมวดย่อย/ประเภทบรรทัด และรวมเท่ากับยอดสุทธิของใบงานที่ปิด', async () => {
    const d = await today();
    const rows = await rpc(U.owner, 'report_revenue', { p_from: d, p_to: d }, { table: true });
    const m = Object.fromEntries(rows.map((r) => [`${r.sub_code}/${r.line_type}`, Number(r.revenue)]));
    eq(m, { 'AC-CL/service': 700, 'AC-RP/service': 1200, 'OT-DC/discount': -200, 'PT-AC/part': 3500 });
    const total = rows.reduce((s, r) => s + Number(r.revenue), 0);
    const jobsNet = (await one(`select coalesce(sum(t.net),0) n from job_orders j join v_job_totals t on t.job_id=j.id where j.status='closed' and j.voided_at is null`)).n;
    eq(total, Number(jobsNet));
    eq(total, 5200);
  });
  await test('รายงานการเงินดูได้เฉพาะ owner', async () => {
    const d = await today();
    await rejects(rpc(U.admin, 'report_revenue', { p_from: d, p_to: d }, { table: true }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.tech, 'report_revenue', { p_from: d, p_to: d }, { table: true }), /ไม่มีสิทธิ์/);
  });

  // =====================================================================
  group('9. VAT รวมในราคาแล้ว (ค่าเริ่มต้น: ปิด — เปิดแล้วแค่แยกยอด VAT ออกมา ไม่บวกเพิ่ม)');
  await test('ค่าเริ่มต้นปิด VAT ; เปิดแล้วราคา "รวม VAT แล้ว": ยอดสุทธิไม่เปลี่ยน แค่แยก VAT 7/107 ; ใบงานเดิมไม่เปลี่ยน', async () => {
    eq((await one('select vat_enabled from branch_settings')).vat_enabled, false);
    await as(sup, U.owner, 'update branch_settings set vat_enabled = true');
    const jv = await newJob('แวต 1');
    await rpc(U.admin, 'add_job_item', { p_job_id: jv, p_item_id: await item('AC-CL-001'), p_unit_price: 1000, p_reason: 'ทดสอบ VAT' });
    const t = await jobTotals(jv);
    eq([Number(t.net), Number(t.vat), Number(t.ex_vat), Number(t.grand_total)], [1000, 65.42, 934.58, 1000]);
    eq(Number(t.vat) + Number(t.ex_vat), Number(t.grand_total), 'ก่อน VAT + VAT ต้องเท่ายอดสุทธิพอดี');
    eq(Number((await jobTotals(jobA)).vat), 0);
    await as(sup, U.owner, 'update branch_settings set vat_enabled = false');
    await rpc(U.admin, 'cancel_job', { p_job_id: jv, p_reason: 'ทดสอบ' });
  });
  await test('admin แก้ตั้งค่า (VAT/เพดานส่วนลด) ไม่ได้', async () => {
    const r = await as(sup, U.admin, 'update branch_settings set vat_enabled = true');
    eq(r.rowCount, 0);
  });

  // =====================================================================
  group('10. RLS ตามบทบาท + แยกสาขา');
  await test('anon เข้าตารางใดไม่ได้เลย', async () => {
    for (const t of ['job_orders', 'payments', 'customers', 'catalog_items', 'v_jobs']) {
      await rejects(as(sup, 'anon', `select * from ${t}`), /permission denied/, t);
    }
    await rejects(as(sup, 'anon', 'select open_job(p_plate => $1)', ['x']), /permission denied/);
  });
  await test('technician: ไม่เห็นการเงิน/ใบเสร็จ/audit ; warehouse: ไม่เห็นใบงาน/ลูกค้า', async () => {
    for (const t of ['payments', 'receipts', 'warranties', 'audit_logs']) {
      eq((await as(sup, U.tech, `select 1 from ${t}`)).rowCount, 0, `tech ${t}`);
    }
    eq((await as(sup, U.wh, 'select 1 from job_orders')).rowCount, 0);
    eq((await as(sup, U.wh, 'select 1 from customers')).rowCount, 0);
    eq((await as(sup, U.wh, 'select 1 from payments')).rowCount, 0);
    ok((await as(sup, U.wh, 'select 1 from catalog_items')).rowCount > 0, 'warehouse อ่านแคตตาล็อกได้');
  });
  let jobT; // ใบงานที่อยู่ในขั้นที่ช่างเห็น (condition_check) พร้อมบรรทัดค่าแรง+อะไหล่ที่มีราคา
  await test('technician/warehouse: อ่านราคา-ต้นทุน และบรรทัดงานตรง ๆ ไม่ได้ ; ดูผ่าน job_items_for_job ได้แต่ค่าเงินเป็น NULL', async () => {
    await setPrice('AC-RP-003', 3500); await setPrice('PT-AC-003', 4200);
    jobT = await rpc(U.admin, 'open_job', { p_plate: 'ทดสอบ 9001', p_customer_name: 'ลูกค้าทดสอบสิทธิ์', p_complaint: 'ทดสอบ RLS ของช่าง' });
    await rpc(U.admin, 'add_job_item', { p_job_id: jobT, p_item_id: await item('AC-RP-003') });
    await rpc(U.admin, 'add_job_item', { p_job_id: jobT, p_item_id: await item('PT-AC-003') });
    await rpc(U.admin, 'advance_job', { p_job_id: jobT }); // opened → condition_check (ช่างเห็นได้)
    eq((await as(sup, U.tech, 'select 1 from job_orders where id = $1', [jobT])).rowCount, 1, 'ช่างต้องเห็นใบงานขั้นเช็คสภาพ');

    eq((await as(sup, U.tech, 'select 1 from item_prices')).rowCount, 0, 'tech item_prices');
    eq((await as(sup, U.wh, 'select 1 from item_prices')).rowCount, 0, 'wh item_prices');
    ok((await as(sup, U.admin, 'select 1 from item_prices')).rowCount > 0, 'admin ยังอ่านราคาได้');

    eq((await as(sup, U.tech, 'select 1 from job_items where job_id = $1', [jobT])).rowCount, 0, 'tech อ่าน job_items ตรง ๆ');
    const viaFn = await rpc(U.tech, 'job_items_for_job', { p_job: jobT }, { table: true });
    const full = await sq('select * from job_items where job_id = $1', [jobT]);
    ok(full.length >= 2, 'ต้องมีบรรทัดงานจริงอย่างน้อย 2 บรรทัด');
    eq(viaFn.length, full.length, 'จำนวนบรรทัดผ่านฟังก์ชันต้องเท่ากับของจริง');
    for (const r of viaFn) {
      eq(r.unit_price, null); eq(r.cost, null); eq(r.line_total, null); eq(r.list_price, null); eq(r.labor_rate, null); eq(r.price_reason, null);
      ok(r.item_name && r.item_code, 'ช่างยังต้องเห็นชื่อ/รหัสรายการ');
    }
    ok(full.some((r) => Number(r.unit_price) > 0), 'ข้อมูลจริงต้องมีราคา (กันเทสต์ผ่านเพราะราคาเป็น 0 อยู่แล้ว)');
    const tot = await as(sup, U.tech, 'select grand_total, gross from v_job_totals where job_id = $1', [jobT]);
    for (const r of tot.rows) eq(Number(r.grand_total), 0, 'ยอดรวมที่ช่างเห็นต้องเป็น 0 ไม่รั่ว');
    const vj = await as(sup, U.tech, 'select grand_total, net from v_jobs where id = $1', [jobT]);
    eq(vj.rowCount, 1); eq(Number(vj.rows[0].grand_total), 0);
    const adminView = await rpc(U.admin, 'job_items_for_job', { p_job: jobT }, { table: true });
    ok(adminView.some((r) => Number(r.unit_price) > 0), 'admin ต้องเห็นราคาผ่านฟังก์ชันเดียวกัน');
  });
  await test('job_items_for_job / job_required_checks: ใบงานที่ช่างยังไม่มีสิทธิ์เห็น / สาขาอื่น / anon → ไม่ได้อะไรกลับมา', async () => {
    const hidden = await sq("select id from job_orders where status in ('opened','quoting','requisition','awaiting_payment','closed') limit 1");
    ok(hidden.length > 0, 'ต้องมีใบงานขั้นที่ช่างไม่เห็น');
    eq((await rpc(U.tech, 'job_items_for_job', { p_job: hidden[0].id }, { table: true })).length, 0);
    eq((await rpc(U.tech, 'job_required_checks', { p_job: hidden[0].id }, { table: true })).length, 0);
    await rejects(as(sup, 'anon', 'select * from job_items_for_job($1)', [hidden[0].id]), /permission denied/);
    await rejects(as(sup, 'anon', 'select * from job_required_checks($1)', [hidden[0].id]), /permission denied/);
  });
  await test('ช่างยังเห็นฟอร์มเช็คสภาพเฉพาะรายการ (ใบงาน jobT มีงานเปลี่ยนตู้แอร์ → 2 ฟอร์ม เหมือนที่ owner เห็น)', async () => {
    const asTech = await rpc(U.tech, 'job_required_checks', { p_job: jobT }, { table: true });
    const asOwn = await rpc(U.owner, 'job_required_checks', { p_job: jobT }, { table: true });
    eq(asOwn.length, 2, 'owner ต้องเห็น 2 ฟอร์ม');
    eq(asTech.length, 2, 'ช่างต้องเห็น 2 ฟอร์ม (ห้ามพึ่งการอ่าน job_items ของตัวเอง)');
  });
  await test('admin เห็นการเงินแต่ไม่เห็น audit_logs ; owner เห็น audit_logs', async () => {
    ok((await as(sup, U.admin, 'select 1 from payments')).rowCount > 0);
    eq((await as(sup, U.admin, 'select 1 from audit_logs')).rowCount, 0);
    ok((await as(sup, U.owner, 'select 1 from audit_logs')).rowCount > 0);
  });
  await test('admin แก้บทบาท/ปิดบัญชีผู้ใช้อื่นไม่ได้ ; owner แก้ได้', async () => {
    eq((await as(sup, U.admin, "update users set role = 'owner' where id = $1", [U.admin])).rowCount, 0);
    eq((await as(sup, U.owner, "update users set is_active = true where id = $1", [U.tech])).rowCount, 1);
  });
  await test('ต่างสาขาแยกขาดกัน: owner สาขาอื่นไม่เห็นข้อมูล/เรียก RPC กับใบงานสาขานี้ไม่ได้', async () => {
    for (const t of ['job_orders', 'job_items', 'customers', 'vehicles', 'payments', 'receipts', 'catalog_items']) {
      eq((await as(sup, U.owner2, `select 1 from ${t}`)).rowCount, 0, t);
    }
    // audit_logs: owner สาขา 2 เห็นได้เฉพาะแถวของสาขาตัวเอง (การสร้างสาขา/ผู้ใช้ของสาขา 2) ห้ามเห็นแถวของสาขา NTW
    const own = await as(sup, U.owner2, 'select branch_id from audit_logs');
    ok(own.rowCount > 0, 'ควรเห็นแถว audit ของสาขาตัวเอง');
    eq(own.rows.filter((r) => r.branch_id !== B2).length, 0, 'audit_logs รั่วข้ามสาขา');
    await rejects(rpc(U.owner2, 'void_job', { p_job_id: jobB, p_reason: 'แอบ' }), /ไม่พบใบงาน/);
    await rejects(rpc(U.owner2, 'add_job_item', { p_job_id: jobB, p_item_id: await item('AC-CL-001') }), /ไม่พบใบงาน/);
  });
  await test('ผู้ใช้ที่ถูกปิดบัญชี (is_active = false) ใช้งานไม่ได้ทันที', async () => {
    await sq("update users set is_active = false where id = $1", [U.tech]);
    eq((await as(sup, U.tech, 'select 1 from job_orders')).rowCount, 0);
    await rejects(rpc(U.tech, 'advance_job', { p_job_id: jobB }), /ไม่มีสิทธิ์/);
    await sq("update users set is_active = true where id = $1", [U.tech]);
  });
  await test('Storage: อัปโหลดได้เฉพาะโฟลเดอร์ของสาขาตัวเอง และเฉพาะ owner/admin/technician', async () => {
    const ins = (uid, name) => as(sup, uid, "insert into storage.objects(bucket_id, name) values ('job-files', $1)", [name]);
    await ins(U.admin, `${B}/j/photo/a.jpg`);
    await ins(U.tech, `${B}/j/photo/b.jpg`);
    await rejects(ins(U.admin, `${B2}/j/photo/a.jpg`), /row-level security/);
    await rejects(ins(U.wh, `${B}/j/photo/a.jpg`), /row-level security/);
    eq((await as(sup, U.owner2, "select 1 from storage.objects where bucket_id='job-files'")).rowCount, 0);
    ok((await as(sup, U.admin, "select 1 from storage.objects where bucket_id='job-files'")).rowCount >= 2);
    await rejects(as(sup, U.admin, "delete from storage.objects where bucket_id='job-files'"), /permission denied/);
  });

  await test('Storage: สลิปโอนเงิน (โฟลเดอร์ slip) ช่างอ่าน/อัปโหลดไม่ได้ ; admin/owner ได้ ; รูปเช็คสภาพช่างยังใช้ได้', async () => {
    const ins = (uid, name) => as(sup, uid, "insert into storage.objects(bucket_id, name) values ('job-files', $1)", [name]);
    await ins(U.admin, `${B}/jslip/slip/s1.jpg`);
    await rejects(ins(U.tech, `${B}/jslip/slip/s2.jpg`), /row-level security/);
    await ins(U.tech, `${B}/jslip/photo/p1.jpg`);
    const sel = (uid, name) => as(sup, uid, "select 1 from storage.objects where bucket_id='job-files' and name = $1", [name]);
    eq((await sel(U.tech, `${B}/jslip/slip/s1.jpg`)).rowCount, 0, 'ช่างต้องไม่เห็นสลิป');
    eq((await sel(U.admin, `${B}/jslip/slip/s1.jpg`)).rowCount, 1, 'admin เห็นสลิป');
    eq((await sel(U.owner, `${B}/jslip/slip/s1.jpg`)).rowCount, 1, 'owner เห็นสลิป');
    eq((await sel(U.tech, `${B}/jslip/photo/p1.jpg`)).rowCount, 1, 'ช่างยังเห็นรูปเช็คสภาพ');
  });

  // =====================================================================
  // เฟส 2
  // =====================================================================
  // ---- fixtures ของเฟส 2 ----
  await setPrice('AC-CL-001', 800); await setPrice('AC-CL-004', 600); await setPrice('AC-DG-002', 1000);
  await sq("update catalog_items set crew_size = 2, labor_rate = 400 where code = 'AC-CL-001'");
  await sq("update catalog_items set crew_size = 1, labor_rate = 100 where code = 'AC-CL-004'");
  await sq("update catalog_items set crew_size = 3, labor_rate = 100 where code = 'AC-DG-002'");
  /** สร้างใบงานจนถึงขั้น quoting : lines = [{code, qty?, attrs?}] */
  async function quotedJob(plate, lines) {
    const j = await newJob(plate);
    for (const l of lines) {
      const a = { p_job_id: j, p_item_id: await item(l.code) };
      if (l.qty) a.p_qty = l.qty;
      if (l.attrs) a.p_attributes = l.attrs;
      await rpc(U.admin, 'add_job_item', a);
    }
    await rpc(U.admin, 'advance_job', { p_job_id: j });     // condition_check
    await completeAllChecks(j);
    await rpc(U.admin, 'advance_job', { p_job_id: j });     // quoting
    return j;
  }
  /** → อนุมัติใบเสนอราคา + คลังส่งอะไหล่ครบ → ready */
  async function readyJob(plate, lines) {
    const j = await quotedJob(plate, lines);
    await rpc(U.admin, 'approve_quote', { p_job_id: j });
    await deliverParts(j);
    return j;
  }
  const BT = { 'ยี่ห้อ': '3K', 'รุ่น': 'MF55', 'ขนาด': '55D23L' };
  const accept = (j, uid, client) => rpc(uid, 'accept_job', { p_job_id: j }, client ? { client } : {});
  const activeCrew = async (j) => (await sq('select user_id from job_assignments where job_id = $1 and released_at is null order by accepted_at', [j])).map((r) => r.user_id);
  const payAndClose = async (j, delivered = null) => {
    const t = await jobTotals(j);
    if (Number(t.balance) > 0) await rpc(U.admin, 'record_payment', { p_job_id: j, p_kind: 'payment', p_method: 'cash', p_amount: Number(t.balance) });
    return rpc(U.admin, 'close_job', delivered ? { p_job_id: j, p_delivered_on: delivered } : { p_job_id: j });
  };
  const daysAgo = async (n) => (await one("select ((now() at time zone 'Asia/Bangkok')::date - $1::int)::text d", [n])).d;

  // =====================================================================
  group('11. ช่างรับงาน (atomic) + ใครเห็นอะไร');
  let jr1; // ใบงาน crew 1 ที่พร้อมทำ
  await test('ใบงาน "พร้อมทำ" ช่างทุกคนเห็น (ยังมีที่ว่าง) ; คลัง/สาขาอื่นไม่เห็น ; เฉพาะช่างเท่านั้นกดรับงานได้', async () => {
    jr1 = await readyJob('รับ 1', [{ code: 'AC-CL-004' }]);
    eq(await statusOf(jr1), 'ready');
    for (const u of [U.tech, U.tech2, U.tech3]) eq((await as(sup, u, 'select 1 from job_orders where id=$1', [jr1])).rowCount, 1);
    eq((await as(sup, U.wh, 'select 1 from job_orders where id=$1', [jr1])).rowCount, 0);
    eq((await as(sup, U.owner2, 'select 1 from job_orders where id=$1', [jr1])).rowCount, 0);
    await rejects(accept(jr1, U.wh), /ไม่มีสิทธิ์/);
    await rejects(accept(jr1, U.admin), /ไม่มีสิทธิ์/);
    await rejects(accept(jr1, U.owner), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.owner2, 'accept_job', { p_job_id: jr1 }), /ไม่มีสิทธิ์|ไม่พบใบงาน/);
  });
  await test('ช่างที่เห็นใบงาน "พร้อมทำ" ยังไม่เห็นเงิน: v_job_totals = 0, job_items_for_job ค่าเงินเป็น NULL', async () => {
    const t = await as(sup, U.tech, 'select grand_total, paid_total from v_job_totals where job_id=$1', [jr1]);
    for (const r of t.rows) eq([Number(r.grand_total), Number(r.paid_total)], [0, 0]);
    const lines = await rpc(U.tech, 'job_items_for_job', { p_job: jr1 }, { table: true });
    ok(lines.length > 0, 'ช่างต้องเห็นรายการงาน');
    for (const r of lines) { eq(r.unit_price, null); eq(r.line_total, null); eq(r.labor_rate, null); }
  });
  await test('รับงานพร้อมกัน 2 connection (crew 1): สำเร็จ 1 ล้มเหลว 1 — ทำซ้ำ 8 รอบ', async () => {
    for (let i = 0; i < 8; i++) {
      const j = await readyJob('แย่ง ' + i, [{ code: 'AC-CL-004' }]);
      const [c1, c2] = await Promise.all([connect(), connect()]);
      const res = await Promise.allSettled([accept(j, U.tech, c1), accept(j, U.tech2, c2)]);
      await c1.end(); await c2.end();
      eq(res.filter((r) => r.status === 'fulfilled').length, 1, `รอบ ${i}`);
      const bad = res.find((r) => r.status === 'rejected');
      ok(/มีช่างรับครบแล้ว|รับงานนี้อยู่แล้ว/.test(bad.reason.message), bad.reason.message);
      eq((await activeCrew(j)).length, 1, `รอบ ${i} ต้องมีช่าง 1 คนพอดี`);
    }
  });
  await test('รับงานพร้อมกัน 3 connection (crew 2): ได้พอดี 2 คน — ทำซ้ำ 5 รอบ', async () => {
    for (let i = 0; i < 5; i++) {
      const j = await readyJob('แย่ง3 ' + i, [{ code: 'AC-CL-001' }]);
      const cs = await Promise.all([connect(), connect(), connect()]);
      const res = await Promise.allSettled([accept(j, U.tech, cs[0]), accept(j, U.tech2, cs[1]), accept(j, U.tech3, cs[2])]);
      await Promise.all(cs.map((c) => c.end()));
      eq(res.filter((r) => r.status === 'fulfilled').length, 2, `รอบ ${i}`);
      eq((await activeCrew(j)).length, 2, `รอบ ${i}`);
    }
  });
  let jr2; // crew 2
  await test('crew 2: รับได้ 2 คน คนที่ 3 ถูกปฏิเสธและมองไม่เห็นใบงานอีก ; รับซ้ำไม่ได้ ; job_crew_info ถูกต้อง', async () => {
    jr2 = await readyJob('ทีม 2', [{ code: 'AC-CL-001' }]);
    await accept(jr2, U.tech);
    await rejects(accept(jr2, U.tech), /รับงานนี้อยู่แล้ว/);
    await accept(jr2, U.tech2);
    await rejects(accept(jr2, U.tech3), /มีช่างรับครบแล้ว \(2\/2 คน\)/);
    eq((await as(sup, U.tech3, 'select 1 from job_orders where id=$1', [jr2])).rowCount, 0, 'ช่างคนที่ 3 ต้องมองไม่เห็นงานที่เต็มแล้ว');
    for (const u of [U.tech, U.tech2]) eq((await as(sup, u, 'select 1 from job_orders where id=$1', [jr2])).rowCount, 1);
    const info = (await rpc(U.tech, 'job_crew_info', { p_jobs: [jr2] }, { table: true }))[0];
    eq([info.crew_required, info.crew_active, info.mine], [2, 2, true]);
    eq(info.member_names, ['ช่างหนุ่ม', 'ช่างกิ้ม']);
    eq((await rpc(U.tech3, 'job_crew_info', { p_jobs: [jr2] }, { table: true })).length, 0);
    eq((await rpc(U.wh, 'job_crew_info', { p_jobs: [jr2] }, { table: true })).length, 0);
    eq((await rpc(U.admin, 'job_crew_info', { p_jobs: [jr2] }, { table: true })).length, 1);
  });
  await test('ช่างปล่อยงานก่อนเริ่มได้ → ช่องว่างกลับมา ช่างคนอื่นเห็นและรับได้ ; เริ่มงานแล้วปล่อยเองไม่ได้', async () => {
    await rejects(rpc(U.tech3, 'release_job', { p_job_id: jr2 }), /ไม่พบใบงาน|คุณยังไม่ได้รับงานนี้/);
    await rpc(U.tech2, 'release_job', { p_job_id: jr2 });
    eq((await activeCrew(jr2)).length, 1);
    eq((await as(sup, U.tech3, 'select 1 from job_orders where id=$1', [jr2])).rowCount, 1);
    eq((await as(sup, U.tech2, 'select 1 from job_orders where id=$1', [jr2])).rowCount, 1, 'ที่ว่างอีก 1 → ทุกคนเห็น');
    await accept(jr2, U.tech3);
    await rejects(accept(jr2, U.tech2), /ครบแล้ว/);
    const rel = await one("select release_reason, released_by from job_assignments where job_id=$1 and user_id=$2 and released_at is not null", [jr2, U.tech2]);
    eq([rel.release_reason, rel.released_by], ['ช่างปล่อยงานก่อนเริ่ม', U.tech2]);
    eq(await rpc(U.tech, 'advance_job', { p_job_id: jr2 }), 'in_progress');
    await rejects(rpc(U.tech, 'release_job', { p_job_id: jr2 }), /ปล่อยงานเองได้เฉพาะ/);
    await rejects(rpc(U.tech2, 'advance_job', { p_job_id: jr2 }), /ต้องกด "รับงาน" ก่อน/);   // tech2 ปล่อยไปแล้ว
  });
  await test('งานเริ่มแล้วแต่ยังขาดคน (crew 2 มีช่าง 1) ช่างคนอื่นยังเห็นและเข้ามาช่วยกลางงานได้', async () => {
    const j = await readyJob('ช่วย 1', [{ code: 'AC-CL-001' }]);
    await accept(j, U.tech);
    await rpc(U.tech, 'advance_job', { p_job_id: j });   // in_progress ทั้งที่มีช่าง 1/2
    eq(await statusOf(j), 'in_progress');
    eq((await as(sup, U.tech2, 'select 1 from job_orders where id=$1', [j])).rowCount, 1);
    await accept(j, U.tech2);
    eq((await as(sup, U.tech3, 'select 1 from job_orders where id=$1', [j])).rowCount, 0);
    // ช่างที่ไม่ได้รับงานเปลี่ยนสถานะไม่ได้
    await rejects(rpc(U.tech3, 'advance_job', { p_job_id: j }), /ต้องกด "รับงาน" ก่อน/);
  });
  await test('ช่างเห็นงานขั้นเช็คสภาพแต่กดรับไม่ได้ ; ขั้นเสนอราคา/รอชำระ ช่างไม่เห็นเลย', async () => {
    const jq = await quotedJob('ขั้น 1', [{ code: 'AC-CL-004' }]);
    eq((await as(sup, U.tech, 'select 1 from job_orders where id=$1', [jq])).rowCount, 0, 'quoting');
    const jc = await newJob('ขั้น 2'); await rpc(U.admin, 'advance_job', { p_job_id: jc });
    eq((await as(sup, U.tech, 'select 1 from job_orders where id=$1', [jc])).rowCount, 1, 'condition_check');
    await rejects(accept(jc, U.tech), /รับงานได้เฉพาะงานที่ "พร้อมทำ"/);
    await rejects(accept(jq, U.tech), /รับงานได้เฉพาะ|ไม่พบใบงาน/);
    await rpc(U.admin, 'cancel_job', { p_job_id: jc, p_reason: 'ทดสอบ' });
    await rpc(U.admin, 'cancel_job', { p_job_id: jq, p_reason: 'ทดสอบ' });
  });
  await test('แอดมิน: มอบหมายช่าง / เอาช่างออก (ต้องมีเหตุผล) ; ช่างและคลังทำไม่ได้ ; ช่างคนสุดท้ายของงานที่เริ่มแล้วเอาออกไม่ได้', async () => {
    const j = await readyJob('มอบ 1', [{ code: 'AC-CL-004' }]);
    await rejects(rpc(U.tech, 'assign_technician', { p_job_id: j, p_user_id: U.tech }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.wh, 'assign_technician', { p_job_id: j, p_user_id: U.tech }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.admin, 'assign_technician', { p_job_id: j, p_user_id: U.wh }), /ไม่ใช่ช่าง/);
    await rejects(rpc(U.admin, 'assign_technician', { p_job_id: j, p_user_id: U.owner2 }), /ไม่ใช่ช่าง/);
    await rpc(U.admin, 'assign_technician', { p_job_id: j, p_user_id: U.tech2 });
    await rejects(rpc(U.admin, 'assign_technician', { p_job_id: j, p_user_id: U.tech3 }), /ครบแล้ว/);
    await rejects(rpc(U.admin, 'remove_technician', { p_job_id: j, p_user_id: U.tech2, p_reason: ' ' }), /ต้องระบุเหตุผล/);
    await rejects(rpc(U.tech, 'remove_technician', { p_job_id: j, p_user_id: U.tech2, p_reason: 'x' }), /ไม่มีสิทธิ์/);
    await rpc(U.tech2, 'advance_job', { p_job_id: j });   // in_progress
    await rejects(rpc(U.admin, 'remove_technician', { p_job_id: j, p_user_id: U.tech2, p_reason: 'ช่างป่วย' }), /อย่างน้อย 1 คน/);
    await rpc(U.admin, 'remove_technician', { p_job_id: j, p_user_id: U.tech, p_reason: 'ไม่มีคนนี้อยู่แล้ว' }).then(
      () => { throw new Error('ต้องไม่ผ่าน: tech ไม่ได้อยู่ในงานนี้'); }, (e) => ok(/ไม่ได้รับงานนี้/.test(e.message), e.message));
    // เปลี่ยนตัว: มอบหมายคนใหม่ไม่ได้เพราะเต็ม → ปล่อยคนเดิมไม่ได้ (ต้องมี ≥1) ; ผ่านการยกเลิก/ย้อนสถานะแทน
    await rpc(U.admin, 'cancel_job', { p_job_id: j, p_reason: 'ทดสอบ' });
    eq((await activeCrew(j)).length, 0, 'ยกเลิกใบงานต้องปล่อยช่างทั้งหมด');
  });
  await test('บอร์ดช่าง ว่าง/มีงาน/กำลังทำ (เฉพาะ owner/admin) คำนวณจากงานที่รับอยู่จริง', async () => {
    await sq("update job_assignments set released_at = now(), release_reason = 'ล้างก่อนเทสต์บอร์ด' where released_at is null");
    const st = async (u) => Object.fromEntries((await rpc(u, 'technician_board', {}, { table: true })).map((r) => [r.user_id, r.state]));
    const board = async (u) => { const m = await st(u); return [m[U.tech], m[U.tech2], m[U.tech3], m[U.tech4]]; };
    eq(await board(U.admin), ['free', 'free', 'free', 'free']);
    const j = await readyJob('บอร์ด 1', [{ code: 'AC-CL-004' }]);
    await accept(j, U.tech2);
    eq(await board(U.owner), ['free', 'assigned', 'free', 'free']);
    await rpc(U.tech2, 'advance_job', { p_job_id: j });
    eq(await board(U.admin), ['free', 'busy', 'free', 'free']);
    const jobs = (await rpc(U.admin, 'technician_board', {}, { table: true })).find((r) => r.user_id === U.tech2).jobs;
    eq([jobs.length, jobs[0].job_id, jobs[0].status], [1, j, 'in_progress']);
    await rejects(rpc(U.tech, 'technician_board', {}, { table: true }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.wh, 'technician_board', {}, { table: true }), /ไม่มีสิทธิ์/);
    await rpc(U.tech2, 'advance_job', { p_job_id: j });   // qc → ช่างไม่ "busy" แล้ว แต่ยังผูกกับงาน
    eq(await board(U.admin), ['free', 'free', 'free', 'free']);
    await rpc(U.admin, 'qc_pass', { p_job_id: j, p_answers: QC_OK });
  });
  await test('ย้อนสถานะต่ำกว่า "พร้อมทำ" หรือยกเลิกใบงาน → ปล่อยช่างทุกคนอัตโนมัติ พร้อมเหตุผล', async () => {
    const j = await readyJob('ย้อน2', [{ code: 'AC-CL-004' }]);
    await accept(j, U.tech);
    await rpc(U.admin, 'revert_job', { p_job_id: j, p_target: 'requisition', p_reason: 'รออะไหล่เพิ่ม' });
    eq((await activeCrew(j)).length, 0);
    const rel = await one('select release_reason from job_assignments where job_id=$1', [j]);
    ok(/ย้อนสถานะ: รออะไหล่เพิ่ม/.test(rel.release_reason), rel.release_reason);
    eq((await as(sup, U.tech, 'select 1 from job_orders where id=$1', [j])).rowCount, 0, 'ขั้นเบิกอะไหล่ ช่างไม่เห็น');
    eq(await rpc(U.admin, 'advance_job', { p_job_id: j }), 'ready');
    await accept(j, U.tech2);
    await rpc(U.admin, 'cancel_job', { p_job_id: j, p_reason: 'ลูกค้ายกเลิก' });
    eq((await activeCrew(j)).length, 0);
  });
  await test('job_assignments: ช่างอ่านได้ในสาขา (เพื่อโชว์เพื่อนร่วมทีม) ; คลังอ่านไม่ได้ ; ทุกบทบาทเขียนตรงไม่ได้', async () => {
    ok((await as(sup, U.tech3, 'select 1 from job_assignments')).rowCount > 0);
    eq((await as(sup, U.wh, 'select 1 from job_assignments')).rowCount, 0);
    eq((await as(sup, U.owner2, 'select 1 from job_assignments')).rowCount, 0);
    for (const u of [U.tech, U.admin, U.owner]) {
      await rejects(as(sup, u, 'update job_assignments set released_at = now()'), /permission denied/);
      await rejects(as(sup, u, 'delete from job_assignments'), /permission denied/);
      await rejects(as(sup, u, 'insert into job_assignments(branch_id, job_id, user_id) select branch_id, id, $1 from job_orders limit 1', [u]), /permission denied/);
    }
    await rejects(sup.query('delete from job_assignments'), /ห้ามลบข้อมูล/);
  });
  await test('status_changed_at ขยับเฉพาะตอนสถานะเปลี่ยน (ใช้เรียงบอร์ด/แสดง "รอมากี่นาที")', async () => {
    const j = await newJob('เวลา 1');
    const t0 = (await one('select status_changed_at::text as t from job_orders where id=$1', [j])).t;   // เป็น text เพื่อไม่ให้ JS ตัดไมโครวินาที
    await sq('select pg_sleep(0.05)');
    await sq("update job_orders set complaint = 'แก้ข้อความ' where id=$1", [j]);
    eq((await one('select status_changed_at = $2::timestamptz as same from job_orders where id=$1', [j, t0])).same, true);
    await rpc(U.admin, 'advance_job', { p_job_id: j });
    ok((await one('select status_changed_at > $2::timestamptz as moved from job_orders where id=$1', [j, t0])).moved, 'ต้องขยับ');
    await rpc(U.admin, 'cancel_job', { p_job_id: j, p_reason: 'ทดสอบ' });
  });

  // =====================================================================
  group('12. เบิกอะไหล่: สร้างคำขอจากบรรทัดอะไหล่ → คลังจัดเตรียม/ส่งมอบ → ใบงานไป "พร้อมทำ" เอง');
  let jq1, rq1;
  await test('อนุมัติใบเสนอราคา → ระบบสร้างคำขอเบิก 1 ใบ รวมอะไหล่ทุกบรรทัด (ค่าแรงไม่เข้า) พร้อม snapshot เลขใบงาน/ทะเบียน', async () => {
    jq1 = await quotedJob('เบิก 1', [{ code: 'PT-AC-003' }, { code: 'PT-BT-001', attrs: BT }, { code: 'AC-CL-004' }]);
    eq((await sq('select 1 from requisitions where job_id=$1', [jq1])).length, 0, 'ยังไม่อนุมัติ → ยังไม่มีคำขอ');
    await rpc(U.admin, 'approve_quote', { p_job_id: jq1 });
    const rs = await sq('select * from requisitions where job_id=$1', [jq1]);
    eq(rs.length, 1); rq1 = rs[0].id;
    eq(rs[0].status, 'requested');
    ok(/^RQ-\d{8}-\d{3}$/.test(rs[0].req_no), rs[0].req_no);
    const jn = await one('select j.job_no, v.plate from job_orders j join vehicles v on v.id=j.vehicle_id where j.id=$1', [jq1]);
    eq([rs[0].job_no, rs[0].plate], [jn.job_no, jn.plate]);
    const ls = await sq('select item_code, qty::float q, attributes from requisition_lines where requisition_id=$1 order by item_code', [rq1]);
    eq(ls.map((l) => [l.item_code, l.q]), [['PT-AC-003', 1], ['PT-BT-001', 1]]);
    eq(ls[1].attributes['ขนาด'], '55D23L');
    eq(await statusOf(jq1), 'requisition');
  });
  await test('คลังเห็นคำขอ+รายการ (ไม่มีราคา) ; ช่าง/สาขาอื่น/anon ไม่เห็น ; คลังยังไม่เห็นใบงาน/การเงิน', async () => {
    const cols = (await sq("select column_name from information_schema.columns where table_name='requisition_lines'")).map((c) => c.column_name);
    ok(!cols.some((c) => /price|cost|total|amount/.test(c)), 'requisition_lines ต้องไม่มีคอลัมน์ราคา: ' + cols);
    for (const u of [U.wh, U.admin, U.owner]) {
      eq((await as(sup, u, 'select 1 from requisitions where id=$1', [rq1])).rowCount, 1);
      eq((await as(sup, u, 'select 1 from requisition_lines where requisition_id=$1', [rq1])).rowCount, 2);
    }
    for (const u of [U.tech, U.owner2]) {
      eq((await as(sup, u, 'select 1 from requisitions')).rowCount, 0);
      eq((await as(sup, u, 'select 1 from requisition_lines')).rowCount, 0);
    }
    await rejects(as(sup, 'anon', 'select 1 from requisitions'), /permission denied/);
    eq((await as(sup, U.wh, 'select 1 from job_orders')).rowCount, 0);
  });
  await test('ช่าง/สาขาอื่นเลื่อนคำขอไม่ได้ ; คลัง/แอดมินแก้ตารางตรง ๆ ไม่ได้ (ต้องผ่าน RPC)', async () => {
    await rejects(rpc(U.tech, 'advance_requisition', { p_req_id: rq1 }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.owner2, 'advance_requisition', { p_req_id: rq1 }), /ไม่พบคำขอเบิก/);
    for (const u of [U.wh, U.admin]) {
      await rejects(as(sup, u, "update requisitions set status = 'delivered'"), /permission denied/);
      await rejects(as(sup, u, 'delete from requisitions'), /permission denied/);
      await rejects(as(sup, u, 'update requisition_lines set qty = 99'), /permission denied/);
    }
  });
  await test('requested → prepared → (ถอยกลับต้องมีเหตุผล) → prepared → delivered ; ส่งมอบครบ → ใบงาน ready พร้อมบันทึกเหตุผล', async () => {
    eq(await rpc(U.wh, 'advance_requisition', { p_req_id: rq1 }), 'prepared');
    const r = await one('select prepared_by, prepared_at from requisitions where id=$1', [rq1]);
    eq(r.prepared_by, U.wh); ok(r.prepared_at, 'prepared_at');
    eq(await statusOf(jq1), 'requisition', 'ยังไม่ส่งมอบ ใบงานต้องยังรออะไหล่');
    await rejects(rpc(U.wh, 'revert_requisition', { p_req_id: rq1, p_reason: '' }), /ต้องระบุเหตุผล/);
    await rpc(U.wh, 'revert_requisition', { p_req_id: rq1, p_reason: 'กดผิดใบ' });
    eq((await one('select status, prepared_at from requisitions where id=$1', [rq1])).status, 'requested');
    await rejects(rpc(U.wh, 'revert_requisition', { p_req_id: rq1, p_reason: 'ซ้ำ' }), /ถอยได้เฉพาะ/);
    await rpc(U.wh, 'advance_requisition', { p_req_id: rq1 });
    eq(await rpc(U.wh, 'advance_requisition', { p_req_id: rq1 }), 'delivered');
    eq(await statusOf(jq1), 'ready');
    const log = await one("select reason from job_status_log where job_id=$1 and to_status='ready'", [jq1]);
    ok(/คลังส่งมอบอะไหล่ครบ \(RQ-/.test(log.reason), log.reason);
    await rejects(rpc(U.wh, 'advance_requisition', { p_req_id: rq1 }), /ส่งมอบแล้ว/);
    await rejects(rpc(U.admin, 'cancel_requisition', { p_req_id: rq1, p_reason: 'x' }), /ยกเลิกได้เฉพาะคำขอที่ยังไม่ส่งมอบ/);
    await rejects(rpc(U.wh, 'revert_requisition', { p_req_id: rq1, p_reason: 'x' }), /ถอยได้เฉพาะ/);
  });
  await test('ย้อนไปเสนอราคาแล้วเพิ่ม/เพิ่มจำนวนอะไหล่ → อนุมัติใหม่ ขอเบิกเฉพาะส่วนที่ขาด', async () => {
    await rpc(U.admin, 'revert_job', { p_job_id: jq1, p_target: 'quoting', p_reason: 'ลูกค้าเพิ่มอะไหล่' });
    const l = await one("select id from job_items where job_id=$1 and item_code='PT-AC-003'", [jq1]);
    await rpc(U.admin, 'set_job_item_qty', { p_line_id: l.id, p_qty: 3 });            // เดิมส่งมอบ 1 → ขาด 2
    await rpc(U.admin, 'approve_quote', { p_job_id: jq1 });
    const rs = await sq("select id, status from requisitions where job_id=$1 and status <> 'void' order by created_at", [jq1]);
    eq(rs.map((r) => r.status), ['delivered', 'requested']);
    const ls = await sq('select item_code, qty::float q from requisition_lines where requisition_id=$1 order by item_code', [rs[1].id]);
    eq(ls.map((x) => [x.item_code, x.q]), [['PT-AC-003', 2]], 'ต้องขอเฉพาะส่วนที่ขาด (3 − ส่งมอบแล้ว 1) และไม่ขอ PT-BT-001 ซ้ำ');
    await deliverParts(jq1);
    eq(await statusOf(jq1), 'ready');
  });
  await test('ย้อนสถานะขณะคำขอยังค้าง → คำขอถูก void อัตโนมัติ พร้อมเหตุผล ; อนุมัติใหม่ได้คำขอใหม่', async () => {
    const j = await quotedJob('เบิก 2', [{ code: 'PT-AC-003' }]);
    await rpc(U.admin, 'approve_quote', { p_job_id: j });
    const r1 = await one("select id from requisitions where job_id=$1 and status='requested'", [j]);
    await rpc(U.wh, 'advance_requisition', { p_req_id: r1.id });                     // prepared แล้ว
    await rpc(U.admin, 'revert_job', { p_job_id: j, p_target: 'quoting', p_reason: 'ลูกค้ายังไม่ตกลง' });
    const v = await one('select status, void_reason, voided_by from requisitions where id=$1', [r1.id]);
    eq(v.status, 'void'); ok(/ย้อนสถานะ: ลูกค้ายังไม่ตกลง/.test(v.void_reason), v.void_reason);
    await rpc(U.admin, 'approve_quote', { p_job_id: j });
    eq((await sq("select 1 from requisitions where job_id=$1 and status='requested'", [j])).length, 1);
    await rejects(rpc(U.wh, 'advance_requisition', { p_req_id: r1.id }), /ยกเลิกแล้ว/);
    // ยกเลิกคำขอเอง: คลังทำไม่ได้ ; แอดมินต้องมีเหตุผล ; ยกเลิกแล้วใบงานไปต่อได้
    const r2 = await one("select id from requisitions where job_id=$1 and status='requested'", [j]);
    await rejects(rpc(U.wh, 'cancel_requisition', { p_req_id: r2.id, p_reason: 'x' }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.admin, 'cancel_requisition', { p_req_id: r2.id, p_reason: ' ' }), /ต้องระบุเหตุผล/);
    await rejects(rpc(U.admin, 'advance_job', { p_job_id: j }), /คำขอเบิกอะไหล่ที่คลังยังไม่ส่งมอบ/);
    await rpc(U.admin, 'cancel_requisition', { p_req_id: r2.id, p_reason: 'ซื้ออะไหล่จากร้านอื่นแทน' });
    eq(await rpc(U.admin, 'advance_job', { p_job_id: j }), 'ready');
    await rpc(U.admin, 'cancel_job', { p_job_id: j, p_reason: 'ทดสอบ' });
  });
  await test('ใบงานไม่มีอะไหล่ → ไม่มีคำขอ ; แอดมินกดผ่านขั้นเบิกอะไหล่ได้เอง', async () => {
    const j = await quotedJob('เบิก 3', [{ code: 'AC-CL-004' }]);
    await rpc(U.admin, 'approve_quote', { p_job_id: j });
    eq((await sq('select 1 from requisitions where job_id=$1', [j])).length, 0);
    eq(await rpc(U.admin, 'advance_job', { p_job_id: j }), 'ready');
    await rpc(U.admin, 'cancel_job', { p_job_id: j, p_reason: 'ทดสอบ' });
  });
  await test('รายการเบิกแก้/ลบย้อนหลังไม่ได้ แม้ superuser ; มี audit log', async () => {
    await rejects(sup.query('update requisition_lines set qty = qty + 1'), /แก้ไขย้อนหลังไม่ได้/);
    await rejects(sup.query('delete from requisition_lines'), /ห้ามลบข้อมูล/);
    await rejects(sup.query('delete from requisitions'), /ห้ามลบข้อมูล/);
    const a = await one("select count(*)::int c from audit_logs where table_name='requisitions' and record_id=$1", [rq1]);
    ok(a.c >= 4, `audit ของคำขอเบิก ${a.c}`);
  });

  // =====================================================================
  group('13. QC จริง: ผ่าน/ไม่ผ่านพร้อมเหตุผล+รูป, บันทึกถาวร');
  let jqc;
  await test('รายการตรวจ QC มาตรฐาน 4 ข้อ ; ผ่านได้ต้องติ๊กครบทุกข้อ', async () => {
    eq((await one('select jsonb_array_length(qc_checklist()) n')).n, 4);
    jqc = await quotedJob('QC 1', [{ code: 'AC-CL-004' }]);
    await rejects(rpc(U.admin, 'qc_pass', { p_job_id: jqc, p_answers: QC_OK }), /เฉพาะสถานะ "รอ QC"/);
    await driveToQc(jqc);
    eq(await statusOf(jqc), 'qc');
    await rejects(rpc(U.admin, 'qc_pass', { p_job_id: jqc, p_answers: { work_done: true } }), /ยังไม่ผ่านข้อ/);
    await rejects(rpc(U.admin, 'qc_pass', { p_job_id: jqc, p_answers: { ...QC_OK, clean: false } }), /ยังไม่ผ่านข้อ "ทำความสะอาด/);
    await rejects(rpc(U.admin, 'qc_pass', { p_job_id: jqc, p_answers: '"abc"' }), /รูปแบบผลตรวจ/);
    await rejects(rpc(U.admin, 'qc_pass', { p_job_id: jqc, p_answers: QC_OK, p_photos: [`${B2}/x/y.jpg`] }), /ตำแหน่งไฟล์รูป QC/);
    await rejects(rpc(U.admin, 'qc_pass', { p_job_id: jqc, p_answers: QC_OK, p_photos: [`${B}/${jr1}/qc/1.jpg`] }), /ตำแหน่งไฟล์รูป QC/);
    eq((await sq('select 1 from qc_checks where job_id=$1', [jqc])).length, 0, 'ล้มเหลวแล้วต้องไม่มีบันทึกค้าง');
  });
  await test('QC ไม่ผ่าน: ต้องมีเหตุผล → ใบงานกลับ "กำลังทำ" ช่างเดิมยังผูกงาน ; ส่ง QC ใหม่ได้', async () => {
    await rejects(rpc(U.admin, 'qc_fail', { p_job_id: jqc, p_note: '  ' }), /ต้องระบุเหตุผล/);
    await rejects(rpc(U.tech, 'qc_fail', { p_job_id: jqc, p_note: 'x' }), /ไม่มีสิทธิ์/);
    await rpc(U.admin, 'qc_fail', { p_job_id: jqc, p_note: 'แอร์ยังไม่เย็นพอ ตรวจน้ำยา', p_photos: [`${B}/${jqc}/qc/f1.jpg`], p_answers: { ...QC_OK, function_ok: false } });
    const j = await one('select status, qc_passed_at from job_orders where id=$1', [jqc]);
    eq([j.status, j.qc_passed_at], ['in_progress', null]);
    eq(await activeCrew(jqc), [U.tech]);
    await rejects(rpc(U.admin, 'qc_fail', { p_job_id: jqc, p_note: 'ซ้ำ' }), /เฉพาะสถานะ "รอ QC"/);
    await rejects(rpc(U.admin, 'close_job', { p_job_id: jqc }), /รอชำระ/);
    const log = await one("select reason from job_status_log where job_id=$1 and to_status='in_progress' order by id desc limit 1", [jqc]);
    ok(/QC ไม่ผ่าน: แอร์ยังไม่เย็นพอ/.test(log.reason), log.reason);
    eq(await rpc(U.tech, 'advance_job', { p_job_id: jqc }), 'qc');
  });
  await test('QC ผ่านรอบสอง → รอชำระ ; ประวัติ QC เก็บทั้งรอบที่ไม่ผ่านและผ่าน และแก้/ลบไม่ได้', async () => {
    await rpc(U.admin, 'qc_pass', { p_job_id: jqc, p_answers: QC_OK, p_note: 'เย็นดี 8°C', p_photos: [`${B}/${jqc}/qc/p1.jpg`] });
    eq(await statusOf(jqc), 'awaiting_payment');
    const h = await sq('select result, note, photo_paths, checked_by from qc_checks where job_id=$1 order by checked_at, created_at', [jqc]);
    eq(h.map((x) => x.result), ['fail', 'pass']);
    eq(h[0].note, 'แอร์ยังไม่เย็นพอ ตรวจน้ำยา'); eq(h[1].photo_paths, [`${B}/${jqc}/qc/p1.jpg`]);
    eq(h.map((x) => x.checked_by), [U.admin, U.admin]);
    await rejects(sup.query('update qc_checks set result = $1', ['pass']), /แก้ไขย้อนหลังไม่ได้/);
    await rejects(sup.query('delete from qc_checks'), /ห้ามลบข้อมูล/);
    for (const u of [U.admin, U.owner]) eq((await as(sup, u, 'select 1 from qc_checks where job_id=$1', [jqc])).rowCount, 2);
    for (const u of [U.tech, U.wh, U.owner2]) eq((await as(sup, u, 'select 1 from qc_checks')).rowCount, 0);
    await rejects(as(sup, U.admin, "insert into qc_checks(branch_id, job_id, result) values ($1, $2, 'pass')", [B, jqc]), /permission denied/);
    await payAndClose(jqc);
    eq(await statusOf(jqc), 'closed');
  });

  // =====================================================================
  group('14. ค่าแรงช่าง = labor_rate × จำนวน ÷ ช่างที่ทำจริง (คิดตอนปิดงาน) ; ช่างเห็นเฉพาะของตัวเอง');
  let jl1, jl2, jl3;
  const labor = (j) => sq('select u.full_name n, e.amount::float a, e.crew_actual c, e.item_name from labor_pay_entries e join users u on u.id=e.user_id where e.job_id=$1 and e.voided_at is null order by u.full_name, e.amount', [j]);
  await test('ใบงานต้องใช้ 2 ช่าง (ค่าแรง 400 + 100): ยังไม่มีค่าแรงจนกว่าจะปิดงาน ; ปิดแล้วช่างแต่ละคนได้ 200+50 = 250', async () => {
    jl1 = await readyJob('แรง 1', [{ code: 'AC-CL-001' }, { code: 'AC-CL-004' }]);
    await accept(jl1, U.tech); await accept(jl1, U.tech2);
    await rpc(U.tech, 'advance_job', { p_job_id: jl1 }); await rpc(U.tech2, 'advance_job', { p_job_id: jl1 });
    await rpc(U.admin, 'qc_pass', { p_job_id: jl1, p_answers: QC_OK });
    eq((await labor(jl1)).length, 0, 'ก่อนปิดงานยังไม่คิดค่าแรง');
    await payAndClose(jl1);
    const l = await labor(jl1);
    eq(l.length, 4);
    eq(l.filter((x) => x.n === 'ช่างหนุ่ม').map((x) => x.a).sort((a, b) => a - b), [50, 200]);
    eq(l.filter((x) => x.n === 'ช่างกิ้ม').map((x) => x.a).sort((a, b) => a - b), [50, 200]);
    ok(l.every((x) => x.c === 2), 'crew_actual ต้องเป็น 2');
    eq(l.reduce((s, x) => s + x.a, 0), 500, 'ผลรวม = 400×1 + 100×1');
    eq((await one('select min(earned_on)::text d, max(earned_on)::text e from labor_pay_entries where job_id=$1', [jl1])).d, await today());
  });
  await test('หาร 3 คนไม่ลงตัว (100 ÷ 3): ผลรวมเท่ากับ 100 พอดี เศษสตางค์ให้คนรับงานก่อน', async () => {
    jl2 = await readyJob('แรง 2', [{ code: 'AC-DG-002' }]);
    await accept(jl2, U.tech); await accept(jl2, U.tech2); await accept(jl2, U.tech3);
    await rpc(U.tech, 'advance_job', { p_job_id: jl2 }); await rpc(U.tech, 'advance_job', { p_job_id: jl2 });
    await rpc(U.admin, 'qc_pass', { p_job_id: jl2, p_answers: QC_OK });
    await payAndClose(jl2);
    const l = await labor(jl2);
    eq(l.map((x) => [x.n, x.a]), [['ช่างหนุ่ม', 33.34], ['ช่างกิ้ม', 33.33], ['ช่างริด', 33.33]]);
    eq(Math.round(l.reduce((s, x) => s + x.a, 0) * 100), 10000);
  });
  await test('ต้องการ 2 ช่างแต่ทำจริงคนเดียว → ได้เต็ม (หารด้วยคนที่ทำจริง) ; คูณจำนวน (qty)', async () => {
    jl3 = await quotedJob('แรง 3', [{ code: 'AC-CL-001' }, { code: 'AC-CL-004', qty: 3 }]);
    await driveToQc(jl3, U.tech2);
    await rpc(U.admin, 'qc_pass', { p_job_id: jl3, p_answers: QC_OK });
    await payAndClose(jl3);
    const l = await labor(jl3);
    eq(l.map((x) => [x.n, x.c, x.a]).sort((a, b) => a[2] - b[2]), [['ช่างกิ้ม', 1, 300], ['ช่างกิ้ม', 1, 400]]);
  });
  await test('บรรทัดที่ labor_rate = 0 และอะไหล่ ไม่สร้างค่าแรง', async () => {
    const j = await quotedJob('แรง 4', [{ code: 'PT-AC-003' }, { code: 'AC-CL-004' }]);
    await driveToQc(j, U.tech3);
    await rpc(U.admin, 'qc_pass', { p_job_id: j, p_answers: QC_OK });
    await payAndClose(j);
    const l = await labor(j);
    eq(l.map((x) => [x.n, x.a, x.item_name]).length, 1);
    eq(l[0].a, 100);
  });
  await test('ช่างเห็นค่าแรงเฉพาะของตัวเอง ; owner เห็นทั้งหมด ; admin/คลัง/สาขาอื่นไม่เห็น ; ไม่มีราคาขายรั่ว', async () => {
    for (const [name, uid] of [['tech', U.tech], ['tech2', U.tech2], ['tech3', U.tech3]]) {
      const r = await as(sup, uid, 'select distinct user_id from labor_pay_entries');
      eq(r.rows.map((x) => x.user_id), [uid], name);
    }
    const all = await as(sup, U.owner, 'select distinct user_id from labor_pay_entries');
    eq(all.rowCount, 3);
    for (const u of [U.admin, U.wh, U.owner2]) eq((await as(sup, u, 'select 1 from labor_pay_entries')).rowCount, 0);
    await rejects(as(sup, 'anon', 'select 1 from labor_pay_entries'), /permission denied/);
    const cols = (await sq("select column_name from information_schema.columns where table_name='labor_pay_entries'")).map((c) => c.column_name);
    ok(!cols.includes('unit_price') && !cols.includes('line_total') && !cols.includes('customer_id'), 'ต้องไม่มีราคาขาย/ลูกค้า: ' + cols);
    for (const u of [U.tech, U.admin, U.owner]) {
      await rejects(as(sup, u, 'update labor_pay_entries set amount = 9999'), /permission denied/);
      await rejects(as(sup, u, 'delete from labor_pay_entries'), /permission denied/);
    }
    await rejects(sup.query('delete from labor_pay_entries'), /ห้ามลบข้อมูล/);
  });
  await test('owner ทำเครื่องหมาย "จ่ายแล้ว" รายช่าง/ช่วงวัน (ไม่นับซ้ำ) ; ยกเลิกต้องมีเหตุผล ; คนอื่นทำไม่ได้', async () => {
    const d = await today();
    for (const u of [U.admin, U.tech, U.wh]) await rejects(rpc(u, 'mark_labor_paid', { p_user_id: U.tech, p_from: d, p_to: d }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.owner, 'mark_labor_paid', { p_user_id: U.tech, p_from: d, p_to: '2000-01-01' }), /ช่วงวันที่ไม่ถูกต้อง/);
    const unpaid = async (u) => (await one('select count(*)::int c, coalesce(sum(amount),0)::float s from labor_pay_entries where user_id=$1 and paid_at is null and voided_at is null', [u]));
    const t1 = await unpaid(U.tech), t2 = await unpaid(U.tech2);
    ok(t1.c > 0 && t2.c > 0, 'ต้องมีค่าแรงค้างจ่าย');
    eq(await rpc(U.owner, 'mark_labor_paid', { p_user_id: U.tech, p_from: d, p_to: d, p_note: 'จ่ายสิ้นวัน' }), t1.c);
    eq(await rpc(U.owner, 'mark_labor_paid', { p_user_id: U.tech, p_from: d, p_to: d }), 0, 'ครั้งที่สองต้องไม่มีอะไรให้จ่ายซ้ำ');
    eq((await unpaid(U.tech2)).c, t2.c, 'ไม่กระทบช่างคนอื่น');
    const mine = await as(sup, U.tech, 'select paid_at is not null as paid from labor_pay_entries');
    ok(mine.rows.every((r) => r.paid), 'ช่างต้องเห็นสถานะจ่ายแล้วของตัวเอง');
    await rejects(rpc(U.owner, 'unmark_labor_paid', { p_user_id: U.tech, p_from: d, p_to: d, p_reason: '' }), /ต้องระบุเหตุผล/);
    await rejects(rpc(U.admin, 'unmark_labor_paid', { p_user_id: U.tech, p_from: d, p_to: d, p_reason: 'x' }), /ไม่มีสิทธิ์/);
    eq(await rpc(U.owner, 'unmark_labor_paid', { p_user_id: U.tech, p_from: d, p_to: d, p_reason: 'กดผิดช่าง' }), t1.c);
    eq((await unpaid(U.tech)).c, t1.c);
    const a = await one("select reason, actor from audit_logs where table_name='labor_pay_entries' and action='UPDATE' order by id desc limit 1");
    eq([a.reason, a.actor], ['กดผิดช่าง', U.owner]);
  });
  await test('void ใบงานที่ปิดแล้ว → ค่าแรงของใบงานนั้นถูก void ตาม (ข้อมูลไม่หาย) และไม่ถูกนับเป็นค้างจ่าย', async () => {
    const before = (await sq('select 1 from labor_pay_entries where job_id=$1', [jl3])).length;
    ok(before === 2, 'jl3 ควรมี 2 รายการ');
    const p = await one('select id from payments where job_id=$1 and voided_at is null', [jl3]);
    await rpc(U.owner, 'void_payment', { p_payment_id: p.id, p_reason: 'บันทึกผิดใบ' });
    await rpc(U.owner, 'void_job', { p_job_id: jl3, p_reason: 'บันทึกผิดใบ' });
    eq((await sq('select 1 from labor_pay_entries where job_id=$1', [jl3])).length, 2);
    eq((await labor(jl3)).length, 0, 'ไม่มีรายการที่ยังใช้ได้');
    const v = await one('select void_reason, voided_at from labor_pay_entries where job_id=$1 limit 1', [jl3]);
    ok(/void ใบงาน: บันทึกผิดใบ/.test(v.void_reason) && v.voided_at, v.void_reason);
    const d = await today();
    eq(await rpc(U.owner, 'mark_labor_paid', { p_user_id: U.tech2, p_from: d, p_to: d }) >= 0, true);
    eq((await one('select count(*)::int c from labor_pay_entries where job_id=$1 and paid_at is not null', [jl3])).c, 0, 'รายการที่ void ห้ามถูกทำเครื่องหมายจ่าย');
  });

  // =====================================================================
  group('15. คืนเงิน / คืนมัดจำ (flow จริง ไม่ใช่แค่ void)');
  let jf1;
  await test('คืนเงินมัดจำบางส่วน: เฉพาะ owner/admin, ต้องมีเหตุผล, ห้ามเกินที่รับ, QR/โอนต้องมีสลิป ; ยอดสุทธิคำนวณหักคืนแล้ว', async () => {
    jf1 = await quotedJob('คืน 1', [{ code: 'AC-CL-004' }]);   // ยอดบิล 600
    await rpc(U.admin, 'record_payment', { p_job_id: jf1, p_kind: 'deposit', p_method: 'cash', p_amount: 500 });
    const refund = (args, uid = U.admin) => rpc(uid, 'refund_job_payment', { p_job_id: jf1, p_method: 'cash', p_amount: 100, p_reason: 'ลูกค้าขอคืนบางส่วน', ...args });
    for (const u of [U.tech, U.wh]) await rejects(refund({}, u), /ไม่มีสิทธิ์/);
    await rejects(refund({ p_reason: '  ' }), /ต้องระบุเหตุผล/);
    await rejects(refund({ p_amount: 0 }), /มากกว่า 0/);
    await rejects(refund({ p_amount: -5 }), /มากกว่า 0/);
    await rejects(refund({ p_amount: 500.01 }), /คืนเกินยอดที่รับไว้/);
    await rejects(refund({ p_method: 'transfer' }), /แนบสลิป/);
    await rejects(refund({ p_method: 'qr_promptpay', p_slip_path: `${B2}/x/slip/r.jpg` }), /แนบสลิป/);
    await refund({ p_amount: 200 });
    const t = await jobTotals(jf1);
    eq([Number(t.paid_total), Number(t.refunded_total), Number(t.balance), t.payment_status], [300, 200, 300, 'partial']);
  });
  await test('ยกเลิกใบงานที่ยังมียอดสุทธิค้างอยู่ไม่ได้ → ต้องคืนเงินให้ครบก่อน (โอนคืนแนบสลิป) แล้วยกเลิกได้', async () => {
    await rejects(rpc(U.admin, 'cancel_job', { p_job_id: jf1, p_reason: 'ลูกค้าไม่ทำ' }), /ยังมียอดรับชำระคงเหลือ ฿300.*คืนเงิน/);
    await rpc(U.admin, 'refund_job_payment', { p_job_id: jf1, p_method: 'transfer', p_amount: 300, p_reason: 'คืนที่เหลือทั้งหมด', p_reference: 'KBANK-123', p_slip_path: `${B}/${jf1}/slip/refund1.jpg` });
    const t = await jobTotals(jf1);
    eq([Number(t.paid_total), Number(t.refunded_total), t.payment_status], [0, 500, 'unpaid']);
    await rpc(U.admin, 'cancel_job', { p_job_id: jf1, p_reason: 'ลูกค้าไม่ทำ' });
    eq(await statusOf(jf1), 'cancelled');
    await rejects(rpc(U.admin, 'refund_job_payment', { p_job_id: jf1, p_method: 'cash', p_amount: 1, p_reason: 'x' }), /ปิด\/ยกเลิกแล้ว/);
  });
  await test('ใบงานที่ปิดแล้วคืนเงินผ่านระบบไม่ได้ (ต้อง owner void) ; ช่าง/คลัง/สาขาอื่นมองไม่เห็นรายการคืนเงิน ; ลบ/แก้ตรงไม่ได้', async () => {
    await rejects(rpc(U.admin, 'refund_job_payment', { p_job_id: jobA, p_method: 'cash', p_amount: 1, p_reason: 'x' }), /ปิด\/ยกเลิกแล้ว/);
    for (const u of [U.admin, U.owner]) ok((await as(sup, u, 'select 1 from refunds')).rowCount >= 2, 'owner/admin ต้องเห็นรายการคืนเงิน');
    for (const u of [U.tech, U.wh, U.owner2]) eq((await as(sup, u, 'select 1 from refunds')).rowCount, 0);
    for (const u of [U.admin, U.owner]) {
      await rejects(as(sup, u, 'update refunds set amount = 1'), /permission denied/);
      await rejects(as(sup, u, 'delete from refunds'), /permission denied/);
      await rejects(as(sup, u, 'insert into refunds(branch_id, job_id, method, amount, reason) select branch_id, id, $1, 1, $2 from job_orders limit 1', ['cash', 'x']), /permission denied/);
    }
    await rejects(sup.query('delete from refunds'), /ห้ามลบข้อมูล/);
    const a = await one("select reason, actor from audit_logs where table_name='refunds' and action='INSERT' order by id desc limit 1");
    eq([a.reason, a.actor], ['คืนที่เหลือทั้งหมด', U.admin]);
  });
  await test('void รายการคืนเงิน: เฉพาะ owner + เหตุผล ; void การรับเงินที่ทำให้ยอดสุทธิติดลบไม่ได้ ; void คืนเงินที่ทำให้รับเกินบิลไม่ได้', async () => {
    const j = await quotedJob('คืน 2', [{ code: 'AC-CL-004' }]);  // 600
    const dep = await rpc(U.admin, 'record_payment', { p_job_id: j, p_kind: 'deposit', p_method: 'cash', p_amount: 500 });
    const rf = await rpc(U.admin, 'refund_job_payment', { p_job_id: j, p_method: 'cash', p_amount: 200, p_reason: 'คืนบางส่วน' });
    await rejects(rpc(U.admin, 'void_payment', { p_payment_id: dep, p_reason: 'x' }), /ยอดรับสุทธิจะติดลบ/);
    await rpc(U.admin, 'record_payment', { p_job_id: j, p_kind: 'deposit', p_method: 'cash', p_amount: 300 });   // net 600 = เต็มบิล
    await rejects(rpc(U.owner, 'void_refund', { p_refund_id: rf, p_reason: 'x' }), /เกินยอดบิล/);
    await rejects(rpc(U.admin, 'void_refund', { p_refund_id: rf, p_reason: 'x' }), /ไม่มีสิทธิ์/);
    const p2 = await one("select id from payments where job_id=$1 and amount=300", [j]);
    await rpc(U.admin, 'void_payment', { p_payment_id: p2.id, p_reason: 'รับผิดจำนวน' });
    await rejects(rpc(U.owner, 'void_refund', { p_refund_id: rf, p_reason: '  ' }), /ต้องระบุเหตุผล/);
    await rpc(U.owner, 'void_refund', { p_refund_id: rf, p_reason: 'บันทึกคืนผิดใบ' });
    eq(Number((await jobTotals(j)).paid_total), 500);
    await rejects(rpc(U.owner, 'void_refund', { p_refund_id: rf, p_reason: 'ซ้ำ' }), /ถูก void ไปแล้ว/);
    await rpc(U.admin, 'void_payment', { p_payment_id: dep, p_reason: 'ล้างเพื่อยกเลิก' });
    await rpc(U.admin, 'cancel_job', { p_job_id: j, p_reason: 'ทดสอบ' });
  });
  await test('ปิดงานที่มีทั้งรับมัดจำ→คืนบางส่วน→รับส่วนที่เหลือ: ใบเสร็จมีรายการคืนเงิน และยอดสุทธิ = ยอดบิล', async () => {
    const j = await quotedJob('คืน 3', [{ code: 'AC-CL-004' }]);   // 600
    await rpc(U.admin, 'record_payment', { p_job_id: j, p_kind: 'deposit', p_method: 'cash', p_amount: 500 });
    await rpc(U.admin, 'refund_job_payment', { p_job_id: j, p_method: 'cash', p_amount: 100, p_reason: 'ลูกค้าขอคืนส่วนเกิน' });
    await driveToQc(j, U.tech3);
    await rpc(U.admin, 'qc_pass', { p_job_id: j, p_answers: QC_OK });
    await rejects(rpc(U.admin, 'close_job', { p_job_id: j }), /รับเงินยังไม่ครบ.*200/);
    const rc = await payAndClose(j);
    const r = await one('select snapshot from receipts where id=$1', [rc]);
    eq(r.snapshot.refunds.length, 1); eq(Number(r.snapshot.refunds[0].amount), 100);
    eq(r.snapshot.payments.length, 2);
    eq([Number(r.snapshot.totals.paid_total), Number(r.snapshot.totals.grand_total), Number(r.snapshot.totals.refunded_total)], [600, 600, 100]);
  });

  // =====================================================================
  group('16. วันที่ส่งมอบ + ประกัน + สรุป VAT (ราคารวม VAT แล้ว)');
  let jd1;
  await test('ปิดงานระบุวันที่ส่งมอบย้อนหลังได้ → ใบรับประกันนับจากวันส่งมอบ ไม่ใช่วันปิดงาน', async () => {
    jd1 = await quotedJob('ส่งมอบ 1', [{ code: 'PT-AC-003' }, { code: 'AC-CL-004' }]);   // PT-AC-003 ประกัน 6 เดือน
    await driveToQc(jd1);
    await rpc(U.admin, 'qc_pass', { p_job_id: jd1, p_answers: QC_OK });
    await sq("update job_orders set opened_at = now() - interval '10 days' where id=$1", [jd1]);
    const t = await jobTotals(jd1);
    await rpc(U.admin, 'record_payment', { p_job_id: jd1, p_kind: 'payment', p_method: 'cash', p_amount: Number(t.balance) });
    await rejects(rpc(U.admin, 'close_job', { p_job_id: jd1, p_delivered_on: await daysAgo(11) }), /ไม่ก่อนวันที่เปิดใบงาน/);
    await rejects(rpc(U.admin, 'close_job', { p_job_id: jd1, p_delivered_on: await daysAgo(-8) }), /ล่วงหน้าได้ไม่เกิน 7 วัน/);
    const d3 = await daysAgo(3);
    await rpc(U.admin, 'close_job', { p_job_id: jd1, p_delivered_on: d3 });
    const j = await one('select delivered_on::text d, closed_at::date::text c from job_orders where id=$1', [jd1]);
    eq(j.d, d3);
    const w = await sq('select starts_on::text s, ends_on::text e from warranties where job_id=$1', [jd1]);
    eq(w.length, 1);
    eq(w[0].s, d3);
    eq(w[0].e, (await one("select (($1::date) + interval '6 months')::date::text e", [d3])).e);
  });
  await test('แก้วันที่ส่งมอบหลังปิดงาน: ต้องมีเหตุผล, เฉพาะ owner/admin, เฉพาะใบที่ปิดแล้ว → คำนวณวันสิ้นสุดประกันใหม่ + audit', async () => {
    const d1 = await daysAgo(1);
    await rejects(rpc(U.tech, 'set_delivery_date', { p_job_id: jd1, p_date: d1, p_reason: 'x' }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.admin, 'set_delivery_date', { p_job_id: jd1, p_date: d1, p_reason: ' ' }), /ต้องระบุเหตุผล/);
    await rejects(rpc(U.admin, 'set_delivery_date', { p_job_id: jd1, p_date: await daysAgo(30), p_reason: 'x' }), /ไม่ก่อนวันที่เปิดใบงาน/);
    await rejects(rpc(U.admin, 'set_delivery_date', { p_job_id: jobB, p_date: d1, p_reason: 'x' }), /เฉพาะใบงานที่ปิดแล้ว/);
    await rpc(U.admin, 'set_delivery_date', { p_job_id: jd1, p_date: d1, p_reason: 'ลูกค้ามารับรถเมื่อวาน' });
    const w = await one('select starts_on::text s, ends_on::text e from warranties where job_id=$1', [jd1]);
    eq([w.s, w.e], [d1, (await one("select (($1::date) + interval '6 months')::date::text e", [d1])).e]);
    const a = await one("select reason, actor from audit_logs where table_name='job_orders' and record_id=$1 and action='UPDATE' order by id desc limit 1", [jd1]);
    eq([a.reason, a.actor], ['ลูกค้ามารับรถเมื่อวาน', U.admin]);
  });
  await test('VAT รวมในราคา: เปิด VAT แล้วยอดสุทธิ = ยอดที่ลูกค้าจ่าย, VAT = 7/107 ; ใบเสร็จระบุ "รวม VAT" ; สรุป VAT ของ owner ตรงกับใบงาน', async () => {
    await as(sup, U.owner, 'update branch_settings set vat_enabled = true');
    const j = await quotedJob('แวต 2', [{ code: 'AC-CL-004' }]);                 // 600 รวม VAT แล้ว → VAT 39.25, ก่อน VAT 560.75
    await as(sup, U.owner, 'update branch_settings set vat_enabled = false');
    const t = await jobTotals(j);
    eq([Number(t.net), Number(t.vat), Number(t.ex_vat), Number(t.grand_total)], [600, 39.25, 560.75, 600]);
    await driveToQc(j);
    await rpc(U.admin, 'qc_pass', { p_job_id: j, p_answers: QC_OK });
    const rc = await payAndClose(j);
    const r = await one('select vat_amount, grand_total, snapshot from receipts where id=$1', [rc]);
    eq([Number(r.vat_amount), Number(r.grand_total)], [39.25, 600]);
    eq([r.snapshot.totals.vat_included, Number(r.snapshot.totals.ex_vat)], [true, 560.75]);
    const d = await today();
    const sum = (await rpc(U.owner, 'report_vat_summary', { p_from: d, p_to: d }, { table: true }))[0];
    eq(Number(sum.vat_total), 39.25, 'มีใบงาน VAT ใบเดียวที่ปิดวันนี้');
    eq(Math.round((Number(sum.vat_total) + Number(sum.ex_vat_total)) * 100), Math.round(Number(sum.gross_total) * 100));
    ok(Number(sum.job_count) >= 5, 'นับใบงานที่ปิดวันนี้');
    await rejects(rpc(U.admin, 'report_vat_summary', { p_from: d, p_to: d }, { table: true }), /ไม่มีสิทธิ์/);
    await rejects(rpc(U.tech, 'report_vat_summary', { p_from: d, p_to: d }, { table: true }), /ไม่มีสิทธิ์/);
  });

  // =====================================================================
  group('17. Realtime: ตารางที่หน้าบอร์ดต้องรู้ทันที อยู่ใน publication ; migration รันซ้ำได้');
  await test('supabase_realtime มีครบ 7 ตาราง และ migration 0009 รันซ้ำไม่ error', async () => {
    const want = ['job_assignments', 'job_orders', 'labor_pay_entries', 'payments', 'qc_checks', 'refunds', 'requisitions'];
    const get = async () => (await sq("select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' order by 1")).map((r) => r.tablename);
    eq(await get(), want);
    await sup.query(fs.readFileSync(path.join(root, 'supabase/migrations/0009_realtime.sql'), 'utf8'));
    eq(await get(), want);
    // ตารางที่มีข้อมูลอ่อนไหวเกินความจำเป็นต้องไม่อยู่ใน publication
    for (const t of ['audit_logs', 'customers', 'receipts', 'item_prices']) ok(!(await get()).includes(t), t);
  });
  await test('Realtime ส่งเหตุการณ์ตาม RLS ของผู้ฟัง: ช่าง/คลังอ่านตารางเหล่านี้ได้เท่าที่นโยบายอนุญาตเท่านั้น', async () => {
    eq((await as(sup, U.tech, 'select 1 from payments')).rowCount, 0);
    eq((await as(sup, U.tech, 'select 1 from refunds')).rowCount, 0);
    eq((await as(sup, U.tech, 'select 1 from requisitions')).rowCount, 0);
    eq((await as(sup, U.wh, 'select 1 from job_orders')).rowCount, 0);
    eq((await as(sup, U.wh, 'select 1 from labor_pay_entries')).rowCount, 0);
    ok((await as(sup, U.wh, 'select 1 from requisitions')).rowCount > 0);
  });

  // =====================================================================
  group('17. Qwen: มอบหมายช่างหลายคนต่อหนึ่งงาน (0010 set_job_crew / add_job_crew)');
  /** ใบงานที่พร้อมมอบหมาย + ช่างคนที่ 4 สำหรับทดสอบทีม 4 คน */
  let crewJob;
  await test('เตรียมการ: ใบงาน "พร้อมทำ" (default ต้องใช้ 1 ช่าง) ; ช่าง 4 คนในสาขา (หนุ่ม/กิ้ม/ริด/วี)', async () => {
    eq((await sq("select full_name from users where role='technician' and branch_id = $1 and is_active order by full_name", [B])).map(r=>r.full_name),
       ['ช่างกิ้ม','ช่างริด','ช่างวี','ช่างหนุ่ม'], 'ต้องมีช่าง 4 คนหลังเปลี่ยนชื่อ');
    crewJob = await readyJob('QWEN-CREW-1', [{ code: 'AC-CL-004' }]);   // service ปกติ → ใช้ 1 ช่าง
    eq(await statusOf(crewJob), 'ready');
    eq((await rpc(U.admin, 'job_crew_info', { p_jobs: [crewJob] }, { table: true }))[0].crew_required, 1, 'legacy ยังต้องใช้ 1 คน');
  });
  await test('TASK B: mapping เปลี่ยนชื่อช่าง 1→หนุ่ม / 2→กิ้ม / 3→ริด / 4→วี โดย id เดิมคงอยู่', async () => {
    // migration 0010 ถูก apply ตอนสร้างฐานข้อมูลแล้ว — ตรวจว่า mapping ทำงานบนบัญชีจริง "ช่าง 1..4"
    for (const [name, want] of [['tech', 'ช่างหนุ่ม'], ['tech2', 'ช่างกิ้ม'], ['tech3', 'ช่างริด'], ['tech4', 'ช่างวี']]) {
      const r = await one('select full_name from users where id = $1', [U[name]]);
      eq(r.full_name, want, `ชื่อของ ${name}`);
      ok(U[name], 'id เดิมต้องยังอยู่ (ไม่สร้างบัญชีใหม่)');
    }
    // ชื่ออื่นไม่ถูกกระทบ (ห้ามแก้ช่าง/พนักงานที่ไม่ได้ระบุ)
    eq((await one("select full_name from users where id = $1", [U.owner])).full_name, 'owner');
    eq((await one("select full_name from users where id = $1", [U.wh])).full_name, 'wh');
    // รันซ้ำอีกครั้ง → ไม่มีแถวตรงเงื่อนไขเดิมเหลือ (idempotent จริง)
    await sup.query(fs.readFileSync(path.join(root, 'supabase/migrations/0010_multi_technician_assignment.sql'), 'utf8'));
    eq((await one("select count(*)::int c from users where full_name ~ '^ช่าง ?[1-4]$'")).c, 0, 'ต้องไม่มีชื่อเดิมเหลือ');
    eq((await one('select full_name from users where id = $1', [U.tech])).full_name, 'ช่างหนุ่ม');
  });
  await test('สร้างงานที่มีช่าง 1 คนผ่าน set_job_crew (กรณี legacy — ข้อมูลเดิมเข้ากันได้)', async () => {
    await rpc(U.admin, 'set_job_crew', { p_job_id: crewJob, p_user_ids: [U.tech] });
    eq(await activeCrew(crewJob), [U.tech]);
    const info = (await rpc(U.admin, 'job_crew_info', { p_jobs: [crewJob] }, { table: true }))[0];
    eq([info.crew_required, info.crew_active], [1, 1], 'ทีม 1 คน → required เท่าเดิม (พฤติกรรม legacy คงไว้)');
  });
  await test('ป้องกันรายชื่อซ้ำ: ส่ง id เดียวกันสองครั้งใน array เดียว → บันทึกครั้งเดียว', async () => {
    await rpc(U.admin, 'set_job_crew', { p_job_id: crewJob, p_user_ids: [U.tech, U.tech] });
    eq(await activeCrew(crewJob), [U.tech], 'ห้ามมีแถวซ้ำ');
  });
  await test('แก้ไขรายชื่อ (แทนทั้งทีม): เพิ่มเป็น 2 คน แล้วสลับคน — ประวัติคนเก่าถูกเก็บแบบ soft release', async () => {
    await rpc(U.admin, 'set_job_crew', { p_job_id: crewJob, p_user_ids: [U.tech, U.tech2] });
    eq(await activeCrew(crewJob), [U.tech, U.tech2]);
    const info = (await rpc(U.admin, 'job_crew_info', { p_jobs: [crewJob] }, { table: true }))[0];
    eq([info.crew_required, info.crew_active], [2, 2], 'ผู้ดูแลตั้ง 2 คน → เพดานขยายเป็น 2');
    eq(info.member_names.sort(), ['ช่างกิ้ม', 'ช่างหนุ่ม'], 'แสดงรายชื่อผู้รับผิดชอบครบถ้วน (ชื่อใหม่)');
    // สลับ tech2 ออก ใส่ tech3 เข้า
    await rpc(U.admin, 'set_job_crew', { p_job_id: crewJob, p_user_ids: [U.tech, U.tech3], p_reason: 'สลับทีมทดสอบ' });
    eq(await activeCrew(crewJob), [U.tech, U.tech3]);
    const rel = await one('select released_by, release_reason from job_assignments where job_id = $1 and user_id = $2 and released_at is not null', [crewJob, U.tech2]);
    eq([rel.release_reason], ['สลับทีมทดสอบ'], 'ต้องมีเหตุผลกำกับเหมือน remove_technician เดิม');
    eq((await one('select count(*)::int c from job_assignments where job_id = $1', [crewJob])).c, 3, 'ประวัติห้ามถูกลบ (2 รับ + 1 ปล่อย)');
  });
  await test('add_job_crew เพิ่มหลายคนพร้อมกัน (atomic) ; ซ้ำ/ไม่ใช่ช่าง → ปฏิเสธทั้งก้อน', async () => {
    await rpc(U.owner, 'add_job_crew', { p_job_id: crewJob, p_user_ids: [U.tech2, U.tech4] });
    eq((await activeCrew(crewJob)).sort(), [U.tech, U.tech2, U.tech3, U.tech4].sort());
    await rejects(rpc(U.admin, 'add_job_crew', { p_job_id: crewJob, p_user_ids: [U.tech] }), /รับงานนี้อยู่แล้ว/);
    await rejects(rpc(U.admin, 'add_job_crew', { p_job_id: crewJob, p_user_ids: [U.wh] }), /ไม่ใช่ช่าง/);
    await rejects(rpc(U.tech, 'add_job_crew', { p_job_id: crewJob, p_user_ids: [U.tech4] }), /ไม่มีสิทธิ์|permission|not authorized/i);
  });
  await test('ทีม 4 คน: ตั้งครบ, ลดเหลือ 3 (required ไม่หดย้อนหลัง — กัน race), นำออกทีละคนจนเหลือ 1', async () => {
    const j4 = await readyJob('QWEN-CREW-4', [{ code: 'AC-CL-004' }]);
    await rpc(U.admin, 'set_job_crew', { p_job_id: j4, p_user_ids: [U.tech, U.tech2, U.tech3, U.tech4] });
    eq(await activeCrew(j4).length, 4);
    eq((await rpc(U.admin, 'job_crew_info', { p_jobs: [j4] }, { table: true }))[0].member_names.length, 4, 'รายงานเห็นชื่อครบ 4 คน');
    await rpc(U.admin, 'set_job_crew', { p_job_id: j4, p_user_ids: [U.tech, U.tech2, U.tech3] });
    eq(await activeCrew(j4).length, 3);
    eq((await rpc(U.admin, 'job_crew_info', { p_jobs: [j4] }, { table: true }))[0].crew_required, 4, 'เพดานต้องไม่หดกลับ (กันคนนอกชิงช่องว่าง)');
    // เอาออกทีละคนผ่าน API เดิม (remove_technician) — ต้องทำงานกับทีมหลายคนได้
    await rpc(U.admin, 'remove_technician', { p_job_id: j4, p_user_id: U.tech3, p_reason: 'ถอนตัว' });
    await rpc(U.admin, 'remove_technician', { p_job_id: j4, p_user_id: U.tech2, p_reason: 'ถอนตัว' });
    eq(await activeCrew(j4), [U.tech]);
  });
  await test('ข้อจำกัดกติกาเดิมยังอยู่: ห้ามเหลือ 0 คนในงานที่เริ่มแล้ว ; งานที่ยังไม่เริ่มล้างทีมได้ ; ผิดขั้น/สาขาอื่น/anon ถูกปฏิเสธ', async () => {
    const j = await readyJob('QWEN-CREW-2', [{ code: 'AC-CL-004' }]);
    await rpc(U.admin, 'set_job_crew', { p_job_id: j, p_user_ids: [U.tech, U.tech2] });
    await rpc(U.tech, 'advance_job', { p_job_id: j });                 // in_progress (ช่าง 2 คนช่วยกันทำได้)
    await rejects(rpc(U.admin, 'set_job_crew', { p_job_id: j, p_user_ids: [] }), /อย่างน้อย 1 คน/);
    await rejects(rpc(U.admin, 'set_job_crew', { p_job_id: j, p_user_ids: null }), /ต้องระบุรายชื่อช่าง/);
    // งานขั้น quoting (ยังไม่ถึงพร้อมทำ) ตั้งทีมไม่ได้
    const jq = await quotedJob('QWEN-CREW-Q', [{ code: 'AC-CL-004' }]);
    await rejects(rpc(U.admin, 'set_job_crew', { p_job_id: jq, p_user_ids: [U.tech] }), /พร้อมทำ.*กำลังทำ|ตอนนี้/);
    // anon เรียกไม่ได้ (RLS/revoke)
    await rejects(rpc('anon', 'set_job_crew', { p_job_id: j, p_user_ids: [U.tech] }), /permission|not authorized|ไม่มีสิทธิ์/i);
    // เจ้าของอีกสาขาแตะไม่ได้ (_lock_job กั้นข้ามสาขา)
    await rejects(rpc(U.owner2, 'set_job_crew', { p_job_id: j, p_user_ids: [U.tech] }), /ไม่พบใบงาน/);
    // ล้างทีมเมื่อยังไม่เริ่ม → คืนสถานะว่าง
    const j2 = await readyJob('QWEN-CREW-3', [{ code: 'AC-CL-004' }]);
    await rpc(U.admin, 'set_job_crew', { p_job_id: j2, p_user_ids: [U.tech, U.tech2], p_reason: 'ตั้งทีม' });
    await rpc(U.admin, 'set_job_crew', { p_job_id: j2, p_user_ids: [], p_reason: 'รอสับเปลี่ยนทีม' });
    eq(await activeCrew(j2), []);
    eq((await rpc(U.admin, 'job_crew_info', { p_jobs: [j2] }, { table: true }))[0].crew_active, 0);
  });
  await test('บันทึกไม่สำเร็จ → ไม่มีข้อมูลค้าง (rollback ทั้งก้อน)', async () => {
    const j = await readyJob('QWEN-CREW-ROLL', [{ code: 'AC-CL-004' }]);
    await rpc(U.admin, 'set_job_crew', { p_job_id: j, p_user_ids: [U.tech] });       // ทีมเริ่มต้น 1 คน
    // รายการที่มีทั้งคนดี + คนที่รับอยู่แล้ว → error กลาง loop หลัง insert สำเร็จบางส่วนไม่ได้
    await rejects(rpc(U.admin, 'add_job_crew', { p_job_id: j, p_user_ids: [U.tech2, U.tech] }), /รับงานนี้อยู่แล้ว/);
    eq(await activeCrew(j), [U.tech], 'ต้องไม่เห็น tech2 ค้าง (ธุรกรรม rollback)');
    // set ที่ส่งคนนอกสาขาปนมา → ทั้งหมดล้มเหลว ทีมเดิมคงอยู่
    await rejects(rpc(U.admin, 'set_job_crew', { p_job_id: j, p_user_ids: [U.tech, U.owner2] }), /ไม่ใช่ช่าง/);
    eq(await activeCrew(j), [U.tech], 'ทีมเดิมต้องไม่ถูกแตะ');
  });
  await test('ผลกระทบต่อค่าแรง (D24 เดิม): ปิดงานทีม 2 คน → หารเท่า 2 คน, ไม่ได้เปลี่ยนกติกาเพราะ 0010', async () => {
    const j = await readyJob('QWEN-PAY-10', [{ code: 'AC-CL-001' }]);   // service ค่าแรง 400 (ตั้งราคาก่อน)
    await setPrice('AC-CL-001', 400);
    await rpc(U.admin, 'set_job_crew', { p_job_id: j, p_user_ids: [U.tech, U.tech2] });
    eq(await activeCrew(j).length, 2);
    await rpc(U.tech, 'advance_job', { p_job_id: j });    // in_progress
    await rpc(U.tech2, 'advance_job', { p_job_id: j });   // qc (ช่างคนที่ 2 ก็ขยับได้ — ทีมหลายคน)
    await rpc(U.admin, 'qc_pass', { p_job_id: j, p_answers: QC_OK });
    await payAndClose(j);
    eq(await statusOf(j), 'completed');
    const rows = await labor(j);
    eq(rows.length, 2, 'ต้องมีรายการค่าแรงครบทั้งทีม 2 คน');
    eq(rows.map((x) => x.a).sort((a, b) => a - b), [200, 200], 'หารเท่าตามคนทำจริง 2 คน (กติกาเดิม D24 — ไม่แตะ)');
    ok(rows.every((x) => x.c === 2), 'crew_actual = 2');
  });

  // =====================================================================
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== สรุป: ผ่าน ${results.length - failed.length} / ${results.length} ====`);
  if (failed.length) {
    console.log('ที่ไม่ผ่าน:');
    for (const f of failed) console.log(`  - [${f.group}] ${f.name}`);
  }
  await sup.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
