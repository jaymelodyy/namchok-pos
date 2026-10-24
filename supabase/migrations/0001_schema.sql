-- =====================================================================
-- นำโชคออโต้แอร์ สาขานาทวี — POS + Job Order
-- 0001_schema.sql  (เฟส 1: MVP)
-- ต้องการ PostgreSQL 15+ (ใช้ security_invoker view) — Supabase ใช้ได้
-- =====================================================================

-- ---------- ENUMS ----------
create type user_role     as enum ('owner', 'admin', 'technician', 'warehouse');
create type item_type     as enum ('service', 'part', 'bundle', 'fee', 'discount');
-- ลำดับ enum = ลำดับ state machine (เปรียบเทียบด้วย < > ได้) ; cancelled อยู่ท้ายสุด
create type job_status    as enum (
  'booked',            -- จองคิว
  'opened',            -- เปิดใบงาน (Walk-in เริ่มที่นี่)
  'condition_check',   -- เช็คสภาพรถ
  'quoting',           -- เสนอราคา / รอลูกค้าอนุมัติ
  'requisition',       -- เบิกอะไหล่
  'ready',             -- พร้อมทำ (รอช่างรับ)
  'in_progress',       -- กำลังทำ
  'qc',                -- รอ QC
  'awaiting_payment',  -- รอชำระ
  'closed',            -- ปิดงาน
  'cancelled'          -- ยกเลิก
);
create type job_source    as enum ('walk_in', 'line', 'messenger', 'facebook_ads', 'returning');
create type pay_method    as enum ('qr_promptpay', 'cash', 'transfer');
create type pay_kind      as enum ('deposit', 'payment');
create type vehicle_size  as enum ('sedan', 'suv', 'pickup_cab', 'pickup_4door', 'van');
create type film_position as enum ('full', 'front', 'side', 'rear', 'roof');

-- ---------- COMMON TRIGGER FUNCTIONS ----------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function forbid_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'ห้ามลบข้อมูล (% ) — ให้ใช้ void พร้อมเหตุผลแทน', tg_table_name;
end $$;

create or replace function forbid_update() returns trigger
language plpgsql as $$
begin
  raise exception 'ตาราง % แก้ไขย้อนหลังไม่ได้', tg_table_name;
end $$;

