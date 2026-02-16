import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  AgentActivitySnapshot,
  AgentNotifyEvent,
  ChatEventPayload,
  ThemeChangedPayload,
  ThemePreference,
} from '../shared/ipc-channels'
import type { CreateWorktreeProgressEvent } from '../shared/workspace-creation'

const openDirectoryListeners = new Set<(dirPath: string) => void>()
const pendingDirectoryPaths: string[] = []
const themeListeners = new Set<(payload: ThemeChangedPayload) => void>()
let latestThemePayload: ThemeChangedPayload | null = null

ipcRenderer.on(IPC.APP_OPEN_DIRECTORY, (_event, dirPath: string) => {
  if (openDirectoryListeners.size === 0) {
    pendingDirectoryPaths.push(dirPath)
    return
  }
  for (const listener of openDirectoryListeners) {
    listener(dirPath)
  }
})

ipcRenderer.on(IPC.THEME_CHANGED, (_event, payload: ThemeChangedPayload) => {
  latestThemePayload = payload
  for (const listener of themeListeners) {
    listener(payload)
  }
})

const api = {
  git: {
    listWorktrees: (repoPath: string) =>
      ipcRenderer.invoke(IPC.GIT_LIST_WORKTREES, repoPath),
    createWorktree: (repoPath: string, name: string, branch: string, newBranch: boolean, baseBranch?: string, force?: boolean, requestId?: string) =>
      ipcRenderer.invoke(IPC.GIT_CREATE_WORKTREE, repoPath, name, branch, newBranch, baseBranch, force, requestId),
    createWorktreeFromPr: (repoPath: string, name: string, prNumber: number, localBranch: string, force?: boolean, requestId?: string) =>
      ipcRenderer.invoke(IPC.GIT_CREATE_WORKTREE_FROM_PR, repoPath, name, prNumber, localBranch, force, requestId) as Promise<{ worktreePath: string; branch: string }>,
    onCreateWorktreeProgress: (callback: (progress: CreateWorktreeProgressEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: CreateWorktreeProgressEvent) => callback(progress)
      ipcRenderer.on(IPC.GIT_CREATE_WORKTREE_PROGRESS, listener)
      return () => {
        ipcRenderer.removeListener(IPC.GIT_CREATE_WORKTREE_PROGRESS, listener)
      }
    },
    removeWorktree: (repoPath: string, worktreePath: string) =>
      ipcRenderer.invoke(IPC.GIT_REMOVE_WORKTREE, repoPath, worktreePath),
    getStatus: (worktreePath: string) =>
      ipcRenderer.invoke(IPC.GIT_GET_STATUS, worktreePath),
    getDiff: (worktreePath: string, staged: boolean) =>
      ipcRenderer.invoke(IPC.GIT_GET_DIFF, worktreePath, staged),
    getFileDiff: (worktreePath: string, filePath: string) =>
      ipcRenderer.invoke(IPC.GIT_GET_FILE_DIFF, worktreePath, filePath),
    getBranches: (repoPath: string) =>
      ipcRenderer.invoke(IPC.GIT_GET_BRANCHES, repoPath),
    stage: (worktreePath: string, paths: string[]) =>
      ipcRenderer.invoke(IPC.GIT_STAGE, worktreePath, paths),
    unstage: (worktreePath: string, paths: string[]) =>
      ipcRenderer.invoke(IPC.GIT_UNSTAGE, worktreePath, paths),
    discard: (worktreePath: string, paths: string[], untracked: string[]) =>
      ipcRenderer.invoke(IPC.GIT_DISCARD, worktreePath, paths, untracked),
    commit: (worktreePath: string, message: string) =>
      ipcRenderer.invoke(IPC.GIT_COMMIT, worktreePath, message),
    pushCurrentBranch: (worktreePath: string) =>
      ipcRenderer.invoke(IPC.GIT_PUSH_CURRENT_BRANCH, worktreePath) as Promise<{ branch: string }>,
    openOrCreatePr: (worktreePath: string) =>
      ipcRenderer.invoke(IPC.GIT_OPEN_OR_CREATE_PR, worktreePath) as Promise<{
        url: string
        created: boolean
        branch: string
      }>,
    shipBranchToMain: (repoPath: string, sourceBranch: string) =>
      ipcRenderer.invoke(IPC.GIT_SHIP_BRANCH_TO_MAIN, repoPath, sourceBranch) as Promise<{
        mainBranch: string
        prUrl: string | null
        prCreated: boolean
      }>,
    getCurrentBranch: (worktreePath: string) =>
      ipcRenderer.invoke(IPC.GIT_GET_CURRENT_BRANCH, worktreePath) as Promise<string>,
    getDefaultBranch: (repoPath: string) =>
      ipcRenderer.invoke(IPC.GIT_GET_DEFAULT_BRANCH, repoPath) as Promise<string>,
    createSnapshot: (worktreePath: string, label?: string) =>
      ipcRenderer.invoke(IPC.GIT_CREATE_SNAPSHOT, worktreePath, label) as Promise<{
        ref: string
        label: string
        createdAt: number
      } | null>,
    listSnapshots: (worktreePath: string) =>
      ipcRenderer.invoke(IPC.GIT_LIST_SNAPSHOTS, worktreePath) as Promise<Array<{
        ref: string
        label: string
        createdAt: number
      }>>,
    restoreSnapshot: (worktreePath: string, ref: string) =>
      ipcRenderer.invoke(IPC.GIT_RESTORE_SNAPSHOT, worktreePath, ref),
    dropSnapshot: (worktreePath: string, ref: string) =>
      ipcRenderer.invoke(IPC.GIT_DROP_SNAPSHOT, worktreePath, ref),
  },

  fs: {
    getTree: (dirPath: string) =>
      ipcRenderer.invoke(IPC.FS_GET_TREE, dirPath),
    getTreeWithStatus: (dirPath: string) =>
      ipcRenderer.invoke(IPC.FS_GET_TREE_WITH_STATUS, dirPath),
    readFile: (filePath: string) =>
      ipcRenderer.invoke(IPC.FS_READ_FILE, filePath),
    writeFile: (filePath: string, content: string) =>
      ipcRenderer.invoke(IPC.FS_WRITE_FILE, filePath, content),
    watchDir: (dirPath: string) =>
      ipcRenderer.invoke(IPC.FS_WATCH_START, dirPath),
    unwatchDir: (dirPath: string) =>
      ipcRenderer.send(IPC.FS_WATCH_STOP, dirPath),
    onDirChanged: (callback: (dirPath: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, dirPath: string) => callback(dirPath)
      ipcRenderer.on(IPC.FS_WATCH_CHANGED, listener)
      return () => {
        ipcRenderer.removeListener(IPC.FS_WATCH_CHANGED, listener)
      }
    },
  },

  app: {
    selectDirectory: () =>
      ipcRenderer.invoke(IPC.APP_SELECT_DIRECTORY),
    addProjectPath: (dirPath: string) =>
      ipcRenderer.invoke(IPC.APP_ADD_PROJECT_PATH, dirPath),
    getDataPath: () =>
      ipcRenderer.invoke(IPC.APP_GET_DATA_PATH),
    setUnreadCount: (count: number) =>
      ipcRenderer.send(IPC.APP_SET_UNREAD_COUNT, count),
    setActiveWorkspace: (workspaceId: string | null) =>
      ipcRenderer.send(IPC.APP_SET_ACTIVE_WORKSPACE, workspaceId),
    setThemePreference: (themePreference: ThemePreference) =>
      ipcRenderer.send(IPC.APP_SET_THEME_SOURCE, themePreference),
    minimizeWindow: () =>
      ipcRenderer.send(IPC.APP_WINDOW_MINIMIZE),
    toggleMaximizeWindow: () =>
      ipcRenderer.send(IPC.APP_WINDOW_TOGGLE_MAXIMIZE),
    closeWindow: () =>
      ipcRenderer.send(IPC.APP_WINDOW_CLOSE),
    isWindowMaximized: () =>
      ipcRenderer.invoke(IPC.APP_WINDOW_IS_MAXIMIZED) as Promise<boolean>,
    openInVSCode: (dirPath: string) =>
      ipcRenderer.invoke(IPC.APP_OPEN_IN_VSCODE, dirPath) as Promise<{
        ok: boolean
        error?: string
      }>,
    openInCursor: (dirPath: string) =>
      ipcRenderer.invoke(IPC.APP_OPEN_IN_CURSOR, dirPath) as Promise<{
        ok: boolean
        error?: string
      }>,
    onOpenDirectory: (callback: (dirPath: string) => void) => {
      openDirectoryListeners.add(callback)
      while (pendingDirectoryPaths.length > 0) {
        const next = pendingDirectoryPaths.shift()
        if (next) callback(next)
      }
      return () => {
        openDirectoryListeners.delete(callback)
      }
    },
    onThemeChanged: (callback: (payload: ThemeChangedPayload) => void) => {
      themeListeners.add(callback)
      if (latestThemePayload) callback(latestThemePayload)
      return () => {
        themeListeners.delete(callback)
      }
    },
    onWindowMaximizedChange: (callback: (maximized: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, maximized: boolean) => callback(maximized)
      ipcRenderer.on(IPC.APP_WINDOW_MAXIMIZED_CHANGED, listener)
      return () => {
        ipcRenderer.removeListener(IPC.APP_WINDOW_MAXIMIZED_CHANGED, listener)
      }
    },
    onActivateWorkspace: (callback: (workspaceId: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, workspaceId: string) => callback(workspaceId)
      ipcRenderer.on(IPC.ACTIVATE_WORKSPACE, listener)
      return () => {
        ipcRenderer.removeListener(IPC.ACTIVATE_WORKSPACE, listener)
      }
    },
  },

  claude: {
    trustPath: (dirPath: string) =>
      ipcRenderer.invoke(IPC.CLAUDE_TRUST_PATH, dirPath),
    installHooks: () =>
      ipcRenderer.invoke(IPC.CLAUDE_INSTALL_HOOKS),
    uninstallHooks: () =>
      ipcRenderer.invoke(IPC.CLAUDE_UNINSTALL_HOOKS),
    checkHooks: () =>
      ipcRenderer.invoke(IPC.CLAUDE_CHECK_HOOKS),
    onNotifyWorkspace: (callback: (event: AgentNotifyEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AgentNotifyEvent | string) => {
        if (typeof payload === 'string') {
          callback({ workspaceId: payload, reason: 'completed' })
          return
        }
        callback(payload)
      }
      ipcRenderer.on(IPC.CLAUDE_NOTIFY_WORKSPACE, listener)
      return () => {
        ipcRenderer.removeListener(IPC.CLAUDE_NOTIFY_WORKSPACE, listener)
      }
    },
    onActivityUpdate: (callback: (snapshot: AgentActivitySnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AgentActivitySnapshot | string[]) => {
        if (Array.isArray(payload)) {
          callback({
            runningWorkspaceIds: payload,
            waitingWorkspaceIds: [],
            runningAgentsByWorkspace: Object.fromEntries(payload.map((id) => [id, 1])),
            waitingAgentsByWorkspace: {},
            runningAgentCount: payload.length,
          })
          return
        }
        callback(payload)
      }
      ipcRenderer.on(IPC.CLAUDE_ACTIVITY_UPDATE, listener)
      return () => {
        ipcRenderer.removeListener(IPC.CLAUDE_ACTIVITY_UPDATE, listener)
      }
    },
  },

  codex: {
    installNotify: () =>
      ipcRenderer.invoke(IPC.CODEX_INSTALL_NOTIFY),
    uninstallNotify: () =>
      ipcRenderer.invoke(IPC.CODEX_UNINSTALL_NOTIFY),
    checkNotify: () =>
      ipcRenderer.invoke(IPC.CODEX_CHECK_NOTIFY),
  },

  github: {
    getPrStatuses: (repoPath: string, branches: string[], preferredLogin?: string) =>
      ipcRenderer.invoke(IPC.GITHUB_GET_PR_STATUSES, repoPath, branches, preferredLogin),
    listOpenPrs: (repoPath: string, preferredLogin?: string) =>
      ipcRenderer.invoke(IPC.GITHUB_LIST_OPEN_PRS, repoPath, preferredLogin),
    listAuthAccounts: (host = 'github.com') =>
      ipcRenderer.invoke(IPC.GITHUB_LIST_AUTH_ACCOUNTS, host) as Promise<{
        available: boolean
        error?: 'gh_not_installed' | 'not_authenticated' | 'not_github_repo'
        data: string[]
      }>,
  },

  clipboard: {
    saveImage: () =>
      ipcRenderer.invoke(IPC.CLIPBOARD_SAVE_IMAGE) as Promise<string | null>,
    readText: () =>
      ipcRenderer.invoke(IPC.CLIPBOARD_READ_TEXT) as Promise<string>,
    writeText: (text: string) =>
      ipcRenderer.invoke(IPC.CLIPBOARD_WRITE_TEXT, text),
  },

  chat: {
    login: () =>
      ipcRenderer.invoke(IPC.CHAT_LOGIN) as Promise<{ success: boolean }>,
    logout: () =>
      ipcRenderer.invoke(IPC.CHAT_LOGOUT),
    getAuthStatus: () =>
      ipcRenderer.invoke(IPC.CHAT_AUTH_STATUS) as Promise<{ loggedIn: boolean }>,
    listModels: () =>
      ipcRenderer.invoke(IPC.CHAT_LIST_MODELS) as Promise<Array<{ value: string; label: string }>>,
    createThread: (
      workingDir: string,
      model?: string,
      effort?: string,
      options?: {
        sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
        approvalMode?: 'never' | 'on-request' | 'on-failure' | 'untrusted'
      },
      workspaceId?: string,
    ) =>
      ipcRenderer.invoke(IPC.CHAT_CREATE_THREAD, workingDir, model, effort, options, workspaceId) as Promise<string>,
    send: (threadId: string, input: string | Array<{ type: string; text?: string; path?: string }>) =>
      ipcRenderer.invoke(IPC.CHAT_SEND, threadId, input) as Promise<{ accepted: true; turnId: string }>,
    cancel: (threadId: string) =>
      ipcRenderer.invoke(IPC.CHAT_CANCEL, threadId),
    destroyThread: (threadId: string) =>
      ipcRenderer.invoke(IPC.CHAT_DESTROY_THREAD, threadId),
    resume: (threadId: string) =>
      ipcRenderer.invoke(IPC.CHAT_RESUME, threadId) as Promise<boolean>,
    onEvent: (callback: (event: ChatEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: ChatEventPayload) => callback(data)
      ipcRenderer.on(IPC.CHAT_EVENT, listener)
      return () => {
        ipcRenderer.removeListener(IPC.CHAT_EVENT, listener)
      }
    },
  },

  state: {
    save: (data: unknown) =>
      ipcRenderer.invoke(IPC.STATE_SAVE, data),
    saveSync: (data: unknown) =>
      ipcRenderer.sendSync(IPC.STATE_SAVE_SYNC, data) as boolean,
    load: () =>
      ipcRenderer.invoke(IPC.STATE_LOAD),
  },
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
