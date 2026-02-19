import 'v8-compile-cache'
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  systemPreferences,
  type BrowserWindowConstructorOptions,
} from 'electron'
import { existsSync, statSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { arch, platform, release, tmpdir, version as osVersion } from 'os'
import { IPC } from '../shared/ipc-channels'
import type { ThemeChangedPayload, ThemePreference } from '../shared/ipc-channels'
import { debugLog, resolveDefaultShell } from '@shared/platform'
import { CREATE_WORKTREE_STAGES, type CreateWorktreeProgressEvent } from '../shared/workspace-creation'
import { registerIpcHandlers } from './ipc'
import { NotificationWatcher } from './notification-watcher'
import { loadWindowState, saveWindowState } from './window-state'
import { clearWindowActiveWorkspace } from './workspace-presence'

let mainWindow: BrowserWindow | null = null
const notificationWatcher = new NotificationWatcher()
let unreadWorkspaceCount = 0
let windowStateTimer: ReturnType<typeof setTimeout> | null = null
let pendingDirectoryToOpen = extractDirectoryFromArgv(process.argv)
let pendingThemePayload: ThemeChangedPayload | null = null
let waitingForRendererLoad = false
let themeUpdatedHandler: (() => void) | null = null
const allowMultiInstance = process.env.CI_TEST === '1' || process.env.TERMINATOR_CHAT_ALLOW_MULTI_INSTANCE === '1'
const customProfileName = process.env.TERMINATOR_CHAT_PROFILE?.trim()

// In dev, Vite requires relaxed CSP directives (`unsafe-eval`) and Electron prints
// a known warning on every run. Keep production warnings intact.
if (process.env.ELECTRON_RENDERER_URL) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
}

function setMainWindowProgress(progress: CreateWorktreeProgressEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const stageIndex = CREATE_WORKTREE_STAGES.indexOf(progress.stage)
  const value = stageIndex >= 0
    ? (stageIndex + 1) / CREATE_WORKTREE_STAGES.length
    : 0.1
  mainWindow.setProgressBar(value)
}

function clearMainWindowProgress(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setProgressBar(-1)
}

function createOverlayBadge(count: number) {
  const label = count > 99 ? '99+' : String(count)
  const fontSize = label.length > 2 ? 16 : 18
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">',
    '<circle cx="32" cy="32" r="30" fill="#d12d2d" />',
    `<text x="32" y="40" text-anchor="middle" font-size="${fontSize}" font-family="Segoe UI, sans-serif" font-weight="700" fill="#ffffff">${label}</text>`,
    '</svg>',
  ].join('')
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  return nativeImage.createFromDataURL(dataUrl).resize({ width: 32, height: 32 })
}

function syncUnreadOverlay(): void {
  if (!mainWindow || mainWindow.isDestroyed() || process.platform !== 'win32') return
  if (unreadWorkspaceCount <= 0) {
    mainWindow.setOverlayIcon(null, '')
    return
  }
  const badge = createOverlayBadge(unreadWorkspaceCount)
  mainWindow.setOverlayIcon(
    badge,
    `${unreadWorkspaceCount} unread workspace notification${unreadWorkspaceCount === 1 ? '' : 's'}`,
  )
}

function resolveMainWindowIconPath(): string | undefined {
  const icoCandidates = [
    join(app.getAppPath(), 'build', 'icon.ico'),
    join(process.resourcesPath, 'build', 'icon.ico'),
    join(process.resourcesPath, 'icon.ico'),
  ]
  for (const iconPath of icoCandidates) {
    if (existsSync(iconPath)) return iconPath
  }

  const pngCandidates = [
    join(app.getAppPath(), 'build', 'icon.png'),
    join(process.resourcesPath, 'build', 'icon.png'),
    join(process.resourcesPath, 'icon.png'),
  ]
  for (const iconPath of pngCandidates) {
    if (existsSync(iconPath)) return iconPath
  }
  return undefined
}

function scheduleWindowStateSave(): void {
  if (windowStateTimer) clearTimeout(windowStateTimer)
  windowStateTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    saveWindowState(mainWindow)
  }, 200)
}

