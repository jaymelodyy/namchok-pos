'use client';
import { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, XCircle } from 'lucide-react';
import { Button, Field, Sheet } from '@/components/ui';
import { qcChecklist, qcFail, qcPass, uploadFile } from '@/lib/api';
import { compressImage } from '@/lib/image';
import { useAsync } from '@/lib/hooks';
import { cx, fmtDateTime } from '@/lib/format';
import type { QcCheck, QcItem } from '@/lib/types';

const MAX_PHOTOS = 4;

/** บันทึกผล QC : ผ่าน (ติ๊กครบทุกข้อ) หรือ ไม่ผ่าน (ต้องมีเหตุผล → ส่งกลับ "กำลังทำ") ; แนบรูปได้ */
export function QcSheet({ open, jobId, branchId, onClose, onDone }: {
  open: boolean; jobId: string; branchId: string; onClose: () => void; onDone: (result: 'pass' | 'fail') => void;
}) {
  const list = useAsync(qcChecklist, []);
  const items: QcItem[] = list.data ?? [];
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<null | 'pass' | 'fail'>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setTicked({}); setNote(''); setFiles([]); setErr(null); setBusy(null); } }, [open]);

  const all = items.length > 0 && items.every((i) => ticked[i.key]);
  const go = async (result: 'pass' | 'fail') => {
    if (result === 'fail' && !note.trim()) { setErr('ถ้าไม่ผ่าน QC ต้องระบุว่าต้องแก้อะไร'); return; }
    setBusy(result); setErr(null);
    try {
      const paths: string[] = [];
      for (const f of files) {
        const img = await compressImage(f);
        paths.push(await uploadFile(`${branchId}/${jobId}/qc/${crypto.randomUUID()}.${img.ext}`, img.blob, img.type));
      }
      const answers = Object.fromEntries(items.map((i) => [i.key, Boolean(ticked[i.key])]));
      if (result === 'pass') await qcPass(jobId, answers, note.trim() || undefined, paths);
      else await qcFail(jobId, note.trim(), paths, answers);
      onDone(result);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(null); }
  };

  return (
    <Sheet
      open={open} onClose={onClose} title="ผลตรวจ QC"
      footer={
        <div className="flex gap-3">
          <Button variant="danger" className="flex-1" onClick={() => void go('fail')} loading={busy === 'fail'} disabled={busy !== null && busy !== 'fail'} data-testid="qc-fail">
            <XCircle className="h-4 w-4" aria-hidden />ไม่ผ่าน
          </Button>
          <Button className="flex-[1.4]" onClick={() => void go('pass')} loading={busy === 'pass'} disabled={!all || (busy !== null && busy !== 'pass')} data-testid="qc-pass">
            <CheckCircle2 className="h-4 w-4" aria-hidden />ผ่าน QC
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <fieldset>
          <legend className="label">ตรวจทีละข้อ (ติ๊กครบทุกข้อจึงผ่านได้)</legend>
          <ul className="space-y-2">
            {items.map((it) => {
              const on = Boolean(ticked[it.key]);
              return (
                <li key={it.key}>
                  <button type="button" role="checkbox" aria-checked={on} onClick={() => setTicked((t) => ({ ...t, [it.key]: !on }))}
                    className={cx('flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                      on ? 'border-ok/60 bg-ok/10' : 'border-rule bg-inset hover:border-gold/40')}>
                    <span className={cx('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border', on ? 'border-ok bg-ok text-lacquer' : 'border-mute')} aria-hidden>
                      {on && <CheckCircle2 className="h-4 w-4" />}
                    </span>
                    <span className="text-[15px]">{it.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </fieldset>
        <Field label="หมายเหตุ (ถ้าไม่ผ่าน ต้องระบุว่าต้องแก้อะไร)" htmlFor="qc-note">
          <textarea id="qc-note" rows={3} className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ยังมีน้ำรั่วที่ท่อทางออก ต้องขันใหม่" />
        </Field>
        <Field label={`รูปประกอบ (ไม่บังคับ สูงสุด ${MAX_PHOTOS} รูป)`}>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple className="sr-only" aria-label="เลือกรูป QC"
            onChange={(e) => setFiles((p) => [...p, ...Array.from(e.target.files ?? [])].slice(0, MAX_PHOTOS))} />
          <Button variant="outline" className="w-full" onClick={() => fileRef.current?.click()} disabled={files.length >= MAX_PHOTOS}>
            <Camera className="h-4 w-4" aria-hidden />{files.length ? `แนบแล้ว ${files.length} รูป — เพิ่มอีก` : 'ถ่ายรูป / เลือกรูป'}
          </Button>
        </Field>
        {err && <p role="alert" className="text-[15px] text-bad">{err}</p>}
      </div>
    </Sheet>
  );
}

export function QcHistory({ checks }: { checks: QcCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <section className="px-4" aria-labelledby="qc-h" data-testid="qc-history">
      <h2 id="qc-h" className="section-title mb-2">ประวัติ QC</h2>
      <ul className="space-y-2">
        {[...checks].reverse().map((c) => (
          <li key={c.id} className={cx('rounded-lg border px-3.5 py-2.5', c.result === 'pass' ? 'border-ok/40 bg-ok/5' : 'border-bad/40 bg-bad/5')}>
            <p className={cx('font-medium', c.result === 'pass' ? 'text-ok' : 'text-bad')}>{c.result === 'pass' ? 'ผ่าน QC' : 'ไม่ผ่าน QC — ส่งกลับแก้งาน'}</p>
            <p className="text-[13px] text-mute">{fmtDateTime(c.checked_at)}{c.photo_paths.length ? `  รูป ${c.photo_paths.length}` : ''}</p>
            {c.note && <p className="mt-1 text-[14px] text-dim">{c.note}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
