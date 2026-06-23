import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { registerServiceWorker } from './lib/serviceWorker';
import { installGlobalErrorHandlers, setErrorReporter } from './lib/errorReporter';
import { initSentry } from './lib/sentryReporter';
import { initTheme } from './stores/themeStore';

// Apply the saved appearance (light/dark/system) before first React paint.
// CSP blocks an inline <head> script, so this runs as early as the module
// graph allows; the initial loading screen is dark navy regardless, so there
// is no jarring light flash.
initTheme();

// Activate Sentry if VITE_SENTRY_DSN is set; otherwise the noop reporter
// stays active and dev-mode logs go to the console.
const sentryReporter = initSentry();
if (sentryReporter) setErrorReporter(sentryReporter);
installGlobalErrorHandlers();
registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
