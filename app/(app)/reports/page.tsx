'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Wallet } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { Empty, ErrorNote, Field, Skeleton } from '@/components/ui';
import { paymentsInRange, refundsInRange, revenueReport, vatSummary } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { addDays, bangkokDate, cx, fmtMoney } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { ITEM_TYPE_LABEL, METHOD_LABEL } from '@/lib/labels';
import type { ItemType, PayMethod } from '@/lib/types';

type Preset = 'today' | '7d' | 'month' | 'custom';

export default function ReportsPage() {
  const { isOwner } = useSession();
  const router = useRouter();
  useEffect(() => { if (!isOwner) router.replace('/'); }, [isOwner, router]);

  const today = bangkokDate();
  const [preset, setPreset] = useState<Preset>('today');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  const pick = (p: Preset) => {
    setPreset(p);
    if (p === 'today') { setFrom(today); setTo(today); }
    if (p === '7d') { setFrom(addDays(today, -6)); setTo(today); }
    if (p === 'month') { setFrom(`${today.slice(0, 8)}01`); setTo(today); }
  };

  const valid = from <= to;
  const data = useAsync(async () => {
    if (!isOwner || !valid) return null;
    const [rows, pays, refunds, vat] = await Promise.all([
      revenueReport(from, to), paymentsInRange(from, addDays(to, 1)), refundsInRange(from, addDays(to, 1)), vatSummary(from, to),
    ]);
    return { rows, pays, refunds, vat };
  }, [from, to, isOwner]);

  const view = useMemo(() => {
    const rows = data.data?.rows ?? [];
    const total = rows.reduce((s, r) => s + r.revenue, 0);
    const mains = new Map<string, { code: string; name: string; total: number; subs: Map<string, { code: string; name: string; byType: Partial<Record<ItemType, number>>; total: number }> }>();
    for (const r of rows) {
      const m = mains.get(r.main_code) ?? { code: r.main_code, name: r.main_name, total: 0, subs: new Map() };
      m.total += r.revenue;
      const s = m.subs.get(r.sub_code) ?? { code: r.sub_code, name: r.sub_name, byType: {}, total: 0 };
      s.byType[r.line_type] = (s.byType[r.line_type] ?? 0) + r.revenue;
      s.total += r.revenue;
      m.subs.set(r.sub_code, s); mains.set(r.main_code, m);
    }
    const byMethod: Record<PayMethod, { sum: number; n: number; refund: number }> = {
      cash: { sum: 0, n: 0, refund: 0 }, qr_promptpay: { sum: 0, n: 0, refund: 0 }, transfer: { sum: 0, n: 0, refund: 0 },
    };
    for (const p of data.data?.pays ?? []) { byMethod[p.method].sum += p.amount; byMethod[p.method].n += 1; }
    for (const r of data.data?.refunds ?? []) byMethod[r.method].refund += r.amount;
    const typeTotals = rows.reduce<Partial<Record<ItemType, number>>>((a, r) => ({ ...a, [r.line_type]: (a[r.line_type] ?? 0) + r.revenue }), {});
    return { total, mains: [...mains.values()], byMethod, typeTotals, empty: rows.length === 0 };
  }, [data.data]);

  if (!isOwner) return null;
  const received = Object.values(view.byMethod).reduce((s, x) => s + x.sum - x.refund, 0);
  const vat = data.data?.vat ?? null;

  return (
    <>
      <PageHeader title="รายงานรายได้" subtitle="นับจากใบงานที่ปิดแล้วและไม่ถูก void ตามวันที่ปิดงาน ยอดรวม VAT แล้ว" />
      <div className="space-y-5 px-4 pb-8 pt-4">
        <div className="flex gap-2 overflow-x-auto" role="tablist" aria-label="ช่วงเวลา">
          {([['today', 'วันนี้'], ['7d', '7 วันล่าสุด'], ['month', 'เดือนนี้'], ['custom', 'เลือกเอง']] as [Preset, string][]).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={preset === k} onClick={() => pick(k)}
              className={cx('shrink-0 rounded-full border px-4 py-2 text-[14px] font-medium', preset === k ? 'border-gold bg-gold/15 text-gold-hi' : 'border-rule text-dim hover:text-ivory')}>{l}</button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="ตั้งแต่" htmlFor="r-from"><input id="r-from" type="date" className="field" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="ถึง" htmlFor="r-to"><input id="r-to" type="date" className="field" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          </div>
        )}
        {!valid && <p role="alert" className="text-bad">วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด</p>}

        {data.loading ? <><Skeleton className="h-28" /><Skeleton className="h-48" /></> : data.error ? <ErrorNote message={data.error} onRetry={() => void data.reload()} /> : (
          <>
            <section aria-label="รายได้รวม" className="rounded-xl border border-gold/30 bg-raised px-5 py-5">
              <p className="text-[14px] text-dim">รายได้รวมช่วงนี้</p>
              <p className="num font-display text-[40px] font-bold leading-tight text-gold-hi">{fmtMoney(view.total)}</p>
              {vat && vat.vat_total > 0 && (
                <p className="mt-1 text-[14px] text-dim" data-testid="vat-summary">
                  ในนี้เป็น VAT <span className="num">{fmtMoney(vat.vat_total, { fixed: true })}</span> · ก่อน VAT <span className="num">{fmtMoney(vat.ex_vat_total, { fixed: true })}</span> · {vat.job_count} ใบงาน
                </p>
              )}
              <p className="mt-1 text-[14px] text-dim">
                {(['service', 'part', 'fee', 'discount'] as ItemType[]).filter((t) => view.typeTotals[t]).map((t) => `${ITEM_TYPE_LABEL[t]} ${fmtMoney(view.typeTotals[t])}`).join('   ')}
              </p>
            </section>

            {view.empty ? (
              <Empty title="ยังไม่มีงานที่ปิดในช่วงนี้" hint="เมื่อปิดงานแล้ว รายได้จะแยกตามหมวดหลัก หมวดย่อย และแยกค่าแรงกับอะไหล่ให้ที่นี่" />
            ) : (
              <section aria-label="รายได้แยกตามหมวด" className="space-y-6">
                {view.mains.map((m) => (
                  <div key={m.code}>
                    <div className="flex items-baseline justify-between">
                      <h2 className="section-title">{m.name}</h2>
                      <span className="num font-display text-[18px] font-semibold text-gold-hi">{fmtMoney(m.total)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-rule" aria-hidden>
                      <div className="h-full rounded-full bg-gold" style={{ width: `${view.total > 0 ? Math.max(2, Math.round((m.total / view.total) * 100)) : 0}%` }} />
                    </div>
                    <ul className="ledger mt-2">
                      {[...m.subs.values()].map((s) => (
                        <li key={s.code} className="py-2.5">
                          <div className="flex items-baseline justify-between">
                            <span className="font-medium"><span className="num mr-2 text-[12px] text-mute">{s.code}</span>{s.name}</span>
                            <span className="num">{fmtMoney(s.total)}</span>
                          </div>
                          <p className="mt-0.5 text-[13px] text-mute">
                            {(Object.keys(s.byType) as ItemType[]).map((t) => `${ITEM_TYPE_LABEL[t]} ${fmtMoney(s.byType[t])}`).join('   ')}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            )}

            <Link href="/labor" className="flex items-center justify-between rounded-xl border border-rule bg-raised px-4 py-3.5 transition-colors hover:border-gold/50" data-testid="labor-link">
              <span className="flex items-center gap-3"><Wallet className="h-5 w-5 text-gold" aria-hidden /><span><span className="block font-medium">ค่าแรงช่าง</span><span className="block text-[13px] text-mute">สรุปรายช่าง ทำเครื่องหมายจ่ายแล้ว</span></span></span>
              <span className="text-mute" aria-hidden>›</span>
            </Link>

            <section aria-label="เงินที่รับตามช่องทาง">
              <div className="flex items-baseline justify-between">
                <h2 className="section-title">เงินที่รับตามช่องทาง</h2>
                <span className="num text-[15px] text-dim">{fmtMoney(received)}</span>
              </div>
              <p className="text-[13px] text-mute">รวมมัดจำและรับชำระทุกใบงานตามวันที่รับเงิน หักเงินที่คืนลูกค้า ไม่รวมรายการที่ void</p>
              <ul className="ledger mt-2">
                {(Object.keys(METHOD_LABEL) as PayMethod[]).map((m) => (
                  <li key={m} className="flex items-baseline justify-between py-2.5">
                    <span>{METHOD_LABEL[m]} <span className="num text-[13px] text-mute">{view.byMethod[m].n} รายการ{view.byMethod[m].refund > 0 ? ` · คืน ${fmtMoney(view.byMethod[m].refund)}` : ''}</span></span>
                    <span className="num">{fmtMoney(view.byMethod[m].sum - view.byMethod[m].refund)}</span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </>
  );
}
