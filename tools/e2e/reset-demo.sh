#!/bin/bash
# สร้างฐานข้อมูลเดโมใหม่ + seed + เริ่ม dev-api ใหม่ (ฆ่าด้วย PID ที่เก็บไว้ ไม่ใช้ pkill -f)
# ใช้: bash tools/e2e/reset-demo.sh   (ต้องตั้ง PGHOST PGPORT PGUSER ; ไม่แตะ next dev)
cd "$(dirname "$0")/../.."
[ -f /tmp/dev-api.pid ] && kill "$(cat /tmp/dev-api.pid)" 2>/dev/null; sleep 1
bash tools/db/apply-all.sh namchok_demo 2>&1 | grep -i "error" 
rm -rf tools/dev-api/.data
node tools/dev-api/seed-demo.mjs 2>&1 | tail -1 | cut -c1-200
nohup node tools/dev-api/server.mjs > /tmp/dev-api.log 2>&1 &
echo $! > /tmp/dev-api.pid
sleep 3; head -2 /tmp/dev-api.log
