// ตัวช่วยสำหรับสคริปต์ทดสอบหน้าจอ (Playwright + Chromium ที่ติดตั้งในเครื่อง) — ใช้กับ dev-api เท่านั้น
import { chromium } from 'playwright-core';
import fs from 'node:fs';

export const BASE = process.env.APP_URL ?? 'http://localhost:3100';
export const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
export const SHOTS = process.env.SHOTS_DIR ?? 'shots';
fs.mkdirSync(SHOTS, { recursive: true });

export async function launch({ width = 390, height = 844 } = {}) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1.5, isMobile: width < 768, hasTouch: width < 768, locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/_next/')) problems.push(`http ${r.status()} ${r.request().method()} ${r.url().replace(/\?.*/, '').slice(0, 120)}`); });
  return { browser, ctx, page, problems };
}

export async function login(page, email, password = 'demo1234') {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  await page.waitForLoadState('networkidle');
}

export const shot = async (page, name, full = true) => {
  await page.bringToFront().catch(() => {});   // แท็บที่ถูกซ่อน (context เดียวกันมีหลายแท็บ) ถ่ายภาพไม่ได้ — รอฟอนต์ค้าง
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
  console.log('shot', name);
};

// ---------- ตัวช่วยสำหรับสคริปต์เฟส 2 (หลาย browser context พร้อมกัน) ----------
import { chromium as _chromium } from 'playwright-core';

/** เปิด browser เดียว แล้วแยก context ต่อผู้ใช้ (คนละ session เหมือนคนละเครื่อง) */
export async function openActors(emails, { width = 390, height = 844 } = {}) {
  const browser = await _chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const actors = {};
  for (const [key, email] of Object.entries(emails)) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1.5, isMobile: width < 768, hasTouch: width < 768, locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
    const page = await ctx.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
    await login(page, email);
    actors[key] = { ctx, page, problems, email };
  }
  return { browser, actors };
}

/** รอจนเงื่อนไขเป็นจริง แล้วคืนจำนวน ms ที่ใช้ (ล้มถ้าเกิน timeout) */
export async function waitMs(fn, { timeout = 8000, every = 100, what = 'เงื่อนไข' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = await fn(); } catch { ok = false; }
    if (ok) return Date.now() - t0;
    if (Date.now() - t0 > timeout) throw new Error(`รอ "${what}" เกิน ${timeout} ms`);
    await new Promise((r) => setTimeout(r, every));
  }
}

/** ชุดทดสอบแบบเรียงขั้น: step() พิมพ์ผล ✓/✗ แล้วหยุดที่ขั้นแรกที่ล้ม */
export function runner(name) {
  const steps = [];
  return {
    steps,
    async step(label, fn, page) {
      try { const r = await fn(); steps.push(['ok', label]); console.log('✓', label); return r; }
      catch (e) {
        steps.push(['FAIL', label]); console.log('✗', label, '\n   ', String(e.message).split('\n').slice(0, 4).join('\n    '));
        await page?.screenshot({ path: `${SHOTS}/FAIL-${name}-${steps.length}.png` }).catch(() => {});
        throw e;
      }
    },
    finish(problems = []) {
      const failed = steps.some((s) => s[0] === 'FAIL');
      console.log(`\n${name}: ${steps.filter((s) => s[0] === 'ok').length} ผ่าน / ${steps.filter((s) => s[0] === 'FAIL').length} ล้ม`);
      console.log('problems:', problems.length ? '\n' + problems.join('\n') : 'none');
      return failed ? 1 : 0;
    },
  };
}
