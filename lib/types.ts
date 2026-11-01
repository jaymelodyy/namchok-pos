// ชนิดข้อมูลให้ตรงกับ supabase/migrations/0001_schema.sql และ 0003_rpc.sql
export type Role = 'owner' | 'admin' | 'technician' | 'warehouse';
export type ItemType = 'service' | 'part' | 'bundle' | 'fee' | 'discount';
export type JobStatus =
  | 'booked' | 'opened' | 'condition_check' | 'quoting' | 'requisition' | 'ready'
  | 'in_progress' | 'qc' | 'awaiting_payment' | 'closed' | 'cancelled';
export type JobSource = 'walk_in' | 'line' | 'messenger' | 'facebook_ads' | 'returning';
export type PayMethod = 'qr_promptpay' | 'cash' | 'transfer';
export type PayKind = 'deposit' | 'payment';
export type VehicleSize = 'sedan' | 'suv' | 'pickup_cab' | 'pickup_4door' | 'van';
export type FilmPosition = 'full' | 'front' | 'side' | 'rear' | 'roof';

export interface Profile {
  id: string; branch_id: string; full_name: string; role: Role; phone: string | null; is_active: boolean;
}
export interface BranchSettings {
  branch_id: string; shop_name: string; shop_address: string | null; shop_phone: string | null; tax_id: string | null;
  vat_enabled: boolean; vat_rate: number; discount_cap_percent: number; receipt_footer: string | null;
}

/** แถวจาก view v_jobs (ตัวเลขเงินมาเป็น string/number ตาม PostgREST → แปลงด้วย num()) */
export interface VJob {
  id: string; job_no: string; status: JobStatus; source: JobSource; complaint: string | null; odometer: number | null;
  scheduled_at: string | null; opened_at: string | null; created_at: string; updated_at: string;
  quote_approved_at: string | null; qc_passed_at: string | null; closed_at: string | null; voided_at: string | null;
  cancel_reason: string | null;
  customer_id: string; customer_name: string; customer_phone: string | null;
  vehicle_id: string; plate: string; plate_province: string | null; brand: string | null; model: string | null; year: number | null;
  gross: number; discount: number; net: number; vat: number; grand_total: number; paid_total: number; balance: number;
  payment_status: 'unpaid' | 'partial' | 'paid';
  /** ราคารวม VAT แล้ว: ex_vat = net − vat ; paid_total/balance คิดหลังหักเงินคืนแล้ว */
  ex_vat: number; refunded_total: number;
  status_changed_at: string; delivered_on: string | null;
}

export interface JobItem {
  id: string; job_id: string; parent_id: string | null; catalog_item_id: string | null; price_id: string | null;
  item_code: string; item_name: string; variant_label: string | null; item_type: ItemType; is_bundle_header: boolean;
  qty: number; unit_price: number; list_price: number | null; price_reason: string | null;
  warranty_months: number | null; requires_condition_check: boolean; attributes: Record<string, string>;
  owner_approved_at: string | null; sort_order: number; line_total: number;
}

export interface CheckRequirement {
  template_id: string; template_name: string; min_photos: number; check_id: string | null; completed: boolean; photo_count: number;
}
export interface ChecklistItem { key: string; label: string; required?: boolean }
export interface CheckTemplate { id: string; code: string; name: string; is_default: boolean; checklist: ChecklistItem[]; min_photos: number }
export type AnswerState = 'ok' | 'defect' | 'na';
export type Answers = Record<string, { state: AnswerState; note?: string }>;
export interface ConditionCheck {
  id: string; job_id: string; template_id: string; answers: Answers; note: string | null;
  signature_path: string | null; signed_by_name: string | null; signed_at: string | null; completed_at: string | null;
}
export interface CheckPhoto { id: string; check_id: string; storage_path: string; caption: string | null }

export interface Payment {
  id: string; job_id: string; kind: PayKind; method: PayMethod; amount: number; reference_no: string | null;
  slip_path: string | null; note: string | null; received_at: string; voided_at: string | null; void_reason: string | null;
}
export interface Refund {
  id: string; job_id: string; method: PayMethod; amount: number; reason: string; reference_no: string | null;
  slip_path: string | null; refunded_at: string; voided_at: string | null; void_reason: string | null;
}
export interface StatusLog { id: number; from_status: JobStatus | null; to_status: JobStatus; reason: string | null; actor: string | null; created_at: string }

export interface Category { id: string; code: string; name: string; parent_id: string | null; sort_order: number; is_active: boolean }
export interface CatalogItem {
  id: string; category_id: string; code: string; name: string; item_type: ItemType; unit: string | null;
  requires_condition_check: boolean; crew_size: number; labor_rate: number; warranty_months: number | null;
  attribute_schema: string[]; sort_order: number; is_active: boolean;
}
export interface ItemPrice {
  id: string; item_id: string; position: FilmPosition | null; vehicle_size: VehicleSize | null; label: string | null;
  price: number; cost: number; is_active: boolean;
}

