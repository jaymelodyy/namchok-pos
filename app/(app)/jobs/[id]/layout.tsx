'use client';
// จอใหญ่ (xl ขึ้นไป) สำหรับเจ้าของ/แอดมิน: รายการใบงานที่ยังไม่ปิดอยู่คอลัมน์ซ้าย + รายละเอียดใบงานคอลัมน์ขวา
// เปลี่ยนงานได้โดยไม่ต้องกลับไปหน้าบอร์ด ; มือถือ/แท็บเล็ต และหน้าใบเสร็จ/เช็คสภาพ แสดงแบบเดิม
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { JobSideList } from '@/components/job-side-list';
import { useSession } from '@/lib/auth';
import { useMediaQuery } from '@/lib/hooks';

export default function JobDetailLayout({ children }: { children: ReactNode }) {
  const { role } = useSession();
  const pathname = usePathname();
  // ไม่ mount รายการด้านข้างบนจอเล็ก: ไม่โหลดข้อมูลเกิน และไม่มีข้อความซ่อนซ้ำในหน้า
  const wide = useMediaQuery('(min-width: 1280px)');
  const split = (role === 'owner' || role === 'admin') && /^\/jobs\/[^/]+$/.test(pathname) && wide;
  if (!split) return <>{children}</>;
  return (
    <div className="xl:grid xl:grid-cols-[22rem_minmax(0,1fr)] xl:[--side:22rem]">
      <JobSideList currentPath={pathname} />
      <div className="min-w-0 xl:mx-auto xl:w-full xl:max-w-3xl">{children}</div>
    </div>
  );
}
