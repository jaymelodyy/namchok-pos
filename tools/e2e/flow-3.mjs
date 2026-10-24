// ส่วนที่ 3 (รวมถึงอนุมัติใบเสนอราคา → ช่างเริ่มงาน/QC): แก้ราคา(ต้องมีเหตุผล) → ส่วนลดเกินเพดาน → เจ้าของอนุมัติ → อนุมัติใบเสนอราคา → ช่างเริ่มงาน/ส่ง QC → ผ่าน QC → มัดจำ+ชำระ → ปิดงาน → ใบเสร็จ
import { launch, login, shot, BASE } from './lib.mjs';
import fs from 'node:fs';

const jobUrl = fs.readFileSync('shots/_jobUrl.txt', 'utf8').trim();
const { browser, ctx, page, problems } = await launch();
const steps = [];
const step = async (name, fn) => {
  try { await fn(); steps.push(['ok', name]); console.log('✓', name); }
  catch (e) {
    steps.push(['FAIL', name]); console.log('✗', name, '\n   ', String(e.message).split('\n').slice(0, 4).join('\n    '));
    await page.screenshot({ path: `shots/FAIL-${steps.length}.png`, fullPage: false }).catch(() => {});
    throw e;
  }
};
const btn = (t) => page.getByRole('button', { name: t }).first();
const text = (t) => page.getByText(t, { exact: false }).first();
const go = async (url = jobUrl) => { await page.goto(url, { waitUntil: 'networkidle' }); await page.waitForTimeout(350); };
const logout = async () => { await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} }); await ctx.clearCookies(); };
const alertText = async () => (await page.locator('[role=alert]').allTextContents()).join(' | ');

