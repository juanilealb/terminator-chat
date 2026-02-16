import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { useAppStore, hydrateFromDisk } from './store/app-store'
import './styles/global.css'

if (import.meta.env.DEV) {
  const originalInfo = console.info.bind(console)
  console.info = (...args: unknown[]) => {
    const first = args[0]
    if (typeof first === 'string' && first.includes('Download the React DevTools for a better development experience')) {
      return
    }
    originalInfo(...args)
  }
}

// Expose store for e2e testing
;(window as any).__store = useAppStore

// Hydrate persisted state before rendering to avoid UI flicker.
hydrateFromDisk().then(() => {
  const root = createRoot(document.getElementById('root')!)
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
