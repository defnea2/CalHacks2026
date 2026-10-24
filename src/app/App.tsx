import { useState } from 'react';
import { VisualSandbox } from '../visuals/VisualSandbox';
import { GuidedWorkbench } from '../presentation/GuidedWorkbench';
export default function App(){
  const [mode,setMode]=useState<'guided'|'components'>('guided');
  return <main><header className="engine-intro"><span className="eyebrow">An idea, brought to life</span><h1>See it unfold.<br/><em>Understand it together.</em></h1><p>A tutor that builds the picture as it explains.<br/>Follow along, then try a little discovery of your own.</p></header>
    <nav className="workbench-mode" aria-label="Workbench mode"><button aria-pressed={mode==='guided'} onClick={()=>setMode('guided')}>Guided explanation</button><button aria-pressed={mode==='components'} onClick={()=>setMode('components')}>Interactive building blocks</button></nav>
    {mode==='guided'?<GuidedWorkbench/>:<VisualSandbox/>}<footer>Visual engine development preview</footer></main>;
}
