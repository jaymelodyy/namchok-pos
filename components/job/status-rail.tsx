import { cx } from '@/lib/format';
import { STATUS_FLOW, STATUS_LABEL } from '@/lib/labels';
import type { JobStatus } from '@/lib/types';

/** แถบขั้นตอนของใบงาน: 9 ช่อง เติมทองตามขั้นที่ผ่านแล้ว (ลำดับขั้นจริง จึงมีเลขขั้นได้) */
export function StatusRail({ status }: { status: JobStatus }) {
  const idx = STATUS_FLOW.indexOf(status);
  const cancelled = status === 'cancelled';
  const next = idx >= 0 && idx < STATUS_FLOW.length - 1 ? STATUS_FLOW[idx + 1] : null;
  return (
    <div aria-label={`สถานะใบงาน ${STATUS_LABEL[status]}`}>
      <div className="flex gap-1" aria-hidden>
        {STATUS_FLOW.map((s, i) => (
          <span
            key={s}
            className={cx(
              'h-1.5 flex-1 rounded-full',
              cancelled ? 'bg-bad/30' : i < idx ? 'bg-gold-lo' : i === idx ? 'bg-gold-hi' : 'bg-rule',
            )}
          />
        ))}
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <p className={cx('font-display text-[17px] font-semibold', cancelled ? 'text-bad' : status === 'closed' ? 'text-ok' : 'text-gold-hi')}>
          {STATUS_LABEL[status]}
        </p>
        {idx >= 0 && <p className="num text-[13px] text-mute">{next ? `ถัดไป ${STATUS_LABEL[next]}` : 'เสร็จสิ้น'}</p>}
        {status === 'booked' && <p className="text-[13px] text-mute">รอลูกค้านำรถมา</p>}
      </div>
    </div>
  );
}
