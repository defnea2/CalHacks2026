import { describe, expect, it } from 'vitest';
import { applyCanvasCommands } from './canvasState';
import { emptyCanvas, type BeatInput } from './contracts';
import { VisualDirector } from './VisualDirector';

const beat:BeatInput={id:'water',narration:'The sun warms the water.',cues:[
  {id:'setup',atMs:0,commands:[{type:'clear',title:'Water changes'},{type:'add',nodes:[{id:'sun',kind:'object',x:200,y:100,width:100,height:100,label:'Sun',icon:'sun'}]}]},
  {id:'point',atMs:1200,commands:[{type:'point',id:'sun',label:'A source of warmth'}]},
  {id:'move',atMs:2400,commands:[{type:'update',id:'sun',patch:{x:400}},{type:'highlight',ids:['sun']}]},
],question:{prompt:'Which object warms the water?',nodeIds:['sun']}};

describe('narration-driven visuals',()=>{
  it('waits for actual playback and applies each cue once at its audio time',()=>{
    const d=new VisualDirector();const token=d.prepare(beat);
    d.narrationProgress(token,2000);expect(d.getSnapshot().canvas.nodes).toHaveLength(0);
    d.narrationStarted(token);expect(d.getSnapshot().canvas.nodes[0].x).toBe(200);
    d.narrationProgress(token,1199);expect(d.getSnapshot().canvas.pointer).toBeNull();
    d.narrationProgress(token,1200);expect(d.getSnapshot().canvas.pointer?.id).toBe('sun');
    d.narrationProgress(token,2400);d.narrationProgress(token,2400);d.narrationProgress(token,100);
    expect(d.getSnapshot().canvas.nodes[0].x).toBe(400);
    expect(d.getSnapshot().appliedCueIds).toEqual(['setup','point','move']);
  });
  it('freezes on pause and resumes from the same point',()=>{
    const d=new VisualDirector();const token=d.prepare(beat);d.narrationStarted(token);d.narrationProgress(token,500);d.narrationPaused(token);
    d.narrationProgress(token,2500);expect(d.getSnapshot().canvas.pointer).toBeNull();
    d.narrationStarted(token);d.narrationProgress(token,1500);expect(d.getSnapshot().canvas.pointer?.id).toBe('sun');
  });
  it('discards pending cues on interruption and ignores delayed callbacks even when replaying the same beat',()=>{
    const d=new VisualDirector();const old=d.prepare(beat);d.narrationStarted(old);d.interrupt(old);d.narrationProgress(old,5000);d.narrationEnded(old);
    expect(d.getSnapshot().status).toBe('interrupted');expect(d.getSnapshot().canvas.nodes[0].x).toBe(200);
    const next=d.prepare(beat);d.narrationStarted(next);d.narrationEnded(old);
    expect(d.getSnapshot().status).toBe('speaking');expect(next.runId).not.toBe(old.runId);
  });
  it('waits for the child after narration and accepts only a current, valid response once',()=>{
    const d=new VisualDirector();const token=d.prepare(beat);d.narrationStarted(token);
    expect(d.respond('sun')).toBeNull();d.narrationEnded(token);
    expect(d.getSnapshot().status).toBe('awaiting_answer');expect(d.respond('missing')).toBeNull();
    expect(d.respond('sun')).toEqual({...token,type:'choose_node',nodeId:'sun'});expect(d.respond('sun')).toBeNull();
  });
  it('rejects a broken plan before replacing the active one',()=>{
    const d=new VisualDirector();const token=d.prepare(beat);d.narrationStarted(token);const before=d.getSnapshot();
    expect(()=>d.prepare({...beat,cues:[{id:'bad',atMs:0,commands:[{type:'highlight',ids:['missing']}]}]})).toThrow('Unknown canvas object');
    expect(d.getSnapshot()).toBe(before);
  });
  it('preserves existing visuals across streamed explanation beats',()=>{
    const d=new VisualDirector();const a=d.prepare(beat);d.narrationStarted(a);d.narrationEnded(a);
    const b=d.prepare({id:'continue',narration:'Look over here.',cues:[{id:'update',atMs:0,commands:[{type:'update',id:'sun',patch:{label:'Our star'}}]}]});
    d.narrationStarted(b);expect(d.getSnapshot().canvas.nodes[0]).toMatchObject({label:'Our star',x:400,icon:'sun'});
  });
  it('rejects duplicate or out-of-order cues',()=>{
    const d=new VisualDirector();expect(()=>d.prepare({...beat,cues:[beat.cues[1],beat.cues[0]]})).toThrow('playback order');
    expect(()=>d.prepare({...beat,cues:[beat.cues[0],beat.cues[0]]})).toThrow('unique');
  });
});
it('applies cue batches atomically and removes dangling arrows and focus',()=>{
  const initial=applyCanvasCommands(emptyCanvas(),beat.cues[0].commands);
  expect(()=>applyCanvasCommands(initial,[{type:'update',id:'sun',patch:{x:900}},{type:'point',id:'missing'}])).toThrow();
  expect(initial.nodes[0].x).toBe(200);
  const connected=applyCanvasCommands(initial,[{type:'add',nodes:[{id:'drop',kind:'object',x:100,y:300,width:80,height:80,label:'Water'}]},{type:'connect',edges:[{id:'warmth',from:'sun',to:'drop'}]},{type:'point',id:'sun'},{type:'highlight',ids:['sun']}]);
  const removed=applyCanvasCommands(connected,[{type:'remove',ids:['sun']}]);
  expect(removed.edges).toEqual([]);expect(removed.pointer).toBeNull();expect(removed.highlightedIds).toEqual([]);
});

it('replays the current beat from its starting canvas with a fresh playback token',()=>{
  const d=new VisualDirector();const old=d.prepare(beat);d.narrationStarted(old);d.narrationProgress(old,2500);d.interrupt(old);
  const replay=d.replay()!;expect(replay.runId).not.toBe(old.runId);expect(d.getSnapshot().canvas.nodes).toHaveLength(0);
  d.narrationStarted(replay);expect(d.getSnapshot().canvas.nodes[0].x).toBe(200);d.narrationEnded(old);expect(d.getSnapshot().status).toBe('speaking');
});
