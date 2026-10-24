import { useState } from 'react';
import { createScene, type LearnerAction } from '../shared';
import { fixtureKeys, getFixture, type FixtureKey } from '../shared/fixtures';
import { applySceneCommand, commandFromAction } from '../session/sceneReducer';
import { LearningWorkspace } from './LearningWorkspace';

export function VisualSandbox() {
  const [key, setKey] = useState<FixtureKey>('groups');
  const [scene, setScene] = useState(() => createScene(getFixture('groups')));
  const [event, setEvent] = useState<unknown>(null);
  const handleAction = (action: LearnerAction) => {
    const result = applySceneCommand(scene, commandFromAction(action));
    setEvent({ action, result: result.ok ? result.status : result.message });
    if (result.ok) setScene(result.scene);
  };
  return <>
    <div className="panel toolbar"><label>Fixture <select value={key} onChange={e => { const next = e.target.value as FixtureKey; setKey(next); setScene(createScene(getFixture(next))); setEvent(null); }}>{fixtureKeys.map(value => <option key={value} value={value}>{value}</option>)}</select></label><span>Member 1 · no provider required</span></div>
    <LearningWorkspace scene={scene} onAction={handleAction} />
    <details className="panel"><summary>Latest interaction event</summary><pre>{JSON.stringify(event, null, 2)}</pre></details>
  </>;
}
