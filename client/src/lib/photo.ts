// Task photo: compressed in the browser via canvas to at most `maxBytes` (spec: <= 1 MB).

export interface CompressedPhoto {
  mime: string;
  data: Uint8Array;
  width: number;
  height: number;
}

async function loadImage(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

export async function compressPhoto(file: Blob, maxBytes: number, maxSide: number): Promise<CompressedPhoto> {
  const img = await loadImage(file);
  let scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  for (let attempt = 0; attempt < 8; attempt++) {
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not available');
    ctx.drawImage(img, 0, 0, w, h);
    for (const q of [0.85, 0.72, 0.6, 0.45]) {
      const blob = await toBlob(canvas, 'image/jpeg', q);
      if (blob && blob.size <= maxBytes) {
        return { mime: 'image/jpeg', data: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
      }
    }
    scale *= 0.7;
  }
  throw new Error('Could not compress the photo below the size limit');
}
