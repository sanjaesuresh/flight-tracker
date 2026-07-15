import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// self-hosted (no CDN): Bricolage display, Instrument body, Spline Sans Mono data
import '@fontsource-variable/bricolage-grotesque/wght.css';
import '@fontsource-variable/instrument-sans/wght.css';
import '@fontsource-variable/spline-sans-mono/wght.css';
import './styles.css';
import { App } from './App.tsx';
import { AuthProvider } from './auth/AuthProvider.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
