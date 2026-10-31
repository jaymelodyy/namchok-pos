import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ManagerContext = { client: SupabaseClient; userId: string; branchId: string; anonKey: string; token: string; url: string };
const json = (body: object, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

async function authorize(request: NextRequest): Promise<ManagerContext | NextResponse> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !serviceKey || !anonKey) return json({ error: 'ระบบจัดการบัญชียังไม่ได้ตั้งค่าฝั่งเซิร์ฟเวอร์' }, 503);

  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json({ error: 'กรุณาเข้าสู่ระบบใหม่' }, 401);

  const client = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: authData, error: authError } = await client.auth.getUser(token);
  if (authError || !authData.user) return json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' }, 401);

  const { data: profile, error: profileError } = await client.from('users')
    .select('branch_id,role,is_active').eq('id', authData.user.id).maybeSingle();
  if (profileError) return json({ error: 'ตรวจสอบสิทธิ์บัญชีไม่สำเร็จ' }, 503);
  if (!profile?.is_active) return json({ error: 'บัญชีนี้ไม่มีสิทธิ์จัดการพนักงาน' }, 403);
  if (profile.role !== 'owner' && profile.role !== 'admin') return json({ error: 'เฉพาะผู้จัดการเท่านั้น' }, 403);
  return { client, userId: authData.user.id, branchId: profile.branch_id, anonKey, token, url };
}

function isContext(value: ManagerContext | NextResponse): value is ManagerContext {
  return !(value instanceof NextResponse);
}

async function parseBody(request: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  let value: unknown;
  try {
    value = await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' }, 400);
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' }, 400);
  return value as Record<string, unknown>;
}

function isBody(value: Record<string, unknown> | NextResponse): value is Record<string, unknown> {
  return !(value instanceof NextResponse);
}

export async function POST(request: NextRequest) {
  const context = await authorize(request);
  if (!isContext(context)) return context;
  const body = await parseBody(request);
  if (!isBody(body)) return body;

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json({ error: 'กรุณาระบุอีเมลให้ถูกต้อง' }, 400);
  }
  if (fullName.length < 1 || fullName.length > 100) return json({ error: 'ชื่อพนักงานต้องมี 1–100 ตัวอักษร' }, 400);
  if (password.length < 12 || password.length > 128) return json({ error: 'รหัสผ่านต้องมี 12–128 ตัวอักษร' }, 400);

  const { data, error } = await context.client.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: fullName },
  });
  if (error || !data.user) return json({ error: 'สร้างบัญชีไม่สำเร็จ ตรวจสอบอีเมลที่ใช้ซ้ำหรือการตั้งค่า Auth' }, 409);

  const { error: profileError } = await context.client.from('users').insert({
    id: data.user.id, branch_id: context.branchId, full_name: fullName, role: 'technician', created_by: context.userId,
  });
  if (profileError) {
    const { error: cleanupError } = await context.client.auth.admin.deleteUser(data.user.id);
    if (cleanupError) return json({ error: 'สร้างบัญชีไม่ครบ กรุณาให้ผู้ดูแลระบบตรวจสอบก่อนลองซ้ำ' }, 500);
    return json({ error: 'บันทึกข้อมูลพนักงานไม่สำเร็จ' }, 500);
  }

  return json({ userId: data.user.id }, 201);
}

export async function DELETE(request: NextRequest) {
  const context = await authorize(request);
  if (!isContext(context)) return context;
  const body = await parseBody(request);
  if (!isBody(body)) return body;
  const userId = typeof body.userId === 'string' ? body.userId : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    return json({ error: 'รหัสพนักงานไม่ถูกต้อง' }, 400);
  }

  const { data: employee, error: lookupError } = await context.client.from('users').select('id')
    .eq('id', userId).eq('branch_id', context.branchId).eq('role', 'technician').maybeSingle();
  if (lookupError) return json({ error: 'ตรวจสอบข้อมูลพนักงานไม่สำเร็จ' }, 503);
  if (!employee) return json({ error: 'ไม่พบช่างในสาขานี้' }, 404);

  const userClient = createClient(context.url, context.anonKey, {
    global: { headers: { Authorization: `Bearer ${context.token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: disableError } = await userClient.rpc('deactivate_technician', { p_user_id: userId });
  if (disableError) return json({ error: 'ปิดสิทธิ์พนักงานไม่สำเร็จ' }, 503);

  const { error: banError } = await context.client.auth.admin.updateUserById(userId, { ban_duration: '876000h' });
  if (banError) return json({ error: 'ปิดสิทธิ์ในระบบแล้ว แต่ระงับการเข้าสู่ระบบไม่สำเร็จ' }, 503);
  return json({ ok: true });
}
