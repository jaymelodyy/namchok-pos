const TZ = 'Asia/Bangkok';

/** PostgREST ส่ง numeric เป็น number หรือ string ขึ้นกับค่า — แปลงให้เป็น number เสมอ */
export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

const baht = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const bahtFixed = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtMoney(v: unknown, opts: { fixed?: boolean; sign?: boolean } = {}): string {
  const n = num(v);
  const s = (opts.fixed ? bahtFixed : baht).format(Math.abs(n));
  const sign = n < 0 ? '−' : opts.sign && n > 0 ? '+' : '';
  return `${sign}฿${s}`;
}

const dtShort = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dtDate = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, day: 'numeric', month: 'short', year: '2-digit' });
const dtDateLong = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
const dtTime = new Intl.DateTimeFormat('th-TH', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

export const fmtDateTime = (iso?: string | null) => (iso ? dtShort.format(new Date(iso)) : '—');
export const fmtDate = (iso?: string | null) => (iso ? dtDate.format(new Date(iso)) : '—');
export const fmtDateLong = (iso?: string | null) => (iso ? dtDateLong.format(new Date(iso)) : '—');
export const fmtTime = (iso?: string | null) => (iso ? dtTime.format(new Date(iso)) : '—');

/** วันที่ (YYYY-MM-DD) ตามเวลาไทย */
export function bangkokDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00+07:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return bangkokDate(d);
}

/** ตัดช่องว่าง . - ออก ให้ตรงกับ vehicles.plate_norm (upper) */
export function plateNorm(p: string): string {
  return p.replace(/[\s.\-]/g, '').toUpperCase();
}

export function vehicleLabel(v: { brand: string | null; model: string | null; year: number | null }): string {
  const name = [v.brand, v.model].filter(Boolean).join(' ');
  return [name || 'ไม่ระบุรุ่น', v.year ? `ปี ${v.year}` : null].filter(Boolean).join(' ');
}

export function relativeDay(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'วันนี้';
  if (days === 1) return 'เมื่อวาน';
  if (days < 30) return `${days} วันก่อน`;
  if (days < 365) return `${Math.floor(days / 30)} เดือนก่อน`;
  return `${Math.floor(days / 365)} ปีก่อน`;
}

export function cx(...a: (string | false | null | undefined)[]): string {
  return a.filter(Boolean).join(' ');
}
