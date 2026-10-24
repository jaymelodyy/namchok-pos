// ทดสอบเกณฑ์ข้อ 1: เปิดใบงานจากทะเบียนภายใน 30 วินาที และประวัติเด้งขึ้นมา (ในฐานะ admin บนมือถือ)
import { launch, login, shot, BASE } from './lib.mjs';

const { browser, page, problems } = await launch();
await login(page, 'admin@demo.local');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

const t0 = Date.now();
await page.fill('#plate-input', 'กษ4821');           // พิมพ์ไม่เว้นวรรค ระบบต้องเจอเพราะ plate_norm
await page.waitForTimeout(900);
await shot(page, '10-home-history');
const hit = page.locator('button', { hasText: 'Fortuner' }).first();
console.log('history hit visible:', await hit.isVisible());
await hit.click();
await page.waitForTimeout(500);
await shot(page, '11-home-picked');
await page.fill('#c-complaint', 'แอร์ไม่เย็นอีกแล้ว ลองตรวจซ้ำ');
await page.fill('#p-odo', '143500');
await page.click('button:has-text("เปิดใบงาน")');
await page.waitForURL(/\/jobs\/[0-9a-f-]{36}/, { timeout: 15000 });
console.log('เวลาตั้งแต่พิมพ์ทะเบียนถึงเข้าใบงาน (ms, รวมค่าหน่วงของสคริปต์):', Date.now() - t0);
await page.waitForLoadState('networkidle');
await shot(page, '12-job-opened');
console.log('url', page.url());
console.log('\nproblems:', problems.length ? '\n' + problems.join('\n') : 'none');
await browser.close();
