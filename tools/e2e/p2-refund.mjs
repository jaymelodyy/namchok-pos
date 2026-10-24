// เฟส 2 — คืนมัดจำ/คืนเงินจริง + ยกเลิกใบงาน  บนใบงาน "กข 6004" (ยอดบิล ฿1,500 รับมัดจำเงินสด ฿500)
//   * ยกเลิกใบงานไม่ได้ขณะรับสุทธิ > 0 ; คืนเกินยอดไม่ได้ ; คืนต้องมีเหตุผล ; QR/โอนต้องแนบสลิป
//   * คืนบางส่วน → รับสุทธิ/คืนเงินถูกต้อง ; admin void การคืนเงินไม่ได้ (เฉพาะเจ้าของ) ; void การรับเงินที่ทำให้ติดลบไม่ได้
//   * คืนเต็ม → ยกเลิกใบงานสำเร็จ ; เจ้าของที่เปิดหน้าค้างไว้เห็นรายการคืนเงินเปลี่ยนเอง (ไม่รีโหลด)
import { execFileSync } from 'node:child_process';
import { openActors, waitMs, runner, shot, BASE } from './lib.mjs';

const R = runner('p2-refund');
const PLATE = 'กข 6004';
const SLIP = 'tools/dev-api/.data/files/job-files/_demo/photo.jpg';
const sql = (q) => execFileSync('psql', ['-d', process.env.DEMO_DB ?? 'namchok_demo', '-tAc', q], { encoding: 'utf8', env: process.env }).trim();
const { browser, actors } = await openActors({ admin: 'admin@demo.local', owner: 'owner@demo.local' });
const { admin, owner } = actors;
const A = admin.page, O = owner.page;
const keep = (p) => p.evaluate(() => { window.__keep = 'still-here'; });
const kept = (p) => p.evaluate(() => window.__keep === 'still-here');
const btn = (p, name) => p.getByRole('button', { name }).first();
const alerts = async (p) => (await p.locator('[role=alert]').allTextContents()).join(' | ');
const id = () => sql(`select id from v_jobs where plate = '${PLATE}'`);
const tot = () => sql(`select paid_total::numeric(12,2) || '|' || refunded_total::numeric(12,2) from v_job_totals where job_id = '${id()}'`);   // "รับสุทธิ|คืนแล้ว"
const status = () => sql(`select status from v_jobs where plate = '${PLATE}'`);
const refunds = () => Number(sql(`select count(*) from refunds where job_id = '${id()}' and voided_at is null`));
const openRefund = async () => { await btn(A, 'คืนเงิน').click(); await A.waitForTimeout(500); };
let jobUrl;

