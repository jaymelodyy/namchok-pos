'use client';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2, X } from 'lucide-react';
import { cx, fmtMoney } from '@/lib/format';
import { STATUS_LABEL } from '@/lib/labels';
import type { JobStatus } from '@/lib/types';
import { DEFAULT_PROVINCE, PROVINCES } from '@/lib/provinces';

// ---------- ปุ่ม ----------
type Variant = 'primary' | 'outline' | 'ghost' | 'danger';
export function Button({
  variant = 'primary', small, loading, className, children, disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx('btn', `btn-${variant}`, small && 'btn-sm', className)}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Spinner({ label = 'กำลังโหลด' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-16 text-dim">
      <Loader2 className="h-5 w-5 animate-spin text-gold" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="mx-4 my-6 rounded-xl border border-bad/40 bg-bad/10 p-4 text-[15px]">
      <p className="text-ivory">{message}</p>
      {onRetry && <Button variant="outline" small className="mt-3" onClick={onRetry}>ลองอีกครั้ง</Button>}
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="px-6 py-14 text-center">
      <p className="font-display text-lg font-semibold">{title}</p>
      {hint && <p className="mx-auto mt-1.5 max-w-xs text-[15px] text-dim">{hint}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

// ---------- ฟอร์ม ----------
export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Segmented<T extends string>({
  value, onChange, options, label,
}: { value: T; onChange: (v: T) => void; options: { value: T; label: string; tone?: 'ok' | 'bad' | 'mute' }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1.5">
      {options.map((o) => {
        const on = o.value === value;
        const tone = o.tone === 'bad' ? 'border-bad bg-bad/15 text-bad' : o.tone === 'ok' ? 'border-ok bg-ok/15 text-ok' : 'border-gold bg-gold/15 text-gold-hi';
        return (
          <button
            key={o.value} type="button" role="radio" aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cx(
              'min-h-[44px] flex-1 rounded-lg border px-2 text-[15px] font-medium transition-colors',
              on ? tone : 'border-rule bg-inset text-dim hover:text-ivory',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------- แผ่นล่าง / กล่องยืนยัน ----------
export function Sheet({
  open, onClose, title, children, footer,
}: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose; // ใช้ ref เพื่อไม่ให้ effect รันซ้ำ (และแย่งโฟกัส) ทุกครั้งที่หน้าแม่ render
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>('input,textarea,select,button[data-autofocus]')?.focus(), 60);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); clearTimeout(t); };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" role="presentation">
      <div className="absolute inset-0 animate-fadeIn bg-black/70" onClick={onClose} aria-hidden />
      <div
        ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="relative flex max-h-[92dvh] w-full max-w-lg animate-sheetUp flex-col rounded-t-2xl border border-rule bg-raised md:rounded-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-rule px-5 py-3.5">
          <h2 id={titleId} className="font-display text-[18px] font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="ปิด" className="grid h-10 w-10 place-items-center rounded-lg text-dim hover:bg-inset hover:text-ivory">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t border-rule px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">{footer}</div>}
      </div>
    </div>
  );
}

/** กล่องกรอกเหตุผล (ใช้กับ void / ย้อนสถานะ / ยกเลิก / แก้ราคา ฯลฯ — ระบบบังคับเหตุผลทุกครั้งเพื่อลงบันทึกตรวจสอบ) */
export function ReasonSheet({
  open, title, description, confirmLabel, danger, placeholder = 'เช่น ลูกค้าขอลดราคา, บันทึกผิดคัน', onConfirm, onClose, children,
}: {
  open: boolean; title: string; description?: string; confirmLabel: string; danger?: boolean; placeholder?: string;
  onConfirm: (reason: string) => Promise<void>; onClose: () => void; children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setReason(''); setErr(null); setBusy(false); } }, [open]);
  const submit = async () => {
    if (!reason.trim()) { setErr('ต้องระบุเหตุผล'); return; }
    setBusy(true); setErr(null);
    try { await onConfirm(reason.trim()); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Sheet
      open={open} onClose={onClose} title={title}
      footer={
        <div className="flex gap-3">
          <Button variant="ghost" className="flex-1" onClick={onClose} disabled={busy}>ยกเลิก</Button>
          <Button variant={danger ? 'danger' : 'primary'} className="flex-[2]" onClick={submit} loading={busy}>{confirmLabel}</Button>
        </div>
      }
    >
      {description && <p className="mb-4 text-[15px] text-dim">{description}</p>}
      {children}
      <Field label="เหตุผล" htmlFor="reason-input">
        <textarea
          id="reason-input" rows={3} className="field" placeholder={placeholder} value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      {err && <p role="alert" className="mt-3 text-[15px] text-bad">{err}</p>}
    </Sheet>
  );
}

/** กล่องยืนยันการกระทำที่ย้อนกลับไม่ได้ (เช่น ปิดงานออกใบเสร็จ) */
export function ConfirmSheet({
  open, title, description, confirmLabel, onConfirm, onClose, children,
}: { open: boolean; title: string; description?: string; confirmLabel: string; onConfirm: () => Promise<void>; onClose: () => void; children?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setBusy(false); setErr(null); } }, [open]);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await onConfirm(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Sheet
      open={open} onClose={onClose} title={title}
      footer={
        <div className="flex gap-3">
          <Button variant="ghost" className="flex-1" onClick={onClose} disabled={busy}>ยังก่อน</Button>
          <Button className="flex-[2]" onClick={go} loading={busy} data-autofocus>{confirmLabel}</Button>
        </div>
      }
    >
      {description && <p className="text-[15px] text-dim">{description}</p>}
      {children}
      {err && <p role="alert" className="mt-3 text-[15px] text-bad">{err}</p>}
    </Sheet>
  );
}

// ---------- สถานะ / เงิน ----------
const STATUS_TONE: Record<JobStatus, string> = {
  booked: 'border-rule bg-inset text-dim',
  opened: 'border-gold/30 bg-gold/10 text-gold-hi',
  condition_check: 'border-gold/30 bg-gold/10 text-gold-hi',
  quoting: 'border-gold/30 bg-gold/10 text-gold-hi',
  requisition: 'border-gold/30 bg-gold/10 text-gold-hi',
  ready: 'border-gold/30 bg-gold/10 text-gold-hi',
  in_progress: 'border-gold bg-gold text-lacquer',
  qc: 'border-gold bg-gold text-lacquer',
  awaiting_payment: 'border-warn/50 bg-warn/10 text-warn',
  closed: 'border-ok/40 bg-ok/10 text-ok',
  cancelled: 'border-bad/40 bg-bad/10 text-bad',
};
export function StatusBadge({ status, voided }: { status: JobStatus; voided?: boolean }) {
  if (voided) return <span className="inline-flex items-center rounded-full border border-bad/40 bg-bad/10 px-2.5 py-0.5 text-[13px] font-medium text-bad">VOID</span>;
  return (
    <span className={cx('inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[13px] font-medium', STATUS_TONE[status])}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Money({ v, className, fixed, sign }: { v: unknown; className?: string; fixed?: boolean; sign?: boolean }) {
  return <span className={cx('num', className)}>{fmtMoney(v, { fixed, sign })}</span>;
}

// ---------- ป้ายทะเบียนทอง ----------
/** ป้ายแสดงผล: ขนาดควบคุมด้วย font-size ของ className (ลูกใช้หน่วย em) */
export function Plate({ plate, province, className, glint }: { plate: string; province?: string | null; className?: string; glint?: boolean }) {
  return (
    <div className={cx('plate inline-flex flex-col items-center px-[0.55em] pb-[0.22em] pt-[0.12em] leading-none', glint && 'glint', className)}>
      <span className="plate-text whitespace-nowrap text-[1em] leading-[1.15]">{plate}</span>
      {province && <span className="-mt-[0.02em] whitespace-nowrap font-sans text-[0.32em] font-medium leading-tight tracking-wide opacity-80">{province}</span>}
    </div>
  );
}

/** ช่องกรอกทะเบียนแบบป้ายทอง — จุดเด่นของหน้าแรก */
export function PlateInput({
  plate, province, onPlate, onProvince, autoFocus,
}: { plate: string; province: string; onPlate: (v: string) => void; onProvince: (v: string) => void; autoFocus?: boolean }) {
  // จังหวัดเป็นรายการให้เลือก (select) — เดิมใช้ช่องพิมพ์+datalist ซึ่งกรองรายการตามข้อความที่มีอยู่ ทำให้เห็นแค่ "สงขลา" และเปลี่ยนไม่ได้
  const options = PROVINCES.includes(province) || !province ? PROVINCES : [province, ...PROVINCES];
  return (
    <div className="plate glint px-4 pb-3 pt-2 sm:px-8">
      <label htmlFor="plate-input" className="sr-only">ทะเบียนรถ</label>
      <input
        id="plate-input" value={plate} autoFocus={autoFocus}
        onChange={(e) => onPlate(e.target.value)}
        placeholder="กก 1234" maxLength={12} autoComplete="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="search"
        className="plate-text w-full bg-transparent text-center text-[clamp(2.6rem,13vw,4.5rem)] leading-[1.15] placeholder:text-[#1b1406]/25 focus:outline-none"
      />
      <div className="mx-auto flex max-w-[16rem] items-center justify-center border-t border-[#7a5a17]/40 pt-1.5">
        <label htmlFor="plate-province" className="sr-only">จังหวัดบนป้าย</label>
        <select
          id="plate-province" value={province || DEFAULT_PROVINCE} onChange={(e) => onProvince(e.target.value)}
          style={{ colorScheme: 'light' }}
          className="w-full cursor-pointer bg-transparent py-0.5 text-center font-sans text-lg font-semibold text-[#1b1406] [text-align-last:center] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1b1406]/50"
        >
          {options.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-lg bg-inset', className)} aria-hidden />;
}
