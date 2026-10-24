import { motion } from 'motion/react';
import { createAction } from '../interactions/createAction';
import type { ActionPayload, LearnerAction, SceneState } from '../shared';
import { partitionWidth } from '../visual-math/fractions';

export interface LearningWorkspaceProps {
  scene: SceneState;
  onAction(action: LearnerAction): void;
}
const icons = { dot: '●', leaf: '✿', sun: '☀', cloud: '☁', drop: '◒', animal: '♞', book: '▤' };

export function LegacyWorkspace({ scene, onAction }: LearningWorkspaceProps) {
  const activity = scene.activity;
  const send = (payload: ActionPayload) => onAction(createAction(scene, payload));
  const selected = scene.selectedIds[0];
  const allowed = (type: ActionPayload['type']) => activity.allowedInteractions.includes(type);
  const classFor = (id: string) => `object ${scene.selectedIds.includes(id) ? 'selected' : ''} ${scene.highlightedIds.includes(id) ? 'highlighted' : ''}`;
  const reorder = (id: string, direction: number) => {
    const order = [...scene.order], index = order.indexOf(id), next = index + direction;
    if (next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next], order[index]];
    send({ type: 'reorder', objectIds: order });
  };
  return <section className="workspace" aria-label="Learning workspace">
    <div className="workspace-heading"><span className="eyebrow">Explore together</span><span className="revision">Scene revision {scene.revision}</span></div>
    <h2>{activity.title}</h2><p className="question">{activity.prompt}</p>
    <motion.div key={activity.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}>
      {(activity.kind === 'objects_groups' || activity.kind === 'sorting_board') && (() => {
        const items = activity.kind === 'objects_groups' ? activity.objects : activity.items;
        const groups = activity.kind === 'objects_groups' ? activity.groups : activity.categories;
        return <>
          <div className="object-tray">{scene.order.map(id => {
            const item = items.find(x => x.id === id)!;
            return <button key={id} className={classFor(id)} aria-pressed={selected === id} disabled={!allowed('select')} onClick={() => send({ type: 'select', objectId: id })}>
              <span className="object-icon" aria-hidden="true">{icons[item.icon]}</span><span>{item.label}</span>
              {scene.placements[id] && <small>In {groups.find(x => x.id === scene.placements[id])?.label}</small>}
            </button>;
          })}</div>
          <p className="hint">Select an object, then choose its destination.</p>
          <div className="group-grid">{groups.map(group => <button className="group" key={group.id} disabled={!selected || !allowed('place')} onClick={() => selected && send({ type: 'place', objectId: selected, containerId: group.id })}>
            <strong>{group.label}</strong><span>{Object.values(scene.placements).filter(id => id === group.id).length} objects</span>
          </button>)}</div>
          {activity.kind === 'sorting_board' && <div className="toolbar"><button disabled={!selected || !allowed('reorder') || scene.order[0] === selected} onClick={() => selected && reorder(selected, -1)}>Move selected earlier</button></div>}
        </>;
      })()}
      {activity.kind === 'bars_number_line' && activity.mode === 'bars' && <div className="bar-grid">{activity.bars.map(bar => <div key={bar.id} className={classFor(bar.id)}>
        <button className="text-button" disabled={!allowed('select')} onClick={() => send({ type: 'select', objectId: bar.id })}>{bar.label}: {bar.shaded}/{bar.parts}</button>
        <svg viewBox="0 0 100 18" role="img" aria-label={`${bar.shaded} of ${bar.parts} equal parts shaded`}>
          {Array.from({ length: bar.parts }, (_, i) => <rect key={i} x={i * partitionWidth(bar.parts)} y="1" width={partitionWidth(bar.parts)} height="16" fill={i < bar.shaded ? '#31866d' : '#e5efe9'} stroke="white" strokeWidth="0.6" />)}
        </svg>
        <label>Equal parts <select value={bar.parts} disabled={!allowed('set_parts')} onChange={e => send({ type: 'set_parts', objectId: bar.id, parts: Number(e.target.value) })}>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
      </div>)}</div>}
      {activity.kind === 'bars_number_line' && activity.mode === 'number_line' && <div className="number-line">{activity.markers.map(marker => <div key={marker.id} className={classFor(marker.id)}>
        <label htmlFor={marker.id}>{marker.label}: <strong>{marker.value}</strong></label>
        <input id={marker.id} type="range" min={activity.min} max={activity.max} step="1" value={marker.value} disabled={!allowed('move_marker')} onChange={e => send({ type: 'move_marker', objectId: marker.id, value: Number(e.target.value) })} />
        <div className="range-labels"><span>{activity.min}</span><span>{activity.max}</span></div>
      </div>)}</div>}
      {activity.kind === 'diagram_sequence' && <>
        <ol className="sequence">{scene.order.map((id, index) => {
          const node = activity.nodes.find(x => x.id === id)!;
          return <li key={id} className={classFor(id)}>
            <button className="text-button" aria-pressed={selected === id} disabled={!allowed('select')} onClick={() => send({ type: 'select', objectId: id })}><span className="object-icon" aria-hidden="true">{icons[node.icon]}</span>{node.label}</button>
            <div className="toolbar"><button aria-label={`Move ${node.label} earlier`} disabled={index === 0 || !allowed('reorder')} onClick={() => reorder(id, -1)}>←</button><button aria-label={`Move ${node.label} later`} disabled={index === scene.order.length - 1 || !allowed('reorder')} onClick={() => reorder(id, 1)}>→</button></div>
          </li>;
        })}</ol>
        <div className="toolbar"><label>Connect selected to <select aria-label="Connect selected to" value="" disabled={!selected || !allowed('connect')} onChange={e => selected && send({ type: 'connect', from: selected, to: e.target.value })}><option value="">Choose a node</option>{activity.nodes.filter(x => x.id !== selected).map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label></div>
        <ul className="connections" aria-label="Connections">{activity.edges.map(edge => <li key={edge.id}>{activity.nodes.find(x => x.id === edge.from)?.label} → {activity.nodes.find(x => x.id === edge.to)?.label}</li>)}</ul>
      </>}
      {activity.kind === 'shape_workspace' && <>
        <svg className="shape-board" viewBox="0 0 100 100" role="img" aria-label="Shape transformations">
          <path d="M50 0V100" stroke="#c5d9d0" strokeDasharray="2 2" />
          {activity.shapes.map(shape => <g key={shape.id} transform={`translate(${shape.x} ${shape.y}) rotate(${shape.rotation}) scale(${shape.reflected ? -1 : 1} 1)`} fill={scene.highlightedIds.includes(shape.id) ? '#edb75d' : '#31866d'}>
            {shape.shape === 'circle' && <circle r={shape.size / 2} />}
            {shape.shape === 'rectangle' && <rect x={-shape.size / 2} y={-shape.size / 3} width={shape.size} height={shape.size * 2 / 3} rx="1" />}
            {shape.shape === 'triangle' && <polygon points={`${-shape.size / 2},${shape.size / 2} ${shape.size / 2},${shape.size / 2} ${-shape.size / 2},${-shape.size / 2}`} />}
          </g>)}
        </svg>
        <div className="group-grid">{activity.shapes.map(shape => <div key={shape.id} className={classFor(shape.id)}><button className="text-button" disabled={!allowed('select')} onClick={() => send({ type: 'select', objectId: shape.id })}>{shape.label}</button><div className="toolbar"><button disabled={!allowed('transform')} onClick={() => send({ type: 'transform', objectId: shape.id, rotation: (shape.rotation + 90) % 360, reflected: shape.reflected })}>Turn 90°</button><button disabled={!allowed('transform')} onClick={() => send({ type: 'transform', objectId: shape.id, rotation: shape.rotation, reflected: !shape.reflected })}>Flip</button></div></div>)}</div>
      </>}
    </motion.div>
  </section>;
}
