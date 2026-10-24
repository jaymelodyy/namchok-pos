// ตรวจตัวจำลอง Realtime ของ dev-api ด้วย supabase-js ตัวเดียวกับที่แอปใช้ (ไม่ใช้เบราว์เซอร์)
//   * ผู้ฟังแต่ละบทบาทได้รับเหตุการณ์เฉพาะแถวที่ RLS ของตัวเองอนุญาต
//   * เหตุการณ์ถึงภายในไม่กี่ร้อย ms
// หมายเหตุ: นี่ทดสอบ "ตัวจำลองใน dev-api" ไม่ใช่ Supabase Realtime ตัวจริง
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54330';
const ANON = 'dev-anon-key';
let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function client(email) {
  const c = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: 'demo1234' });
  if (error) throw new Error(`${email}: ${error.message}`);
  c.realtime.setAuth((await c.auth.getSession()).data.session.access_token);
  return c;
}
function listen(c, tables) {
  const got = [];
  const ch = c.channel(`probe-${Math.random().toString(36).slice(2)}`);
  for (const t of tables) ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, (p) => got.push({ table: t, type: p.eventType, id: p.new?.id ?? p.old?.id, at: Date.now() }));
  return new Promise((resolve, reject) => {
    ch.subscribe((st, err) => { if (st === 'SUBSCRIBED') resolve({ got, ch }); if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') reject(err ?? new Error(st)); });
  });
}

const admin = await client('admin@demo.local');
const tech = await client('tech@demo.local');
const tech2 = await client('tech2@demo.local');
const stock = await client('stock@demo.local');
const L = {
  admin: await listen(admin, ['job_orders', 'requisitions', 'job_assignments']),
  tech: await listen(tech, ['job_orders', 'requisitions']),
  tech2: await listen(tech2, ['job_orders', 'job_assignments']),
  stock: await listen(stock, ['job_orders', 'requisitions']),
};
console.log('สมัครฟังครบ 4 ผู้ใช้');

// 1) แอดมินดันใบงาน "opened" → condition_check : admin + ช่าง (เห็นใบเช็คสภาพ) ได้เหตุการณ์ ; คลังไม่เห็นใบงาน
const jobOpened = (await admin.from('job_orders').select('id').eq('status', 'opened').limit(1).single()).data.id;
let t0 = Date.now();
const r1 = await admin.rpc('advance_job', { p_job_id: jobOpened });
ok(!r1.error, `advance_job ไม่ error (${r1.error?.message ?? 'ok'})`);
await sleep(1200);
const ev = (u, tbl) => L[u].got.filter((e) => e.table === tbl && e.id === jobOpened);
ok(ev('admin', 'job_orders').length >= 1, `admin ได้เหตุการณ์ job_orders (${Math.min(...ev('admin', 'job_orders').map((e) => e.at - t0))} ms)`);
ok(ev('tech', 'job_orders').length >= 1, 'ช่างเห็นใบงานที่อยู่ขั้นเช็คสภาพ → ได้เหตุการณ์');
ok(ev('stock', 'job_orders').length === 0, 'คลังไม่ได้เหตุการณ์ job_orders (RLS กรองแล้ว)');

// 2) คลังเลื่อนคำขอเบิก requested → prepared : คลัง + admin ได้เหตุการณ์ requisitions
const req = (await stock.from('requisitions').select('id').eq('status', 'requested').limit(1).single()).data.id;
t0 = Date.now();
const r2 = await stock.rpc('advance_requisition', { p_req_id: req });
ok(!r2.error, `advance_requisition ไม่ error (${r2.error?.message ?? 'ok'})`);
await sleep(1200);
const rq = (u) => L[u].got.filter((e) => e.table === 'requisitions' && e.id === req);
ok(rq('stock').length >= 1, 'คลังได้เหตุการณ์ requisitions');
ok(rq('admin').length >= 1, `admin ได้เหตุการณ์ requisitions (${Math.min(...rq('admin').map((e) => e.at - t0))} ms)`);

// 3) ช่างสองรับงานที่พร้อมทำ → ช่างหนึ่งเห็นใบงานเปลี่ยน (ที่ว่างเต็ม) / ช่างสองได้เหตุการณ์ job_assignments ของตัวเอง
const ready = (await admin.from('job_orders').select('id').eq('status', 'ready').limit(1).single()).data.id;
const before = L.tech.got.length;
t0 = Date.now();
const r3 = await tech2.rpc('accept_job', { p_job_id: ready });
ok(!r3.error, `ช่างสองรับงานสำเร็จ (${r3.error?.message ?? 'ok'})`);
await sleep(1200);
ok(L.tech2.got.some((e) => e.table === 'job_assignments'), 'ช่างสองได้เหตุการณ์ job_assignments');
ok(L.admin.got.some((e) => e.table === 'job_assignments'), 'admin ได้เหตุการณ์ job_assignments (การรับงานไม่แตะแถว job_orders → ต้องฟังตารางนี้ด้วย)');
void before;

// 4) ปิดการเชื่อมต่อแล้วไม่ได้รับเหตุการณ์อีก
await tech.removeChannel(L.tech.ch);
const n = L.tech.got.length;
await admin.rpc('advance_job', { p_job_id: jobOpened });
await sleep(600);
ok(L.tech.got.length === n, 'หลัง removeChannel ไม่มีเหตุการณ์ใหม่');

for (const c of [admin, tech, tech2, stock]) await c.removeAllChannels();
console.log(fails === 0 ? '\nผ่านทุกข้อ' : `\nไม่ผ่าน ${fails} ข้อ`);
process.exit(fails === 0 ? 0 : 1);
