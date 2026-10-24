/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false, // ซ่อนปุ่ม N ของ dev server (ไม่มีผลกับ production)
};
export default nextConfig;
