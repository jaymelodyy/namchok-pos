'use client';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Eraser } from 'lucide-react';
import { Button } from './ui';

export interface SignaturePadHandle {
  isEmpty: () => boolean;
  toBlob: () => Promise<Blob>;
  clear: () => void;
}

/** ช่องเซ็นชื่อ: เซ็นด้วยนิ้ว/ปากกา (pointer events) ส่งออกเป็น PNG พื้นขาวหมึกดำ ให้ชัดเมื่อพิมพ์ */
export const SignaturePad = forwardRef<SignaturePadHandle, { onChange?: (hasInk: boolean) => void; height?: number }>(
  function SignaturePad({ onChange, height = 190 }, ref) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const drawing = useRef(false);
    const last = useRef<{ x: number; y: number } | null>(null);
    const ink = useRef(false);
    const [has, setHas] = useState(false);

    const setup = useCallback(() => {
      const c = canvas.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      c.width = Math.round(w * dpr);
      c.height = Math.round(height * dpr);
      const ctx = c.getContext('2d')!;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, height);
      ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111111';
      ink.current = false; setHas(false); onChange?.(false);
    }, [height, onChange]);

    useEffect(() => { setup(); }, [setup]);

    const pos = (e: React.PointerEvent) => {
      const r = canvas.current!.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: React.PointerEvent) => {
      canvas.current!.setPointerCapture(e.pointerId);
      drawing.current = true; last.current = pos(e);
      const ctx = canvas.current!.getContext('2d')!;
      ctx.beginPath(); ctx.arc(last.current.x, last.current.y, 1.2, 0, Math.PI * 2); ctx.fillStyle = '#111'; ctx.fill();
    };
    const move = (e: React.PointerEvent) => {
      if (!drawing.current || !last.current) return;
      const p = pos(e);
      const ctx = canvas.current!.getContext('2d')!;
      ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last.current = p;
      if (!ink.current) { ink.current = true; setHas(true); onChange?.(true); }
    };
    const up = () => { drawing.current = false; last.current = null; };

    useImperativeHandle(ref, () => ({
      isEmpty: () => !ink.current,
      clear: setup,
      toBlob: () => new Promise<Blob>((res, rej) => canvas.current!.toBlob((b) => (b ? res(b) : rej(new Error('สร้างรูปลายเซ็นไม่สำเร็จ'))), 'image/png')),
    }), [setup]);

    return (
      <div>
        <div className="overflow-hidden rounded-xl border border-gold/40 bg-white">
          <canvas
            ref={canvas} role="img" aria-label="พื้นที่เซ็นชื่อลูกค้า"
            className="block w-full touch-none" style={{ height }}
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          />
        </div>
        <div className="mt-2 flex items-center justify-between">
          <p className="text-[13px] text-mute">{has ? 'เซ็นแล้ว' : 'ให้ลูกค้าเซ็นในกรอบด้านบน'}</p>
          <Button variant="ghost" small onClick={setup} disabled={!has}><Eraser className="h-4 w-4" aria-hidden />ล้างลายเซ็น</Button>
        </div>
      </div>
    );
  },
);
