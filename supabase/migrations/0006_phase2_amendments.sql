-- =====================================================================
-- 0006 — เฟส 2: ปรับกติกาเฟส 1 ตามคำตอบของ Jay + ขั้นตอนคืนเงิน
--   1) VAT "รวมในราคา" (เดิม: บวกเพิ่มนอกราคา) : ยอดชำระ = ยอดสุทธิหลังส่วนลด ; VAT = ส่วนที่รวมอยู่ในยอดนั้น
--   2) ใบรับประกันนับจาก "วันที่ส่งมอบ" (job_orders.delivered_on) ไม่ใช่วันปิดงาน
--   3) คืนเงิน/คืนมัดจำ (ตาราง refunds) — เหตุผลบังคับ, QR/โอนต้องแนบสลิปโอนออก, ไม่ลบ (void เท่านั้น)
--   4) hook ภายใน (_on_job_*) ให้ migration ถัดไปต่อยอดโดยไม่ต้องก๊อป RPC ทั้งตัว
--   5) job_orders.status_changed_at (ใช้แสดงอายุของงานในแต่ละขั้นบน Job Board)
-- =====================================================================

-- ---------- คอลัมน์ใหม่ ----------
alter table job_orders add column delivered_on date;
alter table job_orders add column status_changed_at timestamptz not null default now();
update job_orders set status_changed_at = coalesce(closed_at, updated_at);

create or replace function job_orders_stamp_status() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then new.status_changed_at := now(); end if;
  return new;
end $$;
create trigger trg_job_orders_stamp_status before update on job_orders
  for each row execute function job_orders_stamp_status();

-- ---------- ตาราง refunds ----------
create table refunds (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  job_id        uuid not null references job_orders(id),
  method        pay_method not null,
  amount        numeric(12,2) not null check (amount > 0),
  reason        text not null check (length(btrim(reason)) > 0),
  reference_no  text,
  slip_path     text,                                  -- สลิปโอนเงินคืน (บังคับเมื่อคืนด้วย QR/โอน)
  refunded_at   timestamptz not null default now(),
  refunded_by   uuid default auth.uid(),
  voided_at     timestamptz,
  voided_by     uuid,
  void_reason   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  check (voided_at is null or void_reason is not null)
);
create index refunds_job_idx on refunds(job_id);

create trigger trg_refunds_updated before update on refunds for each row execute function set_updated_at();
create trigger trg_refunds_audit   after insert or update or delete on refunds for each row execute function audit_row();
create trigger trg_refunds_nodelete before delete on refunds for each row execute function forbid_delete();

alter table refunds enable row level security;
revoke all on refunds from anon, authenticated;
grant select on refunds to authenticated;
create policy refunds_select on refunds for select to authenticated
  using (branch_id = app_branch_id() and app_role() in ('owner', 'admin'));

-- ---------- ยอดรวม: VAT รวมในราคา + หักคืนเงิน ----------
--   net         = รายการ − ส่วนลด (ราคาที่ลูกค้าจ่ายจริง และรวม VAT แล้วถ้าเปิด VAT)
--   vat         = ส่วนที่เป็น VAT อยู่ในยอด net = net × rate / (100 + rate)   (0 ถ้าปิด VAT)
--   grand_total = net                (เดิมคือ net + vat)
--   paid_total  = รับชำระ − คืนเงิน (ไม่นับที่ void)
--   ex_vat      = net − vat          (มูลค่าก่อน VAT)
create or replace view v_job_totals with (security_invoker = true) as
select t.job_id, t.branch_id, t.gross, t.discount, t.net, t.vat,
       t.net as grand_total,
       t.paid_total,
       (t.net - t.paid_total) as balance,
       case when t.paid_total <= 0 then 'unpaid'
            when t.paid_total < t.net then 'partial'
            else 'paid' end as payment_status,
       (t.net - t.vat) as ex_vat,
       t.refunded_total
from (
  select j.id as job_id, j.branch_id, l.gross, l.discount,
         (l.gross - l.discount) as net,
         case when j.vat_enabled and (l.gross - l.discount) > 0
              then round((l.gross - l.discount) * j.vat_rate / (100 + j.vat_rate), 2)
              else 0::numeric end as vat,
         (p.paid_total - r.refunded_total) as paid_total,
         r.refunded_total
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
  cross join lateral (
    select coalesce(sum(rf.amount), 0) as refunded_total
    from refunds rf where rf.job_id = j.id and rf.voided_at is null
  ) r
) t;
grant select on v_job_totals to authenticated;

