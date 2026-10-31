'use client';
// แจ้งเตือนในแอปแบบเรียลไทม์ตามบทบาท (toast) + ตัวบอกสถานะการเชื่อมต่อ
//   คลัง          : มีคำขอเบิกอะไหล่ใหม่
//   เจ้าของ/แอดมิน : คลังจัดเตรียมอะไหล่แล้ว / อะไหล่ครบ ใบงานพร้อมเริ่มงาน
//   ช่าง          : มีงานพร้อมทำ (รับงานได้) / ถูกมอบหมายงาน / ถูกเอาออกจากงาน (โดยเจ้าของหรือแอดมิน)
// หมายเหตุ: เป็นการแจ้งเตือนขณะเปิดแอปอยู่เท่านั้น (ยังไม่ใช่ push/LINE — เป็นงานเฟส 3)
import { useRef } from 'react';
import { useSession } from '@/lib/auth';
import { msSinceOwnWrite } from '@/lib/api';
import { useLive, type LiveEvent, type LiveStatus } from '@/lib/realtime';
import { useToast } from './providers';
import { cx } from '@/lib/format';

export function LiveNotifier() {
  const { role, profile } = useSession();
  const toast = useToast();
  const seen = useRef(new Set<string>());

  const once = (key: string) => {
    if (seen.current.has(key)) return false;
    seen.current.add(key);
    if (seen.current.size > 400) seen.current = new Set([...seen.current].slice(-200));
    return true;
  };
  const buzz = () => { try { navigator.vibrate?.(60); } catch { /* ไม่รองรับก็ข้าม */ } };

  useLive(
    role === 'warehouse' ? ['requisitions'] : role === 'technician' ? ['job_orders', 'job_assignments'] : ['requisitions', 'job_orders'],
    (evs: LiveEvent[]) => {
      for (const e of evs) {
        const r = e.record as Record<string, string | null | undefined>;
        if (!r?.id) continue;
        const mine = msSinceOwnWrite() < 2500;      // เพิ่งกดเอง → ไม่ต้องแจ้งซ้ำ
        if (e.table === 'requisitions') {
          if (role === 'warehouse' && e.type === 'INSERT' && r.status === 'requested' && once(`rq:${r.id}:new`) && !mine) {
            toast.ok(`มีคำขอเบิกอะไหล่ใหม่ ${r.req_no ?? ''} · ${r.plate ?? ''}`.trim()); buzz();
          }
          if ((role === 'admin' || role === 'owner') && e.type === 'UPDATE' && r.status === 'prepared' && once(`rq:${r.id}:prepared`) && !mine) {
            toast.ok(`คลังจัดเตรียมอะไหล่แล้ว ${r.req_no ?? ''} · ${r.plate ?? ''}`.trim());
          }
        }
        // ช่าง: ถูกมอบหมาย/ถูกเอาออก โดยคนอื่น (created_by/released_by ไม่ใช่ตัวเอง) — กดรับเองไม่ต้องเด้ง
        if (e.table === 'job_assignments' && role === 'technician' && r.user_id === profile.id) {
          if (e.type === 'INSERT' && r.created_by !== profile.id && once(`as:${r.id}:new`)) {
            toast.ok('คุณถูกมอบหมายงานใหม่ — ดูที่ "กำลังรับผิดชอบ"'); buzz();
          }
          if (e.type === 'UPDATE' && r.released_at && r.released_by !== profile.id && once(`as:${r.id}:released`)) {
            toast.ok(`คุณถูกเอาออกจากงาน${r.release_reason ? ` (${r.release_reason})` : ''}`);
          }
        }
        if (e.table === 'job_orders' && e.type === 'UPDATE' && r.status === 'ready' && once(`job:${r.id}:ready:${r.status_changed_at}`) && !mine) {
          if (role === 'technician') { toast.ok(`มีงานพร้อมทำ ${r.job_no ?? ''} — กดรับงานได้เลย`.trim()); buzz(); }
          if (role === 'admin' || role === 'owner') toast.ok(`อะไหล่ครบแล้ว ${r.job_no ?? ''} พร้อมเริ่มงาน`.trim());
        }
      }
    },
    { pollMs: 0 },    // ตัวแจ้งเตือนไม่ต้องโพล (หน้าจอแต่ละหน้าโพลของตัวเองอยู่แล้ว) ; ถ้าพลาดเหตุการณ์ก็แค่ไม่เด้ง ข้อมูลในหน้ายังถูกต้อง
  );
  return null;
}

export function LiveDot({ status, className }: { status: LiveStatus; className?: string }) {
  const label = status === 'live' ? 'เชื่อมต่อสด' : status === 'connecting' ? 'กำลังเชื่อมต่อ' : 'ออฟไลน์ — รีเฟรชอัตโนมัติทุก 30 วินาที';
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-[12px]', status === 'live' ? 'text-ok' : status === 'connecting' ? 'text-mute' : 'text-warn', className)} title={label}>
      <span className={cx('h-2 w-2 rounded-full', status === 'live' ? 'bg-ok' : status === 'connecting' ? 'bg-mute animate-pulse' : 'bg-warn')} aria-hidden />
      <span>{status === 'live' ? 'สด' : status === 'connecting' ? 'เชื่อมต่อ' : 'ออฟไลน์'}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
