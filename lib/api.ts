// ชั้นเรียกฐานข้อมูล: ชื่อ RPC/พารามิเตอร์ต้องตรงกับ supabase/migrations/0003_rpc.sql
import { sb } from './supabase';
import { num, plateNorm } from './format';
import type {
  Answers, AuditRow, BranchSettings, CatalogItem, Category, CheckPhoto, CheckRequirement, CheckTemplate,
  ConditionCheck, CrewInfo, ItemPrice, JobItem, JobSource, JobStatus, LaborEntry, PayKind, PayMethod, Payment, Profile, QcCheck,
  QcItem, Receipt, Refund, Requisition, RequisitionLine, RequisitionStatus, RevenueRow, StatusLog, TechnicianRow, VJob, VatSummary, Warranty,
} from './types';

interface DbError { message?: string; code?: string }

function friendly(e: DbError): string {
  if (e.code === '42501') return 'ไม่มีสิทธิ์ทำรายการนี้';
  if (e.message && /JWT|token/i.test(e.message)) return 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่';
  if (e.code === '23505') return 'ข้อมูลซ้ำกับที่มีอยู่แล้ว';
  return e.message || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ';
}
function fail(e: DbError): never { throw new Error(friendly(e)); }

/** เวลาที่ตัวเองเขียนข้อมูลสำเร็จล่าสุด — ใช้กันไม่ให้แจ้งเตือนในแอปเด้งซ้ำกับสิ่งที่เพิ่งกดเอง */
let lastOwnWriteAt = 0;
export const msSinceOwnWrite = () => Date.now() - lastOwnWriteAt;
const READ_RPC = /^(job_items_for_job|job_required_checks|job_discount_blocked|job_crew_info|technician_board|qc_checklist|report_)/;
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await sb().rpc(fn, args);
  if (error) fail(error);
  if (!READ_RPC.test(fn)) lastOwnWriteAt = Date.now();
  return data as T;
}
async function rows<T>(q: PromiseLike<{ data: unknown; error: DbError | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) fail(error);
  return (data ?? []) as T[];
}
async function maybeOne<T>(q: PromiseLike<{ data: unknown; error: DbError | null }>): Promise<T | null> {
  const { data, error } = await q;
  if (error) fail(error);
  return (data ?? null) as T | null;
}

// ---------- แปลงตัวเลขเงิน ----------
const normJob = (r: VJob): VJob => ({
  ...r,
  gross: num(r.gross), discount: num(r.discount), net: num(r.net), vat: num(r.vat),
  grand_total: num(r.grand_total), paid_total: num(r.paid_total), balance: num(r.balance),
  ex_vat: num(r.ex_vat), refunded_total: num(r.refunded_total),
});
const normItem = (r: JobItem): JobItem => ({
  ...r, qty: num(r.qty), unit_price: num(r.unit_price), line_total: num(r.line_total), // ช่าง/คลังได้ค่าเงินเป็น NULL จาก DB → 0 (หน้าจอซ่อนอยู่แล้ว)
  list_price: r.list_price == null ? null : num(r.list_price),
});
const normPayment = (r: Payment): Payment => ({ ...r, amount: num(r.amount) });
const normRefund = (r: Refund): Refund => ({ ...r, amount: num(r.amount) });
const normLabor = (r: LaborEntry): LaborEntry => ({ ...r, qty: num(r.qty), labor_rate: num(r.labor_rate), crew_actual: num(r.crew_actual), amount: num(r.amount) });
const normPrice = (r: ItemPrice): ItemPrice => ({ ...r, price: num(r.price), cost: num(r.cost) });
const normCatalogItem = (r: CatalogItem): CatalogItem => ({ ...r, labor_rate: num(r.labor_rate) });

