'use client';
// Job Board (Kanban) สำหรับเจ้าของ/แอดมิน : เห็นทุกใบงานตามขั้น + ช่างที่รับงาน + ความคืบหน้าเบิกอะไหล่ + ช่างว่าง/ไม่ว่าง
// อัปเดตเองผ่าน Realtime (ไม่ต้องรีเฟรช) ; การย้ายขั้นทำผ่านปุ่มในหน้าใบงานเท่านั้น (กติกาแต่ละขั้นมีเงื่อนไข จึงไม่รองรับลากวาง)
import Link from 'next/link';
import { useMemo } from 'react';
import { Clock, PackageOpen, Users } from 'lucide-react';
import { Money, Plate } from './ui';
import { REQ_LABEL } from './requisition-card';
import { TECH_STATE_LABEL, TECH_STATE_TONE } from './job/crew';
import { cx, vehicleLabel } from '@/lib/format';
import { STATUS_LABEL } from '@/lib/labels';
import type { BoardData } from '@/lib/api';
import type { CrewInfo, JobStatus, Requisition, TechnicianRow, VJob } from '@/lib/types';

const COLUMNS: { key: string; label: string; statuses: JobStatus[]; hint: string }[] = [
  { key: 'intake', label: 'รับรถ / เช็คสภาพ', statuses: ['booked', 'opened', 'condition_check'], hint: 'รอเช็คสภาพรถ' },
  { key: 'quoting', label: 'เสนอราคา', statuses: ['quoting'], hint: 'รอลูกค้าอนุมัติ' },
  { key: 'requisition', label: 'รออะไหล่', statuses: ['requisition'], hint: 'คลังกำลังจัดของ' },
  { key: 'ready', label: 'พร้อมทำ', statuses: ['ready'], hint: 'รอช่างรับงาน' },
  { key: 'in_progress', label: 'กำลังทำ', statuses: ['in_progress'], hint: 'ช่างกำลังทำงาน' },
  { key: 'qc', label: 'รอ QC', statuses: ['qc'], hint: 'รอตรวจก่อนส่งมอบ' },
  { key: 'awaiting_payment', label: 'รอชำระ / ปิดงาน', statuses: ['awaiting_payment'], hint: 'รับเงินแล้วปิดงาน' },
];

export function inBoard(j: VJob): boolean {
  return !j.voided_at && j.status !== 'closed' && j.status !== 'cancelled';
}

/** "2 ชม. 5 นาที" — อายุของงานในขั้นปัจจุบัน */
export function dwell(iso: string, now: number): { text: string; hours: number } {
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  const hours = m / 60;
  if (m < 1) return { text: 'เพิ่งเปลี่ยน', hours };
  if (m < 60) return { text: `${m} นาที`, hours };
  if (m < 60 * 24) return { text: `${Math.floor(m / 60)} ชม. ${m % 60} นาที`, hours };
  return { text: `${Math.floor(m / 1440)} วัน ${Math.floor((m % 1440) / 60)} ชม.`, hours };
}

