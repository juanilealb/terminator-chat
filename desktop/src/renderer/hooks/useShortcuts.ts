import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'

export function useShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.ctrlKey
      const shift = e.shiftKey
      const alt = e.altKey
      if (!meta) return

      const store = useAppStore.getState()

      function consume() {
        e.preventDefault()
        e.stopPropagation()
      }

      // Quick open: Ctrl+P
      if (!shift && !alt && e.key === 'p') {
        consume()
        store.toggleQuickOpen()
        return
      }
      if (shift && !alt && e.key.toLowerCase() === 'p') {
        consume()
        store.toggleCommandPalette()
        return
      }

      // Tab switching: Ctrl+1-9
      if (!shift && !alt && e.key >= '1' && e.key <= '9') {
        consume()
        store.switchToTabByIndex(parseInt(e.key) - 1)
        return
      }

      // Workspace switching: Ctrl+Shift+Up / Ctrl+Shift+Down
      if (shift && !alt && e.key === 'ArrowUp') {
        consume()
        store.prevWorkspace()
        return
      }
      if (shift && !alt && e.key === 'ArrowDown') {
        consume()
        store.nextWorkspace()
        return
      }

      // Tab management
      if (!shift && !alt && e.key === 't') {
        consume()
        void store.openNewThreadDialog()
        return
      }
      if (shift && !alt && e.code === 'KeyN') {
        consume()
        void store.openNewThreadDialog()
        return
      }
      if (!shift && !alt && e.key === 'w') {
        consume()
        store.closeActiveTab()
        return
      }
      if (shift && !alt && e.code === 'KeyW') {
        consume()
        store.closeAllWorkspaceTabs()
        return
      }
      if (shift && !alt && e.key === ']') {
        consume()
        store.nextTab()
        return
      }
      if (shift && !alt && e.key === '[') {
        consume()
        store.prevTab()
        return
      }

      // Panels
      if (!shift && !alt && e.key === 'b') {
        consume()
        store.toggleSidebar()
        return
      }
      if (shift && !alt && e.code === 'KeyB') {
        consume()
        store.toggleSidebar()
        return
      }
      if (!shift && alt && e.code === 'KeyB') {
        consume()
        store.toggleRightPanel()
        return
      }
      if (shift && !alt && e.code === 'KeyE') {
        consume()
        store.setRightPanelMode('files')
        if (!store.rightPanelOpen) store.toggleRightPanel()
        return
      }
      if (shift && !alt && e.code === 'KeyG') {
        consume()
        store.setRightPanelMode('changes')
        if (!store.rightPanelOpen) store.toggleRightPanel()
        return
      }
      if (shift && !alt && e.code === 'KeyM') {
        consume()
        store.setRightPanelMode('memory')
        if (!store.rightPanelOpen) store.toggleRightPanel()
        return
      }
      // Focus chat
      if (!shift && !alt && e.key === 'j') {
        consume()
        store.focusOrCreateChat()
        return
      }

      // Font size: Ctrl+= / Ctrl+- / Ctrl+0
      if (!shift && !alt && (e.key === '=' || e.key === '-' || e.key === '0')) {
        consume()
        if (e.key === '0') {
          store.updateSettings({ editorFontSize: 13 })
        } else {
          const current = store.settings.editorFontSize
          const next = Math.max(8, Math.min(32, current + (e.key === '=' ? 1 : -1)))
          store.updateSettings({ editorFontSize: next })
        }
        return
      }

      // Settings
      if (!shift && !alt && e.key === ',') {
        consume()
        store.toggleSettings()
        return
      }

      // Workspace creation
      if (!shift && !alt && e.key === 'n') {
        consume()
        void store.openNewThreadDialog()
      }
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])
}
