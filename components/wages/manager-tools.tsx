'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { Copy, UserRoundPlus, UserX } from 'lucide-react';
import { Button, ConfirmSheet, Field } from '@/components/ui';
import { useToast } from '@/components/providers';
import {
  correctWageAttendance, createTechnicianAccount, deactivateTechnicianAccount, recordWageWork,
  saveTechnicianBankDetails, updateWageWorkRate,
} from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import type { Profile, TechnicianBankDetails, WageDailyRow, WageWorkType } from '@/lib/types';

type TeamMember = Pick<Profile, 'id' | 'full_name' | 'role' | 'is_active'>;

export function ManagerWageTools({
  branchId, workDate, users, types, banks, rows, onChanged,
}: {
  branchId: string; workDate: string; users: TeamMember[]; types: WageWorkType[];
  banks: TechnicianBankDetails[]; rows: WageDailyRow[]; onChanged: () => void;
}) {
  const technicians = users.filter((u) => u.role === 'technician');
  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-rule bg-raised p-4">
        <h2 className="font-display text-[17px] font-semibold">อัตรางานเพิ่ม</h2>
        <p className="mb-3 text-[13px] text-mute">การเปลี่ยนเรตมีผลเฉพาะรายการที่บันทึกหลังจากนี้</p>
        <div className="space-y-2">
          {types.map((type) => <RateEditor key={type.id} type={type} onSaved={onChanged} />)}
        </div>
      </section>
      <section className="rounded-xl border border-rule bg-raised p-4">
        <h2 className="font-display text-[17px] font-semibold">บันทึกผลงานช่าง</h2>
        <WorkEntryForm users={technicians.filter((u) => u.is_active)} types={types} workDate={workDate} onSaved={onChanged} />
      </section>
      <section className="rounded-xl border border-rule bg-raised p-4">
        <h2 className="font-display text-[17px] font-semibold">แก้เวลาเข้างาน</h2>
        <p className="mb-3 text-[13px] text-mute">การแก้เวลาหลังจ่ายแล้วจะเปิดสถานะค้างจ่ายใหม่</p>
        <AttendanceCorrectionForm users={technicians.filter((u) => u.is_active)} workDate={workDate} onSaved={onChanged} />
        <div className="space-y-2">
          {rows.map((row) => <AttendanceEditor key={`${row.user_id}:${row.work_date}`} row={row} onSaved={onChanged} />)}
        </div>
      </section>
      <TeamEditor users={technicians} onChanged={onChanged} />
      <BankEditors branchId={branchId} users={technicians.filter((u) => u.is_active)} banks={banks} />
    </div>
  );
}

