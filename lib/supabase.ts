import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && anon);

let client: SupabaseClient | null = null;

/** ใช้ anon key เท่านั้น — สิทธิ์จริงคุมด้วย RLS + RPC ในฐานข้อมูล */
export function sb(): SupabaseClient {
  if (!url || !anon) throw new Error('ยังไม่ได้ตั้งค่า NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (!client) {
    client = createClient(url, anon, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
}
