-- =====================================================================
-- 0002_rls.sql — Row Level Security + สิทธิ์ตามบทบาท (บังคับที่ DB ไม่ใช่แค่ซ่อนปุ่ม)
-- หลักการ: ตารางธุรกรรม (job_orders, job_items, payments, receipts, ...) เขียนได้ผ่าน RPC เท่านั้น
-- =====================================================================

-- ---------- helper (security definer เพื่อเลี่ยง recursion ของ RLS) ----------
create or replace function app_branch_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select branch_id from users where id = auth.uid() and is_active
$$;

create or replace function app_role() returns user_role
language sql stable security definer set search_path = public, pg_temp as $$
  select role from users where id = auth.uid() and is_active
$$;

-- ใช้ใน RPC: ตรวจบทบาท คืน branch_id ของผู้เรียก
create or replace function app_assert(p_roles user_role[]) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_role user_role; v_branch uuid;
begin
  select role, branch_id into v_role, v_branch from users where id = auth.uid() and is_active;
  if v_role is null then
    raise exception 'ไม่มีสิทธิ์ใช้งาน (บัญชียังไม่ได้ผูกกับผู้ใช้ในระบบ)' using errcode = '42501';
  end if;
  if not (v_role = any (p_roles)) then
    raise exception 'บทบาท % ไม่มีสิทธิ์ทำรายการนี้', v_role using errcode = '42501';
  end if;
  return v_branch;
end $$;

-- ---------- เปิด RLS ----------
alter table branches                  enable row level security;
alter table branch_settings           enable row level security;
alter table users                     enable row level security;
alter table customers                 enable row level security;
alter table vehicles                  enable row level security;
alter table catalog_categories        enable row level security;
alter table condition_templates       enable row level security;
alter table catalog_items             enable row level security;
alter table item_prices               enable row level security;
alter table catalog_bundle_components enable row level security;
alter table doc_counters              enable row level security;
alter table job_orders                enable row level security;
alter table job_status_log            enable row level security;
alter table job_items                 enable row level security;
alter table condition_checks          enable row level security;
alter table condition_check_photos    enable row level security;
alter table payments                  enable row level security;
alter table receipts                  enable row level security;
alter table warranties                enable row level security;
alter table audit_logs                enable row level security;

-- ---------- สิทธิ์ระดับตาราง: ถอนทั้งหมดก่อน แล้วให้เท่าที่จำเป็น ----------
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to authenticated;

grant select on branches, branch_settings, users, customers, vehicles, catalog_categories,
  condition_templates, catalog_items, item_prices, catalog_bundle_components,
  job_orders, job_status_log, job_items, condition_checks, condition_check_photos,
  payments, receipts, warranties, audit_logs to authenticated;

-- เขียนตรงได้เฉพาะข้อมูลหลัก (ผ่าน RLS: owner / admin)
grant insert, update on customers, vehicles to authenticated;
grant insert, update on catalog_categories, condition_templates, catalog_items, item_prices,
  catalog_bundle_components to authenticated;
grant update on branch_settings, branches, users to authenticated;
-- job_orders / job_items / payments / receipts / warranties / condition_* / audit_logs / doc_counters
--   => ไม่มี insert/update/delete สำหรับ authenticated : ต้องผ่าน RPC (security definer) เท่านั้น

-- ---------- policies ----------
-- branches / settings
create policy branches_select on branches for select to authenticated using (id = app_branch_id());
create policy branches_update on branches for update to authenticated
  using (id = app_branch_id() and app_role() = 'owner') with check (id = app_branch_id());

create policy settings_select on branch_settings for select to authenticated using (branch_id = app_branch_id());
create policy settings_update on branch_settings for update to authenticated
  using (branch_id = app_branch_id() and app_role() = 'owner') with check (branch_id = app_branch_id());

-- users
create policy users_select on users for select to authenticated
  using (id = auth.uid() or (branch_id = app_branch_id() and app_role() in ('owner', 'admin')));
create policy users_update on users for update to authenticated
  using (branch_id = app_branch_id() and app_role() = 'owner')
  with check (branch_id = app_branch_id());

-- customers / vehicles
create policy customers_select on customers for select to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin', 'technician'));
create policy customers_insert on customers for insert to authenticated
  with check (branch_id = app_branch_id() and app_role() in ('owner', 'admin'));
create policy customers_update on customers for update to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin'))
  with check (branch_id = app_branch_id());

create policy vehicles_select on vehicles for select to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin', 'technician'));
create policy vehicles_insert on vehicles for insert to authenticated
  with check (branch_id = app_branch_id() and app_role() in ('owner', 'admin'));
create policy vehicles_update on vehicles for update to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin'))
  with check (branch_id = app_branch_id());

-- catalog: ทุกบทบาทในสาขาอ่านได้ / owner เท่านั้นที่เพิ่ม-แก้
do $$
declare t text;
begin
  foreach t in array array['catalog_categories','condition_templates','catalog_items','item_prices','catalog_bundle_components'] loop
    execute format('create policy %1$s_select on %1$I for select to authenticated using (branch_id = app_branch_id())', t);
    execute format('create policy %1$s_insert on %1$I for insert to authenticated with check (branch_id = app_branch_id() and app_role() = ''owner'')', t);
    execute format('create policy %1$s_update on %1$I for update to authenticated using (branch_id = app_branch_id() and app_role() = ''owner'') with check (branch_id = app_branch_id())', t);
  end loop;
end $$;

-- job_orders: owner/admin เห็นทั้งสาขา ; ช่างเห็นเฉพาะงานที่อยู่ในขั้นเช็คสภาพ→QC (เฟส 2 จะจำกัดเป็น "งานว่าง/งานตัวเอง")
create policy job_orders_select on job_orders for select to authenticated
  using (
    branch_id = app_branch_id()
    and (
      app_role() in ('owner', 'admin')
      or (app_role() = 'technician' and voided_at is null
          and status in ('condition_check', 'ready', 'in_progress', 'qc'))
    )
  );

-- ตารางลูกของใบงาน: เห็นได้เท่าที่เห็นใบงานแม่ (RLS ของ job_orders ถูกใช้ซ้ำ)
create policy job_items_select on job_items for select to authenticated
  using (exists (select 1 from job_orders j where j.id = job_items.job_id));
create policy job_status_log_select on job_status_log for select to authenticated
  using (exists (select 1 from job_orders j where j.id = job_status_log.job_id));
create policy condition_checks_select on condition_checks for select to authenticated
  using (exists (select 1 from job_orders j where j.id = condition_checks.job_id));
create policy condition_check_photos_select on condition_check_photos for select to authenticated
  using (exists (select 1 from condition_checks c where c.id = condition_check_photos.check_id));

-- เงิน: owner / admin เท่านั้น
create policy payments_select on payments for select to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin'));
create policy receipts_select on receipts for select to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin'));
create policy warranties_select on warranties for select to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin'));

-- audit: owner อ่านได้อย่างเดียว
create policy audit_logs_select on audit_logs for select to authenticated
  using (branch_id = app_branch_id() and app_role() = 'owner');

-- doc_counters: ไม่มี policy = ไม่มีใครเข้าถึงตรง ๆ (RPC เท่านั้น)

-- ---------- ให้ฟังก์ชันใหม่ปิดไว้ก่อน (เปิดเฉพาะ authenticated ใน 0003) ----------
alter default privileges in schema public revoke execute on functions from public, anon;
