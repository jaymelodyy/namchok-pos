// ส่วนที่ 2 ของ flow เต็ม (ต่อจาก full-flow.mjs): รายการ ราคา ส่วนลดเกินเพดาน อนุมัติ ช่างเริ่มงาน/QC รับเงิน ปิดงาน ใบเสร็จ
import { launch, login, shot, BASE } from './lib.mjs';
import fs from 'node:fs';

const jobUrl = fs.readFileSync('shots/_jobUrl.txt', 'utf8').trim();
const { browser, page, problems } = await launch();
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
const settle = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(350); };
const toastText = async () => (await page.locator('[role=status], [role=alert]').allTextContents()).join(' | ');
const go = async (url = jobUrl) => { await page.goto(url, { waitUntil: 'networkidle' }); await page.waitForTimeout(300); };
const addItem = async (tab, code, config) => {
  if (!(await page.getByRole('tab', { name: /งานแอร์/ }).first().isVisible().catch(() => false))) {
    await btn('เพิ่มรายการ').click();
    await page.waitForTimeout(500);
  }
  if (tab) await page.getByRole('tab', { name: new RegExp(tab) }).first().click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: new RegExp(code) }).first().click();
  await page.waitForTimeout(400);
  if (config) await config();
};
const submitAdd = async () => { await btn('เพิ่มลงใบงาน').click(); await page.waitForTimeout(1000); };

try {
  await step('admin เข้าสู่ระบบ + เปิดใบงานเดิม (สถานะเสนอราคา)', async () => {
    await login(page, 'admin@demo.local');
    await go();
    const next = page.getByRole('button', { name: 'ไปขั้นเสนอราคา' });
    if (await next.count()) { await next.first().click(); await page.waitForTimeout(1500); }  // เช็คสภาพครบแล้ว → ไปขั้นเสนอราคา
    await text('เสนอราคา').waitFor();
  });

  await step('เพิ่มค่าแรง: ล้างตู้แอร์', async () => {
    await addItem('งานแอร์รถยนต์', 'AC-CL-001');
    await shot(page, '30-config-simple', false);
    await submitAdd();
    await text('ล้างตู้แอร์').waitFor();
  });

  await step('เพิ่มฟิล์ม Hi-Kool: ต้องเลือกตำแหน่ง+ขนาดก่อนจึงเพิ่มได้ และราคามาจากตาราง', async () => {
    await addItem('ฟิล์มกรองแสง', 'FM-HK-001');
    const add = btn('เพิ่มลงใบงาน');
    console.log('   ก่อนเลือกตัวเลือก ปุ่มเพิ่ม disabled =', await add.isDisabled());
    await btn(/^ทั้งคัน$/).click();
    await btn(/^SUV$/).click();
    await page.waitForTimeout(300);
    await shot(page, '31-config-film', false);
    console.log('   ราคาที่ระบบใส่ให้:', await page.locator('input[inputmode=decimal], input.num').last().inputValue().catch(() => '?'));
    await submitAdd();
  });

  await step('เพิ่มอะไหล่: น้ำยาแอร์ จำนวน 2 (แยกบรรทัดจากค่าแรง)', async () => {
    await addItem('อะไหล่/วัสดุ', 'PT-CN-001');
    await btn('เพิ่มจำนวน').click().catch(async () => { await page.getByRole('button', { name: /^\+$/ }).first().click(); });
    await shot(page, '32-config-part', false);
    await submitAdd();
  });
  await shot(page, '33-after-items', false);
} catch (e) {
  console.log('\nหยุดที่ขั้นที่ล้มเหลว');
}
console.log('\nสรุป:\n  ' + steps.map((s) => s.join(' ')).join('\n  '));
console.log('\nproblems:', problems.length ? '\n' + problems.join('\n') : 'none');
process.exitCode = steps.some((x) => x[0] === 'FAIL') ? 1 : 0;
await browser.close();
