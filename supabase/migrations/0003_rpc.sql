-- =====================================================================
-- 0003_rpc.sql — views, ฟังก์ชันภายใน, RPC (state machine + กฎธุรกิจ)
-- ทุก RPC เป็น security definer และตรวจบทบาท/สาขาเองผ่าน app_assert()
-- =====================================================================

-- ---------- helpers ภายใน ----------
create or replace function _job_editable(s job_status) returns boolean
language sql immutable as $$
  select s in ('booked', 'opened', 'condition_check', 'quoting')
$$;

create or replace function next_doc_no(p_branch uuid, p_type text, p_prefix text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_period text := to_char(now() at time zone 'Asia/Bangkok', 'YYYYMMDD'); v_no int;
begin
  insert into doc_counters(branch_id, doc_type, period, last_no)
  values (p_branch, p_type, v_period, 1)
  on conflict (branch_id, doc_type, period) do update set last_no = doc_counters.last_no + 1
  returning last_no into v_no;
  return p_prefix || '-' || v_period || '-' || lpad(v_no::text, 3, '0');
end $$;

create or replace function _log_status(p_branch uuid, p_job uuid, p_from job_status, p_to job_status, p_reason text)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into job_status_log(branch_id, job_id, from_status, to_status, reason)
  values (p_branch, p_job, p_from, p_to, nullif(btrim(coalesce(p_reason, '')), ''))
$$;

create or replace function _lock_job(p_job uuid, p_branch uuid) returns job_orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare j job_orders%rowtype;
begin
  select * into j from job_orders where id = p_job and branch_id = p_branch for update;
  if not found then raise exception 'ไม่พบใบงาน'; end if;
  if j.voided_at is not null then raise exception 'ใบงานนี้ถูก void แล้ว'; end if;
  return j;
end $$;

create or replace function _need_reason(p text, p_what text default 'การกระทำนี้') returns text
language plpgsql immutable as $$
begin
  if nullif(btrim(coalesce(p, '')), '') is null then
    raise exception '% ต้องระบุเหตุผล', p_what;
  end if;
  return btrim(p);
end $$;

create or replace function _check_attrs(p_schema text[], p_attrs jsonb, p_name text) returns void
language plpgsql immutable as $$
declare k text;
begin
  if p_attrs is null or jsonb_typeof(p_attrs) <> 'object' then
    raise exception 'รูปแบบข้อมูลเพิ่มเติม (attributes) ไม่ถูกต้อง';
  end if;
  foreach k in array coalesce(p_schema, '{}') loop
    if nullif(btrim(coalesce(p_attrs ->> k, '')), '') is null then
      raise exception 'กรุณาระบุ "%" สำหรับรายการ %', k, p_name;
    end if;
  end loop;
end $$;

-- ---------- views ----------
create or replace view v_job_totals with (security_invoker = true) as
select t.job_id, t.branch_id, t.gross, t.discount, t.net, t.vat,
       (t.net + t.vat) as grand_total,
       t.paid_total,
       (t.net + t.vat - t.paid_total) as balance,
       case when t.paid_total <= 0 then 'unpaid'
            when t.paid_total < (t.net + t.vat) then 'partial'
            else 'paid' end as payment_status
from (
  select j.id as job_id, j.branch_id, l.gross, l.discount,
         (l.gross - l.discount) as net,
         case when j.vat_enabled then round((l.gross - l.discount) * j.vat_rate / 100, 2) else 0::numeric end as vat,
         p.paid_total
  from job_orders j
  cross join lateral (
    select coalesce(sum(i.line_total) filter (where i.item_type <> 'discount'), 0)  as gross,
           coalesce(-sum(i.line_total) filter (where i.item_type = 'discount'), 0)  as discount
    from job_items i where i.job_id = j.id
  ) l
  cross join lateral (
    select coalesce(sum(pay.amount), 0) as paid_total
    from payments pay where pay.job_id = j.id and pay.voided_at is null
  ) p
) t;

create or replace view v_jobs with (security_invoker = true) as
select j.id, j.branch_id, j.job_no, j.status, j.source, j.complaint, j.odometer,
       j.scheduled_at, j.opened_at, j.created_at, j.updated_at,
       j.quote_approved_at, j.qc_passed_at, j.closed_at, j.voided_at, j.cancel_reason,
       j.customer_id, c.name as customer_name, c.phone as customer_phone,
       j.vehicle_id, v.plate, v.plate_province, v.brand, v.model, v.year,
       t.gross, t.discount, t.net, t.vat, t.grand_total, t.paid_total, t.balance, t.payment_status
from job_orders j
join customers c on c.id = j.customer_id
join vehicles v  on v.id = j.vehicle_id
join v_job_totals t on t.job_id = j.id;

grant select on v_job_totals, v_jobs to authenticated;

-- ---------- ตรวจเช็คสภาพ / ส่วนลด (ใช้ได้ทั้งใน UI และ RPC) ----------
create or replace function _job_required_templates(p_job uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select t.id from condition_templates t
    join job_orders j on j.id = p_job and t.branch_id = j.branch_id
   where t.is_default and t.is_active
  union
  select i.condition_template_id from job_items i
   where i.job_id = p_job and i.requires_condition_check and i.condition_template_id is not null
$$;

create or replace function job_required_checks(p_job uuid)
returns table (template_id uuid, template_name text, min_photos int, check_id uuid, completed boolean, photo_count bigint)
language sql stable set search_path = public, pg_temp as $$
  select t.id, t.name, t.min_photos, c.id, (c.completed_at is not null),
         (select count(*) from condition_check_photos p where p.check_id = c.id)
    from condition_templates t
    join job_orders j on j.id = p_job and j.branch_id = t.branch_id
    left join condition_checks c on c.job_id = p_job and c.template_id = t.id
   where t.id in (
       select t2.id from condition_templates t2 where t2.branch_id = j.branch_id and t2.is_default and t2.is_active
       union
       select i.condition_template_id from job_items i
        where i.job_id = p_job and i.requires_condition_check and i.condition_template_id is not null)
   order by t.is_default desc, t.name
$$;

create or replace function _job_missing_checks(p_job uuid) returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(t.name order by t.name), '{}')
    from condition_templates t
   where t.id in (select _job_required_templates(p_job))
     and not exists (select 1 from condition_checks c
                      where c.job_id = p_job and c.template_id = t.id and c.completed_at is not null)
$$;

create or replace function job_discount_blocked(p_job uuid) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_gross numeric; v_disc numeric; v_pending int; v_cap numeric;
begin
  select coalesce(sum(line_total) filter (where item_type <> 'discount'), 0),
         coalesce(-sum(line_total) filter (where item_type = 'discount'), 0),
         count(*) filter (where item_type = 'discount' and owner_approved_at is null)
    into v_gross, v_disc, v_pending
    from job_items where job_id = p_job;
  if v_disc = 0 or v_pending = 0 then return false; end if;
  select s.discount_cap_percent into v_cap
    from branch_settings s join job_orders j on j.branch_id = s.branch_id where j.id = p_job;
  if v_gross = 0 then return true; end if;
  return (v_disc / v_gross * 100) > coalesce(v_cap, 0);
end $$;

-- =====================================================================
-- เปิดใบงาน (ค้นด้วยทะเบียน → ใช้รถ/ลูกค้าเดิม ถ้าไม่มีสร้างใหม่)
-- =====================================================================
create or replace function open_job(
  p_plate text,
  p_plate_province text default null,
  p_brand text default null,
  p_model text default null,
  p_year int default null,
  p_odometer int default null,
  p_customer_name text default null,
  p_phone text default null,
  p_source job_source default 'walk_in',
  p_complaint text default null,
  p_scheduled_at timestamptz default null,
  p_vehicle_id uuid default null,
  p_customer_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  v_veh vehicles%rowtype;
  v_cust uuid;
  v_job uuid;
  v_status job_status;
  v_set branch_settings%rowtype;
  v_norm text;
  v_prov text := nullif(btrim(coalesce(p_plate_province, '')), '');
begin
  perform set_config('app.audit_reason', '', true);
  if p_odometer is not null and p_odometer < 0 then raise exception 'เลขไมล์ไม่ถูกต้อง'; end if;

  if p_vehicle_id is not null then
    select * into v_veh from vehicles where id = p_vehicle_id and branch_id = v_branch;
    if not found then raise exception 'ไม่พบรถที่เลือก'; end if;
  else
    if nullif(btrim(coalesce(p_plate, '')), '') is null then raise exception 'กรุณากรอกทะเบียนรถ'; end if;
    v_norm := upper(regexp_replace(p_plate, '[\s\.\-]', '', 'g'));
    select * into v_veh from vehicles
     where branch_id = v_branch and plate_norm = v_norm and coalesce(plate_province, '') = coalesce(v_prov, '');
    if not found then
      insert into vehicles(branch_id, plate, plate_province, brand, model, year, last_odometer)
      values (v_branch, btrim(p_plate), v_prov, nullif(btrim(coalesce(p_brand, '')), ''),
              nullif(btrim(coalesce(p_model, '')), ''), p_year, p_odometer)
      returning * into v_veh;
    end if;
  end if;

  -- ลูกค้า: ระบุตรง ๆ > ค้นด้วยเบอร์ > ลูกค้าเดิมของรถ (ถ้าไม่กรอกชื่อ) > สร้างใหม่
  if p_customer_id is not null then
    select id into v_cust from customers where id = p_customer_id and branch_id = v_branch;
    if not found then raise exception 'ไม่พบลูกค้าที่เลือก'; end if;
  elsif nullif(btrim(coalesce(p_phone, '')), '') is not null then
    select id into v_cust from customers
     where branch_id = v_branch and phone = btrim(p_phone) order by created_at limit 1;
  end if;
  if v_cust is null and nullif(btrim(coalesce(p_customer_name, '')), '') is null and v_veh.customer_id is not null then
    v_cust := v_veh.customer_id;
  end if;
  if v_cust is null then
    if nullif(btrim(coalesce(p_customer_name, '')), '') is null then
      raise exception 'กรุณากรอกชื่อลูกค้า';
    end if;
    insert into customers(branch_id, name, phone)
    values (v_branch, btrim(p_customer_name), nullif(btrim(coalesce(p_phone, '')), ''))
    returning id into v_cust;
  end if;

  update vehicles set
    brand = coalesce(nullif(btrim(coalesce(p_brand, '')), ''), brand),
    model = coalesce(nullif(btrim(coalesce(p_model, '')), ''), model),
    year = coalesce(p_year, year),
    last_odometer = coalesce(p_odometer, last_odometer),
    customer_id = v_cust
  where id = v_veh.id;

  select * into v_set from branch_settings where branch_id = v_branch;
  v_status := case when p_scheduled_at is not null and p_scheduled_at > now() then 'booked' else 'opened' end;

  insert into job_orders(branch_id, job_no, status, customer_id, vehicle_id, odometer, source, complaint,
                         scheduled_at, opened_at, vat_enabled, vat_rate)
  values (v_branch, next_doc_no(v_branch, 'job', 'JO'), v_status, v_cust, v_veh.id, p_odometer, p_source,
          nullif(btrim(coalesce(p_complaint, '')), ''), p_scheduled_at,
          case when v_status = 'opened' then now() end,
          coalesce(v_set.vat_enabled, false), coalesce(v_set.vat_rate, 7))
  returning id into v_job;

  perform _log_status(v_branch, v_job, null, v_status, 'เปิดใบงาน');
  return v_job;
end $$;

-- =====================================================================
-- รายการในใบงาน
-- =====================================================================
create or replace function add_job_item(
  p_job_id uuid,
  p_item_id uuid,
  p_price_id uuid default null,
  p_qty numeric default 1,
  p_unit_price numeric default null,
  p_reason text default null,
  p_attributes jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  v_role user_role := app_role();
  j job_orders;
  it catalog_items%rowtype;
  pr item_prices%rowtype;
  v_list numeric; v_unit numeric; v_id uuid; v_header uuid; v_sort int;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_attr jsonb := coalesce(p_attributes, '{}'::jsonb);
  comp record;
begin
  perform set_config('app.audit_reason', coalesce(v_reason, ''), true);
  j := _lock_job(p_job_id, v_branch);
  if not _job_editable(j.status) then
    raise exception 'แก้ไขรายการไม่ได้ในสถานะนี้ — ถ้าต้องแก้ ให้ย้อนสถานะกลับไป "เสนอราคา" พร้อมเหตุผล';
  end if;
  if p_qty is null or p_qty <= 0 then raise exception 'จำนวนต้องมากกว่า 0'; end if;

  select * into it from catalog_items where id = p_item_id and branch_id = v_branch;
  if not found then raise exception 'ไม่พบรายการในแคตตาล็อก'; end if;
  if not it.is_active then raise exception 'รายการ % ปิดใช้งานอยู่', it.name; end if;
  perform _check_attrs(it.attribute_schema, v_attr, it.name);

  select coalesce(max(sort_order), 0) + 1 into v_sort from job_items where job_id = j.id;

  -- ---- bundle: แตกเป็นบรรทัดย่อยตอนบันทึกใบงาน ----
  if it.item_type = 'bundle' then
    if p_unit_price is not null then
      raise exception 'ชุดบริการ (bundle) แก้ราคารวมไม่ได้ — ให้แก้ราคาที่รายการย่อยแทน';
    end if;
    if not exists (select 1 from catalog_bundle_components where bundle_item_id = it.id) then
      raise exception 'ชุดบริการ % ยังไม่มีรายการย่อย', it.name;
    end if;
    insert into job_items(branch_id, job_id, catalog_item_id, category_id, item_code, item_name, item_type,
                          is_bundle_header, qty, unit_price, sort_order, attributes)
    values (v_branch, j.id, it.id, it.category_id, it.code, it.name, 'bundle', true, p_qty, 0, v_sort, v_attr)
    returning id into v_header;

    for comp in
      select bc.qty as c_qty, bc.unit_price as c_price, ci.id as ci_id, ci.category_id, ci.code, ci.name,
             ci.item_type, ci.labor_rate, ci.crew_size, ci.warranty_months, ci.requires_condition_check,
             ci.condition_template_id, ci.attribute_schema
        from catalog_bundle_components bc
        join catalog_items ci on ci.id = bc.component_item_id
       where bc.bundle_item_id = it.id
       order by ci.code
    loop
      perform _check_attrs(comp.attribute_schema, v_attr, comp.name);
      v_sort := v_sort + 1;
      insert into job_items(branch_id, job_id, parent_id, catalog_item_id, category_id, item_code, item_name,
                            item_type, qty, unit_price, list_price, labor_rate, crew_size, warranty_months,
                            requires_condition_check, condition_template_id, sort_order, attributes)
      values (v_branch, j.id, v_header, comp.ci_id, comp.category_id, comp.code, comp.name, comp.item_type,
              comp.c_qty * p_qty, comp.c_price, comp.c_price, comp.labor_rate, comp.crew_size,
              comp.warranty_months, comp.requires_condition_check, comp.condition_template_id, v_sort, v_attr);
    end loop;
    return v_header;
  end if;

  -- ---- เลือกตัวเลือกราคา (variant) ----
  if p_price_id is not null then
    select * into pr from item_prices where id = p_price_id and item_id = it.id and is_active;
    if not found then raise exception 'ไม่พบตัวเลือกราคาที่เลือก'; end if;
  else
    select * into pr from item_prices
     where item_id = it.id and is_active and position is null and vehicle_size is null;
    if not found and exists (select 1 from item_prices where item_id = it.id and is_active) then
      raise exception 'รายการ % มีหลายตัวเลือกราคา — กรุณาเลือกตำแหน่ง/ขนาดรถ', it.name;
    end if;
  end if;
  v_list := coalesce(pr.price, 0);

  if it.item_type = 'discount' then
    if p_unit_price is null or p_unit_price <= 0 then raise exception 'กรุณาระบุจำนวนเงินส่วนลด (มากกว่า 0)'; end if;
    v_reason := _need_reason(v_reason, 'ส่วนลด');
    v_unit := -round(p_unit_price, 2);
  else
    if p_unit_price is not null and p_unit_price < 0 then raise exception 'ราคาต้องไม่ติดลบ'; end if;
    v_unit := coalesce(round(p_unit_price, 2), v_list);
    if v_unit <> v_list then
      v_reason := _need_reason(v_reason, format('การแก้ราคาจากแคตตาล็อก (฿%s)', v_list));
    end if;
  end if;

  insert into job_items(branch_id, job_id, catalog_item_id, price_id, category_id, item_code, item_name,
                        variant_label, item_type, qty, unit_price, list_price, cost, price_reason,
                        labor_rate, crew_size, warranty_months, requires_condition_check, condition_template_id,
                        attributes, owner_approved_at, owner_approved_by, sort_order)
  values (v_branch, j.id, it.id, pr.id, it.category_id, it.code, it.name,
          case when pr.id is not null and (pr.position is not null or pr.vehicle_size is not null) then pr.label end,
          it.item_type, p_qty, v_unit,
          case when it.item_type = 'discount' then null else v_list end,
          coalesce(pr.cost, 0), v_reason,
          it.labor_rate, it.crew_size, it.warranty_months, it.requires_condition_check, it.condition_template_id,
          v_attr,
          case when it.item_type = 'discount' and v_role = 'owner' then now() end,
          case when it.item_type = 'discount' and v_role = 'owner' then auth.uid() end,
          v_sort)
  returning id into v_id;
  return v_id;
end $$;

create or replace function set_job_item_price(p_line_id uuid, p_price numeric, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  v_role user_role := app_role();
  l job_items%rowtype; j job_orders; v_reason text;
begin
  v_reason := _need_reason(p_reason, 'การแก้ราคา/ส่วนลด');
  perform set_config('app.audit_reason', v_reason, true);
  select * into l from job_items where id = p_line_id and branch_id = v_branch for update;
  if not found then raise exception 'ไม่พบรายการ'; end if;
  j := _lock_job(l.job_id, v_branch);
  if not _job_editable(j.status) then raise exception 'แก้ราคาไม่ได้ในสถานะนี้ — ให้ย้อนสถานะกลับไป "เสนอราคา" พร้อมเหตุผล'; end if;
  if l.is_bundle_header then raise exception 'แก้ราคาที่หัวชุดไม่ได้ — ให้แก้ที่รายการย่อย'; end if;
  if p_price is null or p_price < 0 then raise exception 'ราคาต้องไม่ติดลบ'; end if;

  if l.item_type = 'discount' then
    update job_items set unit_price = -round(p_price, 2), price_reason = v_reason,
           owner_approved_at = case when v_role = 'owner' then now() end,
           owner_approved_by = case when v_role = 'owner' then auth.uid() end
     where id = l.id;
  else
    update job_items set unit_price = round(p_price, 2), price_reason = v_reason where id = l.id;
  end if;
end $$;

create or replace function set_job_item_qty(p_line_id uuid, p_qty numeric) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  l job_items%rowtype; j job_orders;
begin
  perform set_config('app.audit_reason', 'แก้จำนวน', true);
  select * into l from job_items where id = p_line_id and branch_id = v_branch for update;
  if not found then raise exception 'ไม่พบรายการ'; end if;
  j := _lock_job(l.job_id, v_branch);
  if not _job_editable(j.status) then raise exception 'แก้จำนวนไม่ได้ในสถานะนี้'; end if;
  if l.is_bundle_header or l.parent_id is not null then
    raise exception 'แก้จำนวนของชุดบริการไม่ได้ — ให้ลบแล้วเพิ่มใหม่';
  end if;
  if p_qty is null or p_qty <= 0 then raise exception 'จำนวนต้องมากกว่า 0'; end if;
  update job_items set qty = round(p_qty, 2) where id = l.id;
end $$;

create or replace function remove_job_item(p_line_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  l job_items%rowtype; j job_orders; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into l from job_items where id = p_line_id and branch_id = v_branch for update;
  if not found then raise exception 'ไม่พบรายการ'; end if;
  if l.item_type = 'discount' then v_reason := _need_reason(v_reason, 'การลบส่วนลด'); end if;
  perform set_config('app.audit_reason', coalesce(v_reason, 'ลบรายการ'), true);
  j := _lock_job(l.job_id, v_branch);
  if not _job_editable(j.status) then raise exception 'ลบรายการไม่ได้ในสถานะนี้'; end if;
  if l.parent_id is not null then raise exception 'ลบรายการย่อยของชุดไม่ได้ — ให้ลบทั้งชุด'; end if;
  delete from job_items where parent_id = l.id;
  delete from job_items where id = l.id;
end $$;

create or replace function approve_discounts(p_job_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner']::user_role[]); j job_orders;
begin
  perform set_config('app.audit_reason', coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'เจ้าของอนุมัติส่วนลด'), true);
  j := _lock_job(p_job_id, v_branch);
  if not _job_editable(j.status) then raise exception 'อนุมัติส่วนลดได้เฉพาะก่อนลูกค้าอนุมัติใบเสนอราคา'; end if;
  update job_items set owner_approved_at = now(), owner_approved_by = auth.uid()
   where job_id = j.id and item_type = 'discount' and owner_approved_at is null;
end $$;

-- =====================================================================
-- เช็คสภาพรถ
-- =====================================================================
create or replace function save_condition_check(
  p_job_id uuid, p_template_id uuid, p_answers jsonb, p_note text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin', 'technician']::user_role[]);
  j job_orders; cc condition_checks%rowtype; v_id uuid; e record;
begin
  perform set_config('app.audit_reason', '', true);
  j := _lock_job(p_job_id, v_branch);
  if j.status < 'condition_check' or j.status > 'ready' then
    raise exception 'บันทึกเช็คสภาพได้ตั้งแต่ขั้น "เช็คสภาพรถ" ถึง "พร้อมทำ" เท่านั้น';
  end if;
  if not exists (select 1 from condition_templates where id = p_template_id and branch_id = v_branch) then
    raise exception 'ไม่พบแบบฟอร์มเช็คสภาพ';
  end if;
  if p_template_id not in (select _job_required_templates(j.id)) then
    raise exception 'แบบฟอร์มนี้ไม่ได้ใช้กับใบงานนี้';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then raise exception 'รูปแบบคำตอบไม่ถูกต้อง'; end if;
  for e in select key, value from jsonb_each(p_answers) loop
    if coalesce(e.value ->> 'state', '') not in ('ok', 'defect', 'na') then
      raise exception 'คำตอบของข้อ "%" ต้องเป็น ok / defect / na', e.key;
    end if;
  end loop;

  select * into cc from condition_checks where job_id = j.id and template_id = p_template_id for update;
  if found then
    if cc.completed_at is not null then
      raise exception 'เช็คสภาพชุดนี้ยืนยันแล้ว — owner/admin ต้องเปิดแก้ไขพร้อมเหตุผลก่อน';
    end if;
    update condition_checks set answers = p_answers, note = p_note where id = cc.id returning id into v_id;
  else
    insert into condition_checks(branch_id, job_id, template_id, answers, note)
    values (v_branch, j.id, p_template_id, p_answers, p_note) returning id into v_id;
  end if;
  return v_id;
end $$;

create or replace function add_condition_photo(p_check_id uuid, p_path text, p_caption text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin', 'technician']::user_role[]);
  cc condition_checks%rowtype; j job_orders; v_id uuid;
begin
  perform set_config('app.audit_reason', '', true);
  select * into cc from condition_checks where id = p_check_id and branch_id = v_branch for update;
  if not found then raise exception 'ไม่พบรายการเช็คสภาพ'; end if;
  j := _lock_job(cc.job_id, v_branch);
  if cc.completed_at is not null then raise exception 'เช็คสภาพนี้ยืนยันแล้ว เพิ่มรูปไม่ได้'; end if;
  if p_path is null or p_path not like v_branch::text || '/%' then
    raise exception 'ตำแหน่งไฟล์รูปไม่ถูกต้อง';
  end if;
  insert into condition_check_photos(branch_id, check_id, storage_path, caption)
  values (v_branch, cc.id, p_path, nullif(btrim(coalesce(p_caption, '')), '')) returning id into v_id;
  return v_id;
end $$;

create or replace function complete_condition_check(p_check_id uuid, p_signature_path text, p_signed_by text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin', 'technician']::user_role[]);
  cc condition_checks%rowtype; t condition_templates%rowtype; j job_orders; it jsonb; v_key text; v_ans jsonb;
  v_photos int;
begin
  perform set_config('app.audit_reason', 'ยืนยันเช็คสภาพ', true);
  select * into cc from condition_checks where id = p_check_id and branch_id = v_branch for update;
  if not found then raise exception 'ไม่พบรายการเช็คสภาพ'; end if;
  j := _lock_job(cc.job_id, v_branch);
  if cc.completed_at is not null then raise exception 'ยืนยันเช็คสภาพนี้ไปแล้ว'; end if;
  select * into t from condition_templates where id = cc.template_id;

  for it in select * from jsonb_array_elements(t.checklist) loop
    if coalesce((it ->> 'required')::boolean, true) then
      v_key := it ->> 'key';
      v_ans := cc.answers -> v_key;
      if v_ans is null then raise exception 'ยังไม่ได้ตอบข้อ "%"', it ->> 'label'; end if;
      if v_ans ->> 'state' = 'defect' and nullif(btrim(coalesce(v_ans ->> 'note', '')), '') is null then
        raise exception 'ข้อ "%" พบตำหนิ — ต้องระบุรายละเอียด', it ->> 'label';
      end if;
    end if;
  end loop;

  select count(*) into v_photos from condition_check_photos where check_id = cc.id;
  if v_photos < t.min_photos then
    raise exception 'ต้องแนบรูปอย่างน้อย % รูป (ตอนนี้ % รูป)', t.min_photos, v_photos;
  end if;
  if p_signature_path is null or p_signature_path not like v_branch::text || '/%' then
    raise exception 'ต้องมีลายเซ็นลูกค้า';
  end if;
  if nullif(btrim(coalesce(p_signed_by, '')), '') is null then raise exception 'กรุณาระบุชื่อผู้เซ็น'; end if;

  update condition_checks set signature_path = p_signature_path, signed_by_name = btrim(p_signed_by),
         signed_at = now(), completed_at = now(), completed_by = auth.uid()
   where id = cc.id;
end $$;

create or replace function reopen_condition_check(p_check_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  cc condition_checks%rowtype; j job_orders; v_reason text;
begin
  v_reason := _need_reason(p_reason, 'การเปิดแก้เช็คสภาพ');
  perform set_config('app.audit_reason', v_reason, true);
  select * into cc from condition_checks where id = p_check_id and branch_id = v_branch for update;
  if not found then raise exception 'ไม่พบรายการเช็คสภาพ'; end if;
  j := _lock_job(cc.job_id, v_branch);
  if j.status >= 'in_progress' then raise exception 'งานเริ่มทำแล้ว เปิดแก้เช็คสภาพไม่ได้'; end if;
  update condition_checks set completed_at = null, completed_by = null, signature_path = null,
         signed_by_name = null, signed_at = null where id = cc.id;
end $$;

-- =====================================================================
-- State machine
-- =====================================================================
create or replace function advance_job(p_job_id uuid) returns job_status
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin', 'technician']::user_role[]);
  v_role user_role := app_role();
  j job_orders; v_to job_status; v_missing text[];
begin
  perform set_config('app.audit_reason', '', true);
  j := _lock_job(p_job_id, v_branch);

  -- ช่างทำได้เฉพาะ: เริ่มงาน และ ส่งตรวจ QC (เฟส 2 จะจำกัดเฉพาะงานที่ตัวเองรับ)
  if v_role = 'technician' and j.status not in ('ready', 'in_progress') then
    raise exception 'ช่างเปลี่ยนสถานะได้เฉพาะ "เริ่มงาน" และ "ส่งตรวจ QC"';
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
      v_to := 'ready';   -- เฟส 1: แอดมินยืนยันเอง ; เฟส 2 จะผูกกับคำขอเบิกอะไหล่
      update job_orders set status = v_to where id = j.id;
    when 'ready' then
      v_missing := _job_missing_checks(j.id);
      if cardinality(v_missing) > 0 then
        raise exception 'เริ่มงานไม่ได้ — เช็คสภาพรถยังไม่ครบ: %', array_to_string(v_missing, ', ');
      end if;
      v_to := 'in_progress';
      update job_orders set status = v_to where id = j.id;
    when 'in_progress' then
      v_to := 'qc';
      update job_orders set status = v_to where id = j.id;
    when 'qc' then
      raise exception 'ขั้น "รอ QC" ต้องกด "ผ่าน QC" (pass_qc)';
    when 'awaiting_payment' then
      raise exception 'ขั้น "รอชำระ" ต้องกด "ปิดงาน" (close_job) เมื่อรับเงินครบ';
    else
      raise exception 'สถานะ % ไปต่อไม่ได้', j.status;
  end case;

  perform _log_status(v_branch, j.id, j.status, v_to, null);
  return v_to;
end $$;

create or replace function approve_quote(p_job_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; t record; v_zero int;
begin
  perform set_config('app.audit_reason', '', true);
  j := _lock_job(p_job_id, v_branch);
  if j.status <> 'quoting' then raise exception 'อนุมัติใบเสนอราคาได้เฉพาะสถานะ "เสนอราคา"'; end if;
  if not exists (select 1 from job_items where job_id = j.id and item_type not in ('discount', 'bundle')) then
    raise exception 'ยังไม่มีรายการในใบเสนอราคา';
  end if;
  select count(*) into v_zero from job_items
   where job_id = j.id and item_type not in ('discount', 'bundle') and unit_price = 0 and price_reason is null;
  if v_zero > 0 then
    raise exception 'มี % รายการที่ราคา 0 — ให้ owner ตั้งราคาในแคตตาล็อก หรือแก้ราคาในใบงานพร้อมเหตุผล', v_zero;
  end if;
  select * into t from v_job_totals where job_id = j.id;
  if t.net < 0 then raise exception 'ส่วนลดรวมเกินยอดรายการ'; end if;
  if job_discount_blocked(j.id) then
    raise exception 'ส่วนลดเกินเพดานที่เจ้าของตั้งไว้ — ต้องให้เจ้าของอนุมัติก่อน';
  end if;

  update job_orders set status = 'requisition', quote_approved_at = now(), quote_approved_by = auth.uid(),
         quote_approval_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = j.id;
  perform _log_status(v_branch, j.id, j.status, 'requisition', 'ลูกค้าอนุมัติใบเสนอราคา');
end $$;

create or replace function pass_qc(p_job_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner', 'admin']::user_role[]); j job_orders;
begin
  perform set_config('app.audit_reason', '', true);
  j := _lock_job(p_job_id, v_branch);
  if j.status <> 'qc' then raise exception 'ผ่าน QC ได้เฉพาะสถานะ "รอ QC"'; end if;
  update job_orders set status = 'awaiting_payment', qc_passed_at = now(), qc_passed_by = auth.uid(),
         qc_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = j.id;
  perform _log_status(v_branch, j.id, j.status, 'awaiting_payment', 'ผ่าน QC');
end $$;

create or replace function revert_job(p_job_id uuid, p_target job_status, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; v_reason text;
begin
  v_reason := _need_reason(p_reason, 'การย้อนสถานะ');
  perform set_config('app.audit_reason', v_reason, true);
  j := _lock_job(p_job_id, v_branch);
  if j.status in ('closed', 'cancelled') then
    raise exception 'ใบงานที่ปิดแล้ว/ยกเลิกแล้วย้อนสถานะไม่ได้ (ถ้าบันทึกผิดให้ owner ใช้ void)';
  end if;
  if p_target < 'opened' or p_target >= j.status then
    raise exception 'ต้องย้อนไปยังขั้นก่อนหน้า (ตั้งแต่ "เปิดใบงาน") เท่านั้น';
  end if;
  if exists (select 1 from payments where job_id = j.id and kind = 'payment' and voided_at is null) then
    raise exception 'มีการรับชำระยอดบิลแล้ว — ให้ void รายการชำระก่อนย้อนสถานะ';
  end if;

  update job_orders set
    status = p_target,
    quote_approved_at   = case when p_target <= 'quoting' then null else quote_approved_at end,
    quote_approved_by   = case when p_target <= 'quoting' then null else quote_approved_by end,
    quote_approval_note = case when p_target <= 'quoting' then null else quote_approval_note end,
    qc_passed_at = null, qc_passed_by = null, qc_note = null
  where id = j.id;
  perform _log_status(v_branch, j.id, j.status, p_target, v_reason);
end $$;

create or replace function cancel_job(p_job_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; v_reason text;
begin
  v_reason := _need_reason(p_reason, 'การยกเลิกใบงาน');
  perform set_config('app.audit_reason', v_reason, true);
  j := _lock_job(p_job_id, v_branch);
  if j.status in ('closed', 'cancelled') then raise exception 'ใบงานนี้ปิด/ยกเลิกไปแล้ว'; end if;
  if exists (select 1 from payments where job_id = j.id and voided_at is null) then
    raise exception 'มีรายการรับชำระ/มัดจำอยู่ — ให้ void รายการชำระ (พร้อมคืนเงินลูกค้า) ก่อนยกเลิก';
  end if;
  update job_orders set status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason where id = j.id;
  perform _log_status(v_branch, j.id, j.status, 'cancelled', v_reason);
end $$;

create or replace function void_job(p_job_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner']::user_role[]);
  j job_orders; v_reason text;
begin
  v_reason := _need_reason(p_reason, 'การ void ใบงาน');
  perform set_config('app.audit_reason', v_reason, true);
  j := _lock_job(p_job_id, v_branch);
  if exists (select 1 from payments where job_id = j.id and voided_at is null) then
    raise exception 'ต้อง void รายการชำระทั้งหมดก่อน void ใบงาน';
  end if;
  update receipts set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
   where job_id = j.id and voided_at is null;
  update warranties set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
   where job_id = j.id and voided_at is null;
  update job_orders set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = j.id;
end $$;

-- =====================================================================
-- รับชำระ / void / ปิดงาน
-- =====================================================================
create or replace function record_payment(
  p_job_id uuid, p_kind pay_kind, p_method pay_method, p_amount numeric,
  p_reference text default null, p_slip_path text default null, p_note text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; t record; v_id uuid; v_amt numeric := round(coalesce(p_amount, 0), 2);
begin
  perform set_config('app.audit_reason', '', true);
  j := _lock_job(p_job_id, v_branch);
  if j.status in ('closed', 'cancelled') then raise exception 'ใบงานที่ปิด/ยกเลิกแล้วรับชำระไม่ได้'; end if;
  if v_amt <= 0 then raise exception 'จำนวนเงินต้องมากกว่า 0'; end if;
  if p_kind = 'payment' and j.status <> 'awaiting_payment' then
    raise exception 'รับชำระยอดบิลได้เมื่อใบงานอยู่ในสถานะ "รอชำระ" (ก่อนหน้านั้นรับเป็นมัดจำได้)';
  end if;
  if p_method in ('qr_promptpay', 'transfer') then
    if p_slip_path is null or p_slip_path not like v_branch::text || '/%' then
      raise exception 'รับชำระด้วย QR/โอน ต้องแนบสลิป';
    end if;
  end if;

  select * into t from v_job_totals where job_id = j.id;
  if p_kind = 'payment' and t.paid_total + v_amt > t.grand_total then
    raise exception 'รับเกินยอดค้างชำระ (ค้างอยู่ ฿%)', t.balance;
  end if;
  if p_kind = 'deposit' and t.grand_total > 0 and t.paid_total + v_amt > t.grand_total then
    raise exception 'มัดจำเกินยอดบิล (ยอดบิล ฿%)', t.grand_total;
  end if;

  insert into payments(branch_id, job_id, kind, method, amount, reference_no, slip_path, note)
  values (v_branch, j.id, p_kind, p_method, v_amt, nullif(btrim(coalesce(p_reference, '')), ''),
          p_slip_path, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function void_payment(p_payment_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  v_role user_role := app_role();
  p payments%rowtype; j job_orders; v_reason text;
begin
  v_reason := _need_reason(p_reason, 'การ void รายการชำระ');
  perform set_config('app.audit_reason', v_reason, true);
  select * into p from payments where id = p_payment_id and branch_id = v_branch for update;
  if not found then raise exception 'ไม่พบรายการชำระ'; end if;
  if p.voided_at is not null then raise exception 'รายการนี้ถูก void ไปแล้ว'; end if;
  j := _lock_job(p.job_id, v_branch);
  if j.status = 'closed' and v_role <> 'owner' then
    raise exception 'ใบงานปิดแล้ว — เฉพาะเจ้าของเท่านั้นที่ void รายการชำระได้';
  end if;
  update payments set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = p.id;
end $$;

create or replace function close_job(p_job_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; t record; s branch_settings%rowtype; c customers%rowtype; v vehicles%rowtype;
  v_rc uuid; v_no text; v_missing text[]; l record; v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  perform set_config('app.audit_reason', 'ปิดงาน', true);
  j := _lock_job(p_job_id, v_branch);
  if j.status <> 'awaiting_payment' then raise exception 'ปิดงานได้เฉพาะใบงานที่อยู่ในสถานะ "รอชำระ"'; end if;
  if j.qc_passed_at is null then raise exception 'ปิดงานไม่ได้ — ยังไม่ผ่าน QC'; end if;
  v_missing := _job_missing_checks(j.id);
  if cardinality(v_missing) > 0 then raise exception 'เช็คสภาพรถไม่ครบ: %', array_to_string(v_missing, ', '); end if;
  if job_discount_blocked(j.id) then raise exception 'มีส่วนลดเกินเพดานที่เจ้าของยังไม่อนุมัติ'; end if;

  select * into t from v_job_totals where job_id = j.id;
  if t.net < 0 then raise exception 'ส่วนลดรวมเกินยอดรายการ'; end if;
  if t.paid_total < t.grand_total then
    raise exception 'ปิดงานไม่ได้ — รับเงินยังไม่ครบ (ค้างชำระ ฿%)', t.balance;
  end if;
  if t.paid_total > t.grand_total then
    raise exception 'ยอดรับชำระเกินยอดบิล ฿% — ให้ void รายการชำระที่เกิน', (t.paid_total - t.grand_total);
  end if;

  select * into s from branch_settings where branch_id = v_branch;
  select * into c from customers where id = j.customer_id;
  select * into v from vehicles where id = j.vehicle_id;
  v_no := next_doc_no(v_branch, 'receipt', 'RC');

  insert into receipts(branch_id, job_id, receipt_no, subtotal, discount_total, vat_amount, grand_total, snapshot)
  values (v_branch, j.id, v_no, t.gross, t.discount, t.vat, t.grand_total,
    jsonb_build_object(
      'shop', jsonb_build_object('name', s.shop_name, 'address', s.shop_address, 'phone', s.shop_phone,
                                 'tax_id', s.tax_id, 'footer', s.receipt_footer),
      'job', jsonb_build_object('job_no', j.job_no, 'odometer', j.odometer, 'opened_at', j.opened_at, 'closed_at', now()),
      'customer', jsonb_build_object('name', c.name, 'phone', c.phone),
      'vehicle', jsonb_build_object('plate', v.plate, 'province', v.plate_province, 'brand', v.brand,
                                    'model', v.model, 'year', v.year),
      'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                  'code', i.item_code, 'name', i.item_name, 'variant', i.variant_label, 'type', i.item_type,
                  'qty', i.qty, 'unit_price', i.unit_price, 'line_total', i.line_total,
                  'is_header', i.is_bundle_header, 'is_child', i.parent_id is not null,
                  'attributes', i.attributes, 'warranty_months', i.warranty_months, 'reason', i.price_reason)
                  order by i.sort_order), '[]'::jsonb) from job_items i where i.job_id = j.id),
      'payments', (select coalesce(jsonb_agg(jsonb_build_object(
                  'kind', p.kind, 'method', p.method, 'amount', p.amount, 'reference_no', p.reference_no,
                  'received_at', p.received_at) order by p.received_at), '[]'::jsonb)
                  from payments p where p.job_id = j.id and p.voided_at is null),
      'totals', jsonb_build_object('gross', t.gross, 'discount', t.discount, 'net', t.net,
                                   'vat_enabled', j.vat_enabled, 'vat_rate', j.vat_rate, 'vat', t.vat,
                                   'grand_total', t.grand_total, 'paid_total', t.paid_total)))
  returning id into v_rc;

  -- ใบรับประกันอัตโนมัติ ตาม warranty_months ของแต่ละรายการ
  for l in
    select * from job_items
     where job_id = j.id and not is_bundle_header and item_type <> 'discount' and warranty_months is not null
     order by sort_order
  loop
    insert into warranties(branch_id, job_id, job_item_id, receipt_id, customer_id, vehicle_id, warranty_no,
                           item_name, variant_label, attributes, warranty_months, starts_on, ends_on)
    values (v_branch, j.id, l.id, v_rc, j.customer_id, j.vehicle_id, next_doc_no(v_branch, 'warranty', 'WR'),
            l.item_name, l.variant_label, l.attributes, l.warranty_months, v_today,
            (v_today + make_interval(months => l.warranty_months))::date);
  end loop;

  update job_orders set status = 'closed', closed_at = now(), closed_by = auth.uid() where id = j.id;
  perform _log_status(v_branch, j.id, j.status, 'closed', 'ปิดงาน ออกใบเสร็จ ' || v_no);
  return v_rc;
end $$;

-- =====================================================================
-- แคตตาล็อก (owner) + รายงาน
-- =====================================================================
create or replace function catalog_create_item(
  p_category_id uuid, p_name text, p_item_type item_type,
  p_requires_check boolean default false, p_template_id uuid default null,
  p_crew_size int default 1, p_labor_rate numeric default 0, p_warranty_months int default null,
  p_unit text default null, p_attribute_schema text[] default '{}', p_with_matrix boolean default false
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner']::user_role[]);
  cat catalog_categories%rowtype; v_n int; v_id uuid; v_code text;
begin
  perform set_config('app.audit_reason', 'เพิ่มรายการแคตตาล็อก', true);
  select * into cat from catalog_categories where id = p_category_id and branch_id = v_branch and parent_id is not null;
  if not found then raise exception 'ต้องเลือกหมวดย่อย'; end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'กรุณากรอกชื่อรายการ'; end if;

  perform pg_advisory_xact_lock(hashtext('catalog_item_code:' || p_category_id::text));
  select coalesce(max(right(code, 3)::int), 0) + 1 into v_n from catalog_items where category_id = cat.id;
  if v_n > 999 then raise exception 'หมวดนี้เต็มแล้ว (999 รายการ)'; end if;
  v_code := cat.code || '-' || lpad(v_n::text, 3, '0');

  insert into catalog_items(branch_id, category_id, code, name, item_type, unit, requires_condition_check,
                            condition_template_id, crew_size, labor_rate, warranty_months, attribute_schema, sort_order)
  values (v_branch, cat.id, v_code, btrim(p_name), p_item_type, p_unit, coalesce(p_requires_check, false),
          p_template_id, coalesce(p_crew_size, 1), coalesce(p_labor_rate, 0), p_warranty_months,
          coalesce(p_attribute_schema, '{}'), v_n)
  returning id into v_id;

  if p_with_matrix then
    insert into item_prices(branch_id, item_id, position, vehicle_size)
    select v_branch, v_id, pos, sz
      from unnest(enum_range(null::film_position)) pos
      cross join unnest(enum_range(null::vehicle_size)) sz;
  else
    insert into item_prices(branch_id, item_id) values (v_branch, v_id);
  end if;
  return v_id;
end $$;

create or replace function report_revenue(p_from date, p_to date)
returns table (main_code text, main_name text, sub_code text, sub_name text, line_type item_type,
               line_count bigint, revenue numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner']::user_role[]);
begin
  return query
  select m.code, m.name, s.code, s.name, i.item_type, count(*), sum(i.line_total)
    from job_orders j
    join job_items i on i.job_id = j.id
    join catalog_categories s on s.id = i.category_id
    join catalog_categories m on m.id = s.parent_id
   where j.branch_id = v_branch and j.status = 'closed' and j.voided_at is null
     and not i.is_bundle_header
     and (j.closed_at at time zone 'Asia/Bangkok')::date between p_from and p_to
   group by m.code, m.name, s.code, s.name, i.item_type
   order by m.code, s.code, i.item_type;
end $$;

-- =====================================================================
-- สิทธิ์ execute: เปิดเฉพาะ authenticated ; ฟังก์ชันภายใน/trigger ปิดไว้
-- =====================================================================
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
         'catalog_items_validate', 'bundle_components_validate'))
  loop
    execute format('revoke execute on function %s from authenticated', r.sig);
  end loop;
end $$;
