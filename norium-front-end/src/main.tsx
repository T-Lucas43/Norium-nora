import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/index.css'
import './index.css'
import './styles/tokens.css'
import './styles/interface-theme.css'
import './styles/layout-v2.css'
import './styles/ui-v2.css'
import App from './App.tsx'
import { installNoriumFetchAuth } from './utils/api'
import AppDialogProvider from './components/shared/AppDialogProvider.tsx'

installNoriumFetchAuth()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppDialogProvider>
      <App />
    </AppDialogProvider>
  </StrictMode>,
)

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // A instalacao como app continua disponivel quando o navegador aceitar o registro.
    });
  });
}