function RateEditor({ type, onSaved }: { type: WageWorkType; onSaved: () => void }) {
  const toast = useToast();
  const [rate, setRate] = useState(String(type.current_rate));
  const [busy, setBusy] = useState(false);
  useEffect(() => setRate(String(type.current_rate)), [type.current_rate]);
  const save = async () => {
    const value = Number(rate);
    if (!Number.isFinite(value) || value < 0 || value > 1000000) { toast.err('กรุณาระบุเรตตั้งแต่ 0 ถึง 1,000,000 บาท'); return; }
    setBusy(true);
    try { await updateWageWorkRate(type.id, value); toast.ok(`บันทึกเรต ${type.name} แล้ว`); onSaved(); }
    catch (e) { toast.err(e instanceof Error ? e.message : 'บันทึกเรตไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex items-center gap-2 border-t border-rule py-2 first:border-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium">{type.name}</p>
        <p className="text-[12px] text-mute">ต่อ{type.unit_label}</p>
      </div>
      <input aria-label={`เรต ${type.name}`} type="number" inputMode="decimal" min="0" max="1000000" step="0.01"
        className="field num w-28 text-right" value={rate} onChange={(e) => setRate(e.target.value)} />
      <Button small loading={busy} onClick={() => void save()}>บันทึก</Button>
    </div>
  );
}

function WorkEntryForm({ users, types, workDate, onSaved }: {
  users: TeamMember[]; types: WageWorkType[]; workDate: string; onSaved: () => void;
}) {
  const toast = useToast();
  const [userId, setUserId] = useState(users[0]?.id ?? '');
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [quantity, setQuantity] = useState('1');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!users.some((u) => u.id === userId)) setUserId(users[0]?.id ?? ''); }, [users, userId]);
  useEffect(() => { if (!types.some((t) => t.id === typeId)) setTypeId(types[0]?.id ?? ''); }, [types, typeId]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const count = Number(quantity);
    if (!userId || !typeId || !Number.isInteger(count) || count < 1 || count > 10000) { toast.err('ตรวจสอบช่าง ประเภทงาน และจำนวน'); return; }
    setBusy(true);
    try {
      await recordWageWork({ userId, workDate, workTypeId: typeId, quantity: count });
      setQuantity('1'); toast.ok('บันทึกผลงานแล้ว'); onSaved();
    } catch (error) { toast.err(error instanceof Error ? error.message : 'บันทึกผลงานไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  if (!users.length || !types.length) return <p className="mt-2 text-[14px] text-mute">ต้องมีช่างที่เปิดใช้งานและประเภทงานก่อน</p>;
  return (
    <form className="mt-3 space-y-3" onSubmit={(e) => void submit(e)}>
      <Field label="ช่าง">
        <select className="field" value={userId} onChange={(e) => setUserId(e.target.value)}>
          {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>
      </Field>
      <Field label="งานที่ทำ">
        <select className="field" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name} · {fmtMoney(t.current_rate)}/{t.unit_label}</option>)}
        </select>
      </Field>
      <div className="flex items-end gap-3">
        <Field label="จำนวน">
          <input className="field num w-28" type="number" inputMode="numeric" aria-label="จำนวน" min="1" max="10000" step="1" value={quantity}
            onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Button type="submit" loading={busy}><UserRoundPlus className="h-4 w-4" aria-hidden />บันทึกงาน</Button>
      </div>
    </form>
  );
}

