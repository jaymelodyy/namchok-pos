// เฟส 2 — ช่าง 2 คนกด "รับงานนี้" พร้อมกันบนใบงานที่ต้องการช่าง 1 คน (กข 6002)
//   0012: จำนวนช่างเป็นค่าแนะนำ → ต้องได้ทั้งสองคน ไม่มีแถวซ้ำ ; บอร์ด admin เปลี่ยนเองโดยไม่รีโหลด
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

  await R.step('ช่าง 2 คนกด "รับงานนี้" พร้อมกัน → ได้ทั้งคู่ (0012: ไม่จำกัดจำนวนช่าง)', async () => {
    await Promise.all([
      card(tech.page, 'open').locator('[data-testid=accept-btn]').click(),
      card(tech2.page, 'open').locator('[data-testid=accept-btn]').click(),
    ]);
    await waitMs(async () => (await card(tech.page, 'mine').count()) + (await card(tech2.page, 'mine').count()) === 2,
      { timeout: 8000, what: 'ทั้งสองคนได้งาน' });
    for (const a of [tech, tech2]) {
      if ((await card(a.page, 'open').count()) !== 0) throw new Error(`${a.email}: การ์ดยังค้างในงานว่าง`);
      await waitMs(async () => /รับงานแล้ว/.test(await a.page.locator('body').innerText()), { timeout: 4000, what: 'ข้อความรับงานแล้ว' });
    }
    await shot(tech.page, 'p2-race-2-both', false);
  });

  await R.step('ฐานข้อมูล: มีช่างรับงาน 2 คน ไม่มีแถวซ้ำ', async () => {
    const id = sql(`select id from v_jobs where plate = '${PLATE}'`);
    const rows = sql(`select u.full_name from job_assignments a join users u on u.id = a.user_id where a.job_id = '${id}' and a.released_at is null order by 1`).split('\n').filter(Boolean);
    if (rows.join(',') !== [NAME.tech, NAME.tech2].sort().join(',')) throw new Error('ใน DB มีช่างรับ: ' + rows.join(', '));
    console.log('   DB:', rows.join(', '));
  });

  await R.step('บอร์ด admin: การ์ดแสดงชื่อช่างทั้งสอง + แถบสถานะเปลี่ยนเอง (ไม่รีโหลด)', async () => {
    const col = admin.page.locator('[data-col=ready] [data-testid=board-card]', { hasText: PLATE });
    for (const who of ['tech', 'tech2']) {
      await waitMs(async () => (await col.locator('[data-testid=crew-chip]', { hasText: NAME[who] }).count()) === 1, { timeout: 5000, what: 'ชื่อ ' + NAME[who] + ' บนการ์ด' });
      const st = await admin.page.locator(`[data-testid=tech-strip] [data-tech="${NAME[who]}"]`).getAttribute('data-state');
      if (st === 'free') throw new Error(`แถบสถานะ ${NAME[who]} ยังเป็น free`);
    }
    if (!(await kept(admin.page))) throw new Error('บอร์ดถูกรีโหลด');
    await shot(admin.page, 'p2-race-4-board', false);
  }, admin.page);

  await R.step('การ์ดงานของช่างไม่มีตัวเลขเงิน/ราคา', async () => {
    const t = await card(tech.page, 'mine').innerText();
    if (/฿/.test(t)) throw new Error('การ์ดช่างมีตัวเลขเงิน: ' + t);
  });
} catch { console.log('\nหยุดที่ขั้นที่ล้มเหลว'); }

const problems = [admin, tech, tech2].flatMap((a) => a.problems.map((p) => `${a.email}: ${p}`));
process.exitCode = R.finish(problems);
await browser.close();
