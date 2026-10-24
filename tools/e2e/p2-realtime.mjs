// เฟส 2 — เรียลไทม์ข้ามเครื่อง (หลาย browser context พร้อมกัน ไม่มีการรีโหลดหน้า)
//   admin (บอร์ด) + คลัง (หน้าเบิกอะไหล่) + ช่าง (หน้างานของฉัน) เปิดค้างไว้ ; admin อนุมัติใบเสนอราคา → คลังจัดเตรียม/ส่งมอบ → ช่างเห็นงานว่าง
//   * วัดเวลาที่หน้าจออัปเดตเอง (ต้อง ≤ 5 วินาที) และยืนยันว่าหน้าไม่ได้รีโหลด (ตัวแปร window.__keep ยังอยู่)
//   * ข้อควรทราบ: ทดสอบกับ "ตัวจำลอง Realtime ของ dev-api" — ไม่ใช่ Supabase Realtime ตัวจริง
//   * แล้วทดสอบทางสำรอง: ตัดการเชื่อมต่อ WebSocket → หน้าจอยังตามทันด้วยการโพล (30 วิ) และเมื่อกลับมาออนไลน์
import { openActors, waitMs, runner, shot, BASE } from './lib.mjs';

const R = runner('p2-realtime');
const { browser, actors } = await openActors({ admin: 'admin@demo.local', stock: 'stock@demo.local', tech: 'tech@demo.local' });
const { admin, stock, tech } = actors;
const PLATE = 'กข 6001';
const LIMIT = 5000;
const times = {};
const keep = (page) => page.evaluate(() => { window.__keep = 'still-here'; });
const kept = (page) => page.evaluate(() => window.__keep === 'still-here');

