import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
// Register agent-response hooks at boot. Side-effect-only imports; each
// hook registers itself with the registry in src/lib/agent-response-hooks.
import './lib/hooks/services-proposal'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
