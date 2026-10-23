import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { api } from './api'
import './styles.css'

window.addEventListener('error', (e) => {
  const err = e.error instanceof Error ? (e.error.stack ?? e.error.message) : String(e.message)
  void api.log.write('error', 'window', err).catch(() => {})
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason instanceof Error ? (e.reason.stack ?? e.reason.message) : String(e.reason)
  void api.log.write('error', 'promise', r).catch(() => {})
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
