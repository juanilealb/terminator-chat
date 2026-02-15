import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Allotment } from 'allotment'
import { FluentProvider, webDarkTheme, webLightTheme, type Theme } from '@fluentui/react-components'
import type { ThemeChangedPayload, ThemePreference } from '@shared/ipc-channels'
import { formatShortcut } from '@shared/platform'
import { SHORTCUT_MAP } from '@shared/shortcuts'
import 'allotment/dist/style.css'
import { useAppStore } from './store/app-store'
import { Sidebar } from './components/Sidebar/Sidebar'
import { SidebarRail } from './components/Sidebar/SidebarRail'
import { TabBar } from './components/TabBar/TabBar'
import { TerminalPanel } from './components/Terminal/TerminalPanel'
import { FileEditor } from './components/Editor/FileEditor'
import { DiffViewer } from './components/Editor/DiffEditor'
import { RightPanel } from './components/RightPanel/RightPanel'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { AutomationsPanel } from './components/Automations/AutomationsPanel'
import { QuickOpen } from './components/QuickOpen/QuickOpen'
import { CommandPalette } from './components/CommandPalette/CommandPalette'
import { ToastContainer } from './components/Toast/Toast'
import { useShortcuts } from './hooks/useShortcuts'
import { usePrStatusPoller } from './hooks/usePrStatusPoller'
import styles from './App.module.css'

const DEFAULT_THEME: ThemeChangedPayload = {
  dark: true,
  accentColor: '#58abff',
}

/** Custom dark theme: override Fluent neutral tokens to match the sidebar's warm-dark palette */
const customDarkTheme: Theme = {
  ...webDarkTheme,
  // Backgrounds — deep blacks with warm purple tint
  colorNeutralBackground1: '#151218',
  colorNeutralBackground1Hover: '#1a171e',
  colorNeutralBackground1Pressed: '#121013',
  colorNeutralBackground1Selected: '#1a171e',
  colorNeutralBackground2: '#1a171e',
  colorNeutralBackground2Hover: '#211b21',
  colorNeutralBackground2Pressed: '#2b232b',
  colorNeutralBackground2Selected: '#2a2230',
  colorNeutralBackground3: '#1e1a22',
  colorNeutralBackground4: '#211b21',
  colorNeutralBackground5: '#2a2428',
  colorNeutralBackground6: '#2b232b',
  colorNeutralBackgroundStatic: '#1e1a22',
  colorNeutralBackgroundAlpha: 'rgba(18, 16, 19, 0.5)',
  colorNeutralBackgroundAlpha2: 'rgba(18, 16, 19, 0.7)',
  colorNeutralBackgroundInverted: '#f4edf7',
  colorNeutralBackgroundInvertedDisabled: 'rgba(244, 237, 247, 0.1)',
  // Subtle backgrounds — hover/pressed/selected states
  colorSubtleBackground: 'transparent',
  colorSubtleBackgroundHover: '#2b232b',
  colorSubtleBackgroundPressed: '#332936',
  colorSubtleBackgroundSelected: '#2a2230',
  colorSubtleBackgroundLightAlphaHover: 'rgba(43, 35, 43, 0.7)',
  colorSubtleBackgroundLightAlphaPressed: 'rgba(51, 41, 54, 0.5)',
  colorSubtleBackgroundLightAlphaSelected: 'transparent',
  colorSubtleBackgroundInverted: 'transparent',
  colorSubtleBackgroundInvertedHover: 'rgba(0, 0, 0, 0.1)',
  colorSubtleBackgroundInvertedPressed: 'rgba(0, 0, 0, 0.3)',
  colorSubtleBackgroundInvertedSelected: 'rgba(0, 0, 0, 0.2)',
  // Strokes — subtle low-contrast borders
  colorNeutralStroke1: '#3f3340',
  colorNeutralStroke1Hover: '#544458',
  colorNeutralStroke1Pressed: '#3f3340',
  colorNeutralStroke1Selected: '#544458',
  colorNeutralStroke2: '#2e2630',
  colorNeutralStrokeAccessible: '#544458',
  colorNeutralStrokeAccessibleHover: '#6e5e70',
  colorNeutralStrokeAccessiblePressed: '#544458',
  colorNeutralStrokeAccessibleSelected: '#58abff',
  colorNeutralStrokeAlpha: 'rgba(62, 51, 64, 0.4)',
  colorNeutralStrokeAlpha2: 'rgba(62, 51, 64, 0.2)',
  colorNeutralStrokeOnBrand: '#121013',
  colorNeutralStrokeOnBrand2: '#121013',
  colorNeutralStrokeOnBrand2Hover: '#121013',
  colorNeutralStrokeOnBrand2Pressed: '#121013',
  colorNeutralStrokeOnBrand2Selected: '#121013',
  // Foreground — high-contrast text with warm tint
  colorNeutralForeground1: '#f4edf7',
  colorNeutralForeground1Hover: '#f4edf7',
  colorNeutralForeground1Pressed: '#f4edf7',
  colorNeutralForeground1Selected: '#f4edf7',
  colorNeutralForeground2: '#b8adb8',
  colorNeutralForeground2Hover: '#f4edf7',
  colorNeutralForeground2Pressed: '#f4edf7',
  colorNeutralForeground2Selected: '#f4edf7',
  colorNeutralForeground2BrandHover: '#58abff',
  colorNeutralForeground2BrandPressed: '#58abff',
  colorNeutralForeground2BrandSelected: '#58abff',
  colorNeutralForeground3: '#7f7380',
  colorNeutralForeground3Hover: '#b8adb8',
  colorNeutralForeground3Pressed: '#b8adb8',
  colorNeutralForeground3Selected: '#b8adb8',
  colorNeutralForeground3BrandHover: '#58abff',
  colorNeutralForeground3BrandPressed: '#58abff',
  colorNeutralForeground3BrandSelected: '#58abff',
  colorNeutralForeground4: '#6e5e70',
  colorNeutralForegroundDisabled: '#544458',
  colorNeutralForegroundInverted: '#121013',
  colorNeutralForegroundInvertedHover: '#121013',
  colorNeutralForegroundInvertedPressed: '#121013',
  colorNeutralForegroundInvertedSelected: '#121013',
  colorNeutralForegroundInvertedDisabled: 'rgba(18, 16, 19, 0.4)',
  colorNeutralForegroundOnBrand: '#121013',
  // Shadows — deeper for dark theme
  colorNeutralShadowAmbient: 'rgba(0, 0, 0, 0.30)',
  colorNeutralShadowKey: 'rgba(0, 0, 0, 0.36)',
  colorNeutralShadowAmbientLighter: 'rgba(0, 0, 0, 0.16)',
  colorNeutralShadowKeyLighter: 'rgba(0, 0, 0, 0.20)',
  colorNeutralShadowAmbientDarker: 'rgba(0, 0, 0, 0.44)',
  colorNeutralShadowKeyDarker: 'rgba(0, 0, 0, 0.52)',
}

