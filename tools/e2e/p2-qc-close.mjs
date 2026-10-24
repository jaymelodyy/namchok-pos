// เฟส 2 — QC → ชำระ → ปิดงาน (วันส่งมอบ/ประกัน) → ค่าแรงช่าง  บนใบงาน "2ขท 6610" (สถานะ รอ QC ช่างสองรับงานอยู่คนเดียว)
//   * ปุ่ม "ผ่าน QC" กดไม่ได้จนกว่าจะติ๊กครบ ; "ไม่ผ่าน" ต้องมีเหตุผล → ส่งกลับ "กำลังทำ" ; ช่างเห็นเหตุผลในประวัติสถานะ ไม่เห็นเงิน
//   * ปิดงานด้วยวันส่งมอบ ≠ วันนี้ → ใบรับประกันนับจากวันส่งมอบ ; แก้วันส่งมอบภายหลัง → ประกันคำนวณใหม่ ; วันเกินกำหนดถูกปฏิเสธ
//   * ค่าแรง: เข้าตอนปิดงานให้ช่างที่ทำจริงเท่านั้น (ช่างสอง ฿50) ; ช่างหนึ่งไม่เห็น ; เจ้าของกดจ่าย → ช่างสองเห็นเปลี่ยนเอง
import { execFileSync } from 'node:child_process';
import { openActors, waitMs, runner, shot, BASE } from './lib.mjs';

const R = runner('p2-qc-close');
const PLATE = '2ขท 6610';
const sql = (q) => execFileSync('psql', ['-d', process.env.DEMO_DB ?? 'namchok_demo', '-tAc', q], { encoding: 'utf8', env: process.env }).trim();
const bkk = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
const plusDays = (n) => bkk(new Date(Date.now() + n * 86400000));
const num = (t) => Number(String(t).replace(/[^0-9.\-]/g, ''));
const { browser, actors } = await openActors({ admin: 'admin@demo.local', tech: 'tech@demo.local', tech2: 'tech2@demo.local', owner: 'owner@demo.local' });
const { admin, tech, tech2, owner } = actors;
const A = admin.page;
const keep = (p) => p.evaluate(() => { window.__keep = 'still-here'; });
const kept = (p) => p.evaluate(() => window.__keep === 'still-here');
const btn = (p, name) => p.getByRole('button', { name }).first();
const alerts = async (p) => (await p.locator('[role=alert]').allTextContents()).join(' | ');
const body = (p) => p.locator('body').innerText();
const jobId = () => sql(`select id from v_jobs where plate = '${PLATE}'`);
const jobStatus = () => sql(`select status from v_jobs where plate = '${PLATE}'`);
const total = async (p, id) => num(await p.locator(`[data-testid=${id}]`).first().innerText());
const base = {};
let jobUrl; let deliver1; let deliver2;

