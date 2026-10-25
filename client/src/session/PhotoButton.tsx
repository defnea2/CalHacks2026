// "Take a picture at any time": camera button + modal (live preview, capture, retake; file /
// `capture` input when there is no webcam) + chip with the pending photo. The photo is uploaded
// with attachImage (private turn_image, <= 1 MB JPEG) and the module sends it with the learner's
// next closed turn (session.pendingPhoto goes false). Self-contained: SessionView renders it once.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DbConnection } from '../module_bindings';
import { callReducer } from '../stdb/connection';
import { APP_CONFIG } from '../app-config';
import { compressPhoto, type CompressedPhoto } from '../lib/photo';
import { canUseCamera, captureFrame, photoBlob, photoChip } from '../lib/turnPhoto';
import './photo.css';

type Mode = 'closed' | 'starting' | 'live' | 'review' | 'fallback';

export function PhotoButton({ conn, sessionId, pending }: { conn: DbConnection; sessionId: bigint; pending: boolean }) {
  const [mode, setMode] = useState<Mode>('closed');
  const [shot, setShot] = useState<{ photo: CompressedPhoto; url: string } | null>(null);
  const [thumb, setThumb] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [justSent, setJustSent] = useState(false);
  const [camError, setCamError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const wasPending = useRef(pending);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    setCamError('');
    if (!canUseCamera(navigator, window.isSecureContext)) return setMode('fallback');
    setMode('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      streamRef.current = stream;
      setMode('live');
    } catch (e) {
      setCamError(e instanceof Error && e.name === 'NotAllowedError' ? 'The camera is blocked. You can pick a picture instead.' : 'No camera found. You can pick a picture instead.');
      setMode('fallback');
    }
  }, []);

  // Attach the stream once the <video> exists.
  useEffect(() => {
    const v = videoRef.current;
    if (mode === 'live' && v && streamRef.current && v.srcObject !== streamRef.current) {
      v.srcObject = streamRef.current;
      void v.play().catch(() => undefined);
    }
  }, [mode]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const dropThumb = useCallback(() => setThumb(prev => (prev && URL.revokeObjectURL(prev), '')), []);

  // The module bound the pending photo to a turn: show "sent" for a moment, then drop the thumbnail.
  useEffect(() => {
    const was = wasPending.current;
    wasPending.current = pending;
    if (!was || pending) return;
    setJustSent(true);
    const t = setTimeout(() => {
      setJustSent(false);
      dropThumb();
    }, 4000);
    return () => clearTimeout(t);
  }, [pending, dropThumb]);

  const close = () => {
    stopCamera();
    if (shot) URL.revokeObjectURL(shot.url);
    setShot(null);
    setMode('closed');
  };

  const review = (photo: CompressedPhoto) => {
    if (shot) URL.revokeObjectURL(shot.url);
    setShot({ photo, url: URL.createObjectURL(photoBlob(photo)) });
    setMode('review');
  };

  const capture = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      review(await captureFrame(v, APP_CONFIG.photoMaxBytes, APP_CONFIG.photoMaxSide));
      stopCamera();
    } catch (e) {
      setCamError(e instanceof Error ? e.message : String(e));
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      review(await compressPhoto(f, APP_CONFIG.photoMaxBytes, APP_CONFIG.photoMaxSide));
    } catch (e) {
      setCamError(e instanceof Error ? e.message : String(e));
    }
  };

  const send = async () => {
    if (!shot) return;
    const { photo, url } = shot;
    setShot(null);
    stopCamera();
    setMode('closed');
    setUploading(true);
    setError('');
    setJustSent(false);
    const args = { sessionId, mime: photo.mime, data: photo.data };
    const r = await callReducer('attachImage', { sessionId, mime: photo.mime, bytes: photo.data.length }, () => conn.reducers.attachImage(args));
    setUploading(false);
    if (r.ok) {
      if (thumb) URL.revokeObjectURL(thumb);
      setThumb(url);
    } else {
      URL.revokeObjectURL(url);
      setError(r.error ?? 'Could not send the photo');
    }
  };

  const remove = async () => {
    setError('');
    wasPending.current = false; // removed, not sent (the row update may arrive before the call returns)
    const r = await callReducer('removePendingImage', { sessionId }, () => conn.reducers.removePendingImage({ sessionId }));
    if (!r.ok) setError(r.error ?? 'Could not remove the photo');
    else dropThumb();
  };

  const chip = photoChip({ pending, uploading, error, justSent });

  return (
    <div className="turn-photo" data-testid="turn-photo" data-state={chip.kind}>
      <button type="button" className="turn-photo-button" data-testid="photo-button" aria-label="Take a picture" title="Take a picture" onClick={() => void startCamera()}>
        <CameraIcon />
      </button>
      {chip.kind !== 'none' && (
        <div className="turn-photo-chip" data-testid="photo-chip" role="status">
          {thumb && chip.kind !== 'error' && <img src={thumb} alt="Your photo" />}
          <span>
            {chip.kind === 'uploading' ? 'Sending photo…' : chip.kind === 'pending' ? 'Will be sent with your next answer' : chip.kind === 'sent' ? 'Photo sent to your tutor' : chip.message}
          </span>
          {chip.kind === 'pending' && (
            <button type="button" className="turn-photo-remove" data-testid="photo-remove" aria-label="Remove photo" onClick={() => void remove()}>
              ✕
            </button>
          )}
        </div>
      )}
      {mode !== 'closed' &&
        createPortal(
          <div className="turn-photo-modal" role="dialog" aria-modal="true" aria-label="Take a picture" data-testid="photo-modal" onKeyDown={e => e.key === 'Escape' && close()}>
            <div className="turn-photo-sheet">
              <header>
                <h2>Take a picture</h2>
                <button type="button" className="turn-photo-x" aria-label="Close" onClick={close}>✕</button>
              </header>
              <div className="turn-photo-view">
                {mode === 'review' && shot ? (
                  <img src={shot.url} alt="Your picture" data-testid="photo-review" />
                ) : mode === 'live' || mode === 'starting' ? (
                  <video ref={videoRef} playsInline muted autoPlay data-testid="photo-video" />
                ) : (
                  <div className="turn-photo-empty">
                    <CameraIcon size={40} />
                    <p>{camError || 'Take a picture of your work.'}</p>
                  </div>
                )}
              </div>
              {camError && mode !== 'fallback' && <p className="turn-photo-error" role="alert">{camError}</p>}
              <footer>
                {mode === 'review' ? (
                  <>
                    <button type="button" className="secondary" data-testid="photo-retake" onClick={() => (canUseCamera(navigator, window.isSecureContext) && !camError ? void startCamera() : fileRef.current?.click())}>
                      Retake
                    </button>
                    <button type="button" className="primary" data-testid="photo-use" onClick={() => void send()}>Use this photo</button>
                  </>
                ) : mode === 'fallback' ? (
                  <button type="button" className="primary" data-testid="photo-pick" onClick={() => fileRef.current?.click()}>Choose or take a picture</button>
                ) : (
                  <button type="button" className="primary" data-testid="photo-capture" disabled={mode !== 'live'} onClick={() => void capture()}>
                    {mode === 'starting' ? 'Starting camera…' : 'Snap!'}
                  </button>
                )}
              </footer>
              <input
                ref={fileRef}
                hidden
                type="file"
                accept="image/*"
                capture="environment"
                data-testid="photo-file"
                onChange={e => {
                  void onFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

function CameraIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}
