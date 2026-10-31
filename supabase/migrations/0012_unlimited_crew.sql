-- 0012: ช่างกดรับงาน / เข้าร่วมงานได้ไม่จำกัดจำนวนคน (Jay ยืนยัน 2026-10-31)
--
-- เดิม (0007): _add_assignment ปฏิเสธ "งานนี้มีช่างรับครบแล้ว (x/y คน)" เมื่อช่างครบตามจำนวนที่ต้องใช้
--             และ app_tech_can_see_job ซ่อนงานที่ครบแล้วจากช่างคนอื่น
-- ใหม่: จำนวนช่างที่ต้องใช้ (crew_required) เป็นแค่ "ค่าแนะนำ" แสดงว่ายังขาดกี่คน
--   * ช่างกด "รับงาน" ได้ตลอดที่งาน "พร้อมทำ" / "กำลังทำ" — ไม่ตรวจเพดาน
--   * ช่างทุกคนในสาขาเห็นงาน "พร้อมทำ" / "กำลังทำ" ทุกใบ (เพื่อกดเข้าร่วมได้)
-- กติกาเดิมที่ยังคงไว้: ตรวจสถานะงาน, รับซ้ำไม่ได้ (unique index + _lock_job), งานเริ่มแล้วต้องมีช่าง >= 1,
--   ค่าแรงหารเท่าตามคนที่ยังรับอยู่ (D24), audit log ผ่าน trigger เดิม

create or replace function _add_assignment(j job_orders, p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if j.status not in ('ready', 'in_progress') then
    raise exception 'รับงานได้เฉพาะงานที่ "พร้อมทำ" หรือ "กำลังทำ" (ตอนนี้: %)', j.status;
  end if;
  if _is_assigned(j.id, p_user) then raise exception 'รับงานนี้อยู่แล้ว'; end if;
  insert into job_assignments(branch_id, job_id, user_id) values (j.branch_id, j.id, p_user);
end $$;

create or replace function app_tech_can_see_job(p_job uuid, p_status job_status) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app_role() = 'technician' and (
    p_status in ('condition_check', 'ready', 'in_progress')
    or (p_status = 'qc' and _is_assigned(p_job, auth.uid()))
  )
$$;

-- ฟังก์ชันภายในยังปิดจาก client ตามกลไกเดิม (0007)
revoke execute on function _add_assignment(job_orders, uuid) from public, anon, authenticated;
