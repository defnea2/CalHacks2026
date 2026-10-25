import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { loadSettings } from './config';
import { installDebug } from './lib/debug';

const CanvasPreview = lazy(() => import('./board/CanvasPreview').then(m => ({ default: m.CanvasPreview })));
const TeamLab = lazy(() => import('./screens/TeamLab').then(m => ({ default: m.TeamLab })));
const TeamHarness = lazy(() => import('./screens/TeamLab').then(m => ({ default: m.TeamHarness })));
const query = new URLSearchParams(window.location.search);
const canvasPreview = query.has('canvasPreview');

const settings = loadSettings(window.location.search, import.meta.env as Record<string, string | undefined>);
installDebug(settings);

if (new URLSearchParams(window.location.search).get('theme') === 'dark' || (window.matchMedia?.('(prefers-color-scheme: dark)').matches && new URLSearchParams(window.location.search).get('theme') !== 'light')) {
  document.documentElement.classList.add('dark');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<p>Opening the canvas…</p>}>{canvasPreview ? <CanvasPreview /> : query.has('lesson') ? <TeamLab settings={settings} /> : query.has('harness') ? <TeamHarness /> : <App settings={settings} />}</Suspense>
  </StrictMode>
);
