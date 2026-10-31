'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Clock, HandMetal, Search, UserPlus, Users } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { dwell } from '@/components/job-board';
import { LiveDot } from '@/components/live-notifier';
import { useToast } from '@/components/providers';
import { Button, Empty, ErrorNote, Plate, Skeleton, Spinner, StatusBadge } from '@/components/ui';
import { acceptJob, loadWorkData, type WorkData } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { plateNorm, vehicleLabel } from '@/lib/format';
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

  const [q, setQ] = useState('');
  const { mine, open, checking } = useMemo(() => split(st.data, q), [st.data, q]);

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
        <div className="space-y-8 pb-8 pt-4">
          <div className="relative px-4">
            <Search className="pointer-events-none absolute left-7 top-1/2 h-5 w-5 -translate-y-1/2 text-mute" aria-hidden />
            <input type="search" aria-label="ค้นหาทะเบียน" className="field pl-11" placeholder="ค้นหาทะเบียน" data-testid="work-search"
              value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Group title="กำลังรับผิดชอบ" count={mine.length} testid="mine" empty={q ? 'ไม่พบทะเบียนนี้ในงานของคุณ' : 'ยังไม่มีงานที่คุณรับ — เลือกจาก "งานที่รับได้" ด้านล่าง'}>
            {mine.map((j) => <WorkCard key={j.id} job={j} crew={st.data!.crew[j.id]} now={now} />)}
          </Group>
          <Group title="งานที่รับได้" count={open.length} testid="open" empty={q ? 'ไม่พบทะเบียนนี้ในงานที่รับได้' : 'ตอนนี้ยังไม่มีงาน — จะเด้งแจ้งเตือนทันทีเมื่อมีงานพร้อมทำ'}>
            {open.map((j) => (
              <WorkCard key={j.id} job={j} crew={st.data!.crew[j.id]} now={now}
                action={<Button className="w-full" onClick={() => void accept(j.id)} loading={accepting === j.id} disabled={accepting !== null && accepting !== j.id} data-testid="accept-btn">
                  {(st.data!.crew[j.id]?.crew_active ?? 0) > 0
                    ? <><UserPlus className="h-5 w-5" aria-hidden />เข้าร่วมงานนี้</>
                    : <><HandMetal className="h-5 w-5" aria-hidden />รับงานนี้</>}
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

function split(d: WorkData | null, q: string) {
  const needle = plateNorm(q);
  const jobs = (d?.jobs ?? []).filter((j) => !needle || plateNorm(j.plate).includes(needle));
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
  const open = crew ? crew.crew_required - crew.crew_active : 0;
  return (
    <article className="overflow-hidden rounded-2xl border border-rule bg-raised" data-testid="work-card" data-job={job.job_no} data-status={job.status}>
      <Link href={`/jobs/${job.id}`} className="block px-4 pb-3.5 pt-4 active:bg-inset">
        <div className="flex items-start justify-between gap-3">
          <Plate plate={job.plate} province={job.plate_province} className="text-[1.6rem]" />
          <StatusBadge status={job.status} />
        </div>
        <p className="mt-2.5 text-[17px] font-medium">{vehicleLabel(job)}</p>
        {job.complaint && <p className="mt-0.5 line-clamp-2 text-[15px] text-dim">อาการ: {job.complaint}</p>}
        {crew && crew.member_names.length > 0 && (
          <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="ช่างในงานนี้">
            {crew.member_names.slice(0, 3).map((n) => (
              <li key={n} className="inline-flex items-center gap-1 rounded-full border border-gold/40 bg-gold/10 px-2.5 py-0.5 text-[14px] text-gold-hi" data-testid="work-crew-chip">
                <Users className="h-4 w-4" aria-hidden />{n}
              </li>
            ))}
            {crew.member_names.length > 3 && (
              <li className="inline-flex items-center rounded-full border border-gold/40 px-2.5 py-0.5 text-[14px] text-gold-hi" title={crew.member_names.slice(3).join(', ')}>+{crew.member_names.length - 3}</li>
            )}
          </ul>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[14px] text-mute">
          <span className="flex items-center gap-1"><Clock className="h-4 w-4" aria-hidden /><span className="num">{age.text}</span></span>
          {crew && crew.crew_required > 0 && (
            <span className="num" title="จำนวนช่างที่แนะนำ — เข้าร่วมเพิ่มได้ไม่จำกัด">
              ช่าง {crew.crew_active}/{crew.crew_required} คน
              {open > 0 && crew.crew_active > 0 && <span className="text-gold-hi"> · ยังขาด {open}</span>}
            </span>
          )}
          <span className="num">{job.job_no}</span>
        </div>
      </Link>
      {action && <div className="border-t border-rule p-3">{action}</div>}
    </article>
  );
}
