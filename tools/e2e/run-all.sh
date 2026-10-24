#!/bin/bash
# รัน flow หน้าจอทั้งหมดตามลำดับ บนฐานข้อมูลเดโมที่เพิ่งสร้างใหม่ (ดู README → "ทดสอบหน้าจอ")
# ต้องมี: dev-api (พอร์ต 54330) + next dev (พอร์ต 3100) รันอยู่ และ seed-demo.mjs เพิ่งรัน
cd "$(dirname "$0")/../.."
fail=0
for s in open-job full-flow flow-2 flow-3 flow-5 audit flow-6 fix-province-photos; do
  echo; echo "################ $s"
  node tools/e2e/$s.mjs || { echo "!!!! $s ล้มเหลว (exit $?)"; fail=1; }
done
echo; echo "==== สรุปรวม: $([ $fail = 0 ] && echo 'ผ่านทุกสคริปต์' || echo 'มีสคริปต์ล้มเหลว')"
exit $fail
