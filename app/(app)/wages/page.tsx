'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Clock3, LogIn, LogOut } from 'lucide-react';
import { DailyLedger } from '@/components/wages/daily-ledger';
import { ManagerWageTools } from '@/components/wages/manager-tools';
import { PageHeader } from '@/components/app-shell';
import { useToast } from '@/components/providers';
import { Button, ErrorNote, Skeleton, Spinner } from '@/components/ui';
import {
  listTechnicianBankDetails, listUsers, listWageWorkEntries, listWageWorkTypes,
  wageClockIn, wageClockOut, wageDailyReport,
} from '@/lib/api';
import { useSession } from '@/lib/auth';
import { bangkokDate, fmtMoney } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { useLive } from '@/lib/realtime';
import type { TechnicianBankDetails, WageDailyRow, WageWorkEntry, WageWorkType } from '@/lib/types';
import type { Profile } from '@/lib/types';

type TeamMember = Pick<Profile, 'id' | 'full_name' | 'role' | 'is_active'>;
type WageData = {
  rows: WageDailyRow[]; todayRows: WageDailyRow[]; entries: WageWorkEntry[];
  types: WageWorkType[]; users: TeamMember[]; banks: TechnicianBankDetails[];
};

function monthEnd(month: string) {
  const [year, value] = month.split('-').map(Number);
  return new Date(Date.UTC(year, value, 0)).toISOString().slice(0, 10);
}

export default function WagesPage() {
  const { role } = useSession();
  const router = useRouter();
  const permitted = role === 'owner' || role === 'admin' || role === 'technician';
  useEffect(() => { if (!permitted) router.replace('/'); }, [permitted, router]);
  if (!permitted) return <Spinner />;
  return <WagesScreen />;
}

function WagesScreen() {
  const { profile, role } = useSession();
  const isManager = role === 'owner' || role === 'admin';
  const today = bangkokDate();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [workDate, setWorkDate] = useState(today);
  const from = `${month}-01`;
  const to = month === today.slice(0, 7) ? today : monthEnd(month);

  const data = useAsync<WageData>(async () => {
    const [rows, todayRows, entries, types, users, banks] = await Promise.all([
      wageDailyReport(from, to), wageDailyReport(today, today), listWageWorkEntries({ from, to }),
      isManager ? listWageWorkTypes() : Promise.resolve([]),
      isManager ? listUsers() : Promise.resolve([]),
      isManager ? listTechnicianBankDetails() : Promise.resolve([]),
    ]);
    return {
      rows, todayRows, entries,
      types, users: users as TeamMember[], banks,
    };
  }, [from, to, today, isManager]);
  const live = useLive(['wage_attendance', 'wage_work_entries'], () => void data.reload());
  const todayRow = data.data?.todayRows.find((row) => row.user_id === profile.id) ?? null;
  const totals = useMemo(() => {
    const rows = data.data?.rows ?? [];
    return {
      total: rows.reduce((sum, row) => sum + row.total, 0),
      paid: rows.filter((row) => row.paid_at).reduce((sum, row) => sum + row.total, 0),
      unpaid: rows.filter((row) => !row.paid_at).reduce((sum, row) => sum + row.total, 0),
    };
  }, [data.data]);

  return (
    <>
      <PageHeader title="ค่าแรงรายวัน" subtitle={isManager ? 'สรุปและจัดการค่าแรงทั้งทีม' : 'ยอดค่าแรงของทีม'} />
      <div className="space-y-5 px-4 pb-8 pt-4">
        <section className="rounded-xl border border-rule bg-raised p-4">
          <div className="flex items-start gap-3">
            <Clock3 className="mt-1 h-5 w-5 shrink-0 text-gold" aria-hidden />
            <div className="flex-1">
              <h2 className="font-display text-[17px] font-semibold">เวลาทำงานและอัตราค่าจ้าง</h2>
              <p className="mt-1 text-[13px] text-dim">08:30–17:00 · พัก 12:00–12:45 · เริ่มหักสายหลัง 09:00 นาทีละ 2 บาท</p>
              <p className="text-[13px] text-dim">พื้นฐาน 400 บาท/วัน · OT หลัง 17:00 ชั่วโมงละ 100 บาท คิดตามเวลาจริง</p>
            </div>
          </div>
          {role === 'technician' && <SelfClock row={todayRow} loading={data.loading} onChanged={() => void data.reload()} />}
        </section>

        <div className="flex flex-col gap-3 min-[400px]:flex-row min-[400px]:items-end">
          <label className="block min-w-0 flex-1">
            <span className="label">สรุปประจำเดือน</span>
            <input aria-label="เลือกเดือน" className="field num w-full min-w-0" type="month" max={today.slice(0, 7)}
              value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
          {isManager && <label className="block min-w-0 flex-1">
            <span className="label">วันที่บันทึก/แก้ไข</span>
            <input aria-label="วันที่บันทึกงาน" className="field num w-full min-w-0" type="date" max={today}
              value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
          </label>}
        </div>

        <dl className="grid grid-cols-3 gap-2" data-testid="wage-summary">
          <Summary label="รวม" amount={totals.total} />
          <Summary label="จ่ายแล้ว" amount={totals.paid} tone="ok" />
          <Summary label="ค้างจ่าย" amount={totals.unpaid} tone={totals.unpaid ? 'warn' : 'ok'} />
        </dl>

        {data.loading && !data.data
          ? <div className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
          : data.error && !data.data ? <ErrorNote message={data.error} onRetry={() => void data.reload()} />
            : <>
              {data.error && <p role="alert" className="text-[13px] text-bad">{data.error}</p>}
              <DailyLedger rows={data.data?.rows ?? []} entries={data.data?.entries ?? []}
                canManage={isManager} onChanged={() => void data.reload()} />
              {isManager && data.data && <ManagerWageTools branchId={profile.branch_id} workDate={workDate}
                users={data.data.users} types={data.data.types} banks={data.data.banks}
                rows={data.data.rows} onChanged={() => void data.reload()} />}
            </>}
        <p className="text-center text-[12px] text-mute">ยอดจ่ายเป็นสถานะบันทึกเท่านั้น ระบบไม่ได้โอนเงินจริง · อัปเดต {live === 'live' ? 'สด' : 'อัตโนมัติ'}</p>
      </div>
    </>
  );
}

