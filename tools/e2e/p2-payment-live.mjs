// เฟส 2 — "ยืนยันรับเงินแล้วเครื่องอื่นเห็นทันที" บนใบงาน "กข 6001" (ยอดบิล ฿650 ยังไม่มีการรับเงิน)
//   * admin กดรับมัดจำเงินสด ฿200 ; เจ้าของที่เปิดใบงานเดียวกันค้างไว้ (ไม่รีโหลด) เห็น "รับแล้ว ฿200" และรายการรับเงินเอง ≤ 5 วินาที
//   * admin void รายการรับเงิน → เจ้าของเห็นรายการถูกขีดฆ่าและยอดรับแล้วหายไปเอง ≤ 5 วินาที
// หมายเหตุ: ทดสอบกับ "ตัวจำลอง Realtime ของ dev-api" ไม่ใช่ Supabase Realtime ตัวจริง
import { execFileSync } from 'node:child_process';
import { openActors, waitMs, runner, shot, BASE } from './lib.mjs';

const R = runner('p2-payment-live');
const PLATE = 'กข 6001';
const sql = (q) => execFileSync('psql', ['-d', process.env.DEMO_DB ?? 'namchok_demo', '-tAc', q], { encoding: 'utf8', env: process.env }).trim();
const { browser, actors } = await openActors({ admin: 'admin@demo.local', owner: 'owner@demo.local' });
const { admin, owner } = actors;
const A = admin.page, O = owner.page;
const keep = (p) => p.evaluate(() => { window.__keep = 'still-here'; });
const kept = (p) => p.evaluate(() => window.__keep === 'still-here');
const jobId = () => sql(`select id from v_jobs where plate = '${PLATE}'`);
const paid = () => sql(`select paid_total::numeric(12,2) from v_job_totals where job_id = '${jobId()}'`);

try {
  await R.step('ก่อนเริ่ม: ใบงาน กข 6001 ยังไม่มีการรับเงิน (DB) ; admin และเจ้าของเปิดใบงานเดียวกัน', async () => {
    if (paid() !== '0.00') throw new Error('ก่อนทดสอบ ยอดรับสุทธิควรเป็น 0.00 แต่เป็น ' + paid());
    await A.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
    await A.locator('[data-testid=view-list]').click();
    await A.getByText(PLATE).first().click();
    await A.waitForURL(/\/jobs\/[0-9a-f-]{36}/);
    const url = A.url();
    await O.goto(url, { waitUntil: 'networkidle' });
    await keep(O);
    const t = await O.locator('body').innerText();
    if (/รับแล้ว/.test(t)) throw new Error('หน้าเจ้าของมี "รับแล้ว" ทั้งที่ยังไม่มีการรับเงิน');
    await shot(O, 'p2-pay-1-owner-before', false);
  });

  let ms;
  await R.step('admin รับมัดจำเงินสด ฿200 → DB รับสุทธิ 200.00', async () => {
    await A.getByRole('button', { name: 'รับมัดจำ' }).first().click();
    await A.waitForTimeout(500);
    await A.fill('#pay-amt', '200');
    await A.getByRole('button', { name: /บันทึกมัดจำ/ }).last().click();
    await waitMs(async () => paid() === '200.00', { timeout: 5000, what: 'DB รับสุทธิ 200.00' });
  }, A);

  await R.step('เจ้าของ (เปิดหน้าค้างไว้ ไม่รีโหลด) เห็น "รับแล้ว ฿200" ภายใน 5 วินาที', async () => {
    ms = await waitMs(async () => {
      const t = await O.locator('body').innerText();
      return /รับแล้ว/.test(t) && /200/.test(t);
    }, { timeout: 5000, what: 'หน้าเจ้าของแสดงยอดรับแล้ว' });
    console.log(`   ↳ เจ้าของเห็นยอดรับเงิน ${ms} ms หลัง DB เปลี่ยน`);
    if (!(await kept(O))) throw new Error('หน้าเจ้าของถูกรีโหลด (ไม่ใช่การอัปเดตสด)');
    await shot(O, 'p2-pay-2-owner-live', false);
  }, O);

  await R.step('เจ้าของเห็นรายการ "มัดจำ เงินสด" ในส่วนการรับเงิน และยอดค้างชำระ ฿450', async () => {
    const t = await O.locator('body').innerText();
    if (!/มัดจำ\s*เงินสด/.test(t)) throw new Error('ไม่เห็นรายการ มัดจำ เงินสด');
    if (!/ค้างชำระ[\s\S]{0,20}450/.test(t)) throw new Error('ยอดค้างชำระไม่ใช่ 450: ' + t.slice(t.indexOf('สรุปยอด'), t.indexOf('สรุปยอด') + 200));
  });

  await R.step('admin void รายการรับเงิน (ผิด) พร้อมเหตุผล → เจ้าของเห็นรายการถูกขีดฆ่า + ยอดรับแล้วหายไปสด', async () => {
    await A.getByRole('button', { name: /^void$/ }).first().click();
    await A.waitForTimeout(400);
    await A.fill('#reason-input', 'กดจำนวนผิด');
    await A.getByRole('button', { name: 'Void รายการนี้' }).click();
    await waitMs(async () => paid() === '0.00', { timeout: 5000, what: 'DB รับสุทธิกลับเป็น 0.00' });
    const ms2 = await waitMs(async () => {
      const t = await O.locator('body').innerText();
      return /void:\s*กดจำนวนผิด/.test(t) && !/รับแล้ว/.test(t);
    }, { timeout: 5000, what: 'หน้าเจ้าของแสดง void และไม่มี "รับแล้ว"' });
    console.log(`   ↳ เจ้าของเห็นการ void ${ms2} ms หลัง DB เปลี่ยน`);
    if (!(await kept(O))) throw new Error('หน้าเจ้าของถูกรีโหลด (ไม่ใช่การอัปเดตสด)');
    await shot(O, 'p2-pay-3-owner-voided', false);
  }, A);
} catch { /* step() พิมพ์สาเหตุแล้ว */ }

const problems = [...admin.problems, ...owner.problems].filter((p) => !/\b40[0-9]\b/.test(p));
const rc = R.finish(problems);
await browser.close();
process.exit(rc || (problems.length ? 1 : 0));
