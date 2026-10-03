import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Fonts, hosted by the app itself (no request to Google Fonts, so they load on any network)
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

import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
