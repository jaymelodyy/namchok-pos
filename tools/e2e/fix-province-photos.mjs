// ทดสอบแก้ไขหลัง Jay ทดลองใช้งานจริง (2026-10-25):
//   1) ช่องจังหวัดบนป้ายต้องเลือกได้ทุกจังหวัด (เดิมเห็นแค่ "สงขลา")
//   2) ใบงานขั้น "เปิดงาน" ต้องไม่พาไปหน้าเช็คสภาพที่บันทึก/แนบรูปไม่ได้ — แสดงคำแนะนำแทน
//   3) แนบรูปเช็คสภาพได้หลายรูปในครั้งเดียว + เลือกรูปจากเครื่อง
// รันบนฐานเดโมที่เพิ่งรีเซ็ตเท่านั้น (ใช้ใบงานตัวอย่าง '1กข 2468' ขั้น opened และ 'ขจ 7733' ขั้น condition_check)
import { launch, login, shot, BASE } from './lib.mjs';
import path from 'node:path';
import pg from 'pg';

const PHOTO = path.resolve('tools/dev-api/.data/files/job-files/_demo/photo.jpg');
const { browser, page, problems } = await launch();
let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '\n    ', String(e.message).split('\n').slice(0, 3).join('\n     ')); await page.screenshot({ path: `shots/FAIL-fix-${fail}.png`, fullPage: true }).catch(() => {}); }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

const db = new pg.Client({ database: 'namchok_demo' });
await db.connect();
const tplId = (await db.query("select id from condition_templates where code = 'GEN'")).rows[0].id;
const jobIdByPlate = async (plate) => (await db.query("select j.id from job_orders j join vehicles v on v.id = j.vehicle_id where replace(v.plate, ' ', '') = replace($1, ' ', '') order by j.created_at desc limit 1", [plate])).rows[0]?.id;

await login(page, 'admin@demo.local');

await check('ช่องจังหวัด: มีให้เลือก 77 จังหวัด และเปลี่ยนเป็นจังหวัดอื่นได้ (ค่าเริ่มต้นสงขลา)', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const sel = page.locator('#plate-province');
  must((await sel.evaluate((el) => el.tagName)) === 'SELECT', 'ช่องจังหวัดไม่ใช่รายการเลือก');
  must((await sel.inputValue()) === 'สงขลา', 'ค่าเริ่มต้นไม่ใช่สงขลา');
  const n = await sel.locator('option').count();
  must(n === 77, `จำนวนจังหวัด ${n} ไม่ใช่ 77`);
  await sel.selectOption('เชียงใหม่');
  must((await sel.inputValue()) === 'เชียงใหม่', 'เลือกเชียงใหม่ไม่ติด');
  await sel.selectOption('ภูเก็ต');
  must((await sel.inputValue()) === 'ภูเก็ต', 'เลือกภูเก็ตไม่ติด');
  await shot(page, '70-province-select', false);
});

await check('เปิดรถใหม่ด้วยจังหวัดที่เลือก → จังหวัดไปขึ้นที่ป้ายในใบงาน', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.fill('#plate-input', '9กก 7777');
  await page.selectOption('#plate-province', 'ภูเก็ต');
  await page.waitForTimeout(800);
  await page.fill('#c-name', 'คุณทดสอบจังหวัด (ตัวอย่าง)');
  await page.fill('#c-phone', '0800000077');
  await page.fill('#c-odo', '1000');
  await page.fill('#c-brand', 'Toyota');
  await page.fill('#c-model', 'Vios');
  await page.fill('#c-year', '2020');
  await page.fill('#c-complaint', 'ทดสอบจังหวัด');
  await page.getByRole('button', { name: 'เปิดใบงาน' }).first().click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}/);
  await page.waitForLoadState('networkidle');
  const prov = (await db.query("select v.plate_province from vehicles v where replace(v.plate, ' ', '') = '9กก7777' limit 1")).rows[0]?.plate_province;
  must(prov === 'ภูเก็ต', `จังหวัดที่บันทึกใน DB = ${prov}`);
  await page.getByText('ภูเก็ต').first().waitFor({ timeout: 5000 });
});

