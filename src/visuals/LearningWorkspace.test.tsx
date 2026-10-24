import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createScene } from '../shared';
import { getFixture, fixtureKeys } from '../shared/fixtures';
import { LearningWorkspace } from './LearningWorkspace';

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