// ---------- โปรไฟล์ / ตั้งค่า ----------
export async function loadProfile(userId: string): Promise<Profile | null> {
  return maybeOne<Profile>(sb().from('users').select('*').eq('id', userId).maybeSingle());
}
export async function loadSettings(branchId: string): Promise<BranchSettings | null> {
  const s = await maybeOne<BranchSettings>(sb().from('branch_settings').select('*').eq('branch_id', branchId).maybeSingle());
  return s ? { ...s, vat_rate: num(s.vat_rate), discount_cap_percent: num(s.discount_cap_percent) } : null;
}
export async function saveSettings(branchId: string, patch: Partial<Pick<BranchSettings,
  'vat_enabled' | 'vat_rate' | 'discount_cap_percent' | 'shop_name' | 'shop_address' | 'shop_phone' | 'tax_id' | 'receipt_footer'>>) {
  const { data, error } = await sb().from('branch_settings').update(patch).eq('branch_id', branchId).select();
  if (error) fail(error);
  if (!data || data.length === 0) throw new Error('บันทึกไม่ได้ — ไม่มีสิทธิ์ หรือไม่พบการตั้งค่า');
}
export async function listUsers() {
  return rows<Pick<Profile, 'id' | 'full_name' | 'role' | 'phone' | 'is_active'>>(
    sb().from('users').select('id,full_name,role,phone,is_active').order('role').order('full_name'));
}
export async function listAudit(limit = 60) {
  return rows<AuditRow>(sb().from('audit_logs')
    .select('id,table_name,record_id,action,reason,actor,created_at').order('id', { ascending: false }).limit(limit));
}

// ---------- ค้นรถ / เปิดใบงาน ----------
export interface VehicleHit {
  id: string; plate: string; plate_province: string | null; brand: string | null; model: string | null; year: number | null;
  last_odometer: number | null; customer_id: string | null; customer_name: string | null; customer_phone: string | null;
  visits: number; last_visit: string | null; last_status: JobStatus | null; open_job_id: string | null;
}

export async function searchVehicles(plateInput: string): Promise<VehicleHit[]> {
  const norm = plateNorm(plateInput);
  if (!norm) return [];
  const vs = await rows<{
    id: string; plate: string; plate_province: string | null; brand: string | null; model: string | null;
    year: number | null; last_odometer: number | null; customer_id: string | null;
  }>(sb().from('vehicles')
    .select('id,plate,plate_province,brand,model,year,last_odometer,customer_id')
    .like('plate_norm', `${norm}%`).order('plate_norm').limit(6));
  if (vs.length === 0) return [];
  const custIds = [...new Set(vs.map((v) => v.customer_id).filter(Boolean))] as string[];
  const [custs, jobs] = await Promise.all([
    custIds.length ? rows<{ id: string; name: string; phone: string | null }>(sb().from('customers').select('id,name,phone').in('id', custIds)) : Promise.resolve([]),
    rows<{ id: string; vehicle_id: string; status: JobStatus; created_at: string; voided_at: string | null }>(
      sb().from('v_jobs').select('id,vehicle_id,status,created_at,voided_at').in('vehicle_id', vs.map((v) => v.id)).order('created_at', { ascending: false }).limit(60)),
  ]);
  return vs.map((v) => {
    const c = custs.find((x) => x.id === v.customer_id);
    const mine = jobs.filter((j) => j.vehicle_id === v.id && !j.voided_at);
    const open = mine.find((j) => j.status !== 'closed' && j.status !== 'cancelled');
    return {
      ...v, customer_name: c?.name ?? null, customer_phone: c?.phone ?? null,
      visits: mine.filter((j) => j.status === 'closed').length,
      last_visit: mine[0]?.created_at ?? null, last_status: mine[0]?.status ?? null, open_job_id: open?.id ?? null,
    };
  });
}

export interface OpenJobInput {
  plate: string; province: string | null; brand?: string; model?: string; year?: number | null; odometer?: number | null;
  customerName?: string; phone?: string; source: JobSource; complaint?: string; scheduledAt?: string | null; vehicleId?: string | null;
}
export async function openJob(i: OpenJobInput): Promise<string> {
  return rpc<string>('open_job', {
    p_plate: i.plate, p_plate_province: i.province || undefined, p_brand: i.brand || undefined, p_model: i.model || undefined,
    p_year: i.year ?? undefined, p_odometer: i.odometer ?? undefined, p_customer_name: i.customerName || undefined,
    p_phone: i.phone || undefined, p_source: i.source, p_complaint: i.complaint || undefined,
    p_scheduled_at: i.scheduledAt || undefined, p_vehicle_id: i.vehicleId || undefined,
  });
}

// ---------- ใบงาน ----------
export async function listJobs(): Promise<VJob[]> {
  const r = await rows<VJob>(sb().from('v_jobs').select('*').order('created_at', { ascending: false }).limit(300));
  return r.map(normJob);
}

