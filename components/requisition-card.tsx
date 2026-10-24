'use client';
import { Clock } from 'lucide-react';
import { cx, fmtDateTime } from '@/lib/format';
import type { Requisition, RequisitionStatus } from '@/lib/types';
import type { ReactNode } from 'react';

export const REQ_LABEL: Record<RequisitionStatus, string> = {
  requested: 'ขอเบิก', prepared: 'จัดเตรียมแล้ว', delivered: 'ส่งมอบแล้ว', void: 'ยกเลิก',
};
const REQ_TONE: Record<RequisitionStatus, string> = {
  requested: 'border-warn/50 bg-warn/10 text-warn',
  prepared: 'border-gold/40 bg-gold/10 text-gold-hi',
  delivered: 'border-ok/40 bg-ok/10 text-ok',
  void: 'border-rule bg-inset text-mute',
};
export function ReqBadge({ status }: { status: RequisitionStatus }) {
  return <span className={cx('inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[13px] font-medium', REQ_TONE[status])}>{REQ_LABEL[status]}</span>;
}

/** นาทีที่ผ่านมา → "3 นาทีที่แล้ว" */
export function ago(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'เมื่อสักครู่';
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ชม.ที่แล้ว`;
  return `${Math.floor(h / 24)} วันที่แล้ว`;
}

export function attrText(a: Record<string, string>): string {
  return Object.entries(a ?? {}).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(' · ');
}

/** การ์ดคำขอเบิกอะไหล่ — คลังเห็นเลขใบงาน/ทะเบียน/รายการ เท่านั้น (ไม่มีชื่อลูกค้า ไม่มีราคา) */
export function RequisitionCard({ req, actions, showJob = true }: { req: Requisition; actions?: ReactNode; showJob?: boolean }) {
  const dim = req.status === 'void';
  return (
    <article className={cx('rounded-xl border border-rule bg-raised p-4', dim && 'opacity-60')} data-testid="req-card" data-status={req.status} data-req={req.req_no}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="num text-[13px] text-mute">{req.req_no}{showJob ? ` · ${req.job_no}` : ''}</p>
          {showJob && <p className="font-display text-[19px] font-semibold leading-tight">{req.plate}</p>}
          {showJob && req.vehicle_label && <p className="text-[14px] text-dim">{req.vehicle_label}</p>}
        </div>
        <ReqBadge status={req.status} />
      </div>
      <ul className="mt-3 divide-y divide-rule/70 rounded-lg border border-rule bg-inset/60">
        {req.lines.map((l) => (
          <li key={l.id} className="flex items-start justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="text-[15px]">{l.item_name}</p>
              {attrText(l.attributes) && <p className="text-[13px] text-mute">{attrText(l.attributes)}</p>}
            </div>
            <span className="num shrink-0 font-medium text-gold-hi">× {l.qty}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 flex items-center gap-1.5 text-[13px] text-mute">
        <Clock className="h-3.5 w-3.5" aria-hidden />
        {req.status === 'delivered' && req.delivered_at ? `ส่งมอบ ${fmtDateTime(req.delivered_at)}`
          : req.status === 'prepared' && req.prepared_at ? `จัดเตรียมแล้ว ${ago(req.prepared_at)}`
          : req.status === 'void' ? `ยกเลิก: ${req.void_reason ?? ''}`
          : `ขอเมื่อ ${ago(req.requested_at)}`}
      </p>
      {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
    </article>
  );
}
