-- =====================================================================
-- 0008 — เฟส 2: QC จริง (ผ่าน/ไม่ผ่านพร้อมหลักฐาน) + ค่าแรงช่าง
--   * qc_checks : บันทึกผล QC ทุกครั้ง (แก้/ลบไม่ได้) — ไม่ผ่าน = ส่งกลับ "กำลังทำ" (แก้งาน) พร้อมเหตุผล
--   * ค่าแรงช่าง = labor_rate × จำนวน ÷ จำนวนช่างที่ทำจริง (ช่างที่รับงานอยู่ ณ วันปิดงาน) — คิดตอนปิดงาน
--     ช่างเห็นเฉพาะของตัวเอง ; owner เห็นทั้งหมดและทำเครื่องหมาย "จ่ายแล้ว" รายงวดได้
--     void ใบงาน → ค่าแรงของใบงานนั้นถูก void ตาม
-- =====================================================================

-- ---------- QC ----------
create table qc_checks (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branches(id),
  job_id      uuid not null references job_orders(id),
  result      text not null check (result in ('pass', 'fail')),
  answers     jsonb not null default '{}'::jsonb,
  note        text,
  photo_paths text[] not null default '{}',
  checked_by  uuid default auth.uid(),
  checked_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  check (result = 'pass' or length(btrim(coalesce(note, ''))) > 0)
);
create index qc_checks_job_idx on qc_checks(job_id, checked_at);
create trigger trg_qc_checks_audit after insert or update or delete on qc_checks for each row execute function audit_row();
create trigger trg_qc_checks_nodelete before delete on qc_checks for each row execute function forbid_delete();
create trigger trg_qc_checks_noupdate before update on qc_checks for each row execute function forbid_update();

alter table qc_checks enable row level security;
revoke all on qc_checks from anon, authenticated;
grant select on qc_checks to authenticated;
create policy qc_checks_select on qc_checks for select to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin'));

-- รายการตรวจ QC มาตรฐาน (แหล่งเดียว: ทั้งฐานข้อมูลและหน้าจอใช้ชุดนี้)
create or replace function qc_checklist() returns jsonb
language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('key', 'work_done',   'label', 'งานเสร็จครบตามรายการในใบเสนอราคา'),
    jsonb_build_object('key', 'function_ok', 'label', 'ทดสอบการทำงานแล้ว (เช่น แอร์เย็น ไม่รั่ว ไฟฟ้าปกติ)'),
    jsonb_build_object('key', 'clean',       'label', 'ทำความสะอาดและเก็บเครื่องมือ/ชิ้นส่วนเก่าเรียบร้อย'),
    jsonb_build_object('key', 'no_new_damage', 'label', 'ไม่พบความเสียหายใหม่เมื่อเทียบกับตอนเช็คสภาพก่อนทำ')
  )
$$;

create or replace function _qc_photos_ok(p_branch uuid, p_job uuid, p_paths text[]) returns void
language plpgsql immutable as $$
declare p text;
begin
  foreach p in array coalesce(p_paths, '{}') loop
    if p not like p_branch::text || '/' || p_job::text || '/%' then
      raise exception 'ตำแหน่งไฟล์รูป QC ไม่ถูกต้อง';
    end if;
  end loop;
end $$;

drop function if exists pass_qc(uuid, text);