export interface BoardData { jobs: VJob[]; crew: Record<string, CrewInfo>; reqs: Requisition[]; techs: TechnicianRow[] }
/** ข้อมูลบอร์ดงาน (owner/admin) : ใบงาน + ทีมช่างของงานที่เริ่มแล้ว + คำขอเบิกที่ค้าง + สถานะช่าง */
export async function loadBoardData(): Promise<BoardData> {
  const jobs = await listJobs();
  const live = jobs.filter((j) => !j.voided_at && ['ready', 'in_progress', 'qc'].includes(j.status)).map((j) => j.id);
  const [crew, reqs, techs] = await Promise.all([
    jobCrewInfo(live),
    listRequisitions({ statuses: ['requested', 'prepared'], limit: 200 }),
    technicianBoard(),
  ]);
  return { jobs, crew, reqs, techs };
}

export interface WorkData { jobs: VJob[]; crew: Record<string, CrewInfo> }
/** งานที่ช่างเห็น (RLS กรองให้แล้ว) + ทีมช่างของแต่ละงาน เพื่อแยก "งานของฉัน" / "งานว่างที่รับได้" */
export async function loadWorkData(): Promise<WorkData> {
  const jobs = (await listJobs()).filter((j) => !j.voided_at);
  const crew = await jobCrewInfo(jobs.filter((j) => ['ready', 'in_progress', 'qc'].includes(j.status)).map((j) => j.id));
  return { jobs, crew };
}

export interface JobDetail {
  job: VJob; items: JobItem[]; checks: CheckRequirement[]; payments: Payment[]; refunds: Refund[]; log: StatusLog[]; discountBlocked: boolean;
  crew: CrewInfo | null; requisitions: Requisition[]; qc: QcCheck[];
}
export async function loadJob(id: string): Promise<JobDetail | null> {
  const job = await maybeOne<VJob>(sb().from('v_jobs').select('*').eq('id', id).maybeSingle());
  if (!job) return null;
  const [items, checks, payments, refunds, log, blocked, crew, requisitions, qc] = await Promise.all([
    rpc<JobItem[]>('job_items_for_job', { p_job: id }).then((r) => r ?? []),
    rpc<CheckRequirement[]>('job_required_checks', { p_job: id }),
    rows<Payment>(sb().from('payments').select('*').eq('job_id', id).order('received_at')),
    rows<Refund>(sb().from('refunds').select('*').eq('job_id', id).order('refunded_at')),   // ช่าง/คลังไม่มีสิทธิ์อ่าน → ว่าง
    rows<StatusLog>(sb().from('job_status_log').select('*').eq('job_id', id).order('id')),
    rpc<boolean>('job_discount_blocked', { p_job: id }),
    rpc<CrewInfo[]>('job_crew_info', { p_jobs: [id] }).then((r) => r?.[0] ?? null),
    listRequisitions({ jobId: id }),
    rows<QcCheck>(sb().from('qc_checks').select('*').eq('job_id', id).order('checked_at')),   // owner/admin เท่านั้นที่อ่านได้
  ]);
  return {
    job: normJob(job), items: items.map(normItem), checks: (checks ?? []).map((c) => ({ ...c, photo_count: num(c.photo_count) })),
    payments: payments.map(normPayment), refunds: refunds.map(normRefund), log, discountBlocked: Boolean(blocked),
    crew, requisitions, qc,
  };
}

export async function loadReceipt(jobId: string) {
  const [receipt, warranties] = await Promise.all([
    maybeOne<Receipt>(sb().from('receipts').select('*').eq('job_id', jobId).maybeSingle()),
    rows<Warranty>(sb().from('warranties').select('*').eq('job_id', jobId).order('warranty_no')),
  ]);
  return { receipt, warranties };
}

// ---------- รายการในใบงาน ----------
export const addItem = (a: {
  jobId: string; itemId: string; priceId?: string | null; qty?: number; unitPrice?: number | null; reason?: string; attributes?: Record<string, string>;
}) => rpc<string>('add_job_item', {
  p_job_id: a.jobId, p_item_id: a.itemId, p_price_id: a.priceId || undefined, p_qty: a.qty ?? 1,
  p_unit_price: a.unitPrice ?? undefined, p_reason: a.reason || undefined,
  p_attributes: a.attributes && Object.keys(a.attributes).length ? a.attributes : undefined,
});
export const setItemPrice = (lineId: string, price: number, reason: string) =>
  rpc<void>('set_job_item_price', { p_line_id: lineId, p_price: price, p_reason: reason });
export const setItemQty = (lineId: string, qty: number) => rpc<void>('set_job_item_qty', { p_line_id: lineId, p_qty: qty });
export const removeItem = (lineId: string, reason?: string) => rpc<void>('remove_job_item', { p_line_id: lineId, p_reason: reason || undefined });
export const approveDiscounts = (jobId: string, note?: string) => rpc<void>('approve_discounts', { p_job_id: jobId, p_note: note || undefined });

