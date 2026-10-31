#!/bin/bash
# สร้างฐานข้อมูล Postgres ในเครื่อง (ไม่ใช่ Supabase จริง) แล้วรัน stub + migration 0001→0011 + seed
# usage: tools/db/apply-all.sh <ชื่อฐานข้อมูล>     ต้องตั้ง PGHOST PGPORT PGUSER (และ PGPASSWORD ถ้ามี)
# คำเตือน: จะ DROP ฐานข้อมูลชื่อนั้นทิ้งก่อนสร้างใหม่ — ใช้กับชื่อ *_test / *_demo เท่านั้น
set -e
DB="${1:?ระบุชื่อฐานข้อมูล เช่น namchok_demo}"
case "$DB" in *_test|*_demo|*_check) ;; *) echo "ปฏิเสธ: ชื่อฐานข้อมูลต้องลงท้าย _test / _demo / _check (กันเผลอลบของจริง)"; exit 2;; esac
cd "$(dirname "$0")/../.."
psql -q -c "drop database if exists $DB" -c "create database $DB" 2>&1 | grep -v NOTICE || true
for f in supabase/tests/00_supabase_stub.sql supabase/migrations/0001_schema.sql supabase/migrations/0002_rls.sql \
         supabase/migrations/0003_rpc.sql supabase/migrations/0004_storage.sql \
         supabase/migrations/0005_hide_money_from_non_finance.sql \
         supabase/migrations/0006_phase2_amendments.sql supabase/migrations/0007_assignments_requisitions.sql \
         supabase/migrations/0008_qc_labor.sql supabase/migrations/0009_realtime.sql \
         supabase/migrations/0010_multi_technician_assignment.sql supabase/migrations/0011_owner_crew_control.sql supabase/seed.sql; do
  echo "== $f"; psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" 2>&1 | head -20
done
