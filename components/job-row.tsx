'use client';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { fmtDateTime, vehicleLabel } from '@/lib/format';
import type { VJob } from '@/lib/types';
import { Money, Plate, StatusBadge } from './ui';

export function JobRow({ job, showMoney }: { job: VJob; showMoney: boolean }) {
  const owing = job.status === 'awaiting_payment' && job.balance > 0;
  return (
    <Link
      href={`/jobs/${job.id}`}
      className="block px-4 py-3.5 transition-colors hover:bg-raised active:bg-raised"
    >
      <div className="flex items-center gap-3">
        <Plate plate={job.plate} province={job.plate_province} className="shrink-0 text-[1.35rem]" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{job.customer_name}</p>
          <p className="truncate text-[14px] text-dim">{vehicleLabel(job)}</p>
          <p className="truncate text-[13px] text-mute">{fmtDateTime(job.created_at)}</p>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0 text-mute" aria-hidden />
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-3">
        <span className="num truncate text-[13px] text-mute">{job.job_no}</span>
        <div className="flex shrink-0 items-center gap-2.5">
          {showMoney && (job.grand_total > 0 || owing) && (
            <span className={owing ? 'text-[14px] text-warn' : 'text-[14px] text-dim'}>
              {owing ? <>ค้าง <Money v={job.balance} /></> : <Money v={job.grand_total} />}
            </span>
          )}
          <StatusBadge status={job.status} voided={Boolean(job.voided_at)} />
        </div>
      </div>
    </Link>
  );
}
