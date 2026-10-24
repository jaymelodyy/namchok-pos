'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { AuthProvider } from '@/lib/auth';

interface Toast { id: number; kind: 'ok' | 'err'; text: string }
interface ToastApi { ok: (t: string) => void; err: (t: string) => void }
const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const c = useContext(ToastCtx);
  if (!c) throw new Error('useToast ต้องอยู่ใต้ Providers');
  return c;
}

function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++seq.current;
    setItems((a) => [...a.slice(-2), { id, kind, text }]);
    setTimeout(() => setItems((a) => a.filter((t) => t.id !== id)), kind === 'err' ? 7000 : 3200);
  }, []);
  const api = useMemo<ToastApi>(() => ({ ok: (t) => push('ok', t), err: (t) => push('err', t) }), [push]);
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-[60] flex flex-col items-center gap-2 px-4">
        {items.map((t) => (
          <div
            key={t.id} role={t.kind === 'err' ? 'alert' : 'status'}
            className={`pointer-events-auto flex max-w-md animate-fadeIn items-start gap-2.5 rounded-xl border bg-raised px-4 py-3 text-[15px] shadow-xl ${t.kind === 'err' ? 'border-bad/60' : 'border-gold/50'}`}
          >
            {t.kind === 'err'
              ? <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-bad" aria-hidden />
              : <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-gold" aria-hidden />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function RegisterSW() {
  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* ติดตั้งแอปไม่ได้ก็ใช้งานต่อได้ */ });
    }
  }, []);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <ToastProvider>
        <RegisterSW />
        {children}
      </ToastProvider>
    </AuthProvider>
  );
}
