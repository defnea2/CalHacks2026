import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';

export interface DragPoint { x: number; y: number; dx: number; dy: number; targetId: string | null }
interface Options {
  enabled: boolean;
  version: string;
  onDrop(point: DragPoint): void;
  onPreview?(point: DragPoint | null): void;
  onCancel?(): void;
}

/** Pointer capture supports mouse, pen, and touch; Escape/scene updates cancel the gesture. */
export function usePointerDrag(options: Options) {
  const latest = useRef(options); latest.current = options;
  const active = useRef<{ x: number; y: number; pointerId: number; version: string; moved: boolean; element: Element } | null>(null);
  const suppressClick = useRef(false);
  const suppressionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [point, setPoint] = useState<DragPoint | null>(null);
  const release = () => {
    const gesture = active.current;
    if (gesture && 'hasPointerCapture' in gesture.element && gesture.element.hasPointerCapture(gesture.pointerId)) gesture.element.releasePointerCapture(gesture.pointerId);
    active.current = null; setPoint(null); latest.current.onPreview?.(null);
  };
  const cancel = () => { if (active.current) { release(); latest.current.onCancel?.(); } };
  useEffect(() => {
    if (active.current && active.current.version !== options.version) cancel();
  }, [options.version]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(suppressionTimer.current); active.current = null; };
  }, []);
  const locate = (event: PointerEvent): DragPoint => {
    const gesture = active.current!;
    const target = document.elementFromPoint?.(event.clientX, event.clientY)?.closest<HTMLElement>('[data-drop-target]');
    return { x: event.clientX, y: event.clientY, dx: event.clientX - gesture.x, dy: event.clientY - gesture.y, targetId: target?.dataset.dropTarget ?? null };
  };
  return {
    point,
    isDragging: !!point,
    bindings: {
      onPointerDown(event: PointerEvent) {
        if (!latest.current.enabled || event.button !== 0 || active.current) return;
        suppressClick.current = false;
        active.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, version: latest.current.version, moved: false, element: event.currentTarget };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      },
      onPointerMove(event: PointerEvent) {
        const gesture = active.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        const next = locate(event);
        if (!gesture.moved && Math.hypot(next.dx, next.dy) < 6) return;
        gesture.moved = true; event.preventDefault(); setPoint(next); latest.current.onPreview?.(next);
      },
      onPointerUp(event: PointerEvent) {
        const gesture = active.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        const next = locate(event), shouldDrop = gesture.moved && gesture.version === latest.current.version;
        suppressClick.current = gesture.moved;
        release();
        if (shouldDrop) latest.current.onDrop(next);
        clearTimeout(suppressionTimer.current);
        suppressionTimer.current = setTimeout(() => { suppressClick.current = false; }, 0);
      },
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
      onClickCapture(event: MouseEvent) {
        if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; }
      },
    },
  };
}
