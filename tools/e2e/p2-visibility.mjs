// เฟส 2 — ใครเห็นอะไร (ตรวจทั้งหน้าจอและระดับฐานข้อมูลด้วยบทบาทจริง ไม่ใช่แค่ซ่อนปุ่ม)
//   ช่าง: ไม่เห็นเงิน/การชำระ/คืนเงิน/ผล QC/คำขอเบิก ; เห็นเฉพาะงานที่ตัวเองรับ หรืองานที่ยังมีที่ว่าง ; ค่าแรงเห็นเฉพาะของตัวเอง
//   คลัง: ไม่เห็นใบงาน/ลูกค้า/เงินเลย เห็นเฉพาะคำขอเบิก
import { execFileSync } from 'node:child_process';
import { openActors, runner, shot, BASE } from './lib.mjs';

const R = runner('p2-visibility');
const DB = process.env.DEMO_DB ?? 'namchok_demo';
const UID = { owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222', tech: '33333333-3333-4333-8333-333333333333', tech2: '55555555-5555-4555-8555-555555555555', stock: '44444444-4444-4444-8444-444444444444' };
const sql = (q) => execFileSync('psql', ['-d', DB, '-tAc', q], { encoding: 'utf8', env: process.env }).trim();
/** รันคำสั่งเดียวในฐานะบทบาทนั้น (authenticated + jwt sub) ในทรานแซกชันที่ rollback เสมอ → 'ok:<ค่า>' หรือ 'err:<ข้อความ>' */
function asRole(uid, query) {
  const script = `begin;\nset local role authenticated;\nselect set_config('request.jwt.claim.sub', '${uid}', true) \\gset\n\\set ON_ERROR_STOP on\nselect 'RESULT:' || (${query});\nrollback;\n`;
  try {
    const out = execFileSync('psql', ['-d', DB, '-tAq', '-v', 'ON_ERROR_STOP=1'], { input: script, encoding: 'utf8', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const line = out.split('\n').find((l) => l.startsWith('RESULT:'));
    return 'ok:' + (line ?? '').slice(7);
  } catch (e) { return 'err:' + String(e.stderr ?? e.message).replace(/\s+/g, ' ').slice(0, 160); }
}
const denied = (r) => r.startsWith('err:');
const zero = (r) => r === 'ok:0';

const { browser, actors } = await openActors({ tech: 'tech@demo.local', tech2: 'tech2@demo.local', stock: 'stock@demo.local' });
const { tech, tech2, stock } = actors;
const body = (p) => p.locator('body').innerText();
const money = (t) => (t.match(/฿\s?[\d,.]+/) ?? [])[0];
const PLATE = 'ฆง 8842';                                  // กำลังทำ — ช่างหนึ่งรับไว้ (งานเต็มแล้ว)
const jid = sql(`select id from v_jobs where plate = '${PLATE}'`);
const crew = sql(`select _job_crew_active(id) || '/' || _job_crew_required(id) from job_orders where id = '${jid}'`);
const url = `${BASE}/jobs/${jid}`;
const anyJob = sql(`select id from v_jobs where plate = 'นพ 3021'`);

try {
  await R.step(`ข้อมูลตั้งต้น: ${PLATE} มีช่างรับครบแล้ว (${crew}) — ช่างสองจึงต้องไม่เห็นงานนี้`, async () => {
    const [a, r] = crew.split('/').map(Number);
    if (a < r) throw new Error('งานนี้ยังมีที่ว่าง (' + crew + ') การทดสอบ "ช่างอีกคนไม่เห็น" ใช้ไม่ได้ — ตรวจ seed');
  });

  await R.step('DB (ในฐานะช่าง): payments / refunds / requisitions / qc_checks ไม่มีแถวให้เห็นเลย ; ค่าแรงเห็นเฉพาะของตัวเอง', async () => {
    for (const uid of ['tech', 'tech2']) {
      for (const t of ['payments', 'refunds', 'requisitions', 'requisition_lines', 'qc_checks', 'receipts']) {
        const r = asRole(UID[uid], `select count(*) from ${t}`);
        if (!denied(r) && !zero(r)) throw new Error(`${uid} อ่าน ${t} ได้: ${r}`);
      }
      const other = asRole(UID[uid], `select count(*) from labor_pay_entries where user_id <> '${UID[uid]}'`);
      if (!zero(other) && !denied(other)) throw new Error(`${uid} เห็นค่าแรงของคนอื่น: ${other}`);
      const own = asRole(UID[uid], `select count(*) from labor_pay_entries where user_id = '${UID[uid]}'`);
      if (!/^ok:[1-9]/.test(own)) throw new Error(`${uid} ควรเห็นค่าแรงของตัวเอง (จากใบงานที่ปิดแล้ว) แต่ได้ ${own}`);
    }
  });

  await R.step('DB (ในฐานะช่าง): ราคา/ต้นทุนไม่รั่ว (job_items ตรง ๆ = 0 แถว, item_prices = 0, ยอดใน v_jobs = 0, รายการงานผ่าน job_items_for_job เห็นรายการแต่เงินเป็น NULL) ; เรียก RPC ของ admin ไม่ได้', async () => {
    for (const t of ['job_items', 'item_prices']) {
      const r = asRole(UID.tech, `select count(*) from ${t}`);
      if (!zero(r) && !denied(r)) throw new Error(`ช่างอ่าน ${t} ตรง ๆ ได้: ${r}`);
    }
    const sumv = asRole(UID.tech, `select coalesce(sum(grand_total), 0)::text from v_jobs`);
    if (sumv !== 'ok:0' && sumv !== 'ok:0.00') throw new Error('ช่างเห็นยอดรวมใน v_jobs: ' + sumv);
    const n = asRole(UID.tech, `select count(*) from job_items_for_job('${jid}'::uuid)`);
    if (!/^ok:[1-9]/.test(n)) throw new Error('ช่างควรเห็นรายการงานของใบงานตัวเองผ่าน job_items_for_job แต่ได้ ' + n);
    const leak = asRole(UID.tech, `select count(*) from job_items_for_job('${jid}'::uuid) where unit_price is not null or list_price is not null or cost is not null or line_total is not null or price_reason is not null or labor_rate is not null`);
    if (!zero(leak)) throw new Error('job_items_for_job คืนค่าเงินให้ช่าง: ' + leak);
    // ตรงข้าม: admin ต้องเห็นราคา (กันกรณีทดสอบผ่านเพราะข้อมูลว่าง)
    const adm = asRole(UID.admin, `select count(*) from job_items_for_job('${jid}'::uuid) where unit_price is not null`);
    if (!/^ok:[1-9]/.test(adm)) throw new Error('admin ควรเห็นราคาในรายการงาน แต่ได้ ' + adm);
    const rf = asRole(UID.tech, `refund_job_payment('${anyJob}'::uuid, 'cash', 1, 'ทดสอบ')::text`);
    if (!denied(rf)) throw new Error('ช่างเรียก refund_job_payment ได้: ' + rf);
    const aq = asRole(UID.tech, `approve_quote('${anyJob}'::uuid)::text`);
    if (!denied(aq)) throw new Error('ช่างเรียก approve_quote ได้: ' + aq);
    console.log('   ข้อความที่ได้เมื่อช่างเรียกคืนเงิน:', rf.slice(0, 110));
  });

  await R.step('DB (ในฐานะคลัง): ไม่เห็นใบงาน/ลูกค้า/รถ/การชำระ/ค่าแรงเลย แต่เห็นคำขอเบิก', async () => {
    for (const t of ['job_orders', 'job_items', 'customers', 'vehicles', 'payments', 'refunds', 'labor_pay_entries', 'job_assignments']) {
      const r = asRole(UID.stock, `select count(*) from ${t}`);
      if (!denied(r) && !zero(r)) throw new Error(`คลังอ่าน ${t} ได้: ${r}`);
    }
    const q = asRole(UID.stock, `select count(*) from requisitions`);
    if (!/^ok:[1-9]/.test(q)) throw new Error('คลังควรเห็นคำขอเบิกอย่างน้อย 1 รายการ แต่ได้ ' + q);
  });

  await R.step(`หน้าจอช่างหนึ่ง: เปิดงานของตัวเอง (${PLATE}) → ไม่เห็นเงิน/การชำระ/คืนเงิน/ตาราง QC/ปุ่มใบเสร็จ`, async () => {
    await tech.page.goto(url, { waitUntil: 'networkidle' });
    await tech.page.waitForTimeout(600);
    const t = await body(tech.page);
    if (!t.includes(PLATE.split(' ')[1])) throw new Error('ช่างหนึ่งเปิดงานของตัวเองไม่ได้');
    if (money(t)) throw new Error('ช่างเห็นเงิน: ' + money(t));
    for (const sel of ['section[aria-labelledby=pay-h]', '[data-testid=refund-list]', '[data-testid=qc-history]', '[data-testid=grand-total]']) {
      if ((await tech.page.locator(sel).count()) !== 0) throw new Error('ช่างเห็นส่วน ' + sel);
    }
    if (/ดูใบเสร็จ/.test(t)) throw new Error('ช่างเห็นปุ่มใบเสร็จ');
    await shot(tech.page, 'p2-vis-1-tech-job', false);
  }, tech.page);

  await R.step('ช่างเปิดหน้าใบเสร็จไม่เห็นเนื้อหา ; เปิด /reports แล้วถูกเด้งออก', async () => {
    await tech.page.goto(url + '/receipt', { waitUntil: 'networkidle' });
    await tech.page.waitForTimeout(600);
    const t = await body(tech.page);
    if (/ใบเสร็จรับเงิน|ยอดสุทธิ/.test(t) || money(t)) throw new Error('ช่างเห็นเนื้อหาใบเสร็จ: ' + (money(t) ?? t.slice(0, 80)));
    await tech.page.goto(`${BASE}/reports`, { waitUntil: 'networkidle' });
    await tech.page.waitForTimeout(800);
    if (new URL(tech.page.url()).pathname === '/reports') throw new Error('ช่างเข้า /reports ได้');
  });

  await R.step(`ช่างสอง: เปิดงาน ${PLATE} ของช่างหนึ่ง (เต็มแล้ว) → "ไม่พบใบงานนี้" และไม่อยู่ในรายการใด ๆ ของ "งานของฉัน"`, async () => {
    await tech2.page.goto(url, { waitUntil: 'networkidle' });
    await tech2.page.waitForTimeout(600);
    const t = await body(tech2.page);
    if (!/ไม่พบใบงานนี้/.test(t)) throw new Error('ช่างสองเปิดงานของคนอื่นได้ หรือข้อความไม่ใช่ "ไม่พบใบงานนี้": ' + t.slice(0, 120));
    await tech2.page.goto(`${BASE}/work`, { waitUntil: 'networkidle' });
    await tech2.page.waitForTimeout(600);
    if ((await tech2.page.locator('[data-testid=work-card]', { hasText: PLATE }).count()) !== 0) throw new Error('งานของช่างหนึ่งโผล่ในหน้างานของช่างสอง');
  });

  await R.step('คลัง: /jobs ถูกเด้งไปหน้าเบิกอะไหล่ ; เปิดใบงานตรง ๆ ไม่ได้ ("ไม่พบใบงานนี้") ; /labor /reports เด้งออก', async () => {
    await stock.page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
    await stock.page.waitForURL(/\/requisitions/, { timeout: 8000 });
    await stock.page.goto(`${BASE}/jobs/${anyJob}`, { waitUntil: 'networkidle' });
    await stock.page.waitForTimeout(600);
    const t = await body(stock.page);
    if (!/ไม่พบใบงานนี้/.test(t)) throw new Error('คลังเปิดใบงานได้: ' + t.slice(0, 120));
    if (money(t) || /\(ตัวอย่าง\)/.test(t)) throw new Error('คลังเห็นข้อมูลลูกค้า/เงินบนหน้าใบงาน');
    for (const p of ['/labor', '/reports']) {
      await stock.page.goto(BASE + p, { waitUntil: 'networkidle' });
      await stock.page.waitForTimeout(700);
      if (new URL(stock.page.url()).pathname === p) throw new Error('คลังเข้า ' + p + ' ได้');
    }
  });

  await R.step('หน้าเบิกอะไหล่ของคลัง: ไม่มีเงิน ไม่มีชื่อ/เบอร์ลูกค้า (มีทะเบียนและรายการอะไหล่)', async () => {
    await stock.page.goto(`${BASE}/requisitions`, { waitUntil: 'networkidle' });
    await stock.page.waitForTimeout(800);
    const t = await body(stock.page);
    if (money(t)) throw new Error('คลังเห็นเงิน: ' + money(t));
    if (/\(ตัวอย่าง\)|0800000\d{3}|โทร/.test(t)) throw new Error('คลังเห็นชื่อ/เบอร์ลูกค้า');
    if ((await stock.page.locator('[data-testid=req-card]').count()) < 1) throw new Error('คลังไม่เห็นคำขอเบิก');
    await shot(stock.page, 'p2-vis-2-stock-requisitions', false);
  }, stock.page);
} catch { console.log('\nหยุดที่ขั้นที่ล้มเหลว'); }

const problems = [tech, tech2, stock].flatMap((a) => a.problems.map((p) => `${a.email}: ${p}`));
// หน้าที่ถูกปฏิเสธโดย RLS ให้ผล 0 แถว/404 จาก API ตามการออกแบบ → console รายงาน "status of 4xx" ตัดออกเฉพาะรหัส 4xx
const unexpected = problems.filter((p) => !/status of 40\d/.test(p));
if (problems.length - unexpected.length) console.log(`(ตัดออก ${problems.length - unexpected.length} รายการ: HTTP 4xx ที่คาดไว้จากหน้าที่สิทธิ์ไม่ถึง)`);
process.exitCode = R.finish(unexpected);
await browser.close();
