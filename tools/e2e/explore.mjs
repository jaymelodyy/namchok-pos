// สำรวจหน้าจอ: node tools/e2e/explore.mjs <email> <path> [คลิกข้อความ...]  → ถ่ายภาพเป็น shots/x-*.png
import { launch, login, shot, BASE } from './lib.mjs';
const [email, p, ...clicks] = process.argv.slice(2);
const { browser, page, problems } = await launch();
await login(page, email);
await page.goto(p.startsWith('http') ? p : `${BASE}${p}`, { waitUntil: 'networkidle' });
await shot(page, 'x-0', false);
let i = 1;
for (const c of clicks) {
  if (c.startsWith('btn:')) await page.getByRole('button', { name: new RegExp(c.slice(4)) }).first().click();
  else await page.getByText(c, { exact: false }).first().click();
  await page.waitForTimeout(700);
  await shot(page, `x-${i++}`, false);
}
console.log('problems:', problems.length ? '\n' + problems.join('\n') : 'none');
await browser.close();
