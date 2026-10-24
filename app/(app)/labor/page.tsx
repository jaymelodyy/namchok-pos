'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, ChevronDown } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { LiveDot } from '@/components/live-notifier';
import { useToast } from '@/components/providers';
import { Button, ConfirmSheet, Empty, ErrorNote, Money, ReasonSheet, Skeleton, Spinner } from '@/components/ui';
import { listLabor, listUsers, markLaborPaid, unmarkLaborPaid } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { addDays, bangkokDate, cx, fmtDate, fmtMoney } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { useLive } from '@/lib/realtime';
import type { LaborEntry } from '@/lib/types';

type Preset = 'today' | '7d' | 'month' | 'lastmonth' | 'custom';
const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'วันนี้' }, { key: '7d', label: '7 วันล่าสุด' }, { key: 'month', label: 'เดือนนี้' },
  { key: 'lastmonth', label: 'เดือนก่อน' }, { key: 'custom', label: 'กำหนดเอง' },
];
function range(p: Preset, today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (p) {
    case 'today': return { from: today, to: today };
    case '7d': return { from: addDays(today, -6), to: today };
    case 'month': return { from: `${y}-${pad(m)}-01`, to: today };
    case 'lastmonth': {
      const py = m === 1 ? y - 1 : y; const pm = m === 1 ? 12 : m - 1;
      const first = `${py}-${pad(pm)}-01`;
      return { from: first, to: addDays(`${y}-${pad(m)}-01`, -1) };
    }
    default: return { from: today, to: today };
  }
}

export default function LaborPage() {
  const { role } = useSession();
  const router = useRouter();
  useEffect(() => { if (role !== 'technician' && role !== 'owner') router.replace('/'); }, [role, router]);
  if (role !== 'technician' && role !== 'owner') return <Spinner />;
  return <LaborScreen />;
}