try {
  await R.step('เปิดใบงาน กข 6004: admin และเจ้าของ (เจ้าของเปิดค้างไว้) ; เห็นมัดจำ ฿500 และปุ่ม "คืนเงิน"', async () => {
    await A.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
    await A.locator('[data-testid=view-list]').click();
    await A.getByText(PLATE).first().click();
    await A.waitForURL(/\/jobs\/[0-9a-f-]{36}/);
    jobUrl = A.url();
    await O.goto(jobUrl, { waitUntil: 'networkidle' });
    await keep(O);
    if (tot() !== '500.00|0.00') throw new Error('ก่อนทดสอบ รับสุทธิ|คืนแล้ว ควรเป็น 500.00|0.00 แต่เป็น ' + tot());
    await waitMs(async () => (await btn(A, 'คืนเงิน').count()) === 1, { what: 'ปุ่มคืนเงิน' });
    await shot(A, 'p2-rf-1-deposit', false);
  });

  await R.step('ยกเลิกใบงานขณะรับสุทธิ ฿500 → ถูกปฏิเสธ (ต้องคืนเงินก่อน) ; คำอธิบายในกล่องยกเลิกบอกให้กด "คืนเงิน"', async () => {
    await A.getByRole('button', { name: 'เมนูเพิ่มเติม' }).click();
    await A.getByText('ยกเลิกใบงาน', { exact: false }).first().click();
    await A.waitForTimeout(500);
    const t = await A.locator('body').innerText();
    if (!/ต้องกด\s*"คืนเงิน"\s*ให้ครบก่อนจึงยกเลิกได้/.test(t)) throw new Error('คำอธิบายในกล่องยกเลิกไม่บอกให้คืนเงินก่อน');
    await A.fill('#reason-input', 'ลูกค้าไม่ทำแล้ว');
    await A.getByRole('button', { name: /^ยกเลิกใบงาน$/ }).last().click();
    await waitMs(async () => /ยังมียอดรับชำระคงเหลือ/.test(await alerts(A)), { timeout: 4000, what: 'ข้อความปฏิเสธการยกเลิก' });
    if ((await status()) === 'cancelled') throw new Error('ใบงานถูกยกเลิกทั้งที่ยังรับสุทธิ > 0');
    await shot(A, 'p2-rf-2-cancel-refused', false);
    await A.goto(jobUrl, { waitUntil: 'networkidle' });          // ปิดกล่อง
  }, A);

  await R.step('ฟอร์มคืนเงิน: คืนเกินยอด ฿600 → เตือน + บันทึกไม่ได้ ; ไม่ใส่เหตุผล → บันทึกไม่ได้', async () => {
    await openRefund();
    await A.fill('#rf-amt', '600');
    await waitMs(async () => /คืนเกินยอดที่รับไว้/.test(await alerts(A)), { timeout: 3000, what: 'เตือนคืนเกิน' });
    if (!(await btn(A, /บันทึกการคืนเงิน/).isDisabled())) throw new Error('คืนเกินยอดแต่ปุ่มบันทึกกดได้');
    await A.fill('#rf-amt', '200');
    if (!(await btn(A, /บันทึกการคืนเงิน/).isDisabled())) throw new Error('ไม่มีเหตุผลแต่ปุ่มบันทึกกดได้');
    await shot(A, 'p2-rf-3-over-no-reason', false);
  });

  await R.step('คืนด้วย QR → ต้องแนบสลิปก่อนจึงบันทึกได้ ; กลับมาคืนเงินสด ฿200 ไม่ต้องใช้สลิป → บันทึกได้', async () => {
    await A.fill('#rf-reason', 'ลูกค้าลดรายการบริการ');
    await A.getByRole('radio', { name: 'QR พร้อมเพย์' }).click();
    await A.waitForTimeout(300);
    if (!(await btn(A, /บันทึกการคืนเงิน/).isDisabled())) throw new Error('คืนด้วย QR แต่ไม่มีสลิป ปุ่มบันทึกกดได้');
    await A.setInputFiles('input[type=file]', SLIP);
    await A.waitForTimeout(400);
    if (await btn(A, /บันทึกการคืนเงิน/).isDisabled()) throw new Error('แนบสลิปแล้วแต่ปุ่มยังกดไม่ได้');
    await A.getByRole('radio', { name: 'เงินสด' }).click();      // เปลี่ยนใจคืนเงินสด (ไม่ต้องใช้สลิป)
    await A.waitForTimeout(300);
    if (await btn(A, /บันทึกการคืนเงิน/).isDisabled()) throw new Error('คืนเงินสดพร้อมเหตุผลและจำนวนถูกต้อง แต่ปุ่มกดไม่ได้');
    await btn(A, /บันทึกการคืนเงิน/).click();
    await waitMs(async () => refunds() === 1, { timeout: 6000, what: 'มีรายการคืนเงิน 1 รายการใน DB' });
    if (tot() !== '300.00|200.00') throw new Error('หลังคืน ฿200 รับสุทธิ|คืนแล้ว ควรเป็น 300.00|200.00 แต่เป็น ' + tot());
  }, A);

  await R.step('เจ้าของที่เปิดหน้าค้างไว้ เห็นรายการคืนเงินโผล่เอง (ไม่รีโหลด) และรับสุทธิ ฿300', async () => {
    await waitMs(async () => (await O.locator('[data-testid=refund-list] li').count()) === 1, { timeout: 6000, what: 'รายการคืนเงินบนหน้าเจ้าของ' });
    if (!(await kept(O))) throw new Error('หน้าเจ้าของถูกรีโหลด');
    const t = await O.locator('[data-testid=refund-list]').innerText();
    if (!/คืนเงิน\s*เงินสด/.test(t) || !/200/.test(t)) throw new Error('รายการคืนเงินแสดงไม่ถูก: ' + t);
    await shot(O, 'p2-rf-4-owner-sees-refund', false);
  }, O);

  await R.step('void การรับมัดจำ ฿500 ตอนนี้ไม่ได้ (รับสุทธิจะติดลบ เพราะคืนไปแล้ว ฿200) → ถูกปฏิเสธ', async () => {
    await A.reload({ waitUntil: 'networkidle' });
    await A.locator('section[aria-labelledby=pay-h] button', { hasText: /^void$/ }).first().click();
    await A.waitForTimeout(400);
    await A.fill('#reason-input', 'ทดสอบ void มัดจำ');
    await btn(A, 'Void รายการนี้').click();
    await waitMs(async () => /ยอดรับสุทธิจะติดลบ/.test(await alerts(A)), { timeout: 4000, what: 'ข้อความปฏิเสธ void' });
    if (Number(sql(`select count(*) from payments where job_id = '${id()}' and voided_at is null`)) !== 1) throw new Error('การรับเงินถูก void ทั้งที่ไม่ควร');
    await A.reload({ waitUntil: 'networkidle' });
  }, A);

  await R.step('admin ไม่มีปุ่ม void การคืนเงิน (เฉพาะเจ้าของ)', async () => {
    await waitMs(async () => (await A.locator('[data-testid=refund-list] li').count()) === 1, { what: 'รายการคืนเงินบนหน้า admin' });
    const n = await A.locator('[data-testid=refund-list] button', { hasText: /^void$/ }).count();
    if (n !== 0) throw new Error('admin เห็นปุ่ม void การคืนเงิน ' + n + ' ปุ่ม');
  });

  await R.step('เจ้าของ void การคืนเงินที่บันทึกผิด (ต้องมีเหตุผล) → รับสุทธิกลับเป็น ฿500', async () => {
    await O.reload({ waitUntil: 'networkidle' });
    await O.locator('[data-testid=refund-list] button', { hasText: /^void$/ }).click();
    await O.waitForTimeout(400);
    await btn(O, 'Void รายการนี้').click();                          // ยังไม่ใส่เหตุผล
    await waitMs(async () => /ต้องระบุเหตุผล/.test(await alerts(O)), { timeout: 3000, what: 'ปฏิเสธเมื่อไม่มีเหตุผล' });
    await O.fill('#reason-input', 'บันทึกคืนเงินผิดจำนวน');
    await btn(O, 'Void รายการนี้').click();
    await waitMs(async () => tot() === '500.00|0.00', { timeout: 6000, what: 'รับสุทธิกลับเป็น 500' });
    await waitMs(async () => /void:\s*บันทึกคืนเงินผิดจำนวน/.test(await O.locator('[data-testid=refund-list]').innerText()), { timeout: 4000, what: 'รายการที่ void แสดงเหตุผล' });
  }, O);

  await R.step('admin คืนเต็มจำนวน ฿500 → รับสุทธิ ฿0 ; แล้วยกเลิกใบงานสำเร็จ', async () => {
    await waitMs(async () => /void:/.test(await A.locator('[data-testid=refund-list]').innerText()), { timeout: 6000, what: 'หน้า admin เห็นรายการ void (live)' });
    await openRefund();
    await A.fill('#rf-amt', '500');
    await A.fill('#rf-reason', 'ลูกค้ายกเลิกงาน');
    await btn(A, /บันทึกการคืนเงิน/).click();
    await waitMs(async () => tot() === '0.00|500.00', { timeout: 6000, what: 'คืนเต็ม 500' });
    await A.reload({ waitUntil: 'networkidle' });
    await A.getByRole('button', { name: 'เมนูเพิ่มเติม' }).click();
    await A.getByText('ยกเลิกใบงาน', { exact: false }).first().click();
    await A.waitForTimeout(400);
    await A.fill('#reason-input', 'ลูกค้ายกเลิกงาน คืนมัดจำครบแล้ว');
    await A.getByRole('button', { name: /^ยกเลิกใบงาน$/ }).last().click();
    await waitMs(async () => (await status()) === 'cancelled', { timeout: 6000, what: 'สถานะ cancelled' });
    await waitMs(async () => /ยกเลิกแล้ว:\s*ลูกค้ายกเลิกงาน คืนมัดจำครบแล้ว/.test(await A.locator('body').innerText()), { timeout: 5000, what: 'แสดงเหตุผลยกเลิก' });
    await shot(A, 'p2-rf-5-cancelled', false);
  }, A);

  await R.step('หลังยกเลิก: ไม่มีปุ่มคืนเงิน ; DB: payments 1 (ไม่ void), refunds ใช้งาน 1 (฿500) + void 1 (฿200)', async () => {
    if ((await btn(A, 'คืนเงิน').count()) !== 0) throw new Error('ใบงานที่ยกเลิกแล้วยังมีปุ่มคืนเงิน');
    const r = sql(`select count(*) filter (where voided_at is null) || '|' || coalesce(sum(amount) filter (where voided_at is null), 0) || '|' || count(*) filter (where voided_at is not null) from refunds where job_id = '${id()}'`);
    if (r !== '1|500.00|1') throw new Error('refunds ใน DB ไม่ตรงที่คาด (ใช้งาน|ยอด|void): ' + r);
  });
} catch { console.log('\nหยุดที่ขั้นที่ล้มเหลว'); }

// HTTP 400 ที่คาดไว้: ยกเลิกทั้งที่ยังรับสุทธิ, void มัดจำที่ทำให้ติดลบ, void ไม่ใส่เหตุผล (กันที่หน้าจอ → ไม่มี 400) — ตัดออกเฉพาะ "status of 400"
const all = [admin, owner].flatMap((a) => a.problems.map((p) => `${a.email}: ${p}`));
const unexpected = all.filter((p) => !/status of 400/.test(p));
if (all.length - unexpected.length) console.log(`(ตัดออก ${all.length - unexpected.length} รายการ: HTTP 400 ที่คาดไว้จากการทดสอบกติกาที่ถูกปฏิเสธ)`);
process.exitCode = R.finish(unexpected);
await browser.close();
