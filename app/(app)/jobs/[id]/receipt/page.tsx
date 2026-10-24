'use client';
import { useParams } from 'next/navigation';
import { Printer } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { Button, Empty, ErrorNote, Skeleton } from '@/components/ui';
import { loadReceipt } from '@/lib/api';
import { fmtDate, fmtDateLong, fmtDateTime, fmtMoney, num, vehicleLabel } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { METHOD_LABEL } from '@/lib/labels';

export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const st = useAsync(() => loadReceipt(id), [id]);

  if (st.loading) return <><PageHeader title="ใบเสร็จ" back={`/jobs/${id}`} /><div className="p-4"><Skeleton className="h-96" /></div></>;
  if (st.error) return <><PageHeader title="ใบเสร็จ" back={`/jobs/${id}`} /><ErrorNote message={st.error} onRetry={() => void st.reload()} /></>;
  const r = st.data?.receipt;
  if (!r) return <><PageHeader title="ใบเสร็จ" back={`/jobs/${id}`} /><Empty title="ยังไม่มีใบเสร็จ" hint="ใบเสร็จจะออกเมื่อปิดงานหลังรับเงินครบ" /></>;
  const s = r.snapshot;
  const warranties = (st.data?.warranties ?? []).filter((w) => !w.voided_at);

  return (
    <>
      <PageHeader
        title={r.receipt_no} subtitle={s.job.job_no} back={`/jobs/${id}`}
        right={<Button small variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" aria-hidden />พิมพ์</Button>}
      />
      <div className="space-y-6 px-4 py-5">
        {r.voided_at && <p role="alert" className="no-print rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-[15px] text-bad">ใบเสร็จนี้ถูก void แล้ว ไม่ใช่เอกสารที่ใช้ได้</p>}

        {/* ใบเสร็จ: กระดาษสีงาช้างบนพื้นดำ — พิมพ์ออกมาเป็นขาวดำปกติ */}
        <article className="print-sheet mx-auto max-w-md rounded-sm bg-[#f6f1e4] p-6 text-[#17130a] shadow-[0_18px_50px_-20px_rgba(210,166,64,0.4)]" aria-label="ใบเสร็จรับเงิน">
          <header className="border-b border-[#17130a]/20 pb-4 text-center">
            <h2 className="font-display text-2xl font-bold">{s.shop.name}</h2>
            {s.shop.address && <p className="text-[13px]">{s.shop.address}</p>}
            <p className="text-[13px]">{[s.shop.phone ? `โทร ${s.shop.phone}` : null, s.shop.tax_id ? `เลขประจำตัวผู้เสียภาษี ${s.shop.tax_id}` : null].filter(Boolean).join('   ')}</p>
            <p className="mt-3 font-display text-lg font-semibold">ใบเสร็จรับเงิน</p>
          </header>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 border-b border-[#17130a]/20 py-3 text-[14px]">
            <dt>เลขที่</dt><dd className="num text-right">{r.receipt_no}</dd>
            <dt>วันที่</dt><dd className="text-right">{fmtDateLong(r.issued_at)}</dd>
            <dt>ใบงาน</dt><dd className="num text-right">{s.job.job_no}</dd>
            <dt>ลูกค้า</dt><dd className="text-right">{s.customer.name}{s.customer.phone ? ` โทร ${s.customer.phone}` : ''}</dd>
            <dt>รถ</dt><dd className="text-right">{s.vehicle.plate}{s.vehicle.province ? ` ${s.vehicle.province}` : ''}  {vehicleLabel(s.vehicle)}</dd>
            {s.job.delivered_on && <><dt>วันที่ส่งมอบ</dt><dd className="text-right">{fmtDateLong(`${s.job.delivered_on}T12:00:00+07:00`)}</dd></>}
            {s.job.odometer != null && <><dt>เลขไมล์</dt><dd className="num text-right">{s.job.odometer.toLocaleString('th-TH')} กม.</dd></>}
          </dl>

          <table className="w-full border-b border-[#17130a]/20 text-[14px]">
            <caption className="sr-only">รายการ</caption>
            <thead>
              <tr className="border-b border-[#17130a]/20 text-left text-[13px]">
                <th scope="col" className="py-2 font-semibold">รายการ</th>
                <th scope="col" className="py-2 text-right font-semibold">จำนวน</th>
                <th scope="col" className="py-2 text-right font-semibold">รวม</th>
              </tr>
            </thead>
            <tbody>
              {s.lines.map((l, i) => (
                <tr key={i} className="align-top">
                  <td className={`py-1.5 pr-2 ${l.is_child ? 'pl-4 text-[13px]' : ''} ${l.is_header ? 'font-semibold' : ''}`}>
                    {l.name}
                    {(l.variant || Object.keys(l.attributes ?? {}).length > 0) && (
                      <span className="block text-[12px] opacity-70">{[l.variant, ...Object.entries(l.attributes ?? {}).map(([k, v]) => `${k} ${v}`)].filter(Boolean).join('  ')}</span>
                    )}
                  </td>
                  <td className="num py-1.5 text-right">{l.is_header ? '' : `${num(l.qty)} x ${fmtMoney(l.unit_price)}`}</td>
                  <td className="num py-1.5 text-right">{l.is_header ? '' : fmtMoney(l.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="space-y-1 border-b border-[#17130a]/20 py-3 text-[14px]">
            <div className="flex justify-between"><dt>รวมรายการ</dt><dd className="num">{fmtMoney(r.subtotal)}</dd></div>
            {num(r.discount_total) > 0 && <div className="flex justify-between"><dt>ส่วนลด</dt><dd className="num">{fmtMoney(-num(r.discount_total))}</dd></div>}
            <div className="flex items-baseline justify-between pt-1 font-display text-xl font-bold"><dt>ยอดสุทธิ{s.totals.vat_enabled ? ' (รวม VAT แล้ว)' : ''}</dt><dd className="num" data-testid="receipt-total">{fmtMoney(r.grand_total)}</dd></div>
            {s.totals.vat_enabled && (
              <div className="space-y-0.5 pt-1 text-[13px] opacity-80" data-testid="receipt-vat">
                <div className="flex justify-between"><dt>ราคาก่อน VAT</dt><dd className="num">{fmtMoney(s.totals.ex_vat ?? num(r.grand_total) - num(r.vat_amount), { fixed: true })}</dd></div>
                <div className="flex justify-between"><dt>ภาษีมูลค่าเพิ่ม {num(s.totals.vat_rate)}% (รวมอยู่ในราคาแล้ว)</dt><dd className="num">{fmtMoney(r.vat_amount, { fixed: true })}</dd></div>
              </div>
            )}
          </dl>

          <section className="py-3 text-[14px]" aria-label="การรับเงิน">
            <p className="mb-1 font-semibold">รับเงินแล้ว</p>
            {s.payments.map((p, i) => (
              <div key={i} className="flex justify-between">
                <span>{p.kind === 'deposit' ? 'มัดจำ' : 'ชำระ'} {METHOD_LABEL[p.method]} <span className="text-[12px] opacity-70">{fmtDateTime(p.received_at)}</span></span>
                <span className="num">{fmtMoney(p.amount)}</span>
              </div>
            ))}
            {(s.refunds ?? []).map((rf, i) => (
              <div key={`rf${i}`} className="flex justify-between" data-testid="receipt-refund">
                <span>คืนเงิน {METHOD_LABEL[rf.method]} <span className="text-[12px] opacity-70">{fmtDateTime(rf.refunded_at)} · {rf.reason}</span></span>
                <span className="num">{fmtMoney(-num(rf.amount))}</span>
              </div>
            ))}
            {(s.refunds ?? []).length > 0 && (
              <div className="mt-1 flex justify-between border-t border-[#17130a]/20 pt-1 font-semibold"><span>รับสุทธิ</span><span className="num">{fmtMoney(s.totals.paid_total)}</span></div>
            )}
          </section>
          {s.shop.footer && <p className="border-t border-[#17130a]/20 pt-3 text-center text-[13px]">{s.shop.footer}</p>}
        </article>

        {warranties.length > 0 && (
          <section className="mx-auto max-w-md space-y-3" aria-label="ใบรับประกัน">
            <h2 className="section-title no-print">ใบรับประกัน</h2>
            {warranties.map((w) => (
              <article key={w.id} className="print-sheet break-before-page rounded-sm bg-[#f6f1e4] p-5 text-[#17130a]">
                <p className="font-display text-lg font-bold">ใบรับประกันสินค้าและบริการ</p>
                <p className="text-[13px]">{s.shop.name}</p>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[14px]">
                  <dt>เลขที่</dt><dd className="num text-right">{w.warranty_no}</dd>
                  <dt>รายการ</dt><dd className="text-right">{w.item_name}{w.variant_label ? ` (${w.variant_label})` : ''}</dd>
                  {Object.entries(w.attributes ?? {}).map(([k, v]) => <div key={k} className="contents"><dt>{k}</dt><dd className="text-right">{v}</dd></div>)}
                  <dt>รถ</dt><dd className="text-right">{s.vehicle.plate}</dd>
                  <dt>ระยะรับประกัน</dt><dd className="num text-right">{w.warranty_months} เดือน</dd>
                  <dt>เริ่มวันที่</dt><dd className="text-right">{fmtDate(w.starts_on)}</dd>
                  <dt>สิ้นสุดวันที่</dt><dd className="text-right font-semibold">{fmtDate(w.ends_on)}</dd>
                </dl>
              </article>
            ))}
          </section>
        )}
      </div>
    </>
  );
}
