// Turn photo ("take a picture at any time"): helpers for PhotoButton, kept DOM-light for tests.
import { compressPhoto, type CompressedPhoto } from './photo';

/** Size of a frame scaled down so its longer side is at most `maxSide` (never scaled up). */
export function fitWithin(w: number, h: number, maxSide: number): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  const k = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** A live camera preview is possible (secure context + getUserMedia); else the file/capture input. */
export function canUseCamera(nav: { mediaDevices?: { getUserMedia?: unknown } } | undefined, secure: boolean): boolean {
  return secure && typeof nav?.mediaDevices?.getUserMedia === 'function';
}

export type PhotoChip = { kind: 'none' } | { kind: 'uploading' } | { kind: 'pending' } | { kind: 'sent' } | { kind: 'error'; message: string };

/** What the chip next to the camera button shows. `pending` is the module's session.pendingPhoto;
 *  `justSent` = it was pending a moment ago and went out with a turn. */
export function photoChip(s: { pending: boolean; uploading: boolean; error: string; justSent: boolean }): PhotoChip {
  if (s.uploading) return { kind: 'uploading' };
  if (s.error) return { kind: 'error', message: s.error };
  if (s.pending) return { kind: 'pending' };
  if (s.justSent) return { kind: 'sent' };
  return { kind: 'none' };
}

/** Grabs the current video frame (scaled to maxSide) and compresses it to a JPEG <= maxBytes. */
export async function captureFrame(video: HTMLVideoElement, maxBytes: number, maxSide: number): Promise<CompressedPhoto> {
  const { width, height } = fitWithin(video.videoWidth, video.videoHeight, maxSide);
  if (!width) throw new Error('The camera is not ready yet');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Canvas not available');
  g.drawImage(video, 0, 0, width, height);
  const raw = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.9));
  if (!raw) throw new Error('Could not take the picture');
  return compressPhoto(raw, maxBytes, maxSide);
}

export const photoBlob = (p: CompressedPhoto): Blob => new Blob([p.data as BlobPart], { type: p.mime });
