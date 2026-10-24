-- =====================================================================
-- real-smoke.sql — ทดสอบสิทธิ์ตามบทบาท + flow หลัก บน "ฐานข้อมูล Supabase จริง" ผ่าน SQL
-- ทำงานในธุรกรรมเดียวแล้ว RAISE EXCEPTION ตอนท้ายเสมอ → ข้อมูลทดสอบ "ย้อนกลับทั้งหมด" (ไม่ทิ้งใบงาน/เลขเอกสาร/audit ไว้)
-- ผลลัพธ์อยู่ในข้อความ error ที่ขึ้นต้นด้วย "REPORT"
-- ต้องมีบัญชี owner/manager/tech1-4 (ดู README หัวข้อสร้างผู้ใช้) และ seed แล้ว
-- วิธีสลับผู้ใช้: ตั้ง request.jwt.claims (sub) + set local role authenticated — auth.uid() ของ Supabase อ่านจากค่านี้
-- ข้อจำกัด: เป็นการทดสอบระดับฐานข้อมูล (PostgREST/GoTrue/Realtime/Storage API ไม่ได้ถูกทดสอบ) และรันทีละคำสั่งในลำดับเดียว
--          ไม่ใช่การแย่งกดพร้อมกันจริง (ส่วนนั้นทดสอบในเครื่องที่ p2-accept-race)
-- =====================================================================
do $t$
declare
  v_rep text := '';
  v_err text;
  v_branch uuid; v_owner uuid; v_admin uuid; v_t1 uuid; v_t2 uuid; v_t3 uuid; v_t4 uuid;
  v_svc uuid; v_part uuid; v_tpl uuid;
  v_job uuid; v_chk uuid; v_req uuid; v_rc uuid; v_pay uuid;
  n int; m numeric; s text;
  v_ans jsonb := '{"body":{"state":"ok"},"glass":{"state":"ok"},"interior":{"state":"ok"},"warning":{"state":"ok"},"belongings":{"state":"ok"}}';
  v_qc jsonb := '{"work_done":true,"function_ok":true,"clean":true,"no_new_damage":true}';
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  -- ---------- เตรียมข้อมูล (สิทธิ์ postgres) ----------
  select id into v_branch from branches where code = 'NTW';
  select id into v_owner from auth.users where email = 'owner@ntw.invalid';
  select id into v_admin from auth.users where email = 'manager@ntw.invalid';
  select id into v_t1 from auth.users where email = 'tech1@ntw.invalid';
  select id into v_t2 from auth.users where email = 'tech2@ntw.invalid';
  select id into v_t3 from auth.users where email = 'tech3@ntw.invalid';
  select id into v_t4 from auth.users where email = 'tech4@ntw.invalid';
  select id into v_svc from catalog_items where code = 'AC-RF-001';
  select id into v_part from catalog_items where code = 'PT-CN-001';
  select id into v_tpl from condition_templates where code = 'GEN';
  if v_owner is null or v_admin is null or v_t1 is null or v_t2 is null or v_t3 is null or v_t4 is null then
    raise exception 'REPORT: ไม่พบบัญชีทดสอบครบ';
  end if;
  update item_prices set price = 1000 where item_id = v_svc;
  update item_prices set price = 300  where item_id = v_part;
  update catalog_items set crew_size = 2, labor_rate = 100 where id = v_svc;   -- งานนี้ต้องใช้ช่าง 2 คน ค่าแรง 100 ต่อหน่วย

  -- ---------- แอดมิน เปิดใบงาน ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_job := open_job(p_plate => 'ทดสอบ 9999', p_customer_name => 'ลูกค้าทดสอบ', p_complaint => 'smoke test');
  v_rep := v_rep || format(E'%s | admin เปิดใบงานได้ (job=%s)\n', case when v_job is not null then 'PASS' else 'FAIL' end, v_job);

  -- ช่างยังไม่เห็นใบงานที่อยู่ขั้น "เปิดใบงาน"
  perform set_config('request.jwt.claims', json_build_object('sub', v_t1, 'role', 'authenticated')::text, true);
  select count(*) into n from job_orders where id = v_job;
  v_rep := v_rep || format(E'%s | ช่างยังไม่เห็นใบงานขั้นเปิดใบงาน (เห็น %s แถว)\n', case when n = 0 then 'PASS' else 'FAIL' end, n);

  -- แอดมินเลื่อนไปขั้นเช็คสภาพ ; ช่างเห็นได้และช่วยเช็คสภาพได้
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform advance_job(v_job);
  perform set_config('request.jwt.claims', json_build_object('sub', v_t1, 'role', 'authenticated')::text, true);
  select count(*) into n from job_orders where id = v_job;
  v_rep := v_rep || format(E'%s | ช่างเห็นใบงานขั้นเช็คสภาพ (เห็น %s แถว)\n', case when n = 1 then 'PASS' else 'FAIL' end, n);
  v_chk := save_condition_check(v_job, v_tpl, v_ans, null);
  perform add_condition_photo(v_chk, v_branch::text || '/' || v_job::text || '/cond/smoke.jpg', 'smoke');
  perform complete_condition_check(v_chk, v_branch::text || '/' || v_job::text || '/sig/smoke.png', 'ลูกค้าทดสอบ');
  v_rep := v_rep || E'PASS | ช่างบันทึก/แนบรูป/ยืนยันเช็คสภาพได้\n';

  -- แอดมินเสนอราคา
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform advance_job(v_job);
  perform add_job_item(v_job, v_svc);
  perform add_job_item(v_job, v_part);
  select grand_total into m from v_job_totals where job_id = v_job;
  v_rep := v_rep || format(E'%s | admin เห็นยอดบิล = 1300 (ได้ %s)\n', case when m = 1300 then 'PASS' else 'FAIL' end, m);

  perform set_config('request.jwt.claims', json_build_object('sub', v_t1, 'role', 'authenticated')::text, true);
  select count(*) into n from job_items where job_id = v_job;
  v_rep := v_rep || format(E'%s | ช่างอ่าน job_items ตรง ๆ ไม่ได้ (เห็น %s แถว)\n', case when n = 0 then 'PASS' else 'FAIL' end, n);
  select count(*) into n from item_prices;
  v_rep := v_rep || format(E'%s | ช่างอ่านราคาแคตตาล็อก item_prices ไม่ได้ (เห็น %s แถว)\n', case when n = 0 then 'PASS' else 'FAIL' end, n);

  -- ลูกค้าอนุมัติ → สร้างคำขอเบิกอะไหล่
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform approve_quote(v_job, 'smoke');
  select id into v_req from requisitions where job_id = v_job;
  v_rep := v_rep || format(E'%s | อนุมัติใบเสนอราคา → เกิดคำขอเบิก 1 ใบ (req=%s)\n', case when v_req is not null then 'PASS' else 'FAIL' end, v_req);

  perform set_config('request.jwt.claims', json_build_object('sub', v_t1, 'role', 'authenticated')::text, true);
  select count(*) into n from requisitions;
  v_rep := v_rep || format(E'%s | ช่างไม่เห็นคำขอเบิก (เห็น %s แถว)\n', case when n = 0 then 'PASS' else 'FAIL' end, n);
  select count(*) into n from job_orders where id = v_job;
  v_rep := v_rep || format(E'%s | ช่างยังไม่เห็นใบงานที่รออะไหล่ (เห็น %s แถว)\n', case when n = 0 then 'PASS' else 'FAIL' end, n);

  -- คลัง (ใช้ admin แทน เพราะยังไม่มีบัญชีคลัง) เตรียม+ส่งมอบ → ใบงานเป็น "พร้อมทำ" เอง
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform advance_requisition(v_req);
  perform advance_requisition(v_req);
  select status::text into s from job_orders where id = v_job;
  v_rep := v_rep || format(E'%s | ส่งมอบอะไหล่ครบ → ใบงานเป็น ready เอง (สถานะ %s)\n', case when s = 'ready' then 'PASS' else 'FAIL' end, s);

  -- ช่างเห็นงานว่าง ; เงินเป็น NULL ; ยอดใน v_jobs เป็น 0 (ไม่รั่ว)
  perform set_config('request.jwt.claims', json_build_object('sub', v_t3, 'role', 'authenticated')::text, true);
  select count(*) into n from job_orders where id = v_job;
  v_rep := v_rep || format(E'%s | ช่าง 3 เห็นงานว่าง (พร้อมทำ ทีมยังไม่เต็ม) (เห็น %s แถว)\n', case when n = 1 then 'PASS' else 'FAIL' end, n);
  select count(*) into n from job_items_for_job(v_job);
  select count(*) filter (where unit_price is not null or line_total is not null or cost is not null) into m from job_items_for_job(v_job);
  v_rep := v_rep || format(E'%s | ช่างดูรายการงานได้ %s รายการ แต่ค่าเงินที่ไม่ใช่ NULL = %s\n', case when n = 2 and m = 0 then 'PASS' else 'FAIL' end, n, m);
  select count(*) into n from v_jobs where id = v_job;
  select coalesce(max(grand_total), -1) into m from v_jobs where id = v_job;
  v_rep := v_rep || format(E'%s | ช่างดู v_jobs: แถว=%s ยอดบิลที่เห็น=%s (ต้องไม่ใช่ 1300)\n', case when m <> 1300 then 'PASS' else 'FAIL' end, n, m);
  select count(*) into n from payments;
  v_rep := v_rep || format(E'%s | ช่างอ่าน payments ไม่ได้ (เห็น %s แถว)\n', case when n = 0 then 'PASS' else 'FAIL' end, n);

  -- ช่าง 1,2 รับงาน (ต้องใช้ 2 คน) ; ช่าง 3 รับไม่ได้เพราะเต็ม
  perform set_config('request.jwt.claims', json_build_object('sub', v_t1, 'role', 'authenticated')::text, true);
  perform accept_job(v_job);
  perform set_config('request.jwt.claims', json_build_object('sub', v_t2, 'role', 'authenticated')::text, true);
  perform accept_job(v_job);
  v_rep := v_rep || E'PASS | ช่าง 1 และ ช่าง 2 รับงานได้\n';
  perform set_config('request.jwt.claims', json_build_object('sub', v_t3, 'role', 'authenticated')::text, true);
  v_err := null;
  begin perform accept_job(v_job); exception when others then v_err := sqlerrm; end;
  v_rep := v_rep || format(E'%s | ช่าง 3 รับงานที่เต็มแล้วไม่ได้: %s\n', case when v_err is not null then 'PASS' else 'FAIL' end, coalesce(v_err, '(ไม่มี error!)'));
  select count(*) into n from job_orders where id = v_job;
  v_rep := v_rep || format(E'%s | ใบงานที่ทีมเต็มหายไปจากหน้าของช่าง 3 (เห็น %s แถว)\n', case when n = 0 then 'PASS' else 'FAIL' end, n);

  -- ช่างที่ไม่ได้รับงานเริ่มงานไม่ได้ ; ช่างแก้ตารางตรง ๆ ไม่ได้
  perform set_config('request.jwt.claims', json_build_object('sub', v_t4, 'role', 'authenticated')::text, true);
  v_err := null;
  begin perform advance_job(v_job); exception when others then v_err := sqlerrm; end;
  v_rep := v_rep || format(E'%s | ช่าง 4 (ไม่ได้รับงาน) เริ่มงานไม่ได้: %s\n', case when v_err is not null then 'PASS' else 'FAIL' end, coalesce(v_err, '(ไม่มี error!)'));
  v_err := null;
  begin update job_orders set status = 'closed' where id = v_job; exception when others then v_err := sqlerrm; end;
  v_rep := v_rep || format(E'%s | ช่างสั่ง UPDATE job_orders ตรง ๆ ไม่ได้: %s\n', case when v_err is not null then 'PASS' else 'FAIL' end, coalesce(v_err, '(ไม่มี error!)'));

  -- ช่าง 1 เริ่มงาน → ส่งตรวจ QC
  perform set_config('request.jwt.claims', json_build_object('sub', v_t1, 'role', 'authenticated')::text, true);
  perform advance_job(v_job);
  perform advance_job(v_job);
  select status::text into s from job_orders where id = v_job;
  v_rep := v_rep || format(E'%s | ช่าง 1 เริ่มงานและส่งตรวจ QC (สถานะ %s)\n', case when s = 'qc' then 'PASS' else 'FAIL' end, s);
  v_err := null;
  begin perform qc_pass(v_job, v_qc, null, '{}'); exception when others then v_err := sqlerrm; end;
  v_rep := v_rep || format(E'%s | ช่างกดผ่าน QC เองไม่ได้: %s\n', case when v_err is not null then 'PASS' else 'FAIL' end, coalesce(v_err, '(ไม่มี error!)'));

  -- แอดมิน ผ่าน QC → รับเงินครบ → ปิดงาน
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform qc_pass(v_job, v_qc, null, '{}');
  v_err := null;
  begin perform close_job(v_job); exception when others then v_err := sqlerrm; end;
  v_rep := v_rep || format(E'%s | ปิดงานทั้งที่ยังไม่รับเงินไม่ได้: %s\n', case when v_err is not null then 'PASS' else 'FAIL' end, coalesce(v_err, '(ไม่มี error!)'));
  v_pay := record_payment(v_job, 'payment', 'cash', 1300);
  v_rc := close_job(v_job);
  select status::text into s from job_orders where id = v_job;
  v_rep := v_rep || format(E'%s | รับเงิน 1300 แล้วปิดงานได้ ออกใบเสร็จ (สถานะ %s)\n', case when s = 'closed' and v_rc is not null then 'PASS' else 'FAIL' end, s);

  -- ค่าแรง: 100 ÷ 2 ช่าง = 50 ต่อคน ; ช่างเห็นเฉพาะของตัวเอง ; admin ไม่เห็น ; owner เห็นทั้งหมด
  perform set_config('request.jwt.claims', json_build_object('sub', v_t1, 'role', 'authenticated')::text, true);
  select count(*), coalesce(sum(amount), 0) into n, m from labor_pay_entries;
  v_rep := v_rep || format(E'%s | ช่าง 1 เห็นค่าแรงตัวเอง 1 รายการ 50.00 (ได้ %s รายการ %s)\n', case when n = 1 and m = 50 then 'PASS' else 'FAIL' end, n, m);
  perform set_config('request.jwt.claims', json_build_object('sub', v_t2, 'role', 'authenticated')::text, true);
  select count(*), coalesce(sum(amount), 0) into n, m from labor_pay_entries;
  v_rep := v_rep || format(E'%s | ช่าง 2 เห็นค่าแรงตัวเอง 1 รายการ 50.00 (ได้ %s รายการ %s)\n', case when n = 1 and m = 50 then 'PASS' else 'FAIL' end, n, m);
  perform set_config('request.jwt.claims', json_build_object('sub', v_t3, 'role', 'authenticated')::text, true);
  select count(*) into n from labor_pay_entries;
  v_rep := v_rep || format(E'%s | ช่าง 3 (ไม่ได้ทำงานนี้) ไม่เห็นค่าแรงของใคร (เห็น %s แถว)\n', case when n = 0 then 'PASS' else 'FAIL' end, n);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  select count(*) into n from labor_pay_entries;
  v_rep := v_rep || format(E'%s | admin ไม่เห็นค่าแรงช่าง (เห็น %s แถว)\n', case when n = 0 then 'PASS' else 'FAIL' end, n);
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  select count(*), coalesce(sum(amount), 0) into n, m from labor_pay_entries;
  v_rep := v_rep || format(E'%s | owner เห็นค่าแรงทั้งหมด 2 รายการ รวม 100.00 (ได้ %s รายการ %s)\n', case when n = 2 and m = 100 then 'PASS' else 'FAIL' end, n, m);

  -- รายงาน/จ่ายค่าแรง: owner เท่านั้น
  select coalesce(sum(revenue), 0) into m from report_revenue(v_today, v_today);
  v_rep := v_rep || format(E'%s | owner ดูรายงานรายได้ได้ รวม 1300 (ได้ %s)\n', case when m = 1300 then 'PASS' else 'FAIL' end, m);
  select mark_labor_paid(v_t1, v_today, v_today)::numeric into m;
  v_rep := v_rep || format(E'%s | owner ติ๊กจ่ายค่าแรงช่าง 1 ได้ %s รายการ\n', case when m = 1 then 'PASS' else 'FAIL' end, m);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_err := null;
  begin perform report_revenue(v_today, v_today); exception when others then v_err := sqlerrm; end;
  v_rep := v_rep || format(E'%s | admin ดูรายงานรายได้ไม่ได้: %s\n', case when v_err is not null then 'PASS' else 'FAIL' end, coalesce(v_err, '(ไม่มี error!)'));
  v_err := null;
  begin perform mark_labor_paid(v_t2, v_today, v_today); exception when others then v_err := sqlerrm; end;
  v_rep := v_rep || format(E'%s | admin ติ๊กจ่ายค่าแรงไม่ได้: %s\n', case when v_err is not null then 'PASS' else 'FAIL' end, coalesce(v_err, '(ไม่มี error!)'));

  -- ห้ามลบข้อมูล แม้เป็นเจ้าของ
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_err := null;
  begin delete from job_orders where id = v_job; exception when others then v_err := sqlerrm; end;
  v_rep := v_rep || format(E'%s | owner สั่ง DELETE job_orders ไม่ได้: %s\n', case when v_err is not null then 'PASS' else 'FAIL' end, coalesce(v_err, '(ไม่มี error!)'));

  -- Storage policy (ตรวจ policy ที่ storage.objects โดยตรง ไม่ผ่าน Storage API) : สลิปห้ามช่าง
  perform set_config('request.jwt.claims', json_build_object('sub', v_t1, 'role', 'authenticated')::text, true);
  v_err := null;
  begin
    insert into storage.objects(bucket_id, name, owner, owner_id)
    values ('job-files', v_branch::text || '/' || v_job::text || '/slip/smoke.jpg', v_t1, v_t1::text);
  exception when others then v_err := sqlerrm; end;
  v_rep := v_rep || format(E'%s | ช่างอัปโหลดไฟล์ในโฟลเดอร์ slip ไม่ได้: %s\n', case when v_err is not null then 'PASS' else 'FAIL' end, coalesce(v_err, '(ไม่มี error!)'));
  v_err := null;
  begin
    insert into storage.objects(bucket_id, name, owner, owner_id)
    values ('job-files', v_branch::text || '/' || v_job::text || '/cond/smoke2.jpg', v_t1, v_t1::text);
  exception when others then v_err := sqlerrm; end;
  v_rep := v_rep || format(E'%s | ช่างอัปโหลดรูปเช็คสภาพ (โฟลเดอร์ cond) ได้: %s\n', case when v_err is null then 'PASS' else 'FAIL' end, coalesce(v_err, 'ok'));
  v_err := null;
  begin
    insert into storage.objects(bucket_id, name, owner, owner_id)
    values ('job-files', gen_random_uuid()::text || '/' || v_job::text || '/cond/other-branch.jpg', v_t1, v_t1::text);
  exception when others then v_err := sqlerrm; end;
  v_rep := v_rep || format(E'%s | อัปโหลดเข้าโฟลเดอร์สาขาอื่นไม่ได้: %s\n', case when v_err is not null then 'PASS' else 'FAIL' end, coalesce(v_err, '(ไม่มี error!)'));

  -- anon (ยังไม่ล็อกอิน) ต้องเข้าอะไรไม่ได้เลย
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  v_err := null;
  begin perform count(*) from branches; exception when others then v_err := sqlerrm; end;
  v_rep := v_rep || format(E'%s | anon อ่านตาราง branches ไม่ได้: %s\n', case when v_err is not null then 'PASS' else 'FAIL' end, coalesce(v_err, '(ไม่มี error!)'));
  v_err := null;
  begin perform open_job(p_plate => 'x', p_customer_name => 'x'); exception when others then v_err := sqlerrm; end;
  v_rep := v_rep || format(E'%s | anon เรียก open_job ไม่ได้: %s\n', case when v_err is not null then 'PASS' else 'FAIL' end, coalesce(v_err, '(ไม่มี error!)'));
  v_err := null;
  begin perform count(*) from v_jobs; exception when others then v_err := sqlerrm; end;
  v_rep := v_rep || format(E'%s | anon อ่าน v_jobs ไม่ได้: %s\n', case when v_err is not null then 'PASS' else 'FAIL' end, coalesce(v_err, '(ไม่มี error!)'));

  execute 'reset role';
  select count(*) into n from audit_logs where record_id::text in (v_job::text);
  v_rep := v_rep || format(E'INFO | audit_logs ที่อ้างใบงานทดสอบ: %s แถว (จะถูกย้อนกลับ)\n', n);

  -- ย้อนกลับทุกอย่าง และส่งรายงานออกทางข้อความ error
  raise exception E'REPORT\n%PASS=% FAIL=%', v_rep,
    (length(v_rep) - length(replace(v_rep, E'PASS |', ''))) / length('PASS |'),
    (length(v_rep) - length(replace(v_rep, E'FAIL |', ''))) / length('FAIL |');
end
$t$;
