// Service worker แบบเรียบง่าย: ทำให้ติดตั้งเป็นแอปได้ และแคชไฟล์ static ของ Next เท่านั้น
// ไม่แคชข้อมูล/คำขอไป Supabase เด็ดขาด (ข้อมูลเงินต้องสดและตรวจสิทธิ์เสมอ) — แอปยังต้องใช้อินเทอร์เน็ตตอนทำงาน
const CACHE = 'namchok-static-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/_next/static/') && !url.pathname.startsWith('/icons/')) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
  );
});
