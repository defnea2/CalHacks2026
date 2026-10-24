import { act, renderHook } from '@testing-library/react';
import type { PointerEvent } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePointerDrag } from './usePointerDrag';

afterEach(() => vi.restoreAllMocks());
function event(x: number, y: number): PointerEvent {
  const element = document.createElement('button');
  return { clientX: x, clientY: y, pointerId: 1, button: 0, currentTarget: element, preventDefault: vi.fn() } as unknown as PointerEvent;
}
it('ignores clicks below the drag threshold and delivers a completed drop', () => {
  const onDrop = vi.fn();
  const { result } = renderHook(() => usePointerDrag({ enabled: true, version: '1', onDrop }));
  act(() => { result.current.bindings.onPointerDown(event(10, 10)); result.current.bindings.onPointerMove(event(12, 12)); result.current.bindings.onPointerUp(event(12, 12)); });
  expect(onDrop).not.toHaveBeenCalled();
  act(() => { result.current.bindings.onPointerDown(event(10, 10)); result.current.bindings.onPointerMove(event(100, 40)); });
  expect(result.current.isDragging).toBe(true);
  act(() => result.current.bindings.onPointerUp(event(100, 40)));
  expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ dx: 90, dy: 30 }));
  expect(result.current.isDragging).toBe(false);
});
it('cancels a drag when a newer scene arrives', () => {
  const onDrop = vi.fn(), onCancel = vi.fn();
  const { result, rerender } = renderHook(({ version }) => usePointerDrag({ enabled: true, version, onDrop, onCancel }), { initialProps: { version: '1' } });
  act(() => { result.current.bindings.onPointerDown(event(0, 0)); result.current.bindings.onPointerMove(event(100, 40)); });
  rerender({ version: '2' });
  act(() => result.current.bindings.onPointerUp(event(100, 40)));
  expect(onDrop).not.toHaveBeenCalled(); expect(onCancel).toHaveBeenCalled();
});
it('cancels on Escape and never starts when disabled', () => {
  const onDrop = vi.fn();
  const { result, rerender } = renderHook(({ enabled }) => usePointerDrag({ enabled, version: '1', onDrop }), { initialProps: { enabled: true } });
  act(() => { result.current.bindings.onPointerDown(event(0, 0)); result.current.bindings.onPointerMove(event(100, 40)); });
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  act(() => result.current.bindings.onPointerUp(event(100, 40)));
  expect(onDrop).not.toHaveBeenCalled();
  rerender({ enabled: false });
  act(() => { result.current.bindings.onPointerDown(event(0, 0)); result.current.bindings.onPointerMove(event(100, 40)); });
  expect(result.current.isDragging).toBe(false);
});
