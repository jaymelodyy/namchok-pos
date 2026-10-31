-- ค่าแรงรายวัน: แยกจากค่าแรงตามใบงานเดิม และเก็บอัตรางาน ณ วันที่บันทึก

create table wage_attendance (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references branches(id),
  user_id         uuid not null references users(id),
  work_date       date not null,
  clocked_in_at   timestamptz not null,
  clocked_out_at  timestamptz,
  paid_at         timestamptz,
  paid_by         uuid references users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  unique (branch_id, user_id, work_date),
  check (clocked_out_at is null or clocked_out_at >= clocked_in_at)
);
create index wage_attendance_date_idx on wage_attendance(branch_id, work_date desc);
create trigger trg_wage_attendance_nodelete before delete on wage_attendance
  for each row execute function forbid_delete();
create trigger trg_wage_attendance_updated before update on wage_attendance
  for each row execute function set_updated_at();
create trigger trg_wage_attendance_audit after insert or update on wage_attendance
  for each row execute function audit_row();
alter table wage_attendance enable row level security;
revoke all on wage_attendance from anon, authenticated;
grant select on wage_attendance to authenticated;
create policy wage_attendance_select on wage_attendance for select to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin', 'technician'));

create table wage_work_types (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches(id),
  code         text not null,
  name         text not null,
  unit_label   text not null,
  current_rate numeric(12,2) not null check (current_rate >= 0),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  unique (branch_id, code)
);
create trigger trg_wage_work_types_updated before update on wage_work_types
  for each row execute function set_updated_at();
create trigger trg_wage_work_types_audit after insert or update on wage_work_types
  for each row execute function audit_row();
create trigger trg_wage_work_types_nodelete before delete on wage_work_types
  for each row execute function forbid_delete();
alter table wage_work_types enable row level security;
revoke all on wage_work_types from anon, authenticated;
grant select, update (current_rate, is_active) on wage_work_types to authenticated;
create policy wage_work_types_select on wage_work_types for select to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin'));
create policy wage_work_types_update on wage_work_types for update to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin'))
  with check (branch_id = app_branch_id() and app_role() in ('owner', 'admin'));

create table wage_work_entries (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  user_id       uuid not null references users(id),
  work_date     date not null,
  work_type_id  uuid not null references wage_work_types(id),
  work_name     text not null,
  unit_label    text not null,
  quantity      integer not null check (quantity > 0),
  unit_rate     numeric(12,2) not null check (unit_rate >= 0),
  amount        numeric(12,2) generated always as (round(quantity * unit_rate, 2)) stored,
  voided_at     timestamptz,
  voided_by     uuid references users(id),
  void_reason   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  check (voided_at is null or nullif(btrim(void_reason), '') is not null)
);
create index wage_work_entries_user_date_idx on wage_work_entries(branch_id, user_id, work_date desc);
create trigger trg_wage_work_entries_updated before update on wage_work_entries
  for each row execute function set_updated_at();
create trigger trg_wage_work_entries_audit after insert or update on wage_work_entries
  for each row execute function audit_row();
create trigger trg_wage_work_entries_nodelete before delete on wage_work_entries
  for each row execute function forbid_delete();
alter table wage_work_entries enable row level security;
revoke all on wage_work_entries from anon, authenticated;
grant select on wage_work_entries to authenticated;
create policy wage_work_entries_select on wage_work_entries for select to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin', 'technician'));

-- แยกข้อมูลบัญชีธนาคารออกจาก users เพื่อไม่ให้ช่างอ่านได้ผ่าน profile query
create table technician_bank_details (
  user_id        uuid primary key references users(id),
  branch_id      uuid not null references branches(id),
  bank_name      text not null check (length(btrim(bank_name)) between 1 and 100),
  account_number text not null check (length(btrim(account_number)) between 1 and 50),
  updated_at     timestamptz not null default now()
);
create trigger trg_technician_bank_details_updated before update on technician_bank_details
  for each row execute function set_updated_at();
create trigger trg_technician_bank_details_nodelete before delete on technician_bank_details
  for each row execute function forbid_delete();
alter table technician_bank_details enable row level security;
revoke all on technician_bank_details from anon, authenticated;
grant select, insert, update on technician_bank_details to authenticated;
create policy technician_bank_details_manager on technician_bank_details for all to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin'))
  with check (branch_id = app_branch_id() and app_role() in ('owner', 'admin'));