create or replace function qc_pass(p_job_id uuid, p_answers jsonb, p_note text default null, p_photos text[] default '{}')
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; it jsonb;
begin
  perform set_config('app.audit_reason', 'ผ่าน QC', true);
  j := _lock_job(p_job_id, v_branch);
  if j.status <> 'qc' then raise exception 'บันทึกผล QC ได้เฉพาะสถานะ "รอ QC"'; end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then raise exception 'รูปแบบผลตรวจ QC ไม่ถูกต้อง'; end if;
  for it in select * from jsonb_array_elements(qc_checklist()) loop
    if coalesce((p_answers ->> (it ->> 'key'))::boolean, false) is not true then
      raise exception 'ยังไม่ผ่านข้อ "%" — ติ๊กให้ครบทุกข้อก่อนผ่าน QC (ถ้ามีข้อที่ไม่ผ่านให้เลือก "ไม่ผ่าน QC")', it ->> 'label';
    end if;
  end loop;
  perform _qc_photos_ok(v_branch, j.id, p_photos);

  insert into qc_checks(branch_id, job_id, result, answers, note, photo_paths)
  values (v_branch, j.id, 'pass', p_answers, nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_photos, '{}'));
  update job_orders set status = 'awaiting_payment', qc_passed_at = now(), qc_passed_by = auth.uid(),
         qc_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = j.id;
  perform _log_status(v_branch, j.id, j.status, 'awaiting_payment', 'ผ่าน QC');
end $$;

