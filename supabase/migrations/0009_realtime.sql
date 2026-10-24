-- =====================================================================
-- 0009 — เฟส 2: เปิด Realtime ให้ตารางที่หน้า Job Board / เบิกอะไหล่ / ค่าแรง ต้องรู้ทันที
--   * Supabase Realtime (postgres_changes) ส่งเหตุการณ์เฉพาะแถวที่ผู้ฟัง "อ่านได้ตาม RLS"
--   * ฝั่งแอปใช้เหตุการณ์เป็นแค่ "สัญญาณให้โหลดใหม่" (ไม่เชื่อ payload) และมี polling 30 วินาทีเป็นตาข่ายนิรภัย
--     เพราะบางการเปลี่ยนแปลงทำให้แถว "มองไม่เห็น" สำหรับผู้ฟัง (เช่นใบงานเต็มทีมแล้ว) ซึ่งจะไม่มีเหตุการณ์ส่งไป
--   * ถ้าไม่มี publication ชื่อ supabase_realtime (Postgres ธรรมดา) จะข้ามไปโดยไม่ error
-- =====================================================================
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['job_orders', 'job_assignments', 'requisitions', 'payments', 'refunds', 'qc_checks', 'labor_pay_entries']
    loop
      if not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
