import type { Config } from 'tailwindcss';

// โทนสี "ทองคำเปลวบนพื้นลงรัก" — ทองใช้เป็นวัสดุเฉพาะจุด (ป้ายทะเบียน, ปุ่มหลัก, ตัวเลขเงิน, สถานะปัจจุบัน)
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        lacquer: '#0A0907', // พื้นหลังหลัก
        raised: '#13110D',  // แผ่น/เมนู
        inset: '#1B1812',   // ช่องกรอก
        rule: '#2C2619',    // เส้นคั่น
        gold: { DEFAULT: '#D2A640', hi: '#F0D58A', lo: '#8F6B1F', dim: '#3A2E12' },
        ivory: '#F3EDDF',
        dim: '#B3A98F',
        mute: '#8C826B',
        ok: '#6FBF8B',
        warn: '#E8893F',
        bad: '#E86A5F',
      },
      fontFamily: {
        display: ['Prompt', 'IBM Plex Sans Thai', 'system-ui', 'sans-serif'],
        sans: ['"IBM Plex Sans Thai"', 'Prompt', 'system-ui', 'sans-serif'],
      },
      borderRadius: { plate: '10px' },
      minHeight: { tap: '48px' },
      keyframes: {
        sheetUp: { from: { transform: 'translateY(24px)', opacity: '0' }, to: { transform: 'none', opacity: '1' } },
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        glint: { '0%': { transform: 'translateX(-120%)' }, '100%': { transform: 'translateX(220%)' } },
      },
      animation: {
        sheetUp: 'sheetUp .22s ease-out',
        fadeIn: 'fadeIn .18s ease-out',
        glint: 'glint 1.6s .35s ease-in-out 1 both',
      },
    },
  },
  plugins: [],
};
export default config;