function extractDirectoryFromArgv(argv: string[]): string | null {
  for (let i = argv.length - 1; i >= 1; i -= 1) {
    const rawArg = argv[i]?.trim()
    if (!rawArg) continue
    if (rawArg === '--') continue
    if (rawArg.startsWith('-')) continue
    if (/\.(js|cjs|mjs|asar)$/i.test(rawArg)) continue

    const candidate = rawArg.replace(/^"+|"+$/g, '')
    if (!isAbsolute(candidate)) continue

    try {
      const resolvedPath = resolve(candidate)
      if (statSync(resolvedPath).isDirectory()) {
        return resolvedPath
      }
    } catch {
      // Not an accessible directory argument.
    }
  }
  return null
}

function flushPendingWindowCommands(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (pendingThemePayload) {
    mainWindow.webContents.send(IPC.THEME_CHANGED, pendingThemePayload)
    pendingThemePayload = null
  }
  if (pendingDirectoryToOpen) {
    mainWindow.webContents.send(IPC.APP_OPEN_DIRECTORY, pendingDirectoryToOpen)
    pendingDirectoryToOpen = null
  }
}

function schedulePendingWindowCommandFlush(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!mainWindow.webContents.isLoadingMainFrame()) {
    flushPendingWindowCommands()
    return
  }
  if (waitingForRendererLoad) return
  waitingForRendererLoad = true
  mainWindow.webContents.once('did-finish-load', () => {
    waitingForRendererLoad = false
    flushPendingWindowCommands()
  })
}

function requestOpenDirectory(dirPath: string): void {
  pendingDirectoryToOpen = dirPath
  schedulePendingWindowCommandFlush()
}

function formatAccentColor(rawColor: string): string {
  const cleaned = rawColor.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{8}$/.test(cleaned)) return `#${cleaned.slice(2)}`
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) return `#${cleaned}`
  return '#58abff'
}

function getThemePayload(): ThemeChangedPayload {
  return {
    dark: nativeTheme.shouldUseDarkColors,
    accentColor: formatAccentColor(systemPreferences.getAccentColor()),
  }
}

function broadcastThemeChanged(): void {
  const payload = getThemePayload()
  pendingThemePayload = payload
  schedulePendingWindowCommandFlush()
}

function notifyWindowMaximizedChanged(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IPC.APP_WINDOW_MAXIMIZED_CHANGED, mainWindow.isMaximized())
}

function createWindow(): void {
  const isWindows = process.platform === 'win32'
  const darkTheme = nativeTheme.shouldUseDarkColors
  const initialWindowState = loadWindowState()
  const windowOptions: BrowserWindowConstructorOptions = {
    x: initialWindowState.bounds?.x,
    y: initialWindowState.bounds?.y,
    width: initialWindowState.bounds?.width ?? 1400,
    height: initialWindowState.bounds?.height ?? 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: darkTheme ? '#121013' : '#f3f5f7',
    show: false,
    frame: !isWindows,
    autoHideMenuBar: true,
    titleBarStyle: 'default',
    titleBarOverlay: false,
    icon: resolveMainWindowIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  }

  mainWindow = new BrowserWindow(windowOptions)
  const windowRef = mainWindow
  mainWindow.removeMenu()
  mainWindow.setMenuBarVisibility(false)
  syncUnreadOverlay()
  windowRef.on('closed', () => {
    clearWindowActiveWorkspace(windowRef)
  })
  mainWindow.on('move', scheduleWindowStateSave)
  mainWindow.on('resize', scheduleWindowStateSave)
  mainWindow.on('maximize', () => {
    scheduleWindowStateSave()
    notifyWindowMaximizedChanged()
  })
  mainWindow.on('unmaximize', () => {
    scheduleWindowStateSave()
    notifyWindowMaximizedChanged()
  })

  // Show window when ready to avoid white flash (skip in tests)
  if (!process.env.CI_TEST) {
    mainWindow.on('ready-to-show', () => {
      mainWindow?.show()
      if (initialWindowState.isMaximized) {
        mainWindow?.maximize()
      }
      notifyWindowMaximizedChanged()
    })
  } else if (initialWindowState.isMaximized) {
    mainWindow.maximize()
  }

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Open DevTools in dev mode for debugging
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.webContents.on('did-finish-load', () => {
    notifyWindowMaximizedChanged()
  })

  schedulePendingWindowCommandFlush()
}