function LaborScreen() {
  const { role, profile } = useSession();
  const isOwner = role === 'owner';
  const today = bangkokDate();
  const [preset, setPreset] = useState<Preset>('month');
  const [custom, setCustom] = useState({ from: addDays(today, -6), to: today });
  const { from, to } = preset === 'custom' ? custom : range(preset, today);
  const validRange = Boolean(from && to && from <= to);

  const st = useAsync(async () => {
    if (!validRange) return { entries: [] as LaborEntry[], names: {} as Record<string, string> };
    const [entries, users] = await Promise.all([listLabor({ from, to }), isOwner ? listUsers() : Promise.resolve([])]);
    return { entries, names: Object.fromEntries(users.map((u) => [u.id, u.full_name])) as Record<string, string> };
  }, [from, to, isOwner, validRange]);
  const live = useLive(['labor_pay_entries'], () => void st.reload());

  const groups = useMemo(() => {
    const m = new Map<string, LaborEntry[]>();
    for (const e of st.data?.entries ?? []) m.set(e.user_id, [...(m.get(e.user_id) ?? []), e]);
    return [...m.entries()].map(([uid, list]) => ({
      uid, name: uid === profile.id ? profile.full_name : st.data?.names[uid] ?? 'ช่าง', list,
      total: sum(list), paid: sum(list.filter((e) => e.paid_at)), unpaid: sum(list.filter((e) => !e.paid_at)),
    })).sort((a, b) => b.unpaid - a.unpaid || a.name.localeCompare(b.name));
  }, [st.data, profile]);
  const all = useMemo(() => ({ total: sum(st.data?.entries ?? []), paid: sum((st.data?.entries ?? []).filter((e) => e.paid_at)), unpaid: sum((st.data?.entries ?? []).filter((e) => !e.paid_at)) }), [st.data]);

  return (
    <>
      <PageHeader title="ค่าแรง" subtitle={isOwner ? 'สรุปรายช่าง' : 'เฉพาะของคุณ'} back={isOwner ? '/reports' : undefined} right={<div className="pr-3"><LiveDot status={live} /></div>} />
      <div className="space-y-5 px-4 pb-8 pt-4">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="ช่วงเวลา">
          {PRESETS.map((p) => (
            <button key={p.key} role="tab" aria-selected={preset === p.key} onClick={() => setPreset(p.key)} data-testid={`preset-${p.key}`}
              className={cx('shrink-0 rounded-full border px-4 py-2 text-[14px] font-medium', preset === p.key ? 'border-gold bg-gold/15 text-gold-hi' : 'border-rule text-dim hover:text-ivory')}>
              {p.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="label">ตั้งแต่</span><input type="date" className="field num" value={custom.from} max={custom.to} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
            <label className="block"><span className="label">ถึง</span><input type="date" className="field num" value={custom.to} min={custom.from} max={today} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
          </div>
        )}
        <p className="text-[13px] text-mute">นับตามวันที่ปิดงาน · {fmtDate(`${from}T12:00:00+07:00`)} – {fmtDate(`${to}T12:00:00+07:00`)}</p>

        <dl className="grid grid-cols-3 gap-2" data-testid="labor-summary">
          <Stat k="รวม" v={all.total} testid="sum-total" />
          <Stat k="จ่ายแล้ว" v={all.paid} tone="ok" testid="sum-paid" />
          <Stat k="ค้างจ่าย" v={all.unpaid} tone={all.unpaid > 0 ? 'warn' : undefined} testid="sum-unpaid" />
        </dl>

        {!validRange ? <p role="alert" className="text-bad">ช่วงวันที่ไม่ถูกต้อง</p>
          : st.loading ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>
          : st.error && !st.data ? <ErrorNote message={st.error} onRetry={() => void st.reload()} />
          : groups.length === 0 ? <Empty title="ยังไม่มีค่าแรงในช่วงนี้" hint="ค่าแรงจะเข้าเมื่อเจ้าของ/แอดมินปิดงาน โดยหารเท่ากันตามช่างที่ทำงานนั้นจริง" />
          : isOwner
            ? <div className="space-y-3">{groups.map((g) => <OwnerGroup key={g.uid} g={g} from={from} to={to} onChanged={() => void st.reload()} />)}</div>
            : <EntryList list={groups[0]?.list ?? []} />}
      </div>
    </>
  );
}

const sum = (l: LaborEntry[]) => l.reduce((a, e) => a + e.amount, 0);

function Stat({ k, v, tone, testid }: { k: string; v: number; tone?: 'ok' | 'warn'; testid: string }) {
  return (
    <div className="rounded-xl border border-rule bg-raised px-3 py-2.5">
      <dt className="text-[12px] text-mute">{k}</dt>
      <dd className={cx('num font-display text-[19px] font-semibold', tone === 'ok' && 'text-ok', tone === 'warn' && 'text-warn', !tone && 'text-gold-hi')} data-testid={testid}>{fmtMoney(v)}</dd>
    </div>
  );
}

function EntryList({ list }: { list: LaborEntry[] }) {
  return (
    <ul className="ledger overflow-hidden rounded-xl border border-rule" data-testid="labor-list">
      {list.map((e) => (
        <li key={e.id} className="flex items-start justify-between gap-3 px-4 py-3" data-testid="labor-row">
          <div className="min-w-0">
            <p className="font-medium">{e.item_name}{e.variant_label ? ` · ${e.variant_label}` : ''}</p>
            <p className="text-[13px] text-mute"><span className="num">{e.job_no}</span> · {e.plate} · {fmtDate(`${e.earned_on}T12:00:00+07:00`)}</p>
            <p className="text-[13px] text-dim">
              <span className="num">{fmtMoney(e.labor_rate)}</span>{e.qty !== 1 && <> × <span className="num">{e.qty}</span></>}
              {e.crew_actual > 1 ? <> ÷ {e.crew_actual} ช่าง</> : null}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <Money v={e.amount} className="font-medium" />
            <p className={cx('text-[12px]', e.paid_at ? 'text-ok' : 'text-warn')}>{e.paid_at ? 'จ่ายแล้ว' : 'ค้างจ่าย'}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function OwnerGroup({ g, from, to, onChanged }: {
  g: { uid: string; name: string; list: LaborEntry[]; total: number; paid: number; unpaid: number }; from: string; to: string; onChanged: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const [undoing, setUndoing] = useState(false);
  return (
    <section className="rounded-2xl border border-rule bg-raised" data-testid="labor-group" data-tech={g.name}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3.5 text-left">
        <div className="min-w-0 flex-1">
          <p className="font-display text-[17px] font-semibold">{g.name}</p>
          <p className="text-[13px] text-mute">{g.list.length} รายการ · รวม <span className="num">{fmtMoney(g.total)}</span></p>
        </div>
        <div className="text-right">
          <p className={cx('num font-display text-[18px] font-semibold', g.unpaid > 0 ? 'text-warn' : 'text-ok')} data-testid="group-unpaid">{fmtMoney(g.unpaid)}</p>
          <p className="text-[12px] text-mute">{g.unpaid > 0 ? 'ค้างจ่าย' : 'จ่ายครบแล้ว'}</p>
        </div>
        <ChevronDown className={cx('h-5 w-5 text-mute transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && <div className="border-t border-rule"><EntryList list={g.list} /></div>}
      <div className="flex gap-2 border-t border-rule p-3">
        {g.unpaid > 0 && <Button className="flex-1" onClick={() => setPaying(true)} data-testid="mark-paid"><BadgeCheck className="h-4 w-4" aria-hidden />ทำเครื่องหมายจ่ายแล้ว {fmtMoney(g.unpaid)}</Button>}
        {g.paid > 0 && <Button variant="ghost" onClick={() => setUndoing(true)} data-testid="unmark-paid">ยกเลิกการจ่าย</Button>}
      </div>
      <ConfirmSheet
        open={paying} title={`จ่ายค่าแรง ${g.name}`} confirmLabel={`ยืนยันจ่าย ${fmtMoney(g.unpaid)}`} onClose={() => setPaying(false)}
        description={`ทำเครื่องหมายว่าจ่ายค่าแรงที่ค้างของช่างคนนี้ช่วง ${from} ถึง ${to} แล้ว (ระบบบันทึกเฉพาะสถานะ ไม่ได้โอนเงินจริง)`}
        onConfirm={async () => { const n = await markLaborPaid(g.uid, from, to); setPaying(false); toast.ok(`ทำเครื่องหมายจ่ายแล้ว ${n} รายการ`); onChanged(); }}
      />
      <ReasonSheet
        open={undoing} title={`ยกเลิกการจ่าย ${g.name}`} confirmLabel="ยกเลิกการจ่าย" danger onClose={() => setUndoing(false)}
        description={`รายการที่ทำเครื่องหมายจ่ายแล้วช่วง ${from} ถึง ${to} จะกลับเป็น "ค้างจ่าย"`} placeholder="เช่น กดจ่ายผิดคน"
        onConfirm={async (r) => { const n = await unmarkLaborPaid(g.uid, from, to, r); setUndoing(false); toast.ok(`ยกเลิกการจ่าย ${n} รายการ`); onChanged(); }}
      />
    </section>
  );
}