const openedId = await jobIdByPlate('1กข 2468');
await check('ใบงานขั้น "เปิดงาน": ไม่มีปุ่ม "เริ่มตรวจ" แต่บอกให้กด "เริ่มเช็คสภาพรถ" ก่อน', async () => {
  must(openedId, 'ไม่พบใบงานตัวอย่างขั้น opened');
  await page.goto(`${BASE}/jobs/${openedId}`, { waitUntil: 'networkidle' });
  await page.getByTestId('check-wait-start').first().waitFor({ timeout: 5000 });
  must((await page.getByRole('link', { name: /เริ่มตรวจ/ }).count()) === 0, 'ยังมีลิงก์ "เริ่มตรวจ" ในขั้นเปิดงาน');
  await shot(page, '71-job-opened-wait', false);
});

await check('เปิดหน้าเช็คสภาพของใบงานขั้น "เปิดงาน" ตรงๆ → แจ้งเตือน + ไม่มีปุ่มแนบรูป/ลายเซ็น', async () => {
  await page.goto(`${BASE}/jobs/${openedId}/check/${tplId}`, { waitUntil: 'networkidle' });
  await page.getByTestId('check-too-early').waitFor({ timeout: 5000 });
  must((await page.getByRole('button', { name: /ถ่ายรูป|เลือกรูป/ }).count()) === 0, 'ยังมีปุ่มแนบรูป');
  must((await page.locator('canvas').count()) === 0, 'ยังมีช่องเซ็นชื่อ');
  must((await page.getByRole('button', { name: 'ยืนยันเช็คสภาพ' }).count()) === 0, 'ยังมีปุ่มยืนยัน');
  await shot(page, '72-check-too-early', false);
});

const ccId = await jobIdByPlate('ขจ 7733');
await check('ใบงานขั้น "เช็คสภาพรถ": แนบ 2 รูปพร้อมกัน แล้วเพิ่มอีก 1 รูป รวม 3 รูป (บันทึกใน DB 3 แถว)', async () => {
  await page.goto(`${BASE}/jobs/${ccId}`, { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: /เริ่มตรวจ|ทำต่อ/ }).first().click();
  await page.waitForURL(/\/check\//);
  await page.waitForLoadState('networkidle');
  must((await page.getByTestId('check-too-early').count()) === 0, 'ขั้นเช็คสภาพไม่ควรมีแจ้งเตือน too-early');
  const input = page.locator('input[type=file]');
  must((await input.getAttribute('multiple')) !== null, 'input รูปไม่รับหลายไฟล์');
  await input.setInputFiles([PHOTO, PHOTO]);
  await page.locator('img[alt="รูปสภาพรถ"]').nth(1).waitFor({ timeout: 15000 });
  must((await page.locator('img[alt="รูปสภาพรถ"]').count()) === 2, 'หลังแนบ 2 รูป ควรเห็น 2 รูป');
  await page.getByText('แนบแล้ว 2 รูป').waitFor({ timeout: 5000 });
  await input.setInputFiles([PHOTO]);
  await page.getByText('แนบแล้ว 3 รูป').waitFor({ timeout: 15000 });
  const rows = (await db.query('select count(*)::int as n from condition_check_photos p join condition_checks c on c.id = p.check_id where c.job_id = $1', [ccId])).rows[0].n;
  must(rows === 3, `DB มีรูป ${rows} แถว (ควร 3)`);
  must((await page.getByRole('button', { name: /ถ่ายรูป/ }).count()) === 1 && (await page.getByRole('button', { name: /เลือกรูป/ }).count()) === 1, 'ควรมีทั้งปุ่มถ่ายรูปและเลือกรูป');
  await shot(page, '73-check-3-photos', false);
});

await check('ปุ่ม "ถ่ายรูป" เปิดกล้อง (capture) ส่วน "เลือกรูป" ไม่บังคับกล้อง', async () => {
  const input = page.locator('input[type=file]');
  const [fc1] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /ถ่ายรูป/ }).click()]);
  must((await input.getAttribute('capture')) === 'environment', 'ปุ่มถ่ายรูปไม่ได้ตั้ง capture');
  await fc1.setFiles([]);
  const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /เลือกรูป/ }).click()]);
  must((await input.getAttribute('capture')) === null, 'ปุ่มเลือกรูปยังมี capture');
  must(fc2.isMultiple(), 'ตัวเลือกไฟล์ไม่รับหลายไฟล์');
  await fc2.setFiles([]);
});

await db.end();
console.log('\nproblems:', problems.length ? '\n' + problems.join('\n') : 'none');
console.log(`fix-province-photos: ${pass} ผ่าน / ${fail} ล้ม`);
await browser.close();
process.exit(fail ? 1 : 0);
