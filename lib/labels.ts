import type { FilmPosition, ItemType, JobSource, JobStatus, PayMethod, Role, VehicleSize } from './types';

export const STATUS_LABEL: Record<JobStatus, string> = {
  booked: 'จองคิว',
  opened: 'รับรถแล้ว',
  condition_check: 'เช็คสภาพ',
  quoting: 'เสนอราคา',
  requisition: 'เบิกอะไหล่',
  ready: 'พร้อมเริ่มงาน',
  in_progress: 'กำลังทำ',
  qc: 'ตรวจ QC',
  awaiting_payment: 'รอชำระ',
  closed: 'ปิดงานแล้ว',
  cancelled: 'ยกเลิก',
};

/** ลำดับขั้นปกติ (ไม่รวมจองคิว/ยกเลิก) ใช้วาดแถบสถานะ */
export const STATUS_FLOW: JobStatus[] = [
  'opened', 'condition_check', 'quoting', 'requisition', 'ready', 'in_progress', 'qc', 'awaiting_payment', 'closed',
];

export const ACTIVE_STATUSES: JobStatus[] = [
  'booked', 'opened', 'condition_check', 'quoting', 'requisition', 'ready', 'in_progress', 'qc', 'awaiting_payment',
];

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'เจ้าของ', admin: 'แอดมิน', technician: 'ช่าง', warehouse: 'คลัง',
};
export const SOURCE_LABEL: Record<JobSource, string> = {
  walk_in: 'หน้าร้าน', line: 'LINE', messenger: 'Messenger', facebook_ads: 'โฆษณา Facebook', returning: 'ลูกค้าเก่า',
};
export const METHOD_LABEL: Record<PayMethod, string> = {
  qr_promptpay: 'QR พร้อมเพย์', cash: 'เงินสด', transfer: 'โอนเงิน',
};
export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  service: 'ค่าแรง/บริการ', part: 'อะไหล่', bundle: 'ชุดบริการ', fee: 'ค่าธรรมเนียม', discount: 'ส่วนลด',
};
export const POSITION_LABEL: Record<FilmPosition, string> = {
  full: 'ทั้งคัน', front: 'กระจกหน้า', side: 'กระจกข้าง', rear: 'กระจกหลัง', roof: 'หลังคา',
};
export const SIZE_LABEL: Record<VehicleSize, string> = {
  sedan: 'เก๋ง', suv: 'SUV', pickup_cab: 'กระบะแค็บ', pickup_4door: 'กระบะ 4 ประตู', van: 'ตู้-แวน',
};
export const POSITIONS = Object.keys(POSITION_LABEL) as FilmPosition[];
export const SIZES = Object.keys(SIZE_LABEL) as VehicleSize[];

export const MAIN_CATEGORY_ICON: Record<string, string> = { AC: 'แอร์', FM: 'ฟิล์ม', BT: 'แบต', PT: 'อะไหล่', OT: 'อื่น ๆ' };

/** ชื่อตัวเลือกราคา เช่น "ทั้งคัน · SUV" ให้ตรงกับ variant_label() ในฐานข้อมูล */
export function variantName(position: FilmPosition | null, size: VehicleSize | null): string {
  if (!position && !size) return 'มาตรฐาน';
  return [position ? POSITION_LABEL[position] : null, size ? SIZE_LABEL[size] : null].filter(Boolean).join(' · ');
}
