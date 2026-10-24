// เฟส 2 — ช่าง 2 คนกด "รับงานนี้" พร้อมกันบนใบงานที่ต้องการช่าง 1 คน (กข 6002)
//   ต้องได้ผู้ชนะ "เพียงคนเดียว" ; ผู้แพ้เห็นข้อความว่าเต็มแล้วและการ์ดหายจากงานว่าง ; บอร์ด admin เปลี่ยนเองโดยไม่รีโหลด
//   (ระดับฐานข้อมูลมีเทสต์ชิงงานพร้อมกันหลาย connection อยู่แล้วใน supabase/tests/run.mjs — สคริปต์นี้ทดสอบฝั่งหน้าจอ 1 รอบ)
import { execFileSync } from 'node:child_process';
import { openActors, waitMs, runner, shot, BASE } from './lib.mjs';

const R = runner('p2-accept-race');
const PLATE = 'กข 6002';
const sql = (q) => execFileSync('psql', ['-d', process.env.DEMO_DB ?? 'namchok_demo', '-tAc', q], { encoding: 'utf8', env: process.env }).trim();
const { browser, actors } = await openActors({ admin: 'admin@demo.local', tech: 'tech@demo.local', tech2: 'tech2@demo.local' });
const { admin, tech, tech2 } = actors;
const keep = (p) => p.evaluate(() => { window.__keep = 'still-here'; });
const kept = (p) => p.evaluate(() => window.__keep === 'still-here');
const card = (p, group) => p.locator(`[data-testid=group-${group}] [data-testid=work-card]`, { hasText: PLATE });
const NAME = { tech: 'ช่างหนึ่ง', tech2: 'ช่างสอง' };
let winner, loser;

