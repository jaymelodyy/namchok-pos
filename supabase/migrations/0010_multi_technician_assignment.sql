-- =====================================================================
-- 0010 — Qwen Engineering: รองรับการมอบหมายช่างหลายคนต่อหนึ่งงาน (TASK A) + เปลี่ยนชื่อช่าง (TASK B)
--
-- สิ่งที่ตรวจพบก่อนแก้ (หลักฐาน):
--   * job_assignments (0007) เป็นตารางเชื่อมงาน↔ช่างอยู่แล้ว → many-to-many ทางโครงสร้าง
--     - unique index job_assignments_active_uk (job_id, user_id) where released_at is null → กันบันทึกซ้ำคนเดิม
--     - accept_job / assign_technician / remove_technician ทำงานในธุรกรรมเดียว ล็อกแถวใบงาน (_lock_job for update)
--   * จุดที่ระบบยังจำกัด "ทางปฏิบัติ" ให้มีผลราวกับมอบหมายได้คนเดียว:
--     1) _job_crew_required() ผูกจำนวนช่างที่ต้องใช้กับ crew_size ของแคตตาล็อก (ค่าเริ่มต้น 1 ทุกบรรทัด
--        ตาม 0001_schema.sql บรรทัด crew_size int not null default 1) — งานส่วนใหญ่จึงรับได้ 1 คน
--     2) UI มอบหมายทีละครั้งเลือกได้ทีละคน (components/job/crew.tsx AssignSheet)
--     3) ไม่มี RPC สำหรับ "ตั้งทีมแบบหลายคนที่เรียกครั้งเดียวจบ" — ผู้ดูแลต้องกดเพิ่ม/เอาออกทีละคน
--   * ชื่อช่างมาจากฐานข้อมูลจริงเท่านั้น: users.full_name (สร้างตาม README ข้อ 4 จาก SQL บนโปรเจกต์ Supabase จริง
--     ไม่ใช่ seed.sql และไม่มี hard-code ในโค้ดแอป) — ดู supabase/tests/run.mjs mkUser() ประกอบ
--
-- การออกแบบ (minimal risk, preserve existing behavior):
--   * ไม่เปลี่ยนชื่อตาราง/คอลัมน์ , ไม่แตะ constraint เดิม , ข้อมูลเดิมเข้ากันได้ 100%
--     (ทุกใบงานที่มีช่าง 1 คน = กรณีเฉพาะของความสัมพันธ์หลายคน ; ไม่ต้อง backfill)
--   * เพิ่ม RPC ใหม่ set_job_crew(แทนที่ทั้งทีม) และ add_job_crew(เพิ่มหลายคนแบบ atomic)
--     ใช้กติกาเดียวกับ _add_assignment เดิม (ตรวจสถานะงาน, ตรวจซ้ำ, ตรวจสิทธิ์ช่าง) — ไม่เปลี่ยนกติกาเดิม
--   * ค่าเริ่มต้นของ "จำนวนช่างที่ต้องใช้" เปลี่ยนจาก "ผูกกับ crew_size อย่างเดียว" เป็น
--     max(crew_size ที่ต้องใช้, จำนวนช่างที่ยังรับงานอยู่ตอนนี้) — ทำให้ผู้ดูแลมอบหมายหลายคนได้ทันที
--     โดยที่กติกาเดิมทั้งหมด (ห้ามเกินจำนวน, รับครบแล้วคนอื่นมองไม่เห็น, เริ่มงานต้องมีช่าง ≥1,
--     QC ต้องมี ≥1, ค่าแรงหารเท่าตามคนที่ยังรับอยู่ ณ วันปิดงาน D24) ยังทำงานเหมือนเดิมเป๊ะ
--     เมื่อทีมมี 1 คน (พฤติกรรม legacy คงไว้)
--   * TASK B: UPDATE users.full_name ตาม mapping เท่านั้น — PK (id) และ auth.users ไม่ถูกแตะ
--     ประวัติย้อนหลังใน labor_pay_entries เก็บ item_name/plate แต่ไม่ได้ snapshot ช่าง — ชื่อแสดงดึงสดจาก users
--     (design เดิมของระบบ: technician_board / job_crew_info join users) จึงไม่ใช่การแก้ประวัติย้อนหลัง
--     ถ้าเจ้าของกิจการต้องการตรึงชื่อในอดีตในเอกสารที่พิมพ์ไปแล้ว ให้พิจารณาแยกต่างหาก (ยังไม่ทำอัตโนมัติ)
-- =====================================================================

-- ---------- flag ต่อใบงาน : ผู้ดูแลกำหนดจำนวนช่างที่ต้องใช้เอง (>= crew_size ของแคตตาล็อก) ----------
-- ค่าเริ่มต้น = กติกาเดิมทุกประการ (max crew_size ของบรรทัด service/fee, อย่างน้อย 1)
-- เมื่อ owner/admin ตั้งทีมด้วย set_job_crew จนเกินค่า default → คอลัมน์นี้ถูกยกขึ้น = ขนาดทีมที่สั่ง
-- ผล: งาน default ยังจำกัดที่ 1 คนเหมือนเดิม (ช่างคนอื่นยังแย่งรับเกินไม่ได้ / เห็น "เต็ม" เหมือนเดิม)
--     แต่งานที่ผู้ดูแลมอบหมายหลายคนแล้ว จะ "ต้องใช้" ตามจำนวนนั้น — ขยายได้ ไม่หดย้อนหลัง
--     (hysteresis: ลดทีมแล้วค่า required ไม่ลดกลับ → กันช่อง race ที่คนนอกเข้ามารับแทนทันทีที่เอาคนออก)
alter table job_orders add column if not exists crew_assigned int not null default 0
  check (crew_assigned >= 0);

