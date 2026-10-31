'use client';
// คอลัมน์ซ้ายของมุมมอง 2 คอลัมน์ (จอ xl): ใบงานที่ยังไม่ปิด เรียงตามขั้นแบบเดียวกับบอร์ด + ค้นหาทะเบียน
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { inBoard } from './job-board';
import { Plate, StatusBadge } from './ui';
import { listJobs } from '@/lib/api';
import { cx, plateNorm, vehicleLabel } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { useLive } from '@/lib/realtime';
import type { JobStatus } from '@/lib/types';

const ORDER: JobStatus[] = ['booked', 'opened', 'condition_check', 'quoting', 'requisition', 'ready', 'in_progress', 'qc', 'awaiting_payment'];

export function JobSideList({ currentPath }: { currentPath: string }) {
  const st = useAsync(listJobs, []);
  useLive(['job_orders'], () => void st.reload());
  const [q, setQ] = useState('');
  const jobs = useMemo(() => {
    const needle = plateNorm(q);
    return (st.data ?? []).filter(inBoard)
      .filter((j) => !needle || plateNorm(j.plate).includes(needle) || j.job_no.toLowerCase().includes(q.trim().toLowerCase()))
      .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)
        || new Date(a.status_changed_at).getTime() - new Date(b.status_changed_at).getTime());
  }, [st.data, q]);

  return (
    <aside aria-label="ใบงานที่ยังไม่ปิด" data-testid="job-side-list"
      className="no-print hidden xl:sticky xl:top-0 xl:flex xl:h-dvh xl:flex-col xl:border-r xl:border-rule">
      <div className="border-b border-rule px-3 pb-3 pt-4">
        <p className="mb-2 px-1 font-display text-[16px] font-semibold">ใบงานที่ยังไม่ปิด <span className="num text-mute">{jobs.length}</span></p>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" aria-hidden />
          <input type="search" aria-label="ค้นหาทะเบียน" className="field pl-9" placeholder="ค้นหาทะเบียน" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <ul className="flex-1 space-y-1.5 overflow-y-auto p-2">
        {jobs.map((j) => {
          const on = currentPath === `/jobs/${j.id}`;
          return (
            <li key={j.id}>
              <Link href={`/jobs/${j.id}`} aria-current={on ? 'page' : undefined}
                className={cx('block rounded-xl border px-3 py-2.5 transition-colors', on ? 'border-gold bg-gold/10' : 'border-transparent hover:border-rule hover:bg-raised')}>
                <div className="flex items-center justify-between gap-2">
                  <Plate plate={j.plate} province={j.plate_province} className="text-[1rem]" />
                  <StatusBadge status={j.status} />
                </div>
                <p className="mt-1.5 truncate text-[14px]">{j.customer_name}</p>
                <p className="truncate text-[13px] text-mute">{vehicleLabel(j)}</p>
              </Link>
            </li>
          );
        })}
        {st.data && jobs.length === 0 && <li className="px-3 py-6 text-center text-[14px] text-mute">{q ? 'ไม่พบทะเบียนนี้' : 'ไม่มีงานค้าง'}</li>}
      </ul>
    </aside>
  );
}