try {
  await R.step('เปิดหน้าค้างไว้: ช่างสอง (งานของฉัน + ค่าแรง), ช่างหนึ่ง (ค่าแรง), admin (ใบงาน 2ขท 6610)', async () => {
    await tech2.page.goto(`${BASE}/work`, { waitUntil: 'networkidle' });
    tech2.labor = await tech2.ctx.newPage(); await tech2.labor.goto(`${BASE}/labor`, { waitUntil: 'networkidle' });
    await tech.page.goto(`${BASE}/labor`, { waitUntil: 'networkidle' });
    await A.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
    await A.locator('[data-testid=view-list]').click();
    await A.getByText(PLATE).first().click();
    await A.waitForURL(/\/jobs\/[0-9a-f-]{36}/);
    jobUrl = A.url();
    for (const p of [tech2.page, tech2.labor, tech.page, A]) await keep(p);
    await waitMs(async () => (await btn(A, 'บันทึกผล QC').count()) === 1, { what: 'ปุ่มบันทึกผล QC' });
    base.t2 = { total: await total(tech2.labor, 'sum-total'), paid: await total(tech2.labor, 'sum-paid') };
    base.t1 = { total: await total(tech.page, 'sum-total') };
    console.log('   ค่าแรงก่อนปิดงานนี้ — ช่างสอง รวม', base.t2.total, '| ช่างหนึ่ง รวม', base.t1.total);
    if ((await jobStatus()) !== 'qc') throw new Error('ใบงานควรอยู่สถานะ qc แต่เป็น ' + (await jobStatus()));
  });

  await R.step('ฟอร์ม QC: "ผ่าน QC" กดไม่ได้จนติ๊กครบทุกข้อ (3 จาก 4 ยังกดไม่ได้)', async () => {
    await btn(A, 'บันทึกผล QC').click();
    await A.waitForTimeout(500);
    const boxes = A.getByRole('checkbox');
    if ((await boxes.count()) !== 4) throw new Error('รายการตรวจ QC ควรมี 4 ข้อ แต่มี ' + (await boxes.count()));
    if (!(await A.locator('[data-testid=qc-pass]').isDisabled())) throw new Error('ยังไม่ติ๊กอะไรเลย แต่ปุ่มผ่านกดได้');
    for (let i = 0; i < 3; i++) await boxes.nth(i).click();
    if (!(await A.locator('[data-testid=qc-pass]').isDisabled())) throw new Error('ติ๊ก 3 ข้อ แต่ปุ่มผ่านกดได้');
    await shot(A, 'p2-qc-1-three-of-four', false);
    await boxes.nth(3).click();
    if (await A.locator('[data-testid=qc-pass]').isDisabled()) throw new Error('ติ๊กครบแล้วแต่ปุ่มผ่านยังกดไม่ได้');
    await boxes.nth(3).click();                                   // เอาติ๊กข้อสุดท้ายออก กลับไปเป็น 3 ข้อ แล้วทดสอบทาง "ไม่ผ่าน"
  }, A);

  await R.step('"ไม่ผ่าน" โดยไม่ใส่เหตุผล → ถูกปฏิเสธ สถานะยังเป็น รอ QC', async () => {
    await A.locator('[data-testid=qc-fail]').click();
    await waitMs(async () => /ต้องระบุว่าต้องแก้อะไร/.test(await alerts(A)), { timeout: 3000, what: 'ข้อความปฏิเสธ' });
    if ((await jobStatus()) !== 'qc') throw new Error('สถานะเปลี่ยนทั้งที่ไม่มีเหตุผล: ' + (await jobStatus()));
    if (Number(sql(`select count(*) from qc_checks where job_id = '${jobId()}'`)) !== 0) throw new Error('มีบันทึก QC เกิดขึ้นทั้งที่ถูกปฏิเสธ');
  });

  const NOTE = 'ยังมีน้ำรั่วที่ท่อทางออก ขันใหม่และเช็คซ้ำ';
  await R.step('"ไม่ผ่าน" พร้อมเหตุผล → ส่งกลับ "กำลังทำ" + ประวัติ QC แสดงเหตุผล', async () => {
    await A.fill('#qc-note', NOTE);
    await A.locator('[data-testid=qc-fail]').click();
    await waitMs(async () => (await jobStatus()) === 'in_progress', { timeout: 5000, what: 'สถานะ in_progress ใน DB' });
    await waitMs(async () => (await A.locator('[data-testid=qc-history]').count()) === 1, { timeout: 5000, what: 'ประวัติ QC' });
    const t = await A.locator('[data-testid=qc-history]').innerText();
    if (!/ไม่ผ่าน QC/.test(t) || !t.includes(NOTE)) throw new Error('ประวัติ QC ไม่แสดงผลไม่ผ่าน/เหตุผล: ' + t);
    await shot(A, 'p2-qc-2-failed', false);
  }, A);

  await R.step('ช่างสอง (ไม่ได้รีโหลด): การ์ดเปลี่ยนเป็นกำลังทำเอง ; เปิดใบงานเห็นเหตุผลในประวัติสถานะ ไม่เห็นเงิน ไม่เห็นตาราง QC', async () => {
    const card = tech2.page.locator('[data-testid=work-card]', { hasText: PLATE });
    await waitMs(async () => (await card.getAttribute('data-status')) === 'in_progress', { timeout: 5000, what: 'การ์ดช่างสองเป็น in_progress' });
    if (!(await kept(tech2.page))) throw new Error('หน้าช่างสองถูกรีโหลด');
    await card.locator('a').first().click();
    await tech2.page.waitForURL(/\/jobs\/[0-9a-f-]{36}/);
    await waitMs(async () => /QC ไม่ผ่าน/.test(await body(tech2.page)), { timeout: 6000, what: 'เหตุผล QC ในประวัติสถานะ' });
    const t = await body(tech2.page);
    if (!t.includes(NOTE)) throw new Error('ช่างไม่เห็นว่าต้องแก้อะไร (เหตุผลไม่อยู่ในประวัติสถานะ)');
    // แถบเตือนบนสุดของหน้า (ไม่ต้องเลื่อนไปหาประวัติสถานะ)
    const banner = tech2.page.locator('[data-testid=qc-return]');
    if ((await banner.count()) !== 1 || !(await banner.innerText()).includes(NOTE)) throw new Error('ไม่มีแถบเตือน "QC ไม่ผ่าน" ที่แสดงสิ่งที่ต้องแก้');
    if ((await banner.boundingBox()).y > 700) throw new Error('แถบเตือนอยู่ต่ำเกินไป (ต้องเห็นโดยไม่ต้องเลื่อนไกล)');
    if (/฿\s?\d/.test(t)) throw new Error('ช่างเห็นตัวเลขเงิน: ' + (t.match(/฿\s?[\d,.]+/) ?? [])[0]);
    if ((await tech2.page.locator('[data-testid=qc-history]').count()) !== 0) throw new Error('ช่างเห็นตาราง QC (ควรเห็นเฉพาะ owner/admin)');
    await shot(tech2.page, 'p2-qc-3-tech-sees-reason', false);
  }, tech2.page);

  await R.step('ช่างสองส่งตรวจ QC ใหม่ → หน้า admin (ไม่รีโหลด) กลับมามีปุ่ม "บันทึกผล QC" เอง', async () => {
    await btn(tech2.page, 'ส่งตรวจ QC').click();
    await waitMs(async () => (await jobStatus()) === 'qc', { timeout: 5000, what: 'สถานะ qc' });
    await waitMs(async () => (await btn(A, 'บันทึกผล QC').count()) === 1, { timeout: 5000, what: 'ปุ่มบันทึกผล QC บนหน้า admin' });
    if (!(await kept(A))) throw new Error('หน้า admin ถูกรีโหลด');
    await waitMs(async () => (await tech2.page.locator('[data-testid=qc-return]').count()) === 0, { timeout: 5000, what: 'แถบเตือน QC ไม่ผ่านหายไปเมื่อส่งตรวจใหม่' });
  });

  await R.step('admin ผ่าน QC (ติ๊กครบ) → รอชำระ ; ประวัติ QC มี 2 รายการ (ไม่ผ่าน, ผ่าน)', async () => {
    await btn(A, 'บันทึกผล QC').click();
    await A.waitForTimeout(500);
    const boxes = A.getByRole('checkbox');
    for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).click();
    await A.locator('[data-testid=qc-pass]').click();
    await waitMs(async () => (await jobStatus()) === 'awaiting_payment', { timeout: 5000, what: 'สถานะ awaiting_payment' });
    await waitMs(async () => (await A.locator('[data-testid=qc-history] li').count()) === 2, { timeout: 5000, what: 'ประวัติ QC 2 รายการ' });
    await shot(A, 'p2-qc-4-passed', false);
  }, A);

  await R.step('รับเงินสดเต็มยอด (ระบบเติมยอดค้างให้) → พร้อมปิดงาน', async () => {
    await btn(A, /รับชำระ ค้าง/).click();
    await A.waitForTimeout(500);
    await A.getByRole('radio', { name: 'เงินสด' }).click();
    const v = await A.locator('input[inputmode=decimal]').first().inputValue();
    const due = Number(sql(`select balance from v_job_totals where job_id = '${jobId()}'`));
    if (Number(v) !== due) throw new Error(`ยอดที่ระบบเติมให้ ${v} ไม่ตรงยอดค้างใน DB ${due}`);
    await btn(A, /บันทึกการรับเงิน/).click();
    await waitMs(async () => (await btn(A, /ปิดงานและออกใบเสร็จ/).count()) === 1, { timeout: 6000, what: 'ปุ่มปิดงาน' });
  }, A);

  await R.step('ปิดงานโดยเลือกวันส่งมอบ = วันนี้ + 3 → ใบรับประกันเริ่มนับจากวันส่งมอบ (ตรวจใน DB)', async () => {
    deliver1 = plusDays(3);
    await btn(A, /ปิดงานและออกใบเสร็จ/).click();
    await A.waitForTimeout(500);
    const def = await A.locator('#deliver-date').inputValue();
    if (def !== bkk()) throw new Error(`ค่าเริ่มต้นของวันส่งมอบควรเป็นวันนี้ (${bkk()}) แต่เป็น ${def}`);
    await A.fill('#deliver-date', deliver1);
    await A.getByRole('button', { name: 'ปิดงาน ออกใบเสร็จ' }).click();
    await waitMs(async () => (await jobStatus()) === 'closed', { timeout: 8000, what: 'สถานะ closed' });
    const id = jobId();
    const d = sql(`select delivered_on from job_orders where id = '${id}'`);
    if (d !== deliver1) throw new Error(`delivered_on ใน DB = ${d} ควรเป็น ${deliver1}`);
    const w = sql(`select count(*) || '|' || bool_and(starts_on = date '${deliver1}') || '|' || bool_and(ends_on = (starts_on + make_interval(months => warranty_months))::date) from warranties where job_id = '${id}' and voided_at is null`).split('|');
    console.log('   ใบรับประกัน:', w[0], 'ใบ | เริ่ม=วันส่งมอบ:', w[1], '| สิ้นสุด=เริ่ม+ระยะประกัน:', w[2]);
    if (Number(w[0]) < 1 || w[1] !== 'true' || w[2] !== 'true') throw new Error('ใบรับประกันไม่ได้เริ่มนับจากวันส่งมอบ หรือวันสิ้นสุดผิด');
    await A.waitForURL(/\/receipt$/, { timeout: 8000 });          // ปิดงานแล้วแอปพาไปหน้าใบเสร็จเอง (ตั้งใจ)
    await A.goto(jobUrl, { waitUntil: 'networkidle' });
    await waitMs(async () => (await A.locator('[data-testid=delivered-on]').count()) === 1, { timeout: 5000, what: 'แถว "ส่งมอบรถ" บนหน้าใบงาน' });
    await shot(A, 'p2-qc-5-closed', false);
  }, A);

  await R.step('หน้าใบเสร็จมีใบรับประกัน และยอดตรงกับใบงาน', async () => {
    await A.goto(jobUrl + '/receipt', { waitUntil: 'networkidle' });
    const t = await body(A);
    if (!/ใบรับประกัน/.test(t)) throw new Error('ไม่มีใบรับประกันบนหน้าใบเสร็จ');
    const shown = num(await A.locator('[data-testid=receipt-total]').innerText());
    const db = Number(sql(`select grand_total from v_job_totals where job_id = '${jobId()}'`));
    if (shown !== db) throw new Error(`ยอดบนใบเสร็จ ${shown} ≠ DB ${db}`);
    await shot(A, 'p2-qc-6-receipt');
  });

  await R.step('แก้วันส่งมอบเป็นวันนี้ + 5 (ต้องมีเหตุผล) → ประกันคำนวณใหม่ ; เกิน 7 วัน/ไม่มีเหตุผลถูกปฏิเสธ', async () => {
    deliver2 = plusDays(5);
    await A.goto(jobUrl, { waitUntil: 'networkidle' });
    await A.getByRole('button', { name: 'เมนูเพิ่มเติม' }).click();
    await A.getByText('แก้วันที่ส่งมอบ', { exact: false }).first().click();
    await A.waitForTimeout(500);
    await A.fill('#deliver-date2', deliver2);
    await btn(A, 'บันทึกวันที่ส่งมอบ').click();                     // ยังไม่ใส่เหตุผล
    await waitMs(async () => /ต้องระบุเหตุผล/.test(await alerts(A)), { timeout: 3000, what: 'ปฏิเสธเมื่อไม่มีเหตุผล' });
    await A.fill('#deliver-date2', plusDays(8));                  // เกิน 7 วัน
    await A.fill('#reason-input', 'ลูกค้ามารับรถช้ากว่ากำหนด');
    await btn(A, 'บันทึกวันที่ส่งมอบ').click();
    await waitMs(async () => /ล่วงหน้าได้ไม่เกิน 7 วัน/.test(await alerts(A)), { timeout: 4000, what: 'ปฏิเสธวันเกิน 7 วัน' });
    if (sql(`select delivered_on from job_orders where id = '${jobId()}'`) !== deliver1) throw new Error('วันส่งมอบเปลี่ยนทั้งที่ถูกปฏิเสธ');
    await A.fill('#deliver-date2', deliver2);
    await btn(A, 'บันทึกวันที่ส่งมอบ').click();
    await waitMs(async () => sql(`select delivered_on from job_orders where id = '${jobId()}'`) === deliver2, { timeout: 5000, what: 'delivered_on ใหม่' });
    const w = sql(`select bool_and(starts_on = date '${deliver2}') || '|' || bool_and(ends_on = (date '${deliver2}' + make_interval(months => warranty_months))::date) from warranties where job_id = '${jobId()}' and voided_at is null`);
    if (w !== 'true|true') throw new Error('ประกันไม่ถูกคำนวณใหม่จากวันส่งมอบใหม่: ' + w);
  }, A);

  await R.step('ค่าแรง: เข้า DB เฉพาะช่างสอง ฿50 (ช่างที่ทำจริงคนเดียว) ; ช่างหนึ่งไม่มีรายการ', async () => {
    const rows = sql(`select u.full_name || '=' || l.amount from labor_pay_entries l join users u on u.id = l.user_id where l.job_id = '${jobId()}' and l.voided_at is null`).split('\n').filter(Boolean);
    console.log('   labor_pay_entries ของใบงานนี้:', rows.join(', '));
    if (rows.length !== 1 || rows[0] !== 'ช่างสอง=50.00') throw new Error('ค่าแรงไม่ตรงที่คาด (ช่างสอง=50.00): ' + rows.join(', '));
  });

  await R.step('ช่างสองเห็นค่าแรง +฿50 และแถวทะเบียน 2ขท 6610 เอง (ไม่รีโหลด) ; ช่างหนึ่งเห็นยอดเท่าเดิม ไม่มีแถวนี้', async () => {
    await waitMs(async () => (await total(tech2.labor, 'sum-total')) === base.t2.total + 50, { timeout: 6000, what: 'ยอดรวมช่างสองเพิ่ม 50' });
    if (!(await kept(tech2.labor))) throw new Error('หน้าค่าแรงช่างสองถูกรีโหลด');
    const rows = tech2.labor.locator('[data-testid=labor-row]', { hasText: PLATE });
    if ((await rows.count()) !== 1) throw new Error('ช่างสองควรเห็นแถวค่าแรงของ ' + PLATE + ' 1 แถว');
    await shot(tech2.labor, 'p2-qc-7-tech2-labor', false);
    await tech.page.waitForTimeout(1500);
    if ((await total(tech.page, 'sum-total')) !== base.t1.total) throw new Error('ยอดค่าแรงช่างหนึ่งเปลี่ยนทั้งที่ไม่ได้ทำงานนี้');
    if ((await tech.page.locator('[data-testid=labor-row]', { hasText: PLATE }).count()) !== 0) throw new Error('ช่างหนึ่งเห็นแถวค่าแรงของงานที่ไม่ใช่ของตัวเอง');
  }, tech2.labor);

  await R.step('admin เปิด /labor ไม่ได้ (เฉพาะเจ้าของ/ช่าง) → ถูกเด้งออก', async () => {
    await A.goto(`${BASE}/labor`, { waitUntil: 'networkidle' });
    await A.waitForTimeout(800);
    if (new URL(A.url()).pathname === '/labor') throw new Error('admin เข้าหน้าค่าแรงได้');
  });

  await R.step('เจ้าของเห็นค่าแรงรายช่าง → กด "จ่ายแล้ว" ของช่างสอง → ช่างสอง (ไม่รีโหลด) เห็นยอดจ่ายแล้วเพิ่มเอง', async () => {
    await owner.page.goto(`${BASE}/labor`, { waitUntil: 'networkidle' });
    const g = owner.page.locator('[data-testid=labor-group][data-tech="ช่างสอง"]');
    await g.waitFor({ timeout: 6000 });
    const unpaid = num(await g.locator('[data-testid=group-unpaid]').innerText());
    const expected = base.t2.total - base.t2.paid + 50;
    if (unpaid !== expected) throw new Error(`ยอดค้างจ่ายของช่างสอง ${unpaid} ควรเป็น ${expected}`);
    await shot(owner.page, 'p2-qc-8-owner-labor', false);
    await g.locator('[data-testid=mark-paid]').click();
    await btn(owner.page, /ยืนยันจ่าย/).click();
    await waitMs(async () => (await total(tech2.labor, 'sum-paid')) === base.t2.paid + expected, { timeout: 6000, what: 'ยอดจ่ายแล้วของช่างสองเพิ่ม' });
    if (!(await kept(tech2.labor))) throw new Error('หน้าค่าแรงช่างสองถูกรีโหลด');
    if ((await total(tech2.labor, 'sum-unpaid')) !== 0) throw new Error('ช่างสองยังเห็นค้างจ่าย');
    await shot(tech2.labor, 'p2-qc-9-tech2-paid', false);
  }, owner.page);
} catch { console.log('\nหยุดที่ขั้นที่ล้มเหลว'); }

const problems = [admin, tech, tech2, owner].flatMap((a) => a.problems.map((p) => `${a.email}: ${p}`));
// HTTP 400 ที่คาดไว้: ปฏิเสธ "ไม่ผ่าน QC ไม่มีเหตุผล" (ฝั่งหน้าจอกันไว้ก่อน จึงไม่ควรมี), แก้วันส่งมอบเกิน 7 วัน (RPC ปฏิเสธ → 400 1 ครั้ง)
const expected = (p) => /status of 400/.test(p);
const unexpected = problems.filter((p) => !expected(p));
const n400 = problems.length - unexpected.length;
if (n400) console.log(`(ตัดออก ${n400} รายการ: HTTP 400 ที่คาดไว้จากการทดสอบวันส่งมอบเกิน 7 วัน)`);
process.exitCode = R.finish(unexpected);
await browser.close();