comment on column job_orders.crew_assigned is
  'จำนวนช่างสูงสุดที่ผู้ดูแลเคยมอบหมายให้ใบงานนี้ (set_job_crew) — ใช้ขยาย "จำนวนช่างที่ต้องใช้" เหนือ crew_size แคตตาล็อก; 0 = ใช้กติกาเดิม';

-- ---------- helper ภายใน : จำนวนช่างที่ต้องใช้ ----------
-- เดิม (0007): greatest(1, coalesce(max(crew_size),1)) จากบรรทัด service/fee
-- ใหม่: greatest(ของเดิม, crew_assigned) — crew_assigned เป็น 0 สำหรับข้อมูลเดิมทั้งหมด → พฤติกรรม legacy คงไว้
create or replace function _job_crew_required(p_job uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(
    coalesce((select max(crew_size)::int from job_items
               where job_id = p_job and item_type in ('service', 'fee') and not is_bundle_header), 1),
    1,
    coalesce((select crew_assigned from job_orders where id = p_job), 0)
  )::int
$$;

-- ---------- RPC ใหม่ : ตั้งทีมช่างหลายคน (owner/admin) ----------
-- แทนที่ทีมปัจจุบันด้วยรายชื่อที่ให้มา (diff-based): คนใหม่รับเข้า, คนที่ไม่อยู่ในรายการถูกปล่อยพร้อมเหตุผล
-- ทำใน transaction เดียว, ล็อกใบงาน 1 ครั้ง, ห้ามซ้ำ (unique index เดิม + on conflict do nothing),
-- ห้ามเหลือ 0 คนในงานที่เริ่มแล้ว (in_progress/qc) — กติกาเดียวกับ remove_technician เดิม
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

  -- ยกเพดาน "จำนวนช่างที่ต้องใช้" ตามทีมที่ผู้ดูแลสั่ง (ขยายเท่านั้น ไม่หดย้อนหลัง — ดู comment ท้ายไฟล์)
  if cardinality(v_ids) > j.crew_assigned then
    update job_orders set crew_assigned = cardinality(v_ids) where id = j.id;
  end if;
end $$;

-- ---------- RPC ใหม่ : เพิ่มช่างหลายคนพร้อมกัน (owner/admin) ----------
-- เรียงตาม id ที่ส่งมาเพื่อกัน deadlock เมื่อสองคำขอแข่งกันบนหลายใบงาน
create or replace function add_job_crew(p_job_id uuid, p_user_ids uuid[])
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; v_new uuid;
begin
  if p_user_ids is null or cardinality(p_user_ids) = 0 then raise exception 'ต้องระบุช่างอย่างน้อย 1 คน'; end if;
  perform set_config('app.audit_reason', 'มอบหมายช่าง (เพิ่มหลายคน)', true);
  j := _lock_job(p_job_id, v_branch);
  foreach v_new in array (select array_agg(x order by x) from unnest(p_user_ids) as x) loop
    if not exists (select 1 from users u where u.id = v_new and u.branch_id = v_branch
                     and u.role = 'technician' and u.is_active) then
      raise exception 'ผู้ใช้ที่เลือกไม่ใช่ช่างที่ใช้งานอยู่';
    end if;
    perform _add_assignment(j, v_new);
  end loop;
end $$;

-- ---------- สิทธิ์ execute ตามรูปแบบเดิม ----------
revoke execute on function set_job_crew(uuid, uuid[], text) from public, anon;
revoke execute on function add_job_crew(uuid, uuid[]) from public, anon;
grant execute on function set_job_crew(uuid, uuid[], text) to authenticated;
grant execute on function add_job_crew(uuid, uuid[]) to authenticated;
-- ฟังก์ชันภายใน _* ปิดจาก authenticated ตามกลไกเดิมของ 0007 (set_job_crew/add_job_crew เรียก _add_assignment
-- ซึ่งเป็น security definer ภายใน — ไม่ได้เปิดสิทธิ์ให้ authenticated ตรง ๆ เพิ่มเติม)

-- ---------- TASK B : เปลี่ยนชื่อช่างให้ตรงการใช้งานจริง ----------
-- แหล่งชื่อจริง = users.full_name (PK/user id ไม่เปลี่ยน, บัญชี auth.users ไม่ถูกแตะ, ไม่สร้างบัญชีใหม่)
-- อัปเดตเฉพาะ 4 ชื่อนี้เท่านั้น; ชื่ออื่นไม่ถูกกระทบ (where full_name in (...))
-- รันซ้ำได้ (idempotent): ถ้าเปลี่ยนไปแล้วจะไม่มีแถวที่ตรงเงื่อนไข
update users set full_name = case full_name
    when 'ช่าง 1' then 'ช่างหนุ่ม'
    when 'ช่าง 2' then 'ช่างกิ้ม'
    when 'ช่าง 3' then 'ช่างริด'
    when 'ช่าง 4' then 'ช่างวี'
  end
where full_name in ('ช่าง 1', 'ช่าง 2', 'ช่าง 3', 'ช่าง 4');

-- รองรับกรณีที่ชื่อในฐานข้อมูลจริงเขียนแบบไม่มีช่องว่าง (ช่าง1) ด้วย — เงื่อนไขแคบพอที่จะไม่ชนชื่ออื่น
update users set full_name = case full_name
    when 'ช่าง1' then 'ช่างหนุ่ม'
    when 'ช่าง2' then 'ช่างกิ้ม'
    when 'ช่าง3' then 'ช่างริด'
    when 'ช่าง4' then 'ช่างวี'
  end
where full_name in ('ช่าง1', 'ช่าง2', 'ช่าง3', 'ช่าง4');
