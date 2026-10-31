'use client';
import { useState } from 'react';
import { BadgeCheck, ChevronDown, Undo2 } from 'lucide-react';
import { Button, ConfirmSheet, Empty, Money, ReasonSheet } from '@/components/ui';
import { useToast } from '@/components/providers';
import { markWagePaid, unmarkWagePaid, voidWageWork } from '@/lib/api';
import { cx, fmtMoney } from '@/lib/format';
import type { WageDailyRow, WageWorkEntry } from '@/lib/types';

export function DailyLedger({ rows, entries, canManage, onChanged }: {
  rows: WageDailyRow[]; entries: WageWorkEntry[]; canManage: boolean; onChanged: () => void;
}) {
  if (!rows.length) return <Empty title="ยังไม่มีบันทึกค่าแรงในเดือนนี้" hint="ค่าแรงจะเริ่มคำนวณเมื่อช่างลงเวลาเข้างาน" />;
  const grouped = new Map<string, WageDailyRow[]>();
  for (const row of rows) grouped.set(row.user_id, [...(grouped.get(row.user_id) ?? []), row]);
  const staff = [...grouped.values()].map((days) => ({
    id: days[0].user_id, name: days[0].full_name, days,
    total: days.reduce((sum, day) => sum + day.total, 0),
    unpaid: days.filter((day) => !day.paid_at).reduce((sum, day) => sum + day.total, 0),
  })).sort((a, b) => b.unpaid - a.unpaid || a.name.localeCompare(b.name));

  return <div className="space-y-3">{staff.map((person) => (
    <details key={person.id} className="group rounded-xl border border-rule bg-raised" data-testid="wage-staff">
      <summary className="flex cursor-pointer list-none items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="font-display text-[17px] font-semibold">{person.name}</p>
          <p className="text-[13px] text-mute">{person.days.length} วันทำงาน · รวม {fmtMoney(person.total)}</p>
        </div>
        <div className="text-right">
          <p className={cx('num font-display text-[18px] font-semibold', person.unpaid ? 'text-warn' : 'text-ok')}>{fmtMoney(person.unpaid)}</p>
          <p className="text-[12px] text-mute">{person.unpaid ? 'ค้างจ่าย' : 'จ่ายครบแล้ว'}</p>
        </div>
        <ChevronDown className="h-5 w-5 text-mute transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-2 border-t border-rule p-3">
        {person.days.map((day) => (
          <DayCard key={`${day.user_id}:${day.work_date}`} day={day}
            entries={entries.filter((entry) => entry.user_id === day.user_id && entry.work_date === day.work_date)}
            canManage={canManage} onChanged={onChanged} />
        ))}
      </div>
    </details>
  ))}</div>;
}

