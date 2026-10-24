'use client';
import { useMemo, useState } from 'react';
import { CheckCheck, PackageCheck, Undo2 } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { LiveDot } from '@/components/live-notifier';
import { useToast } from '@/components/providers';
import { RequisitionCard } from '@/components/requisition-card';
import { Button, Empty, ErrorNote, ReasonSheet, Skeleton } from '@/components/ui';
import { advanceRequisition, cancelRequisition, listRequisitions, revertRequisition } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { cx } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { useLive } from '@/lib/realtime';
import type { Requisition, RequisitionStatus } from '@/lib/types';

type Tab = 'requested' | 'prepared' | 'delivered';
const TABS: { key: Tab; label: string }[] = [
  { key: 'requested', label: 'ขอเบิก' }, { key: 'prepared', label: 'จัดเตรียมแล้ว' }, { key: 'delivered', label: 'ส่งมอบแล้ว' },
];

export default function RequisitionsPage() {
  const { role } = useSession();
  const toast = useToast();
  const st = useAsync(() => listRequisitions({ limit: 200 }), []);
  const live = useLive(['requisitions', 'job_orders'], () => void st.reload());
  const [tab, setTab] = useState<Tab>('requested');
  const [busy, setBusy] = useState<string | null>(null);
  const [reverting, setReverting] = useState<Requisition | null>(null);
  const [cancelling, setCancelling] = useState<Requisition | null>(null);
  const canCancel = role === 'owner' || role === 'admin';

  const byStatus = useMemo(() => {
    const m: Record<RequisitionStatus, Requisition[]> = { requested: [], prepared: [], delivered: [], void: [] };
    for (const r of st.data ?? []) m[r.status].push(r);
    // ขอเบิกเก่าสุดขึ้นก่อน (รอนานสุดต้องทำก่อน) ; ที่ส่งมอบแล้วใหม่สุดขึ้นก่อน
    m.requested.sort((a, b) => a.requested_at.localeCompare(b.requested_at));
    m.prepared.sort((a, b) => (a.prepared_at ?? '').localeCompare(b.prepared_at ?? ''));
    m.delivered.sort((a, b) => (b.delivered_at ?? '').localeCompare(a.delivered_at ?? ''));
    m.delivered = m.delivered.slice(0, 30);
    return m;
  }, [st.data]);

  const advance = async (r: Requisition) => {
    setBusy(r.id);
    try {
      const to = await advanceRequisition(r.id);
      toast.ok(to === 'prepared' ? `จัดเตรียม ${r.req_no} แล้ว` : `ส่งมอบ ${r.req_no} แล้ว — แจ้งแอดมินและช่างอัตโนมัติ`);
    } catch (e) { toast.err(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); await st.reload(); }
  };

  const list = byStatus[tab];
  return (
    <>
      <PageHeader title="เบิกอะไหล่" subtitle={st.data ? `${byStatus.requested.length} รอจัดเตรียม · ${byStatus.prepared.length} รอส่งมอบ` : undefined} right={<div className="pr-3"><LiveDot status={live} /></div>} />
      <div className="px-4 pt-4">
        <div role="tablist" aria-label="สถานะคำขอ" className="flex gap-1.5">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} data-testid={`tab-${t.key}`}
              className={cx('min-h-[46px] flex-1 rounded-lg border px-1 text-[14px] font-medium transition-colors',
                tab === t.key ? 'border-gold bg-gold/15 text-gold-hi' : 'border-rule bg-inset text-dim hover:text-ivory')}>
              {t.label}<span className="num ml-1.5 text-mute" data-testid="tab-count">{byStatus[t.key].length}</span>
            </button>
          ))}
        </div>
      </div>

      {st.loading ? (
        <div className="space-y-3 p-4">{[0, 1].map((i) => <Skeleton key={i} className="h-44" />)}</div>
      ) : st.error && !st.data ? (
        <ErrorNote message={st.error} onRetry={() => void st.reload()} />
      ) : list.length === 0 ? (
        <Empty
          title={tab === 'requested' ? 'ไม่มีคำขอเบิกค้าง' : tab === 'prepared' ? 'ไม่มีของที่รอส่งมอบ' : 'ยังไม่มีรายการที่ส่งมอบ'}
          hint={tab === 'requested' ? 'เมื่อลูกค้าอนุมัติใบเสนอราคา คำขอเบิกจะเด้งขึ้นที่นี่ทันที' : undefined}
        />
      ) : (
        <div className="space-y-3 p-4" data-testid="req-list">
          {list.map((r) => (
            <RequisitionCard key={r.id} req={r}
              actions={
                <>
                  {r.status === 'requested' && (
                    <Button className="flex-1" onClick={() => void advance(r)} loading={busy === r.id} disabled={busy !== null && busy !== r.id} data-testid="req-advance">
                      <PackageCheck className="h-4 w-4" aria-hidden />จัดเตรียมแล้ว
                    </Button>
                  )}
                  {r.status === 'prepared' && (
                    <>
                      <Button variant="ghost" onClick={() => setReverting(r)} disabled={busy !== null}><Undo2 className="h-4 w-4" aria-hidden />ถอยกลับ</Button>
                      <Button className="flex-1" onClick={() => void advance(r)} loading={busy === r.id} disabled={busy !== null && busy !== r.id} data-testid="req-advance">
                        <CheckCheck className="h-4 w-4" aria-hidden />ส่งมอบแล้ว
                      </Button>
                    </>
                  )}
                  {canCancel && (r.status === 'requested' || r.status === 'prepared') && (
                    <Button variant="ghost" small className="text-bad" onClick={() => setCancelling(r)}>ยกเลิกคำขอ</Button>
                  )}
                </>
              } />
          ))}
        </div>
      )}

      <ReasonSheet
        open={Boolean(reverting)} title={`ถอย ${reverting?.req_no ?? ''} กลับเป็น "ขอเบิก"`} confirmLabel="ถอยกลับ"
        description="ใช้เมื่อกดจัดเตรียมผิด หรือของที่จัดไว้ใช้ไม่ได้" placeholder="เช่น กดผิดใบ, ของหมดต้องสั่งเพิ่ม"
        onClose={() => setReverting(null)}
        onConfirm={async (r) => { await revertRequisition(reverting!.id, r); setReverting(null); toast.ok('ถอยกลับแล้ว'); await st.reload(); }}
      />
      <ReasonSheet
        open={Boolean(cancelling)} danger title={`ยกเลิกคำขอ ${cancelling?.req_no ?? ''}`} confirmLabel="ยกเลิกคำขอ"
        description="ใช้เมื่อไม่ต้องเบิกแล้ว เช่น ลูกค้านำอะไหล่มาเอง" placeholder="เช่น ลูกค้านำอะไหล่มาเอง"
        onClose={() => setCancelling(null)}
        onConfirm={async (r) => { await cancelRequisition(cancelling!.id, r); setCancelling(null); toast.ok('ยกเลิกคำขอแล้ว'); await st.reload(); }}
      />
    </>
  );
}
