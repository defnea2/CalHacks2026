import { useRef } from 'react';
import { usePointerDrag } from '../interactions/usePointerDrag';
import { clamp, tickValues, valueFromPosition } from '../visual-math/geometry';
import { isEnabled, objectClass, type ActivityProps } from './types';

type Props = ActivityProps<'bars_number_line'>;
function MarkerLine({ marker, activity, scene, emit, announce, index }: Props & { marker: Props['activity']['markers'][number]; index: number }) {
  const rail = useRef<HTMLDivElement>(null);
  const enabled = isEnabled(scene, 'move_marker');
  const step = activity.max - activity.min > 2 ? 1 : 0.1;
  const normalise = (value: number) => Number(clamp(value, activity.min, activity.max).toFixed(4));
  const valueAt = (x: number) => {
    const bounds = rail.current?.getBoundingClientRect();
    return bounds && bounds.width > 0 ? valueFromPosition(x, bounds.left, bounds.width, activity.min, activity.max) : marker.value;
  };
  const drag = usePointerDrag({ enabled, version: `${scene.sceneId}:${scene.revision}`,
    onCancel: () => announce('Move cancelled.'),
    onDrop: point => emit({ type: 'move_marker', objectId: marker.id, value: valueAt(point.x) }),
  });
  const shownValue = drag.point ? valueAt(drag.point.x) : marker.value;
  const position = (value: number) => (value - activity.min) / (activity.max - activity.min) * 100;
  return <section className={`lab-line-card palette-${index % 4} ${objectClass(scene, marker.id)}`} aria-label={marker.label}>
    <div className="lab-line-heading"><button className="lab-object-title" disabled={!isEnabled(scene, 'select')} aria-pressed={scene.selectedIds.includes(marker.id)} onClick={() => emit({ type: 'select', objectId: marker.id })}>{marker.label}</button><output aria-label={`${marker.label} position`}>{shownValue}</output></div>
    <div className="lab-number-rail" ref={rail}>
      <div className="lab-line-progress" style={{ width: `${position(shownValue)}%` }}/>
      {tickValues(activity.min, activity.max).map(value => <div key={value} className="lab-line-tick" style={{ left: `${position(value)}%` }}><span>{value}</span></div>)}
      <button {...drag.bindings} className={`lab-line-marker ${drag.isDragging ? 'dragging' : ''}`} style={{ left: `${position(shownValue)}%` }}
        role="slider" aria-label={`Move ${marker.label}`} aria-valuemin={activity.min} aria-valuemax={activity.max} aria-valuenow={shownValue} aria-orientation="horizontal" disabled={!enabled}
        onKeyDown={event => {
          const values: Record<string, number> = { ArrowRight: marker.value + step, ArrowUp: marker.value + step, ArrowLeft: marker.value - step, ArrowDown: marker.value - step, Home: activity.min, End: activity.max };
          if (event.key in values) { event.preventDefault(); emit({ type: 'move_marker', objectId: marker.id, value: normalise(values[event.key]) }, 'keyboard'); }
        }}><span aria-hidden="true">✦</span></button>
    </div>
    <div className="lab-line-controls"><button disabled={!enabled || marker.value <= activity.min} aria-label={`Move ${marker.label} left`} onClick={() => emit({ type: 'move_marker', objectId: marker.id, value: normalise(marker.value - step) })}>←</button><span>Drag the marker or use the arrow keys</span><button disabled={!enabled || marker.value >= activity.max} aria-label={`Move ${marker.label} right`} onClick={() => emit({ type: 'move_marker', objectId: marker.id, value: normalise(marker.value + step) })}>→</button></div>
  </section>;
}

export function NumberLineActivity(props: Props) {
  return <><div className="lab-instruction"><span className="instruction-number">1</span><span>Slide along the line. Notice the distance between each number.</span></div>
    <div className="lab-lines">{props.activity.markers.map((marker, index) => <MarkerLine key={marker.id} {...props} marker={marker} index={index}/>)}</div></>;
}
