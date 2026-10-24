'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { Button, Field, Plate } from '@/components/ui';

export default function LoginPage() {
  const { state, signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (state.status === 'in') router.replace('/'); }, [state.status, router]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await signIn(email, password); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false); }
  };

  return (
    <div className="relative grid min-h-dvh place-items-center px-6 py-10">
      {/* กรอบป้ายร้านสองชั้น */}
      <div className="pointer-events-none fixed inset-3 rounded-[3px] border border-gold/30" aria-hidden />
      <div className="pointer-events-none fixed inset-[18px] rounded-[2px] border border-gold/10" aria-hidden />

      <main className="w-full max-w-sm">
        <div className="flex flex-col items-center">
          <Plate plate="นำโชค" province="ออโต้แอร์ นาทวี" glint className="text-[3.6rem]" />
          <p className="mt-5 text-center text-[15px] text-dim">ระบบใบสั่งงานและรับชำระเงิน</p>
        </div>

        {state.status === 'unconfigured' ? (
          <p role="alert" className="mt-10 rounded-xl border border-warn/50 bg-warn/10 p-4 text-[15px]">
            ยังไม่ได้ตั้งค่า Supabase — ใส่ค่าใน <code className="text-gold-hi">.env.local</code> ตาม <code className="text-gold-hi">.env.example</code> แล้วเริ่มแอปใหม่
          </p>
        ) : (
          <form onSubmit={submit} className="mt-10 space-y-4" noValidate>
            <Field label="อีเมล" htmlFor="email">
              <input id="email" type="email" autoComplete="username" inputMode="email" required className="field" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="รหัสผ่าน" htmlFor="password">
              <input id="password" type="password" autoComplete="current-password" required className="field" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error && <p role="alert" className="text-[15px] text-bad">{error}</p>}
            <Button type="submit" className="w-full" loading={busy} disabled={!email || !password}>เข้าสู่ระบบ</Button>
          </form>
        )}
      </main>
    </div>
  );
}
