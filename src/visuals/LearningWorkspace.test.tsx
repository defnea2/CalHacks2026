import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { createScene } from '../shared';
import { getFixture, fixtureKeys } from '../shared/fixtures';
import { LearningWorkspace } from './LearningWorkspace';
import { applySceneCommand, commandFromAction } from '../session/sceneReducer';

it.each(fixtureKeys)('renders %s without a provider', key => {
  const scene = createScene(getFixture(key));
  render(<LearningWorkspace scene={scene} onAction={vi.fn()} />);
  expect(screen.getByRole('heading', { name: scene.activity.title })).toBeInTheDocument();
});
it('emits a revision-tagged selection without mutating the input', () => {
  const scene = createScene(getFixture('groups'));
  const onAction = vi.fn();
  render(<LearningWorkspace scene={scene} onAction={onAction} />);
  fireEvent.click(screen.getByRole('button', { name: /Seed 1/ }));
  expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ sceneRevision: 0, sceneId: scene.sceneId, payload: { type: 'select', objectId: 'seed-1' } }));
  expect(scene.selectedIds).toEqual([]);
});

it('moves a selected object between real containers and back to the tray', () => {
  function Harness() {
    const [scene, setScene] = useState(() => createScene(getFixture('groups')));
    return <LearningWorkspace scene={scene} onAction={action => setScene(current => applySceneCommand(current, commandFromAction(action)).scene)}/>;
  }
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', { name: 'Seed 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Place selected object in Garden A' }));
  expect(within(screen.getByRole('region', { name: 'Garden A' })).getByRole('button', { name: 'Seed 1' })).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Objects to explore' })).queryByRole('button', { name: 'Seed 1' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Return to tray' }));
  expect(within(screen.getByRole('region', { name: 'Objects to explore' })).getByRole('button', { name: 'Seed 1' })).toBeInTheDocument();
});

it('shows a recoverable validation error for an invalid scene', () => {
  const scene = createScene(getFixture('groups'));
  scene.selectedIds = ['missing-object'];
  render(<LearningWorkspace scene={scene} onAction={vi.fn()}/>);
  expect(screen.getByRole('alert')).toHaveTextContent('This activity needs a small fix');
});

it('colours equal parts and compares amounts after repartitioning', () => {
  function Harness() {
    const [scene, setScene] = useState(() => createScene(getFixture('bars')));
    return <LearningWorkspace scene={scene} onAction={action => setScene(current => applySceneCommand(current, commandFromAction(action)).scene)}/>;
  }
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', { name: 'Shade 2 of 6 parts in Bar B' }));
  fireEvent.click(screen.getByRole('button', { name: /Compare coloured amounts/ }));
  expect(screen.getByRole('region', { name: 'Equal-scale comparison' })).toHaveTextContent('1/3 = 2/6');
  fireEvent.change(screen.getByRole('combobox', { name: 'Bar A equal parts' }), { target: { value: '6' } });
  expect(screen.getByRole('region', { name: 'Equal-scale comparison' })).toHaveTextContent('1/6 < 2/6');
  fireEvent.click(within(screen.getByRole('region', { name: 'Bar B' })).getByRole('button', { name: 'Clear colour' }));
  expect(screen.getByRole('region', { name: 'Equal-scale comparison' })).toHaveTextContent('1/6 > 0/6');
});

it('reorders stages and creates and removes a visible connection', () => {
  function Harness() {
    const [scene, setScene] = useState(() => createScene(getFixture('water')));
    return <LearningWorkspace scene={scene} onAction={action => setScene(current => applySceneCommand(current, commandFromAction(action)).scene)}/>;
  }
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', { name: 'Move Water evaporates earlier' }));
  expect(screen.getByRole('button', { name: 'Water evaporates' })).toHaveTextContent('2');
  fireEvent.click(screen.getByRole('button', { name: 'Water in the sea' }));
  fireEvent.click(screen.getByRole('button', { name: 'Connect from selected' }));
  fireEvent.click(screen.getByRole('button', { name: 'Water evaporates' }));
  expect(within(screen.getByRole('list', { name: 'Connections' })).getByRole('listitem')).toHaveTextContent('Water in the sea → Water evaporates');
  fireEvent.click(screen.getByRole('button', { name: 'Remove connection from Water in the sea to Water evaporates' }));
  expect(within(screen.getByRole('list', { name: 'Connections' })).queryByRole('listitem')).not.toBeInTheDocument();
});

it('supports number-line keyboard movement and clamps at endpoints', () => {
  function Harness() {
    const [scene, setScene] = useState(() => createScene(getFixture('line')));
    return <LearningWorkspace scene={scene} onAction={action => setScene(current => applySceneCommand(current, commandFromAction(action)).scene)}/>;
  }
  render(<Harness/>);
  const slider = screen.getByRole('slider', { name: 'Move Explorer' });
  fireEvent.keyDown(slider, { key: 'ArrowRight' });
  expect(slider).toHaveAttribute('aria-valuenow', '3');
  fireEvent.keyDown(slider, { key: 'End' });
  fireEvent.keyDown(slider, { key: 'ArrowRight' });
  expect(slider).toHaveAttribute('aria-valuenow', '10');
  expect(screen.getByRole('button', { name: 'Move Explorer right' })).toBeDisabled();
  fireEvent.keyDown(slider, { key: 'Home' });
  expect(slider).toHaveAttribute('aria-valuenow', '0');
});

it('moves, rotates and reflects shapes while retaining their position', () => {
  function Harness() {
    const [scene, setScene] = useState(() => createScene(getFixture('shapes')));
    return <LearningWorkspace scene={scene} onAction={action => setScene(current => applySceneCommand(current, commandFromAction(action)).scene)}/>;
  }
  render(<Harness/>);
  const triangle = screen.getByRole('button', { name: 'Move or select Triangle' });
  fireEvent.keyDown(triangle, { key: 'ArrowRight' });
  expect(triangle).toHaveAttribute('transform', 'translate(27 50)');
  fireEvent.click(screen.getByRole('button', { name: 'Rotate Triangle 90 degrees' }));
  fireEvent.click(screen.getByRole('button', { name: 'Flip Triangle' }));
  expect(triangle.querySelector('.lab-shape-geometry')).toHaveAttribute('transform', 'rotate(90) scale(-1 1)');
  expect(triangle).toHaveAttribute('transform', 'translate(27 50)');
  fireEvent.click(screen.getByRole('button', { name: 'Show mirror' }));
  expect(screen.getByText('The dashed shape shows the reflection across the mirror line.')).toBeInTheDocument();
});