function AttendanceCorrectionForm({ users, workDate, onSaved }: {
  users: TeamMember[]; workDate: string; onSaved: () => void;
}) {
  const toast = useToast();
  const [userId, setUserId] = useState(users[0]?.id ?? '');
  const [clockIn, setClockIn] = useState('08:30');
  const [clockOut, setClockOut] = useState('17:00');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!users.some((u) => u.id === userId)) setUserId(users[0]?.id ?? ''); }, [users, userId]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId || !clockIn || !reason.trim()) { toast.err('กรุณาระบุช่าง เวลาเข้า และเหตุผล'); return; }
    setBusy(true);
    try {
      await correctWageAttendance({
        userId, workDate, clockedInAt: `${workDate}T${clockIn}:00+07:00`,
        clockedOutAt: clockOut ? `${workDate}T${clockOut}:00+07:00` : null, reason: reason.trim(),
      });
      setReason(''); toast.ok('บันทึกเวลาเข้างานแล้ว'); onSaved();
    } catch (error) { toast.err(error instanceof Error ? error.message : 'บันทึกเวลาไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  if (!users.length) return <p className="text-[14px] text-mute">ไม่มีช่างที่เปิดบัญชีอยู่</p>;
  return (
    <form className="mb-3 space-y-3 rounded-lg border border-rule p-3" onSubmit={(e) => void save(e)}>
      <Field label={`เพิ่ม/แก้เวลาของ ${workDate}`}>
        <select className="field mt-1" value={userId} onChange={(e) => setUserId(e.target.value)}>
          {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="เวลาเข้า"><input className="field num" type="time" value={clockIn} onChange={(e) => setClockIn(e.target.value)} /></Field>
        <Field label="เวลาออก"><input className="field num" type="time" value={clockOut} onChange={(e) => setClockOut(e.target.value)} /></Field>
      </div>
      <Field label="เหตุผล"><textarea className="field" rows={2} required value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <Button type="submit" small loading={busy}>บันทึก/แก้เวลา</Button>
    </form>
  );
}

function AttendanceEditor({ row, onSaved }: { row: WageDailyRow; onSaved: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [clockIn, setClockIn] = useState('');
  const [clockOut, setClockOut] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const localTime = (value: string | null) => value
    ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value))
    : '';
  useEffect(() => {
    setClockIn(localTime(row.clocked_in_at)); setClockOut(localTime(row.clocked_out_at)); setReason('');
  }, [row.clocked_in_at, row.clocked_out_at]);
  const save = async () => {
    if (!clockIn || !reason.trim()) { toast.err('กรุณาระบุเวลาเข้าและเหตุผล'); return; }
    setBusy(true);
    try {
      await correctWageAttendance({
        userId: row.user_id, workDate: row.work_date, clockedInAt: `${row.work_date}T${clockIn}:00+07:00`,
        clockedOutAt: clockOut ? `${row.work_date}T${clockOut}:00+07:00` : null, reason: reason.trim(),
      });
      setOpen(false); toast.ok('แก้เวลาเข้างานแล้ว'); onSaved();
    } catch (error) { toast.err(error instanceof Error ? error.message : 'แก้เวลาไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  return (
    <div className="rounded-lg border border-rule p-3">
      <div className="flex items-center justify-between gap-2">
        <div><p className="font-medium">{row.full_name} · {row.work_date}</p><p className="num text-[13px] text-mute">{localTime(row.clocked_in_at)} – {localTime(row.clocked_out_at) || 'ยังไม่ลงเวลาออก'}</p></div>
        <Button small variant="outline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'ปิด' : 'แก้เวลา'}</Button>
      </div>
      {open && <div className="mt-3 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="เวลาเข้า"><input className="field num" type="time" value={clockIn} onChange={(e) => setClockIn(e.target.value)} /></Field>
          <Field label="เวลาออก"><input className="field num" type="time" value={clockOut} onChange={(e) => setClockOut(e.target.value)} /></Field>
        </div>
        <Field label="เหตุผล"><textarea className="field" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Button small loading={busy} onClick={() => void save()}>บันทึกเวลา</Button>
      </div>}
    </div>
  );
}

function TeamEditor({ users, onChanged }: { users: TeamMember[]; onChanged: () => void }) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 12) { toast.err('รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร'); return; }
    setBusy(true);
    try {
      await createTechnicianAccount({ email, fullName, password });
      setEmail(''); setFullName(''); setPassword('');
      toast.ok('เพิ่มบัญชีช่างแล้ว'); onChanged();
    } catch (error) { toast.err(error instanceof Error ? error.message : 'เพิ่มบัญชีไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  return (
    <section className="rounded-xl border border-rule bg-raised p-4">
      <h2 className="font-display text-[17px] font-semibold">บัญชีพนักงาน</h2>
      <p className="mb-3 text-[13px] text-mute">ปิดบัญชีจะตัดสิทธิ์เข้าใช้และเก็บประวัติค่าจ้างเดิมไว้</p>
      <div className="space-y-2">
        {users.map((user) => <div key={user.id} className="flex items-center justify-between gap-2 border-t border-rule py-2 first:border-0">
          <span className="text-[14px]">{user.full_name}{!user.is_active && <span className="ml-2 text-mute">(ปิดบัญชี)</span>}</span>
          {user.is_active && <Button small variant="danger" aria-label={`ปิดบัญชี ${user.full_name}`} onClick={() => setRemoving(user)}>
            <UserX className="h-4 w-4" aria-hidden />ปิดบัญชี
          </Button>}
        </div>)}
      </div>
      <form className="mt-3 space-y-3 border-t border-rule pt-3" onSubmit={(e) => void add(e)}>
        <Field label="ชื่อช่าง"><input className="field" maxLength={100} required value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
        <Field label="อีเมลสำหรับเข้าสู่ระบบ"><input className="field" type="email" maxLength={254} required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="รหัสผ่านเริ่มต้น" hint="อย่างน้อย 12 ตัวอักษร แจ้งให้ช่างทราบเป็นการส่วนตัว">
          <input className="field" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" loading={busy}>เพิ่มบัญชีช่าง</Button>
      </form>
      <ConfirmSheet open={Boolean(removing)} title={`ปิดบัญชี${removing ? ` ${removing.full_name}` : ''}`}
        description="ช่างจะเข้าสู่ระบบและใช้งานข้อมูลต่อไม่ได้ แต่บันทึกเวลาและประวัติค่าแรงจะไม่ถูกลบ"
        confirmLabel="ปิดบัญชีและเก็บประวัติ" onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await deactivateTechnicianAccount(removing.id); setRemoving(null); toast.ok('ปิดบัญชีแล้วและเก็บประวัติไว้'); onChanged();
        }} />
    </section>
  );
}

