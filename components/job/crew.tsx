'use client';
import { useState } from 'react';
import { UserMinus, UserPlus, Users } from 'lucide-react';
import { Button, ReasonSheet, Sheet } from '@/components/ui';
import { addJobCrew, releaseJob, removeTechnician, technicianBoard } from '@/lib/api';
import { useToast } from '@/components/providers';
import { useAsync } from '@/lib/hooks';
import { cx } from '@/lib/format';
import type { CrewInfo, JobStatus, TechState } from '@/lib/types';

export const TECH_STATE_LABEL: Record<TechState, string> = { free: 'ว่าง', assigned: 'รับงานแล้ว (รอเริ่ม)', busy: 'กำลังทำงาน' };
export const TECH_STATE_TONE: Record<TechState, string> = {
  free: 'border-ok/40 bg-ok/10 text-ok', assigned: 'border-gold/40 bg-gold/10 text-gold-hi', busy: 'border-warn/50 bg-warn/10 text-warn',
};

const SHOW_FROM: JobStatus[] = ['ready', 'in_progress', 'qc', 'awaiting_payment', 'closed'];

/** ทีมช่างของใบงาน : ใครรับงานแล้ว / ยังขาดกี่คน ; แอดมินมอบหมาย-เอาออกได้ ; ช่างปล่อยงานของตัวเองได้ก่อนเริ่ม */
export function CrewPanel({ jobId, status, crew, role, canManage, onChanged }: {
  jobId: string; status: JobStatus; crew: CrewInfo | null; role: string; canManage: boolean; onChanged: () => void;
}) {
  const toast = useToast();
  const [assign, setAssign] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!crew || !SHOW_FROM.includes(status)) return null;

  const active = status === 'ready' || status === 'in_progress';
  const open = Math.max(0, crew.crew_required - crew.crew_active);
  const release = async () => {
    setBusy(true);
    try { await releaseJob(jobId); toast.ok('ปล่อยงานแล้ว — ช่างคนอื่นรับต่อได้'); onChanged(); }
    catch (e) { toast.err(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <section className="px-4" aria-labelledby="crew-h" data-testid="crew-panel">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="crew-h" className="section-title flex items-center gap-2"><Users className="h-4 w-4 text-gold" aria-hidden />ทีมช่าง</h2>
        <span className="num text-[14px] text-dim" data-testid="crew-count">{crew.crew_active}/{crew.crew_required} คน</span>
      </div>
      <ul className="space-y-1.5">
        {crew.member_ids.map((uid, i) => (
          <li key={uid} className="flex items-center justify-between gap-3 rounded-lg border border-rule bg-raised px-3.5 py-2.5">
            <span className="font-medium">{crew.member_names[i]}</span>
            {canManage && active && (
              <button type="button" onClick={() => setRemoving({ id: uid, name: crew.member_names[i] })}
                aria-label={`เอา ${crew.member_names[i]} ออกจากงาน`} className="grid h-9 w-9 place-items-center rounded-lg text-mute hover:bg-inset hover:text-bad">
                <UserMinus className="h-[18px] w-[18px]" aria-hidden />
              </button>
            )}
          </li>
        ))}
        {crew.member_ids.length === 0 && <li className="rounded-lg border border-dashed border-rule px-3.5 py-3 text-[15px] text-mute">ยังไม่มีช่างรับงาน</li>}
        {active && open > 0 && crew.member_ids.length > 0 && <li className="px-1 text-[13px] text-warn">ยังขาดอีก {open} คน</li>}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        {/* ผู้ดูแลเพิ่มช่างได้ตลอดที่งานยัง active แม้ทีมครบแล้ว — add_job_crew ขยายจำนวนที่ต้องใช้ให้เอง */}
        {canManage && active && (
          <Button variant="outline" small onClick={() => setAssign(true)}><UserPlus className="h-4 w-4" aria-hidden />มอบหมายช่าง</Button>
        )}
        {role === 'technician' && crew.mine && status === 'ready' && (
          <Button variant="ghost" small onClick={() => void release()} loading={busy}>ปล่อยงาน</Button>
        )}
      </div>

      <AssignSheet open={assign} jobId={jobId} memberIds={crew.member_ids} onClose={() => setAssign(false)}
        onDone={() => { setAssign(false); toast.ok('มอบหมายช่างแล้ว'); onChanged(); }} />
      <ReasonSheet
        open={Boolean(removing)} danger title={`เอา ${removing?.name ?? ''} ออกจากงาน`} confirmLabel="เอาออกจากงาน"
        description="ช่างที่ถูกเอาออกก่อนปิดงานจะไม่ได้รับค่าแรงของงานนี้" placeholder="เช่น ช่างป่วย, ติดงานอื่น"
        onClose={() => setRemoving(null)}
        onConfirm={async (r) => { await removeTechnician(jobId, removing!.id, r); setRemoving(null); toast.ok('เอาช่างออกจากงานแล้ว'); onChanged(); }}
      />
    </section>
  );
}

function AssignSheet({ open, jobId, memberIds, onClose, onDone }: {
  open: boolean; jobId: string; memberIds: string[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const board = useAsync(async () => (open ? technicianBoard() : []), [open]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toggle = (uid: string) => setPicked((p) => (p.includes(uid) ? p.filter((x) => x !== uid) : [...p, uid]));
  const close = () => { setPicked([]); onClose(); };
  // เลือกได้หลายคนแล้วบันทึกครั้งเดียว (atomic) — ถ้ามีคนใดไม่ผ่าน ทั้งก้อนถูกยกเลิก
  const save = async () => {
    setBusy(true);
    try { await addJobCrew(jobId, picked); setPicked([]); onDone(); }
    catch (e) { toast.err(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const rows = (board.data ?? []).filter((t) => !memberIds.includes(t.user_id));
  return (
    <Sheet open={open} onClose={close} title="มอบหมายช่าง">
      {board.loading ? <p className="py-6 text-center text-dim">กำลังโหลด</p> : rows.length === 0 ? (
        <p className="py-6 text-center text-dim">ไม่มีช่างที่มอบหมายเพิ่มได้</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((t) => {
            const on = picked.includes(t.user_id);
            return (
            <li key={t.user_id}>
              <button type="button" role="checkbox" aria-checked={on} onClick={() => toggle(t.user_id)} disabled={busy}
                className={cx('flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-60',
                  on ? 'border-gold bg-gold/10' : 'border-rule bg-inset hover:border-gold/50')}>
                <span className="flex items-center gap-3">
                <span aria-hidden className={cx('grid h-5 w-5 shrink-0 place-items-center rounded border text-[13px]', on ? 'border-gold bg-gold text-lacquer' : 'border-rule')}>{on ? '✓' : ''}</span>
                <span>
                  <span className="block font-medium">{t.full_name}</span>
                  {t.jobs.length > 0 && <span className="block text-[13px] text-mute">{t.jobs.map((j) => `${j.plate}`).join(' · ')}</span>}
                </span>
                </span>
                <span className={cx('shrink-0 rounded-full border px-2.5 py-0.5 text-[13px] font-medium', TECH_STATE_TONE[t.state])}>{TECH_STATE_LABEL[t.state]}</span>
              </button>
            </li>
            );
          })}
        </ul>
      )}
      {rows.length > 0 && (
        <Button className="mt-4 w-full" onClick={() => void save()} loading={busy} disabled={picked.length === 0}>
          {picked.length > 0 ? `มอบหมาย ${picked.length} คน` : 'เลือกช่างอย่างน้อย 1 คน'}
        </Button>
      )}
      <p className="mt-4 text-[13px] text-mute">ช่างหนึ่งคนรับได้หลายงานพร้อมกัน — สถานะ "กำลังทำงาน" ใช้ประกอบการตัดสินใจเท่านั้น</p>
    </Sheet>
  );
}