// ---------- แคตตาล็อก ----------
export interface Catalog { categories: Category[]; items: CatalogItem[]; prices: ItemPrice[] }
let catalogCache: Catalog | null = null;
export const invalidateCatalog = () => { catalogCache = null; };
export async function loadCatalog(force = false): Promise<Catalog> {
  if (catalogCache && !force) return catalogCache;
  const [categories, items, prices] = await Promise.all([
    rows<Category>(sb().from('catalog_categories').select('*').order('code')),
    rows<CatalogItem>(sb().from('catalog_items').select('*').order('code')),
    rows<ItemPrice>(sb().from('item_prices').select('*').order('created_at')),
  ]);
  catalogCache = { categories, items: items.map(normCatalogItem), prices: prices.map(normPrice) };
  return catalogCache;
}
export async function updateItemPrice(priceId: string, patch: { price?: number; cost?: number; is_active?: boolean }) {
  const { data, error } = await sb().from('item_prices').update(patch).eq('id', priceId).select('id');
  if (error) fail(error);
  if (!data?.length) throw new Error('บันทึกไม่ได้ — เฉพาะเจ้าของแก้ราคาได้');
  invalidateCatalog();
}
export async function updateCatalogItem(id: string, patch: Partial<Pick<CatalogItem,
  'warranty_months' | 'crew_size' | 'labor_rate' | 'is_active' | 'name' | 'unit'>>) {
  const { data, error } = await sb().from('catalog_items').update(patch).eq('id', id).select('id');
  if (error) fail(error);
  if (!data?.length) throw new Error('บันทึกไม่ได้ — เฉพาะเจ้าของแก้แคตตาล็อกได้');
  invalidateCatalog();
}
export async function createCatalogItem(a: {
  categoryId: string; name: string; type: CatalogItem['item_type']; withMatrix?: boolean; attributeSchema?: string[];
}) {
  const id = await rpc<string>('catalog_create_item', {
    p_category_id: a.categoryId, p_name: a.name, p_item_type: a.type, p_with_matrix: a.withMatrix ?? false,
    p_attribute_schema: a.attributeSchema?.length ? a.attributeSchema : undefined,
  });
  invalidateCatalog();
  return id;
}

// ---------- เช็คสภาพ ----------
export async function loadTemplate(id: string): Promise<CheckTemplate | null> {
  return maybeOne<CheckTemplate>(sb().from('condition_templates').select('id,code,name,is_default,checklist,min_photos').eq('id', id).maybeSingle());
}
export async function loadCheck(jobId: string, templateId: string) {
  const check = await maybeOne<ConditionCheck>(sb().from('condition_checks').select('*').eq('job_id', jobId).eq('template_id', templateId).maybeSingle());
  const photos = check ? await rows<CheckPhoto>(sb().from('condition_check_photos').select('*').eq('check_id', check.id).order('created_at')) : [];
  return { check, photos };
}
export const saveCheck = (jobId: string, templateId: string, answers: Answers, note?: string) =>
  rpc<string>('save_condition_check', { p_job_id: jobId, p_template_id: templateId, p_answers: answers, p_note: note || undefined });
export const addCheckPhoto = (checkId: string, path: string, caption?: string) =>
  rpc<string>('add_condition_photo', { p_check_id: checkId, p_path: path, p_caption: caption || undefined });
export const completeCheck = (checkId: string, signaturePath: string, signedBy: string) =>
  rpc<void>('complete_condition_check', { p_check_id: checkId, p_signature_path: signaturePath, p_signed_by: signedBy });
export const reopenCheck = (checkId: string, reason: string) => rpc<void>('reopen_condition_check', { p_check_id: checkId, p_reason: reason });

const BUCKET = 'job-files';
export async function uploadFile(path: string, blob: Blob, contentType: string) {
  const { error } = await sb().storage.from(BUCKET).upload(path, blob, { contentType, upsert: false });
  if (error) fail(error);
  return path;
}
export async function signedUrls(paths: string[]): Promise<Record<string, string>> {
  const uniq = [...new Set(paths.filter(Boolean))];
  if (!uniq.length) return {};
  const { data, error } = await sb().storage.from(BUCKET).createSignedUrls(uniq, 3600);
  if (error) fail(error);
  const out: Record<string, string> = {};
  for (const d of data ?? []) if (d.path && d.signedUrl) out[d.path] = d.signedUrl;
  return out;
}

