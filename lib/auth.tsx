'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isConfigured, sb } from './supabase';
import { loadProfile, loadSettings } from './api';
import type { BranchSettings, Profile, Role } from './types';

type AuthState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'out' }
  | { status: 'no-profile'; email: string | null }
  | { status: 'in'; profile: Profile; settings: BranchSettings | null };

interface AuthCtx {
  state: AuthState;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSettings: () => Promise<void>;
}
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: isConfigured ? 'loading' : 'unconfigured' });

  const hydrate = useCallback(async (userId: string | null, email: string | null) => {
    if (!userId) { setState({ status: 'out' }); return; }
    try {
      const profile = await loadProfile(userId);
      if (!profile || !profile.is_active) { setState({ status: 'no-profile', email }); return; }
      const settings = await loadSettings(profile.branch_id);
      setState({ status: 'in', profile, settings });
    } catch {
      setState({ status: 'no-profile', email });
    }
  }, []);

  useEffect(() => {
    if (!isConfigured) return;
    const client = sb();
    let alive = true;
    client.auth.getSession().then(({ data }) => {
      if (alive) void hydrate(data.session?.user.id ?? null, data.session?.user.email ?? null);
    });
    const { data: sub } = client.auth.onAuthStateChange((event, session) => {
      // อัปเดตเฉพาะเมื่อเข้า/ออกจริง (TOKEN_REFRESHED ไม่ต้องโหลดใหม่)
      if (event === 'SIGNED_OUT') setState({ status: 'out' });
      if (event === 'SIGNED_IN' && session) setTimeout(() => void hydrate(session.user.id, session.user.email ?? null), 0);
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [hydrate]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await sb().auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw new Error(/invalid/i.test(error.message) ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : error.message);
  }, []);
  const signOut = useCallback(async () => { await sb().auth.signOut(); setState({ status: 'out' }); }, []);
  const refreshSettings = useCallback(async () => {
    const { data } = await sb().auth.getSession();
    if (data.session) await hydrate(data.session.user.id, data.session.user.email ?? null);
  }, [hydrate]);

  const value = useMemo(() => ({ state, signIn, signOut, refreshSettings }), [state, signIn, signOut, refreshSettings]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth ต้องอยู่ใต้ AuthProvider');
  return c;
}

/** ใช้ในหน้าที่ล็อกอินแล้วเท่านั้น (AppShell การันตี) */
export function useSession(): { profile: Profile; settings: BranchSettings | null; role: Role; isOwner: boolean; canSeeMoney: boolean } {
  const { state } = useAuth();
  if (state.status !== 'in') throw new Error('ยังไม่ได้เข้าสู่ระบบ');
  const role = state.profile.role;
  return { profile: state.profile, settings: state.settings, role, isOwner: role === 'owner', canSeeMoney: role === 'owner' || role === 'admin' };
}
