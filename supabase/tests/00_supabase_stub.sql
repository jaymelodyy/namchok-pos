-- จำลองส่วนของ Supabase ที่ migration พึ่งพา (ใช้เฉพาะตอนทดสอบบน Postgres ธรรมดา — ห้ามรันบน Supabase จริง)
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text,
  owner uuid, created_at timestamptz default now());
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select string_to_array(name, '/')
$$;
grant usage on schema storage to authenticated;
grant select, insert on storage.objects to authenticated;
-- Supabase ให้สิทธิ์เริ่มต้นแบบนี้กับ public schema ; migration ต้องถอนเองให้เหลือเท่าที่จำเป็น
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase มี publication นี้อยู่แล้ว (migration 0009 เพิ่มตารางเข้าไป)
create publication supabase_realtime;