create or replace function qc_fail(p_job_id uuid, p_note text, p_photos text[] default '{}', p_answers jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; v_note text;
begin
  v_note := _need_reason(p_note, 'การไม่ผ่าน QC (ระบุสิ่งที่ต้องแก้)');
  perform set_config('app.audit_reason', v_note, true);
  j := _lock_job(p_job_id, v_branch);
  if j.status <> 'qc' then raise exception 'บันทึกผล QC ได้เฉพาะสถานะ "รอ QC"'; end if;
  perform _qc_photos_ok(v_branch, j.id, p_photos);

  insert into qc_checks(branch_id, job_id, result, answers, note, photo_paths)
  values (v_branch, j.id, 'fail', coalesce(p_answers, '{}'::jsonb), v_note, coalesce(p_photos, '{}'));
  update job_orders set status = 'in_progress', qc_passed_at = null, qc_passed_by = null, qc_note = null where id = j.id;
  perform _log_status(v_branch, j.id, j.status, 'in_progress', 'QC ไม่ผ่าน: ' || v_note);
end $$;

-- ---------- ค่าแรงช่าง ----------
create table labor_pay_entries (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  job_id        uuid not null references job_orders(id),
  job_item_id   uuid not null references job_items(id),
  user_id       uuid not null references users(id),
  job_no        text not null,
  plate         text not null,
  item_name     text not null,
  variant_label text,
  qty           numeric(10,2) not null,
  labor_rate    numeric(12,2) not null,      -- อัตราต่อหน่วย ณ วันที่ใส่ในใบงาน
  crew_actual   int not null check (crew_actual >= 1),
  amount        numeric(12,2) not null check (amount > 0),   -- ส่วนของช่างคนนี้
  earned_on     date not null,               -- วันที่ปิดงาน (เวลาไทย)
  paid_at       timestamptz,
  paid_by       uuid,
  voided_at     timestamptz,
  voided_by     uuid,
  void_reason   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  check (voided_at is null or void_reason is not null)
);
create index labor_pay_user_idx on labor_pay_entries(user_id, earned_on);
create index labor_pay_job_idx on labor_pay_entries(job_id);
create trigger trg_labor_pay_entries_updated before update on labor_pay_entries for each row execute function set_updated_at();
create trigger trg_labor_pay_entries_audit after insert or update or delete on labor_pay_entries for each row execute function audit_row();
create trigger trg_labor_pay_entries_nodelete before delete on labor_pay_entries for each row execute function forbid_delete();

alter table labor_pay_entries enable row level security;
revoke all on labor_pay_entries from anon, authenticated;
grant select on labor_pay_entries to authenticated;
-- owner เห็นทั้งสาขา ; ช่างเห็นเฉพาะของตัวเอง ; admin/คลัง ไม่เห็น
create policy labor_pay_select on labor_pay_entries for select to authenticated
  using (branch_id = app_branch_id()
         and (app_role() = 'owner' or (app_role() = 'technician' and user_id = auth.uid())));

-- คิดค่าแรงตอนปิดงาน : ต่อบรรทัดบริการ/ค่าแรง pool = labor_rate × qty แบ่งเท่ากันตามช่างที่ทำจริง
-- (เศษสตางค์ให้ช่างที่รับงานก่อน เพื่อให้ผลรวมเท่ากับ pool พอดี)
create or replace function _on_job_closed(p_job uuid, p_branch uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  j job_orders; veh vehicles; l record; crew uuid[]; n int; v_pool numeric; v_base numeric; v_rem int; i int; v_amt numeric;
  v_day date := (now() at time zone 'Asia/Bangkok')::date;
begin
  select * into j from job_orders where id = p_job;
  select * into veh from vehicles where id = j.vehicle_id;
  select coalesce(array_agg(user_id order by accepted_at, id), '{}') into crew
    from job_assignments where job_id = p_job and released_at is null;
  n := coalesce(cardinality(crew), 0);
  if n = 0 then return; end if;

  for l in
    select * from job_items
     where job_id = p_job and not is_bundle_header and item_type in ('service', 'fee') and labor_rate > 0
     order by sort_order
  loop
    v_pool := round(l.labor_rate * l.qty, 2);
    v_base := trunc(v_pool / n, 2);
    v_rem  := round((v_pool - v_base * n) * 100)::int;
    for i in 1..n loop
      v_amt := v_base + case when i <= v_rem then 0.01 else 0 end;
      if v_amt > 0 then
        insert into labor_pay_entries(branch_id, job_id, job_item_id, user_id, job_no, plate, item_name, variant_label,
                                      qty, labor_rate, crew_actual, amount, earned_on)
        values (p_branch, p_job, l.id, crew[i], j.job_no, veh.plate, l.item_name, l.variant_label,
                l.qty, l.labor_rate, n, v_amt, v_day);
      end if;
    end loop;
  end loop;
end $$;

create or replace function _on_job_voided(p_job uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform _void_open_requisitions(p_job, 'void ใบงาน: ' || coalesce(p_reason, ''));
  perform _release_all(p_job, 'void ใบงาน: ' || coalesce(p_reason, ''));
  update labor_pay_entries set voided_at = now(), voided_by = auth.uid(), void_reason = 'void ใบงาน: ' || coalesce(p_reason, '')
   where job_id = p_job and voided_at is null;
end $$;

-- owner ทำเครื่องหมาย "จ่ายแล้ว" ค่าแรงของช่างหนึ่งคนในช่วงวันที่ (คืนจำนวนรายการที่อัปเดต)
create or replace function mark_labor_paid(p_user_id uuid, p_from date, p_to date, p_note text default null) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner']::user_role[]); v_n int;
begin
  perform set_config('app.audit_reason', coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'จ่ายค่าแรงช่าง'), true);
  if p_from is null or p_to is null or p_to < p_from then raise exception 'ช่วงวันที่ไม่ถูกต้อง'; end if;
  update labor_pay_entries set paid_at = now(), paid_by = auth.uid()
   where branch_id = v_branch and user_id = p_user_id and paid_at is null and voided_at is null
     and earned_on between p_from and p_to;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function unmark_labor_paid(p_user_id uuid, p_from date, p_to date, p_reason text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner']::user_role[]); v_n int; v_reason text;
begin
  v_reason := _need_reason(p_reason, 'การยกเลิกสถานะจ่ายแล้ว');
  perform set_config('app.audit_reason', v_reason, true);
  if p_from is null or p_to is null or p_to < p_from then raise exception 'ช่วงวันที่ไม่ถูกต้อง'; end if;
  update labor_pay_entries set paid_at = null, paid_by = null
   where branch_id = v_branch and user_id = p_user_id and paid_at is not null and voided_at is null
     and earned_on between p_from and p_to;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------- สิทธิ์ execute ----------
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like '\_%' or p.proname in (
         'next_doc_no', 'audit_row', 'forbid_delete', 'forbid_update', 'set_updated_at',
         'branches_create_settings', 'item_prices_fill', 'catalog_categories_validate',
         'catalog_items_validate', 'bundle_components_validate', 'job_orders_stamp_status'))
  loop
    execute format('revoke execute on function %s from authenticated', r.sig);
  end loop;
end $$;
