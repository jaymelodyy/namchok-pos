'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { MoreHorizontal, Phone, ReceiptText, ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { ChecksPanel } from '@/components/job/checks';
import { AddItemSheet, EDITABLE_STATUSES, ItemsPanel } from '@/components/job/items';
import { CloseSheet, DeliveryDateSheet } from '@/components/job/close';
import { CrewPanel } from '@/components/job/crew';
import { PaymentSheet, PaymentsPanel, RefundSheet } from '@/components/job/payments';
import { QcHistory, QcSheet } from '@/components/job/qc';
import { RequisitionsPanel } from '@/components/job/requisitions';
import { StatusRail } from '@/components/job/status-rail';
import { useToast } from '@/components/providers';
import { Button, ConfirmSheet, Empty, ErrorNote, Money, Plate, ReasonSheet, Sheet, Skeleton, StatusBadge } from '@/components/ui';
import {
  acceptJob, advanceJob, approveDiscounts, approveQuote, cancelJob, loadJob, revertJob, voidJob, type JobDetail,
} from '@/lib/api';
import { useLive } from '@/lib/realtime';
import { LiveDot } from '@/components/live-notifier';
import { useSession } from '@/lib/auth';
import { cx, fmtDate, fmtDateTime, fmtMoney, vehicleLabel } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { SOURCE_LABEL, STATUS_FLOW, STATUS_LABEL } from '@/lib/labels';
import type { JobStatus } from '@/lib/types';

