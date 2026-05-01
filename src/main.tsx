import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { registerServiceWorker } from './lib/serviceWorker';
import { configureNativeStatusBar } from './lib/nativeStatusBar';

registerServiceWorker();
configureNativeStatusBar();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
