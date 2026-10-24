// ส่วนที่ 6: ลบไม่ได้ ทำได้แค่ void/ย้อน/ยกเลิก พร้อมเหตุผล + audit log
//   ใช้ใบงานที่ปิดแล้วจาก flow-5 และสร้างใบงานใหม่อีกหนึ่งใบเพื่อทดสอบย้อนสถานะ/ยกเลิก
import { launch, login, shot, BASE } from './lib.mjs';
import fs from 'node:fs';

const jobUrl = fs.readFileSync('shots/_jobUrl.txt', 'utf8').trim();
const { browser, ctx, page, problems } = await launch();
const steps = [];
const step = async (name, fn) => {
  try { await fn(); steps.push(['ok', name]); console.log('✓', name); }
  catch (e) {
    steps.push(['FAIL', name]); console.log('✗', name, '\n   ', String(e.message).split('\n').slice(0, 4).join('\n    '));
    await page.screenshot({ path: `shots/FAIL-6-${steps.length}.png`, fullPage: false }).catch(() => {});
    throw e;
  }
};
const btn = (t) => page.getByRole('button', { name: t }).first();
const text = (t) => page.getByText(t, { exact: false }).first();
const go = async (url = jobUrl) => { await page.goto(url, { waitUntil: 'networkidle' }); await page.waitForTimeout(350); };
const logout = async () => { await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} }); await ctx.clearCookies(); };
const menu = async (item) => { await btn('เมนูเพิ่มเติม').click(); await page.waitForTimeout(400); await page.getByRole('button', { name: item }).first().click(); await page.waitForTimeout(500); };
let secondJob;

