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
