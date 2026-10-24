/** ย่อรูปจากกล้องมือถือก่อนอัปโหลด (ประหยัดเน็ต/พื้นที่) ถ้าถอดรหัสรูปไม่ได้ (เช่น HEIC บางเบราว์เซอร์) ส่งไฟล์เดิม */
export async function compressImage(file: File, maxSide = 1600, quality = 0.8): Promise<{ blob: Blob; type: string; ext: string }> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob) throw new Error('toBlob failed');
    return { blob, type: 'image/jpeg', ext: 'jpg' };
  } catch {
    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : file.type.includes('hei') ? 'heic' : 'jpg';
    return { blob: file, type: file.type || 'image/jpeg', ext };
  }
}
