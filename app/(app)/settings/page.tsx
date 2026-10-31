'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BookOpen, ChevronRight, LogOut, PackageOpen } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { useToast } from '@/components/providers';
import { Button, Field, Skeleton } from '@/components/ui';
import { listAudit, listUsers, saveSettings } from '@/lib/api';
import { useAuth, useSession } from '@/lib/auth';
import { cx, fmtDateTime } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { ROLE_LABEL } from '@/lib/labels';

const TABLE_LABEL: Record<string, string> = {
  job_orders: 'ใบงาน', job_items: 'รายการในใบงาน', payments: 'การรับเงิน', receipts: 'ใบเสร็จ', warranties: 'ใบรับประกัน',
  condition_checks: 'เช็คสภาพ', condition_check_photos: 'รูปเช็คสภาพ', catalog_items: 'แคตตาล็อก', item_prices: 'ราคา',
  catalog_categories: 'หมวดหมู่', branch_settings: 'ตั้งค่าร้าน', customers: 'ลูกค้า', vehicles: 'รถ', users: 'ผู้ใช้',
  condition_templates: 'แบบฟอร์มเช็คสภาพ', catalog_bundle_components: 'รายการย่อยชุดบริการ', branches: 'สาขา',
};
const ACTION_LABEL: Record<string, string> = { INSERT: 'เพิ่ม', UPDATE: 'แก้ไข', DELETE: 'ลบ' };

