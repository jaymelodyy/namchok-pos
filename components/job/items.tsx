'use client';
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Minus, Plus, Search, Trash2 } from 'lucide-react';
import { addItem, loadCatalog, removeItem, setItemPrice, setItemQty, type Catalog } from '@/lib/api';
import { cx, fmtMoney, num } from '@/lib/format';
import { ITEM_TYPE_LABEL, POSITION_LABEL, SIZE_LABEL } from '@/lib/labels';
import type { CatalogItem, FilmPosition, ItemPrice, JobItem, JobStatus, VehicleSize } from '@/lib/types';
import { Button, Empty, Field, Money, ReasonSheet, Sheet, Spinner } from '../ui';

export const EDITABLE_STATUSES: JobStatus[] = ['booked', 'opened', 'condition_check', 'quoting'];

// ===================================================================
// รายการในใบงาน
// ===================================================================
export function ItemsPanel({
  items, canEdit, showMoney, onAdd, onChanged,
}: { items: JobItem[]; canEdit: boolean; showMoney: boolean; onAdd: () => void; onChanged: () => void }) {
  const [editing, setEditing] = useState<JobItem | null>(null);
  return (
    <section aria-labelledby="items-h">
      <div className="flex items-center justify-between px-4 pb-2">
        <h2 id="items-h" className="section-title">รายการงานและอะไหล่</h2>
        {canEdit && <Button small variant="outline" onClick={onAdd}><Plus className="h-4 w-4" aria-hidden />เพิ่มรายการ</Button>}
      </div>
      {items.length === 0 ? (
        <Empty title="ยังไม่มีรายการ" hint={canEdit ? 'กด "เพิ่มรายการ" เพื่อเลือกค่าแรงและอะไหล่' : 'ใบงานนี้ยังไม่มีรายการ'} />
      ) : (
        <ul className="ledger border-y border-rule">
          {items.map((it) => {
            const row = (
              <>
                <div className="min-w-0 flex-1">
                  <p className={cx('font-medium', it.parent_id && 'text-[15px]', it.is_bundle_header && 'font-display')}>
                    {it.item_name}
                    {it.item_type === 'part' && <span className="ml-2 rounded border border-rule px-1.5 py-px text-[11px] font-normal text-mute">อะไหล่</span>}
                  </p>
                  {(it.variant_label || Object.keys(it.attributes ?? {}).length > 0) && (
                    <p className="text-[13px] text-dim">
                      {[it.variant_label, ...Object.entries(it.attributes ?? {}).map(([k, v]) => `${k} ${v}`)].filter(Boolean).join('  ')}
                    </p>
                  )}
                  {it.price_reason && <p className="text-[12px] text-mute">เหตุผลราคา: {it.price_reason}</p>}
                  {it.warranty_months != null && <p className="text-[12px] text-mute">รับประกัน {it.warranty_months} เดือน</p>}
                  {it.item_type === 'discount' && !it.owner_approved_at && <p className="text-[12px] text-warn">รอเจ้าของอนุมัติ (ถ้าเกินเพดาน)</p>}
                </div>
                <div className="shrink-0 text-right">
                  {it.is_bundle_header ? (
                    <p className="num text-[13px] text-mute">x{num(it.qty)}</p>
                  ) : showMoney ? (
                    <>
                      <p className={cx('num font-medium', it.item_type === 'discount' && 'text-warn')}>{fmtMoney(it.line_total)}</p>
                      <p className="num text-[12px] text-mute">{num(it.qty)} x {fmtMoney(it.unit_price)}</p>
                    </>
                  ) : (
                    <p className="num text-[14px] text-dim">x{num(it.qty)}</p>
                  )}
                </div>
              </>
            );
            const cls = cx('flex w-full items-start gap-3 px-4 py-3 text-left', it.parent_id && 'bg-raised/60 pl-9');
            return (
              <li key={it.id}>
                {canEdit ? (
                  <button type="button" className={cx(cls, 'transition-colors hover:bg-raised')} onClick={() => setEditing(it)} aria-label={`แก้ไข ${it.item_name}`}>{row}</button>
                ) : (
                  <div className={cls}>{row}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <EditLineSheet line={editing} onClose={() => setEditing(null)} onChanged={() => { setEditing(null); onChanged(); }} />
    </section>
  );
}

function EditLineSheet({ line, onClose, onChanged }: { line: JobItem | null; onClose: () => void; onChanged: () => void }) {
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (line) {
      setQty(num(line.qty));
      setPrice(String(Math.abs(num(line.unit_price))));
      setReason(''); setErr(null); setBusy(false); setRemoving(false);
    }
  }, [line]);
  if (!line) return null;

  const isDiscount = line.item_type === 'discount';
  const header = line.is_bundle_header;
  const origPrice = Math.abs(num(line.unit_price));
  const newPrice = num(price);
  const priceChanged = !header && newPrice !== origPrice;
  const qtyChanged = !header && qty !== num(line.qty);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (priceChanged) await setItemPrice(line.id, isDiscount ? -newPrice : newPrice, reason);
      if (qtyChanged) await setItemQty(line.id, qty);
      onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  return (
    <>
      <Sheet
        open={!removing} onClose={onClose} title={line.item_name}
        footer={
          <div className="flex gap-3">
            <Button variant="danger" onClick={() => setRemoving(true)} aria-label="ลบรายการ"><Trash2 className="h-4 w-4" aria-hidden />ลบ</Button>
            {!header && <Button className="flex-1" onClick={save} loading={busy} disabled={(!priceChanged && !qtyChanged) || (priceChanged && !reason.trim())}>บันทึก</Button>}
          </div>
        }
      >
        {header ? (
          <p className="text-[15px] text-dim">นี่คือหัวข้อของชุดบริการ — แก้ราคาได้ที่รายการย่อยแต่ละบรรทัด หรือลบทั้งชุด</p>
        ) : (
          <div className="space-y-4">
            <Field label="จำนวน">
              <div className="flex items-center gap-3">
                <Button variant="outline" aria-label="ลดจำนวน" onClick={() => setQty((q) => Math.max(1, q - 1))}><Minus className="h-4 w-4" /></Button>
                <span className="num min-w-10 text-center font-display text-xl font-semibold" aria-live="polite">{qty}</span>
                <Button variant="outline" aria-label="เพิ่มจำนวน" onClick={() => setQty((q) => q + 1)}><Plus className="h-4 w-4" /></Button>
              </div>
            </Field>
            <Field label={isDiscount ? 'ส่วนลดต่อหน่วย (บาท)' : 'ราคาต่อหน่วย (บาท)'} htmlFor="line-price" hint={line.list_price != null ? `ราคาในแคตตาล็อก ${fmtMoney(line.list_price)}` : undefined}>
              <input id="line-price" className="field num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))} />
            </Field>
            {priceChanged && (
              <Field label="เหตุผลที่แก้ราคา" htmlFor="line-reason">
                <textarea id="line-reason" rows={2} className="field" placeholder="เช่น ลูกค้าประจำ, ตกลงราคาหน้างาน" value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            )}
            {err && <p role="alert" className="text-[15px] text-bad">{err}</p>}
          </div>
        )}
      </Sheet>
      <ReasonSheet
        open={removing} danger title={`ลบ "${line.item_name}"`}
        description={isDiscount ? 'ส่วนลดต้องระบุเหตุผลที่ลบ' : header ? 'จะลบทั้งชุดรวมรายการย่อยทั้งหมด' : 'ลบรายการนี้ออกจากใบเสนอราคา (เก็บประวัติไว้ในบันทึกตรวจสอบ)'}
        confirmLabel="ลบรายการ" onClose={() => setRemoving(false)}
        onConfirm={async (r) => { await removeItem(line.id, r); onChanged(); }}
      />
    </>
  );
}

// ===================================================================
// เพิ่มรายการจากแคตตาล็อก
// ===================================================================
function priceRows(prices: ItemPrice[], itemId: string) { return prices.filter((p) => p.item_id === itemId && p.is_active); }

export function AddItemSheet({
  open, jobId, onClose, onAdded,
}: { open: boolean; jobId: string; onClose: () => void; onAdded: () => void }) {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [mainId, setMainId] = useState<string | null>(null);
  const [picked, setPicked] = useState<CatalogItem | null>(null);

  useEffect(() => {
    if (!open) return;
    setPicked(null); setQ('');
    loadCatalog().then((c) => { setCat(c); setMainId((m) => m ?? c.categories.find((x) => !x.parent_id)?.id ?? null); }).catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, [open]);

  const mains = useMemo(() => (cat?.categories ?? []).filter((c) => !c.parent_id && c.is_active), [cat]);
  const needle = q.trim().toLowerCase();

  const groups = useMemo(() => {
    if (!cat) return [];
    const subs = cat.categories.filter((c) => c.parent_id && c.is_active);
    const out: { sub: string; items: CatalogItem[] }[] = [];
    for (const s of subs) {
      if (!needle && s.parent_id !== mainId) continue;
      const items = cat.items.filter((i) => i.category_id === s.id && i.is_active
        && (!needle || i.name.toLowerCase().includes(needle) || i.code.toLowerCase().includes(needle)));
      if (items.length) out.push({ sub: needle ? `${s.name}` : s.name, items });
    }
    return out;
  }, [cat, mainId, needle]);

  return (
    <Sheet open={open} onClose={onClose} title={picked ? 'ตั้งค่ารายการ' : 'เพิ่มรายการ'}>
      {picked && cat ? (
        <ItemConfig
          key={picked.id} jobId={jobId} item={picked} prices={priceRows(cat.prices, picked.id)}
          onBack={() => setPicked(null)} onAdded={() => { setPicked(null); onAdded(); }}
        />
      ) : !cat ? (
        loadErr ? <p role="alert" className="text-bad">{loadErr}</p> : <Spinner />
      ) : (
        <div className="-mx-1">
          <div className="relative px-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-mute" aria-hidden />
            <input type="search" className="field pl-11" placeholder="ค้นหาชื่อหรือรหัส เช่น ล้างตู้แอร์ หรือ AC-CL" aria-label="ค้นหารายการ" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {!needle && (
            <div className="mt-3 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="หมวดหมู่">
              {mains.map((m) => (
                <button key={m.id} role="tab" aria-selected={mainId === m.id} onClick={() => setMainId(m.id)}
                  className={cx('shrink-0 rounded-full border px-4 py-2 text-[14px] font-medium', mainId === m.id ? 'border-gold bg-gold/15 text-gold-hi' : 'border-rule text-dim hover:text-ivory')}>
                  {m.name}
                </button>
              ))}
            </div>
          )}
          {groups.length === 0 ? (
            <Empty title="ไม่พบรายการ" hint="ลองค้นด้วยคำอื่น หรือเลือกหมวดอื่น" />
          ) : (
            <div className="mt-2 space-y-4">
              {groups.map((g) => (
                <div key={g.sub}>
                  <p className="px-1 pb-1 pt-2 text-[13px] font-medium text-mute">{g.sub}</p>
                  <ul className="ledger overflow-hidden rounded-xl border border-rule">
                    {g.items.map((i) => {
                      const rows = priceRows(cat.prices, i.id);
                      const prices = rows.map((r) => r.price);
                      const min = prices.length ? Math.min(...prices) : 0;
                      const max = prices.length ? Math.max(...prices) : 0;
                      const unpriced = i.item_type !== 'bundle' && i.item_type !== 'discount' && max === 0;
                      return (
                        <li key={i.id}>
                          <button type="button" onClick={() => setPicked(i)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-inset">
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium">{i.name}</span>
                              <span className="num block text-[12px] text-mute">{i.code}</span>
                            </span>
                            <span className="shrink-0 text-right text-[14px]">
                              {i.item_type === 'discount' ? <span className="text-warn">ส่วนลด</span>
                                : i.item_type === 'bundle' ? <span className="text-dim">ชุดบริการ</span>
                                : unpriced ? <span className="text-warn">ยังไม่ตั้งราคา</span>
                                : min === max ? <Money v={max} /> : <span className="num text-dim">{fmtMoney(min)} ขึ้นไป</span>}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

function ItemConfig({
  jobId, item, prices, onBack, onAdded,
}: { jobId: string; item: CatalogItem; prices: ItemPrice[]; onBack: () => void; onAdded: () => void }) {
  const isDiscount = item.item_type === 'discount';
  const isBundle = item.item_type === 'bundle';
  const multi = prices.length > 1;
  const positions = useMemo(() => [...new Set(prices.map((p) => p.position).filter(Boolean))] as FilmPosition[], [prices]);
  const sizes = useMemo(() => [...new Set(prices.map((p) => p.vehicle_size).filter(Boolean))] as VehicleSize[], [prices]);
  const [pos, setPos] = useState<FilmPosition | null>(null);
  const [size, setSize] = useState<VehicleSize | null>(null);
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState('');
  const [priceTouched, setPriceTouched] = useState(false);
  const [reason, setReason] = useState('');
  const [attrs, setAttrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const row: ItemPrice | undefined = multi
    ? prices.find((p) => (p.position ?? null) === pos && (p.vehicle_size ?? null) === size)
    : prices[0];
  const needChoice = multi && ((positions.length > 0 && !pos) || (sizes.length > 0 && !size));
  const list = row?.price ?? 0;

  // ราคาเริ่มต้นตามตัวเลือกที่เลือก (จนกว่าผู้ใช้จะพิมพ์ราคาเอง)
  useEffect(() => { if (!priceTouched && !isDiscount) setPrice(row ? String(row.price) : ''); }, [row, priceTouched, isDiscount]);

  const unit = num(price);
  const priceDiffers = !isDiscount && !isBundle && !needChoice && unit !== list;
  const needReason = isDiscount || priceDiffers;
  const defaultReason = list === 0 ? 'ราคาตามที่ตกลงกับลูกค้า (แคตตาล็อกยังไม่ตั้งราคา)' : '';
  useEffect(() => { if (priceDiffers && !reason && defaultReason) setReason(defaultReason); }, [priceDiffers]); // eslint-disable-line react-hooks/exhaustive-deps

  const missingAttr = item.attribute_schema.some((k) => !(attrs[k] ?? '').trim());
  const invalid = needChoice || missingAttr || (needReason && !reason.trim()) || (isDiscount && !(unit > 0)) || (!isBundle && !isDiscount && !row && prices.length > 0);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await addItem({
        jobId, itemId: item.id, priceId: row && multi ? row.id : undefined, qty,
        unitPrice: isBundle ? undefined : isDiscount ? unit : (priceDiffers ? unit : undefined),
        reason: needReason ? reason.trim() : undefined,
        attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, v.trim()])),
      });
      onAdded();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <button type="button" onClick={onBack} className="-ml-2 flex min-h-[40px] items-center gap-1 rounded-lg px-2 text-[14px] text-dim hover:text-ivory">
        <ChevronLeft className="h-4 w-4" aria-hidden />เลือกรายการอื่น
      </button>
      <div>
        <p className="font-display text-xl font-semibold">{item.name}</p>
        <p className="num text-[13px] text-mute">{item.code}  {ITEM_TYPE_LABEL[item.item_type]}</p>
      </div>

      {multi && (
        <div className="space-y-4">
          {positions.length > 0 && (
            <Field label="ตำแหน่งที่ติด">
              <div className="flex flex-wrap gap-2">
                {positions.map((p) => (
                  <button key={p} type="button" aria-pressed={pos === p} onClick={() => { setPos(p); setPriceTouched(false); }}
                    className={cx('min-h-[44px] rounded-lg border px-3.5 text-[15px]', pos === p ? 'border-gold bg-gold/15 text-gold-hi' : 'border-rule bg-inset text-dim')}>{POSITION_LABEL[p]}</button>
                ))}
              </div>
            </Field>
          )}
          {sizes.length > 0 && (
            <Field label="ขนาดรถ">
              <div className="flex flex-wrap gap-2">
                {sizes.map((s) => (
                  <button key={s} type="button" aria-pressed={size === s} onClick={() => { setSize(s); setPriceTouched(false); }}
                    className={cx('min-h-[44px] rounded-lg border px-3.5 text-[15px]', size === s ? 'border-gold bg-gold/15 text-gold-hi' : 'border-rule bg-inset text-dim')}>{SIZE_LABEL[s]}</button>
                ))}
              </div>
            </Field>
          )}
        </div>
      )}

      {item.attribute_schema.length > 0 && (
        <div className="grid grid-cols-1 gap-3">
          {item.attribute_schema.map((k) => (
            <Field key={k} label={k} htmlFor={`attr-${k}`}>
              <input id={`attr-${k}`} className="field" value={attrs[k] ?? ''} onChange={(e) => setAttrs((a) => ({ ...a, [k]: e.target.value }))} />
            </Field>
          ))}
        </div>
      )}

      <Field label="จำนวน">
        <div className="flex items-center gap-3">
          <Button variant="outline" aria-label="ลดจำนวน" onClick={() => setQty((q) => Math.max(1, q - 1))}><Minus className="h-4 w-4" /></Button>
          <span className="num min-w-10 text-center font-display text-xl font-semibold" aria-live="polite">{qty}</span>
          <Button variant="outline" aria-label="เพิ่มจำนวน" onClick={() => setQty((q) => q + 1)}><Plus className="h-4 w-4" /></Button>
        </div>
      </Field>

      {isBundle ? (
        <p className="rounded-xl border border-rule bg-inset px-4 py-3 text-[14px] text-dim">ชุดบริการจะแตกเป็นรายการย่อยตามที่เจ้าของตั้งไว้ในแคตตาล็อก แก้ราคาได้ที่แต่ละรายการย่อย</p>
      ) : (
        <Field label={isDiscount ? 'จำนวนเงินส่วนลดต่อหน่วย (บาท)' : 'ราคาต่อหน่วย (บาท)'} htmlFor="cfg-price"
          hint={!isDiscount && !needChoice ? (list > 0 ? `ราคาในแคตตาล็อก ${fmtMoney(list)}` : 'ราคาในแคตตาล็อกยังเป็น 0 — กรอกราคาที่ตกลงกับลูกค้า') : undefined}>
          <input id="cfg-price" className="field num" inputMode="decimal" placeholder={isDiscount ? 'เช่น 200' : '0'} value={price}
            onChange={(e) => { setPriceTouched(true); setPrice(e.target.value.replace(/[^\d.]/g, '')); }} />
        </Field>
      )}

      {needReason && (
        <Field label={isDiscount ? 'เหตุผลที่ให้ส่วนลด' : 'เหตุผลที่ราคาต่างจากแคตตาล็อก'} htmlFor="cfg-reason">
          <textarea id="cfg-reason" rows={2} className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ระบบบังคับระบุเหตุผลเพื่อเก็บบันทึกตรวจสอบ" />
        </Field>
      )}
      {err && <p role="alert" className="text-[15px] text-bad">{err}</p>}
      <Button className="w-full" onClick={submit} loading={busy} disabled={invalid}>
        เพิ่มลงใบงาน{!isBundle && !isDiscount && unit > 0 ? ` ${fmtMoney(unit * qty)}` : ''}
      </Button>
    </div>
  );
}