-- รายงานนี้เป็นขอบเขตเดียวที่เปิดชื่อและยอดประจำวันของทั้งทีมให้พนักงาน
create or replace function wage_daily_report(p_from date, p_to date)
returns table (
  work_date date, user_id uuid, full_name text, clocked_in_at timestamptz, clocked_out_at timestamptz,
  late_minutes integer, base_wage numeric, late_deduction numeric, overtime_minutes numeric,
  overtime_amount numeric, work_total numeric, total numeric, paid_at timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_branch uuid;
begin
  v_branch := app_assert(array['owner','admin','technician']::user_role[]);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'ช่วงวันที่ไม่ถูกต้อง';
  end if;

  return query
    select a.work_date, a.user_id, u.full_name, a.clocked_in_at, a.clocked_out_at,
      timing.late_minutes, 400::numeric,
      least(400::numeric, timing.late_minutes * 2::numeric),
      timing.overtime_minutes,
      round(timing.overtime_minutes * 100 / 60, 2),
      coalesce(work.work_total, 0::numeric),
      greatest(0::numeric, 400 - least(400::numeric, timing.late_minutes * 2::numeric))
        + round(timing.overtime_minutes * 100 / 60, 2) + coalesce(work.work_total, 0::numeric),
      a.paid_at
    from wage_attendance a
    join users u on u.id = a.user_id and u.branch_id = a.branch_id
    cross join lateral (
      select
        case
          when (a.clocked_in_at at time zone 'Asia/Bangkok')::time > time '09:00'
          then ceil(extract(epoch from ((a.clocked_in_at at time zone 'Asia/Bangkok')::time - time '09:00')) / 60)::integer
          else 0
        end as late_minutes,
        case
          when a.clocked_out_at is not null
            and a.clocked_out_at > ((a.work_date + time '17:00') at time zone 'Asia/Bangkok')
          then extract(epoch from (a.clocked_out_at - ((a.work_date + time '17:00') at time zone 'Asia/Bangkok'))) / 60
          else 0::numeric
        end as overtime_minutes
    ) timing
    left join lateral (
      select sum(e.amount) as work_total
      from wage_work_entries e
      where e.branch_id = a.branch_id and e.user_id = a.user_id and e.work_date = a.work_date
        and e.voided_at is null
    ) work on true
    where a.branch_id = v_branch and a.work_date between p_from and p_to
    order by a.work_date desc, u.full_name;
end $$;

create function wage_clock_in() returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid; v_date date := (now() at time zone 'Asia/Bangkok')::date; v_id uuid;
begin
  v_branch := app_assert(array['technician']::user_role[]);
  perform set_config('app.audit_reason', 'ช่างลงเวลาเข้างาน', true);
  begin
    insert into wage_attendance(branch_id, user_id, work_date, clocked_in_at)
    values (v_branch, auth.uid(), v_date, now())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'ลงเวลาเข้าแล้ววันนี้';
  end;
  return v_id;
end $$;

create function wage_clock_out() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['technician']::user_role[]); v_date date := (now() at time zone 'Asia/Bangkok')::date;
begin
  perform set_config('app.audit_reason', 'ช่างลงเวลาออกงาน', true);
  update wage_attendance set clocked_out_at = now()
   where branch_id = v_branch and user_id = auth.uid() and work_date = v_date and clocked_out_at is null;
  if not found then
    if exists (select 1 from wage_attendance
                where branch_id = v_branch and user_id = auth.uid() and work_date = v_date) then
      raise exception 'ลงเวลาออกแล้ววันนี้';
    end if;
    raise exception 'ยังไม่ได้ลงเวลาเข้างานวันนี้';
  end if;
end $$;

