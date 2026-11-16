import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
// Register agent-response hooks at boot. Side-effect-only imports; each
// hook registers itself with the registry in src/lib/agent-response-hooks.
import './lib/hooks/services-proposal'

// The Tauri launcher appends ?desktop=1. Persist that fact for the auth flow
// and remove it from the URL so conversation routing stays clean.
const desktopFlag = new URLSearchParams(window.location.search).get('desktop')
if (desktopFlag === '1') {
  try {
    localStorage.setItem('ai-coder:desktop', '1')
  } catch {
    // ignore storage errors
  }
  const url = new URL(window.location.href)
  url.searchParams.delete('desktop')
  window.history.replaceState(
    null,
    '',
    url.pathname + (url.search ? url.search : '') + url.hash
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
