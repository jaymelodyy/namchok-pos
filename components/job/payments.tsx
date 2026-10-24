'use client';
import { useEffect, useRef, useState } from 'react';
import { Banknote, Image as ImageIcon, QrCode, Landmark, Undo2 } from 'lucide-react';
import { recordPayment, refundPayment, signedUrls, uploadFile, voidPayment, voidRefund } from '@/lib/api';
import { compressImage } from '@/lib/image';
import { cx, fmtDateTime, fmtMoney, num } from '@/lib/format';
import { METHOD_LABEL } from '@/lib/labels';
import type { PayMethod, Payment, Refund, VJob } from '@/lib/types';
import { Button, Field, Money, ReasonSheet, Segmented, Sheet } from '../ui';

const METHOD_ICON: Record<PayMethod, typeof Banknote> = { cash: Banknote, qr_promptpay: QrCode, transfer: Landmark };

async function viewSlip(path: string | null) {
  if (!path) return;
  const w = window.open('about:blank', '_blank');
  try {
    const urls = await signedUrls([path]);
    if (w && urls[path]) w.location.href = urls[path]; else w?.close();
  } catch { w?.close(); }
}

export function PaymentsPanel({
  job, payments, refunds, isOwner, onChanged, onDeposit, onRefund,
}: {
  job: VJob; payments: Payment[]; refunds: Refund[]; isOwner: boolean; onChanged: () => void;
  onDeposit?: () => void; onRefund?: () => void;
}) {
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const [voidingRefund, setVoidingRefund] = useState<Refund | null>(null);

  return (
    <section aria-labelledby="pay-h">
      <div className="flex items-center justify-between px-4 pb-2">
        <h2 id="pay-h" className="section-title">การรับเงิน</h2>
        <div className="flex gap-2">
          {onRefund && <Button small variant="outline" onClick={onRefund}><Undo2 className="h-4 w-4" aria-hidden />คืนเงิน</Button>}
          {onDeposit && <Button small variant="outline" onClick={onDeposit}>รับมัดจำ</Button>}
        </div>
      </div>
      {payments.length === 0 ? (
        <p className="px-4 pb-2 text-[15px] text-mute">ยังไม่มีการรับเงิน</p>
      ) : (
        <ul className="ledger border-y border-rule">
          {payments.map((p) => {
            const Icon = METHOD_ICON[p.method];
            const voided = Boolean(p.voided_at);
            const canVoid = !voided && job.status !== 'cancelled' && (job.status !== 'closed' || isOwner) && !job.voided_at;
            return (
              <li key={p.id} className="flex items-start gap-3 px-4 py-3">
                <Icon className={cx('mt-0.5 h-5 w-5 shrink-0', voided ? 'text-mute' : 'text-gold')} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className={cx('font-medium', voided && 'text-mute line-through')}>
                    {p.kind === 'deposit' ? 'มัดจำ' : 'ชำระ'} {METHOD_LABEL[p.method]}
                  </p>
                  <p className="text-[13px] text-mute">{fmtDateTime(p.received_at)}{p.reference_no ? `  อ้างอิง ${p.reference_no}` : ''}</p>
                  {voided && <p className="text-[13px] text-bad">void: {p.void_reason}</p>}
                  <div className="mt-1 flex gap-1">
                    {p.slip_path && <Button variant="ghost" small onClick={() => void viewSlip(p.slip_path)}><ImageIcon className="h-4 w-4" aria-hidden />ดูสลิป</Button>}
                    {canVoid && <Button variant="ghost" small className="text-bad" onClick={() => setVoiding(p)}>void</Button>}
                  </div>
                </div>
                <Money v={p.amount} className={cx('font-medium', voided && 'text-mute line-through')} />
              </li>
            );
          })}
        </ul>
      )}
      {refunds.length > 0 && (
        <div className="mt-4">
          <h3 className="px-4 pb-1.5 text-[14px] font-medium text-dim">เงินที่คืนลูกค้า</h3>
          <ul className="ledger border-y border-rule" data-testid="refund-list">
            {refunds.map((r) => {
              const voided = Boolean(r.voided_at);
              const canVoid = !voided && isOwner && !job.voided_at;
              return (
                <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                  <Undo2 className={cx('mt-0.5 h-5 w-5 shrink-0', voided ? 'text-mute' : 'text-warn')} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className={cx('font-medium', voided && 'text-mute line-through')}>คืนเงิน {METHOD_LABEL[r.method]}</p>
                    <p className="text-[13px] text-mute">{fmtDateTime(r.refunded_at)}{r.reference_no ? `  อ้างอิง ${r.reference_no}` : ''}</p>
                    <p className="text-[13px] text-dim">เหตุผล: {r.reason}</p>
                    {voided && <p className="text-[13px] text-bad">void: {r.void_reason}</p>}
                    <div className="mt-1 flex gap-1">
                      {r.slip_path && <Button variant="ghost" small onClick={() => void viewSlip(r.slip_path)}><ImageIcon className="h-4 w-4" aria-hidden />ดูสลิป</Button>}
                      {canVoid && <Button variant="ghost" small className="text-bad" onClick={() => setVoidingRefund(r)}>void</Button>}
                    </div>
                  </div>
                  <Money v={-r.amount} className={cx('font-medium text-warn', voided && 'text-mute line-through')} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <ReasonSheet
        open={Boolean(voidingRefund)} danger title="Void รายการคืนเงิน" confirmLabel="Void รายการนี้"
        description={voidingRefund ? `คืนเงิน ${METHOD_LABEL[voidingRefund.method]} ${fmtMoney(voidingRefund.amount)} — ยอดรับสุทธิของใบงานจะกลับมารวมเงินก้อนนี้อีกครั้ง` : undefined}
        placeholder="เช่น บันทึกคืนเงินผิดใบงาน"
        onClose={() => setVoidingRefund(null)}
        onConfirm={async (r) => { await voidRefund(voidingRefund!.id, r); setVoidingRefund(null); onChanged(); }}
      />
      <ReasonSheet
        open={Boolean(voiding)} danger title="Void รายการรับเงิน" confirmLabel="Void รายการนี้"
        description={voiding ? `${voiding.kind === 'deposit' ? 'มัดจำ' : 'ชำระ'} ${METHOD_LABEL[voiding.method]} ${fmtMoney(voiding.amount)} — ไม่ลบข้อมูล แต่ตัดออกจากยอดรับและเก็บประวัติไว้` : undefined}
        placeholder="เช่น คืนเงินลูกค้า, กรอกยอดผิด"
        onClose={() => setVoiding(null)}
        onConfirm={async (r) => { await voidPayment(voiding!.id, r); setVoiding(null); onChanged(); }}
      />
    </section>
  );
}

export function PaymentSheet({
  open, job, branchId, onClose, onPaid,
}: { open: boolean; job: VJob; branchId: string; onClose: () => void; onPaid: () => void }) {
  const kind = job.status === 'awaiting_payment' ? 'payment' : 'deposit';
  const [method, setMethod] = useState<PayMethod>('cash');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [slip, setSlip] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setMethod('cash'); setAmount(kind === 'payment' ? String(job.balance) : ''); setReference(''); setNote('');
      setSlip(null); setErr(null); setBusy(false);
    }
  }, [open, kind, job.balance]);

  const needSlip = method !== 'cash';
  const amt = num(amount);
  const over = kind === 'payment' && amt > job.balance;
  const overDeposit = kind === 'deposit' && job.grand_total > 0 && job.paid_total + amt > job.grand_total;
  const invalid = !(amt > 0) || over || overDeposit || (needSlip && !slip);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      let slipPath: string | undefined;
      if (needSlip && slip) {
        const img = await compressImage(slip);
        slipPath = await uploadFile(`${branchId}/${job.id}/slip/${crypto.randomUUID()}.${img.ext}`, img.blob, img.type);
      }
      await recordPayment({ jobId: job.id, kind, method, amount: amt, reference, slipPath, note });
      onPaid();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  return (
    <Sheet
      open={open} onClose={onClose} title={kind === 'payment' ? 'รับชำระเงิน' : 'รับเงินมัดจำ'}
      footer={<Button className="w-full" onClick={submit} loading={busy} disabled={invalid}>{kind === 'payment' ? 'บันทึกการรับเงิน' : 'บันทึกมัดจำ'} {amt > 0 ? fmtMoney(amt) : ''}</Button>}
    >
      <div className="space-y-5">
        <div className="flex items-baseline justify-between rounded-xl border border-rule bg-inset px-4 py-3">
          <span className="text-dim">{kind === 'payment' ? 'ยอดค้างชำระ' : 'ยอดบิลตอนนี้'}</span>
          <Money v={kind === 'payment' ? job.balance : job.grand_total} className="font-display text-xl font-semibold text-gold-hi" />
        </div>
        <Field label="วิธีรับเงิน">
          <Segmented
            label="วิธีรับเงิน" value={method} onChange={setMethod}
            options={(Object.keys(METHOD_LABEL) as PayMethod[]).map((m) => ({ value: m, label: METHOD_LABEL[m] }))}
          />
        </Field>
        <Field label="จำนวนเงิน (บาท)" htmlFor="pay-amt"
          hint={over ? undefined : kind === 'payment' && amt < job.balance && amt > 0 ? `จ่ายบางส่วน คงเหลือ ${fmtMoney(job.balance - amt)}` : undefined}>
          <input id="pay-amt" className="field num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
          {over && <p role="alert" className="mt-1 text-[13px] text-bad">เกินยอดค้างชำระ {fmtMoney(job.balance)}</p>}
          {overDeposit && <p role="alert" className="mt-1 text-[13px] text-bad">มัดจำรวมเกินยอดบิล {fmtMoney(job.grand_total)}</p>}
        </Field>
        {needSlip && (
          <>
            <Field label="แนบสลิป (ต้องมี เพื่อให้แอดมินยืนยันยอด)">
              <input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="เลือกรูปสลิป"
                onChange={(e) => setSlip(e.target.files?.[0] ?? null)} />
              <Button variant="outline" className="w-full" onClick={() => fileRef.current?.click()}>
                <ImageIcon className="h-4 w-4" aria-hidden />{slip ? `เลือกแล้ว: ${slip.name}` : 'ถ่ายรูป / เลือกรูปสลิป'}
              </Button>
            </Field>
            <Field label="เลขอ้างอิงในสลิป (ถ้ามี)" htmlFor="pay-ref">
              <input id="pay-ref" className="field" value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </>
        )}
        <Field label="หมายเหตุ (ถ้ามี)" htmlFor="pay-note"><input id="pay-note" className="field" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {err && <p role="alert" className="text-[15px] text-bad">{err}</p>}
      </div>
    </Sheet>
  );
}

/** คืนเงิน / คืนมัดจำ : ต้องมีเหตุผล ; QR/โอน ต้องแนบสลิปโอนออก ; ห้ามเกินยอดรับสุทธิ */
export function RefundSheet({ open, job, branchId, onClose, onDone }: {
  open: boolean; job: VJob; branchId: string; onClose: () => void; onDone: () => void;
}) {
  const [method, setMethod] = useState<PayMethod>('cash');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [slip, setSlip] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setMethod('cash'); setAmount(''); setReason(''); setReference(''); setSlip(null); setErr(null); setBusy(false); } }, [open]);

  const needSlip = method !== 'cash';
  const amt = num(amount);
  const over = amt > job.paid_total;
  const invalid = !(amt > 0) || over || !reason.trim() || (needSlip && !slip);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      let slipPath: string | undefined;
      if (needSlip && slip) {
        const img = await compressImage(slip);
        slipPath = await uploadFile(`${branchId}/${job.id}/slip/${crypto.randomUUID()}.${img.ext}`, img.blob, img.type);
      }
      await refundPayment({ jobId: job.id, method, amount: amt, reason: reason.trim(), reference, slipPath });
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  return (
    <Sheet
      open={open} onClose={onClose} title="คืนเงินลูกค้า"
      footer={<Button className="w-full" onClick={submit} loading={busy} disabled={invalid}>บันทึกการคืนเงิน {amt > 0 ? fmtMoney(amt) : ''}</Button>}
    >
      <div className="space-y-5">
        <div className="flex items-baseline justify-between rounded-xl border border-rule bg-inset px-4 py-3">
          <span className="text-dim">รับสุทธิแล้ว (หลังหักที่เคยคืน)</span>
          <Money v={job.paid_total} className="font-display text-xl font-semibold text-gold-hi" />
        </div>
        <Field label="คืนด้วยวิธี">
          <Segmented label="คืนด้วยวิธี" value={method} onChange={setMethod}
            options={(Object.keys(METHOD_LABEL) as PayMethod[]).map((m) => ({ value: m, label: METHOD_LABEL[m] }))} />
        </Field>
        <Field label="จำนวนเงินที่คืน (บาท)" htmlFor="rf-amt">
          <input id="rf-amt" className="field num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
          {over && <p role="alert" className="mt-1 text-[13px] text-bad">คืนเกินยอดที่รับไว้ {fmtMoney(job.paid_total)}</p>}
        </Field>
        <Field label="เหตุผล (ต้องระบุ)" htmlFor="rf-reason">
          <input id="rf-reason" className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="เช่น ลูกค้ายกเลิกงาน, ลดรายการบริการ" />
        </Field>
        {needSlip && (
          <>
            <Field label="แนบสลิปโอนเงินคืน (ต้องมี)">
              <input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="เลือกรูปสลิปโอนคืน"
                onChange={(e) => setSlip(e.target.files?.[0] ?? null)} />
              <Button variant="outline" className="w-full" onClick={() => fileRef.current?.click()}>
                <ImageIcon className="h-4 w-4" aria-hidden />{slip ? `เลือกแล้ว: ${slip.name}` : 'ถ่ายรูป / เลือกรูปสลิป'}
              </Button>
            </Field>
            <Field label="เลขอ้างอิง (ถ้ามี)" htmlFor="rf-ref"><input id="rf-ref" className="field" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
          </>
        )}
        {err && <p role="alert" className="text-[15px] text-bad">{err}</p>}
      </div>
    </Sheet>
  );
}