function hexToRgba(hex: string, alpha: number): string | null {
  const cleaned = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null
  const r = Number.parseInt(cleaned.slice(0, 2), 16)
  const g = Number.parseInt(cleaned.slice(2, 4), 16)
  const b = Number.parseInt(cleaned.slice(4, 6), 16)
  if ([r, g, b].some((value) => Number.isNaN(value))) return null
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function applyThemeToDocument(theme: ThemeChangedPayload, preference: ThemePreference): void {
  const isDark = preference === 'system' ? theme.dark : preference === 'dark'
  const root = document.documentElement
  root.dataset.theme = isDark ? 'dark' : 'light'

  root.style.setProperty('--accent-system', theme.accentColor)
  root.style.setProperty('--accent-blue', theme.accentColor)

  const accentDim = hexToRgba(theme.accentColor, 0.22)
  const accentGlow = hexToRgba(theme.accentColor, 0.26)
  if (accentDim) root.style.setProperty('--accent-blue-dim', accentDim)
  if (accentGlow) root.style.setProperty('--accent-blue-glow', accentGlow)
}

export function App() {
  useShortcuts()
  usePrStatusPoller()
  const [osTheme, setOsTheme] = useState<ThemeChangedPayload>(DEFAULT_THEME)

  // Listen for workspace notification signals from Claude Code hooks
  useEffect(() => {
    const unsub = window.api.claude.onNotifyWorkspace(({ workspaceId, reason }) => {
      const state = useAppStore.getState()
      if (workspaceId !== state.activeWorkspaceId) {
        state.markWorkspaceUnread(workspaceId)
        return
      }

      const workspaceName = state.workspaces.find((ws) => ws.id === workspaceId)?.name ?? workspaceId
      const message = reason === 'waiting_input'
        ? `Agent waiting for your input in ${workspaceName}`
        : `Agent completed in ${workspaceName}`
      state.addToast({ id: crypto.randomUUID(), message, type: 'info' })
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.api.app.onActivateWorkspace((workspaceId: string) => {
      const state = useAppStore.getState()
      if (state.workspaces.some((w) => w.id === workspaceId)) {
        state.setActiveWorkspace(workspaceId)
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.api.app.onOpenDirectory((dirPath: string) => {
      void useAppStore.getState().openDirectory(dirPath)
    })
    return unsub
  }, [])

  // Listen for agent activity updates (Claude hooks + Codex submit/notify markers)
  useEffect(() => {
    const unsub = window.api.claude.onActivityUpdate((snapshot) => {
      useAppStore.getState().setClaudeActivitySnapshot(snapshot)
    })
    return unsub
  }, [])

  const {
    tabs: allTabs,
    activeTabId,
    rightPanelOpen,
    sidebarCollapsed,
    activeWorkspaceTabs,
    workspaces,
    activeWorkspaceId,
    settings,
    settingsOpen,
    automationsOpen,
    quickOpenVisible,
    commandPaletteVisible,
    runningAgentCount,
    waitingAgentCount,
  } = useAppStore()
  const unreadWorkspaceCount = useAppStore((s) => s.unreadWorkspaceIds.size)

  const wsTabs = activeWorkspaceTabs()
  const activeTab = wsTabs.find((t) => t.id === activeTabId)
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const activeAgents = runningAgentCount
  const waitingAgents = waitingAgentCount
  const appStyle = {
    '--window-controls-width': '0px',
    '--window-controls-width-tabbar': '0px',
    '--window-controls-width-right-panel': '0px',
  } as CSSProperties

  // All terminal tabs across every workspace — kept alive to preserve PTY state
  const allTerminals = allTabs.filter((t): t is Extract<typeof t, { type: 'terminal' }> => t.type === 'terminal')

  useEffect(() => {
    window.api.app.setUnreadCount(unreadWorkspaceCount)
  }, [unreadWorkspaceCount])

  useEffect(() => {
    const unsub = window.api.app.onThemeChanged((payload) => {
      setOsTheme(payload)
    })
    return unsub
  }, [])

  useEffect(() => {
    window.api.app.setThemePreference(settings.themePreference)
  }, [settings.themePreference])

  const isDark = settings.themePreference === 'system' ? osTheme.dark : settings.themePreference === 'dark'
  const fluentTheme = useMemo(() => isDark ? customDarkTheme : webLightTheme, [isDark])

  useEffect(() => {
    applyThemeToDocument(osTheme, settings.themePreference)
  }, [osTheme, settings.themePreference])

  return (
    <FluentProvider theme={fluentTheme} style={{ background: 'transparent' }}>
      <div className={styles.app} style={appStyle}>
        <div className={styles.layout}>
          {settingsOpen ? (
            <SettingsPanel />
          ) : automationsOpen ? (
            <AutomationsPanel />
          ) : (
            <Allotment>
              {/* Sidebar */}
              {sidebarCollapsed ? (
                <Allotment.Pane minSize={44} maxSize={62} preferredSize={48}>
                  <SidebarRail />
                </Allotment.Pane>
              ) : (
                <Allotment.Pane minSize={180} maxSize={420} preferredSize={240}>
                  <Sidebar />
                </Allotment.Pane>
              )}

              {/* Center */}
              <Allotment.Pane>
                <div className={styles.centerPanel}>
                  <TabBar />
                  <div className={styles.contentArea}>
                    {/* Keep ALL terminal panels alive across workspaces so PTY
                        state (scrollback, TUI layout) is never lost */}
                    {allTerminals.map((t) => (
                      <TerminalPanel
                        key={t.id}
                        ptyId={t.ptyId}
                        active={t.id === activeTabId}
                      />
                    ))}

                    {!activeTab ? (
                      <div className={styles.welcome}>
                        <div className={styles.welcomeLogo}>terminator</div>
                        <div className={styles.welcomeHint}>
                          Add a project to get started, or press
                          <span className={styles.welcomeShortcut}>
                            <kbd>{formatShortcut(SHORTCUT_MAP.newTerminal.mac, SHORTCUT_MAP.newTerminal.win)}</kbd>
                          </span>
                          for a new terminal
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Render active file editor */}
                        {activeTab?.type === 'file' && (
                          <FileEditor
                            key={activeTab.id}
                            tabId={activeTab.id}
                            filePath={activeTab.filePath}
                            active={true}
                          />
                        )}

                        {/* Render active diff viewer */}
                        {activeTab?.type === 'diff' && workspace && (
                          <DiffViewer
                            key={activeTab.id}
                            worktreePath={workspace.worktreePath}
                            active={true}
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>
              </Allotment.Pane>

              {/* Right Panel */}
              {rightPanelOpen && (
                <Allotment.Pane minSize={200} maxSize={500} preferredSize={280}>
                  <RightPanel />
                </Allotment.Pane>
              )}
            </Allotment>
          )}
        </div>
        <div className={styles.statusBar}>
          <div className={styles.statusGroup}>
            <div className={styles.statusItem}>
              <span className={`${styles.dot} ${workspace ? styles.dotConnected : styles.dotNeutral}`} />
              <span>Workspace</span>
            </div>
            <div className={styles.statusItem}>
              <span>{workspace ? workspace.name : 'No workspace selected'}</span>
            </div>
            {workspace?.branch && (
              <div className={styles.statusItem}>
                <span>{workspace.branch}</span>
              </div>
            )}
          </div>
          <div className={styles.statusGroup}>
            <div className={styles.statusItem}>
              <span>{wsTabs.length} tabs</span>
            </div>
            <div className={styles.statusItem}>
              <span className={`${styles.dot} ${activeAgents > 0 ? styles.dotConnected : styles.dotIdle}`} />
              <span>
                {activeAgents > 0
                  ? `${activeAgents} agents running`
                  : waitingAgents > 0
                    ? `${waitingAgents} waiting for input`
                    : 'Agents idle'}
              </span>
            </div>
          </div>
        </div>
        {quickOpenVisible && workspace && (
          <QuickOpen worktreePath={workspace.worktreePath} />
        )}
        {commandPaletteVisible && <CommandPalette />}
        <ToastContainer />
      </div>
    </FluentProvider>
  )
}