function Summary({ label, amount, tone }: { label: string; amount: number; tone?: 'ok' | 'warn' }) {
  return (
    <div className="rounded-lg border border-rule bg-raised px-3 py-2.5">
      <dt className="text-[12px] text-mute">{label}</dt>
      <dd className={`num font-display text-[18px] font-semibold ${tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-gold-hi'}`}>
        {fmtMoney(amount)}
      </dd>
    </div>
  );
}

function SelfClock({ row, loading, onChanged }: { row: WageDailyRow | null; loading: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const clockOut = Boolean(row?.clocked_out_at);
  const label = row ? (clockOut ? 'ลงเวลาออกแล้ว' : 'ลงเวลาออกงาน') : 'ลงเวลาเข้างาน';
  const action = async () => {
    if (clockOut) return;
    setBusy(true);
    try {
      if (row) await wageClockOut();
      else await wageClockIn();
      toast.ok(row ? 'ลงเวลาออกงานแล้ว' : 'ลงเวลาเข้างานแล้ว');
      onChanged();
    } catch (error) { toast.err(error instanceof Error ? error.message : 'ลงเวลาไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-3">
      <p className="text-[14px] text-dim">
        {row ? `วันนี้ลงเวลาเข้า ${new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(row.clocked_in_at))}${row.clocked_out_at ? ` · ออก ${new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(row.clocked_out_at))}` : ''}` : 'อย่าลืมลงเวลาเข้างาน'}
      </p>
      <Button small variant={row ? 'outline' : 'primary'} loading={busy} disabled={loading || clockOut} onClick={() => void action()}>
        {row ? <LogOut className="h-4 w-4" aria-hidden /> : <LogIn className="h-4 w-4" aria-hidden />}{label}
      </Button>
    </div>
  );
}
