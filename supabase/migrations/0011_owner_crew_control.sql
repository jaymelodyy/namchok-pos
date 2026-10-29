-- =====================================================================
-- 0011 — เจ้าของร้านกำหนด "จำนวนช่างที่ต้องใช้" เองได้ต่อใบงาน + UI เลือกช่างหลายคนครั้งเดียวจบ
--
-- อาการที่เจ้าของร้านแจ้ง: "เพิ่มช่างแต่ละงานได้แค่คนเดียว ทั้งที่แก้แล้ว"
--
-- สาเหตุ (หลักฐานในโค้ด — migration 0010 แก้ถูกชั้น แต่ยังไม่ครบ):
--   1) 0010 เพิ่ม RPC set_job_crew/add_job_crew และคอลัมน์ job_orders.crew_assigned ให้ "ตั้งทีมเกิน 1 คนได้"
--      แต่ปุ่มในแอป (components/job/crew.tsx → AssignSheet) ยังเรียก assign_technician ทีละคน
--      ไม่มีหน้าจอไหนเรียก set_job_crew/add_job_crew เลย (grep ทั้ง repo: เจอแต่ในไฟล์ migration + test)
--   2) ปุ่ม "มอบหมายช่าง" ถูกแสดงเมื่อ `open > 0` เท่านั้น โดย open = crew_required - crew_active
--      และ _job_crew_required() ของ 0010 = greatest(crew_size จากแคตตาล็อก, 1, crew_assigned)
--      สำหรับงานที่สร้างจากบริการมาตรฐาน crew_size = 1 (ค่า default ใน 0001_schema.sql ทุกบรรทัด)
--      และเจ้าของไม่เคยกดตั้งทีมหลายคนมาก่อน → crew_assigned = 0 → ต้องใช้ 1 คน → รับคนที่ 1 แล้ว
--      ปุ่มหาย + _add_assignment ปฏิเสธ "งานนี้มีช่างรับครบแล้ว (1/1 คน)" — นี่คืออาการที่เจ้าของร้านเจอ
--      (ของเดิมจึง "เหมือนแก้แล้ว" เพราะ RPC อยู่จริง แต่ไม่มีทางเข้าถึงได้จากหน้าจอ)
--   3) ทางออกเก่าคือไปแก้ "จำนวนช่างมาตรฐาน" ในหน้าแคตตาล็อก ซึ่งกระทบทุกงานในอนาคต
--      และ owner แก้ไม่ได้เพราะ RLS เปิดให้ update catalog_items เฉพาะ admin (ดู 0002_rls.sql) — เจ้าของติดทั้ง 2 ทาง
--
-- การแก้ (ชั้น DB — ไฟล์นี้):
--   * เพิ่ม RPC ตั้ง "จำนวนช่างที่ต้องใช้ต่อใบงาน" โดยตรง: set_job_crew_required(job, n)
--     owner/admin เท่านั้น, ล็อกใบงานด้วย _lock_job เดิม, 1 <= n <= 10 (เท่า check ของแคตตาล็อก),
--     ห้ามลดต่ำกว่าจำนวนช่างที่ยังรับอยู่จริง (กันข้อมูลขัดแย้ง + กันการลบคนโดยไม่ตั้งใจ — ถ้าจะลดให้เอาคนออกก่อน)
--     เมื่อขยายเพดานแล้ว ช่างคนอื่นเข้ามา "รับงาน" เติมช่องว่างได้ทันทีตามกติกาเดิมของ _add_assignment
--   * เพิ่ม required_crew int เป็นคอลัมน์ "เป้าหมาย" ต่อใบงาน (แทน crew_assigned ที่ 0010 ใช้เป็น proxy
--     แบบ raise-only ซึ่งทำให้เจ้าของ "ลด" จำนวนช่างไม่ได้เลย — ใส่ผิดก็ถอยไม่ได้)
--     - backfill ครั้งเดียวจากค่าที่ 0010 เคยยกไว้ (crew_assigned) → พฤติกรรมงานเดิมไม่เปลี่ยน
--     - ข้อมูลใหม่ทั้งหมด required_crew = 0 = ใช้กติกาเดิม (max crew_size ของแคตตาล็อก, อย่างน้อย 1)
--   * เขียน _job_crew_required() ใหม่ = greatest(ค่าเดิม, coalesce(required_crew, 0))
--     (ยังรองรับ crew_assigned ของ 0010 เพื่อความเข้ากันได้กับแถวที่ถูกเขียนโดย RPC เวอร์ชันก่อน)
--   * job_crew_info คืน required_crew เพิ่ม → หน้าจอแสดง "ตั้งไว้กี่คน" และแก้ไขได้ตรงจุด
--   * สิทธิ์ execute ตามรูปแบบเดิม (revoke public/anon, grant authenticated) — กติกาภายในไม่เปลี่ยน:
--     ห้ามเกินจำนวน / รับครบแล้วคนอื่นมองไม่เห็น / งานเริ่มแล้วต้องมีช่าง >= 1 / ค่าแรงหารเท่าตามคนที่ยังรับอยู่ (D24)
--
-- การแก้ (ชั้น UI — ดู components/job/crew.tsx + lib/api.ts ที่แก้พร้อมกัน):
--   * "ตั้งทีมช่าง" เลือกได้หลายคนในหน้าจอเดียว (checkbox) แล้วส่ง set_job_crew ครั้งเดียว (atomic)
--   * แสดงปุ่ม "มอบหมายช่าง" ตลอดเวลาที่งานยัง active แม้ทีมครบแล้ว (เจ้าของต้องเพิ่มคนได้เอง)
--   * ช่อง "จำนวนช่างที่ต้องใช้" ในแผงทีมช่าง เรียก set_job_crew_required
-- =====================================================================