export interface ReceiptLine {
  code: string; name: string; variant: string | null; type: ItemType; qty: number; unit_price: number; line_total: number;
  is_header: boolean; is_child: boolean; attributes: Record<string, string>; warranty_months: number | null; reason: string | null;
}
export interface Receipt {
  id: string; job_id: string; receipt_no: string; issued_at: string; subtotal: number; discount_total: number;
  vat_amount: number; grand_total: number; voided_at: string | null;
  snapshot: {
    shop: { name: string; address: string | null; phone: string | null; tax_id: string | null; footer: string | null };
    job: { job_no: string; odometer: number | null; opened_at: string | null; closed_at: string; delivered_on?: string | null };
    customer: { name: string; phone: string | null };
    vehicle: { plate: string; province: string | null; brand: string | null; model: string | null; year: number | null };
    lines: ReceiptLine[];
    payments: { kind: PayKind; method: PayMethod; amount: number; reference_no: string | null; received_at: string }[];
    refunds?: { method: PayMethod; amount: number; reason: string; refunded_at: string }[];
    totals: {
      gross: number; discount: number; net: number; vat_enabled: boolean; vat_rate: number; vat: number; grand_total: number; paid_total: number;
      ex_vat?: number; vat_included?: boolean; refunded_total?: number;
    };
  };
}
export interface Warranty {
  id: string; warranty_no: string; item_name: string; variant_label: string | null; attributes: Record<string, string>;
  warranty_months: number; starts_on: string; ends_on: string; voided_at: string | null;
}

export interface RevenueRow {
  main_code: string; main_name: string; sub_code: string; sub_name: string; line_type: ItemType; line_count: number; revenue: number;
}
export interface AuditRow {
  id: number; table_name: string; record_id: string | null; action: string; reason: string | null; actor: string | null; created_at: string;
}

// ---------- เฟส 2 ----------
export type RequisitionStatus = 'requested' | 'prepared' | 'delivered' | 'void';
export interface RequisitionLine {
  id: string; requisition_id: string; catalog_item_id: string | null; item_code: string; item_name: string; qty: number; attributes: Record<string, string>;
}
export interface Requisition {
  id: string; job_id: string; req_no: string; job_no: string; plate: string; vehicle_label: string | null; status: RequisitionStatus;
  note: string | null; requested_at: string; prepared_at: string | null; delivered_at: string | null; voided_at: string | null; void_reason: string | null;
  lines: RequisitionLine[];
}
/** ทีมช่างของใบงาน (จาก RPC job_crew_info) — required_crew = ค่าที่ผู้ดูแลตั้งเองต่อใบงาน (null = ใช้กติกาแคตตาล็อก) */
export interface CrewInfo {
  job_id: string; crew_required: number; crew_active: number; required_crew: number | null;
  member_ids: string[]; member_names: string[]; mine: boolean;
}
export type TechState = 'free' | 'assigned' | 'busy';
export interface TechnicianRow {
  user_id: string; full_name: string; state: TechState;
  jobs: { job_id: string; job_no: string; status: JobStatus; plate: string }[];
}
export interface QcItem { key: string; label: string }
export interface QcCheck {
  id: string; job_id: string; result: 'pass' | 'fail'; answers: Record<string, boolean>; note: string | null; photo_paths: string[];
  checked_by: string | null; checked_at: string;
}
export interface LaborEntry {
  id: string; job_id: string; user_id: string; job_no: string; plate: string; item_name: string; variant_label: string | null;
  qty: number; labor_rate: number; crew_actual: number; amount: number; earned_on: string;
  paid_at: string | null; voided_at: string | null; void_reason: string | null;
}
export interface WageDailyRow {
  work_date: string; user_id: string; full_name: string; clocked_in_at: string; clocked_out_at: string | null;
  late_minutes: number; base_wage: number; late_deduction: number; overtime_minutes: number;
  overtime_amount: number; work_total: number; total: number; paid_at: string | null;
}
export interface WageWorkType {
  id: string; code: string; name: string; unit_label: string; current_rate: number; is_active: boolean;
}
export interface WageWorkEntry {
  id: string; user_id: string; work_date: string; work_name: string; unit_label: string;
  quantity: number; unit_rate: number; amount: number; voided_at: string | null; void_reason: string | null;
}
export interface TechnicianBankDetails { user_id: string; bank_name: string; account_number: string }
export interface VatSummary { job_count: number; gross_total: number; vat_total: number; ex_vat_total: number }