try {
  await R.step('เปิดหน้าค้างไว้ 3 เครื่อง: admin=บอร์ด, คลัง=เบิกอะไหล่, ช่าง=งานของฉัน', async () => {
    await admin.page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
    await stock.page.goto(`${BASE}/requisitions`, { waitUntil: 'networkidle' });
    await tech.page.goto(`${BASE}/work`, { waitUntil: 'networkidle' });
    for (const a of [admin, stock, tech]) await keep(a.page);
    await waitMs(async () => (await admin.page.locator('[data-testid=board]').count()) > 0, { what: 'บอร์ดแสดง' });
    await waitMs(async () => /live|สด/.test(await admin.page.locator('header').first().innerText()), { what: 'สถานะเชื่อมต่อสด', timeout: 6000 });
  }, admin.page);

  const base = {};
  await R.step('บันทึกค่าเริ่มต้น: จำนวนคำขอเบิกที่คลัง และตำแหน่งใบงานบนบอร์ด', async () => {
    base.req = Number(await stock.page.locator('[data-testid=tab-requested] [data-testid=tab-count]').innerText());
    const inQuoting = await admin.page.locator('[data-col=quoting] [data-testid=board-card]', { hasText: PLATE }).count();
    if (inQuoting !== 1) throw new Error(`ใบงาน ${PLATE} ควรอยู่คอลัมน์ "เสนอราคา" แต่พบ ${inQuoting}`);
    console.log('   คำขอเบิกค้างที่คลังตอนนี้:', base.req);
  });

  await R.step('admin (อีกหน้าต่าง) อนุมัติใบเสนอราคา', async () => {
    const act = await admin.ctx.newPage();
    await act.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
    await act.locator('[data-testid=view-list]').click();
    await act.getByText(PLATE).first().click();
    await act.waitForURL(/\/jobs\/[0-9a-f-]{36}/);
    await act.getByRole('button', { name: 'ลูกค้าอนุมัติใบเสนอราคา' }).click();
    await act.waitForTimeout(400);
    times.t0 = Date.now();
    await act.getByRole('button', { name: 'ลูกค้าอนุมัติใบเสนอราคา' }).last().click();
    await act.waitForTimeout(800);
    await act.close();
  });

  await R.step(`คลังเห็นคำขอเบิกใหม่เด้งขึ้นเองภายใน ${LIMIT / 1000} วินาที (+ แจ้งเตือน) โดยไม่รีโหลด`, async () => {
    const ms = await waitMs(async () => (await stock.page.locator('[data-testid=req-card]', { hasText: PLATE }).count()) === 1, { timeout: LIMIT, what: 'การ์ดคำขอเบิกที่คลัง' });
    times.stockSees = Date.now() - times.t0; console.log('   คลังเห็นหลังกดอนุมัติ', times.stockSees, 'ms');
    const cnt = Number(await stock.page.locator('[data-testid=tab-requested] [data-testid=tab-count]').innerText());
    if (cnt !== base.req + 1) throw new Error(`จำนวนบนแท็บ "ขอเบิก" ควรเป็น ${base.req + 1} แต่เป็น ${cnt}`);
    await waitMs(async () => /มีคำขอเบิกอะไหล่ใหม่/.test(await stock.page.locator('body').innerText()), { timeout: 3000, what: 'toast แจ้งเตือนคำขอใหม่' });
    if (!(await kept(stock.page))) throw new Error('หน้าคลังถูกรีโหลด');
    await shot(stock.page, 'p2-rt-1-stock-new-request', false);
    if (ms > LIMIT) throw new Error('ช้าเกิน');
  }, stock.page);

  await R.step('คลังไม่เห็นชื่อลูกค้า/เบอร์/ราคา บนการ์ดคำขอเบิก', async () => {
    const card = stock.page.locator('[data-testid=req-card]', { hasText: PLATE });
    const t = await card.innerText();
    if (/฿/.test(t) || /คุณทดสอบเรียลไทม์/.test(t) || /0800000011/.test(t)) throw new Error('การ์ดคลังมีข้อมูลที่ไม่ควรเห็น: ' + t);
  });

  await R.step('บอร์ดของ admin: ใบงานย้ายไปคอลัมน์ "รออะไหล่" พร้อมป้าย "ขอเบิก" เอง', async () => {
    await waitMs(async () => (await admin.page.locator('[data-col=requisition] [data-testid=board-card]', { hasText: PLATE }).count()) === 1, { timeout: LIMIT, what: 'ใบงานย้ายคอลัมน์' });
    const chip = await admin.page.locator('[data-col=requisition] [data-testid=board-card]', { hasText: PLATE }).locator('[data-testid=req-chip]').innerText();
    if (!/ขอเบิก/.test(chip)) throw new Error('ป้ายคำขอควรเป็น "ขอเบิก" แต่เป็น: ' + chip);
    if (!(await kept(admin.page))) throw new Error('บอร์ดถูกรีโหลด');
    await shot(admin.page, 'p2-rt-2-board-requisition', false);
  }, admin.page);

  await R.step('คลังกด "จัดเตรียมแล้ว" → admin เห็นป้ายเปลี่ยนเอง + ได้แจ้งเตือน', async () => {
    times.t1 = Date.now();
    await stock.page.locator('[data-testid=req-card]', { hasText: PLATE }).locator('[data-testid=req-advance]').click();
    await waitMs(async () => /จัดเตรียมแล้ว/.test(await admin.page.locator('[data-col=requisition] [data-testid=board-card]', { hasText: PLATE }).locator('[data-testid=req-chip]').innerText()), { timeout: LIMIT, what: 'ป้ายเปลี่ยนเป็นจัดเตรียมแล้ว' });
    console.log('   admin เห็นหลังคลังกด', Date.now() - times.t1, 'ms');
    await waitMs(async () => /คลังจัดเตรียมอะไหล่แล้ว/.test(await admin.page.locator('body').innerText()), { timeout: 3000, what: 'toast ถึง admin' });
  }, admin.page);

  await R.step('คลังกด "ส่งมอบแล้ว" → ใบงานเป็น "พร้อมทำ" เอง : บอร์ด admin ย้ายคอลัมน์ + ช่างเห็นงานว่างพร้อมแจ้งเตือน', async () => {
    await stock.page.locator('[data-testid=tab-prepared]').click();
    times.t2 = Date.now();
    await stock.page.locator('[data-testid=req-card]', { hasText: PLATE }).locator('[data-testid=req-advance]').click();
    await waitMs(async () => (await admin.page.locator('[data-col=ready] [data-testid=board-card]', { hasText: PLATE }).count()) === 1, { timeout: LIMIT, what: 'ใบงานเข้าคอลัมน์พร้อมทำ' });
    times.adminReady = Date.now() - times.t2; console.log('   บอร์ด admin เห็น "พร้อมทำ" หลังส่งมอบ', times.adminReady, 'ms');
    await waitMs(async () => (await tech.page.locator('[data-testid=group-open] [data-testid=work-card]', { hasText: PLATE }).count()) === 1, { timeout: LIMIT, what: 'งานว่างขึ้นที่หน้าช่าง' });
    times.techSees = Date.now() - times.t2; console.log('   ช่างเห็นงานว่างหลังส่งมอบ', times.techSees, 'ms');
    await waitMs(async () => /มีงานพร้อมทำ/.test(await tech.page.locator('body').innerText()), { timeout: 3000, what: 'toast แจ้งช่าง' });
    for (const a of [admin, stock, tech]) if (!(await kept(a.page))) throw new Error('มีหน้าที่ถูกรีโหลด: ' + a.email);
    await shot(tech.page, 'p2-rt-3-tech-open-job', false);
    await shot(admin.page, 'p2-rt-4-board-ready', false);
    if (times.adminReady > LIMIT || times.techSees > LIMIT) throw new Error('ช้ากว่า 5 วินาที');
  }, tech.page);

  await R.step('หน้าคลังย้ายรายการไปแท็บ "ส่งมอบแล้ว" และจำนวนแท็บ "ขอเบิก" กลับมาเท่าเดิม', async () => {
    await waitMs(async () => Number(await stock.page.locator('[data-testid=tab-requested] [data-testid=tab-count]').innerText()) === base.req, { timeout: 3000, what: 'จำนวนแท็บ' });
  });

  // ---- ทางสำรอง: ตัดเรียลไทม์ ----
  // หมายเหตุ: ctx.setOffline() ของ Playwright "ไม่ตัด" WebSocket ที่ต่ออยู่แล้ว (รอบแรกที่ลองตัวบอกจึงยังเป็น "สด") จึงใช้ routeWebSocket ตัดที่ตัว socket แทน
  const cut = { on: false, live: new Set() };
  await tech.ctx.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    if (cut.on) { ws.close(); return; }                 // ช่วงที่ตัด: ทุกการต่อใหม่ถูกปิดทันที
    const server = ws.connectToServer();
    const pair = { ws, server }; cut.live.add(pair);
    ws.onClose(() => cut.live.delete(pair));
  });
  const cutNow = async () => { cut.on = true; for (const p of [...cut.live]) { p.ws.close(); await p.server.close().catch(() => {}); } };

  await R.step('ทางสำรอง: หน้าช่างเสียการเชื่อมต่อเรียลไทม์ → ตัวบอกเป็น "ออฟไลน์" ; ระหว่างหลุดงานถูกรับจนเต็ม ; พอต่อกลับหน้าตามทันเองโดยไม่รีโหลด', async () => {
    await tech.page.reload({ waitUntil: 'networkidle' });      // โหลดใหม่ 1 ครั้ง เพื่อให้ socket ใหม่ผ่านตัวควบคุม
    await keep(tech.page);
    await waitMs(async () => /สด/.test(await tech.page.locator('header').first().innerText()), { timeout: 8000, what: 'หน้าช่างต่อเรียลไทม์ได้ก่อนตัด' });
    if ((await tech.page.locator('[data-testid=group-open] [data-testid=work-card]', { hasText: PLATE }).count()) !== 1) throw new Error('ก่อนตัด ช่างควรเห็นงาน ' + PLATE);

    await cutNow();
    await waitMs(async () => /ออฟไลน์/.test(await tech.page.locator('header').first().innerText()), { timeout: 15000, what: 'ตัวบอกสถานะเป็นออฟไลน์' });
    await shot(tech.page, 'p2-rt-5-tech-offline', false);

    // ระหว่างหลุด: admin (ยังออนไลน์) มอบหมายช่างสอง → งานเต็ม ควรหายจากรายการงานว่างของช่างหนึ่ง แต่หน้าช่างหนึ่งยังไม่รู้
    const act = await admin.ctx.newPage();
    await act.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
    await act.locator('[data-testid=view-list]').click();
    await act.getByText(PLATE).first().click();
    await act.waitForURL(/\/jobs\/[0-9a-f-]{36}/);
    await act.getByRole('button', { name: 'มอบหมายช่าง' }).click();
    await act.getByRole('button', { name: /ช่างสอง/ }).click();
    await act.getByText('มอบหมายช่างแล้ว').waitFor({ timeout: 5000 });
    await act.close();
    await tech.page.waitForTimeout(2500);
    const stale = await tech.page.locator('[data-testid=group-open] [data-testid=work-card]', { hasText: PLATE }).count();
    if (stale !== 1) throw new Error(`ระหว่างหลุด หน้าช่างควรยังแสดงข้อมูลเดิม (1) แต่เป็น ${stale} — แปลว่ามีช่องทางอื่นอัปเดต หรือการตัดไม่ได้ผล`);
    console.log('   ระหว่างหลุด หน้าช่างยังเห็นงานเดิม (ข้อมูลค้าง) — ตามคาด');

    cut.on = false; times.t3 = Date.now();                       // ปล่อยให้ต่อกลับ → supabase-js ต่อใหม่เอง → SUBSCRIBED → โหลดซ้ำ
    await waitMs(async () => (await tech.page.locator('[data-testid=group-open] [data-testid=work-card]', { hasText: PLATE }).count()) === 0, { timeout: 30000, every: 300, what: 'หน้าช่างตามทันหลังต่อกลับ' });
    times.reconnectCatchUp = Date.now() - times.t3; console.log('   ต่อกลับแล้วตามทันใน', times.reconnectCatchUp, 'ms');
    await waitMs(async () => /สด/.test(await tech.page.locator('header').first().innerText()), { timeout: 5000, what: 'ตัวบอกกลับเป็นสด' });
    if (!(await kept(tech.page))) throw new Error('หน้าถูกรีโหลดระหว่างต่อกลับ');
  }, tech.page);

  await R.step('บอร์ด admin แสดงช่างสองรับงานบนการ์ด + แถบสถานะช่างเปลี่ยนเอง', async () => {
    await waitMs(async () => (await admin.page.locator('[data-col=ready] [data-testid=board-card]', { hasText: PLATE }).locator('[data-testid=crew-chip]', { hasText: 'ช่างสอง' }).count()) === 1, { timeout: LIMIT, what: 'ชื่อช่างบนการ์ด' });
    const chip = admin.page.locator('[data-testid=tech-strip] [data-tech="ช่างสอง"]');
    console.log('   แถบสถานะช่างสอง:', (await chip.innerText()).replace(/\s+/g, ' '), '| data-state =', await chip.getAttribute('data-state'));
    if ((await chip.getAttribute('data-state')) === 'free') throw new Error('สถานะช่างสองยังเป็น free ทั้งที่รับงานแล้ว');
  });

  await R.step('ทางสำรองสุดท้าย: หน้าที่ WebSocket ใช้ไม่ได้เลย → ยังตามทันด้วยการโพลทุก 30 วินาที (รอได้ ≤ 45 วินาที)', async () => {
    // เปิดหน้าใหม่ของ admin ที่ WebSocket ถูกปิดทุกครั้งที่ต่อ แล้วดูว่ายังเห็นการเปลี่ยนแปลงจากการโพลอย่างเดียว
    const blocked = await admin.ctx.newPage();
    await blocked.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => { ws.close(); });
    await blocked.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
    await keep(blocked);
    await waitMs(async () => /ออฟไลน์/.test(await blocked.locator('header').first().innerText()), { timeout: 20000, what: 'ตัวบอกออฟไลน์เมื่อ WebSocket ใช้ไม่ได้' });
    await blocked.locator('[data-testid=view-board]').click();          // มุมมองถูกจำใน localStorage ของ context (ขั้นก่อนหน้ากด "รายการ" ไว้)
    await waitMs(async () => (await blocked.locator('[data-col=ready] [data-testid=board-card]', { hasText: PLATE }).count()) === 1, { timeout: 8000, what: 'ก่อนเปลี่ยน ใบงานอยู่คอลัมน์พร้อมทำ' });
    // เปลี่ยนสถานะผ่านหน้าอื่น: เริ่มงาน (พร้อมทำ → กำลังทำ)
    const act2 = await admin.ctx.newPage();
    await act2.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
    await act2.locator('[data-testid=view-list]').click();
    await act2.getByText(PLATE).first().click();
    await act2.waitForURL(/\/jobs\/[0-9a-f-]{36}/);
    await act2.getByRole('button', { name: 'เริ่มงาน' }).click();
    await act2.waitForTimeout(1200);
    await act2.close();
    const t0 = Date.now();
    await waitMs(async () => (await blocked.locator('[data-col=in_progress] [data-testid=board-card]', { hasText: PLATE }).count()) === 1, { timeout: 45000, every: 500, what: 'โพลตามทัน' });
    times.pollCatchUp = Date.now() - t0; console.log('   หน้าที่ไม่มี WebSocket ตามทันด้วยการโพลใน', times.pollCatchUp, 'ms');
    if (!(await kept(blocked))) throw new Error('หน้าถูกรีโหลด');
    await blocked.close();
  });
} catch (e) { console.log('\nหยุดที่ขั้นที่ล้มเหลว'); }

console.log('\nเวลาที่วัดได้ (ms):', JSON.stringify(times));
const problems = [admin, stock, tech].flatMap((a) => a.problems.map((p) => `${a.email}: ${p}`));
process.exitCode = R.finish(problems);
await browser.close();