interface Primary { label: string; run?: () => Promise<void>; confirm?: { title: string; text: string }; disabled?: boolean; hint?: string; href?: string; secondary?: boolean }

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { role, isOwner, canSeeMoney, profile } = useSession();
  const st = useAsync(() => loadJob(id), [id]);

  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [qcOpen, setQcOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [delivery, setDelivery] = useState(false);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<null | 'revert' | 'cancel' | 'void'>(null);
  const [confirming, setConfirming] = useState<Primary | null>(null);
  const [busy, setBusy] = useState(false);

  const d = st.data;
  // ใบงานนี้เปลี่ยน (สถานะ / ช่างรับงาน / คลังส่งมอบ / รับเงิน / QC) → โหลดใหม่ทันที ; ใบงานอื่นเปลี่ยนไม่เกี่ยวกับหน้านี้
  const live = useLive(['job_orders', 'job_assignments', 'requisitions', 'payments', 'refunds', 'qc_checks'], (evs) => {
    if (evs.length === 0 || evs.some((e) => e.record?.job_id === id || e.record?.id === id)) void st.reload();
  });
  const isAdminLike = role === 'owner' || role === 'admin';

  const act = async (fn: () => Promise<unknown>, okText?: string) => {
    setBusy(true);
    try { await fn(); if (okText) toast.ok(okText); await st.reload(); }
    catch (e) { toast.err(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const primary = useMemo<Primary | null>(() => (d ? primaryAction(d, role, id, (fn, ok) => act(fn, ok), {
    pay: () => setPaying(true), qc: () => setQcOpen(true), close: () => setClosing(true),
  }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d, role, id]);

  if (st.loading) return <><PageHeader title="ใบงาน" back="/jobs" /><div className="space-y-3 p-4"><Skeleton className="h-40" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div></>;
  if (st.error && !d) return <><PageHeader title="ใบงาน" back="/jobs" /><ErrorNote message={st.error} onRetry={() => void st.reload()} /></>;
  if (!d) return <><PageHeader title="ใบงาน" back="/jobs" /><Empty title="ไม่พบใบงานนี้" hint="ใบงานอาจถูกลบออกจากมุมมองของคุณ หรือคุณไม่มีสิทธิ์ดู" /></>;

  const { job, items, checks, payments, refunds, log, discountBlocked, crew, requisitions, qc } = d;
  const editable = isAdminLike && EDITABLE_STATUSES.includes(job.status) && !job.voided_at;
  const checksFirst = job.status === 'opened' || job.status === 'condition_check';
  const missing = checks.filter((c) => !c.completed).length;
  const inFlow = job.status !== 'closed' && job.status !== 'cancelled' && !job.voided_at;
  const idx = STATUS_FLOW.indexOf(job.status);
  const revertTargets = idx > 0 ? STATUS_FLOW.slice(0, idx) : [];
  // งานที่ QC ไม่ผ่านแล้วถูกส่งกลับ: ช่างต้องเห็น "ต้องแก้อะไร" ทันทีที่เปิดใบงาน (เหตุผลมาจากประวัติสถานะ ซึ่งช่างอ่านได้ ส่วนตาราง QC ช่างอ่านไม่ได้)
  const lastLog = log[log.length - 1];
  const QC_PREFIX = 'QC ไม่ผ่าน: ';
  const qcReturn = job.status === 'in_progress' && lastLog?.from_status === 'qc' && lastLog.to_status === 'in_progress' && lastLog.reason?.startsWith(QC_PREFIX)
    ? lastLog.reason.slice(QC_PREFIX.length) : null;

  const itemsBlock = (
    <ItemsPanel key="items" items={items} canEdit={editable} showMoney={canSeeMoney} onAdd={() => setAdding(true)} onChanged={() => void st.reload()} />
  );
  const checksBlock = job.status === 'booked' ? null : (
    <ChecksPanel key="checks" jobId={job.id} status={job.status} checks={checks} canReopen={isAdminLike} onChanged={() => void st.reload()} />
  );

  return (
    <>
      <PageHeader
        title={job.job_no} subtitle={fmtDateTime(job.created_at)} back="/jobs"
        right={
          <div className="flex items-center gap-1">
            <LiveDot status={live} className="mr-1" />
            {job.voided_at && <StatusBadge status={job.status} voided />}
            {isAdminLike && <button type="button" onClick={() => setMenu(true)} aria-label="เมนูเพิ่มเติม" className="grid h-11 w-11 place-items-center rounded-lg text-dim hover:bg-inset hover:text-ivory"><MoreHorizontal className="h-5 w-5" /></button>}
          </div>
        }
      />

      <div className="space-y-7 pb-28 pt-5">
        {/* ข้อมูลรถ/ลูกค้า + แถบสถานะ */}
        <section className="px-4" aria-label="ข้อมูลใบงาน">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
            <Plate plate={job.plate} province={job.plate_province} className="shrink-0 text-[2.1rem]" />
            <div className="min-w-[10.5rem] flex-1 pt-0.5">
              <p className="break-words font-display text-[18px] font-semibold leading-tight">{job.customer_name}</p>
              <p className="text-[14px] text-dim">{vehicleLabel(job)}</p>
              {job.customer_phone && (
                <a href={`tel:${job.customer_phone}`} className="mt-1 inline-flex min-h-[32px] items-center gap-1.5 text-[14px] text-gold-hi hover:underline">
                  <Phone className="h-3.5 w-3.5" aria-hidden /><span className="num">{job.customer_phone}</span>
                </a>
              )}
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-[14px]">
            {job.odometer != null && <><dt className="text-mute">เลขไมล์</dt><dd className="num text-right">{job.odometer.toLocaleString('th-TH')} กม.</dd></>}
            <dt className="text-mute">รู้จักร้านจาก</dt><dd className="text-right">{SOURCE_LABEL[job.source]}</dd>
            {job.status === 'closed' && job.delivered_on && <><dt className="text-mute">ส่งมอบรถ</dt><dd className="num text-right" data-testid="delivered-on">{fmtDate(`${job.delivered_on}T12:00:00+07:00`)}</dd></>}
            {job.scheduled_at && job.status === 'booked' && <><dt className="text-mute">นัดมา</dt><dd className="text-right">{fmtDateTime(job.scheduled_at)}</dd></>}
          </dl>
          {job.complaint && <p className="mt-3 rounded-lg border border-rule bg-raised px-3.5 py-2.5 text-[15px]"><span className="text-mute">อาการ  </span>{job.complaint}</p>}
          {job.voided_at && <p role="alert" className="mt-3 rounded-lg border border-bad/40 bg-bad/10 px-3.5 py-2.5 text-[14px] text-bad">ใบงานนี้ถูก void แล้ว ไม่นับในรายงานรายได้</p>}
          {job.status === 'cancelled' && <p className="mt-3 rounded-lg border border-bad/40 bg-bad/10 px-3.5 py-2.5 text-[14px] text-bad">ยกเลิกแล้ว: {job.cancel_reason}</p>}
          <div className="mt-5"><StatusRail status={job.status} /></div>
        </section>

        {qcReturn && (
          <div role="alert" className="mx-4 rounded-xl border border-bad/50 bg-bad/10 p-4 text-[15px]" data-testid="qc-return">
            <p className="font-medium text-bad">QC ไม่ผ่าน — ส่งกลับให้แก้งาน</p>
            <p className="mt-1 break-words text-dim">{qcReturn}</p>
          </div>
        )}

        {discountBlocked && inFlow && (
          <div role="alert" className="mx-4 rounded-xl border border-warn/50 bg-warn/10 p-4 text-[15px]">
            <p className="font-medium text-warn">ส่วนลดเกินเพดานที่เจ้าของกำหนด</p>
            <p className="mt-1 text-dim">{isOwner ? 'ตรวจรายการส่วนลดแล้วกดอนุมัติเพื่อให้อนุมัติใบเสนอราคาต่อได้' : 'ต้องให้เจ้าของอนุมัติส่วนลดก่อน จึงจะอนุมัติใบเสนอราคาได้'}</p>
            {isOwner && <Button className="mt-3" small onClick={() => void act(() => approveDiscounts(job.id), 'อนุมัติส่วนลดแล้ว')} loading={busy}><ShieldCheck className="h-4 w-4" aria-hidden />อนุมัติส่วนลด</Button>}
          </div>
        )}

        {checksFirst ? <>{checksBlock}{itemsBlock}</> : <>{itemsBlock}{checksBlock}</>}

        {isAdminLike && <RequisitionsPanel reqs={requisitions} onChanged={() => void st.reload()} />}
        <CrewPanel jobId={job.id} status={job.status} crew={crew} role={role} canManage={isAdminLike} onChanged={() => void st.reload()} />
        {isAdminLike && <QcHistory checks={qc} />}

        {/* สรุปยอด — ราคาในใบงานรวม VAT แล้ว ; ช่างไม่เห็นตัวเลขเงิน */}
        {canSeeMoney && items.length > 0 && (
          <section className="px-4" aria-labelledby="sum-h">
            <h2 id="sum-h" className="section-title mb-2">สรุปยอด</h2>
            <dl className="space-y-1.5 text-[15px]">
              <Row k="รวมรายการ" v={fmtMoney(job.gross)} />
              {job.discount > 0 && <Row k="ส่วนลด" v={fmtMoney(-job.discount)} tone="warn" />}
              <div className="flex items-baseline justify-between border-t border-rule pt-2.5">
                <dt className="font-display text-[17px] font-semibold">ยอดสุทธิ{job.vat > 0 ? ' (รวม VAT แล้ว)' : ''}</dt>
                <dd className="num font-display text-[26px] font-bold text-gold-hi" data-testid="grand-total">{fmtMoney(job.grand_total)}</dd>
              </div>
              {job.vat > 0 && (
                <p className="text-right text-[13px] text-mute" data-testid="vat-note">
                  ในนี้เป็น VAT <span className="num">{fmtMoney(job.vat, { fixed: true })}</span> · ก่อน VAT <span className="num">{fmtMoney(job.ex_vat, { fixed: true })}</span>
                </p>
              )}
              {job.paid_total > 0 && <Row k={job.refunded_total > 0 ? 'รับสุทธิ (หักที่คืนแล้ว)' : 'รับแล้ว'} v={fmtMoney(job.paid_total)} tone="ok" />}
              {job.refunded_total > 0 && <Row k="คืนเงินลูกค้าแล้ว" v={fmtMoney(job.refunded_total)} tone="warn" />}
              {(job.paid_total > 0 || job.refunded_total > 0) && <Row k="ค้างชำระ" v={fmtMoney(job.balance)} tone={job.balance > 0 ? 'warn' : 'ok'} />}
            </dl>
          </section>
        )}

        {canSeeMoney && job.status !== 'booked' && (
          <PaymentsPanel
            job={job} payments={payments} refunds={refunds} isOwner={isOwner} onChanged={() => void st.reload()}
            onDeposit={inFlow && job.status !== 'awaiting_payment' && items.length > 0 ? () => setPaying(true) : undefined}
            onRefund={inFlow && job.paid_total > 0 ? () => setRefunding(true) : undefined}
          />
        )}

        {job.status === 'closed' && (
          <div className="px-4">
            <Link href={`/jobs/${job.id}/receipt`} className="btn btn-outline w-full"><ReceiptText className="h-4 w-4" aria-hidden />ดูใบเสร็จและใบรับประกัน</Link>
          </div>
        )}

        {log.length > 0 && (
          <section className="px-4" aria-labelledby="log-h">
            <h2 id="log-h" className="section-title mb-2">ประวัติสถานะ</h2>
            <ol className="space-y-2 border-l border-rule pl-4">
              {[...log].reverse().map((l) => (
                <li key={l.id} className="relative text-[14px]">
                  <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-gold-lo" aria-hidden />
                  <p>{l.from_status ? `${STATUS_LABEL[l.from_status]} เป็น ${STATUS_LABEL[l.to_status]}` : STATUS_LABEL[l.to_status]}</p>
                  <p className="text-[12px] text-mute">{fmtDateTime(l.created_at)}{l.reason ? `  ${l.reason}` : ''}</p>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      {/* แถบปุ่มทำขั้นถัดไป */}
      {primary && !job.voided_at && (
        <div className="no-print fixed inset-x-0 bottom-[calc(60px+env(safe-area-inset-bottom))] z-30 border-t border-rule bg-lacquer/95 px-4 py-3 backdrop-blur lg:bottom-0 lg:left-24">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            {primary.hint && <p className="min-w-0 flex-1 text-[13px] text-warn">{primary.hint}</p>}
            {primary.href ? (
              <Link href={primary.href} className="btn btn-primary ml-auto flex-1">{primary.label}</Link>
            ) : (
              <Button
                className={cx('flex-1', !primary.hint && 'w-full')} loading={busy} disabled={primary.disabled}
                variant={primary.secondary ? 'outline' : 'primary'}
                onClick={() => (primary.confirm ? setConfirming(primary) : void primary.run?.())}
              >{primary.label}</Button>
            )}
          </div>
        </div>
      )}

      <AddItemSheet open={adding} jobId={job.id} onClose={() => setAdding(false)} onAdded={() => { void st.reload(); toast.ok('เพิ่มรายการแล้ว'); }} />
      <PaymentSheet open={paying} job={job} branchId={profile.branch_id} onClose={() => setPaying(false)} onPaid={() => { setPaying(false); toast.ok('บันทึกการรับเงินแล้ว'); void st.reload(); }} />

      <RefundSheet open={refunding} job={job} branchId={profile.branch_id} onClose={() => setRefunding(false)}
        onDone={() => { setRefunding(false); toast.ok('บันทึกการคืนเงินแล้ว'); void st.reload(); }} />
      <QcSheet open={qcOpen} jobId={job.id} branchId={profile.branch_id} onClose={() => setQcOpen(false)}
        onDone={(r) => { setQcOpen(false); toast.ok(r === 'pass' ? 'ผ่าน QC แล้ว' : 'ส่งกลับให้ช่างแก้งานแล้ว'); void st.reload(); }} />
      <CloseSheet open={closing} job={job} onClose={() => setClosing(false)} onClosed={() => { setClosing(false); router.push(`/jobs/${job.id}/receipt`); }} />
      <DeliveryDateSheet open={delivery} job={job} onClose={() => setDelivery(false)}
        onDone={() => { setDelivery(false); toast.ok('แก้วันที่ส่งมอบแล้ว — คำนวณประกันใหม่'); void st.reload(); }} />

      <ConfirmSheet
        open={Boolean(confirming)} title={confirming?.confirm?.title ?? ''} description={confirming?.confirm?.text} confirmLabel={confirming?.label ?? ''}
        onClose={() => setConfirming(null)}
        onConfirm={async () => { await confirming!.run!(); setConfirming(null); }}
      />

      <Sheet open={menu} onClose={() => setMenu(false)} title="จัดการใบงาน">
        <ul className="ledger overflow-hidden rounded-xl border border-rule">
          {revertTargets.length > 0 && inFlow && <MenuItem label="ย้อนสถานะ" hint="ใช้เมื่อต้องแก้ไขรายการหรือเช็คสภาพใหม่ ต้องระบุเหตุผล" onClick={() => { setMenu(false); setDialog('revert'); }} />}
          {inFlow && <MenuItem label="ยกเลิกใบงาน" danger hint="ถ้ามีเงินรับไว้ ต้อง &quot;คืนเงิน&quot; ลูกค้าให้ครบก่อน (void ใช้เฉพาะรายการที่บันทึกผิด)" onClick={() => { setMenu(false); setDialog('cancel'); }} />}
          {job.status === 'closed' && !job.voided_at && <MenuItem label="แก้วันที่ส่งมอบ" hint="ใช้เมื่อลูกค้ามารับรถคนละวันกับที่บันทึก — ประกันจะนับใหม่" onClick={() => { setMenu(false); setDelivery(true); }} />}
          {isOwner && job.status === 'closed' && <MenuItem label="Void ใบงานที่ปิดแล้ว" danger hint="ใช้เมื่อบันทึกผิดคัน ใบเสร็จและใบรับประกันจะถูก void ตาม" onClick={() => { setMenu(false); setDialog('void'); }} />}
          {!(inFlow && revertTargets.length > 0) && !inFlow && job.status !== 'closed' && <li className="px-4 py-3 text-[15px] text-mute">ไม่มีการจัดการเพิ่มเติมสำหรับสถานะนี้</li>}
        </ul>
      </Sheet>

      <RevertSheet
        open={dialog === 'revert'} targets={revertTargets} onClose={() => setDialog(null)}
        onConfirm={async (target, reason) => { await revertJob(job.id, target, reason); setDialog(null); toast.ok('ย้อนสถานะแล้ว'); await st.reload(); }}
      />
      <ReasonSheet
        open={dialog === 'cancel'} danger title="ยกเลิกใบงาน" confirmLabel="ยกเลิกใบงาน"
        description={`ใบงานจะไม่ถูกลบ แต่เปลี่ยนเป็นสถานะยกเลิกและเก็บเหตุผลไว้${job.paid_total > 0 ? ` — ตอนนี้ยังรับเงินสุทธิ ${fmtMoney(job.paid_total)} ต้องกด "คืนเงิน" ให้ครบก่อนจึงยกเลิกได้` : ''}`}
        onClose={() => setDialog(null)}
        onConfirm={async (r) => { await cancelJob(job.id, r); setDialog(null); toast.ok('ยกเลิกใบงานแล้ว'); await st.reload(); }}
      />
      <ReasonSheet
        open={dialog === 'void'} danger title="Void ใบงานที่ปิดแล้ว" confirmLabel="Void ใบงาน"
        description="ต้อง void รายการรับเงินทุกรายการก่อน ระบบจะ void ใบเสร็จและใบรับประกันของใบงานนี้ตาม และไม่นับในรายงานรายได้"
        onClose={() => setDialog(null)}
        onConfirm={async (r) => { await voidJob(job.id, r); setDialog(null); toast.ok('Void ใบงานแล้ว'); await st.reload(); }}
      />
    </>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-dim">{k}</dt>
      <dd className={cx('num', tone === 'ok' && 'text-ok', tone === 'warn' && 'text-warn')}>{v}</dd>
    </div>
  );
}

function MenuItem({ label, hint, danger, onClick }: { label: string; hint: string; danger?: boolean; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} className="w-full px-4 py-3.5 text-left transition-colors hover:bg-inset">
        <span className={cx('block font-medium', danger && 'text-bad')}>{label}</span>
        <span className="block text-[13px] text-mute">{hint}</span>
      </button>
    </li>
  );
}

function RevertSheet({ open, targets, onClose, onConfirm }: {
  open: boolean; targets: JobStatus[]; onClose: () => void; onConfirm: (t: JobStatus, reason: string) => Promise<void>;
}) {
  const [target, setTarget] = useState<JobStatus | ''>('');
  const t = (target || targets[targets.length - 1]) as JobStatus | undefined;
  return (
    <ReasonSheet
      open={open} title="ย้อนสถานะ" confirmLabel="ย้อนสถานะ"
      description="ถ้ามีการรับชำระยอดบิลแล้ว ต้อง void รายการรับเงินก่อน การย้อนไปขั้นเสนอราคาจะล้างการอนุมัติใบเสนอราคา"
      onClose={onClose}
      onConfirm={(r) => onConfirm(t!, r)}
    >
      <div className="mb-4">
        <label className="label" htmlFor="revert-target">ย้อนไปที่ขั้น</label>
        <select id="revert-target" className="field" value={t ?? ''} onChange={(e) => setTarget(e.target.value as JobStatus)}>
          {targets.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </div>
    </ReasonSheet>
  );
}

// ---------- ปุ่มหลักตามสถานะ/บทบาท ----------
function primaryAction(
  d: JobDetail, role: string, id: string,
  act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>,
  open: { pay: () => void; qc: () => void; close: () => void },
): Primary | null {
  const { job, items, checks, discountBlocked, crew, requisitions } = d;
  const adminLike = role === 'owner' || role === 'admin';
  const isTech = role === 'technician';
  const missing = checks.filter((c) => !c.completed).length;
  const hasLines = items.some((i) => i.item_type !== 'discount' && i.item_type !== 'bundle');
  const openReqs = requisitions.filter((r) => r.status === 'requested' || r.status === 'prepared').length;
  const slots = crew ? Math.max(0, crew.crew_required - crew.crew_active) : 0;

  switch (job.status) {
    case 'booked':
      return adminLike ? { label: 'รับรถเข้าร้าน', run: () => act(() => advanceJob(id), 'รับรถเข้าร้านแล้ว') } : null;
    case 'opened':
      return adminLike ? { label: 'เริ่มเช็คสภาพรถ', run: () => act(() => advanceJob(id), 'เข้าสู่ขั้นเช็คสภาพ') } : null;
    case 'condition_check':
      return adminLike ? {
        label: 'ไปขั้นเสนอราคา', disabled: missing > 0,
        hint: missing > 0 ? `เช็คสภาพยังไม่ครบ ${missing} ฟอร์ม` : undefined,
        run: () => act(() => advanceJob(id), 'เข้าสู่ขั้นเสนอราคา'),
      } : null;
    case 'quoting':
      return adminLike ? {
        label: 'ลูกค้าอนุมัติใบเสนอราคา', disabled: !hasLines || discountBlocked,
        hint: !hasLines ? 'ยังไม่มีรายการในใบเสนอราคา' : discountBlocked ? 'รอเจ้าของอนุมัติส่วนลด' : undefined,
        confirm: { title: 'ลูกค้าอนุมัติใบเสนอราคาแล้ว?', text: 'หลังอนุมัติจะแก้ไขรายการไม่ได้ ถ้าต้องแก้ต้องย้อนสถานะพร้อมเหตุผล ระบบจะส่งคำขอเบิกอะไหล่ให้คลังอัตโนมัติ' },
        run: () => act(() => approveQuote(id), 'อนุมัติใบเสนอราคาแล้ว'),
      } : null;
    case 'requisition':
      if (!adminLike) return null;
      return openReqs > 0
        ? { label: 'รอคลังส่งมอบอะไหล่', disabled: true, hint: `คลังยังไม่ส่งมอบ ${openReqs} คำขอ — เมื่อส่งมอบครบ ใบงานจะเป็น "พร้อมเริ่มงาน" เอง` }
        : { label: 'ไม่มีอะไหล่ต้องเบิก — ไปขั้นพร้อมเริ่มงาน', run: () => act(() => advanceJob(id), 'พร้อมเริ่มงาน') };
    case 'ready':
      if (isTech) {
        if (crew?.mine) return { label: 'เริ่มงาน', disabled: missing > 0, hint: missing > 0 ? `เช็คสภาพยังไม่ครบ ${missing} ฟอร์ม` : undefined, run: () => act(() => advanceJob(id), 'เริ่มงานแล้ว') };
        return slots > 0
          ? { label: 'รับงานนี้', run: () => act(() => acceptJob(id), 'รับงานแล้ว') }
          : { label: 'มีช่างรับครบแล้ว', disabled: true };
      }
      return {
        label: 'เริ่มงาน', disabled: missing > 0 || (crew?.crew_active ?? 0) < 1,
        hint: missing > 0 ? `เช็คสภาพยังไม่ครบ ${missing} ฟอร์ม` : (crew?.crew_active ?? 0) < 1 ? 'ยังไม่มีช่างรับงาน — มอบหมายช่างหรือรอช่างกดรับ' : undefined,
        run: () => act(() => advanceJob(id), 'เริ่มงานแล้ว'),
      };
    case 'in_progress':
      if (isTech && !crew?.mine) return slots > 0 ? { label: 'เข้าร่วมงานนี้', run: () => act(() => acceptJob(id), 'เข้าร่วมงานแล้ว') } : null;
      return { label: 'ส่งตรวจ QC', run: () => act(() => advanceJob(id), 'ส่งตรวจ QC แล้ว') };
    case 'qc':
      return adminLike ? { label: 'บันทึกผล QC', run: async () => open.qc() } : null;
    case 'awaiting_payment':
      if (!adminLike) return null;
      return job.balance > 0
        ? { label: `รับชำระ ค้าง ${fmtMoney(job.balance)}`, run: async () => open.pay() }
        : { label: 'ปิดงานและออกใบเสร็จ', run: async () => open.close() };
    case 'closed':
      return adminLike ? { label: 'ดูใบเสร็จ', href: `/jobs/${id}/receipt`, secondary: true } : null;
    default:
      return null;
  }
}
