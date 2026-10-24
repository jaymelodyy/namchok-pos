// เดินดูทุกหน้าหลักในฐานะ owner แล้วถ่ายภาพ + รายงาน error ที่เจอ
import { launch, login, shot, BASE } from './lib.mjs';

const { browser, page, problems } = await launch();
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await shot(page, '01-login');
await login(page, 'owner@demo.local');
await shot(page, '02-home');
await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
await shot(page, '03-jobs');
const links = await page.$$eval('a[href^="/jobs/"]', (as) => as.map((a) => a.getAttribute('href')));
console.log('job links', links);
for (const [i, href] of links.entries()) {
  await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle' });
  await shot(page, `04-job-${i}`);
}
for (const [n, p] of [['05-catalog', '/catalog'], ['06-reports', '/reports'], ['07-settings', '/settings']]) {
  await page.goto(`${BASE}${p}`, { waitUntil: 'networkidle' });
  await shot(page, n);
}
console.log('\nproblems:', problems.length ? '\n' + problems.join('\n') : 'none');
await browser.close();