-- v_jobs : คอลัมน์เดิมคงลำดับไว้ แล้วต่อท้ายคอลัมน์ใหม่ของเฟส 2 (เวลาเข้าสถานะ/วันส่งมอบ/ราคาก่อน VAT/ยอดคืนเงิน)
create or replace view v_jobs with (security_invoker = true) as
select j.id, j.branch_id, j.job_no, j.status, j.source, j.complaint, j.odometer,
       j.scheduled_at, j.opened_at, j.created_at, j.updated_at,
       j.quote_approved_at, j.qc_passed_at, j.closed_at, j.voided_at, j.cancel_reason,
       j.customer_id, c.name as customer_name, c.phone as customer_phone,
       j.vehicle_id, v.plate, v.plate_province, v.brand, v.model, v.year,
       t.gross, t.discount, t.net, t.vat, t.grand_total, t.paid_total, t.balance, t.payment_status,
       j.status_changed_at, j.delivered_on, t.ex_vat, t.refunded_total
from job_orders j
join customers c on c.id = j.customer_id
join vehicles v  on v.id = j.vehicle_id
join v_job_totals t on t.job_id = j.id;
grant select on v_jobs to authenticated;

-- ---------- hook ภายใน (ว่างไว้ก่อน — 0007/0008 ต่อยอด) ----------
create or replace function _on_job_closed(p_job uuid, p_branch uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$ begin null; end $$;
create or replace function _on_job_voided(p_job uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$ begin null; end $$;
create or replace function _on_job_cancelled(p_job uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$ begin null; end $$;
create or replace function _on_job_reverted(p_job uuid, p_from job_status, p_to job_status, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$ begin null; end $$;
create or replace function _on_quote_approved(p_job uuid, p_branch uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$ begin null; end $$;

-- ---------- approve_quote / revert_job / cancel_job / void_job : เรียก hook ----------
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
  perform _on_quote_approved(j.id, v_branch);
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
  perform _on_job_reverted(j.id, j.status, p_target, v_reason);
end $$;

create or replace function cancel_job(p_job_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; v_reason text; v_paid numeric;
begin
  v_reason := _need_reason(p_reason, 'การยกเลิกใบงาน');
  perform set_config('app.audit_reason', v_reason, true);
  j := _lock_job(p_job_id, v_branch);
  if j.status in ('closed', 'cancelled') then raise exception 'ใบงานนี้ปิด/ยกเลิกไปแล้ว'; end if;
  select paid_total into v_paid from v_job_totals where job_id = j.id;
  if v_paid > 0 then
    raise exception 'ยังมียอดรับชำระคงเหลือ ฿% — ให้ "คืนเงิน" ลูกค้าให้ครบ (หรือ void รายการชำระที่บันทึกผิด) ก่อนยกเลิก', v_paid;
  end if;
  update job_orders set status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason where id = j.id;
  perform _log_status(v_branch, j.id, j.status, 'cancelled', v_reason);
  perform _on_job_cancelled(j.id, v_reason);
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
  if exists (select 1 from payments where job_id = j.id and voided_at is null)
     or exists (select 1 from refunds where job_id = j.id and voided_at is null) then
    raise exception 'ต้อง void รายการชำระ/คืนเงินทั้งหมดก่อน void ใบงาน';
  end if;
  update receipts set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
   where job_id = j.id and voided_at is null;
  update warranties set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
   where job_id = j.id and voided_at is null;
  update job_orders set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = j.id;
  perform _on_job_voided(j.id, v_reason);
end $$;

-- void การรับชำระ: ห้ามทำให้ยอดสุทธิที่รับไว้ติดลบ (ต้อง void การคืนเงินที่ผูกอยู่ก่อน)
create or replace function void_payment(p_payment_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  v_role user_role := app_role();
  p payments%rowtype; j job_orders; v_reason text; v_paid numeric;
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
  select paid_total into v_paid from v_job_totals where job_id = j.id;
  if v_paid - p.amount < 0 then
    raise exception 'void รายการนี้แล้วยอดรับสุทธิจะติดลบ — มีการคืนเงินที่อ้างอิงอยู่ ให้ owner void รายการคืนเงินก่อน';
  end if;
  update payments set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = p.id;
end $$;

-- ---------- คืนเงิน / คืนมัดจำ ----------
create or replace function refund_job_payment(
  p_job_id uuid, p_method pay_method, p_amount numeric, p_reason text,
  p_reference text default null, p_slip_path text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; t record; v_id uuid; v_amt numeric := round(coalesce(p_amount, 0), 2); v_reason text;
begin
  v_reason := _need_reason(p_reason, 'การคืนเงิน');
  perform set_config('app.audit_reason', v_reason, true);
  j := _lock_job(p_job_id, v_branch);
  if j.status in ('closed', 'cancelled') then
    raise exception 'ใบงานที่ปิด/ยกเลิกแล้วคืนเงินในระบบไม่ได้ — ถ้าบันทึกผิดให้ owner void รายการชำระ/ใบงาน';
  end if;
  if v_amt <= 0 then raise exception 'จำนวนเงินคืนต้องมากกว่า 0'; end if;
  if p_method in ('qr_promptpay', 'transfer') then
    if p_slip_path is null or p_slip_path not like v_branch::text || '/%' then
      raise exception 'คืนเงินด้วย QR/โอน ต้องแนบสลิปการโอนคืน';
    end if;
  end if;
  select * into t from v_job_totals where job_id = j.id;
  if v_amt > t.paid_total then
    raise exception 'คืนเกินยอดที่รับไว้ (รับสุทธิ ฿%)', t.paid_total;
  end if;

  insert into refunds(branch_id, job_id, method, amount, reason, reference_no, slip_path)
  values (v_branch, j.id, p_method, v_amt, v_reason, nullif(btrim(coalesce(p_reference, '')), ''), p_slip_path)
  returning id into v_id;
  return v_id;
end $$;

create or replace function void_refund(p_refund_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner']::user_role[]);
  r refunds%rowtype; j job_orders; v_reason text; t record;
begin
  v_reason := _need_reason(p_reason, 'การ void รายการคืนเงิน');
  perform set_config('app.audit_reason', v_reason, true);
  select * into r from refunds where id = p_refund_id and branch_id = v_branch for update;
  if not found then raise exception 'ไม่พบรายการคืนเงิน'; end if;
  if r.voided_at is not null then raise exception 'รายการนี้ถูก void ไปแล้ว'; end if;
  j := _lock_job(r.job_id, v_branch);
  select * into t from v_job_totals where job_id = j.id;
  if j.status not in ('cancelled') and t.grand_total > 0 and t.paid_total + r.amount > t.grand_total then
    raise exception 'void แล้วยอดรับสุทธิจะเกินยอดบิล (฿%) — ให้ void รายการชำระที่เกินก่อน', t.grand_total;
  end if;
  update refunds set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = r.id;
end $$;

-- ---------- ปิดงาน: VAT รวมในราคา + วันส่งมอบ + หักคืนเงิน ----------
drop function if exists close_job(uuid);
create or replace function close_job(p_job_id uuid, p_delivered_on date default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; t record; s branch_settings%rowtype; c customers%rowtype; v vehicles%rowtype;
  v_rc uuid; v_no text; v_missing text[]; l record;
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
  v_delivered date;
begin
  perform set_config('app.audit_reason', 'ปิดงาน', true);
  j := _lock_job(p_job_id, v_branch);
  if j.status <> 'awaiting_payment' then raise exception 'ปิดงานได้เฉพาะใบงานที่อยู่ในสถานะ "รอชำระ"'; end if;
  if j.qc_passed_at is null then raise exception 'ปิดงานไม่ได้ — ยังไม่ผ่าน QC'; end if;
  v_missing := _job_missing_checks(j.id);
  if cardinality(v_missing) > 0 then raise exception 'เช็คสภาพรถไม่ครบ: %', array_to_string(v_missing, ', '); end if;
  if job_discount_blocked(j.id) then raise exception 'มีส่วนลดเกินเพดานที่เจ้าของยังไม่อนุมัติ'; end if;

  v_delivered := coalesce(p_delivered_on, v_today);
  if v_delivered < (coalesce(j.opened_at, j.created_at) at time zone 'Asia/Bangkok')::date then
    raise exception 'วันที่ส่งมอบต้องไม่ก่อนวันที่เปิดใบงาน';
  end if;
  if v_delivered > v_today + 7 then raise exception 'วันที่ส่งมอบล่วงหน้าได้ไม่เกิน 7 วัน'; end if;

  select * into t from v_job_totals where job_id = j.id;
  if t.net < 0 then raise exception 'ส่วนลดรวมเกินยอดรายการ'; end if;
  if t.paid_total < t.grand_total then
    raise exception 'ปิดงานไม่ได้ — รับเงินยังไม่ครบ (ค้างชำระ ฿%)', t.balance;
  end if;
  if t.paid_total > t.grand_total then
    raise exception 'ยอดรับชำระเกินยอดบิล ฿% — ให้คืนเงินส่วนเกิน หรือ void รายการชำระที่เกิน', (t.paid_total - t.grand_total);
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
      'refunds', (select coalesce(jsonb_agg(jsonb_build_object(
                  'method', rf.method, 'amount', rf.amount, 'reason', rf.reason,
                  'refunded_at', rf.refunded_at) order by rf.refunded_at), '[]'::jsonb)
                  from refunds rf where rf.job_id = j.id and rf.voided_at is null),
      'totals', jsonb_build_object('gross', t.gross, 'discount', t.discount, 'net', t.net,
                                   'vat_enabled', j.vat_enabled, 'vat_rate', j.vat_rate,
                                   'vat', t.vat, 'ex_vat', t.ex_vat, 'vat_included', true,
                                   'grand_total', t.grand_total, 'paid_total', t.paid_total,
                                   'refunded_total', t.refunded_total)))
  returning id into v_rc;

  -- ใบรับประกัน: เริ่มนับจากวันที่ส่งมอบ
  for l in
    select * from job_items
     where job_id = j.id and not is_bundle_header and item_type <> 'discount' and warranty_months is not null
     order by sort_order
  loop
    insert into warranties(branch_id, job_id, job_item_id, receipt_id, customer_id, vehicle_id, warranty_no,
                           item_name, variant_label, attributes, warranty_months, starts_on, ends_on)
    values (v_branch, j.id, l.id, v_rc, j.customer_id, j.vehicle_id, next_doc_no(v_branch, 'warranty', 'WR'),
            l.item_name, l.variant_label, l.attributes, l.warranty_months, v_delivered,
            (v_delivered + make_interval(months => l.warranty_months))::date);
  end loop;

  update job_orders set status = 'closed', closed_at = now(), closed_by = auth.uid(), delivered_on = v_delivered
   where id = j.id;
  perform _log_status(v_branch, j.id, j.status, 'closed', 'ปิดงาน ออกใบเสร็จ ' || v_no);
  perform _on_job_closed(j.id, v_branch);
  return v_rc;
end $$;

-- แก้วันที่ส่งมอบของใบงานที่ปิดแล้ว (เช่น ลูกค้ามารับรถวันถัดมา) → คำนวณวันสิ้นสุดประกันใหม่
create or replace function set_delivery_date(p_job_id uuid, p_date date, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := app_assert(array['owner', 'admin']::user_role[]);
  j job_orders; v_reason text; v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  v_reason := _need_reason(p_reason, 'การแก้วันที่ส่งมอบ');
  perform set_config('app.audit_reason', v_reason, true);
  j := _lock_job(p_job_id, v_branch);
  if j.status <> 'closed' then raise exception 'แก้วันที่ส่งมอบได้เฉพาะใบงานที่ปิดแล้ว (ใบงานที่ยังไม่ปิดให้ระบุตอนปิดงาน)'; end if;
  if p_date is null then raise exception 'กรุณาระบุวันที่ส่งมอบ'; end if;
  if p_date < (coalesce(j.opened_at, j.created_at) at time zone 'Asia/Bangkok')::date then
    raise exception 'วันที่ส่งมอบต้องไม่ก่อนวันที่เปิดใบงาน';
  end if;
  if p_date > v_today + 7 then raise exception 'วันที่ส่งมอบล่วงหน้าได้ไม่เกิน 7 วัน'; end if;
  update job_orders set delivered_on = p_date where id = j.id;
  update warranties set starts_on = p_date, ends_on = (p_date + make_interval(months => warranty_months))::date
   where job_id = j.id and voided_at is null;
end $$;

-- ---------- รายงาน: สรุป VAT (ยอดในรายงานแยกหมวดเป็นยอดรวม VAT ตามที่ลูกค้าจ่าย) ----------
create or replace function report_vat_summary(p_from date, p_to date)
returns table (job_count bigint, gross_total numeric, vat_total numeric, ex_vat_total numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_branch uuid := app_assert(array['owner']::user_role[]);
begin
  return query
  select count(*), coalesce(sum(t.grand_total), 0), coalesce(sum(t.vat), 0), coalesce(sum(t.ex_vat), 0)
    from job_orders j join v_job_totals t on t.job_id = j.id
   where j.branch_id = v_branch and j.status = 'closed' and j.voided_at is null
     and (j.closed_at at time zone 'Asia/Bangkok')::date between p_from and p_to;
end $$;

-- ---------- สิทธิ์ execute (ฟังก์ชันใหม่: เปิดเฉพาะ authenticated ; ฟังก์ชันภายใน _* ปิด) ----------
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
