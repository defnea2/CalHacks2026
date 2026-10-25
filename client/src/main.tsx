import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { loadSettings } from './config';
import { installDebug } from './lib/debug';

const settings = loadSettings(window.location.search, import.meta.env as Record<string, string | undefined>);
installDebug(settings);

if (new URLSearchParams(window.location.search).get('theme') === 'dark' || (window.matchMedia?.('(prefers-color-scheme: dark)').matches && new URLSearchParams(window.location.search).get('theme') !== 'light')) {
  document.documentElement.classList.add('dark');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App settings={settings} />
  </StrictMode>
);