-- ---------- คอลัมน์เป้าหมาย : เจ้าของกำหนดจำนวนช่างที่ต้องใช้เองต่อใบงาน ----------
alter table job_orders add column if not exists required_crew int not null default 1
  check (required_crew between 1 and 10);

comment on column job_orders.required_crew is
  'จำนวนช่างที่ต้องใช้สำหรับใบงานนี้ตามที่ผู้ดูแลตั้งไว้ (set_job_crew_required / set_job_crew) — เริ่มที่ 1 (= กติกาเดิมของงานส่วนใหญ่) และขยายได้ตามทีมที่สั่ง';

-- backfill ครั้งเดียวจาก proxy ของ 0010 (crew_assigned = เพดานที่เคยยกขึ้นแบบลดกลับไม่ได้) → งานเดิมพฤติกรรมคงเดิม
update job_orders set required_crew = crew_assigned where coalesce(crew_assigned, 0) > 1;

-- ---------- helper ภายใน : จำนวนช่างที่ต้องใช้ (ฉบับ 0011) ----------
create or replace function _job_crew_required(p_job uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(
    coalesce((select max(crew_size)::int from job_items
               where job_id = p_job and item_type in ('service', 'fee') and not is_bundle_header), 1),
    1,
    coalesce((select required_crew from job_orders where id = p_job), 1),
    coalesce((select crew_assigned from job_orders where id = p_job), 0)
  )::int
$$;

-- ---------- RPC ใหม่ : ตั้งจำนวนช่างที่ต้องใช้ต่อใบงาน (owner/admin) ----------
create or replace function set_job_crew_required(p_job_id uuid, p_count int)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; v_act int;
begin
  if p_count is null or p_count < 1 or p_count > 10 then
    raise exception 'จำนวนช่างต้องอยู่ระหว่าง 1 ถึง 10 คน';
  end if;
  perform set_config('app.audit_reason', 'ตั้งจำนวนช่างที่ต้องใช้ของใบงาน', true);
  j := _lock_job(p_job_id, v_branch);
  if j.status not in ('ready', 'in_progress') then
    raise exception 'ตั้งจำนวนช่างได้เฉพาะงานที่ "พร้อมทำ" หรือ "กำลังทำ" (ตอนนี้: %)', j.status;
  end if;
  v_act := _job_crew_active(j.id);
  if p_count < v_act then
    raise exception 'มีช่างรับงานอยู่แล้ว % คน — เอาคนออกก่อนถ้าต้องการลดจำนวน' , v_act;
  end if;
  update job_orders set required_crew = p_count where id = j.id;
end $$;

-- ---------- RPC (0010) — ใช้กติกาเดียวกันกับรายการที่ส่งมา ----------
-- เดิม: ยกเพดานเฉพาะกรณี "รายการยาวกว่าประวัติที่เคยตั้ง" (raise-only) — ทำให้ลดจำนวนไม่ได้
-- ใหม่: ตั้ง required_crew ตามขนาดรายการที่ส่งมาจริง (ไม่ต่ำกว่าคนที่เหลือในทีม เพราะ _add_assignment ตรวจอยู่แล้ว)
create or replace function set_job_crew(p_job_id uuid, p_user_ids uuid[], p_reason text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; v_ids uuid[]; v_new uuid; v_missing int;
begin
  if p_user_ids is null then raise exception 'ต้องระบุรายชื่อช่าง (อย่างน้อย 1 คน หรือ {} เพื่อล้างทั้งทีม)'; end if;
  -- จัดลำดับและตัดซ้ำในรายการขาเข้า (กัน duplicate id ที่ client ส่งมาผิด)
  select coalesce(array_agg(x order by x), '{}') into v_ids from unnest(p_user_ids) as x;

  perform set_config('app.audit_reason', 'มอบหมายช่าง (ตั้งทีม)', true);
  j := _lock_job(p_job_id, v_branch);

  if j.status not in ('ready', 'in_progress') then
    raise exception 'ตั้งทีมช่างได้เฉพาะงานที่ "พร้อมทำ" หรือ "กำลังทำ" (ตอนนี้: %)', j.status;
  end if;

  -- ตรวจว่าทุกคนเป็นช่างที่ใช้งานอยู่ในสาขาเดียวกัน (กติกาเดียวกับ assign_technician เดิม)
  if cardinality(v_ids) > 0 then
    select count(*) into v_missing
      from unnest(v_ids) as want(id)
     where not exists (select 1 from users u
                        where u.id = want.id and u.branch_id = v_branch
                          and u.role = 'technician' and u.is_active);
    if v_missing > 0 then raise exception 'ผู้ใช้ที่เลือกไม่ใช่ช่างที่ใช้งานอยู่'; end if;
  end if;

  -- เอาคนที่ไม่อยู่ในรายการออก (soft release พร้อมเหตุผล — ห้ามลบแถว, รักษาประวัติตามแนวทางเดิม)
  if cardinality(v_ids) = 0 then
    if j.status = 'in_progress' then
      raise exception 'งานที่เริ่มแล้วต้องมีช่างอย่างน้อย 1 คน — ส่งรายชื่อช่างคนใหม่มาแทน';
    end if;
    perform _release_all(j.id, coalesce(nullif(btrim(p_reason), ''), 'ผู้ดูแลปรับทีมช่าง'));
  else
    update job_assignments
       set released_at = now(), released_by = auth.uid(),
           release_reason = coalesce(nullif(btrim(p_reason), ''), 'ผู้ดูแลปรับทีมช่าง')
     where job_id = j.id and released_at is null and not (user_id = any (v_ids));
  end if;

  -- รับคนใหม่เข้าทีม (ข้ามคนที่มีอยู่แล้ว — กันซ้ำด้วย unique index เดิม)
  foreach v_new in array v_ids loop
    if not _is_assigned(j.id, v_new) then
      perform _add_assignment(j, v_new);
    end if;
  end loop;

  -- ตั้ง "จำนวนช่างที่ต้องใช้" ตามทีมที่ผู้ดูแลสั่ง (ทำได้ทั้งเพิ่มและลด — คนที่ถูกปล่อยไปแล้วไม่นับ)
  -- เก็บค่าสูงสุดที่เคยตั้งไว้ใน crew_assigned (คอลัมน์ของ 0010) เพื่อไม่ให้เพดานหดต่ำกว่าประวัติเดิม
  if cardinality(v_ids) > 0 then
    update job_orders
       set required_crew = cardinality(v_ids),
           crew_assigned = greatest(cardinality(v_ids), coalesce(crew_assigned, 0))
     where id = j.id;
  end if;
end $$;

-- ---------- RPC ใหม่ : เพิ่ม/ถอดทีละคนโดยไม่แตะจำนวนที่เหลือ (owner/admin) ----------
-- assign_technician ของ 0007 ยังอยู่สำหรับ "ช่างกดรับงานเอง" แต่เจ้าของต้องใช้ตัวนี้
-- เพราะมันขยาย required_crew ให้ตามจำนวนจริง — ไม่งั้นจะติด "งานนี้มีช่างรับครบแล้ว (1/1 คน)" เหมือนที่เจ้าของร้านเจอ
create or replace function add_technician(p_job_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; v_req int;
begin
  perform set_config('app.audit_reason', 'มอบหมายช่าง (เพิ่มเข้าทีม)', true);
  j := _lock_job(p_job_id, v_branch);
  if not exists (select 1 from users u where u.id = p_user_id and u.branch_id = v_branch
                   and u.role = 'technician' and u.is_active) then
    raise exception 'ผู้ใช้ที่เลือกไม่ใช่ช่างที่ใช้งานอยู่';
  end if;
  if _is_assigned(j.id, p_user_id) then raise exception 'รับงานนี้อยู่แล้ว'; end if;
  perform _add_assignment(j, p_user_id);
  -- ขยายเป้าหมายตามจำนวนคนจริง (ถ้าแคตตาล็อกกำหนดไว้สูงกว่า ก็คงค่าสูงนั้นไว้)
  v_req := _job_crew_active(j.id);
  update job_orders
     set required_crew = greatest(required_crew, v_req),
         crew_assigned = greatest(coalesce(crew_assigned, 0), v_req)
   where id = j.id;
end $$;

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
  -- หด "จำนวนที่ต้องใช้" ตามจริง แต่ไม่เกินเพดานประวัติ (crew_assigned ของ 0010) →
  -- ช่องว่างที่เกิดจากการถอนคนยังให้เจ้าของ/ช่างคนอื่นเติมได้ตามกติกาเดิม และไม่เปิดช่องให้คนนอกชิง slots เกินจำเป็น
  update job_orders
     set required_crew = greatest(1, least(coalesce(crew_assigned, 1), _job_crew_active(j.id)))
   where id = j.id;
end $$;

-- ---------- อ่านค่าเพิ่มสำหรับหน้าจอ ----------
create or replace function job_crew_info(p_jobs uuid[])
returns table (job_id uuid, crew_required int, crew_active int, required_crew int, member_ids uuid[], member_names text[], mine boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select j.id, _job_crew_required(j.id), _job_crew_active(j.id), j.required_crew,
         coalesce(array_agg(a.user_id order by a.accepted_at) filter (where a.id is not null), '{}'),
         coalesce(array_agg(u.full_name order by a.accepted_at) filter (where a.id is not null), '{}'),
         coalesce(bool_or(a.user_id = auth.uid()), false)
    from job_orders j
    left join job_assignments a on a.job_id = j.id and a.released_at is null
    left join users u on u.id = a.user_id
   where j.id = any (p_jobs) and app_can_see_job(j.id)
   group by j.id, j.required_crew
$$;

-- ---------- สิทธิ์ execute ตามรูปแบบเดิม ----------
revoke execute on function set_job_crew_required(uuid, int) from public, anon;
grant execute on function set_job_crew_required(uuid, int) to authenticated;
revoke execute on function set_job_crew(uuid, uuid[], text) from public, anon;
grant execute on function set_job_crew(uuid, uuid[], text) to authenticated;
revoke execute on function add_technician(uuid, uuid) from public, anon;
grant execute on function add_technician(uuid, uuid) to authenticated;
revoke execute on function remove_technician(uuid, uuid, text) from public, anon;
grant execute on function remove_technician(uuid, uuid, text) to authenticated;