function DayCard({ day, entries, canManage, onChanged }: {
  day: WageDailyRow; entries: WageWorkEntry[]; canManage: boolean; onChanged: () => void;
}) {
  const toast = useToast();
  const [paying, setPaying] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const minutes = Math.round(day.overtime_minutes);
  const clock = (value: string | null) => value
    ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value))
    : 'ยังไม่ลงเวลาออก';
  return (
    <article className="rounded-lg border border-rule bg-inset p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{day.work_date}</p>
          <p className="num text-[13px] text-mute">{clock(day.clocked_in_at)} – {clock(day.clocked_out_at)}</p>
        </div>
        <div className="text-right">
          <Money v={day.total} className="font-display text-[18px] font-semibold" />
          <p className={cx('text-[12px]', day.paid_at ? 'text-ok' : 'text-warn')}>{day.paid_at ? 'จ่ายแล้ว' : 'ค้างจ่าย'}</p>
        </div>
      </div>
      <ul className="mt-2 space-y-1 text-[13px] text-dim">
        <li className="flex justify-between gap-3"><span>ค่าแรงพื้นฐาน</span><span className="num">{fmtMoney(day.base_wage)}</span></li>
        <li className="flex justify-between gap-3"><span>หักสาย {day.late_minutes} นาที</span><span className="num text-bad">−{fmtMoney(day.late_deduction)}</span></li>
        <li className="flex justify-between gap-3"><span>OT {minutes} นาที</span><span className="num text-ok">+{fmtMoney(day.overtime_amount)}</span></li>
        <li className="flex justify-between gap-3"><span>งานเพิ่ม</span><span className="num text-ok">+{fmtMoney(day.work_total)}</span></li>
      </ul>
      {entries.length > 0 && <div className="mt-2 space-y-1 border-t border-rule pt-2">
        {entries.map((entry) => <WorkEntryRow key={entry.id} entry={entry} canManage={canManage} onChanged={onChanged} />)}
      </div>}
      {canManage && <div className="mt-3 flex flex-wrap gap-2 border-t border-rule pt-3">
        {!day.paid_at
          ? <Button small onClick={() => setPaying(true)}><BadgeCheck className="h-4 w-4" aria-hidden />ทำเครื่องหมายจ่ายแล้ว</Button>
          : <Button small variant="outline" onClick={() => setUndoing(true)}><Undo2 className="h-4 w-4" aria-hidden />ยกเลิกการจ่าย</Button>}
      </div>}
      <ConfirmSheet open={paying} title={`จ่ายค่าแรง ${day.full_name}`}
        description={`ยืนยันยอด ${fmtMoney(day.total)} ของวันที่ ${day.work_date} ระบบบันทึกสถานะเท่านั้น ไม่ได้โอนเงินจริง`}
        confirmLabel="ยืนยันจ่ายแล้ว" onClose={() => setPaying(false)}
        onConfirm={async () => {
          const changed = await markWagePaid(day.user_id, day.work_date);
          if (!changed) throw new Error('รายการนี้ถูกทำเครื่องหมายจ่ายแล้ว หรือไม่มีข้อมูลวันดังกล่าว');
          setPaying(false); toast.ok('ทำเครื่องหมายจ่ายแล้ว'); onChanged();
        }} />
      <ReasonSheet open={undoing} title={`ยกเลิกการจ่าย ${day.full_name}`} confirmLabel="ยกเลิกการจ่าย" danger
        description={`ยอดวันที่ ${day.work_date} จะกลับเป็นค้างจ่าย`} onClose={() => setUndoing(false)}
        onConfirm={async (reason) => {
          await unmarkWagePaid(day.user_id, day.work_date, reason);
          setUndoing(false); toast.ok('ยกเลิกสถานะจ่ายแล้ว'); onChanged();
        }} />
    </article>
  );
}

function WorkEntryRow({ entry, canManage, onChanged }: {
  entry: WageWorkEntry; canManage: boolean; onChanged: () => void;
}) {
  const toast = useToast();
  const [voiding, setVoiding] = useState(false);
  return (
    <>
      <div className="flex items-center justify-between gap-2 text-[13px]">
        <span className="min-w-0">{entry.work_name} · <span className="num">{entry.quantity}</span> {entry.unit_label} × <span className="num">{fmtMoney(entry.unit_rate)}</span></span>
        <span className="flex shrink-0 items-center gap-2">
          <Money v={entry.amount} />
          {canManage && <button type="button" className="text-bad underline" onClick={() => setVoiding(true)}>ยกเลิก</button>}
        </span>
      </div>
      <ReasonSheet open={voiding} title="ยกเลิกรายการงานเพิ่ม" confirmLabel="ยกเลิกรายการ" danger
        description={`${entry.work_name} จำนวน ${entry.quantity} ${entry.unit_label} · ${fmtMoney(entry.amount)} (ข้อมูลเดิมจะถูกเก็บเป็นประวัติ)`}
        onClose={() => setVoiding(false)}
        onConfirm={async (reason) => {
          await voidWageWork(entry.id, reason); setVoiding(false); toast.ok('ยกเลิกรายการแล้ว'); onChanged();
        }} />
    </>
  );
}