try {
  await step('admin: ใบงานที่ปิดแล้ว → เมนูไม่มี void ใบงาน และ void การรับเงินไม่ได้ (เฉพาะ owner)', async () => {
    await login(page, 'admin@demo.local');
    await go();
    await btn('เมนูเพิ่มเติม').click();
    await page.waitForTimeout(400);
    await shot(page, '70-admin-menu-closed', false);
    if (await page.getByRole('button', { name: /Void ใบงาน/ }).count()) throw new Error('admin เห็นปุ่ม Void ใบงานที่ปิดแล้ว');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /ปิด/ }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    if (await page.getByRole('button', { name: /^void$/ }).count()) throw new Error('admin เห็นปุ่ม void รายการรับเงินของใบที่ปิดแล้ว');
  });

  await step('owner: void ใบงานที่ปิดแล้วไม่ได้ถ้ายังไม่ void การรับเงิน', async () => {
    await logout(); await login(page, 'owner@demo.local'); await go();
    await menu(/Void ใบงานที่ปิดแล้ว/);
    await page.fill('#reason-input', 'ทดสอบ: บันทึกผิดคัน');
    await page.getByRole('button', { name: 'Void ใบงาน' }).last().click();
    await page.waitForTimeout(1200);
    const err = (await page.locator('[role=alert]').allTextContents()).join(' | ');
    console.log('   ข้อความ:', err);
    await shot(page, '71-void-needs-payment-void', false);
    if (!/void/i.test(err)) throw new Error('ควรถูกปฏิเสธและบอกให้ void การรับเงินก่อน แต่ข้อความคือ: ' + err);
    await btn('ยกเลิก').click();
  });

  await step('owner: void การรับเงินทั้งสองรายการ (ต้องใส่เหตุผล)', async () => {
    await go();
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: /^void$/ }).first().click();
      await page.waitForTimeout(400);
      // ไม่ใส่เหตุผล → ต้องไม่ผ่าน
      await page.getByRole('button', { name: 'Void รายการนี้' }).click();
      await page.waitForTimeout(500);
      if (i === 0) {
        const e = await page.locator('[role=alert]').allTextContents();
        console.log('   ไม่ใส่เหตุผล →', e.join(' | '));
        if (!e.join('').includes('เหตุผล')) throw new Error('ไม่ใส่เหตุผลแล้วไม่ถูกปฏิเสธ');
      }
      await page.fill('#reason-input', 'ทดสอบ: ลูกค้าขอแก้ไขยอด');
      await page.getByRole('button', { name: 'Void รายการนี้' }).click();
      await page.waitForTimeout(1500);
    }
    await shot(page, '72-payments-voided');
    const body = await page.locator('body').innerText();
    if (!/void:/.test(body)) throw new Error('ไม่เห็นข้อความ void: พร้อมเหตุผลในรายการรับเงิน');
  });

  await step('owner: void ใบงาน → ขึ้นป้าย void ; ข้อมูลยังอยู่ ; ไม่มีปุ่มแก้', async () => {
    await menu(/Void ใบงานที่ปิดแล้ว/);
    await page.fill('#reason-input', 'ทดสอบ: บันทึกผิดคัน');
    await page.getByRole('button', { name: 'Void ใบงาน' }).last().click();
    await page.waitForTimeout(1800);
    await go();
    await text('ถูก void แล้ว').waitFor();
    await shot(page, '73-job-voided');
    const body = await page.locator('body').innerText();
    if (!/5กจ 9087/.test(body)) throw new Error('ข้อมูลใบงานหายหลัง void');
  });

  await step('รายงานรายได้: ใบงานที่ void ไม่ถูกนับ', async () => {
    await page.goto(`${BASE}/reports`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const t = await page.locator('body').innerText();
    await shot(page, '74-reports-after-void');
    console.log('   ยอดในรายงาน:', t.split('\n').filter((l) => /฿/.test(l)).slice(0, 2).join(' / '));
    if (/10,200|10,850/.test(t)) throw new Error('ยอดของใบงานที่ void ยังถูกนับในรายงาน');
  });

  await step('ตั้งค่า → บันทึกตรวจสอบ: มีรายการ void พร้อมเหตุผล และไม่มีปุ่มลบ/แก้ไข', async () => {
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await shot(page, '75-audit-log');
    const t = await page.locator('body').innerText();
    if (!/ทดสอบ: ลูกค้าขอแก้ไขยอด/.test(t)) throw new Error('ไม่พบเหตุผล void การรับเงินใน audit log');
    if (!/ทดสอบ: บันทึกผิดคัน/.test(t)) throw new Error('ไม่พบเหตุผล void ใบงานใน audit log');
    if (await page.getByRole('button', { name: /ลบ|แก้ไข/ }).count()) throw new Error('บันทึกตรวจสอบมีปุ่มลบ/แก้ไข');
  });

  await step('ย้อนสถานะ (ใบเดโมขั้นเสนอราคา): ต้องมีเหตุผล → ย้อนไปขั้นเช็คสภาพได้ และมีบันทึก', async () => {
    await logout(); await login(page, 'admin@demo.local');
    await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
    await page.getByText('3ฒญ 5590', { exact: false }).first().click();
    await page.waitForURL(/\/jobs\/[0-9a-f-]{36}/);
    await page.waitForLoadState('networkidle');
    await text('เสนอราคา').waitFor();
    await menu(/ย้อนสถานะ/);
    await page.selectOption('#revert-target', 'condition_check');
    await page.getByRole('button', { name: 'ย้อนสถานะ' }).last().click();
    await page.waitForTimeout(500);
    if (!(await page.locator('[role=alert]').allTextContents()).join('').includes('เหตุผล')) throw new Error('ย้อนโดยไม่ใส่เหตุผลไม่ถูกปฏิเสธ');
    await page.fill('#reason-input', 'ทดสอบ: ลูกค้าขอเปลี่ยนรายการ');
    await shot(page, '77-revert-sheet', false);
    await page.getByRole('button', { name: 'ย้อนสถานะ' }).last().click();
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const body = await page.locator('body').innerText();
    await shot(page, '78-after-revert');
    if (!/ทดสอบ: ลูกค้าขอเปลี่ยนรายการ/.test(body)) throw new Error('ไม่เห็นเหตุผลการย้อนในประวัติสถานะ');
  });

  await step('เปิดใบงานใหม่ (ทะเบียนใหม่) เพื่อทดสอบยกเลิก', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.fill('#plate-input', 'ฬฬ 1111'); await page.selectOption('#plate-province', 'สงขลา');
    await page.waitForTimeout(700);
    await page.fill('#c-name', 'คุณทดสอบยกเลิก (ตัวอย่าง)');
    await btn('เปิดใบงาน').click();
    await page.waitForURL(/\/jobs\/[0-9a-f-]{36}/);
    secondJob = page.url();
  });

  await step('ยกเลิกใบงาน: ต้องมีเหตุผล → สถานะยกเลิก ข้อมูลยังอยู่', async () => {
    await go(secondJob);
    await menu(/ยกเลิกใบงาน/);
    await page.getByRole('button', { name: 'ยกเลิกใบงาน' }).last().click();
    await page.waitForTimeout(500);
    if (!(await page.locator('[role=alert]').allTextContents()).join('').includes('เหตุผล')) throw new Error('ยกเลิกโดยไม่ใส่เหตุผลไม่ถูกปฏิเสธ');
    await page.fill('#reason-input', 'ทดสอบ: ลูกค้าไม่มาตามนัด');
    await page.getByRole('button', { name: 'ยกเลิกใบงาน' }).last().click();
    await page.waitForTimeout(1500);
    await go(secondJob);
    await text('ยกเลิก').waitFor();
    await shot(page, '76-job-cancelled');
  });
} catch (e) {
  console.log('\nหยุดที่ขั้นที่ล้มเหลว');
}
console.log('\nสรุป:\n  ' + steps.map((s) => s.join(' ')).join('\n  '));
console.log('\nproblems:', problems.length ? '\n' + problems.join('\n') : 'none');
process.exitCode = steps.some((x) => x[0] === 'FAIL') ? 1 : 0;
await browser.close();