try {
  await step('admin: เปิดใบงาน (เสนอราคา)', async () => { await login(page, 'admin@demo.local'); await go(); await shot(page, '40-quote-items'); });

  await step('แก้ราคาโดยไม่ใส่เหตุผล → ปุ่มบันทึกต้องกดไม่ได้', async () => {
    await page.getByRole('button', { name: 'แก้ไข ล้างตู้แอร์' }).first().click();
    await page.waitForTimeout(500);
    await page.fill('#line-price', '1000');
    await page.waitForTimeout(250);
    const dis = await btn('บันทึก').isDisabled();
    await shot(page, '41-edit-price-no-reason', false);
    if (!dis) throw new Error('ปุ่มบันทึกกดได้ทั้งที่ยังไม่มีเหตุผล');
  });
  await step('ใส่เหตุผล → บันทึกได้', async () => {
    await page.fill('#line-reason', 'ลูกค้าประจำ ตกลงราคาหน้างาน');
    await btn('บันทึก').click();
    await page.waitForTimeout(1200);
    await page.getByText('฿1,000').first().waitFor();
  });

  await step('ส่วนลดเกินเพดาน 10%: เพิ่มส่วนลด ฿3,000 พร้อมเหตุผล', async () => {
    await btn('เพิ่มรายการ').click();
    await page.waitForTimeout(400);
    // แท็บ "อื่น ๆ" อาจอยู่นอกจอ → ใช้ค้นหา
    await page.getByLabel('ค้นหารายการ').fill('OT-DC-001');
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /OT-DC-001/ }).first().click();
    await page.waitForTimeout(400);
    await shot(page, '42-config-discount', false);
    const fields = page.locator('input.field');
    // ช่องจำนวนเงินส่วนลด = input ตัวเลข/ทศนิยม
    await page.locator('input[inputmode=decimal]').first().fill('3000');
    const reason = page.getByLabel(/เหตุผล/).first();
    await reason.fill('ลูกค้าเก่า ขอส่วนลดพิเศษ');
    await shot(page, '43-config-discount-filled', false);
    await btn('เพิ่มลงใบงาน').click();
    await page.waitForTimeout(1200);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /ปิด/ }).first().click().catch(() => {});
    await page.waitForTimeout(500);
  });

  await step('ส่วนลดเกินเพดาน → admin อนุมัติใบเสนอราคาไม่ได้ (รอเจ้าของ)', async () => {
    await go();
    await shot(page, '44-discount-blocked');
    await text('เจ้าของอนุมัติ').waitFor();
    const a = btn('ลูกค้าอนุมัติใบเสนอราคา');
    if (!(await a.isDisabled())) throw new Error('admin กดอนุมัติใบเสนอราคาได้ทั้งที่ส่วนลดเกินเพดานและยังไม่ได้รับอนุมัติ');
  });

  await step('เจ้าของเข้าระบบ → อนุมัติส่วนลด', async () => {
    await logout();
    await login(page, 'owner@demo.local');
    await go();
    await btn('อนุมัติส่วนลด').click();
    await page.waitForTimeout(1200);
    await go();
    await shot(page, '45-discount-approved');
  });

  await step('admin อนุมัติใบเสนอราคา → ระบบส่งคำขอเบิกให้คลัง (ถ้ามีอะไหล่) ', async () => {
    await logout();
    await login(page, 'admin@demo.local');
    await go();
    await btn('ลูกค้าอนุมัติใบเสนอราคา').click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'ลูกค้าอนุมัติใบเสนอราคา' }).last().click();
    await page.waitForTimeout(1500);
    await shot(page, '46a-after-approve');
  });

  await step('คลังเห็นคำขอเบิก → จัดเตรียม → ส่งมอบ (ถ้ามีคำขอ) ; ใบงานเป็น "พร้อมทำ" เอง', async () => {
    const noParts = await page.getByRole('button', { name: /ไม่มีอะไหล่ต้องเบิก/ }).count();
    if (noParts > 0) { console.log('   ใบงานนี้ไม่มีอะไหล่ → แอดมินกดไปขั้นพร้อมทำเอง'); await btn('ไม่มีอะไหล่ต้องเบิก').click(); await page.waitForTimeout(1200); }
    else {
      await logout(); await login(page, 'stock@demo.local');
      await page.goto(`${BASE}/requisitions`, { waitUntil: 'networkidle' });
      await shot(page, '46b-stock-requests');
      const body = await page.locator('body').innerText();
      if (/฿\s?\d/.test(body)) throw new Error('คลังเห็นตัวเลขเงิน');
      // มีคำขอของใบเดโมปนอยู่ด้วย → เลือกการ์ดของ "ใบงานนี้" ตามทะเบียน
      const mine = () => page.locator('[data-testid=req-card]', { hasText: '5กจ 9087' });
      await mine().locator('[data-testid=req-advance]').click(); await page.waitForTimeout(1000);
      await page.locator('[data-testid=tab-prepared]').click();
      await mine().locator('[data-testid=req-advance]').click(); await page.waitForTimeout(1000);
      await logout(); await login(page, 'admin@demo.local');
    }
    await go();
    await btn('เริ่มงาน').waitFor();           // ปุ่ม "เริ่มงาน" ปรากฏเฉพาะเมื่อใบงานเป็น "พร้อมทำ"
    if (await page.getByText('รอคลังส่งมอบอะไหล่').count()) throw new Error('ใบงานยังรอคลังอยู่');
    await shot(page, '46-ready');
  });

  await step('ช่าง: เห็นใบงานแต่ไม่เห็นราคา/เงิน → รับงาน → เริ่มงาน → ส่ง QC', async () => {
    await logout();
    await login(page, 'tech@demo.local');
    await go();
    await shot(page, '47-tech-view');
    const body = await page.locator('body').innerText();
    if (/฿\s?\d/.test(body)) throw new Error('ช่างเห็นตัวเลขเงินในหน้าใบงาน: ' + (body.match(/฿\s?[\d,]+/) ?? [])[0]);
    await btn('รับงานนี้').click();
    await page.waitForTimeout(1200);
    await btn('เริ่มงาน').click();
    await page.waitForTimeout(1200);
    await btn('ส่งตรวจ QC').click();
    await page.waitForTimeout(1200);
    await text('ตรวจ QC').waitFor();
  });

  await step('admin: บันทึกผล QC (ติ๊กครบ) → ผ่าน QC → รอชำระ', async () => {
    await logout();
    await login(page, 'admin@demo.local');
    await go();
    await btn('บันทึกผล QC').click();
    await page.waitForTimeout(600);
    const boxes = page.getByRole('checkbox');
    const n = await boxes.count();
    for (let i = 0; i < n; i++) await boxes.nth(i).click();
    await shot(page, '48a-qc-sheet', false);
    await page.locator('[data-testid=qc-pass]').click();
    await page.waitForTimeout(1500);
    await shot(page, '48-awaiting-payment');
    await text('รอชำระ').waitFor();
  });
} catch (e) {
  console.log('\nหยุดที่ขั้นที่ล้มเหลว');
}
console.log('\nสรุป:\n  ' + steps.map((s) => s.join(' ')).join('\n  '));
console.log('\nproblems:', problems.length ? '\n' + problems.join('\n') : 'none');
process.exitCode = steps.some((x) => x[0] === 'FAIL') ? 1 : 0;
await browser.close();