-- ---------- BRANCHES / SETTINGS / USERS ----------
create table branches (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  address     text,
  phone       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

create table branch_settings (
  branch_id            uuid primary key references branches(id),
  shop_name            text not null default 'นำโชคออโต้แอร์',
  shop_address         text,
  shop_phone           text,
  tax_id               text,
  vat_enabled          boolean not null default false,          -- ค่าเริ่มต้น: ปิด
  vat_rate             numeric(5,2) not null default 7.00 check (vat_rate between 0 and 30),
  discount_cap_percent numeric(5,2) not null default 0 check (discount_cap_percent between 0 and 100),
  receipt_footer       text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid default auth.uid()
);

create or replace function branches_create_settings() returns trigger
language plpgsql as $$
begin
  insert into branch_settings(branch_id, shop_name, shop_address, shop_phone)
  values (new.id, new.name, new.address, new.phone)
  on conflict do nothing;
  return new;
end $$;
create trigger trg_branches_settings after insert on branches
  for each row execute function branches_create_settings();

create table users (
  id          uuid primary key references auth.users(id),
  branch_id   uuid not null references branches(id),
  full_name   text not null,
  role        user_role not null,
  phone       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
create index users_branch_idx on users(branch_id);

-- ---------- CUSTOMERS / VEHICLES ----------
create table customers (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branches(id),
  name        text not null,
  phone       text,
  line_id     text,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
create index customers_phone_idx on customers(branch_id, phone);

create table vehicles (
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid not null references branches(id),
  plate          text not null,
  plate_province text,
  plate_norm     text generated always as (upper(regexp_replace(plate, '[\s\.\-]', '', 'g'))) stored,
  brand          text,
  model          text,
  year           int check (year between 1950 and 2100),
  customer_id    uuid references customers(id),
  last_odometer  int check (last_odometer >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  check (length(btrim(plate)) > 0)
);
create unique index vehicles_plate_uk on vehicles(branch_id, plate_norm, (coalesce(plate_province, '')));
create index vehicles_plate_search on vehicles(branch_id, plate_norm text_pattern_ops);

-- ---------- CATALOG ----------
create table catalog_categories (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branches(id),
  code        text not null,
  name        text not null,
  parent_id   uuid references catalog_categories(id),
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  unique (branch_id, code),
  check ((parent_id is null and code ~ '^[A-Z]{2}$')
      or (parent_id is not null and code ~ '^[A-Z]{2}-[A-Z]{2}$'))
);
-- ห้ามชื่อซ้ำในระดับเดียวกัน (หมวดหลักด้วยกัน / หมวดย่อยใต้หมวดหลักเดียวกัน)
create unique index catalog_categories_name_uk on catalog_categories
  (branch_id, (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)), lower(btrim(name)));

create table condition_templates (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branches(id),
  code        text not null,
  name        text not null,
  is_default  boolean not null default false,            -- ใช้กับทุกคัน
  checklist   jsonb not null default '[]'::jsonb,         -- [{key,label,required}]
  min_photos  int not null default 1 check (min_photos >= 0),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  unique (branch_id, code),
  check (jsonb_typeof(checklist) = 'array')
);
create unique index condition_templates_one_default on condition_templates(branch_id) where is_default;

create table catalog_items (
  id                       uuid primary key default gen_random_uuid(),
  branch_id                uuid not null references branches(id),
  category_id              uuid not null references catalog_categories(id),   -- 1 รายการ = 1 หมวดย่อย
  code                     text not null,
  name                     text not null,
  item_type                item_type not null,
  unit                     text,
  requires_condition_check boolean not null default false,
  condition_template_id    uuid references condition_templates(id),
  crew_size                int not null default 1 check (crew_size between 1 and 10),
  labor_rate               numeric(12,2) not null default 0 check (labor_rate >= 0),
  warranty_months          int check (warranty_months is null or warranty_months > 0),  -- ว่าง = ไม่มีประกัน (owner กรอกเอง)
  attribute_schema         text[] not null default '{}',   -- ฟิลด์ที่ต้องบันทึกตอนใส่ใบงาน เช่น ยี่ห้อ/รุ่น/ขนาด
  note                     text,
  sort_order               int not null default 0,
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid default auth.uid(),
  unique (branch_id, code),
  check (code ~ '^[A-Z]{2}-[A-Z]{2}-[0-9]{3}$'),
  check (not requires_condition_check or condition_template_id is not null)
);
create unique index catalog_items_name_uk on catalog_items(branch_id, category_id, lower(btrim(name)));
create index catalog_items_category_idx on catalog_items(category_id);

create table item_prices (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  item_id       uuid not null references catalog_items(id),
  position      film_position,
  vehicle_size  vehicle_size,
  label         text,
  price         numeric(12,2) not null default 0 check (price >= 0),
  cost          numeric(12,2) not null default 0 check (cost >= 0),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);
-- 1 รายการ มีตัวเลือกราคาซ้ำ (ตำแหน่ง × ขนาด) ไม่ได้ ; NULL นับเป็นค่าเดียวกัน (ต้องใช้ PG15+)
create unique index item_prices_variant_uk on item_prices (item_id, position, vehicle_size) nulls not distinct;

create table catalog_bundle_components (
  id                 uuid primary key default gen_random_uuid(),
  branch_id          uuid not null references branches(id),
  bundle_item_id     uuid not null references catalog_items(id),
  component_item_id  uuid not null references catalog_items(id),
  qty                numeric(10,2) not null default 1 check (qty > 0),
  unit_price         numeric(12,2) not null default 0 check (unit_price >= 0),  -- ราคาที่จัดสรรให้ชิ้นนี้ในชุด
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid default auth.uid(),
  unique (bundle_item_id, component_item_id)
);

create or replace function variant_label(p_pos film_position, p_size vehicle_size) returns text
language sql immutable as $$
  select case
    when p_pos is null and p_size is null then 'มาตรฐาน'
    else concat_ws(' · ',
      case p_pos when 'full' then 'ทั้งคัน' when 'front' then 'กระจกหน้า' when 'side' then 'กระจกข้าง'
                 when 'rear' then 'กระจกหลัง' when 'roof' then 'หลังคา' end,
      case p_size when 'sedan' then 'เก๋ง' when 'suv' then 'SUV' when 'pickup_cab' then 'กระบะแค็บ'
                  when 'pickup_4door' then 'กระบะ 4 ประตู' when 'van' then 'ตู้-แวน' end)
  end
$$;

create or replace function item_prices_fill() returns trigger
language plpgsql as $$
begin
  if new.label is null or btrim(new.label) = '' then
    new.label := variant_label(new.position, new.vehicle_size);
  end if;
  return new;
end $$;
create trigger trg_item_prices_fill before insert or update on item_prices
  for each row execute function item_prices_fill();

-- ---- กฎหมวดหมู่: ห้ามมั่ว ห้ามซ้ำ ----
create or replace function catalog_categories_validate() returns trigger
language plpgsql as $$
declare v_parent catalog_categories%rowtype;
begin
  if tg_op = 'UPDATE' and new.code <> old.code then
    raise exception 'ห้ามแก้รหัสหมวด (%)', old.code;
  end if;
  if new.parent_id is not null then
    select * into v_parent from catalog_categories where id = new.parent_id;
    if not found then raise exception 'ไม่พบหมวดหลัก'; end if;
    if v_parent.parent_id is not null then raise exception 'หมวดย่อยต้องอยู่ใต้หมวดหลักเท่านั้น'; end if;
    if v_parent.branch_id <> new.branch_id then raise exception 'หมวดหลักอยู่คนละสาขา'; end if;
    if new.code not like v_parent.code || '-%' then
      raise exception 'รหัสหมวดย่อยต้องขึ้นต้นด้วย %-', v_parent.code;
    end if;
  end if;
  return new;
end $$;
create trigger trg_catalog_categories_validate before insert or update on catalog_categories
  for each row execute function catalog_categories_validate();

create or replace function catalog_items_validate() returns trigger
language plpgsql as $$
declare v_cat catalog_categories%rowtype; v_main text;
begin
  if tg_op = 'UPDATE' then
    if new.code <> old.code then raise exception 'ห้ามแก้รหัสรายการ (%)', old.code; end if;
    if new.category_id <> old.category_id then
      raise exception 'ย้ายหมวดไม่ได้ (1 รายการอยู่ได้ 1 หมวดย่อย) — ให้สร้างรายการใหม่แทน';
    end if;
    if new.item_type <> old.item_type then raise exception 'เปลี่ยนประเภทรายการไม่ได้'; end if;
  end if;

  select * into v_cat from catalog_categories where id = new.category_id;
  if not found then raise exception 'ไม่พบหมวด'; end if;
  if v_cat.parent_id is null then raise exception 'ต้องเลือกหมวดย่อย (ไม่ใช่หมวดหลัก)'; end if;
  if v_cat.branch_id <> new.branch_id then raise exception 'หมวดอยู่คนละสาขา'; end if;
  if new.code not like v_cat.code || '-%' then
    raise exception 'รหัสรายการ % ไม่ตรงกับหมวดย่อย %', new.code, v_cat.code;
  end if;

  select code into v_main from catalog_categories where id = v_cat.parent_id;
  if v_cat.code = 'OT-DP' then
    raise exception 'มัดจำบันทึกเป็นรายการชำระ (kind = deposit) ไม่ใช่รายการสินค้า/บริการ';
  elsif v_cat.code = 'OT-FE' and new.item_type <> 'fee' then
    raise exception 'หมวด OT-FE รับเฉพาะประเภท fee';
  elsif v_cat.code = 'OT-DC' and new.item_type <> 'discount' then
    raise exception 'หมวด OT-DC รับเฉพาะประเภท discount';
  elsif v_main = 'PT' and new.item_type <> 'part' then
    raise exception 'หมวด PT (อะไหล่/วัสดุ) รับเฉพาะประเภท part — ค่าแรงต้องอยู่คนละบรรทัดในหมวดบริการ';
  elsif v_main in ('AC', 'FM', 'BT') and new.item_type not in ('service', 'bundle') then
    raise exception 'หมวด % รับเฉพาะ service หรือ bundle (อะไหล่ให้ไปอยู่หมวด PT)', v_main;
  end if;
  return new;
end $$;
create trigger trg_catalog_items_validate before insert or update on catalog_items
  for each row execute function catalog_items_validate();

create or replace function bundle_components_validate() returns trigger
language plpgsql as $$
declare v_b item_type; v_c item_type;
begin
  select item_type into v_b from catalog_items where id = new.bundle_item_id;
  select item_type into v_c from catalog_items where id = new.component_item_id;
  if v_b is distinct from 'bundle' then raise exception 'รายการแม่ต้องเป็นประเภท bundle'; end if;
  if v_c not in ('service', 'part', 'fee') then
    raise exception 'ส่วนประกอบของ bundle ต้องเป็น service / part / fee เท่านั้น';
  end if;
  return new;
end $$;
create trigger trg_bundle_components_validate before insert or update on catalog_bundle_components
  for each row execute function bundle_components_validate();

-- ---------- JOB ORDERS ----------
create table doc_counters (
  branch_id  uuid not null references branches(id),
  doc_type   text not null,
  period     text not null,
  last_no    int  not null default 0,
  primary key (branch_id, doc_type, period)
);

create table job_orders (
  id                   uuid primary key default gen_random_uuid(),
  branch_id            uuid not null references branches(id),
  job_no               text not null,
  status               job_status not null default 'opened',
  customer_id          uuid not null references customers(id),
  vehicle_id           uuid not null references vehicles(id),
  odometer             int check (odometer >= 0),
  source               job_source not null default 'walk_in',
  complaint            text,
  scheduled_at         timestamptz,
  opened_at            timestamptz,
  quote_approved_at    timestamptz,
  quote_approved_by    uuid,
  quote_approval_note  text,
  qc_passed_at         timestamptz,
  qc_passed_by         uuid,
  qc_note              text,
  closed_at            timestamptz,
  closed_by            uuid,
  cancelled_at         timestamptz,
  cancel_reason        text,
  vat_enabled          boolean not null default false,
  vat_rate             numeric(5,2) not null default 7.00,
  voided_at            timestamptz,
  voided_by            uuid,
  void_reason          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid default auth.uid(),
  unique (branch_id, job_no),
  check (voided_at is null or void_reason is not null)
);
create index job_orders_status_idx  on job_orders(branch_id, status) where voided_at is null;
create index job_orders_vehicle_idx on job_orders(vehicle_id, created_at desc);
create index job_orders_customer_idx on job_orders(customer_id);

create table job_status_log (
  id          bigint generated always as identity primary key,
  branch_id   uuid not null references branches(id),
  job_id      uuid not null references job_orders(id),
  from_status job_status,
  to_status   job_status not null,
  reason      text,
  actor       uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index job_status_log_job_idx on job_status_log(job_id, created_at);

create table job_items (
  id                       uuid primary key default gen_random_uuid(),
  branch_id                uuid not null references branches(id),
  job_id                   uuid not null references job_orders(id),
  parent_id                uuid references job_items(id),           -- บรรทัดย่อยของ bundle
  catalog_item_id          uuid references catalog_items(id),
  price_id                 uuid references item_prices(id),
  category_id              uuid references catalog_categories(id), -- หมวดย่อย (snapshot)
  item_code                text not null,
  item_name                text not null,
  variant_label            text,
  item_type                item_type not null,
  is_bundle_header         boolean not null default false,
  qty                      numeric(10,2) not null default 1 check (qty > 0),
  unit_price               numeric(12,2) not null default 0,         -- ส่วนลดเก็บเป็นค่าติดลบ
  list_price               numeric(12,2),                            -- ราคาในแคตตาล็อกตอนเพิ่ม
  cost                     numeric(12,2) not null default 0,
  price_reason             text,
  labor_rate               numeric(12,2) not null default 0,
  crew_size                int not null default 1,
  warranty_months          int,
  requires_condition_check boolean not null default false,
  condition_template_id    uuid references condition_templates(id),
  attributes               jsonb not null default '{}'::jsonb,
  owner_approved_at        timestamptz,                              -- ใช้กับบรรทัดส่วนลด
  owner_approved_by        uuid,
  sort_order               int not null default 0,
  line_total               numeric(14,2) generated always as (round(qty * unit_price, 2)) stored,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid default auth.uid(),
  check ((item_type = 'discount' and unit_price <= 0) or (item_type <> 'discount' and unit_price >= 0))
);
create index job_items_job_idx on job_items(job_id, sort_order);

-- ---------- CONDITION CHECKS ----------
create table condition_checks (
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid not null references branches(id),
  job_id         uuid not null references job_orders(id),
  template_id    uuid not null references condition_templates(id),
  answers        jsonb not null default '{}'::jsonb,   -- { key: { state: ok|defect|na, note } }
  note           text,
  signature_path text,
  signed_by_name text,
  signed_at      timestamptz,
  completed_at   timestamptz,
  completed_by   uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  unique (job_id, template_id)
);

create table condition_check_photos (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches(id),
  check_id     uuid not null references condition_checks(id),
  storage_path text not null,
  caption      text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid default auth.uid()
);
create index condition_check_photos_idx on condition_check_photos(check_id);

-- ---------- PAYMENTS / RECEIPTS / WARRANTIES ----------
create table payments (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches(id),
  job_id       uuid not null references job_orders(id),
  kind         pay_kind not null,
  method       pay_method not null,
  amount       numeric(12,2) not null check (amount > 0),
  reference_no text,
  slip_path    text,
  note         text,
  received_at  timestamptz not null default now(),
  received_by  uuid default auth.uid(),
  voided_at    timestamptz,
  voided_by    uuid,
  void_reason  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  check (voided_at is null or void_reason is not null)
);
create index payments_job_idx on payments(job_id);

create table receipts (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches(id),
  job_id       uuid not null unique references job_orders(id),
  receipt_no   text not null,
  issued_at    timestamptz not null default now(),
  issued_by    uuid default auth.uid(),
  subtotal     numeric(14,2) not null,
  discount_total numeric(14,2) not null,
  vat_amount   numeric(14,2) not null,
  grand_total  numeric(14,2) not null,
  snapshot     jsonb not null,
  voided_at    timestamptz,
  voided_by    uuid,
  void_reason  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  unique (branch_id, receipt_no),
  check (voided_at is null or void_reason is not null)
);

create table warranties (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references branches(id),
  job_id          uuid not null references job_orders(id),
  job_item_id     uuid not null references job_items(id),
  receipt_id      uuid references receipts(id),
  customer_id     uuid not null references customers(id),
  vehicle_id      uuid not null references vehicles(id),
  warranty_no     text not null,
  item_name       text not null,
  variant_label   text,
  attributes      jsonb not null default '{}'::jsonb,
  warranty_months int not null check (warranty_months > 0),
  starts_on       date not null,
  ends_on         date not null,
  voided_at       timestamptz,
  voided_by       uuid,
  void_reason     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  unique (branch_id, warranty_no)
);
create index warranties_vehicle_idx on warranties(vehicle_id);
create index warranties_ends_idx on warranties(branch_id, ends_on) where voided_at is null;

-- ---------- AUDIT LOG ----------
create table audit_logs (
  id          bigint generated always as identity primary key,
  branch_id   uuid,
  table_name  text not null,
  record_id   uuid,
  action      text not null,
  old_data    jsonb,
  new_data    jsonb,
  reason      text,
  actor       uuid,
  created_at  timestamptz not null default now()
);
create index audit_logs_record_idx on audit_logs(table_name, record_id, created_at);
create index audit_logs_branch_idx on audit_logs(branch_id, created_at desc);

create or replace function audit_row() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old jsonb; v_new jsonb; v_row jsonb; v_branch uuid; v_id uuid;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new); v_row := v_new;
  elsif tg_op = 'UPDATE' then
    v_new := to_jsonb(new); v_old := to_jsonb(old); v_row := v_new;
    if (v_new - 'updated_at') = (v_old - 'updated_at') then return null; end if;
  else
    v_old := to_jsonb(old); v_row := v_old;
  end if;
  v_branch := coalesce((v_row ->> 'branch_id')::uuid,
                       case when tg_table_name = 'branches' then (v_row ->> 'id')::uuid end);
  v_id := (v_row ->> 'id')::uuid;
  insert into audit_logs(branch_id, table_name, record_id, action, old_data, new_data, reason, actor)
  values (v_branch, tg_table_name, v_id, tg_op, v_old, v_new,
          nullif(current_setting('app.audit_reason', true), ''), auth.uid());
  return null;
end $$;

-- ---------- ผูก trigger ----------
do $$
declare t text;
begin
  -- updated_at
  foreach t in array array['branches','branch_settings','users','customers','vehicles','catalog_categories',
    'condition_templates','catalog_items','item_prices','catalog_bundle_components','job_orders','job_items',
    'condition_checks','condition_check_photos','payments','receipts','warranties'] loop
    execute format('create trigger trg_%1$s_updated before update on %1$I for each row execute function set_updated_at()', t);
  end loop;
  -- audit
  foreach t in array array['branches','branch_settings','users','customers','vehicles','catalog_categories',
    'condition_templates','catalog_items','item_prices','catalog_bundle_components','job_orders','job_items',
    'condition_checks','condition_check_photos','payments','receipts','warranties'] loop
    execute format('create trigger trg_%1$s_audit after insert or update or delete on %1$I for each row execute function audit_row()', t);
  end loop;
  -- ห้ามลบ (void เท่านั้น)
  foreach t in array array['job_orders','payments','receipts','warranties','condition_checks',
    'condition_check_photos','customers','vehicles','catalog_categories','catalog_items','item_prices',
    'users','branches','audit_logs','job_status_log'] loop
    execute format('create trigger trg_%1$s_nodelete before delete on %1$I for each row execute function forbid_delete()', t);
  end loop;
end $$;

create trigger trg_audit_logs_noupdate before update on audit_logs
  for each row execute function forbid_update();
create trigger trg_job_status_log_noupdate before update on job_status_log
  for each row execute function forbid_update();
