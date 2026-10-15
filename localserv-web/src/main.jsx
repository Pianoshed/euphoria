import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Fonts, hosted by the app itself (no request to Google Fonts, so they load on any network)
import '@fontsource/fredoka/600.css';
import '@fontsource/fredoka/700.css';
import '@fontsource/sora/600.css';
import '@fontsource/sora/700.css';
import '@fontsource/sora/800.css';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';

// One entry point for all styles (tokens -> global -> components -> pages).
// Replaces the old reset / tokens / global / components / marketing-auth imports.
import './styles/index.css';

import './styles/native.css';
import { Capacitor } from '@capacitor/core';
import { initTheme } from './utils/theme';
import App from './App.jsx'

// Marks the page when it runs inside the Android app, so native.css can size things for a phone.
if (Capacitor.isNativePlatform()) document.documentElement.classList.add('is-native');
initTheme(); // set data-theme before the first paint

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

