-- =====================================================================
-- 0005 — ช่าง/คลังต้องไม่เห็นเงิน "ที่ระดับฐานข้อมูล" (ไม่ใช่แค่ซ่อนในหน้าจอ)
--   * item_prices (ราคา + ต้นทุน) : อ่านได้เฉพาะ owner/admin
--   * job_items (ราคาต่อหน่วย/ต้นทุน/ยอดบรรทัด) : อ่านตรง ๆ ได้เฉพาะ owner/admin
--       ช่างดูรายการงานผ่าน job_items_for_job() ซึ่งคืนค่าเงินเป็น NULL ให้ช่าง
--   * v_job_totals / v_jobs เป็น security_invoker → ช่างอ่าน job_items ไม่ได้ จึงเห็นยอดเป็น 0 (ไม่รั่ว)
--   ที่ยังไม่ปิด (ตั้งใจ ดู DECISIONS.md): catalog_items.labor_rate/crew_size ยังอ่านได้ทุกบทบาทในสาขา
-- =====================================================================

-- ราคา/ต้นทุน: เฉพาะ owner/admin
drop policy if exists item_prices_select on item_prices;
create policy item_prices_select on item_prices for select to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin'));

-- job_items: อ่านตรง ๆ เฉพาะ owner/admin
drop policy if exists job_items_select on job_items;
create policy job_items_select on job_items for select to authenticated
  using (
    exists (select 1 from job_orders j where j.id = job_items.job_id)
    and app_role() in ('owner', 'admin')
  );

-- ตรวจว่าผู้เรียก "เห็นใบงานนี้ได้" ไหม (เงื่อนไขเดียวกับ policy job_orders_select ใน 0002 — มีเทสต์ตรวจ)
create or replace function app_can_see_job(p_job uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from job_orders j
     where j.id = p_job and j.branch_id = app_branch_id()
       and (app_role() in ('owner', 'admin')
            or (app_role() = 'technician' and j.voided_at is null
                and j.status in ('condition_check', 'ready', 'in_progress', 'qc')))
  )
$$;
revoke all on function app_can_see_job(uuid) from public, anon;
grant execute on function app_can_see_job(uuid) to authenticated;

-- รายการงานของใบงานหนึ่ง : เรียกได้ทุกบทบาทที่ "เห็นใบงานนั้นได้" ; ค่าเงินคืน NULL ถ้าไม่ใช่ owner/admin
--   (security definer เพราะช่างอ่าน job_items ตรง ๆ ไม่ได้ จึงตรวจสิทธิ์เห็นใบงานเองด้วย app_can_see_job)
create or replace function job_items_for_job(p_job uuid) returns setof job_items
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_branch_id();
  v_role   user_role := app_role();
  v_money  boolean;
begin
  if v_branch is null or not app_can_see_job(p_job) then return; end if;
  v_money := v_role in ('owner', 'admin');
  return query
  select i.id, i.branch_id, i.job_id, i.parent_id, i.catalog_item_id, i.price_id, i.category_id,
         i.item_code, i.item_name, i.variant_label, i.item_type, i.is_bundle_header, i.qty,
         (case when v_money then i.unit_price end)::numeric(12,2),
         (case when v_money then i.list_price end)::numeric(12,2),
         (case when v_money then i.cost end)::numeric(12,2),
         case when v_money then i.price_reason end,
         (case when v_money then i.labor_rate end)::numeric(12,2),
         i.crew_size, i.warranty_months, i.requires_condition_check, i.condition_template_id,
         i.attributes, i.owner_approved_at, i.owner_approved_by, i.sort_order,
         (case when v_money then i.line_total end)::numeric(14,2),
         i.created_at, i.updated_at, i.created_by
    from job_items i
   where i.job_id = p_job
   order by i.sort_order, i.created_at;
end $$;
revoke all on function job_items_for_job(uuid) from public, anon;
grant execute on function job_items_for_job(uuid) to authenticated;

-- job_required_checks เดิมอ่าน job_items ตรง ๆ (security invoker) → ช่างจะมองไม่เห็นฟอร์มเช็คสภาพเฉพาะรายการ
-- ทำเป็น security definer + ตรวจสิทธิ์เห็นใบงานด้วย app_can_see_job
create or replace function job_required_checks(p_job uuid)
returns table (template_id uuid, template_name text, min_photos int, check_id uuid, completed boolean, photo_count bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.id, t.name, t.min_photos, c.id, (c.completed_at is not null),
         (select count(*) from condition_check_photos p where p.check_id = c.id)
    from condition_templates t
    join job_orders j on j.id = p_job and j.branch_id = t.branch_id
    left join condition_checks c on c.job_id = p_job and c.template_id = t.id
   where app_can_see_job(p_job)
     and t.id in (select _job_required_templates(p_job))
   order by t.is_default desc, t.name
$$;
revoke all on function job_required_checks(uuid) from public, anon;
grant execute on function job_required_checks(uuid) to authenticated;

-- สลิปโอนเงิน (โฟลเดอร์ {branch}/{job}/slip/...) : ช่างอ่าน/อัปโหลดไม่ได้ ; รูปเช็คสภาพ/ลายเซ็นช่างยังใช้ได้เหมือนเดิม
drop policy if exists job_files_select on storage.objects;
create policy job_files_select on storage.objects for select to authenticated
  using (bucket_id = 'job-files'
         and (storage.foldername(name))[1] = app_branch_id()::text
         and (app_role() in ('owner', 'admin')
              or (app_role() = 'technician' and coalesce((storage.foldername(name))[3], '') <> 'slip')));

drop policy if exists job_files_insert on storage.objects;
create policy job_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'job-files'
         and (storage.foldername(name))[1] = app_branch_id()::text
         and (app_role() in ('owner', 'admin')
              or (app_role() = 'technician' and coalesce((storage.foldername(name))[3], '') <> 'slip')));
