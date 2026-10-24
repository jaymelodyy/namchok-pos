-- =====================================================================
-- 0007 — เฟส 2: ช่างรับงาน (atomic) + งานว่าง/งานตัวเอง + คำขอเบิกอะไหล่
--   * job_assignments : ช่างที่รับงาน (1 ใบงานมีหลายคนได้ตาม crew_size ที่ต้องใช้)
--   * รับงานแบบ atomic : ล็อกแถวใบงาน (select … for update) แล้วนับที่ว่างในธุรกรรมเดียว — คนกดก่อนได้ ไม่เกินจำนวนช่างที่ต้องใช้
--   * ช่างเห็นเฉพาะ : งานที่อยู่ขั้นเช็คสภาพ (ทุกคนช่วยเช็คได้) + งานว่าง (พร้อมทำ/กำลังทำที่ crew ยังไม่เต็ม) + งานที่ตัวเองรับ
--   * requisitions    : คำขอเบิกอะไหล่ ขอเบิก → จัดเตรียมแล้ว → ส่งมอบแล้ว ; ส่งมอบครบ = ใบงานไป "พร้อมทำ" อัตโนมัติ
--   * คลังเห็นเฉพาะคำขอเบิก (เลขใบงาน/ทะเบียน/รายการ) ไม่เห็นลูกค้า ไม่เห็นเงิน
-- =====================================================================

create type requisition_status as enum ('requested', 'prepared', 'delivered', 'void');

-- ---------- ตาราง ----------
create table job_assignments (
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid not null references branches(id),
  job_id         uuid not null references job_orders(id),
  user_id        uuid not null references users(id),
  accepted_at    timestamptz not null default now(),
  released_at    timestamptz,
  released_by    uuid,
  release_reason text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  check (released_at is null or release_reason is not null)
);
-- ช่างคนเดียวรับใบงานเดียวกันซ้อนไม่ได้ (ปล่อยแล้วรับใหม่ได้)
create unique index job_assignments_active_uk on job_assignments(job_id, user_id) where released_at is null;
create index job_assignments_user_idx on job_assignments(user_id) where released_at is null;
create index job_assignments_job_idx on job_assignments(job_id);

create table requisitions (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  job_id        uuid not null references job_orders(id),
  req_no        text not null,
  job_no        text not null,          -- snapshot ให้คลังเห็นโดยไม่ต้องเข้าถึงใบงาน
  plate         text not null,
  vehicle_label text,
  status        requisition_status not null default 'requested',
  note          text,
  requested_at  timestamptz not null default now(),
  requested_by  uuid default auth.uid(),
  prepared_at   timestamptz,
  prepared_by   uuid,
  delivered_at  timestamptz,
  delivered_by  uuid,
  voided_at     timestamptz,
  voided_by     uuid,
  void_reason   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  unique (branch_id, req_no),
  check ((status = 'void') = (void_reason is not null))
);
create index requisitions_job_idx on requisitions(job_id);
create index requisitions_status_idx on requisitions(branch_id, status);

create table requisition_lines (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references branches(id),
  requisition_id  uuid not null references requisitions(id),
  catalog_item_id uuid references catalog_items(id),
  item_code       text not null,
  item_name       text not null,
  qty             numeric(10,2) not null check (qty > 0),
  attributes      jsonb not null default '{}'::jsonb,   -- เช่น ยี่ห้อ/รุ่น/ขนาดแบตเตอรี่
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid()
);
create index requisition_lines_req_idx on requisition_lines(requisition_id);