export default function SettingsPage() {
  const { signOut, refreshSettings } = useAuth();
  const { profile, settings, isOwner } = useSession();
  const toast = useToast();

  const [vat, setVat] = useState(false);
  const [vatRate, setVatRate] = useState('7');
  const [cap, setCap] = useState('0');
  const [shop, setShop] = useState({ shop_name: '', shop_address: '', shop_phone: '', tax_id: '', receipt_footer: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setVat(settings.vat_enabled); setVatRate(String(settings.vat_rate)); setCap(String(settings.discount_cap_percent));
    setShop({
      shop_name: settings.shop_name, shop_address: settings.shop_address ?? '', shop_phone: settings.shop_phone ?? '',
      tax_id: settings.tax_id ?? '', receipt_footer: settings.receipt_footer ?? '',
    });
  }, [settings]);

  const users = useAsync(async () => (isOwner ? listUsers() : []), [isOwner]);
  const audit = useAsync(async () => (isOwner ? listAudit(40) : []), [isOwner]);
  const nameOf = (id: string | null) => (id ? users.data?.find((u) => u.id === id)?.full_name ?? 'ไม่ทราบ' : 'ระบบ');

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await saveSettings(profile.branch_id, {
        vat_enabled: vat, vat_rate: Number(vatRate), discount_cap_percent: Number(cap),
        shop_name: shop.shop_name.trim(), shop_address: shop.shop_address.trim() || null, shop_phone: shop.shop_phone.trim() || null,
        tax_id: shop.tax_id.trim() || null, receipt_footer: shop.receipt_footer.trim() || null,
      });
      await refreshSettings();
      toast.ok('บันทึกการตั้งค่าแล้ว');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title="ตั้งค่า" subtitle={settings?.shop_name} />
      <div className="space-y-8 px-4 pb-8 pt-5">
        <section className="flex items-center justify-between gap-4" aria-label="บัญชีของฉัน">
          <div>
            <p className="font-display text-[19px] font-semibold">{profile.full_name}</p>
            <p className="text-[14px] text-dim">{ROLE_LABEL[profile.role]}</p>
          </div>
          <Button variant="outline" onClick={() => void signOut()}><LogOut className="h-4 w-4" aria-hidden />ออกจากระบบ</Button>
        </section>
        {profile.role !== 'technician' && (
          <Link href="/catalog" data-testid="settings-catalog"
            className="flex min-h-tap items-center gap-3 rounded-xl border border-rule bg-raised px-4 py-3 text-[16px] font-medium hover:border-gold/50 lg:hidden">
            <BookOpen className="h-5 w-5 text-gold-hi" aria-hidden />
            <span className="flex-1">แคตตาล็อกสินค้าและบริการ</span>
            <ChevronRight className="h-5 w-5 text-mute" aria-hidden />
          </Link>
        )}
        {isOwner && (
          <Link href="/requisitions" data-testid="settings-requisitions"
            className="flex min-h-tap items-center gap-3 rounded-xl border border-rule bg-raised px-4 py-3 text-[16px] font-medium hover:border-gold/50 lg:hidden">
            <PackageOpen className="h-5 w-5 text-gold-hi" aria-hidden />
            <span className="flex-1">เบิกอะไหล่</span>
            <ChevronRight className="h-5 w-5 text-mute" aria-hidden />
          </Link>
        )}

        {isOwner && settings && (
          <>
            <section className="space-y-4" aria-labelledby="set-money">
              <h2 id="set-money" className="section-title">ภาษีและส่วนลด</h2>
              <button type="button" role="switch" aria-checked={vat} onClick={() => setVat((v) => !v)}
                className={cx('flex min-h-tap w-full items-center justify-between rounded-xl border px-4 text-[15px]', vat ? 'border-gold/50 bg-gold/10 text-gold-hi' : 'border-rule bg-inset text-dim')}>
                <span>{vat ? 'แสดง VAT ในใบงาน (ราคารวม VAT แล้ว)' : 'ไม่แสดง VAT ในใบงาน'}</span>
              </button>
              <div className="grid grid-cols-2 gap-3">
                <Field label="อัตรา VAT (%)" htmlFor="s-vat"><input id="s-vat" className="field num" inputMode="decimal" value={vatRate} onChange={(e) => setVatRate(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
                <Field label="เพดานส่วนลด (% ของยอดรวม)" htmlFor="s-cap" hint="เกินเพดานต้องให้เจ้าของอนุมัติ"><input id="s-cap" className="field num" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
              </div>
              <p className="hint">ราคาในแคตตาล็อกและใบงานรวม VAT แล้ว — ระบบไม่บวก VAT เพิ่ม แต่แยกยอด VAT ออกมาแสดงในใบเสร็จและรายงาน การเปลี่ยนมีผลกับใบงานที่เปิดหลังจากนี้ ใบงานเดิมไม่เปลี่ยน</p>
            </section>

            <section className="space-y-4" aria-labelledby="set-shop">
              <h2 id="set-shop" className="section-title">ข้อมูลบนใบเสร็จ</h2>
              <Field label="ชื่อร้าน" htmlFor="s-name"><input id="s-name" className="field" value={shop.shop_name} onChange={(e) => setShop((s) => ({ ...s, shop_name: e.target.value }))} /></Field>
              <Field label="ที่อยู่" htmlFor="s-addr"><textarea id="s-addr" rows={2} className="field" value={shop.shop_address} onChange={(e) => setShop((s) => ({ ...s, shop_address: e.target.value }))} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="เบอร์โทร" htmlFor="s-phone"><input id="s-phone" className="field" inputMode="tel" value={shop.shop_phone} onChange={(e) => setShop((s) => ({ ...s, shop_phone: e.target.value }))} /></Field>
                <Field label="เลขประจำตัวผู้เสียภาษี" htmlFor="s-tax"><input id="s-tax" className="field num" inputMode="numeric" value={shop.tax_id} onChange={(e) => setShop((s) => ({ ...s, tax_id: e.target.value }))} /></Field>
              </div>
              <Field label="ข้อความท้ายใบเสร็จ" htmlFor="s-foot"><input id="s-foot" className="field" value={shop.receipt_footer} onChange={(e) => setShop((s) => ({ ...s, receipt_footer: e.target.value }))} /></Field>
              {err && <p role="alert" className="text-[15px] text-bad">{err}</p>}
              <Button className="w-full" onClick={save} loading={busy} disabled={!shop.shop_name.trim()}>บันทึกการตั้งค่า</Button>
            </section>

            <section aria-labelledby="set-users">
              <h2 id="set-users" className="section-title mb-1">ผู้ใช้งานในร้าน</h2>
              <p className="mb-2 text-[13px] text-mute">เพิ่มบัญชีใหม่ที่ Supabase → Authentication แล้วเพิ่มแถวในตาราง users พร้อมกำหนดบทบาท</p>
              {users.loading ? <Skeleton className="h-24" /> : (
                <ul className="ledger border-y border-rule">
                  {(users.data ?? []).map((u) => (
                    <li key={u.id} className="flex items-center justify-between px-1 py-2.5">
                      <span className={cx(!u.is_active && 'text-mute line-through')}>{u.full_name}</span>
                      <span className="text-[14px] text-dim">{ROLE_LABEL[u.role]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="set-audit">
              <h2 id="set-audit" className="section-title mb-1">บันทึกตรวจสอบล่าสุด</h2>
              <p className="mb-2 text-[13px] text-mute">ทุกการแก้ไขราคา ส่วนลด void และย้อนสถานะ ถูกบันทึกพร้อมเหตุผลและผู้ทำรายการ ลบหรือแก้ย้อนหลังไม่ได้</p>
              {audit.loading ? <Skeleton className="h-40" /> : (
                <ul className="ledger border-y border-rule">
                  {(audit.data ?? []).map((a) => (
                    <li key={a.id} className="py-2.5 text-[14px]">
                      <p><span className="font-medium">{ACTION_LABEL[a.action] ?? a.action}</span> {TABLE_LABEL[a.table_name] ?? a.table_name}{a.reason ? <span className="text-gold-hi">  {a.reason}</span> : null}</p>
                      <p className="text-[12px] text-mute">{nameOf(a.actor)}  {fmtDateTime(a.created_at)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <p className="text-center text-[12px] text-mute">นำโชค POS เฟส 1 ใบงาน เช็คสภาพ เสนอราคา รับชำระ ใบเสร็จ</p>
      </div>
    </>
  );
}
