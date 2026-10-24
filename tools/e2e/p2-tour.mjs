// เดินดูหน้าจอเฟส 2 ของแต่ละบทบาทแล้วถ่ายภาพ + รายงาน error ที่เจอ (ไม่ตรวจพฤติกรรม — ดู p2-*.mjs)
import { launch, login, shot, BASE } from './lib.mjs';
const out = process.env.SHOTS_DIR ?? 'shots';
let bad = 0;

async function role(email, steps) {
  const { browser, page, problems } = await launch();
  await login(page, email);
  for (const [name, path, after] of steps) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    if (after) await after(page);
    await shot(page, `p2-${name}`);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  console.log(email, 'ล้นแนวนอน:', overflow, ' problems:', problems.length ? '\n' + problems.join('\n') : 'none');
  if (problems.length) bad++;
  await browser.close();
}

await role('admin@demo.local', [
  ['admin-board', '/jobs'],
  ['admin-list', '/jobs', async (p) => { await p.click('[data-testid=view-list]'); await p.waitForTimeout(300); }],
  ['admin-req', '/requisitions'],
]);
await role('tech@demo.local', [['tech-work', '/work'], ['tech-labor', '/labor']]);
await role('stock@demo.local', [['stock-req', '/requisitions'], ['stock-req-prepared', '/requisitions', async (p) => { await p.click('[data-testid=tab-prepared]'); }]]);
await role('owner@demo.local', [['owner-labor', '/labor'], ['owner-reports', '/reports']]);
process.exit(bad ? 1 : 0);