-- trigger: updated_at / audit / ห้ามลบ ; รายการในคำขอแก้ย้อนหลังไม่ได้
create trigger trg_job_assignments_updated before update on job_assignments for each row execute function set_updated_at();
create trigger trg_job_assignments_audit   after insert or update or delete on job_assignments for each row execute function audit_row();
create trigger trg_job_assignments_nodelete before delete on job_assignments for each row execute function forbid_delete();
create trigger trg_requisitions_updated before update on requisitions for each row execute function set_updated_at();
create trigger trg_requisitions_audit   after insert or update or delete on requisitions for each row execute function audit_row();
create trigger trg_requisitions_nodelete before delete on requisitions for each row execute function forbid_delete();
create trigger trg_requisition_lines_audit after insert or update or delete on requisition_lines for each row execute function audit_row();
create trigger trg_requisition_lines_nodelete before delete on requisition_lines for each row execute function forbid_delete();
create trigger trg_requisition_lines_noupdate before update on requisition_lines for each row execute function forbid_update();

-- ---------- helper ภายใน (security definer — ใช้ใน RLS ได้โดยไม่วนซ้ำ) ----------
-- จำนวนช่างที่ต้องใช้ = crew_size สูงสุดของบรรทัดบริการ/ค่าแรงในใบงาน (อย่างน้อย 1)
create or replace function _job_crew_required(p_job uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(1, coalesce(max(crew_size), 1))::int
    from job_items where job_id = p_job and item_type in ('service', 'fee') and not is_bundle_header
$$;
create or replace function _job_crew_active(p_job uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from job_assignments where job_id = p_job and released_at is null
$$;
create or replace function _is_assigned(p_job uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from job_assignments where job_id = p_job and user_id = p_user and released_at is null)
$$;

-- ช่างเห็นใบงานนี้ได้ไหม (ใช้ทั้งใน policy และ app_can_see_job)
create or replace function app_tech_can_see_job(p_job uuid, p_status job_status) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app_role() = 'technician' and (
    p_status = 'condition_check'
    or (p_status in ('ready', 'in_progress') and _job_crew_active(p_job) < _job_crew_required(p_job))
    or (p_status in ('ready', 'in_progress', 'qc') and _is_assigned(p_job, auth.uid()))
  )
$$;

drop policy job_orders_select on job_orders;
create policy job_orders_select on job_orders for select to authenticated
  using (
    branch_id = app_branch_id()
    and (
      app_role() in ('owner', 'admin')
      or (voided_at is null and app_tech_can_see_job(id, status))
    )
  );

create or replace function app_can_see_job(p_job uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from job_orders j
     where j.id = p_job and j.branch_id = app_branch_id()
       and (app_role() in ('owner', 'admin') or (j.voided_at is null and app_tech_can_see_job(j.id, j.status)))
  )
$$;

-- ---------- RLS ของตารางใหม่ ----------
alter table job_assignments   enable row level security;
alter table requisitions      enable row level security;
alter table requisition_lines enable row level security;
revoke all on job_assignments, requisitions, requisition_lines from anon, authenticated;
grant select on job_assignments, requisitions, requisition_lines to authenticated;

-- การรับงาน: owner/admin/ช่าง เห็นทั้งสาขา (ใช้นับ "ช่างครบหรือยัง" และให้ realtime ส่งเหตุการณ์ถึงช่างคนอื่น) ; คลังไม่เห็น
create policy job_assignments_select on job_assignments for select to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin', 'technician'));
-- คำขอเบิก: owner/admin/คลัง (ช่างไม่เห็น)
create policy requisitions_select on requisitions for select to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin', 'warehouse'));
create policy requisition_lines_select on requisition_lines for select to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin', 'warehouse'));

-- ---------- ช่างรับงาน ----------
create or replace function _add_assignment(j job_orders, p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_req int; v_act int;
begin
  if j.status not in ('ready', 'in_progress') then
    raise exception 'รับงานได้เฉพาะงานที่ "พร้อมทำ" หรือ "กำลังทำ" (ตอนนี้: %)', j.status;
  end if;
  if _is_assigned(j.id, p_user) then raise exception 'รับงานนี้อยู่แล้ว'; end if;
  v_req := _job_crew_required(j.id);
  v_act := _job_crew_active(j.id);
  if v_act >= v_req then
    raise exception 'งานนี้มีช่างรับครบแล้ว (%/% คน)', v_act, v_req;
  end if;
  insert into job_assignments(branch_id, job_id, user_id) values (j.branch_id, j.id, p_user);
end $$;

-- ช่างกด "รับงาน" : j ถูกล็อกด้วย _lock_job (for update) → คนที่สองต้องรอคิว แล้วเห็นว่าเต็ม
create or replace function accept_job(p_job_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['technician']::user_role[]); j job_orders;
begin
  perform set_config('app.audit_reason', 'ช่างรับงาน', true);
  j := _lock_job(p_job_id, v_branch);
  perform _add_assignment(j, auth.uid());
end $$;

-- แอดมิน/เจ้าของ มอบหมายช่าง
create or replace function assign_technician(p_job_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner', 'admin']::user_role[]); j job_orders;
begin
  perform set_config('app.audit_reason', 'มอบหมายช่าง', true);
  j := _lock_job(p_job_id, v_branch);
  if not exists (select 1 from users where id = p_user_id and branch_id = v_branch and role = 'technician' and is_active) then
    raise exception 'ผู้ใช้ที่เลือกไม่ใช่ช่างที่ใช้งานอยู่';
  end if;
  perform _add_assignment(j, p_user_id);
end $$;

-- ช่างปล่อยงานของตัวเอง (ก่อนเริ่มงานเท่านั้น)
create or replace function release_job(p_job_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['technician']::user_role[]); j job_orders;
begin
  perform set_config('app.audit_reason', 'ช่างปล่อยงาน', true);
  j := _lock_job(p_job_id, v_branch);
  if j.status <> 'ready' then raise exception 'ปล่อยงานเองได้เฉพาะงานที่ยังไม่เริ่ม — ถ้างานเริ่มแล้วให้แจ้งแอดมิน'; end if;
  update job_assignments set released_at = now(), released_by = auth.uid(), release_reason = 'ช่างปล่อยงานก่อนเริ่ม'
   where job_id = j.id and user_id = auth.uid() and released_at is null;
  if not found then raise exception 'คุณยังไม่ได้รับงานนี้'; end if;
end $$;

-- แอดมิน/เจ้าของ เอาช่างออกจากงาน (ต้องมีเหตุผล)
create or replace function remove_technician(p_job_id uuid, p_user_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner', 'admin']::user_role[]); j job_orders; v_reason text;
begin
  v_reason := _need_reason(p_reason, 'การเอาช่างออกจากงาน');
  perform set_config('app.audit_reason', v_reason, true);
  j := _lock_job(p_job_id, v_branch);
  if not _is_assigned(j.id, p_user_id) then raise exception 'ช่างคนนี้ไม่ได้รับงานนี้อยู่'; end if;
  if j.status in ('in_progress', 'qc') and _job_crew_active(j.id) <= 1 then
    raise exception 'งานที่เริ่มแล้วต้องมีช่างอย่างน้อย 1 คน — ให้มอบหมายช่างคนใหม่ก่อนแล้วค่อยเอาคนเดิมออก';
  end if;
  update job_assignments set released_at = now(), released_by = auth.uid(), release_reason = v_reason
   where job_id = j.id and user_id = p_user_id and released_at is null;
end $$;

-- ข้อมูลทีมช่างของใบงาน (ทุกบทบาทที่ "เห็นใบงานนั้นได้")
create or replace function job_crew_info(p_jobs uuid[])
returns table (job_id uuid, crew_required int, crew_active int, member_ids uuid[], member_names text[], mine boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select j.id, _job_crew_required(j.id), _job_crew_active(j.id),
         coalesce(array_agg(a.user_id order by a.accepted_at) filter (where a.id is not null), '{}'),
         coalesce(array_agg(u.full_name order by a.accepted_at) filter (where a.id is not null), '{}'),
         coalesce(bool_or(a.user_id = auth.uid()), false)
    from job_orders j
    left join job_assignments a on a.job_id = j.id and a.released_at is null
    left join users u on u.id = a.user_id
   where j.id = any (p_jobs) and app_can_see_job(j.id)
   group by j.id
$$;

-- สถานะช่าง ว่าง/ไม่ว่าง (owner/admin)
create or replace function technician_board()
returns table (user_id uuid, full_name text, state text, jobs jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
begin
  return query
  select u.id, u.full_name,
         case when bool_or(j.status = 'in_progress') then 'busy'
              when bool_or(j.status = 'ready') then 'assigned'
              else 'free' end,
         coalesce(jsonb_agg(jsonb_build_object('job_id', j.id, 'job_no', j.job_no, 'status', j.status, 'plate', v.plate)
                  order by a.accepted_at) filter (where j.id is not null), '[]'::jsonb)
    from users u
    left join job_assignments a on a.user_id = u.id and a.released_at is null
    left join job_orders j on j.id = a.job_id and j.voided_at is null and j.status in ('ready', 'in_progress', 'qc')
    left join vehicles v on v.id = j.vehicle_id
   where u.branch_id = v_branch and u.role = 'technician' and u.is_active
   group by u.id, u.full_name
   order by u.full_name;
end $$;

-- ---------- คำขอเบิกอะไหล่ ----------
-- สร้างคำขอจากบรรทัดอะไหล่ในใบงานตอนลูกค้าอนุมัติใบเสนอราคา (ถ้าเคยส่งมอบบางส่วนแล้ว ขอเฉพาะส่วนที่ขาด)
create or replace function _on_quote_approved(p_job uuid, p_branch uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare j job_orders; v record; v_req uuid; veh vehicles;
begin
  select * into j from job_orders where id = p_job;
  select * into veh from vehicles where id = j.vehicle_id;
  for v in
    select n.catalog_item_id, n.item_code, n.item_name, n.attributes, (n.qty - coalesce(d.qty, 0)) as need
      from (select catalog_item_id, min(item_code) as item_code, min(item_name) as item_name, attributes, sum(qty) as qty
              from job_items
             where job_id = p_job and item_type = 'part' and not is_bundle_header
             group by catalog_item_id, attributes) n
      left join (select l.catalog_item_id, l.attributes, sum(l.qty) as qty
                   from requisition_lines l join requisitions r on r.id = l.requisition_id
                  where r.job_id = p_job and r.status <> 'void'
                  group by l.catalog_item_id, l.attributes) d
        on d.catalog_item_id = n.catalog_item_id and d.attributes = n.attributes
     where (n.qty - coalesce(d.qty, 0)) > 0
     order by n.item_code
  loop
    if v_req is null then
      insert into requisitions(branch_id, job_id, req_no, job_no, plate, vehicle_label)
      values (p_branch, p_job, next_doc_no(p_branch, 'requisition', 'RQ'), j.job_no, veh.plate,
              nullif(btrim(concat_ws(' ', veh.brand, veh.model)), ''))
      returning id into v_req;
    end if;
    insert into requisition_lines(branch_id, requisition_id, catalog_item_id, item_code, item_name, qty, attributes)
    values (p_branch, v_req, v.catalog_item_id, v.item_code, v.item_name, v.need, v.attributes);
  end loop;
end $$;

-- ยกเลิกคำขอที่ยังไม่ส่งมอบ (ภายใน)
create or replace function _void_open_requisitions(p_job uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update requisitions set status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
   where job_id = p_job and status in ('requested', 'prepared');
end $$;

create or replace function _release_all(p_job uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update job_assignments set released_at = now(), released_by = auth.uid(), release_reason = p_reason
   where job_id = p_job and released_at is null;
end $$;

create or replace function _on_job_reverted(p_job uuid, p_from job_status, p_to job_status, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_to <= 'quoting' then
    perform _void_open_requisitions(p_job, 'ย้อนสถานะ: ' || coalesce(p_reason, ''));
  end if;
  if p_to < 'ready' then
    perform _release_all(p_job, 'ย้อนสถานะ: ' || coalesce(p_reason, ''));
  end if;
end $$;
create or replace function _on_job_cancelled(p_job uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform _void_open_requisitions(p_job, 'ยกเลิกใบงาน: ' || coalesce(p_reason, ''));
  perform _release_all(p_job, 'ยกเลิกใบงาน: ' || coalesce(p_reason, ''));
end $$;
create or replace function _on_job_voided(p_job uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform _void_open_requisitions(p_job, 'void ใบงาน: ' || coalesce(p_reason, ''));
  perform _release_all(p_job, 'void ใบงาน: ' || coalesce(p_reason, ''));
end $$;

-- เลื่อนสถานะคำขอ: ขอเบิก → จัดเตรียมแล้ว → ส่งมอบแล้ว (คลัง/แอดมิน/เจ้าของ)
create or replace function advance_requisition(p_req_id uuid) returns requisition_status
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin', 'warehouse']::user_role[]);
  r requisitions%rowtype; j job_orders; v_to requisition_status;
begin
  perform set_config('app.audit_reason', '', true);
  select * into r from requisitions where id = p_req_id and branch_id = v_branch;
  if not found then raise exception 'ไม่พบคำขอเบิก'; end if;
  j := _lock_job(r.job_id, v_branch);
  select * into r from requisitions where id = p_req_id for update;
  case r.status
    when 'requested' then
      v_to := 'prepared';
      update requisitions set status = v_to, prepared_at = now(), prepared_by = auth.uid() where id = r.id;
    when 'prepared' then
      v_to := 'delivered';
      update requisitions set status = v_to, delivered_at = now(), delivered_by = auth.uid() where id = r.id;
      -- ส่งมอบครบทุกคำขอ และใบงานรออะไหล่อยู่ → พร้อมทำ (แจ้งช่างผ่านบอร์ด real-time)
      if j.status = 'requisition'
         and not exists (select 1 from requisitions x where x.job_id = j.id and x.status in ('requested', 'prepared')) then
        update job_orders set status = 'ready' where id = j.id;
        perform _log_status(v_branch, j.id, 'requisition', 'ready', 'คลังส่งมอบอะไหล่ครบ (' || r.req_no || ')');
      end if;
    when 'delivered' then raise exception 'คำขอนี้ส่งมอบแล้ว';
    else raise exception 'คำขอนี้ถูกยกเลิกแล้ว';
  end case;
  return v_to;
end $$;

-- ถอยจาก "จัดเตรียมแล้ว" กลับเป็น "ขอเบิก" (กดผิด)
create or replace function revert_requisition(p_req_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin', 'warehouse']::user_role[]);
  r requisitions%rowtype; v_reason text;
begin
  v_reason := _need_reason(p_reason, 'การถอยสถานะคำขอเบิก');
  perform set_config('app.audit_reason', v_reason, true);
  select * into r from requisitions where id = p_req_id and branch_id = v_branch;
  if not found then raise exception 'ไม่พบคำขอเบิก'; end if;
  perform _lock_job(r.job_id, v_branch);
  select * into r from requisitions where id = p_req_id for update;
  if r.status <> 'prepared' then raise exception 'ถอยได้เฉพาะคำขอที่ "จัดเตรียมแล้ว" (ยังไม่ส่งมอบ)'; end if;
  update requisitions set status = 'requested', prepared_at = null, prepared_by = null where id = r.id;
end $$;

-- ยกเลิกคำขอ (owner/admin) เช่น ซื้ออะไหล่จากที่อื่นแทน ; ส่งมอบแล้วยกเลิกไม่ได้
create or replace function cancel_requisition(p_req_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  r requisitions%rowtype; v_reason text;
begin
  v_reason := _need_reason(p_reason, 'การยกเลิกคำขอเบิก');
  perform set_config('app.audit_reason', v_reason, true);
  select * into r from requisitions where id = p_req_id and branch_id = v_branch;
  if not found then raise exception 'ไม่พบคำขอเบิก'; end if;
  perform _lock_job(r.job_id, v_branch);
  select * into r from requisitions where id = p_req_id for update;
  if r.status not in ('requested', 'prepared') then raise exception 'ยกเลิกได้เฉพาะคำขอที่ยังไม่ส่งมอบ'; end if;
  update requisitions set status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = r.id;
end $$;

-- ---------- state machine: ผูกกับช่างที่รับงาน + คำขอเบิก ----------
create or replace function advance_job(p_job_id uuid) returns job_status
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin', 'technician']::user_role[]);
  v_role user_role := app_role();
  j job_orders; v_to job_status; v_missing text[];
begin
  perform set_config('app.audit_reason', '', true);
  j := _lock_job(p_job_id, v_branch);

  -- ช่างทำได้เฉพาะ: เริ่มงาน และ ส่งตรวจ QC ของงานที่ "ตัวเองรับ"
  if v_role = 'technician' then
    if j.status not in ('ready', 'in_progress') then
      raise exception 'ช่างเปลี่ยนสถานะได้เฉพาะ "เริ่มงาน" และ "ส่งตรวจ QC"';
    end if;
    if not _is_assigned(j.id, auth.uid()) then
      raise exception 'ต้องกด "รับงาน" ก่อน จึงจะเริ่มงาน/ส่งตรวจ QC ได้';
    end if;
  end if;

  case j.status
    when 'booked' then
      v_to := 'opened';
      update job_orders set status = v_to, opened_at = now() where id = j.id;
    when 'opened' then
      v_to := 'condition_check';
      update job_orders set status = v_to where id = j.id;
    when 'condition_check' then
      v_missing := _job_missing_checks(j.id);
      if cardinality(v_missing) > 0 then
        raise exception 'เช็คสภาพรถยังไม่ครบ: %', array_to_string(v_missing, ', ');
      end if;
      v_to := 'quoting';
      update job_orders set status = v_to where id = j.id;
    when 'quoting' then
      raise exception 'ขั้น "เสนอราคา" ต้องกดปุ่ม "ลูกค้าอนุมัติใบเสนอราคา" (approve_quote)';
    when 'requisition' then
      if exists (select 1 from requisitions where job_id = j.id and status in ('requested', 'prepared')) then
        raise exception 'ยังมีคำขอเบิกอะไหล่ที่คลังยังไม่ส่งมอบ — รอคลังส่งมอบ หรือยกเลิกคำขอพร้อมเหตุผล';
      end if;
      v_to := 'ready';   -- ไม่มีอะไหล่ต้องเบิก หรือคำขอส่งมอบ/ยกเลิกครบแล้ว
      update job_orders set status = v_to where id = j.id;
    when 'ready' then
      v_missing := _job_missing_checks(j.id);
      if cardinality(v_missing) > 0 then
        raise exception 'เริ่มงานไม่ได้ — เช็คสภาพรถยังไม่ครบ: %', array_to_string(v_missing, ', ');
      end if;
      if _job_crew_active(j.id) < 1 then
        raise exception 'เริ่มงานไม่ได้ — ยังไม่มีช่างรับงาน';
      end if;
      v_to := 'in_progress';
      update job_orders set status = v_to where id = j.id;
    when 'in_progress' then
      v_to := 'qc';
      update job_orders set status = v_to where id = j.id;
    when 'qc' then
      raise exception 'ขั้น "รอ QC" ต้องบันทึกผล QC (ผ่าน/ไม่ผ่าน)';
    when 'awaiting_payment' then
      raise exception 'ขั้น "รอชำระ" ต้องกด "ปิดงาน" (close_job) เมื่อรับเงินครบ';
    else
      raise exception 'สถานะ % ไปต่อไม่ได้', j.status;
  end case;

  perform _log_status(v_branch, j.id, j.status, v_to, null);
  return v_to;
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
