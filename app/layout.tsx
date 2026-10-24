import type { Metadata, Viewport } from 'next';
import '@fontsource/prompt/500.css';
import '@fontsource/prompt/600.css';
import '@fontsource/prompt/700.css';
import '@fontsource/ibm-plex-sans-thai/400.css';
import '@fontsource/ibm-plex-sans-thai/500.css';
import '@fontsource/ibm-plex-sans-thai/600.css';
import './globals.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: 'นำโชคออโต้แอร์ ระบบหน้าร้าน',
  description: 'เปิดใบงาน เช็คสภาพรถ เสนอราคา รับชำระ และออกใบเสร็จ สำหรับร้านแอร์ ฟิล์ม และแบตเตอรี่รถยนต์',
  applicationName: 'นำโชค POS',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'นำโชค POS', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  themeColor: '#0A0907',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
