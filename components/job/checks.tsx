'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Camera, CheckCircle2, ChevronRight, ClipboardCheck, RotateCcw } from 'lucide-react';
import { reopenCheck } from '@/lib/api';
import { cx } from '@/lib/format';
import type { CheckRequirement, JobStatus } from '@/lib/types';
import { Button, ReasonSheet } from '../ui';

const BEFORE_START: JobStatus[] = ['booked', 'opened', 'condition_check', 'quoting', 'requisition', 'ready'];

export function ChecksPanel({
  jobId, status, checks, canReopen, onChanged,
}: { jobId: string; status: JobStatus; checks: CheckRequirement[]; canReopen: boolean; onChanged: () => void }) {
  const [reopening, setReopening] = useState<CheckRequirement | null>(null);
  const done = checks.filter((c) => c.completed).length;
  const canEditChecks = status !== 'cancelled' && status !== 'closed';
  const tooEarly = status === 'booked' || status === 'opened';

  return (
    <section aria-labelledby="checks-h">
      <div className="flex items-baseline justify-between px-4 pb-2">
        <h2 id="checks-h" className="section-title">เช็คสภาพรถ</h2>
        <p className={cx('num text-[14px]', done === checks.length ? 'text-ok' : 'text-warn')}>
          {checks.length === 0 ? '' : done === checks.length ? 'ครบแล้ว' : `ครบ ${done} จาก ${checks.length} ฟอร์ม`}
        </p>
      </div>
      <ul className="ledger border-y border-rule">
        {checks.map((c) => {
          const state = c.completed ? 'done' : c.check_id ? 'draft' : 'todo';
          const photoOk = c.photo_count >= c.min_photos;
          return (
            <li key={c.template_id} className="flex items-center gap-3 px-4 py-3">
              <span className="shrink-0" aria-hidden>
                {state === 'done' ? <CheckCircle2 className="h-6 w-6 text-ok" /> : <ClipboardCheck className={cx('h-6 w-6', state === 'draft' ? 'text-gold' : 'text-mute')} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{c.template_name}</p>
                <p className="flex items-center gap-3 text-[13px] text-mute">
                  <span className={state === 'done' ? 'text-ok' : state === 'draft' ? 'text-gold-hi' : ''}>
                    {state === 'done' ? 'ลูกค้าเซ็นยืนยันแล้ว' : state === 'draft' ? 'บันทึกร่างไว้ ยังไม่ยืนยัน' : 'ยังไม่ได้ตรวจ'}
                  </span>
                  <span className={cx('flex items-center gap-1', !photoOk && 'text-warn')}><Camera className="h-3.5 w-3.5" aria-hidden /><span className="num">{c.photo_count}/{c.min_photos}</span></span>
                </p>
              </div>
              {canReopen && c.completed && BEFORE_START.includes(status) && (
                <Button variant="ghost" small onClick={() => setReopening(c)} aria-label={`เปิดแก้ ${c.template_name}`}><RotateCcw className="h-4 w-4" aria-hidden /></Button>
              )}
              {canEditChecks && (tooEarly && !c.completed ? (
                // ขั้น "เปิดงาน"/"จองคิว" ฐานข้อมูลยังไม่รับบันทึกเช็คสภาพ — บอกให้กดเดินขั้นก่อน แทนที่จะพาไปหน้าที่บันทึกไม่ได้
                <span className="max-w-[9.5rem] text-right text-[13px] leading-snug text-warn" data-testid="check-wait-start">
                  กด “เริ่มเช็คสภาพรถ” ก่อน
                </span>
              ) : (
                <Link href={`/jobs/${jobId}/check/${c.template_id}`} className={cx('btn btn-sm', c.completed ? 'btn-ghost' : 'btn-outline')}>
                  {c.completed ? 'ดู' : state === 'draft' ? 'ทำต่อ' : 'เริ่มตรวจ'}<ChevronRight className="h-4 w-4" aria-hidden />
                </Link>
              ))}
            </li>
          );
        })}
      </ul>
      <ReasonSheet
        open={Boolean(reopening)} title="เปิดแก้ไขเช็คสภาพ" confirmLabel="เปิดแก้ไข"
        description={`${reopening?.template_name ?? ''} — ลายเซ็นลูกค้าจะถูกล้าง ต้องให้ลูกค้าเซ็นใหม่หลังแก้`}
        onClose={() => setReopening(null)}
        onConfirm={async (r) => { await reopenCheck(reopening!.check_id!, r); setReopening(null); onChanged(); }}
      />
    </section>
  );
}
