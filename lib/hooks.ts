'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;      // โหลดครั้งแรก (ยังไม่มีข้อมูล)
  refreshing: boolean;   // โหลดซ้ำ (ยังแสดงข้อมูลเก่าอยู่)
  reload: () => Promise<void>;
  setData: (d: T | null) => void;
}

/** โหลดข้อมูลแบบ async: เก็บข้อมูลเก่าไว้ระหว่างโหลดซ้ำ กันหน้ากระพริบ และกันผลลัพธ์ที่มาช้าทับของใหม่ */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const ticket = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async () => {
    const mine = ++ticket.current;
    setRefreshing(true);
    try {
      const d = await fnRef.current();
      if (mine !== ticket.current) return;
      setData(d); setError(null);
    } catch (e) {
      if (mine !== ticket.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === ticket.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void run();
    return () => { ticket.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, refreshing, reload: run, setData };
}

export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** เวลาปัจจุบันที่อัปเดตทุก ms (ใช้แสดง "ค้างมา x นาที" ให้เดินเอง) */
export function useNow(ms = 60000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** true เมื่อหน้าจอตรง media query (ฝั่ง client เท่านั้น ; ตอนแรกเป็น false เพื่อไม่ให้ SSR ไม่ตรงกัน) */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}
