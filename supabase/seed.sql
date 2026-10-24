-- =====================================================================
-- seed.sql — โครงหมวดหมู่ + รายการตัวอย่าง "ราคา 0" ให้ owner กรอกเอง
-- * ไม่มีราคา / ไม่มี warranty_months (ว่าง) / ไม่มี crew_size,labor_rate ที่เดาเอง (ค่าเริ่มต้น 1 / 0)
-- * รันซ้ำได้ (idempotent)
-- =====================================================================
do $seed$
declare
  v_branch uuid;
begin
  insert into branches(code, name) values ('NTW', 'นำโชคออโต้แอร์ สาขานาทวี') on conflict (code) do nothing;
  select id into v_branch from branches where code = 'NTW';

  -- ---- หมวดหลัก ----
  insert into catalog_categories(branch_id, code, name, sort_order) values
    (v_branch, 'AC', 'งานแอร์รถยนต์', 1),
    (v_branch, 'FM', 'ฟิล์มกรองแสง', 2),
    (v_branch, 'BT', 'แบตเตอรี่', 3),
    (v_branch, 'PT', 'อะไหล่/วัสดุ', 4),
    (v_branch, 'OT', 'อื่น ๆ', 5)
  on conflict (branch_id, code) do nothing;

  -- ---- หมวดย่อย ----
  insert into catalog_categories(branch_id, code, name, parent_id, sort_order)
  select v_branch, s.code, s.name, p.id, s.ord
    from (values
      ('AC-DG', 'ตรวจเช็ค/วิเคราะห์อาการ', 1),
      ('AC-RF', 'น้ำยาและระบบ', 2),
      ('AC-RP', 'เปลี่ยน/ซ่อมชิ้นส่วนระบบทำความเย็น', 3),
      ('AC-EL', 'ระบบพัดลมและไฟฟ้าแอร์', 4),
      ('AC-CL', 'ล้างและดูแลรักษา', 5),
      ('FM-HK', 'Hi-Kool Ceramic Pro (ระดับพรีเมียม)', 1),
      ('FM-IR', 'IR Ceramic (ระดับกลาง)', 2),
      ('FM-NS', 'Nano Ceramic STATUS (ระดับมาตรฐาน)', 3),
      ('FM-EX', 'งานเสริม (ลอกฟิล์มเก่า, ติดเฉพาะตำแหน่ง)', 4),
      ('BT-CK', 'ตรวจวัด/ชาร์จแบต', 1),
      ('BT-RP', 'เปลี่ยนแบต', 2),
      ('PT-AC', 'อะไหล่แอร์', 1),
      ('PT-BT', 'แบตเตอรี่', 2),
      ('PT-CN', 'วัสดุสิ้นเปลือง (น้ำยา, น้ำมันคอมฯ, กรอง, โอริง)', 3),
      ('OT-FE', 'ค่าแรงพิเศษ/ค่าถอดประกอบเพิ่ม', 1),
      ('OT-DC', 'ส่วนลด', 2),
      ('OT-DP', 'มัดจำ (บันทึกเป็นรายการชำระ kind = deposit)', 3)
    ) as s(code, name, ord)
    join catalog_categories p on p.branch_id = v_branch and p.code = left(s.code, 2) and p.parent_id is null
  on conflict (branch_id, code) do nothing;

  -- ---- แบบฟอร์มเช็คสภาพ ----
  insert into condition_templates(branch_id, code, name, is_default, min_photos, checklist) values
    (v_branch, 'GEN', 'สภาพรถทั่วไป (ทุกคัน)', true, 1, jsonb_build_array(
      jsonb_build_object('key', 'body',     'label', 'ตัวถังภายนอก (รอยบุบ/ขีดข่วน)', 'required', true),
      jsonb_build_object('key', 'glass',    'label', 'กระจกและยางขอบ',               'required', true),
      jsonb_build_object('key', 'interior', 'label', 'ภายในห้องโดยสาร (เบาะ/พรม/แผงประตู)', 'required', true),
      jsonb_build_object('key', 'warning',  'label', 'ไฟเตือนบนหน้าปัด',             'required', true),
      jsonb_build_object('key', 'belongings', 'label', 'ทรัพย์สินที่อยู่ในรถ',      'required', true))),
    (v_branch, 'AC-EVAP', 'ก่อนรื้อคอนโซล (เปลี่ยนตู้แอร์)', false, 1, jsonb_build_array(
      jsonb_build_object('key', 'speaker',  'label', 'ลำโพง',            'required', true),
      jsonb_build_object('key', 'window',   'label', 'กระจกไฟฟ้า',       'required', true),
      jsonb_build_object('key', 'radio',    'label', 'วิทยุ',            'required', true),
      jsonb_build_object('key', 'cluster',  'label', 'ไฟหน้าปัด',        'required', true),
      jsonb_build_object('key', 'console',  'label', 'รอยคอนโซล',        'required', true)))
  on conflict (branch_id, code) do nothing;

  -- ---- รายการตัวอย่าง (ชื่อตามที่ระบุในโครงหมวดเท่านั้น) ----
  create temp table _seed_items (
    code text, name text, typ item_type, matrix boolean, check_tpl text, attrs text[]
  ) on commit drop;

  insert into _seed_items values
    ('AC-DG-001', 'วัดแรงดันระบบแอร์/วิเคราะห์อาการ', 'service', false, null, '{}'),
    ('AC-DG-002', 'ตรวจหารอยรั่วระบบแอร์', 'service', false, null, '{}'),
    ('AC-RF-001', 'เติมน้ำยาแอร์ (ค่าแรง)', 'service', false, null, '{}'),
    ('AC-RF-002', 'ไล่ลม/Vacuum ระบบแอร์', 'service', false, null, '{}'),
    ('AC-RF-003', 'เติมน้ำมันคอมเพรสเซอร์ (ค่าแรง)', 'service', false, null, '{}'),
    ('AC-RF-004', 'ล้างระบบแอร์', 'service', false, null, '{}'),
    ('AC-RP-001', 'ค่าแรงเปลี่ยนคอมเพรสเซอร์', 'service', false, null, '{}'),
    ('AC-RP-002', 'ค่าแรงเปลี่ยนแผงร้อน', 'service', false, null, '{}'),
    ('AC-RP-003', 'ค่าแรงเปลี่ยนตู้แอร์/อีวาพอเรเตอร์', 'service', false, 'AC-EVAP', '{}'),
    ('AC-RP-004', 'ค่าแรงเปลี่ยนวาล์วแอร์', 'service', false, null, '{}'),
    ('AC-RP-005', 'ค่าแรงเปลี่ยนไดเออร์', 'service', false, null, '{}'),
    ('AC-RP-006', 'ค่าแรงเปลี่ยนท่อ/สายแอร์', 'service', false, null, '{}'),
    ('AC-EL-001', 'ค่าแรงเปลี่ยนโบลเวอร์', 'service', false, null, '{}'),
    ('AC-EL-002', 'ค่าแรงเปลี่ยนมอเตอร์พัดลมแผงร้อน', 'service', false, null, '{}'),
    ('AC-EL-003', 'ค่าแรงเปลี่ยนคลัตช์คอมเพรสเซอร์', 'service', false, null, '{}'),
    ('AC-EL-004', 'ค่าแรงเปลี่ยนรีเลย์/เซ็นเซอร์/สวิตช์', 'service', false, null, '{}'),
    ('AC-CL-001', 'ล้างตู้แอร์', 'service', false, null, '{}'),
    ('AC-CL-002', 'ล้างแผงร้อน', 'service', false, null, '{}'),
    ('AC-CL-003', 'เปลี่ยนกรองแอร์ (ค่าแรง)', 'service', false, null, '{}'),
    ('AC-CL-004', 'ฆ่าเชื้อ/ดับกลิ่น', 'service', false, null, '{}'),
    ('FM-HK-001', 'ฟิล์ม Hi-Kool Ceramic Pro', 'service', true, null, '{}'),
    ('FM-IR-001', 'ฟิล์ม IR Ceramic', 'service', true, null, '{}'),
    ('FM-NS-001', 'ฟิล์ม Nano Ceramic STATUS', 'service', true, null, '{}'),
    ('FM-EX-001', 'ลอกฟิล์มเก่า', 'service', false, null, '{}'),
    ('FM-EX-002', 'ติดฟิล์มเฉพาะตำแหน่ง', 'service', false, null, '{}'),
    ('BT-CK-001', 'ตรวจวัดแบตเตอรี่', 'service', false, null, '{}'),
    ('BT-CK-002', 'ชาร์จแบตเตอรี่', 'service', false, null, '{}'),
    ('BT-RP-001', 'ค่าแรงเปลี่ยนแบตเตอรี่', 'service', false, null, '{ยี่ห้อ,รุ่น,ขนาด}'),
    ('PT-AC-001', 'คอมเพรสเซอร์ (อะไหล่)', 'part', false, null, '{}'),
    ('PT-AC-002', 'แผงร้อน (อะไหล่)', 'part', false, null, '{}'),
    ('PT-AC-003', 'ตู้แอร์/อีวาพอเรเตอร์ (อะไหล่)', 'part', false, null, '{}'),
    ('PT-AC-004', 'วาล์วแอร์ (อะไหล่)', 'part', false, null, '{}'),
    ('PT-AC-005', 'ไดเออร์ (อะไหล่)', 'part', false, null, '{}'),
    ('PT-AC-006', 'ท่อ/สายแอร์ (อะไหล่)', 'part', false, null, '{}'),
    ('PT-BT-001', 'แบตเตอรี่ (อะไหล่)', 'part', false, null, '{ยี่ห้อ,รุ่น,ขนาด}'),
    ('PT-CN-001', 'น้ำยาแอร์', 'part', false, null, '{}'),
    ('PT-CN-002', 'น้ำมันคอมเพรสเซอร์', 'part', false, null, '{}'),
    ('PT-CN-003', 'กรองแอร์', 'part', false, null, '{}'),
    ('PT-CN-004', 'โอริง', 'part', false, null, '{}'),
    ('OT-FE-001', 'ค่าแรงพิเศษ', 'fee', false, null, '{}'),
    ('OT-FE-002', 'ค่าถอดประกอบเพิ่ม', 'fee', false, null, '{}'),
    ('OT-DC-001', 'ส่วนลด', 'discount', false, null, '{}'),
    ('OT-DC-002', 'ส่วนลดแลกแบตเตอรี่เก่า', 'discount', false, null, '{}');

  insert into catalog_items(branch_id, category_id, code, name, item_type, requires_condition_check,
                            condition_template_id, attribute_schema, sort_order)
  select v_branch, c.id, s.code, s.name, s.typ, (s.check_tpl is not null), t.id, s.attrs, right(s.code, 3)::int
    from _seed_items s
    join catalog_categories c on c.branch_id = v_branch and c.code = left(s.code, 5)
    left join condition_templates t on t.branch_id = v_branch and t.code = s.check_tpl
  on conflict (branch_id, code) do nothing;

  -- ตัวเลือกราคา: รายการทั่วไป = 1 แถว (ราคา 0) ; ฟิล์ม = ตำแหน่ง × ขนาดรถ (5 × 5 = 25 แถว)
  insert into item_prices(branch_id, item_id)
  select v_branch, i.id
    from catalog_items i join _seed_items s on s.code = i.code
   where i.branch_id = v_branch and not s.matrix
     and not exists (select 1 from item_prices p where p.item_id = i.id);

  insert into item_prices(branch_id, item_id, position, vehicle_size)
  select v_branch, i.id, pos, sz
    from catalog_items i
    join _seed_items s on s.code = i.code
    cross join unnest(enum_range(null::film_position)) pos
    cross join unnest(enum_range(null::vehicle_size)) sz
   where i.branch_id = v_branch and s.matrix
     and not exists (select 1 from item_prices p where p.item_id = i.id);
end
$seed$;
