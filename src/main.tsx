import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './components/shell/theme';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);

// Vite emits this when a lazy chunk fails to load (stale deploy); one reload fetches a consistent set of files
window.addEventListener('vite:preloadError', () => { try { if (sessionStorage.getItem('or_chunk_reload') !== '1') { sessionStorage.setItem('or_chunk_reload', '1'); window.location.reload(); } } catch { /* ignore */ } });

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => undefined); });
}
