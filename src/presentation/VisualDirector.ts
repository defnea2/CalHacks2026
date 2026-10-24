import { applyCanvasCommands } from './canvasState';
import { emptyCanvas, VisualBeatSchema, type CanvasResponse, type CanvasState, type PlaybackToken, type VisualBeat } from './contracts';

export type DirectorStatus='idle'|'ready'|'speaking'|'paused'|'awaiting_answer'|'completed'|'interrupted'|'error';
export interface DirectorSnapshot {
  canvas:CanvasState; token:PlaybackToken|null; beat:VisualBeat|null;
  status:DirectorStatus; elapsedMs:number; appliedCueIds:string[]; error:string|null;
}

/** Owns presentation only. The voice/teaching host owns narration, planning, and assessment. */
export class VisualDirector {
  private snapshot:DirectorSnapshot={canvas:emptyCanvas(),token:null,beat:null,status:'idle',elapsedMs:0,appliedCueIds:[],error:null};
  private listeners=new Set<()=>void>();
  private beatStartCanvas:CanvasState=emptyCanvas();
  getSnapshot=()=>this.snapshot;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private publish(patch:Partial<DirectorSnapshot>){this.snapshot={...this.snapshot,...patch};this.listeners.forEach(listener=>listener());}
  private matches(token:PlaybackToken){return token.runId===this.snapshot.token?.runId&&token.beatId===this.snapshot.token?.beatId;}
  prepare(input:unknown):PlaybackToken {
    const beat=VisualBeatSchema.parse(input);
    // Preflight every cue against a clone before making any new narration active.
    let planned=this.snapshot.canvas;
    for(const cue of beat.cues)planned=applyCanvasCommands(planned,cue.commands);
    if(beat.question?.nodeIds.some(id=>!planned.nodes.some(node=>node.id===id)))throw new Error('Question refers to an object absent from the completed scene.');
    this.beatStartCanvas=structuredClone(this.snapshot.canvas);
    const token={runId:crypto.randomUUID(),beatId:beat.id};
    this.publish({token,beat,status:'ready',elapsedMs:0,appliedCueIds:[],error:null});
    return token;
  }
  replay():PlaybackToken|null {
    if(!this.snapshot.beat)return null;
    const token={runId:crypto.randomUUID(),beatId:this.snapshot.beat.id};
    this.publish({token,canvas:structuredClone(this.beatStartCanvas),status:'ready',elapsedMs:0,appliedCueIds:[],error:null});
    return token;
  }
  private advance(elapsedMs:number,finish=false){
    const {beat,canvas,appliedCueIds}=this.snapshot;if(!beat)return;
    try{
      let next=canvas;const applied=[...appliedCueIds];
      for(const cue of beat.cues){if((finish||cue.atMs<=elapsedMs)&&!applied.includes(cue.id)){next=applyCanvasCommands(next,cue.commands);applied.push(cue.id);}}
      this.publish({canvas:next,appliedCueIds:applied,elapsedMs});
    }catch(error){this.publish({status:'error',error:error instanceof Error?error.message:'Invalid visual cue.'});}
  }
  narrationStarted(token:PlaybackToken){if(!this.matches(token)||!['ready','paused'].includes(this.snapshot.status))return;this.publish({status:'speaking'});this.advance(this.snapshot.elapsedMs);}
  narrationProgress(token:PlaybackToken,elapsedMs:number){if(!this.matches(token)||this.snapshot.status!=='speaking'||!Number.isFinite(elapsedMs)||elapsedMs<this.snapshot.elapsedMs)return;this.advance(elapsedMs);}
  narrationPaused(token:PlaybackToken){if(this.matches(token)&&this.snapshot.status==='speaking')this.publish({status:'paused'});}
  narrationEnded(token:PlaybackToken){if(!this.matches(token)||!['speaking','paused'].includes(this.snapshot.status))return;this.advance(this.snapshot.elapsedMs,true);if(this.snapshot.status!=='error')this.publish({status:this.snapshot.beat?.question?'awaiting_answer':'completed'});}
  interrupt(token:PlaybackToken){if(this.matches(token)&&!['idle','interrupted'].includes(this.snapshot.status))this.publish({status:'interrupted'});}
  respond(nodeId:string):CanvasResponse|null {
    if(this.snapshot.status!=='awaiting_answer'||!this.snapshot.token||!this.snapshot.beat?.question?.nodeIds.includes(nodeId))return null;
    const response:CanvasResponse={...this.snapshot.token,type:'choose_node',nodeId};
    this.publish({status:'completed'});return response;
  }
  reset(){this.publish({canvas:emptyCanvas(),token:null,beat:null,status:'idle',elapsedMs:0,appliedCueIds:[],error:null});}
}
