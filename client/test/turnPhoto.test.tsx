import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { canUseCamera, fitWithin, photoChip } from '../src/lib/turnPhoto';
import { PhotoButton } from '../src/session/PhotoButton';

describe('turn photo helpers', () => {
  it('fitWithin scales the longer side down to maxSide and never up', () => {
    expect(fitWithin(3200, 2400, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(1080, 1920, 1600)).toEqual({ width: 900, height: 1600 });
    expect(fitWithin(640, 480, 1600)).toEqual({ width: 640, height: 480 });
    expect(fitWithin(0, 480, 1600)).toEqual({ width: 0, height: 0 });
  });

  it('camera only in a secure context with getUserMedia; otherwise the file/capture fallback', () => {
    expect(canUseCamera({ mediaDevices: { getUserMedia: () => undefined } }, true)).toBe(true);
    expect(canUseCamera({ mediaDevices: { getUserMedia: () => undefined } }, false)).toBe(false);
    expect(canUseCamera({}, true)).toBe(false);
    expect(canUseCamera(undefined, true)).toBe(false);
  });

  it('chip: uploading > error > pending > just sent > none', () => {
    const base = { pending: false, uploading: false, error: '', justSent: false };
    expect(photoChip(base)).toEqual({ kind: 'none' });
    expect(photoChip({ ...base, pending: true })).toEqual({ kind: 'pending' });
    expect(photoChip({ ...base, pending: true, uploading: true })).toEqual({ kind: 'uploading' });
    expect(photoChip({ ...base, error: 'photo too large' })).toEqual({ kind: 'error', message: 'photo too large' });
    expect(photoChip({ ...base, justSent: true })).toEqual({ kind: 'sent' });
  });
});

describe('PhotoButton', () => {
  const conn = {} as never;
  it('shows the camera button; a pending photo shows the chip with remove', () => {
    const idle = renderToStaticMarkup(createElement(PhotoButton, { conn, sessionId: 1n, pending: false }));
    expect(idle).toContain('data-testid="photo-button"');
    expect(idle).not.toContain('photo-chip');
    const pending = renderToStaticMarkup(createElement(PhotoButton, { conn, sessionId: 1n, pending: true }));
    expect(pending).toContain('Will be sent with your next answer');
    expect(pending).toContain('data-testid="photo-remove"');
  });
});
