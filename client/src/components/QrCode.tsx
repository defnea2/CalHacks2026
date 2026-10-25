// QR code as SVG (qrcode-generator, no runtime dependencies). Used for sign-in code links.
import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

export function QrCode({ text, size = 128 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
      return { d, n: n + 4 };
    } catch {
      return null;
    }
  }, [text]);
  if (!path) return null;
  return (
    <svg data-testid="qr-code" width={size} height={size} viewBox={`0 0 ${path.n} ${path.n}`} role="img" aria-label="QR code with the sign-in link" shapeRendering="crispEdges">
      <rect width={path.n} height={path.n} fill="#fff" />
      <path d={path.d} fill="#1d2b25" />
    </svg>
  );
}
