-- =====================================================================
-- 0004_storage.sql — bucket เก็บรูปเช็คสภาพ / ลายเซ็น / สลิป (private)
-- โครงชื่อไฟล์: {branch_id}/{job_id}/{ชนิด}/{ไฟล์}  — โฟลเดอร์แรกต้องเป็น branch_id ของผู้ใช้
-- ไม่มี policy update/delete = ลบ/ทับไฟล์หลักฐานไม่ได้
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('job-files', 'job-files', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do nothing;

create policy job_files_select on storage.objects for select to authenticated
  using (bucket_id = 'job-files'
         and (storage.foldername(name))[1] = app_branch_id()::text
         and app_role() in ('owner', 'admin', 'technician'));

create policy job_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'job-files'
         and (storage.foldername(name))[1] = app_branch_id()::text
         and app_role() in ('owner', 'admin', 'technician'));
