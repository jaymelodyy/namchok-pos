#!/bin/bash
# รันสคริปต์ e2e เฟส 2 ตามลำดับ บนฐานข้อมูลเดโมที่รีเซ็ตใหม่ (reset-demo.sh) — ไม่ใช่ Supabase จริง
# ต้องมี: Postgres (พอร์ต 54329), next dev (พอร์ต 3100) รันอยู่ ; ต้องตั้ง PGHOST PGPORT PGUSER (ค่าเริ่มต้นด้านล่าง)
# หมายเหตุ: p2-realtime ทดสอบกับ "ตัวจำลอง Realtime ของ dev-api" ไม่ใช่ Supabase Realtime ตัวจริง
cd "$(dirname "$0")/../.."
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-54329}" PGUSER="${PGUSER:-postgres}"
bash tools/e2e/reset-demo.sh | tail -3
fail=0; summary=""
for s in p2-realtime p2-payment-live p2-accept-race p2-qc-close p2-refund p2-visibility; do
  echo; echo "################ $s"
  out=$(node "tools/e2e/$s.mjs" 2>&1); rc=$?
  echo "$out" | grep -v '^shot'
  line=$(echo "$out" | grep -E "^$s: [0-9]+ ผ่าน" | tail -1)
  summary="$summary\n  $s  →  ${line:-(ไม่มีสรุป — สคริปต์อาจหยุดกลางคัน)}  [exit $rc]"
  [ $rc = 0 ] || fail=1
done
echo; echo "==== สรุปเฟส 2:$(printf "$summary")"
echo "==== $([ $fail = 0 ] && echo 'ผ่านทุกสคริปต์' || echo 'มีสคริปต์ล้มเหลว')"
exit $fail