create function wage_correct_attendance(
  p_user_id uuid, p_work_date date, p_clocked_in_at timestamptz, p_clocked_out_at timestamptz, p_reason text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner','admin']::user_role[]); v_reason text;
begin
  v_reason := _need_reason(p_reason, 'การแก้เวลาเข้างาน');
  if p_work_date is null or p_work_date > (now() at time zone 'Asia/Bangkok')::date
     or p_clocked_in_at is null or p_clocked_in_at > now()
     or (p_clocked_in_at at time zone 'Asia/Bangkok')::date <> p_work_date
     or (p_clocked_out_at is not null and (
       p_clocked_out_at < p_clocked_in_at or p_clocked_out_at > now()
       or (p_clocked_out_at at time zone 'Asia/Bangkok')::date <> p_work_date
     )) then
    raise exception 'เวลาไม่ถูกต้อง';
  end if;
  if not exists (select 1 from users where id = p_user_id and branch_id = v_branch and role = 'technician') then
    raise exception 'ไม่พบพนักงานช่างในสาขา' using errcode = '42501';
  end if;
  perform set_config('app.audit_reason', v_reason, true);
  insert into wage_attendance(branch_id, user_id, work_date, clocked_in_at, clocked_out_at)
  values (v_branch, p_user_id, p_work_date, p_clocked_in_at, p_clocked_out_at)
  on conflict (branch_id, user_id, work_date) do update
    set clocked_in_at = excluded.clocked_in_at,
        clocked_out_at = excluded.clocked_out_at,
        paid_at = case
          when wage_attendance.clocked_in_at is distinct from excluded.clocked_in_at
            or wage_attendance.clocked_out_at is distinct from excluded.clocked_out_at then null
          else wage_attendance.paid_at
        end,
        paid_by = case
          when wage_attendance.clocked_in_at is distinct from excluded.clocked_in_at
            or wage_attendance.clocked_out_at is distinct from excluded.clocked_out_at then null
          else wage_attendance.paid_by
        end;
end $$;

create function wage_record_work(p_user_id uuid, p_work_date date, p_work_type_id uuid, p_quantity integer)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner','admin']::user_role[]); v_type wage_work_types; v_id uuid;
begin
  if p_work_date is null or p_work_date > (now() at time zone 'Asia/Bangkok')::date
     or p_quantity is null or p_quantity < 1 or p_quantity > 10000 then
    raise exception 'จำนวนไม่ถูกต้อง';
  end if;
  if not exists (select 1 from users where id = p_user_id and branch_id = v_branch and role = 'technician') then
    raise exception 'ไม่พบพนักงานช่างในสาขา';
  end if;
  if not exists (select 1 from wage_attendance where branch_id = v_branch and user_id = p_user_id and work_date = p_work_date) then
    raise exception 'ต้องมีบันทึกเวลาเข้างานก่อนเพิ่มรายการค่าแรง';
  end if;
  select * into v_type from wage_work_types
   where id = p_work_type_id and branch_id = v_branch and is_active;
  if not found then raise exception 'ไม่พบประเภทงานที่เปิดใช้งาน'; end if;

  perform set_config('app.audit_reason', 'บันทึกผลงานช่าง', true);
  insert into wage_work_entries(branch_id, user_id, work_date, work_type_id, work_name, unit_label, quantity, unit_rate)
  values (v_branch, p_user_id, p_work_date, v_type.id, v_type.name, v_type.unit_label, p_quantity, v_type.current_rate)
  returning id into v_id;
  return v_id;
end $$;

create function wage_void_work(p_entry_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner','admin']::user_role[]); v_reason text;
begin
  v_reason := _need_reason(p_reason, 'การยกเลิกรายการค่าแรง');
  perform set_config('app.audit_reason', v_reason, true);
  update wage_work_entries set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
   where id = p_entry_id and branch_id = v_branch and voided_at is null;
  if not found then raise exception 'ไม่พบรายการค่าแรงที่ยังใช้งาน'; end if;
end $$;

create function wage_mark_paid(p_user_id uuid, p_work_date date) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner','admin']::user_role[]); v_count integer;
begin
  perform set_config('app.audit_reason', 'ทำเครื่องหมายจ่ายค่าแรงรายวัน', true);
  update wage_attendance set paid_at = now(), paid_by = auth.uid()
   where branch_id = v_branch and user_id = p_user_id and work_date = p_work_date and paid_at is null;
  get diagnostics v_count = row_count;
  return v_count = 1;
end $$;

create function wage_unmark_paid(p_user_id uuid, p_work_date date, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner','admin']::user_role[]); v_reason text;
begin
  v_reason := _need_reason(p_reason, 'การยกเลิกสถานะจ่ายค่าแรง');
  perform set_config('app.audit_reason', v_reason, true);
  update wage_attendance set paid_at = null, paid_by = null
   where branch_id = v_branch and user_id = p_user_id and work_date = p_work_date and paid_at is not null;
end $$;

create function deactivate_technician(p_user_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner','admin']::user_role[]);
begin
  perform set_config('app.audit_reason', 'ปิดบัญชีพนักงานโดยผู้จัดการ', true);
  update users set is_active = false
   where id = p_user_id and branch_id = v_branch and role = 'technician' and is_active;
  if not found then raise exception 'ไม่พบช่างที่เปิดใช้งานในสาขานี้'; end if;
end $$;

revoke execute on function wage_daily_report(date,date), wage_clock_in(), wage_clock_out(),
  wage_correct_attendance(uuid,date,timestamptz,timestamptz,text), wage_record_work(uuid,date,uuid,integer),
  wage_void_work(uuid,text), wage_mark_paid(uuid,date), wage_unmark_paid(uuid,date,text),
  deactivate_technician(uuid) from public, anon;
grant execute on function wage_daily_report(date,date), wage_clock_in(), wage_clock_out(),
  wage_correct_attendance(uuid,date,timestamptz,timestamptz,text), wage_record_work(uuid,date,uuid,integer),
  wage_void_work(uuid,text), wage_mark_paid(uuid,date), wage_unmark_paid(uuid,date,text),
  deactivate_technician(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table wage_attendance, wage_work_entries;
  end if;
end $$;
