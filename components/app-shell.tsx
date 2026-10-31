'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { BarChart3, BookOpen, ChevronLeft, ClipboardList, Home, PackageOpen, Settings, Wallet, Wrench } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { cx } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/labels';
import type { Role } from '@/lib/types';
import { LiveNotifier } from './live-notifier';
import { Button, Plate, Spinner } from './ui';

interface NavItem { href: string; label: string; icon: typeof Home; roles: Role[]; also?: string[]; desktopOnly?: Role[] }
// แถบล่างบนมือถือไม่เกิน 5 รายการ: desktopOnly = แสดงเฉพาะแถบข้างจอใหญ่ (มือถือเข้าได้จากหน้า "ตั้งค่า")
const NAV: NavItem[] = [
  { href: '/', label: 'หน้าแรก', icon: Home, roles: ['owner', 'admin'] },
  { href: '/work', label: 'งานของฉัน', icon: Wrench, roles: ['technician'] },
  { href: '/jobs', label: 'ใบงาน', icon: ClipboardList, roles: ['owner', 'admin'] },
  { href: '/requisitions', label: 'เบิกอะไหล่', icon: PackageOpen, roles: ['owner', 'admin', 'warehouse'] },
  { href: '/labor', label: 'ค่าแรง', icon: Wallet, roles: ['technician'] },
  { href: '/catalog', label: 'แคตตาล็อก', icon: BookOpen, roles: ['owner', 'admin', 'warehouse'], desktopOnly: ['owner'] },
  { href: '/reports', label: 'รายงาน', icon: BarChart3, roles: ['owner'], also: ['/labor'] },
  { href: '/settings', label: 'ตั้งค่า', icon: Settings, roles: ['owner', 'admin', 'technician', 'warehouse'] },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { state, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => { if (state.status === 'out') router.replace('/login'); }, [state.status, router]);

  if (state.status === 'unconfigured') {
    return (
      <div className="mx-auto max-w-md px-6 py-20">
        <h1 className="font-display text-2xl font-semibold">ยังไม่ได้เชื่อมต่อ Supabase</h1>
        <p className="mt-3 text-dim">สร้างไฟล์ <code className="text-gold-hi">.env.local</code> แล้วใส่ <code className="text-gold-hi">NEXT_PUBLIC_SUPABASE_URL</code> และ <code className="text-gold-hi">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> ตามไฟล์ <code className="text-gold-hi">.env.example</code> จากนั้นเริ่มแอปใหม่</p>
      </div>
    );
  }
  if (state.status === 'loading' || state.status === 'out') {
    return <div className="grid min-h-dvh place-items-center"><Spinner label="กำลังเข้าสู่ระบบ" /></div>;
  }
  if (state.status === 'no-profile') {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
        <h1 className="font-display text-2xl font-semibold">บัญชีนี้ยังใช้งานไม่ได้</h1>
        <p className="mt-3 text-dim">
          {state.email ?? 'บัญชีนี้'} ยังไม่ได้ผูกกับร้าน หรือถูกปิดการใช้งาน ให้เจ้าของเพิ่มบัญชีในตาราง <code className="text-gold-hi">users</code> พร้อมกำหนดบทบาท แล้วเข้าสู่ระบบใหม่
        </p>
        <Button className="mt-6 self-start" variant="outline" onClick={() => void signOut()}>ออกจากระบบ</Button>
      </div>
    );
  }

  const role = state.profile.role;
  const items = NAV.filter((n) => n.roles.includes(role));
  const wide = pathname === '/jobs' && (role === 'owner' || role === 'admin');
  const active = (n: NavItem) => {
    const hit = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));
    return hit(n.href) || Boolean(n.also?.some(hit));
  };

  return (
    <div className="min-h-dvh lg:pl-24">
      <LiveNotifier />
      <main className={cx('mx-auto w-full pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:pb-12', wide ? 'max-w-none' : 'max-w-3xl')}>{children}</main>
      <nav
        aria-label="เมนูหลัก"
        className="no-print fixed inset-x-0 bottom-0 z-40 flex border-t border-rule bg-lacquer/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:inset-y-0 lg:right-auto lg:w-24 lg:flex-col lg:justify-start lg:gap-1 lg:border-r lg:border-t-0 lg:pb-0 lg:pt-6"
      >
        <div className="hidden px-3 pb-5 lg:block"><Plate plate="นช" className="w-full text-[1.7rem]" /></div>
        {items.map((n) => {
          const on = active(n);
          const desktopOnly = Boolean(n.desktopOnly?.includes(role));
          const Icon = n.icon;
          return (
            <Link
              key={n.href} href={n.href} aria-current={on ? 'page' : undefined}
              className={cx(
                'relative flex min-h-[60px] flex-1 flex-col items-center justify-center gap-0.5 text-[12px] font-medium transition-colors lg:flex-none lg:py-3',
                desktopOnly && 'hidden lg:flex',
                on ? 'text-gold-hi' : 'text-mute hover:text-ivory',
              )}
            >
              <span className={cx('absolute left-1/4 right-1/4 top-0 h-0.5 rounded-b bg-gold transition-opacity lg:inset-y-3 lg:left-0 lg:right-auto lg:h-auto lg:w-0.5 lg:rounded-r lg:rounded-bl-none', on ? 'opacity-100' : 'opacity-0')} aria-hidden />
              <Icon className="h-[22px] w-[22px]" aria-hidden />
              {n.label}
            </Link>
          );
        })}
        <p className="mt-auto hidden px-2 pb-4 text-center text-[11px] text-mute lg:block">{ROLE_LABEL[role]}</p>
      </nav>
    </div>
  );
}

export function PageHeader({
  title, subtitle, back, right,
}: { title: string; subtitle?: string; back?: string | 'history'; right?: ReactNode }) {
  const router = useRouter();
  return (
    <header className="no-print sticky top-0 z-30 flex items-center gap-1 border-b border-rule bg-lacquer/95 px-2 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
      {back && (
        back === 'history'
          ? <button type="button" onClick={() => router.back()} aria-label="กลับ" className="grid h-11 w-11 place-items-center rounded-lg text-dim hover:bg-inset hover:text-ivory"><ChevronLeft className="h-6 w-6" /></button>
          : <Link href={back} aria-label="กลับ" className="grid h-11 w-11 place-items-center rounded-lg text-dim hover:bg-inset hover:text-ivory"><ChevronLeft className="h-6 w-6" /></Link>
      )}
      <div className={cx('min-w-0 flex-1', !back && 'pl-2')}>
        <h1 className="truncate font-display text-[20px] font-semibold leading-tight">{title}</h1>
        {subtitle && <p className="truncate text-[13px] text-mute">{subtitle}</p>}
      </div>
      {right}
    </header>
  );
}