try {
  await R.step('เปิดหน้าค้างไว้: ช่างสองคนที่ "งานของฉัน" และ admin ที่บอร์ด', async () => {
    await tech.page.goto(`${BASE}/work`, { waitUntil: 'networkidle' });
    await tech2.page.goto(`${BASE}/work`, { waitUntil: 'networkidle' });
    await admin.page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
    await admin.page.locator('[data-testid=view-board]').click();
    for (const a of [admin, tech, tech2]) await keep(a.page);
    for (const a of [tech, tech2]) {
      if ((await card(a.page, 'open').count()) !== 1) throw new Error(`${a.email} ควรเห็นงาน ${PLATE} ในกลุ่มงานว่าง`);
    }
    await waitMs(async () => (await admin.page.locator('[data-col=ready] [data-testid=board-card]', { hasText: PLATE }).count()) === 1, { what: 'การ์ดบนบอร์ด' });
    const chip = await admin.page.locator('[data-col=ready] [data-testid=board-card]', { hasText: PLATE }).locator('[data-testid=crew-chip]').innerText();
    if (!/ยังไม่มีช่างรับ/.test(chip)) throw new Error('ก่อนรับ การ์ดควรเขียนว่ายังไม่มีช่างรับ แต่เป็น: ' + chip);
    await shot(tech.page, 'p2-race-1-before', false);
  });

  await R.step('ฐานข้อมูล: ก่อนกด ยังไม่มีช่างรับงานนี้ (0 คน) และงานต้องการช่าง 1 คน', async () => {
    const id = sql(`select id from v_jobs where plate = '${PLATE}'`);
    const n = Number(sql(`select count(*) from job_assignments where job_id = '${id}' and released_at is null`));
    if (n !== 0) throw new Error('ก่อนทดสอบมีช่างรับอยู่แล้ว ' + n + ' คน — รัน reset-demo.sh ก่อน');
  });

  await R.step('ช่าง 2 คนกด "รับงานนี้" พร้อมกัน → ผู้ชนะ 1 คนเท่านั้น', async () => {
    await Promise.all([
      card(tech.page, 'open').locator('[data-testid=accept-btn]').click(),
      card(tech2.page, 'open').locator('[data-testid=accept-btn]').click(),
    ]);
    // รอให้ทั้งสองหน้าแสดงผลลัพธ์: ใครอยู่กลุ่ม "กำลังรับผิดชอบ" = ผู้ชนะ
    await waitMs(async () => {
      const a = await card(tech.page, 'mine').count(); const b = await card(tech2.page, 'mine').count();
      return a + b >= 1;
    }, { timeout: 8000, what: 'มีผู้ชนะ' });
    await tech.page.waitForTimeout(1200); await tech2.page.waitForTimeout(1200);
    const mineA = await card(tech.page, 'mine').count(); const mineB = await card(tech2.page, 'mine').count();
    if (mineA + mineB !== 1) throw new Error(`ควรมีผู้ชนะ 1 คน แต่ tech=${mineA}, tech2=${mineB}`);
    winner = mineA ? 'tech' : 'tech2'; loser = mineA ? 'tech2' : 'tech';
    console.log('   ผู้ชนะ:', NAME[winner], '| ผู้แพ้:', NAME[loser]);
  });

  await R.step('ผู้แพ้: เห็นข้อความ "รับครบแล้ว" และการ์ดหายจากงานว่าง ; ผู้ชนะ: ได้ข้อความรับงานแล้ว', async () => {
    const L = actors[loser].page, W = actors[winner].page;
    await waitMs(async () => /มีช่างรับครบแล้ว/.test(await L.locator('body').innerText()), { timeout: 4000, what: 'ข้อความแจ้งผู้แพ้' });
    await shot(L, 'p2-race-2-loser', false);
    if ((await card(L, 'open').count()) !== 0) throw new Error('การ์ดยังค้างในงานว่างของผู้แพ้');
    if ((await card(L, 'mine').count()) !== 0) throw new Error('ผู้แพ้ไม่ควรมีงานนี้ในงานของฉัน');
    await waitMs(async () => /รับงานแล้ว/.test(await W.locator('body').innerText()), { timeout: 4000, what: 'ข้อความแจ้งผู้ชนะ' });
    await shot(W, 'p2-race-3-winner', false);
  });

  await R.step('ฐานข้อมูล: มีช่างรับงานพอดี 1 คน และเป็นผู้ชนะ (ไม่เกินจำนวนที่ต้องการ)', async () => {
    const id = sql(`select id from v_jobs where plate = '${PLATE}'`);
    const rows = sql(`select u.full_name from job_assignments a join users u on u.id = a.user_id where a.job_id = '${id}' and a.released_at is null order by 1`).split('\n').filter(Boolean);
    if (rows.length !== 1) throw new Error('ใน DB มีช่างรับ ' + rows.length + ' คน: ' + rows.join(', '));
    if (rows[0] !== NAME[winner]) throw new Error(`ผู้ชนะบนหน้าจอคือ ${NAME[winner]} แต่ DB บันทึก ${rows[0]}`);
    console.log('   DB:', rows[0]);
  });

  await R.step('บอร์ด admin: การ์ดแสดงชื่อผู้ชนะ + แถบสถานะช่างเปลี่ยนเป็น "รับงานแล้ว" เอง (ไม่รีโหลด)', async () => {
    const col = admin.page.locator('[data-col=ready] [data-testid=board-card]', { hasText: PLATE });
    await waitMs(async () => (await col.locator('[data-testid=crew-chip]', { hasText: NAME[winner] }).count()) === 1, { timeout: 5000, what: 'ชื่อผู้ชนะบนการ์ด' });
    if ((await col.locator('[data-testid=crew-chip]', { hasText: NAME[loser] }).count()) !== 0) throw new Error('การ์ดมีชื่อผู้แพ้');
    const st = await admin.page.locator(`[data-testid=tech-strip] [data-tech="${NAME[winner]}"]`).getAttribute('data-state');
    if (st === 'free') throw new Error('แถบสถานะช่างผู้ชนะยังเป็น free');
    if (!(await kept(admin.page))) throw new Error('บอร์ดถูกรีโหลด');
    await shot(admin.page, 'p2-race-4-board', false);
  }, admin.page);

  await R.step('การ์ดงานของผู้ชนะไม่มีตัวเลขเงิน/ราคา', async () => {
    const W = actors[winner].page;
    const t = await card(W, 'mine').innerText();
    if (/฿/.test(t)) throw new Error('การ์ดช่างมีตัวเลขเงิน: ' + t);
  });
} catch { console.log('\nหยุดที่ขั้นที่ล้มเหลว'); }

// ผู้แพ้ได้ HTTP 400 จากการรับงานที่เต็มแล้ว (คาดไว้) → เบราว์เซอร์รายงานเป็น console error 1 ข้อความ ตัดออกจากรายการปัญหา
const expected = (p) => /status of 400/.test(p);
const problems = [admin, tech, tech2].flatMap((a) => a.problems.filter((p) => !expected(p)).map((p) => `${a.email}: ${p}`));
const dropped = [tech, tech2].reduce((n, a) => n + a.problems.filter(expected).length, 0);
if (dropped) console.log(`(ตัดออก ${dropped} รายการ: HTTP 400 ที่คาดไว้จากผู้แพ้ที่ชิงงานไม่ทัน)`);
process.exitCode = R.finish(problems);
await browser.close();
