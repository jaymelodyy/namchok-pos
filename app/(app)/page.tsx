'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, CarFront, UserRound } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { JobRow } from '@/components/job-row';
import { Button, Field, Plate, PlateInput, Skeleton, Spinner } from '@/components/ui';
import { useToast } from '@/components/providers';
import { listJobs, openJob, searchVehicles, type VehicleHit } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { cx, plateNorm, relativeDay, vehicleLabel } from '@/lib/format';
import { useAsync, useDebounced } from '@/lib/hooks';
import { SOURCE_LABEL } from '@/lib/labels';
import { DEFAULT_PROVINCE } from '@/lib/provinces';
import type { JobSource } from '@/lib/types';

export default function HomePage() {
  const { role } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (role === 'technician') router.replace('/work');
    if (role === 'warehouse') router.replace('/requisitions');
  }, [role, router]);
  if (role === 'technician' || role === 'warehouse') return <Spinner />;
  return <OpenJobScreen />;
}

function OpenJobScreen() {
  const { settings, canSeeMoney } = useSession();
  const router = useRouter();
  const toast = useToast();

  const [plate, setPlate] = useState('');
  const [province, setProvince] = useState(DEFAULT_PROVINCE);
  const [hits, setHits] = useState<VehicleHit[] | null>(null);
  const [picked, setPicked] = useState<VehicleHit | null>(null);
  const [form, setForm] = useState({ brand: '', model: '', year: '', odometer: '', name: '', phone: '', complaint: '', source: 'walk_in' as JobSource, booked: false, scheduledAt: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounced = useDebounced(plate, 180);
  useEffect(() => {
    let alive = true;
    if (!plateNorm(debounced)) { setHits(null); return; }
    searchVehicles(debounced).then((h) => { if (alive) setHits(h); }).catch(() => { if (alive) setHits([]); });
    return () => { alive = false; };
  }, [debounced]);

  // ถ้าแก้ทะเบียนจนไม่ตรงกับรถที่เลือกไว้ → เลิกเลือก
  useEffect(() => {
    if (picked && plateNorm(plate) !== plateNorm(picked.plate)) setPicked(null);
  }, [plate, picked]);

  const jobs = useAsync(listJobs, []);
  const active = useMemo(() => (jobs.data ?? []).filter((j) => !j.voided_at && j.status !== 'closed' && j.status !== 'cancelled'), [jobs.data]);

  const pick = (h: VehicleHit) => {
    setPicked(h);
    setPlate(h.plate);
    setProvince(h.plate_province ?? '');
    setForm((f) => ({ ...f, odometer: '' }));
    setError(null);
  };
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const hasPlate = plateNorm(plate).length > 0;
  const ready = hasPlate && (picked ? true : form.name.trim().length > 0);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const id = await openJob({
        plate: plate.trim(), province: province.trim() || null,
        brand: picked ? undefined : form.brand.trim(), model: picked ? undefined : form.model.trim(),
        year: !picked && form.year ? Number(form.year) : null,
        odometer: form.odometer ? Number(form.odometer) : null,
        customerName: picked ? undefined : form.name.trim(), phone: picked ? undefined : form.phone.trim(),
        source: form.source, complaint: form.complaint.trim(),
        scheduledAt: form.booked && form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null,
        vehicleId: picked?.id ?? null,
      });
      toast.ok('เปิดใบงานแล้ว');
      router.push(`/jobs/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="รับรถเข้าร้าน" subtitle={settings?.shop_name} />

      <section className="px-4 pb-2 pt-6">
        <p className="mb-4 text-center text-[15px] text-dim">พิมพ์ทะเบียน ถ้าเคยมาร้านจะขึ้นประวัติให้เลย</p>
        <PlateInput plate={plate} province={province} onPlate={setPlate} onProvince={setProvince} autoFocus />
      </section>

      {/* ประวัติรถที่ตรงกับทะเบียนที่พิมพ์ */}
      {hits && hits.length > 0 && !picked && (
        <ul className="ledger mx-4 mt-3 overflow-hidden rounded-xl border border-rule bg-raised" aria-label="รถที่ตรงกับทะเบียน">
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" onClick={() => pick(h)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-inset">
                <Plate plate={h.plate} province={h.plate_province} className="shrink-0 text-[1.3rem]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{h.customer_name ?? 'ไม่ระบุลูกค้า'}</span>
                  <span className="block truncate text-[14px] text-dim">{vehicleLabel(h)}</span>
                  <span className="block truncate text-[13px] text-mute">
                    {h.visits > 0 ? `มาแล้ว ${h.visits} ครั้ง` : 'ยังไม่เคยปิดงาน'}{h.last_visit ? ` ล่าสุด ${relativeDay(h.last_visit)}` : ''}
                  </span>
                </span>
                <span className="text-[14px] font-medium text-gold-hi">เลือก</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {hasPlate && (
        <section className="mx-4 mt-5 space-y-4">
          {picked ? (
            <div className="rounded-xl border border-gold/30 bg-raised p-4">
              <div className="flex items-start gap-3">
                <CarFront className="mt-0.5 h-5 w-5 shrink-0 text-gold" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{vehicleLabel(picked)}</p>
                  <p className="flex items-center gap-1.5 text-[14px] text-dim"><UserRound className="h-4 w-4" aria-hidden />{picked.customer_name ?? 'ไม่ระบุลูกค้า'}{picked.customer_phone ? ` โทร ${picked.customer_phone}` : ''}</p>
                  {picked.last_odometer != null && <p className="text-[13px] text-mute">เลขไมล์ครั้งก่อน {picked.last_odometer.toLocaleString('th-TH')} กม.</p>}
                </div>
                <Button variant="ghost" small onClick={() => setPicked(null)}>ไม่ใช่คันนี้</Button>
              </div>
              {picked.open_job_id && (
                <p className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-[14px] text-warn">
                  คันนี้มีใบงานที่ยังไม่ปิดอยู่แล้ว <Link className="font-semibold underline" href={`/jobs/${picked.open_job_id}`}>เปิดใบงานเดิม</Link>
                </p>
              )}
            </div>
          ) : (
            <>
              <Field label="ชื่อลูกค้า" htmlFor="c-name">
                <input id="c-name" className="field" autoComplete="off" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="เช่น คุณสมชาย" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="เบอร์โทร" htmlFor="c-phone">
                  <input id="c-phone" className="field" inputMode="tel" autoComplete="off" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
                </Field>
                <Field label="เลขไมล์ (กม.)" htmlFor="c-odo">
                  <input id="c-odo" className="field num" inputMode="numeric" value={form.odometer} onChange={(e) => set('odometer', e.target.value.replace(/\D/g, ''))} />
                </Field>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5.5rem] gap-3">
                <div><Field label="ยี่ห้อรถ" htmlFor="c-brand"><input id="c-brand" className="field" value={form.brand} onChange={(e) => set('brand', e.target.value)} placeholder="Toyota" /></Field></div>
                <div><Field label="รุ่น" htmlFor="c-model"><input id="c-model" className="field" value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="Vios" /></Field></div>
                <Field label="ปี" htmlFor="c-year"><input id="c-year" className="field num" inputMode="numeric" maxLength={4} value={form.year} onChange={(e) => set('year', e.target.value.replace(/\D/g, ''))} placeholder="2015" /></Field>
              </div>
            </>
          )}

          {picked && (
            <Field label="เลขไมล์ตอนนี้ (กม.)" htmlFor="p-odo">
              <input id="p-odo" className="field num" inputMode="numeric" value={form.odometer} onChange={(e) => set('odometer', e.target.value.replace(/\D/g, ''))} />
            </Field>
          )}

          <Field label="อาการ / งานที่ลูกค้าต้องการ" htmlFor="c-complaint">
            <textarea id="c-complaint" rows={2} className="field" value={form.complaint} onChange={(e) => set('complaint', e.target.value)} placeholder="เช่น แอร์ไม่เย็น มีกลิ่นอับ" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="ลูกค้ารู้จักร้านจาก" htmlFor="c-source">
              <select id="c-source" className="field" value={form.source} onChange={(e) => set('source', e.target.value as JobSource)}>
                {(Object.keys(SOURCE_LABEL) as JobSource[]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
              </select>
            </Field>
            <div>
              <span className="label">จองคิวล่วงหน้า</span>
              <button
                type="button" role="switch" aria-checked={form.booked} onClick={() => set('booked', !form.booked)}
                className={cx('flex min-h-tap w-full items-center justify-between rounded-xl border px-4 text-[15px]', form.booked ? 'border-gold bg-gold/10 text-gold-hi' : 'border-rule bg-inset text-dim')}
              >
                <span className="flex items-center gap-2"><CalendarClock className="h-4 w-4" aria-hidden />{form.booked ? 'จองคิว' : 'มาวันนี้'}</span>
              </button>
            </div>
          </div>
          {form.booked && (
            <Field label="วัน-เวลานัด" htmlFor="c-when">
              <input id="c-when" type="datetime-local" className="field" value={form.scheduledAt} onChange={(e) => set('scheduledAt', e.target.value)} />
            </Field>
          )}

          {error && <p role="alert" className="text-[15px] text-bad">{error}</p>}
          <Button className="w-full" onClick={submit} loading={busy} disabled={!ready || (form.booked && !form.scheduledAt)}>
            {form.booked ? 'บันทึกการจองคิว' : 'เปิดใบงาน'}
          </Button>
        </section>
      )}

      {/* ในร้านตอนนี้ */}
      {!hasPlate && (
        <section className="mt-8">
          <div className="flex items-baseline justify-between px-4 pb-2">
            <h2 className="section-title">ในร้านตอนนี้</h2>
            <Link href="/jobs" className="text-[14px] text-gold-hi hover:underline">ดูใบงานทั้งหมด</Link>
          </div>
          {jobs.loading ? (
            <div className="space-y-2 px-4"><Skeleton className="h-[76px]" /><Skeleton className="h-[76px]" /></div>
          ) : jobs.error ? (
            <p role="alert" className="px-4 text-bad">{jobs.error}</p>
          ) : active.length === 0 ? (
            <p className="px-4 py-6 text-[15px] text-mute">ยังไม่มีรถในร้าน พิมพ์ทะเบียนด้านบนเพื่อรับรถคันแรกของวัน</p>
          ) : (
            <div className="ledger border-y border-rule">
              {active.slice(0, 6).map((j) => <JobRow key={j.id} job={j} showMoney={canSeeMoney} />)}
            </div>
          )}
        </section>
      )}
    </>
  );
}
