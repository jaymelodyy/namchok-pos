// ตรวจภาพรวม: ไม่มี horizontal scroll ที่ 320/360/390px, เมนูตามบทบาท, รายงานรายได้ตรงกับใบงานที่ปิด, หน้าจอเดสก์ท็อป
import { launch, login, shot, BASE } from './lib.mjs';
import fs from 'node:fs';

const jobUrl = fs.readFileSync('shots/_jobUrl.txt', 'utf8').trim();
const out = [];
const fails = [];
const log = (...a) => { console.log(...a); out.push(a.join(' ')); if (String(a[0]).startsWith('✗')) fails.push(a.join(' ')); };
const check = (cond, msg) => log(cond ? '✓' : '✗', msg);

// ---- 1) ไม่มี horizontal scroll ----
for (const width of [320, 360, 390]) {
  const { browser, ctx, page, problems } = await launch({ width, height: 780 });
  await login(page, 'owner@demo.local');
  const pages = ['/', '/jobs', '/requisitions', '/labor', jobUrl.replace(BASE, ''), `${jobUrl.replace(BASE, '')}/receipt`, '/catalog', '/reports', '/settings'];
  for (const p of pages) {
    await page.goto(`${BASE}${p}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    const bad = m.sw > m.iw;
    log(`${bad ? '✗' : '✓'} กว้าง ${width}px ${p.length > 30 ? p.slice(0, 14) + '…' + p.slice(-8) : p}  scrollWidth=${m.sw}`);
    if (bad) {
      const culprit = await page.evaluate((iw) => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > iw + 1).slice(0, 4).map((e) => `${e.tagName}.${String(e.className).slice(0, 60)}`), width);
      log('    ตัวการ:', culprit.join(' | '));
    }
  }
  if (problems.length) log('  problems:', problems.join(' ; '));
  await browser.close();
}

// ---- 2) เมนูตามบทบาท ----
const NAV = {};
for (const [email, role] of [['owner@demo.local', 'owner'], ['admin@demo.local', 'admin'], ['tech@demo.local', 'technician'], ['stock@demo.local', 'warehouse']]) {
  const { browser, page } = await launch();
  await login(page, email);
  await page.waitForTimeout(500);
  NAV[role] = { landed: new URL(page.url()).pathname, nav: await page.locator('nav a').allTextContents() };
  await shot(page, `60-landing-${role}`, false);
  if (role === 'warehouse') {
    await page.goto(`${BASE}/catalog`, { waitUntil: 'networkidle' });
    await shot(page, '61-catalog-warehouse');
    const t = await page.locator('body').innerText();
    check(!/฿/.test(t), 'warehouse ไม่เห็นเครื่องหมาย ฿ ในแคตตาล็อก');
    await page.goto(`${BASE}/reports`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    check(new URL(page.url()).pathname === '/requisitions', `warehouse เปิด /reports แล้วถูกส่งไป ${new URL(page.url()).pathname} (ต้องเป็น /requisitions)`);
  }
  if (role === 'technician') {
    await page.goto(`${BASE}/catalog`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    check(new URL(page.url()).pathname === '/work', `technician เปิด /catalog แล้วถูกส่งไป ${new URL(page.url()).pathname} (ต้องเป็น /work)`);
    await page.goto(`${BASE}/reports`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    check(new URL(page.url()).pathname === '/work', `technician เปิด /reports แล้วถูกส่งไป ${new URL(page.url()).pathname} (ต้องเป็น /work)`);
    await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    check(new URL(page.url()).pathname === '/work', `technician เปิด /jobs แล้วถูกส่งไป ${new URL(page.url()).pathname} (ต้องเป็น /work)`);
  }
  await browser.close();
}
log('เมนูตามบทบาท:', JSON.stringify(NAV));
const WANT = {
  owner: ['หน้าแรก', 'ใบงาน', 'เบิกอะไหล่', 'แคตตาล็อก', 'รายงาน', 'ตั้งค่า'], admin: ['หน้าแรก', 'ใบงาน', 'เบิกอะไหล่', 'แคตตาล็อก', 'ตั้งค่า'],
  technician: ['งานของฉัน', 'ค่าแรง', 'ตั้งค่า'], warehouse: ['เบิกอะไหล่', 'แคตตาล็อก', 'ตั้งค่า'],
};
for (const r of Object.keys(WANT)) check(JSON.stringify(NAV[r].nav) === JSON.stringify(WANT[r]), `เมนูของ ${r} ตรงกับที่กำหนด`);

// ---- 3) รายงานรายได้ของ owner + เดสก์ท็อป ----
{
  const { browser, page, problems } = await launch();
  await login(page, 'owner@demo.local');
  await page.goto(`${BASE}/reports`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await shot(page, '62-reports-today');
  const t = await page.locator('body').innerText();
  check(/12,050/.test(t) && /13,700/.test(t) && /1,350/.test(t) && /3,000/.test(t), 'รายงานวันนี้: รวม ฿12,050 = ค่าแรง/บริการ 13,700 + อะไหล่ 1,350 − ส่วนลด 3,000 (ตรงกับใบงานที่ปิด 2 ใบ: เดโม 1,850 + ใบทดสอบ 10,200)');
  check(/121\.03/.test(t), 'รายงานแสดง VAT ที่รวมอยู่ในราคา ฿121.03 (ใบเดโม 1,850 × 7/107) ของใบงานที่เปิด VAT');
  check(/ค่าแรงช่าง/.test(t), 'รายงานมีทางไปหน้าค่าแรงช่าง');
  log('รายงานบรรทัดหัวข้อยอดรวม:', t.split('\n').filter((l) => /฿/.test(l)).slice(0, 3).join(' / '));
  await browser.close();
}
{
  const { browser, page } = await launch({ width: 1280, height: 800 });
  await login(page, 'owner@demo.local');
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await shot(page, '63-desktop-home', false);
  await page.goto(jobUrl.replace(BASE, '') ? jobUrl : jobUrl, { waitUntil: 'networkidle' });
  await shot(page, '64-desktop-job', false);
  await browser.close();
}
fs.writeFileSync('shots/_audit.txt', out.join('\n'));
console.log(fails.length ? `\naudit ล้มเหลว ${fails.length} ข้อ` : '\naudit ผ่านทุกข้อ');
process.exitCode = fails.length ? 1 : 0;