// ---------- สถานะ ----------
export const advanceJob = (jobId: string) => rpc<JobStatus>('advance_job', { p_job_id: jobId });
export const approveQuote = (jobId: string, note?: string) => rpc<void>('approve_quote', { p_job_id: jobId, p_note: note || undefined });
export const qcPass = (jobId: string, answers: Record<string, boolean>, note?: string, photos: string[] = []) =>
  rpc<void>('qc_pass', { p_job_id: jobId, p_answers: answers, p_note: note || undefined, p_photos: photos });
export const qcFail = (jobId: string, note: string, photos: string[] = [], answers: Record<string, boolean> = {}) =>
  rpc<void>('qc_fail', { p_job_id: jobId, p_note: note, p_photos: photos, p_answers: answers });
export const qcChecklist = () => rpc<QcItem[]>('qc_checklist');
export const revertJob = (jobId: string, target: JobStatus, reason: string) => rpc<void>('revert_job', { p_job_id: jobId, p_target: target, p_reason: reason });
export const cancelJob = (jobId: string, reason: string) => rpc<void>('cancel_job', { p_job_id: jobId, p_reason: reason });
export const voidJob = (jobId: string, reason: string) => rpc<void>('void_job', { p_job_id: jobId, p_reason: reason });
/** deliveredOn = วันที่ลูกค้ารับรถ (yyyy-mm-dd) — ประกันนับจากวันนี้ ; ไม่ส่ง = วันนี้ */
export const closeJob = (jobId: string, deliveredOn?: string) => rpc<string>('close_job', { p_job_id: jobId, p_delivered_on: deliveredOn || undefined });
export const setDeliveryDate = (jobId: string, date: string, reason: string) => rpc<void>('set_delivery_date', { p_job_id: jobId, p_date: date, p_reason: reason });

// ---------- ช่างรับงาน / ทีม ----------
export const acceptJob = (jobId: string) => rpc<void>('accept_job', { p_job_id: jobId });
export const releaseJob = (jobId: string) => rpc<void>('release_job', { p_job_id: jobId });
export const assignTechnician = (jobId: string, userId: string) => rpc<void>('assign_technician', { p_job_id: jobId, p_user_id: userId });
export const removeTechnician = (jobId: string, userId: string, reason: string) => rpc<void>('remove_technician', { p_job_id: jobId, p_user_id: userId, p_reason: reason });
/** ตั้งทีมช่างหลายคนครั้งเดียวจบ (แทนที่ทีมเดิมด้วยรายชื่อที่ให้มา — owner/admin) */
export const setJobCrew = (jobId: string, userIds: string[], reason?: string) =>
  rpc<void>('set_job_crew', { p_job_id: jobId, p_user_ids: userIds, p_reason: reason || undefined });
/** เพิ่มช่างหลายคนพร้อมกันโดยไม่แตะคนเดิม (owner/admin) */
export const addJobCrew = (jobId: string, userIds: string[]) => rpc<void>('add_job_crew', { p_job_id: jobId, p_user_ids: userIds });
/** กำหนด "จำนวนช่างที่ต้องใช้" เองต่อใบงาน โดยไม่แก้แคตตาล็อก (owner/admin) */
export const setCrewRequired = (jobId: string, count: number) => rpc<void>('set_job_crew_required', { p_job_id: jobId, p_count: count });
const normCrew = (c: CrewInfo): CrewInfo => ({
  ...c, crew_required: num(c.crew_required), crew_active: num(c.crew_active),
  required_crew: c.required_crew == null ? null : num(c.required_crew),
});
export async function jobCrewInfo(jobIds: string[]): Promise<Record<string, CrewInfo>> {
  if (!jobIds.length) return {};
  const r = await rpc<CrewInfo[]>('job_crew_info', { p_jobs: jobIds });
  return Object.fromEntries((r ?? []).map((c) => [c.job_id, normCrew(c)]));
}
export async function technicianBoard(): Promise<TechnicianRow[]> {
  return (await rpc<TechnicianRow[]>('technician_board')) ?? [];
}

