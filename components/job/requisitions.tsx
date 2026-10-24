'use client';
import { useState } from 'react';
import { PackageOpen } from 'lucide-react';
import { Button, ReasonSheet } from '@/components/ui';
import { RequisitionCard } from '@/components/requisition-card';
import { cancelRequisition } from '@/lib/api';
import { useToast } from '@/components/providers';
import type { Requisition } from '@/lib/types';

/** คำขอเบิกอะไหล่ของใบงาน (owner/admin) : เห็นความคืบหน้าของคลัง และยกเลิกคำขอที่ยังไม่ส่งมอบได้ */
export function RequisitionsPanel({ reqs, onChanged }: { reqs: Requisition[]; onChanged: () => void }) {
  const toast = useToast();
  const [cancelling, setCancelling] = useState<Requisition | null>(null);
  if (reqs.length === 0) return null;
  return (
    <section className="px-4" aria-labelledby="rq-h" data-testid="req-panel">
      <h2 id="rq-h" className="section-title mb-2 flex items-center gap-2"><PackageOpen className="h-4 w-4 text-gold" aria-hidden />เบิกอะไหล่</h2>
      <div className="space-y-3">
        {reqs.map((r) => (
          <RequisitionCard key={r.id} req={r} showJob={false}
            actions={(r.status === 'requested' || r.status === 'prepared')
              ? <Button variant="ghost" small className="text-bad" onClick={() => setCancelling(r)}>ยกเลิกคำขอ</Button> : undefined} />
        ))}
      </div>
      <ReasonSheet
        open={Boolean(cancelling)} danger title={`ยกเลิกคำขอ ${cancelling?.req_no ?? ''}`} confirmLabel="ยกเลิกคำขอ"
        description="ใช้เมื่อไม่ต้องเบิกแล้ว เช่น ลูกค้าซื้ออะไหล่มาเอง คำขอที่ส่งมอบแล้วยกเลิกไม่ได้" placeholder="เช่น ลูกค้านำอะไหล่มาเอง"
        onClose={() => setCancelling(null)}
        onConfirm={async (r) => { await cancelRequisition(cancelling!.id, r); setCancelling(null); toast.ok('ยกเลิกคำขอเบิกแล้ว'); onChanged(); }}
      />
    </section>
  );
}
