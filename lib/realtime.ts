'use client';
// Realtime ของหน้าจอ: ฟังการเปลี่ยนแปลงของตารางผ่าน Supabase Realtime (postgres_changes) แล้ว "ดึงข้อมูลใหม่"
//   * ไม่เชื่อ payload เป็นข้อมูลจริง — ใช้เป็นสัญญาณให้โหลดซ้ำเท่านั้น (ข้อมูลจริงมาจาก query ที่ผ่าน RLS เสมอ)
//   * Realtime ไม่ส่งเหตุการณ์เมื่อแถวเปลี่ยนจาก "มองเห็น" เป็น "มองไม่เห็น" ตาม RLS (เช่น งานที่คนอื่นรับจนเต็มแล้วหายจากรายการช่าง)
//     จึงมีโพลทุก 30 วินาทีเป็นตัวสำรอง + โหลดซ้ำเมื่อกลับมาเปิดหน้า/กลับมาออนไลน์/ต่อ Realtime ใหม่ได้
import { useEffect, useRef, useState } from 'react';
import { sb } from './supabase';

export type LiveTable = 'job_orders' | 'job_assignments' | 'requisitions' | 'payments' | 'refunds' | 'qc_checks' | 'labor_pay_entries';
export type LiveStatus = 'connecting' | 'live' | 'offline';
export interface LiveEvent { table: LiveTable; type: 'INSERT' | 'UPDATE' | 'DELETE'; record: Record<string, unknown> }

let channelSeq = 0;

export function useLive(
  tables: LiveTable[],
  onChange: (events: LiveEvent[]) => void,
  opts: { pollMs?: number; debounceMs?: number; enabled?: boolean } = {},
): LiveStatus {
  const { pollMs = 30000, debounceMs = 250, enabled = true } = opts;
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const cb = useRef(onChange);
  cb.current = onChange;
  const key = tables.join(',');

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let pending: LiveEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (!alive) return;
      const evs = pending; pending = [];
      cb.current(evs);
    };
    const kick = (ev?: LiveEvent) => {
      if (ev) pending.push(ev);
      if (timer) return;
      timer = setTimeout(flush, debounceMs);
    };

    const client = sb();
    const ch = client.channel(`live-${key.replace(/,/g, '-')}-${++channelSeq}`);
    for (const t of key.split(',') as LiveTable[]) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, (p) => {
        kick({ table: t, type: p.eventType as LiveEvent['type'], record: (p.eventType === 'DELETE' ? p.old : p.new) as Record<string, unknown> });
      });
    }
    let wasLive = false;
    ch.subscribe((st) => {
      if (!alive) return;
      if (st === 'SUBSCRIBED') {
        setStatus('live');
        if (wasLive) kick();              // ต่อกลับมาใหม่ → อาจพลาดเหตุการณ์ระหว่างหลุด → โหลดซ้ำ
        wasLive = true;
      } else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') {
        setStatus('offline');
      }
    });

    const poll = pollMs > 0 ? setInterval(() => { if (document.visibilityState === 'visible') kick(); }, pollMs) : null;
    const onVisible = () => { if (document.visibilityState === 'visible') kick(); };
    const onOnline = () => kick();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onVisible);

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onVisible);
      void client.removeChannel(ch);
    };
  }, [key, pollMs, debounceMs, enabled]);

  return status;
}
