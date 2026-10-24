// ส่วนที่ 5 (ต่อจาก flow-4): รับเงิน (QR ต้องมีสลิป) → ปิดงาน → ใบเสร็จ → ตรวจว่าแก้/ลบย้อนหลังไม่ได้ 
// (เดิม: แก้ราคา(ต้องมีเหตุผล) → ส่วนลดเกินเพดาน → เจ้าของอนุมัติ → อนุมัติใบเสนอราคา → ช่างเริ่มงาน/ส่ง QC → ผ่าน QC → มัดจำ+ชำระ → ปิดงาน → ใบเสร็จ
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

const SLIP = 'tools/dev-api/.data/files/job-files/_demo/photo.jpg';
try {
  await step('admin: เปิดใบงาน (รอชำระ)', async () => { await login(page, 'admin@demo.local'); await go(); await text('รอชำระ').waitFor(); await shot(page, '50-awaiting-payment'); });

  await step('รับชำระผ่าน QR 5,000 โดยไม่แนบสลิป → ต้องไม่ผ่าน', async () => {
    await btn(/รับชำระ ค้าง/).click();
    await page.waitForTimeout(500);
    await page.getByRole('radio', { name: 'QR พร้อมเพย์' }).click();
    await page.fill('input[inputmode=decimal]', '5000');
    await page.waitForTimeout(300);
    await shot(page, '51-pay-qr-no-slip', false);
    const save = btn(/บันทึกการรับเงิน/);
    if (!(await save.isDisabled())) {
      await save.click();
      await page.waitForTimeout(1000);
      const err = await alertText();
      console.log('   ข้อความเมื่อไม่มีสลิป:', err);
      if (!err) throw new Error('บันทึกรับเงิน QR ได้โดยไม่มีสลิปและไม่มี error');
    } else console.log('   ปุ่มบันทึก disabled จนกว่าจะแนบสลิป');
  });

  await step('แนบสลิป → บันทึกมัดจำ/ชำระบางส่วนได้', async () => {
    await page.setInputFiles('input[type=file]', SLIP);
    await page.waitForTimeout(2500);
    await shot(page, '52-pay-qr-slip', false);
    await btn(/บันทึกการรับเงิน/).click();
    await page.waitForTimeout(1500);
    await go();
    await shot(page, '53-partial-paid');
    await text('ค้าง').waitFor();
  });

  await step('ชำระเงินสดส่วนที่เหลือ', async () => {
    await btn(/รับชำระ ค้าง/).click();
    await page.waitForTimeout(500);
    await page.getByRole('radio', { name: 'เงินสด' }).click();
    const v = await page.locator('input[inputmode=decimal]').first().inputValue();
    console.log('   ยอดที่ระบบเติมให้ (ควรเป็น 5200):', v);
    if (Number(v) !== 5200) throw new Error('ยอดค้างไม่ถูกต้อง ' + v);
    await btn(/บันทึกการรับเงิน/).click();
    await page.waitForTimeout(1500);
    await go();
    await btn(/ปิดงานและออกใบเสร็จ/).waitFor();
    await shot(page, '54-ready-to-close');
  });

  await step('ปิดงาน (ต้องยืนยัน) → สถานะปิดงานแล้ว', async () => {
    await btn(/ปิดงานและออกใบเสร็จ/).click();
    await page.waitForTimeout(500);
    await shot(page, '55-confirm-close', false);
    // ฟอร์มปิดงานมีช่อง "วันที่ส่งมอบรถ" (ค่าเริ่มต้นวันนี้) — ประกันนับจากวันนี้
    const dd = await page.locator('#deliver-date').inputValue();
    console.log('   วันที่ส่งมอบเริ่มต้น:', dd);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dd)) throw new Error('ไม่มีช่องวันที่ส่งมอบ');
    await page.getByRole('button', { name: 'ปิดงาน ออกใบเสร็จ' }).click();
    await page.waitForTimeout(2000);
    await go();
    await text('ปิดงานแล้ว').waitFor();
    await shot(page, '56-closed');
  });

  await step('ใบเสร็จ + ใบรับประกัน', async () => {
    await go(jobUrl + '/receipt');
    await page.waitForTimeout(800);
    await shot(page, '57-receipt');
    const body = await page.locator('body').innerText();
    console.log('   มี "ประกัน"?', /ประกัน/.test(body), '| มี ฿10,200?', /10,200/.test(body));
    if (!/10,200/.test(body)) throw new Error('ยอดสุทธิบนใบเสร็จไม่ตรง');
  });

  await step('หลังปิดงาน: ไม่มีปุ่มแก้ราคา/เพิ่มรายการ/ลบ', async () => {
    await go();
    const n = await page.getByRole('button', { name: /เพิ่มรายการ|^แก้ไข |ลบรายการ/ }).count();
    if (n > 0) throw new Error('ยังมีปุ่มแก้ไขหลังปิดงาน ' + n);
  });
} catch (e) {
  console.log('\nหยุดที่ขั้นที่ล้มเหลว');
}
console.log('\nสรุป:\n  ' + steps.map((s) => s.join(' ')).join('\n  '));
console.log('\nproblems:', problems.length ? '\n' + problems.join('\n') : 'none');
process.exitCode = steps.some((x) => x[0] === 'FAIL') ? 1 : 0;
await browser.close();
