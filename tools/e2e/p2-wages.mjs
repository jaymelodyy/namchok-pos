// ค่าแรงรายวัน (0013) ผ่านหน้าจอจริง บนฐานข้อมูลเดโม
//   * ช่างกดลงเวลาเข้างานเอง → DB มีแถววันนี้ ; หน้า admin ที่เปิดค้างไว้เห็นชื่อช่างเอง (ไม่รีโหลด)
//   * admin บันทึกงาน "งานไฟฟ้า" 2 ชิ้น → DB เก็บเรต ณ ตอนบันทึก ; ช่างอีกคนเห็นยอดของทีม
//   * ช่างไม่เห็นฟอร์มจัดการ/เลขบัญชี ; แถบล่างมือถือไม่เกิน 5 ปุ่มทุกบทบาท ; /wages ไม่มี horizontal scroll ที่ 320px
// หมายเหตุ: Realtime เป็นตัวจำลองของ dev-api ไม่ใช่ Supabase ตัวจริง
import { execFileSync } from 'node:child_process';
import { openActors, waitMs, runner, shot, BASE, launch, login } from './lib.mjs';

const R = runner('p2-wages');
const sql = (q) => execFileSync('psql', ['-d', process.env.DEMO_DB ?? 'namchok_demo', '-tAc', q], { encoding: 'utf8', env: process.env }).trim();
const TECH = '33333333-3333-4333-8333-333333333333';
const today = sql("select (now() at time zone 'Asia/Bangkok')::date::text");
const { browser, actors } = await openActors({ admin: 'admin@demo.local', tech: 'tech@demo.local', tech2: 'tech2@demo.local' });
const A = actors.admin.page, T = actors.tech.page, T2 = actors.tech2.page;

let rc = 0;
try {
  await R.step('ทุกคนเปิด /wages ; ช่างหนึ่งยังไม่ได้ลงเวลาวันนี้', async () => {
    for (const p of [A, T, T2]) await p.goto(`${BASE}/wages`, { waitUntil: 'networkidle' });
    if (sql(`select count(*) from wage_attendance where user_id='${TECH}' and work_date='${today}'`) !== '0') throw new Error('มีบันทึกเวลาอยู่ก่อนแล้ว');
    await A.evaluate(() => { window.__keep = 1; });
  });

  await R.step('ช่างกด "ลงเวลาเข้างาน" → DB มีแถววันนี้ และปุ่มเปลี่ยนเป็น "ลงเวลาออกงาน"', async () => {
    await T.getByRole('button', { name: 'ลงเวลาเข้างาน' }).click();
    await waitMs(async () => sql(`select count(*) from wage_attendance where user_id='${TECH}' and work_date='${today}'`) === '1', { what: 'แถวลงเวลาใน DB' });
    await T.getByRole('button', { name: 'ลงเวลาออกงาน' }).waitFor({ timeout: 8000 });
    await shot(T, 'wages-1-tech-clocked-in', false);
  });

  await R.step('หน้า admin ที่เปิดค้างไว้ (ไม่รีโหลด) เห็น "ช่างหนึ่ง" ในรายการประจำวันเอง', async () => {
    await waitMs(async () => /ช่างหนึ่ง/.test(await A.locator('[data-testid=wage-summary] ~ *').allInnerTexts().then((x) => x.join(' '))), { timeout: 10000, what: 'ชื่อช่างบนหน้า admin' });
    if (!(await A.evaluate(() => window.__keep === 1))) throw new Error('หน้า admin ถูกรีโหลด');
  });

  await R.step('admin บันทึกงานไฟฟ้า 2 ชิ้นให้ช่างหนึ่ง → DB เก็บเรต 20 ยอด 40', async () => {
    const form = A.locator('form').filter({ has: A.getByRole('button', { name: 'บันทึกงาน' }) });
    await form.locator('select').nth(0).selectOption({ label: 'ช่างหนึ่ง' });
    const typeOpt = await form.locator('select').nth(1).locator('option').filter({ hasText: /ไฟฟ้า/ }).first().getAttribute('value');
    await form.locator('select').nth(1).selectOption(typeOpt);
    await form.getByLabel('จำนวน').fill('2');
    await form.getByRole('button', { name: 'บันทึกงาน' }).click();
    await waitMs(async () => sql(`select unit_rate::int||'/'||amount::int from wage_work_entries where user_id='${TECH}' and work_date='${today}' and voided_at is null`) === '20/40', { what: 'รายการงานใน DB' });
    await shot(A, 'wages-2-admin-recorded', true);
  });

  await R.step('ช่างสองเห็นยอดของช่างหนึ่ง (รวมงาน ฿40) แต่ไม่เห็นฟอร์มจัดการ/เลขบัญชี', async () => {
    await waitMs(async () => /ช่างหนึ่ง/.test(await T2.locator('body').innerText()), { timeout: 10000, what: 'ชื่อช่างหนึ่งบนหน้าช่างสอง' });
    const t = await T2.locator('body').innerText();
    if (/เลขบัญชี|เพิ่มบัญชีช่าง|บันทึกงาน/.test(t)) throw new Error('ช่างเห็นส่วนของผู้จัดการ');
    if (await T2.getByRole('button', { name: 'ลงเวลาเข้างาน' }).count() !== 1) throw new Error('ช่างสองไม่มีปุ่มลงเวลาของตัวเอง');
  });

  await R.step('แถบล่างมือถือ (390px) ไม่เกิน 5 ปุ่ม: admin และช่าง', async () => {
    for (const [who, p] of [['admin', A], ['tech', T]]) {
      const n = await p.locator('nav a:visible').count();
      if (n > 5) throw new Error(`${who} มี ${n} ปุ่มในแถบล่าง`);
    }
  });
} catch { rc = 1; } finally {
  await browser.close();
}

// เจ้าของ: แถบล่าง ≤5 + /wages ที่ 320px ไม่มี horizontal scroll
const { browser: b2, page, problems } = await launch({ width: 320, height: 700 });
try {
  await login(page, 'owner@demo.local');
  await R.step('เจ้าของ 320px: แถบล่าง ≤5 ปุ่ม และ /wages ไม่มี horizontal scroll', async () => {
    await page.goto(`${BASE}/wages`, { waitUntil: 'networkidle' });
    const n = await page.locator('nav a:visible').count();
    if (n > 5) throw new Error(`owner มี ${n} ปุ่มในแถบล่าง`);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 0) throw new Error(`horizontal scroll ${over}px`);
    await shot(page, 'wages-3-owner-320', true);
  });
} catch { rc = 1; } finally {
  await b2.close();
}
const allProblems = [...Object.values(actors).flatMap((a) => a.problems), ...problems];
process.exit(R.finish(allProblems) || rc);
