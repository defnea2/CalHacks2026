import { useReducer, useState } from 'react';
import { ActivitySpecSchema, CONTRACT_VERSION, createScene, type ActivitySpec, type LearnerAction, type SceneCommand, type SceneState } from '../shared';
import { fixtureKeys, getFixture, type FixtureKey } from '../shared/fixtures';
import { applySceneCommand, commandFromAction } from '../session/sceneReducer';
import { LearningWorkspace } from './LearningWorkspace';

const names: Record<FixtureKey, string> = { groups: 'Objects & groups', bars: 'Equal-part bars', line: 'Number lines', water: 'Diagrams & sequences', shapes: 'Shapes & space', sorting: 'Sorting boards' };
const freshScene = (activity: ActivitySpec) => createScene(activity, `scene-${crypto.randomUUID()}`);
type PreviewState = { scene: SceneState; history: { command: SceneCommand; result: string }[]; error: string };
type PreviewAction = { type: 'reset'; activity: ActivitySpec } | { type: 'command'; command: SceneCommand };
function previewReducer(state: PreviewState, action: PreviewAction): PreviewState {
  if (action.type === 'reset') return { scene: freshScene(action.activity), history: [], error: '' };
  const result = applySceneCommand(state.scene, action.command);
  return { scene: result.scene, history: [{ command: action.command, result: result.ok ? result.status : result.message }, ...state.history].slice(0, 20), error: result.ok ? '' : result.message };
}

export function VisualSandbox() {
  const [key, setKey] = useState<FixtureKey>('groups');
  const [{ scene, history, error }, dispatch] = useReducer(previewReducer, undefined, () => ({ scene: freshScene(getFixture('groups')), history: [], error: '' }));
  const [json, setJson] = useState(() => JSON.stringify(getFixture('groups'), null, 2));
  const [editorMessage, setEditorMessage] = useState('');
  const [editorError, setEditorError] = useState(false);
  const command = (payload: SceneCommand['payload']) => dispatch({ type: 'command', command: { contractVersion: CONTRACT_VERSION, commandId: crypto.randomUUID(), sceneId: scene.sceneId, expectedRevision: scene.revision, payload } });
  const handleAction = (action: LearnerAction) => dispatch({ type: 'command', command: commandFromAction(action) });
  const loadExample = (next: FixtureKey) => {
    const activity = getFixture(next); setKey(next); dispatch({ type: 'reset', activity });
    setJson(JSON.stringify(activity, null, 2)); setEditorMessage('');
  };
  const applyJson = (preserve: boolean) => {
    try {
      const activity = ActivitySpecSchema.parse(JSON.parse(json));
      if (preserve && (activity.id !== scene.activity.id || activity.kind !== scene.activity.kind)) throw new Error('Keep the same activity id and kind to preserve work, or load it as a new activity.');
      if (preserve) command({ type: 'update_activity', activity });
      else dispatch({ type: 'reset', activity });
      setEditorError(false); setEditorMessage(preserve ? 'Activity updated; valid placements and order were preserved.' : 'New activity loaded.');
    } catch (error) { setEditorError(true); setEditorMessage(error instanceof Error ? error.message : 'Invalid activity JSON.'); }
  };
  return <>
    <div className="preview-toolbar"><label>Example activity<select value={key} onChange={event => loadExample(event.target.value as FixtureKey)}>{fixtureKeys.map(value => <option key={value} value={value}>{names[value]}</option>)}</select></label>
      <button onClick={() => loadExample(key)}>Reset example</button><span className="preview-status"><i/>Standalone visual engine</span></div>
    {error && <p className="preview-error" role="alert">{error}</p>}
    <LearningWorkspace scene={scene} onAction={handleAction}/>
    <div className="preview-command-bar"><span>Try a tutor cue</span><button disabled={!scene.selectedIds.length} onClick={() => command({ type: 'highlight', objectIds: scene.selectedIds })}>Highlight selection</button><button disabled={!scene.highlightedIds.length} onClick={() => command({ type: 'clear_highlights' })}>Clear highlights</button><small>Revision {scene.revision}</small></div>
    <details className="preview-panel"><summary>Configure an activity <span>Any topic, the same components</span></summary>
      <p>Change the labels, objects, values, or prompt. Keep IDs stable when updating the current activity.</p>
      <label htmlFor="activity-json">Activity JSON</label><textarea id="activity-json" className="preview-json" spellCheck={false} value={json} onChange={event => setJson(event.target.value)}/>
      <div className="preview-editor-actions"><button className="preview-primary" onClick={() => applyJson(true)}>Update current activity</button><button onClick={() => applyJson(false)}>Load as new activity</button><button onClick={() => { setJson(JSON.stringify(scene.activity, null, 2)); setEditorMessage('Editor refreshed from the current scene.'); setEditorError(false); }}>Copy current activity to editor</button></div>
      {editorMessage && <p className={editorError ? 'preview-error' : 'preview-success'} role={editorError ? 'alert' : 'status'}>{editorMessage}</p>}
    </details>
    <details className="preview-panel"><summary>Scene & interaction log <span>{history.length} recent commands</span></summary><p>The host owns this state. The workspace emits actions tagged with the scene ID and revision.</p>
      <h3>Current scene</h3><pre>{JSON.stringify(scene, null, 2)}</pre><h3>Latest commands</h3><pre aria-label="Interaction log">{JSON.stringify(history, null, 2)}</pre>
    </details>
  </>;
}