app.setName('Terminator Chat')
if (process.platform === 'win32') {
  app.setAppUserModelId('com.terminator-chat.app')
}

app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

if (customProfileName) {
  const safeProfileName = customProfileName.replace(/[^a-zA-Z0-9_-]/g, '-')
  app.setPath('userData', join(app.getPath('appData'), `TerminatorChat-${safeProfileName}`))
}

const hasSingleInstanceLock = allowMultiInstance ? true : app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

function setupWindowsJumpList(): void {
  if (process.platform !== 'win32') return

  app.setJumpList([
    {
      type: 'tasks',
      items: [
        {
          type: 'task',
          title: 'New Chat',
          description: 'Start Terminator Chat and open a new chat',
          program: process.execPath,
          args: '--jump-new-chat',
          iconPath: process.execPath,
          iconIndex: 0,
        },
        {
          type: 'task',
          title: 'Open Project',
          description: 'Start Terminator Chat and open the project picker',
          program: process.execPath,
          args: '--jump-open-project',
          iconPath: process.execPath,
          iconIndex: 0,
        },
      ],
    },
  ])
}

// Isolate test data so e2e tests never touch real app state
if (process.env.CI_TEST) {
  const { mkdtempSync } = require('fs')
  const { join } = require('path')
  const testData = mkdtempSync(join(require('os').tmpdir(), 'terminator-chat-test-'))
  app.setPath('userData', testData)
}

if (hasSingleInstanceLock && !allowMultiInstance) {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }

    const requestedDirectory = extractDirectoryFromArgv(argv)
    if (requestedDirectory) {
      requestOpenDirectory(requestedDirectory)
    }
  })
}

if (hasSingleInstanceLock || allowMultiInstance) {
  app.whenReady().then(() => {
    const detectedShell = resolveDefaultShell()
    debugLog('Startup info', {
      platform: platform(),
      release: release(),
      version: osVersion(),
      arch: arch(),
      detectedShell,
      tempDir: tmpdir(),
      appPaths: {
        appPath: app.getAppPath(),
        exe: app.getPath('exe'),
        home: app.getPath('home'),
        appData: app.getPath('appData'),
        userData: app.getPath('userData'),
        temp: app.getPath('temp'),
        logs: app.getPath('logs'),
      },
    })

    Menu.setApplicationMenu(null)
    setupWindowsJumpList()

    registerIpcHandlers({
      onCreateWorktreeProgress: setMainWindowProgress,
      onCreateWorktreeComplete: clearMainWindowProgress,
      onUnreadCountChanged: (count) => {
        unreadWorkspaceCount = count
        syncUnreadOverlay()
      },
      onThemePreferenceChanged: (themePreference: ThemePreference) => {
        nativeTheme.themeSource = themePreference
        broadcastThemeChanged()
      },
    })
    themeUpdatedHandler = () => {
      broadcastThemeChanged()
    }
    nativeTheme.on('updated', themeUpdatedHandler)
    if (process.platform === 'win32') {
      systemPreferences.on('accent-color-changed', themeUpdatedHandler)
    }
    notificationWatcher.start()
    createWindow()
    broadcastThemeChanged()

    if (pendingDirectoryToOpen) {
      requestOpenDirectory(pendingDirectoryToOpen)
    }
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  if (windowStateTimer) {
    clearTimeout(windowStateTimer)
    windowStateTimer = null
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    saveWindowState(mainWindow)
  }
  if (themeUpdatedHandler) {
    nativeTheme.removeListener('updated', themeUpdatedHandler)
    if (process.platform === 'win32') {
      systemPreferences.removeListener('accent-color-changed', themeUpdatedHandler)
    }
    themeUpdatedHandler = null
  }
  notificationWatcher.stop()
})