function BankEditors({ branchId, users, banks }: {
  branchId: string; users: TeamMember[]; banks: TechnicianBankDetails[];
}) {
  return (
    <section className="rounded-xl border border-rule bg-raised p-4">
      <h2 className="font-display text-[17px] font-semibold">บัญชีธนาคารช่าง</h2>
      <p className="mb-3 text-[13px] text-mute">ข้อมูลนี้แสดงเฉพาะผู้จัดการ</p>
      <div className="space-y-3">
        {users.map((user) => <BankEditor key={user.id} branchId={branchId} user={user}
          detail={banks.find((b) => b.user_id === user.id) ?? null} />)}
      </div>
    </section>
  );
}

function BankEditor({ branchId, user, detail }: {
  branchId: string; user: TeamMember; detail: TechnicianBankDetails | null;
}) {
  const toast = useToast();
  const [bankName, setBankName] = useState(detail?.bank_name ?? '');
  const [accountNumber, setAccountNumber] = useState(detail?.account_number ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setBankName(detail?.bank_name ?? ''); setAccountNumber(detail?.account_number ?? ''); }, [detail?.bank_name, detail?.account_number]);
  const save = async () => {
    if (!bankName.trim() || !accountNumber.trim()) { toast.err('กรุณากรอกธนาคารและเลขบัญชี'); return; }
    setBusy(true);
    try {
      await saveTechnicianBankDetails({ user_id: user.id, bank_name: bankName.trim(), account_number: accountNumber.trim() }, branchId);
      toast.ok(`บันทึกบัญชีของ${user.full_name}แล้ว`);
    } catch (error) { toast.err(error instanceof Error ? error.message : 'บันทึกบัญชีไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(accountNumber); toast.ok('คัดลอกเลขบัญชีแล้ว'); }
    catch { toast.err('คัดลอกไม่ได้ กรุณาเลือกเลขบัญชีแล้วคัดลอกเอง'); }
  };
  return (
    <div className="rounded-lg border border-rule p-3">
      <p className="mb-2 font-medium">{user.full_name}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="ธนาคาร"><input className="field" maxLength={100} value={bankName} onChange={(e) => setBankName(e.target.value)} /></Field>
        <Field label="เลขบัญชี"><input className="field num" inputMode="numeric" autoComplete="off" maxLength={50} value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} /></Field>
      </div>
      <div className="mt-2 flex gap-2">
        <Button small loading={busy} onClick={() => void save()}>บันทึก</Button>
        {accountNumber && <Button small variant="outline" onClick={() => void copy()}><Copy className="h-4 w-4" aria-hidden />คัดลอกเลขบัญชี</Button>}
      </div>
    </div>
  );
}
