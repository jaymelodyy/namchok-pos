'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Clock, HandMetal, Users } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { dwell } from '@/components/job-board';
import { LiveDot } from '@/components/live-notifier';
import { useToast } from '@/components/providers';
import { Button, Empty, ErrorNote, Plate, Skeleton, Spinner, StatusBadge } from '@/components/ui';
import { acceptJob, loadWorkData, type WorkData } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { vehicleLabel } from '@/lib/format';
import { useAsync, useNow } from '@/lib/hooks';
import { useLive } from '@/lib/realtime';
import type { CrewInfo, VJob } from '@/lib/types';

export default function WorkPage() {
  const { role } = useSession();
  const router = useRouter();
  useEffect(() => { if (role !== 'technician') router.replace(role === 'warehouse' ? '/requisitions' : '/jobs'); }, [role, router]);
  if (role !== 'technician') return <Spinner />;
  return <WorkScreen />;
}

function WorkScreen() {
  const { profile } = useSession();
  const toast = useToast();
  const st = useAsync(loadWorkData, []);
  const live = useLive(['job_orders', 'job_assignments'], () => void st.reload());
  const now = useNow(30000);
  const [accepting, setAccepting] = useState<string | null>(null);

  const { mine, open, checking } = useMemo(() => split(st.data), [st.data]);

  const accept = async (id: string) => {
    setAccepting(id);
    try { await acceptJob(id); toast.ok('รับงานแล้ว — ไปที่ "งานของฉัน"'); }
    catch (e) { toast.err(e instanceof Error ? e.message : String(e)); }
    finally { setAccepting(null); await st.reload(); }
  };

  return (
    <>
      <PageHeader title="งานของฉัน" subtitle={`สวัสดี ${profile.full_name}`} right={<div className="pr-3"><LiveDot status={live} /></div>} />
      {st.loading ? (
        <div className="space-y-3 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-36" />)}</div>
      ) : st.error && !st.data ? (
        <ErrorNote message={st.error} onRetry={() => void st.reload()} />
      ) : (
        <div className="space-y-8 pb-8 pt-5">
          <Group title="กำลังรับผิดชอบ" count={mine.length} testid="mine" empty={'ยังไม่มีงานที่คุณรับ — เลือกจาก "งานว่าง" ด้านล่าง'}>
            {mine.map((j) => <WorkCard key={j.id} job={j} crew={st.data!.crew[j.id]} now={now} />)}
          </Group>
          <Group title="งานว่าง รับได้ทันที" count={open.length} testid="open" empty="ตอนนี้ยังไม่มีงานว่าง — จะเด้งแจ้งเตือนทันทีเมื่อมีงานพร้อมทำ">
            {open.map((j) => (
              <WorkCard key={j.id} job={j} crew={st.data!.crew[j.id]} now={now}
                action={<Button className="w-full" onClick={() => void accept(j.id)} loading={accepting === j.id} disabled={accepting !== null && accepting !== j.id} data-testid="accept-btn">
                  <HandMetal className="h-4 w-4" aria-hidden />รับงานนี้
                </Button>} />
            ))}
          </Group>
          {checking.length > 0 && (
            <Group title="รอเช็คสภาพรถ" count={checking.length} testid="checking" empty="">
              {checking.map((j) => <WorkCard key={j.id} job={j} crew={undefined} now={now} />)}
            </Group>
          )}
        </div>
      )}
    </>
  );
}

function split(d: WorkData | null) {
  const jobs = d?.jobs ?? [];
  const crewOf = (j: VJob): CrewInfo | undefined => d?.crew[j.id];
  const age = (a: VJob, b: VJob) => new Date(a.status_changed_at).getTime() - new Date(b.status_changed_at).getTime();
  const isLive = (j: VJob) => j.status === 'ready' || j.status === 'in_progress' || j.status === 'qc';
  return {
    mine: jobs.filter((j) => isLive(j) && crewOf(j)?.mine).sort(age),
    open: jobs.filter((j) => (j.status === 'ready' || j.status === 'in_progress') && !crewOf(j)?.mine).sort(age),
    checking: jobs.filter((j) => j.status === 'condition_check').sort(age),
  };
}

function Group({ title, count, empty, testid, children }: { title: string; count: number; empty: string; testid: string; children: React.ReactNode }) {
  return (
    <section className="px-4" aria-label={title} data-testid={`group-${testid}`}>
      <h2 className="section-title mb-2.5 flex items-baseline justify-between"><span>{title}</span><span className="num text-[14px] font-normal text-mute" data-testid="group-count">{count}</span></h2>
      {count === 0 ? (empty ? <Empty title={empty} /> : null) : <div className="space-y-3">{children}</div>}
    </section>
  );
}

function WorkCard({ job, crew, now, action }: { job: VJob; crew?: CrewInfo; now: number; action?: React.ReactNode }) {
  const age = dwell(job.status_changed_at, now);
  const slots = crew ? crew.crew_required - crew.crew_active : 0;
  return (
    <article className="overflow-hidden rounded-2xl border border-rule bg-raised" data-testid="work-card" data-job={job.job_no} data-status={job.status}>
      <Link href={`/jobs/${job.id}`} className="block px-4 pb-3 pt-4 active:bg-inset">
        <div className="flex items-start justify-between gap-3">
          <Plate plate={job.plate} province={job.plate_province} className="text-[1.6rem]" />
          <StatusBadge status={job.status} />
        </div>
        <p className="mt-2.5 font-medium">{vehicleLabel(job)}</p>
        {job.complaint && <p className="mt-0.5 line-clamp-2 text-[14px] text-dim">อาการ: {job.complaint}</p>}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-mute">
          <span className="num">{job.job_no}</span>
          <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" aria-hidden /><span className="num">{age.text}</span></span>
          {crew && crew.crew_required > 0 && (
            <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" aria-hidden />
              <span className="num">{crew.crew_active}/{crew.crew_required}</span>
              {crew.member_names.length > 0 && <span> · {crew.member_names.join(', ')}</span>}
              {slots > 0 && crew.crew_active > 0 && <span className="text-gold-hi"> · ว่าง {slots}</span>}
            </span>
          )}
        </div>
      </Link>
      {action && <div className="border-t border-rule p-3">{action}</div>}
    </article>
  );
}
