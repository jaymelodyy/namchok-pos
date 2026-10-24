'use client';
import { useEffect, useState } from 'react';
import { Field, ConfirmSheet, ReasonSheet } from '@/components/ui';
import { addDays, bangkokDate, fmtDateLong, fmtMoney } from '@/lib/format';
import { closeJob, setDeliveryDate } from '@/lib/api';
import type { VJob } from '@/lib/types';

const minDate = (job: VJob) => bangkokDate(new Date(job.opened_at ?? job.created_at));

/** ปิดงาน : เลือก "วันที่ส่งมอบ" (วันที่ลูกค้ารับรถ) — ระยะประกันนับจากวันนี้ ไม่ใช่วันที่กดปิดงาน */
export function CloseSheet({ open, job, onClose, onClosed }: { open: boolean; job: VJob; onClose: () => void; onClosed: () => void }) {
  const today = bangkokDate();
  const [date, setDate] = useState(today);
  useEffect(() => { if (open) setDate(today); }, [open, today]);
  const min = minDate(job);
  const max = addDays(today, 7);
  const bad = !date || date < min || date > max;
  return (
    <ConfirmSheet
      open={open} title="ปิดงานและออกใบเสร็จ" confirmLabel="ปิดงาน ออกใบเสร็จ" onClose={onClose}
      description="ระบบจะออกใบเสร็จและใบรับประกันตามรายการที่ระบุระยะรับประกัน หลังปิดงานจะแก้รายการไม่ได้ (ถ้าผิดพลาดให้เจ้าของ void)"
      onConfirm={async () => {
        if (bad) throw new Error(`วันที่ส่งมอบต้องอยู่ระหว่าง ${fmtDateLong(min)} ถึง ${fmtDateLong(max)}`);
        await closeJob(job.id, date);
        onClosed();
      }}
    >
      <dl className="mt-4 space-y-1.5 rounded-xl border border-rule bg-inset px-4 py-3 text-[15px]">
        <div className="flex justify-between"><dt className="text-dim">ยอดสุทธิ (รวม VAT แล้ว)</dt><dd className="num">{fmtMoney(job.grand_total)}</dd></div>
        <div className="flex justify-between"><dt className="text-dim">รับแล้วสุทธิ</dt><dd className="num text-ok">{fmtMoney(job.paid_total)}</dd></div>
      </dl>
      <div className="mt-4">
        <Field label="วันที่ส่งมอบรถ" htmlFor="deliver-date" hint="ใบรับประกันนับจากวันนี้ — ถ้าลูกค้ามารับรถช้ากว่าวันที่ปิดงาน ให้เลือกวันที่รับจริง">
          <input id="deliver-date" type="date" className="field num" value={date} min={min} max={max} onChange={(e) => setDate(e.target.value)} />
        </Field>
        {bad && <p role="alert" className="mt-1 text-[13px] text-bad">วันที่ต้องอยู่ระหว่างวันรับรถเข้าร้านถึง 7 วันข้างหน้า</p>}
      </div>
    </ConfirmSheet>
  );
}

/** แก้วันที่ส่งมอบหลังปิดงาน (เจ้าของ/แอดมิน) → คำนวณวันสิ้นสุดประกันใหม่ ต้องมีเหตุผล */
export function DeliveryDateSheet({ open, job, onClose, onDone }: { open: boolean; job: VJob; onClose: () => void; onDone: () => void }) {
  const today = bangkokDate();
  const [date, setDate] = useState(job.delivered_on ?? today);
  useEffect(() => { if (open) setDate(job.delivered_on ?? today); }, [open, job.delivered_on, today]);
  return (
    <ReasonSheet
      open={open} title="แก้วันที่ส่งมอบ" confirmLabel="บันทึกวันที่ส่งมอบ"
      description="วันสิ้นสุดของใบรับประกันทุกใบในงานนี้จะคำนวณใหม่จากวันที่ส่งมอบที่แก้" placeholder="เช่น ลูกค้ามารับรถวันถัดมา"
      onClose={onClose}
      onConfirm={async (r) => { await setDeliveryDate(job.id, date, r); onDone(); }}
    >
      <div className="mb-4">
        <Field label="วันที่ส่งมอบรถ" htmlFor="deliver-date2">
          <input id="deliver-date2" type="date" className="field num" value={date} min={minDate(job)} max={addDays(today, 7)} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
    </ReasonSheet>
  );
}
