'use client';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, ImagePlus } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { useToast } from '@/components/providers';
import { SignaturePad, type SignaturePadHandle } from '@/components/signature-pad';
import { Button, Empty, ErrorNote, Field, Plate, Segmented, Skeleton } from '@/components/ui';
import { addCheckPhoto, completeCheck, loadCheck, loadJob, loadTemplate, saveCheck, signedUrls, uploadFile } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { compressImage } from '@/lib/image';
import { cx, fmtDateTime } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import type { AnswerState, Answers, CheckPhoto } from '@/lib/types';

const MAX_PHOTOS = 20;
/** ขั้นที่ฐานข้อมูลยังไม่รับบันทึกเช็คสภาพ (save_condition_check รับเฉพาะ "เช็คสภาพรถ" ถึง "พร้อมทำ") */
const TOO_EARLY: string[] = ['booked', 'opened'];

const OPTIONS: { value: AnswerState; label: string; tone?: 'ok' | 'bad' | 'mute' }[] = [
  { value: 'ok', label: 'ปกติ', tone: 'ok' },
  { value: 'defect', label: 'พบตำหนิ', tone: 'bad' },
  { value: 'na', label: 'ไม่มี', tone: 'mute' },
];

export default function CheckPage() {
  const { id, tpl } = useParams<{ id: string; tpl: string }>();
  const router = useRouter();
  const toast = useToast();
  const { profile } = useSession();

  const data = useAsync(async () => {
    const [detail, template, existing] = await Promise.all([loadJob(id), loadTemplate(tpl), loadCheck(id, tpl)]);
    const urls = await signedUrls([...existing.photos.map((p) => p.storage_path), existing.check?.signature_path ?? '']);
    return { detail, template, ...existing, urls };
  }, [id, tpl]);

  const [answers, setAnswers] = useState<Answers>({});
  const [note, setNote] = useState('');
  const [signedBy, setSignedBy] = useState('');
  const [photos, setPhotos] = useState<CheckPhoto[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | 'draft' | 'done' | 'photo'>(null);
  const [progress, setProgress] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const checkId = useRef<string | null>(null);
  const pad = useRef<SignaturePadHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    const d = data.data;
    if (!d || loaded.current) return;
    loaded.current = true;
    setAnswers(d.check?.answers ?? {});
    setNote(d.check?.note ?? '');
    setSignedBy(d.check?.signed_by_name ?? d.detail?.job.customer_name ?? '');
    setPhotos(d.photos); setUrls(d.urls);
    checkId.current = d.check?.id ?? null;
  }, [data.data]);

  if (data.loading) return <><PageHeader title="เช็คสภาพรถ" back={`/jobs/${id}`} /><div className="space-y-3 p-4"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div></>;
  if (data.error && !data.data) return <><PageHeader title="เช็คสภาพรถ" back={`/jobs/${id}`} /><ErrorNote message={data.error} onRetry={() => void data.reload()} /></>;
  const d = data.data;
  if (!d?.detail || !d.template) return <><PageHeader title="เช็คสภาพรถ" back={`/jobs/${id}`} /><Empty title="ไม่พบแบบฟอร์มหรือใบงาน" /></>;

  const { job } = d.detail;
  const template = d.template;
  const done = Boolean(d.check?.completed_at);
  const tooEarly = TOO_EARLY.includes(job.status);
  const locked = done || tooEarly || ['in_progress', 'qc', 'awaiting_payment', 'closed', 'cancelled'].includes(job.status);
  const answered = template.checklist.filter((i) => answers[i.key]?.state).length;
  const defectNoNote = template.checklist.some((i) => answers[i.key]?.state === 'defect' && !(answers[i.key]?.note ?? '').trim());

  const setAnswer = (key: string, patch: Partial<Answers[string]>) =>
    setAnswers((a) => ({ ...a, [key]: { ...(a[key] ?? { state: 'ok' as AnswerState }), ...patch } }));

  /** บันทึกคำตอบ (ร่าง) และคืน check id */
  const persist = async (): Promise<string> => {
    const cleaned: Answers = {};
    for (const [k, v] of Object.entries(answers)) if (v?.state) cleaned[k] = v.state === 'defect' ? { state: 'defect', note: v.note ?? '' } : { state: v.state };
    const cid = await saveCheck(id, tpl, cleaned, note);
    checkId.current = cid;
    return cid;
  };

  const saveDraft = async () => {
    setBusy('draft'); setErr(null);
    try { await persist(); toast.ok('บันทึกร่างแล้ว'); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  /** แนบได้หลายรูปในครั้งเดียว (อัปโหลดทีละรูปตามลำดับ) — รูปที่สำเร็จแล้วไม่หาย แม้รูปถัดไปจะล้มเหลว */
  const addPhotos = async (files: File[]) => {
    if (!files.length) return;
    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) { setErr(`แนบได้สูงสุด ${MAX_PHOTOS} รูป`); return; }
    const list = files.slice(0, room);
    setBusy('photo'); setErr(null);
    let ok = 0;
    try {
      const cid = checkId.current ?? await persist();
      for (const file of list) {
        setProgress(`${ok + 1}/${list.length}`);
        const img = await compressImage(file);
        const path = await uploadFile(`${profile.branch_id}/${id}/photo/${crypto.randomUUID()}.${img.ext}`, img.blob, img.type);
        const photoId = await addCheckPhoto(cid, path);
        const u = await signedUrls([path]);
        setPhotos((p) => [...p, { id: photoId, check_id: cid, storage_path: path, caption: null }]);
        setUrls((x) => ({ ...x, ...u }));
        ok += 1;
      }
      if (files.length > room) setErr(`แนบได้สูงสุด ${MAX_PHOTOS} รูป — ข้ามรูปที่เกิน ${files.length - room} รูป`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const msg = ok > 0 ? `แนบสำเร็จ ${ok} รูป แต่รูปที่ ${ok + 1} ไม่สำเร็จ: ${m}` : `แนบรูปไม่สำเร็จ: ${m}`;
      setErr(msg); toast.err(msg);
    } finally { setBusy(null); setProgress(''); if (fileRef.current) fileRef.current.value = ''; }
  };

  /** camera=true เปิดกล้องหลังบนมือถือ ; false เปิดหน้าต่างเลือกไฟล์/คลังรูป (เลือกได้หลายรูป) — ใช้ input ตัวเดียวสลับ attribute */
  const pickPhotos = (camera: boolean) => {
    const el = fileRef.current;
    if (!el) return;
    if (camera) el.setAttribute('capture', 'environment'); else el.removeAttribute('capture');
    el.click();
  };

  const finish = async () => {
    setErr(null);
    if (answered < template.checklist.length) { setErr(`ยังไม่ได้ตอบ ${template.checklist.length - answered} ข้อ`); return; }
    if (defectNoNote) { setErr('ข้อที่พบตำหนิ ต้องเขียนรายละเอียดตำหนิ'); return; }
    if (photos.length < template.min_photos) { setErr(`ต้องแนบรูปอย่างน้อย ${template.min_photos} รูป`); return; }
    if (!signedBy.trim()) { setErr('กรอกชื่อผู้เซ็น'); return; }
    if (!pad.current || pad.current.isEmpty()) { setErr('ให้ลูกค้าเซ็นยืนยันก่อน'); return; }
    setBusy('done');
    try {
      const cid = await persist();
      const blob = await pad.current.toBlob();
      const sig = await uploadFile(`${profile.branch_id}/${id}/signature/${crypto.randomUUID()}.png`, blob, 'image/png');
      await completeCheck(cid, sig, signedBy.trim());
      toast.ok('ยืนยันเช็คสภาพแล้ว');
      router.replace(`/jobs/${id}`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(null); }
  };

  return (
    <>
      <PageHeader title={template.name} subtitle={job.job_no} back={`/jobs/${id}`} right={<Plate plate={job.plate} province={job.plate_province} className="mr-2 text-[1.1rem]" />} />

      <div className="space-y-7 px-4 pb-36 pt-5">
        {tooEarly ? (
          <p role="status" data-testid="check-too-early" className="flex items-start gap-2 rounded-xl border border-warn/50 bg-warn/10 px-4 py-3 text-[15px] text-warn">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
            <span>
              ใบงานยังไม่เข้าขั้นเช็คสภาพรถ ยังบันทึก แนบรูป และให้ลูกค้าเซ็นไม่ได้ —
              กลับไปหน้าใบงานแล้วกด “{job.status === 'booked' ? 'รับรถเข้าร้าน' : 'เริ่มเช็คสภาพรถ'}” ก่อน{job.status === 'booked' ? ' (แล้วกด “เริ่มเช็คสภาพรถ” ต่อ)' : ''}
            </span>
          </p>
        ) : locked && (
          <p className="flex items-center gap-2 rounded-xl border border-ok/40 bg-ok/10 px-4 py-3 text-[15px] text-ok">
            <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden />
            {done ? `ยืนยันแล้ว ลูกค้าเซ็นเมื่อ ${fmtDateTime(d.check?.signed_at)}` : 'งานเริ่มแล้ว แก้ไขเช็คสภาพไม่ได้'}
          </p>
        )}

        <section aria-label="รายการตรวจ">
          <div className="flex items-baseline justify-between pb-2">
            <h2 className="section-title">รายการตรวจ</h2>
            <span className="num text-[14px] text-mute">ตอบแล้ว {answered}/{template.checklist.length}</span>
          </div>
          <ul className="ledger border-y border-rule">
            {template.checklist.map((it) => {
              const a = answers[it.key];
              return (
                <li key={it.key} className="space-y-2.5 py-3.5">
                  <p className="font-medium">{it.label}</p>
                  {locked ? (
                    <p className={cx('text-[15px]', a?.state === 'defect' ? 'text-bad' : a?.state === 'ok' ? 'text-ok' : 'text-mute')}>
                      {OPTIONS.find((o) => o.value === a?.state)?.label ?? 'ไม่ได้ตอบ'}{a?.note ? ` ${a.note}` : ''}
                    </p>
                  ) : (
                    <>
                      <Segmented label={it.label} value={(a?.state ?? '') as AnswerState} onChange={(v) => setAnswer(it.key, { state: v })} options={OPTIONS} />
                      {a?.state === 'defect' && (
                        <textarea
                          rows={2} className="field" aria-label={`รายละเอียดตำหนิ ${it.label}`} placeholder="ระบุตำแหน่งและลักษณะตำหนิ"
                          value={a.note ?? ''} onChange={(e) => setAnswer(it.key, { note: e.target.value })}
                        />
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-label="รูปถ่าย">
          <div className="flex items-baseline justify-between pb-2">
            <h2 className="section-title">รูปถ่ายสภาพรถ</h2>
            <span className={cx('num text-[14px]', photos.length >= template.min_photos ? 'text-ok' : 'text-warn')} data-testid="photo-count">
              แนบแล้ว {photos.length} รูป · ขั้นต่ำ {template.min_photos} · ได้สูงสุด {MAX_PHOTOS}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {photos.map((p) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={p.id} src={urls[p.storage_path]} alt="รูปสภาพรถ" className="aspect-square w-full rounded-lg border border-rule object-cover" />
            ))}
            {!locked && photos.length < MAX_PHOTOS && (
              <>
                <button
                  type="button" onClick={() => pickPhotos(true)} disabled={busy !== null}
                  className="grid aspect-square place-items-center rounded-lg border border-dashed border-gold/50 text-gold-hi transition-colors hover:bg-gold/10 disabled:opacity-60"
                >
                  <span className="flex flex-col items-center gap-1 text-[13px]"><Camera className="h-6 w-6" aria-hidden />{busy === 'photo' ? `กำลังอัปโหลด ${progress}` : 'ถ่ายรูป'}</span>
                </button>
                <button
                  type="button" onClick={() => pickPhotos(false)} disabled={busy !== null}
                  className="grid aspect-square place-items-center rounded-lg border border-dashed border-gold/50 text-gold-hi transition-colors hover:bg-gold/10 disabled:opacity-60"
                >
                  <span className="flex flex-col items-center gap-1 text-[13px]"><ImagePlus className="h-6 w-6" aria-hidden />เลือกรูป (หลายรูปได้)</span>
                </button>
              </>
            )}
          </div>
          <input
            ref={fileRef} type="file" accept="image/*" multiple className="sr-only" aria-label="ถ่ายหรือเลือกรูป"
            onChange={(e) => void addPhotos(Array.from(e.target.files ?? []))}
          />
        </section>

        <section aria-label="ลายเซ็นลูกค้า">
          <h2 className="section-title pb-2">ลูกค้าเซ็นยืนยันสภาพรถ</h2>
          {locked && d.check?.signature_path ? (
            <div className="space-y-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={urls[d.check.signature_path]} alt="ลายเซ็นลูกค้า" className="h-40 w-full rounded-xl border border-rule bg-white object-contain" />
              <p className="text-[14px] text-dim">ผู้เซ็น {d.check.signed_by_name}</p>
            </div>
          ) : locked ? (
            <p className="text-[15px] text-mute">ยังไม่มีลายเซ็น</p>
          ) : (
            <div className="space-y-4">
              <Field label="ชื่อผู้เซ็น" htmlFor="signed-by"><input id="signed-by" className="field" value={signedBy} onChange={(e) => setSignedBy(e.target.value)} /></Field>
              <SignaturePad ref={pad} />
            </div>
          )}
        </section>

        {!locked && (
          <Field label="หมายเหตุเพิ่มเติม (ถ้ามี)" htmlFor="chk-note">
            <textarea id="chk-note" rows={2} className="field" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
        {err && <p role="alert" className="text-[15px] text-bad">{err}</p>}
      </div>

      {!locked && (
        <div className="no-print fixed inset-x-0 bottom-[calc(60px+env(safe-area-inset-bottom))] z-30 border-t border-rule bg-lacquer/95 px-4 py-3 backdrop-blur lg:bottom-0 lg:left-24">
          <div className="mx-auto flex max-w-3xl gap-3">
            <Button variant="outline" onClick={saveDraft} loading={busy === 'draft'} disabled={busy !== null && busy !== 'draft'}>บันทึกร่าง</Button>
            <Button className="flex-1" onClick={finish} loading={busy === 'done'} disabled={busy !== null && busy !== 'done'}>ยืนยันเช็คสภาพ</Button>
          </div>
        </div>
      )}
    </>
  );
}
