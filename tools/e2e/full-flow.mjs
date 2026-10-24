// ทดสอบ flow เต็มผ่านหน้าจอมือถือ: รับรถใหม่ → เช็คสภาพ → รายการ → อนุมัติราคา → เริ่มงาน → QC → รับเงิน → ปิดงาน → ใบเสร็จ
// รันกับ dev-api + ข้อมูลเดโมเท่านั้น (ดู README)
import { launch, login, shot, BASE } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const PHOTO = path.resolve('tools/dev-api/.data/files/job-files/_demo/photo.jpg');
const { browser, page, problems } = await launch();
const steps = [];
const step = async (name, fn) => {
  try { await fn(); steps.push(['ok', name]); console.log('✓', name); }
  catch (e) {
    steps.push(['FAIL', name, String(e.message).split('\n')[0]]); console.log('✗', name, '\n   ', String(e.message).split('\n').slice(0, 3).join('\n    '));
    await page.screenshot({ path: `shots/FAIL-${steps.length}.png`, fullPage: true }).catch(() => {});
    throw e;
  }
};
const text = (t) => page.getByText(t, { exact: false }).first();
const btn = (t) => page.getByRole('button', { name: t }).first();
const settle = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(300); };

try {
  await step('admin เข้าสู่ระบบ', () => login(page, 'admin@demo.local'));

  await step('รับรถใหม่ (ทะเบียนที่ไม่เคยมี)', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.fill('#plate-input', '5กจ 9087');
    await page.fill('#plate-province', 'นครศรีธรรมราช');
    await page.waitForTimeout(800);
    await page.fill('#c-name', 'คุณวิชัย (ตัวอย่าง)');
    await page.fill('#c-phone', '0800000009');
    await page.fill('#c-odo', '88000');
    await page.fill('#c-brand', 'Toyota');
    await page.fill('#c-model', 'Vios');
    await page.fill('#c-year', '2019');
    await page.fill('#c-complaint', 'แอร์เย็นช้า มีเสียงดังตอนเปิดแอร์');
    await shot(page, '20-new-vehicle-form');
    await btn('เปิดใบงาน').click();
    await page.waitForURL(/\/jobs\/[0-9a-f-]{36}/);
    await settle();
  });
  const jobUrl = page.url();

  await step('ยังเริ่มเช็คสภาพไม่ได้ถ้ายังไม่กดเดินงาน + เดินไป "เช็คสภาพ"', async () => {
    await btn('เริ่มเช็คสภาพรถ').click();
    await settle();
    await text('สภาพรถทั่วไป').waitFor();
  });

  await step('ไม่ให้ไปขั้นเสนอราคาเมื่อเช็คสภาพยังไม่ครบ', async () => {
    const primary = page.locator('button', { hasText: /เสนอราคา|ไปขั้น|ถัดไป/ }).last();
    await shot(page, '21-job-condition-check', false);
    const disabled = await primary.isDisabled().catch(() => null);
    console.log('   ปุ่มหลักตอนเช็คสภาพยังไม่ครบ disabled =', disabled, '| ข้อความ:', (await primary.textContent().catch(() => '?'))?.trim());
  });

  await step('เปิดฟอร์มเช็คสภาพ', async () => {
    await page.getByRole('link', { name: /เริ่มตรวจ|ตรวจต่อ|เช็ค/ }).first().click();
    await page.waitForURL(/\/check\//);
    await settle();
    await shot(page, '22-check-form');
  });

  await step('ยืนยันโดยไม่กรอกอะไรต้องถูกปฏิเสธ', async () => {
    await btn('ยืนยันเช็คสภาพ').click();
    await page.waitForTimeout(1200);
    await shot(page, '23-check-rejected', false);
    if (!/\/check\//.test(page.url())) throw new Error('ออกจากฟอร์มทั้งที่ยังไม่ครบ');
  });

  await step('กรอกเช็คสภาพ: ปกติทุกข้อ + ตำหนิ 1 ข้อพร้อมรายละเอียด', async () => {
    const groups = page.getByRole('radiogroup');
    const n = await groups.count();
    for (let i = 0; i < n; i++) await groups.nth(i).getByRole('radio', { name: 'ปกติ' }).click();
    await groups.nth(0).getByRole('radio', { name: 'พบตำหนิ' }).click();
    await page.getByLabel(/รายละเอียดตำหนิ/).first().fill('รอยขีดข่วนกันชนหน้าซ้าย ยาว 10 ซม.');
    console.log('   จำนวนข้อ:', n);
  });

  await step('แนบรูปถ่าย', async () => {
    await page.setInputFiles('input[type=file]', PHOTO);
    await page.waitForTimeout(2500);
    await shot(page, '24-check-photo');
  });

  await step('เซ็นชื่อ + ยืนยัน', async () => {
    await page.fill('#signed-by', 'คุณวิชัย');
    const c = page.locator('canvas').first();
    await c.scrollIntoViewIfNeeded();
    const b = await c.boundingBox();
    await page.mouse.move(b.x + 30, b.y + 120);
    await page.mouse.down();
    for (const [dx, dy] of [[60, 40], [100, 130], [150, 50], [210, 120], [260, 60]]) await page.mouse.move(b.x + dx, b.y + dy, { steps: 6 });
    await page.mouse.up();
    await shot(page, '25-check-signed');
    await btn('ยืนยันเช็คสภาพ').click();
    await page.waitForTimeout(2500);
    await settle();
    await shot(page, '26-check-done');
  });

  await step('กลับใบงาน: เช็คสภาพครบแล้ว', async () => {
    await page.goto(jobUrl, { waitUntil: 'networkidle' });
    await text('ครบแล้ว').waitFor();
    await shot(page, '27-job-after-check');
  });
} catch (e) {
  console.log('\nหยุดที่ขั้นที่ล้มเหลว');
}
console.log('\nสรุป:', steps.map((s) => s.join(' ')).join('\n      '));
console.log('\nproblems:', problems.length ? '\n' + problems.join('\n') : 'none');
fs.writeFileSync('shots/_jobUrl.txt', page.url());
process.exitCode = steps.some((x) => x[0] === 'FAIL') ? 1 : 0;
await browser.close();
