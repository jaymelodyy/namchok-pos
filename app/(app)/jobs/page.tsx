'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { KanbanSquare, List, Plus, Search } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { JobBoard, inBoard } from '@/components/job-board';
import { JobRow } from '@/components/job-row';
import { LiveDot } from '@/components/live-notifier';
import { Empty, ErrorNote, Skeleton, Spinner } from '@/components/ui';
import { loadBoardData } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { cx, plateNorm } from '@/lib/format';
import { useAsync, useNow } from '@/lib/hooks';
import { useLive } from '@/lib/realtime';
import type { VJob } from '@/lib/types';

type Filter = 'active' | 'awaiting_payment' | 'closed' | 'cancelled' | 'all';
const FILTERS: { key: Filter; label: string; test: (j: VJob) => boolean }[] = [
  { key: 'active', label: 'ยังไม่ปิด', test: (j) => !j.voided_at && j.status !== 'closed' && j.status !== 'cancelled' },
  { key: 'awaiting_payment', label: 'รอชำระ', test: (j) => !j.voided_at && j.status === 'awaiting_payment' },
  { key: 'closed', label: 'ปิดแล้ว', test: (j) => j.status === 'closed' },
  { key: 'cancelled', label: 'ยกเลิก', test: (j) => j.status === 'cancelled' || Boolean(j.voided_at) },
  { key: 'all', label: 'ทั้งหมด', test: () => true },
];

const VIEW_KEY = 'namchok.jobs.view';

export default function JobsPage() {
  const { role } = useSession();
  const router = useRouter();
  useEffect(() => { if (role === 'technician') router.replace('/work'); if (role === 'warehouse') router.replace('/requisitions'); }, [role, router]);
  if (role === 'technician' || role === 'warehouse') return <Spinner />;
  return <JobsScreen />;
}

function JobsScreen() {
  const { canSeeMoney } = useSession();
  const board = useAsync(loadBoardData, []);
  const live = useLive(['job_orders', 'job_assignments', 'requisitions', 'payments', 'refunds'], () => void board.reload());
  const now = useNow(30000);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [filter, setFilter] = useState<Filter>('active');
  const [q, setQ] = useState('');
  useEffect(() => { try { const v = localStorage.getItem(VIEW_KEY); if (v === 'list' || v === 'board') setView(v); } catch { /* ไม่มี storage ก็ใช้ค่าเริ่มต้น */ } }, []);
  const chooseView = (v: 'board' | 'list') => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };

  const jobs = board.data?.jobs;
  const match = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const nplate = plateNorm(q);
    return (j: VJob) => !needle
      || (nplate !== '' && plateNorm(j.plate).includes(nplate)) || j.customer_name.toLowerCase().includes(needle)
      || j.job_no.toLowerCase().includes(needle) || (j.customer_phone ?? '').includes(needle);
  }, [q]);
  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)!;
    return (jobs ?? []).filter(f.test).filter(match);
  }, [jobs, filter, match]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, (jobs ?? []).filter(f.test).length])) as Record<Filter, number>, [jobs]);
  const boardData = useMemo(() => (board.data ? { ...board.data, jobs: board.data.jobs.filter(match) } : null), [board.data, match]);

  return (
    <>
      <PageHeader
        title="ใบงาน" subtitle={jobs ? `${counts.active} งานที่ยังไม่ปิด` : undefined}
        right={
          <div className="flex items-center gap-2 pr-2">
            <LiveDot status={live} />
            <div role="tablist" aria-label="มุมมอง" className="flex rounded-lg border border-rule p-0.5">
              <button role="tab" aria-selected={view === 'board'} onClick={() => chooseView('board')} data-testid="view-board"
                className={cx('flex min-h-[36px] items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium', view === 'board' ? 'bg-gold/15 text-gold-hi' : 'text-mute')}>
                <KanbanSquare className="h-4 w-4" aria-hidden />บอร์ด
              </button>
              <button role="tab" aria-selected={view === 'list'} onClick={() => chooseView('list')} data-testid="view-list"
                className={cx('flex min-h-[36px] items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium', view === 'list' ? 'bg-gold/15 text-gold-hi' : 'text-mute')}>
                <List className="h-4 w-4" aria-hidden />รายการ
              </button>
            </div>
          </div>
        }
      />
      <div className={cx('space-y-3 px-4 pb-2 pt-4', view === 'list' && 'mx-auto max-w-3xl')}>
        <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-mute" aria-hidden />
          <input
            type="search" aria-label="ค้นหาใบงาน" className="field pl-11" placeholder="ทะเบียน ชื่อ เบอร์ หรือเลขงาน"
            value={q} onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Link href="/" className="btn btn-primary shrink-0 px-4" data-testid="new-job">
          <Plus className="h-5 w-5" aria-hidden /><span className="hidden sm:inline">เปิดใบงานใหม่</span><span className="sm:hidden">ใบงานใหม่</span>
        </Link>
        </div>
        {view === 'list' && (
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="กรองสถานะ">
            {FILTERS.map((f) => (
              <button
                key={f.key} role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)}
                className={cx(
                  'shrink-0 rounded-full border px-4 py-2 text-[14px] font-medium transition-colors',
                  filter === f.key ? 'border-gold bg-gold/15 text-gold-hi' : 'border-rule text-dim hover:text-ivory',
                )}
              >
                {f.label}<span className="num ml-1.5 text-mute">{counts[f.key]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {board.loading ? (
        <div className="space-y-2 px-4 pt-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[84px]" />)}</div>
      ) : board.error && !board.data ? (
        <ErrorNote message={board.error} onRetry={() => void board.reload()} />
      ) : view === 'board' && boardData ? (
        boardData.jobs.filter(inBoard).length === 0
          ? <Empty title={q ? 'ไม่พบใบงานที่ค้นหา' : 'ยังไม่มีงานที่กำลังดำเนินการ'} hint={q ? 'ลองพิมพ์ทะเบียนเพียงบางส่วน' : 'เปิดใบงานใหม่ได้ที่หน้าแรก'} />
          : <JobBoard data={boardData} now={now} />
      ) : shown.length === 0 ? (
        <Empty
          title={q ? 'ไม่พบใบงานที่ค้นหา' : 'ยังไม่มีใบงานในหมวดนี้'}
          hint={q ? 'ลองพิมพ์ทะเบียนเพียงบางส่วน หรือเปลี่ยนตัวกรอง' : 'เปิดใบงานใหม่ได้ที่หน้าแรก'}
        />
      ) : (
        <div className="ledger mx-auto max-w-3xl border-y border-rule">
          {shown.map((j) => <JobRow key={j.id} job={j} showMoney={canSeeMoney} />)}
        </div>
      )}
    </>
  );
}
