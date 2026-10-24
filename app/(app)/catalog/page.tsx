'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Search } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { useToast } from '@/components/providers';
import { Button, Empty, ErrorNote, Field, Money, Sheet, Skeleton } from '@/components/ui';
import { createCatalogItem, loadCatalog, updateCatalogItem, updateItemPrice, type Catalog } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { cx, fmtMoney, num } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { ITEM_TYPE_LABEL, POSITIONS, POSITION_LABEL, SIZES, SIZE_LABEL, variantName } from '@/lib/labels';
import type { CatalogItem, ItemPrice, ItemType } from '@/lib/types';

export default function CatalogPage() {
  const { isOwner, canSeeMoney, role } = useSession();
  const router = useRouter();
  useEffect(() => { if (role === 'technician') router.replace('/jobs'); }, [role, router]);
  const st = useAsync(() => loadCatalog(true), []);
  const [mainId, setMainId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<CatalogItem | null>(null);
  const [creating, setCreating] = useState(false);

  const cat = st.data;
  const mains = useMemo(() => (cat?.categories ?? []).filter((c) => !c.parent_id), [cat]);
  const activeMain = mainId ?? mains[0]?.id ?? null;
  const needle = q.trim().toLowerCase();

  const groups = useMemo(() => {
    if (!cat) return [];
    const subs = cat.categories.filter((c) => c.parent_id && (needle || c.parent_id === activeMain));
    return subs.map((s) => ({
      sub: s,
      items: cat.items.filter((i) => i.category_id === s.id && (!needle || i.name.toLowerCase().includes(needle) || i.code.toLowerCase().includes(needle))),
    })).filter((g) => g.items.length > 0 || (!needle && isOwner));
  }, [cat, activeMain, needle, isOwner]);

  return (
    <>
      <PageHeader
        title="แคตตาล็อก" subtitle={isOwner ? 'เจ้าของตั้งราคาและระยะรับประกันที่นี่' : 'ดูรายการและราคา (แก้ไขได้เฉพาะเจ้าของ)'}
        right={isOwner ? <Button small className="mr-1" onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden />เพิ่มรายการ</Button> : undefined}
      />
      {st.loading ? (
        <div className="space-y-2 p-4"><Skeleton className="h-12" /><Skeleton className="h-40" /></div>
      ) : st.error && !cat ? (
        <ErrorNote message={st.error} onRetry={() => void st.reload()} />
      ) : cat && (
        <>
          <div className="space-y-3 px-4 pb-2 pt-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-mute" aria-hidden />
              <input type="search" aria-label="ค้นหารายการ" className="field pl-11" placeholder="ค้นหาชื่อหรือรหัส" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {!needle && (
              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="หมวดหลัก">
                {mains.map((m) => (
                  <button key={m.id} role="tab" aria-selected={activeMain === m.id} onClick={() => setMainId(m.id)}
                    className={cx('shrink-0 rounded-full border px-4 py-2 text-[14px] font-medium', activeMain === m.id ? 'border-gold bg-gold/15 text-gold-hi' : 'border-rule text-dim hover:text-ivory')}>
                    {m.name}<span className="num ml-1.5 text-mute">{cat.items.filter((i) => cat.categories.find((c) => c.id === i.category_id)?.parent_id === m.id).length}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {groups.length === 0 ? <Empty title="ไม่พบรายการ" hint="ลองค้นด้วยคำอื่น" /> : (
            <div className="space-y-6 pb-6 pt-2">
              {groups.map(({ sub, items }) => (
                <section key={sub.id} aria-label={sub.name}>
                  <h2 className="px-4 pb-1.5 text-[14px] font-medium text-dim"><span className="num mr-2 text-mute">{sub.code}</span>{sub.name}</h2>
                  {items.length === 0 ? (
                    <p className="border-y border-rule px-4 py-3 text-[14px] text-mute">ยังไม่มีรายการในหมวดนี้</p>
                  ) : (
                    <ul className="ledger border-y border-rule">
                      {items.map((i) => {
                        const rows = cat.prices.filter((p) => p.item_id === i.id && p.is_active);
                        const prices = rows.map((r) => r.price);
                        const max = prices.length ? Math.max(...prices) : 0;
                        const min = prices.length ? Math.min(...prices) : 0;
                        const unpriced = i.item_type !== 'bundle' && max === 0;
                        const Tag = isOwner ? 'button' : 'div';
                        return (
                          <li key={i.id}>
                            <Tag
                              {...(isOwner ? { type: 'button' as const, onClick: () => setEditing(i), 'aria-label': `แก้ไข ${i.name}` } : {})}
                              className={cx('flex w-full items-center gap-3 px-4 py-3 text-left', isOwner && 'transition-colors hover:bg-raised', !i.is_active && 'opacity-50')}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block font-medium">{i.name}{!i.is_active && <span className="ml-2 text-[12px] text-mute">ปิดใช้งาน</span>}</span>
                                <span className="num block text-[12px] text-mute">
                                  {i.code}  {ITEM_TYPE_LABEL[i.item_type]}
                                  {i.warranty_months ? `  ประกัน ${i.warranty_months} เดือน` : ''}
                                </span>
                              </span>
                              {canSeeMoney && (
                                <span className="shrink-0 text-right text-[14px]">
                                  {i.item_type === 'bundle' ? <span className="text-dim">ชุดบริการ</span>
                                    : unpriced ? <span className="text-warn">ยังไม่ตั้งราคา</span>
                                    : min === max ? <Money v={max} /> : <span className="num text-dim">{fmtMoney(min)} ขึ้นไป</span>}
                                </span>
                              )}
                            </Tag>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {cat && <ItemEditor item={editing} cat={cat} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void st.reload(); }} />}
      {cat && <CreateItem open={creating} cat={cat} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void st.reload(); }} />}
    </>
  );
}

// ===================================================================
function ItemEditor({ item, cat, onClose, onSaved }: { item: CatalogItem | null; cat: Catalog; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [warranty, setWarranty] = useState('');
  const [crew, setCrew] = useState('1');
  const [labor, setLabor] = useState('0');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [seen, setSeen] = useState<string | null>(null);

  // โหลดค่าเริ่มต้นทุกครั้งที่เปิดรายการใหม่
  if (item && seen !== item.id) {
    setSeen(item.id);
    setPrices(Object.fromEntries(cat.prices.filter((p) => p.item_id === item.id).map((p) => [p.id, String(p.price)])));
    setWarranty(item.warranty_months ? String(item.warranty_months) : '');
    setCrew(String(item.crew_size)); setLabor(String(item.labor_rate)); setActive(item.is_active); setErr(null);
  }
  if (!item && seen) setSeen(null);
  if (!item) return null;

  const rows = cat.prices.filter((p) => p.item_id === item.id);
  const isMatrix = rows.length > 1;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const jobs: Promise<void>[] = [];
      for (const r of rows) {
        const v = num(prices[r.id]);
        if (v !== r.price) jobs.push(updateItemPrice(r.id, { price: v }));
      }
      const w = warranty.trim() ? Number(warranty) : null;
      const patch: Partial<CatalogItem> = {};
      if (w !== item.warranty_months) patch.warranty_months = w;
      if (num(crew) !== item.crew_size) patch.crew_size = Math.max(1, Math.round(num(crew)));
      if (num(labor) !== item.labor_rate) patch.labor_rate = num(labor);
      if (active !== item.is_active) patch.is_active = active;
      if (Object.keys(patch).length) jobs.push(updateCatalogItem(item.id, patch));
      await Promise.all(jobs);
      toast.ok('บันทึกแคตตาล็อกแล้ว');
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  const priceField = (r: ItemPrice, label?: string) => (
    <input
      key={r.id} aria-label={label ?? 'ราคา'} className="field num min-h-[44px] px-2 text-right" inputMode="decimal"
      value={prices[r.id] ?? ''} onChange={(e) => setPrices((p) => ({ ...p, [r.id]: e.target.value.replace(/[^\d.]/g, '') }))}
    />
  );
  const isBundle = item.item_type === 'bundle';

  return (
    <Sheet
      open onClose={onClose} title={item.name}
      footer={<Button className="w-full" onClick={save} loading={busy}>บันทึก</Button>}
    >
      <div className="space-y-5">
        <p className="num text-[13px] text-mute">{item.code}  {ITEM_TYPE_LABEL[item.item_type]}</p>

        {isBundle ? (
          <p className="rounded-xl border border-rule bg-inset px-4 py-3 text-[14px] text-dim">ชุดบริการคิดราคาจากรายการย่อย — กำหนดรายการย่อยในฐานข้อมูล (ตาราง catalog_bundle_components)</p>
        ) : !isMatrix ? (
          rows[0] && <Field label={item.item_type === 'discount' ? 'ส่วนลดมาตรฐาน (บาท) ปล่อย 0 ถ้าให้กรอกตอนใช้' : 'ราคา (บาท)'} htmlFor="cat-price">
            <input id="cat-price" className="field num" inputMode="decimal" value={prices[rows[0].id] ?? ''} onChange={(e) => setPrices((p) => ({ ...p, [rows[0].id]: e.target.value.replace(/[^\d.]/g, '') }))} />
          </Field>
        ) : (
          <div>
            <p className="label">ราคาตามตำแหน่งและขนาดรถ (บาท)</p>
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[520px] border-separate border-spacing-1 text-[13px]">
                <thead>
                  <tr>
                    <th scope="col" className="w-24" />
                    {SIZES.map((s) => <th key={s} scope="col" className="px-1 pb-1 text-center font-medium text-dim">{SIZE_LABEL[s]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {POSITIONS.map((p) => (
                    <tr key={p}>
                      <th scope="row" className="pr-2 text-left font-medium text-dim">{POSITION_LABEL[p]}</th>
                      {SIZES.map((s) => {
                        const r = rows.find((x) => x.position === p && x.vehicle_size === s);
                        return <td key={s}>{r ? priceField(r, variantName(p, s)) : null}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <Field label="ระยะรับประกัน (เดือน)" htmlFor="cat-warranty" hint="เว้นว่าง = ไม่มีใบรับประกัน ระบบจะไม่เดาให้ — กรอกเมื่อทราบเงื่อนไขจริง">
          <input id="cat-warranty" className="field num" inputMode="numeric" value={warranty} onChange={(e) => setWarranty(e.target.value.replace(/\D/g, ''))} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="จำนวนช่างมาตรฐาน" htmlFor="cat-crew"><input id="cat-crew" className="field num" inputMode="numeric" value={crew} onChange={(e) => setCrew(e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label="ค่าแรงช่างต่อรายการ (บาท)" htmlFor="cat-labor"><input id="cat-labor" className="field num" inputMode="decimal" value={labor} onChange={(e) => setLabor(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        </div>
        <button
          type="button" role="switch" aria-checked={active} onClick={() => setActive((a) => !a)}
          className={cx('flex min-h-tap w-full items-center justify-between rounded-xl border px-4 text-[15px]', active ? 'border-gold/50 bg-gold/10 text-gold-hi' : 'border-rule bg-inset text-dim')}
        >
          <span>{active ? 'เปิดใช้งาน (เลือกใส่ใบงานได้)' : 'ปิดใช้งาน (ซ่อนจากใบงานใหม่)'}</span>
        </button>
        {err && <p role="alert" className="text-[15px] text-bad">{err}</p>}
      </div>
    </Sheet>
  );
}

// ===================================================================
function CreateItem({ open, cat, onClose, onCreated }: { open: boolean; cat: Catalog; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const subs = cat.categories.filter((c) => c.parent_id);
  const [subId, setSubId] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<ItemType>('service');
  const [matrix, setMatrix] = useState(false);
  const [attrs, setAttrs] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sub = subs.find((s) => s.id === (subId || subs[0]?.id));
  const main = sub ? sub.code.slice(0, 2) : '';
  const forced: ItemType | null = sub?.code === 'OT-DC' ? 'discount' : sub?.code === 'OT-FE' ? 'fee' : main === 'PT' ? 'part' : null;
  const effectiveType = forced ?? (type === 'part' || type === 'fee' || type === 'discount' ? 'service' : type);
  const noItems = sub?.code === 'OT-DP';

  const submit = async () => {
    if (!sub) return;
    setBusy(true); setErr(null);
    try {
      await createCatalogItem({
        categoryId: sub.id, name: name.trim(), type: effectiveType, withMatrix: matrix && main === 'FM',
        attributeSchema: attrs.split(',').map((s) => s.trim()).filter(Boolean),
      });
      toast.ok('เพิ่มรายการแล้ว รหัสถูกกำหนดให้อัตโนมัติ กรอกราคาต่อได้เลย');
      setName(''); setAttrs(''); setMatrix(false);
      onCreated();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  return (
    <Sheet open={open} onClose={onClose} title="เพิ่มรายการใหม่"
      footer={<Button className="w-full" onClick={submit} loading={busy} disabled={!name.trim() || !sub || noItems}>เพิ่มรายการ</Button>}>
      <div className="space-y-4">
        <Field label="หมวดย่อย" htmlFor="new-sub">
          <select id="new-sub" className="field" value={sub?.id ?? ''} onChange={(e) => setSubId(e.target.value)}>
            {subs.map((s) => <option key={s.id} value={s.id}>{s.code}  {s.name}</option>)}
          </select>
          <p className="hint">1 รายการอยู่ได้หมวดย่อยเดียว และย้ายหมวดภายหลังไม่ได้ ระบบรันรหัสให้เอง</p>
        </Field>
        {noItems ? (
          <p className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-[14px] text-warn">หมวดมัดจำไม่มีรายการ — มัดจำบันทึกเป็นรายการรับเงินชนิด "มัดจำ" ที่หน้าใบงาน</p>
        ) : (
          <>
            <Field label="ชื่อรายการ" htmlFor="new-name"><input id="new-name" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="ชื่อที่ช่างและลูกค้าเข้าใจ" /></Field>
            {forced ? (
              <p className="text-[14px] text-dim">ประเภท: {ITEM_TYPE_LABEL[forced]} (กำหนดโดยหมวด)</p>
            ) : (
              <Field label="ประเภท" htmlFor="new-type">
                <select id="new-type" className="field" value={effectiveType} onChange={(e) => setType(e.target.value as ItemType)}>
                  <option value="service">ค่าแรง/บริการ</option>
                  <option value="bundle">ชุดบริการ (แตกเป็นรายการย่อย)</option>
                </select>
              </Field>
            )}
            {main === 'FM' && (
              <button type="button" role="switch" aria-checked={matrix} onClick={() => setMatrix((m) => !m)}
                className={cx('flex min-h-tap w-full items-center rounded-xl border px-4 text-[15px]', matrix ? 'border-gold/50 bg-gold/10 text-gold-hi' : 'border-rule bg-inset text-dim')}>
                {matrix ? 'ราคาแยกตามตำแหน่ง × ขนาดรถ (25 ช่อง)' : 'ราคาเดียว'}
              </button>
            )}
            <Field label="ข้อมูลที่ต้องบันทึกตอนใส่ใบงาน (ไม่บังคับ)" htmlFor="new-attrs" hint="คั่นด้วยจุลภาค เช่น ยี่ห้อ, รุ่น, ขนาด (ใช้กับแบตเตอรี่)">
              <input id="new-attrs" className="field" value={attrs} onChange={(e) => setAttrs(e.target.value)} />
            </Field>
          </>
        )}
        {err && <p role="alert" className="text-[15px] text-bad">{err}</p>}
      </div>
    </Sheet>
  );
}