// ---------- คำขอเบิกอะไหล่ ----------
export async function listRequisitions(f: { jobId?: string; statuses?: RequisitionStatus[]; limit?: number } = {}): Promise<Requisition[]> {
  let q = sb().from('requisitions').select('*').order('requested_at', { ascending: false }).limit(f.limit ?? 120);
  if (f.jobId) q = q.eq('job_id', f.jobId);
  if (f.statuses?.length) q = q.in('status', f.statuses);
  const reqs = await rows<Omit<Requisition, 'lines'>>(q);
  if (!reqs.length) return [];
  const lines = await rows<RequisitionLine>(sb().from('requisition_lines').select('*').in('requisition_id', reqs.map((r) => r.id)).order('item_code'));
  return reqs.map((r) => ({ ...r, lines: lines.filter((l) => l.requisition_id === r.id).map((l) => ({ ...l, qty: num(l.qty) })) }));
}
export const advanceRequisition = (reqId: string) => rpc<RequisitionStatus>('advance_requisition', { p_req_id: reqId });
export const revertRequisition = (reqId: string, reason: string) => rpc<void>('revert_requisition', { p_req_id: reqId, p_reason: reason });
export const cancelRequisition = (reqId: string, reason: string) => rpc<void>('cancel_requisition', { p_req_id: reqId, p_reason: reason });

// ---------- ค่าแรงช่าง ----------
export async function listLabor(f: { from: string; to: string; userId?: string }): Promise<LaborEntry[]> {
  let q = sb().from('labor_pay_entries').select('*').gte('earned_on', f.from).lte('earned_on', f.to).is('voided_at', null)
    .order('earned_on', { ascending: false }).order('created_at', { ascending: false }).limit(500);
  if (f.userId) q = q.eq('user_id', f.userId);
  return (await rows<LaborEntry>(q)).map(normLabor);
}
export const markLaborPaid = (userId: string, from: string, to: string, note?: string) =>
  rpc<number>('mark_labor_paid', { p_user_id: userId, p_from: from, p_to: to, p_note: note || undefined });
export const unmarkLaborPaid = (userId: string, from: string, to: string, reason: string) =>
  rpc<number>('unmark_labor_paid', { p_user_id: userId, p_from: from, p_to: to, p_reason: reason });

// ---------- เงิน ----------
export const recordPayment = (a: {
  jobId: string; kind: PayKind; method: PayMethod; amount: number; reference?: string; slipPath?: string; note?: string;
}) => rpc<string>('record_payment', {
  p_job_id: a.jobId, p_kind: a.kind, p_method: a.method, p_amount: a.amount,
  p_reference: a.reference || undefined, p_slip_path: a.slipPath || undefined, p_note: a.note || undefined,
});
export const voidPayment = (paymentId: string, reason: string) => rpc<void>('void_payment', { p_payment_id: paymentId, p_reason: reason });
export const refundPayment = (a: { jobId: string; method: PayMethod; amount: number; reason: string; reference?: string; slipPath?: string }) =>
  rpc<string>('refund_job_payment', {
    p_job_id: a.jobId, p_method: a.method, p_amount: a.amount, p_reason: a.reason,
    p_reference: a.reference || undefined, p_slip_path: a.slipPath || undefined,
  });
export const voidRefund = (refundId: string, reason: string) => rpc<void>('void_refund', { p_refund_id: refundId, p_reason: reason });

// ---------- รายงาน ----------
export async function revenueReport(from: string, to: string): Promise<RevenueRow[]> {
  const r = await rpc<RevenueRow[]>('report_revenue', { p_from: from, p_to: to });
  return (r ?? []).map((x) => ({ ...x, revenue: num(x.revenue), line_count: num(x.line_count) }));
}
export async function vatSummary(from: string, to: string): Promise<VatSummary | null> {
  const r = await rpc<VatSummary[]>('report_vat_summary', { p_from: from, p_to: to });
  const x = r?.[0];
  return x ? { job_count: num(x.job_count), gross_total: num(x.gross_total), vat_total: num(x.vat_total), ex_vat_total: num(x.ex_vat_total) } : null;
}
export async function refundsInRange(from: string, nextDay: string): Promise<Refund[]> {
  const r = await rows<Refund>(sb().from('refunds').select('*')
    .gte('refunded_at', `${from}T00:00:00+07:00`).lt('refunded_at', `${nextDay}T00:00:00+07:00`).is('voided_at', null));
  return r.map(normRefund);
}
/** รายการรับเงิน (ไม่รวมที่ void) ตั้งแต่ from ถึงก่อน nextDay เวลาไทย */
export async function paymentsInRange(from: string, nextDay: string): Promise<Payment[]> {
  const r = await rows<Payment>(sb().from('payments').select('*')
    .gte('received_at', `${from}T00:00:00+07:00`).lt('received_at', `${nextDay}T00:00:00+07:00`).is('voided_at', null));
  return r.map(normPayment);
}