export function TechStrip({ techs }: { techs: TechnicianRow[] }) {
  if (techs.length === 0) return null;
  return (
    <section aria-label="สถานะช่าง" className="px-4" data-testid="tech-strip">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {techs.map((t) => (
          <div key={t.user_id} data-state={t.state} data-tech={t.full_name} className={cx('shrink-0 rounded-xl border px-3.5 py-2', TECH_STATE_TONE[t.state])}>
            <p className="text-[15px] font-medium leading-tight">{t.full_name}</p>
            <p className="text-[12px] opacity-90">{TECH_STATE_LABEL[t.state]}{t.jobs.length > 0 ? ` · ${t.jobs.map((j) => j.plate).join(', ')}` : ''}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function JobBoard({ data, now }: { data: BoardData; now: number }) {
  const reqByJob = useMemo(() => {
    const m = new Map<string, Requisition[]>();
    for (const r of data.reqs) m.set(r.job_id, [...(m.get(r.job_id) ?? []), r]);
    return m;
  }, [data.reqs]);
  const jobs = data.jobs.filter(inBoard);

  return (
    <div className="space-y-3">
      <TechStrip techs={data.techs} />
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-6 pt-1" data-testid="board">
        {COLUMNS.map((col) => {
          const list = jobs.filter((j) => col.statuses.includes(j.status))
            .sort((a, b) => new Date(a.status_changed_at).getTime() - new Date(b.status_changed_at).getTime());
          return (
            <section key={col.key} aria-label={col.label} data-col={col.key}
              className="w-[84vw] max-w-[19rem] shrink-0 snap-start rounded-2xl border border-rule bg-raised/60 sm:w-[19rem]">
              <header className="sticky top-0 flex items-baseline justify-between gap-2 rounded-t-2xl border-b border-rule px-3.5 py-3">
                <div className="min-w-0">
                  <h3 className="truncate font-display text-[15px] font-semibold">{col.label}</h3>
                  <p className="truncate text-[12px] text-mute">{col.hint}</p>
                </div>
                <span className="num rounded-full border border-rule bg-inset px-2.5 py-0.5 text-[13px] text-dim" data-testid="col-count">{list.length}</span>
              </header>
              <ul className="space-y-2.5 p-2.5">
                {list.length === 0 && <li className="px-2 py-6 text-center text-[13px] text-mute">ไม่มีงาน</li>}
                {list.map((j) => (
                  <li key={j.id}><BoardCard job={j} crew={data.crew[j.id]} reqs={reqByJob.get(j.id) ?? []} now={now} /></li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function BoardCard({ job, crew, reqs, now }: { job: VJob; crew?: CrewInfo; reqs: Requisition[]; now: number }) {
  const age = dwell(job.status_changed_at, now);
  const stale = age.hours >= 24;
  const owing = job.status === 'awaiting_payment' && job.balance > 0;
  const lead = reqs.find((r) => r.status === 'requested') ?? reqs[0];
  return (
    <Link href={`/jobs/${job.id}`} data-testid="board-card" data-job={job.job_no} data-status={job.status}
      className="block rounded-xl border border-rule bg-lacquer px-3 py-3 transition-colors hover:border-gold/50 active:bg-inset">
      <div className="flex items-start justify-between gap-2">
        <Plate plate={job.plate} province={job.plate_province} className="text-[1.15rem]" />
        <span className={cx('flex shrink-0 items-center gap-1 text-[12px]', stale ? 'text-warn' : 'text-mute')} title={`อยู่ขั้น "${STATUS_LABEL[job.status]}" มา ${age.text}`}>
          <Clock className="h-3.5 w-3.5" aria-hidden /><span className="num">{age.text}</span>
        </span>
      </div>
      <p className="mt-2 truncate text-[15px] font-medium">{job.customer_name}</p>
      <p className="truncate text-[13px] text-dim">{vehicleLabel(job)} · <span className="num">{job.job_no}</span></p>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {job.status === 'requisition' && (lead
          ? <span className="inline-flex items-center gap-1 rounded-full border border-warn/50 bg-warn/10 px-2.5 py-0.5 text-[12px] text-warn" data-testid="req-chip">
              <PackageOpen className="h-3.5 w-3.5" aria-hidden />{lead.req_no} · {REQ_LABEL[lead.status]}
            </span>
          : <span className="inline-flex items-center gap-1 rounded-full border border-rule px-2.5 py-0.5 text-[12px] text-mute">ไม่มีอะไหล่ต้องเบิก</span>)}
        {crew && (job.status === 'ready' || job.status === 'in_progress' || job.status === 'qc') && (
          crew.member_names.length > 0
            ? crew.member_names.map((n) => <span key={n} className="inline-flex items-center gap-1 rounded-full border border-gold/40 bg-gold/10 px-2.5 py-0.5 text-[12px] text-gold-hi" data-testid="crew-chip"><Users className="h-3.5 w-3.5" aria-hidden />{n}</span>)
            : <span className="inline-flex items-center gap-1 rounded-full border border-warn/50 bg-warn/10 px-2.5 py-0.5 text-[12px] text-warn" data-testid="crew-chip">ยังไม่มีช่างรับ</span>
        )}
        {crew && job.status === 'ready' && crew.crew_required > 1 && (
          <span className="num text-[12px] text-mute">{crew.crew_active}/{crew.crew_required} คน</span>
        )}
        {owing && <span className="text-[13px] text-warn">ค้าง <Money v={job.balance} /></span>}
      </div>
    </Link>
  );
}
