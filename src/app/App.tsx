import { VisualSandbox } from '../visuals/VisualSandbox';

export default function App() {
  return <main><header className="engine-intro"><span className="eyebrow">Interactive visual engine</span><h1>A little room<br />for <em>big ideas.</em></h1><p>A standalone workbench for our visual module.<br />Explore a scene, change it, and inspect the events.</p></header><VisualSandbox/><footer>Visual engine preview · no voice or model connection</footer></main>;
}
