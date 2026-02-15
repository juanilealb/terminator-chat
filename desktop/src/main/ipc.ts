import { ipcMain, dialog, app, BrowserWindow, clipboard } from 'electron'
import { join, relative } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { watch, type FSWatcher } from 'fs'
import { IPC } from '../shared/ipc-channels'
import type { ThemePreference } from '../shared/ipc-channels'
import type { CreateWorktreeProgressEvent } from '../shared/workspace-creation'
import { debugLog, toPosixPath } from '@shared/platform'
import { PtyManager } from './pty-manager'
import { GitService } from './git-service'
import { GithubService } from './github-service'
import { FileService } from './file-service'
import { AutomationScheduler, type AutomationConfig } from './automation-scheduler'
import { trustPathForClaude, loadClaudeSettings, saveClaudeSettings, loadJsonFile, saveJsonFile } from './claude-config'
import { loadCodexConfigText, saveCodexConfigText } from './codex-config'

const ptyManager = new PtyManager()
const automationScheduler = new AutomationScheduler(ptyManager)

// Filesystem watchers: dirPath → { watcher, debounceTimer }
const fsWatchers = new Map<string, { watcher: FSWatcher; timer: ReturnType<typeof setTimeout> | null }>()

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return error
}

async function runGitOperation<T>(
  operation: string,
  context: Record<string, unknown>,
  op: () => Promise<T>,
): Promise<T> {
  try {
    return await op()
  } catch (error) {
    console.error('[Terminator] Git operation failed', {
      operation,
      ...context,
      error: serializeError(error),
    })
    throw error
  }
}

interface StateSanitizeResult {
  data: unknown
  changed: boolean
  removedWorkspaceCount: number
}

interface IpcHandlerOptions {
  onCreateWorktreeProgress?: (progress: CreateWorktreeProgressEvent) => void
  onCreateWorktreeComplete?: () => void
  onUnreadCountChanged?: (count: number) => void
  onThemePreferenceChanged?: (themePreference: ThemePreference) => void
}

interface WorkspaceLike {
  id: string
  worktreePath: string
}

interface TabLike {
  id: string
  workspaceId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isWorkspaceLike(value: unknown): value is WorkspaceLike {
  return isRecord(value) && typeof value.id === 'string' && typeof value.worktreePath === 'string'
}

function isTabLike(value: unknown): value is TabLike {
  return isRecord(value) && typeof value.id === 'string' && typeof value.workspaceId === 'string'
}

function sanitizeLoadedState(data: unknown): StateSanitizeResult {
  if (!isRecord(data)) return { data, changed: false, removedWorkspaceCount: 0 }
  const rawWorkspaces = Array.isArray(data.workspaces) ? data.workspaces : null
  if (!rawWorkspaces) return { data, changed: false, removedWorkspaceCount: 0 }

  const keptWorkspaces: unknown[] = []
  const keptWorkspaceIds = new Set<string>()
  let removedWorkspaceCount = 0

  for (const workspace of rawWorkspaces) {
    if (!isWorkspaceLike(workspace) || !existsSync(workspace.worktreePath)) {
      removedWorkspaceCount += 1
      continue
    }
    keptWorkspaces.push(workspace)
    keptWorkspaceIds.add(workspace.id)
  }

  if (removedWorkspaceCount === 0) {
    return { data, changed: false, removedWorkspaceCount: 0 }
  }

  const next: Record<string, unknown> = { ...data, workspaces: keptWorkspaces }
  let changed = true

  const rawTabs = Array.isArray(data.tabs) ? data.tabs : null
  const keptTabs = rawTabs
    ? rawTabs.filter((tab) => isTabLike(tab) && keptWorkspaceIds.has(tab.workspaceId))
    : []
  if (rawTabs) next.tabs = keptTabs

  const rawActiveWorkspaceId = typeof data.activeWorkspaceId === 'string' ? data.activeWorkspaceId : null
  let nextActiveWorkspaceId: string | null = null
  if (rawActiveWorkspaceId && keptWorkspaceIds.has(rawActiveWorkspaceId)) {
    nextActiveWorkspaceId = rawActiveWorkspaceId
  } else {
    const firstWorkspace = keptWorkspaces.find(isWorkspaceLike)
    nextActiveWorkspaceId = firstWorkspace?.id ?? null
  }
  if ((data.activeWorkspaceId ?? null) !== nextActiveWorkspaceId) {
    changed = true
  }
  next.activeWorkspaceId = nextActiveWorkspaceId

  const rawActiveTabId = typeof data.activeTabId === 'string' ? data.activeTabId : null
  let nextActiveTabId: string | null = null
  if (rawTabs) {
    const tabIds = new Set<string>()
    for (const tab of keptTabs) {
      if (isTabLike(tab)) tabIds.add(tab.id)
    }
    if (rawActiveTabId && tabIds.has(rawActiveTabId)) {
      nextActiveTabId = rawActiveTabId
    } else if (nextActiveWorkspaceId) {
      const fallback = keptTabs.find(
        (tab) => isTabLike(tab) && tab.workspaceId === nextActiveWorkspaceId
      )
      if (isTabLike(fallback)) nextActiveTabId = fallback.id
    }
  }
  if ((data.activeTabId ?? null) !== nextActiveTabId) {
    changed = true
  }
  next.activeTabId = nextActiveTabId

  if (isRecord(data.lastActiveTabByWorkspace)) {
    const filtered = Object.fromEntries(
      Object.entries(data.lastActiveTabByWorkspace).filter(([workspaceId]) =>
        keptWorkspaceIds.has(workspaceId)
      )
    )
    if (
      Object.keys(filtered).length !==
      Object.keys(data.lastActiveTabByWorkspace).length
    ) {
      changed = true
    }
    next.lastActiveTabByWorkspace = filtered
  }

  return { data: next, changed, removedWorkspaceCount }
}
export function registerIpcHandlers(options: IpcHandlerOptions = {}): void {
  const normalizeGitPath = (filePath: string): string => toPosixPath(filePath)

  // ── Git handlers ──
  ipcMain.handle(IPC.GIT_LIST_WORKTREES, async (_e, repoPath: string) => {
    return runGitOperation('list-worktrees', { repoPath }, () =>
      GitService.listWorktrees(repoPath),
    )
  })

  ipcMain.handle(IPC.GIT_CREATE_WORKTREE, async (_e, repoPath: string, name: string, branch: string, newBranch: boolean, baseBranch?: string, force?: boolean, requestId?: string) => {
    try {
      return await runGitOperation(
        'create-worktree',
        { repoPath, name, branch, newBranch, baseBranch, force, requestId },
        () =>
          GitService.createWorktree(
            repoPath,
            name,
            branch,
            newBranch,
            baseBranch,
            force,
            (progress) => {
              const payload: CreateWorktreeProgressEvent = { requestId, ...progress }
              _e.sender.send(IPC.GIT_CREATE_WORKTREE_PROGRESS, payload)
              options.onCreateWorktreeProgress?.(payload)
            },
          ),
      )
    } finally {
      options.onCreateWorktreeComplete?.()
    }
  })

  ipcMain.handle(IPC.GIT_CREATE_WORKTREE_FROM_PR, async (_e, repoPath: string, name: string, prNumber: number, localBranch: string, force?: boolean, requestId?: string) => {
    try {
      return await GitService.createWorktreeFromPr(
        repoPath,
        name,
        prNumber,
        localBranch,
        force,
        (progress) => {
          const payload: CreateWorktreeProgressEvent = { requestId, ...progress }
          _e.sender.send(IPC.GIT_CREATE_WORKTREE_PROGRESS, payload)
          options.onCreateWorktreeProgress?.(payload)
        }
      )
    } finally {
      options.onCreateWorktreeComplete?.()
    }
  })

  ipcMain.handle(IPC.GIT_REMOVE_WORKTREE, async (_e, repoPath: string, worktreePath: string) => {
    return runGitOperation('remove-worktree', { repoPath, worktreePath }, () =>
      GitService.removeWorktree(repoPath, worktreePath),
    )
  })

  ipcMain.handle(IPC.GIT_GET_STATUS, async (_e, worktreePath: string) => {
    const statuses = await runGitOperation('get-status', { worktreePath }, () =>
      GitService.getStatus(worktreePath),
    )
    return statuses.map((s) => ({ ...s, path: normalizeGitPath(s.path) }))
  })

  ipcMain.handle(IPC.GIT_GET_DIFF, async (_e, worktreePath: string, staged: boolean) => {
    const diffs = await runGitOperation('get-diff', { worktreePath, staged }, () =>
      GitService.getDiff(worktreePath, staged),
    )
    return diffs.map((d) => ({ ...d, path: normalizeGitPath(d.path) }))
  })

  ipcMain.handle(IPC.GIT_GET_FILE_DIFF, async (_e, worktreePath: string, filePath: string) => {
    return runGitOperation('get-file-diff', { worktreePath, filePath }, () =>
      GitService.getFileDiff(worktreePath, filePath),
    )
  })

  ipcMain.handle(IPC.GIT_GET_BRANCHES, async (_e, repoPath: string) => {
    return runGitOperation('get-branches', { repoPath }, () =>
      GitService.getBranches(repoPath),
    )
  })

  ipcMain.handle(IPC.GIT_STAGE, async (_e, worktreePath: string, paths: string[]) => {
    return runGitOperation('stage', { worktreePath, paths }, () =>
      GitService.stage(worktreePath, paths),
    )
  })

  ipcMain.handle(IPC.GIT_UNSTAGE, async (_e, worktreePath: string, paths: string[]) => {
    return runGitOperation('unstage', { worktreePath, paths }, () =>
      GitService.unstage(worktreePath, paths),
    )
  })

  ipcMain.handle(IPC.GIT_DISCARD, async (_e, worktreePath: string, paths: string[], untracked: string[]) => {
    return runGitOperation('discard', { worktreePath, paths, untracked }, () =>
      GitService.discard(worktreePath, paths, untracked),
    )
  })

  ipcMain.handle(IPC.GIT_COMMIT, async (_e, worktreePath: string, message: string) => {
    return runGitOperation('commit', { worktreePath, message }, () =>
      GitService.commit(worktreePath, message),
    )
  })

  ipcMain.handle(IPC.GIT_PUSH_CURRENT_BRANCH, async (_e, worktreePath: string) => {
    return runGitOperation('push-current-branch', { worktreePath }, () =>
      GitService.pushCurrentBranch(worktreePath),
    )
  })

  ipcMain.handle(IPC.GIT_OPEN_OR_CREATE_PR, async (_e, worktreePath: string) => {
    return runGitOperation('open-or-create-pr', { worktreePath }, () =>
      GitService.openOrCreatePullRequest(worktreePath),
    )
  })

  ipcMain.handle(IPC.GIT_SHIP_BRANCH_TO_MAIN, async (_e, repoPath: string, sourceBranch: string) => {
    return runGitOperation('ship-branch-to-main', { repoPath, sourceBranch }, () =>
      GitService.shipBranchToMain(repoPath, sourceBranch),
    )
  })

  ipcMain.handle(IPC.GIT_GET_CURRENT_BRANCH, async (_e, worktreePath: string) => {
    return runGitOperation('get-current-branch', { worktreePath }, () =>
      GitService.getCurrentBranch(worktreePath),
    )
  })

  ipcMain.handle(IPC.GIT_GET_DEFAULT_BRANCH, async (_e, repoPath: string) => {
    return runGitOperation('get-default-branch', { repoPath }, () =>
      GitService.getDefaultBranch(repoPath),
    )
  })

  ipcMain.handle(IPC.GIT_CREATE_SNAPSHOT, async (_e, worktreePath: string, label?: string) => {
    return runGitOperation('create-snapshot', { worktreePath, label }, () =>
      GitService.createSnapshot(worktreePath, label),
    )
  })

  ipcMain.handle(IPC.GIT_LIST_SNAPSHOTS, async (_e, worktreePath: string) => {
    return runGitOperation('list-snapshots', { worktreePath }, () =>
      GitService.listSnapshots(worktreePath),
    )
  })

  ipcMain.handle(IPC.GIT_RESTORE_SNAPSHOT, async (_e, worktreePath: string, ref: string) => {
    return runGitOperation('restore-snapshot', { worktreePath, ref }, () =>
      GitService.restoreSnapshot(worktreePath, ref),
    )
  })

  ipcMain.handle(IPC.GIT_DROP_SNAPSHOT, async (_e, worktreePath: string, ref: string) => {
    return runGitOperation('drop-snapshot', { worktreePath, ref }, () =>
      GitService.dropSnapshot(worktreePath, ref),
    )
  })

  // ── GitHub handlers ──
  ipcMain.handle(IPC.GITHUB_GET_PR_STATUSES, async (_e, repoPath: string, branches: string[]) => {
    return GithubService.getPrStatuses(repoPath, branches)
  })

  ipcMain.handle(IPC.GITHUB_LIST_OPEN_PRS, async (_e, repoPath: string) => {
    return GithubService.listOpenPrs(repoPath)
  })

  // ── PTY handlers ──
  ipcMain.handle(IPC.PTY_CREATE, async (_e, workingDir: string, shell?: string, shellArgs?: string[], extraEnv?: Record<string, string>) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) throw new Error('No window found')
    return ptyManager.create(workingDir, win.webContents, shell, shellArgs, undefined, undefined, extraEnv)
  })

  ipcMain.on(IPC.PTY_WRITE, async (_e, ptyId: string, data: string) => {
    try {
      await ptyManager.write(ptyId, data)
    } catch (error) {
      debugLog('PTY write failed', { ptyId, error: serializeError(error) })
    }
  })

  ipcMain.on(IPC.PTY_RESIZE, (_e, ptyId: string, cols: number, rows: number) => {
    ptyManager.resize(ptyId, cols, rows)
  })

  ipcMain.on(IPC.PTY_DESTROY, (_e, ptyId: string) => {
    ptyManager.destroy(ptyId)
  })

  ipcMain.handle(IPC.PTY_LIST, async () => {
    return ptyManager.list()
  })

  ipcMain.handle(IPC.PTY_REATTACH, async (_e, ptyId: string) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) throw new Error('No window found')
    return ptyManager.reattach(ptyId, win.webContents)
  })

  // ── File handlers ──
  ipcMain.handle(IPC.FS_GET_TREE, async (_e, dirPath: string) => {
    return FileService.getTree(dirPath)
  })

  ipcMain.handle(IPC.FS_GET_TREE_WITH_STATUS, async (_e, dirPath: string) => {
    const [tree, statuses, topLevel] = await Promise.all([
      FileService.getTree(dirPath),
      GitService.getStatus(dirPath).catch(() => []),
      GitService.getTopLevel(dirPath).catch(() => dirPath),
    ])

    // git status --porcelain paths are relative to repo root, but git ls-files
    // paths (used for tree nodes) are cwd-relative. Convert both to POSIX.
    const prefixRaw = toPosixPath(relative(topLevel, dirPath))
    const prefix = prefixRaw === '.' ? '' : prefixRaw.replace(/^\.\/+/, '')

    // Build map: dirPath-relative path → git status
    const statusMap = new Map<string, string>()
    for (const s of statuses) {
      let p = normalizeGitPath(s.path)
      // Handle renamed files: "old -> new" — use the new path
      if (p.includes(' -> ')) {
        p = p.split(' -> ')[1] ?? p
      }
      // Strip repo-root prefix to get dirPath-relative path
      if (prefix) {
        if (p === prefix) p = ''
        else if (p.startsWith(`${prefix}/`)) p = p.slice(prefix.length + 1)
      }
      statusMap.set(p, s.status)
    }

    // Attach gitStatus to nodes, propagate to parent dirs
    function annotate(nodes: Awaited<ReturnType<typeof FileService.getTree>>): boolean {
      let hasStatus = false
      for (const node of nodes) {
        const rel = toPosixPath(relative(dirPath, node.path))

        if (node.type === 'file') {
          const st = statusMap.get(rel)
          if (st) {
            ;(node as any).gitStatus = st
            hasStatus = true
          }
        } else if (node.children) {
          const childHasStatus = annotate(node.children)
          if (childHasStatus) {
            ;(node as any).gitStatus = 'modified'
            hasStatus = true
          }
        }
      }
      return hasStatus
    }

    annotate(tree)
    return tree
  })

  ipcMain.handle(IPC.FS_READ_FILE, async (_e, filePath: string) => {
    return FileService.readFile(filePath)
  })

  ipcMain.handle(IPC.FS_WRITE_FILE, async (_e, filePath: string, content: string) => {
    return FileService.writeFile(filePath, content)
  })

  // ── Filesystem watcher handlers ──
  ipcMain.handle(IPC.FS_WATCH_START, (_e, dirPath: string) => {
    if (fsWatchers.has(dirPath)) return // already watching

    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) return

    try {
      const watcher = watch(dirPath, { recursive: true }, (_eventType, filename) => {
        const fileNameText = typeof filename === 'string'
          ? filename
          : ''

        // For .git/ changes, only notify on meaningful state changes (commit, stage, branch switch)
        // Ignore noisy internals like objects/, logs/, COMMIT_EDITMSG
        if (fileNameText && (fileNameText.startsWith('.git/') || fileNameText.startsWith('.git\\'))) {
          const f = fileNameText.replaceAll('\\', '/')
          const isStateChange =
            f === '.git/index' || f === '.git/HEAD' || f.startsWith('.git/refs/')
            || f === '.git/packed-refs'
            || f === '.git/logs/HEAD'
            || f.startsWith('.git/logs/refs/')
          if (!isStateChange) return
        }

        const entry = fsWatchers.get(dirPath)
        if (!entry) return

        // Debounce: wait 1000ms of quiet before notifying
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          if (!win.isDestroyed()) {
            win.webContents.send(IPC.FS_WATCH_CHANGED, dirPath)
          }
        }, 1000)
      })

      fsWatchers.set(dirPath, { watcher, timer: null })
    } catch {
      // Directory may not exist or be inaccessible — ignore
    }
  })

  ipcMain.on(IPC.FS_WATCH_STOP, (_e, dirPath: string) => {
    const entry = fsWatchers.get(dirPath)
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.watcher.close()
      fsWatchers.delete(dirPath)
    }
  })

  // ── App handlers ──
  ipcMain.handle(IPC.APP_SELECT_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Repository',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Accepts a path directly (for testing — avoids dialog.showOpenDialog)
  ipcMain.handle(IPC.APP_ADD_PROJECT_PATH, async (_e, dirPath: string) => {
    const { stat } = await import('fs/promises')
    try {
      const s = await stat(dirPath)
      if (!s.isDirectory()) return null
      return dirPath
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.APP_GET_DATA_PATH, async () => {
    return app.getPath('userData')
  })

  ipcMain.on(IPC.APP_SET_UNREAD_COUNT, (_e, count: number) => {
    const normalizedCount = Number.isFinite(count)
      ? Math.max(0, Math.floor(count))
      : 0
    options.onUnreadCountChanged?.(normalizedCount)
  })

  ipcMain.on(IPC.APP_SET_THEME_SOURCE, (_e, themePreference: unknown) => {
    if (themePreference === 'system' || themePreference === 'dark' || themePreference === 'light') {
      options.onThemePreferenceChanged?.(themePreference)
    }
  })

  ipcMain.on(IPC.APP_WINDOW_MINIMIZE, (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) return
    win.minimize()
  })

  ipcMain.on(IPC.APP_WINDOW_TOGGLE_MAXIMIZE, (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
      return
    }
    win.maximize()
  })

  ipcMain.on(IPC.APP_WINDOW_CLOSE, (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) return
    win.close()
  })

  ipcMain.handle(IPC.APP_WINDOW_IS_MAXIMIZED, (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) return false
    return win.isMaximized()
  })

  // ── Claude Code trust ──
  ipcMain.handle(IPC.CLAUDE_TRUST_PATH, async (_e, dirPath: string) => {
    await trustPathForClaude(dirPath)
  })

  // ── Claude Code hooks ──
  function getHookScriptPath(name: string): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'claude-hooks', name)
    }
    return join(__dirname, '..', '..', 'claude-hooks', name)
  }

  function getCodexHookScriptPath(name: string): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'codex-hooks', name)
    }
    return join(__dirname, '..', '..', 'codex-hooks', name)
  }

  // Stable identifiers to match our hook entries regardless of full path.
  const CLAUDE_HOOK_IDENTIFIERS = [
    'claude-hooks/notify.js',
    'claude-hooks/activity.js',
  ]

  function normalizeHookText(value: string): string {
    return toPosixPath(value).replace(/\/+/g, '/').toLowerCase()
  }

  function commandHasIdentifier(command: string | undefined, identifiers: readonly string[]): boolean {
    if (!command) return false
    const normalized = normalizeHookText(command)
    return identifiers.some((id) => normalized.includes(id))
  }

  function buildNodeHookCommand(scriptPath: string): string {
    const escapedPath = scriptPath.replace(/"/g, '""')
    return `node "${escapedPath}"`
  }

  function isOurHook(rule: { hooks?: Array<{ command?: string }> }): boolean {
    return !!rule.hooks?.some((h) => commandHasIdentifier(h.command, CLAUDE_HOOK_IDENTIFIERS))
  }

  ipcMain.handle(IPC.CLAUDE_CHECK_HOOKS, async () => {
    const settings = await loadClaudeSettings()
    const hooks = settings.hooks as Record<string, unknown[]> | undefined
    if (!hooks) return { installed: false }

    const hasStop = (hooks.Stop as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    const hasNotification = (hooks.Notification as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    const hasPromptSubmit = (hooks.UserPromptSubmit as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    return { installed: !!(hasStop && hasNotification && hasPromptSubmit) }
  })

  ipcMain.handle(IPC.CLAUDE_INSTALL_HOOKS, async () => {
    const settings = await loadClaudeSettings()
    const notifyPath = getHookScriptPath('notify.js')
    const activityPath = getHookScriptPath('activity.js')

    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>

    // Helper: remove stale entries with old paths, then add current one
    function ensureHook(event: string, scriptPath: string, matcher = '') {
      const rules = (hooks[event] ?? []) as Array<Record<string, unknown>>
      const filtered = rules.filter((rule) => !isOurHook(rule as { hooks?: Array<{ command?: string }> }))
      filtered.push({ matcher, hooks: [{ type: 'command', command: buildNodeHookCommand(scriptPath) }] })
      hooks[event] = filtered
    }

    ensureHook('Stop', notifyPath)
    ensureHook('Notification', notifyPath)
    ensureHook('UserPromptSubmit', activityPath)
    settings.hooks = hooks

    await saveClaudeSettings(settings)
    debugLog('Claude hooks installed', {
      events: ['Stop', 'Notification', 'UserPromptSubmit'],
      notifyPath,
      activityPath,
    })
    return { success: true }
  })

  ipcMain.handle(IPC.CLAUDE_UNINSTALL_HOOKS, async () => {
    const settings = await loadClaudeSettings()
    const hooks = settings.hooks as Record<string, unknown[]> | undefined
    if (!hooks) {
      debugLog('Claude hooks uninstall skipped (no hooks configured)')
      return { success: true }
    }

    function removeHook(event: string) {
      const rules = (hooks![event] ?? []) as Array<{ hooks?: Array<{ command?: string }> }>
      hooks![event] = rules.filter((rule) => !isOurHook(rule))
      if ((hooks![event] as unknown[]).length === 0) delete hooks![event]
    }

    removeHook('Stop')
    removeHook('Notification')
    removeHook('UserPromptSubmit')

    if (Object.keys(hooks).length === 0) delete settings.hooks
    await saveClaudeSettings(settings)
    debugLog('Claude hooks uninstalled', {
      events: ['Stop', 'Notification', 'UserPromptSubmit'],
    })
    return { success: true }
  })

  // ── Codex notify hook ──
  const CODEX_NOTIFY_IDENTIFIERS = [
    'codex-hooks/notify.js',
  ]
  const TABLE_HEADER_RE = /^\s*\[[^\n]+\]\s*$/m
  const NOTIFY_ASSIGNMENT_RE = /^\s*notify\s*=/

  function tomlEscape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }

  function firstTableHeaderIndex(configText: string): number {
    const match = configText.match(TABLE_HEADER_RE)
    return match?.index ?? -1
  }

  function topLevelSection(configText: string): string {
    const firstTableIndex = firstTableHeaderIndex(configText)
    return firstTableIndex === -1 ? configText : configText.slice(0, firstTableIndex)
  }

  function textHasAnyCodexNotifyIdentifier(text: string): boolean {
    const normalized = normalizeHookText(text)
    return CODEX_NOTIFY_IDENTIFIERS.some((id) => normalized.includes(id))
  }

  function hasOurCodexNotify(configText: string): boolean {
    return textHasAnyCodexNotifyIdentifier(topLevelSection(configText))
  }

  function stripNotifyAssignments(configText: string, shouldStrip: (assignment: string) => boolean = () => true): string {
    const lines = configText.split('\n')
    const kept: string[] = []
    let i = 0

    while (i < lines.length) {
      const line = lines[i]
      if (!NOTIFY_ASSIGNMENT_RE.test(line)) {
        kept.push(line)
        i += 1
        continue
      }

      let end = i
      const startsArray = line.includes('[')
      const endsArray = line.includes(']')
      if (startsArray && !endsArray) {
        let j = i + 1
        while (j < lines.length) {
          end = j
          if (lines[j].includes(']')) break
          j += 1
        }
      }

      const assignment = lines.slice(i, end + 1).join('\n')
      if (!shouldStrip(assignment)) {
        kept.push(...lines.slice(i, end + 1))
      }
      i = end + 1
    }

    return kept.join('\n')
  }

  function insertTopLevelNotify(configText: string, notifyLine: string): string {
    const withoutNotify = configText.trimEnd()
    if (!withoutNotify) return `${notifyLine}\n`

    const firstTableIndex = firstTableHeaderIndex(withoutNotify)
    if (firstTableIndex === -1) {
      return `${withoutNotify}\n${notifyLine}\n`
    }

    const beforeTables = withoutNotify.slice(0, firstTableIndex).trimEnd()
    const tablesAndBelow = withoutNotify.slice(firstTableIndex).replace(/^\n+/, '')

    const rebuilt = beforeTables
      ? `${beforeTables}\n${notifyLine}\n\n${tablesAndBelow}`
      : `${notifyLine}\n\n${tablesAndBelow}`

    return `${rebuilt.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
  }

  ipcMain.handle(IPC.CODEX_CHECK_NOTIFY, async () => {
    const config = await loadCodexConfigText()
    return { installed: hasOurCodexNotify(config) }
  })

  ipcMain.handle(IPC.CODEX_INSTALL_NOTIFY, async () => {
    const notifyPath = getCodexHookScriptPath('notify.js')
    const notifyLine = `notify = ["node", "${tomlEscape(notifyPath)}"]`
    let config = await loadCodexConfigText()

    // `notify` must be at true top-level in TOML. Appending at EOF can accidentally
    // nest it under the last table (for example `[projects."..."]`), which Codex ignores.
    config = stripNotifyAssignments(config)
    config = insertTopLevelNotify(config, notifyLine)

    await saveCodexConfigText(config)
    debugLog('Codex notify hook installed', { notifyPath })
    return { success: true }
  })

  ipcMain.handle(IPC.CODEX_UNINSTALL_NOTIFY, async () => {
    let config = await loadCodexConfigText()
    if (!textHasAnyCodexNotifyIdentifier(config)) {
      debugLog('Codex notify hook uninstall skipped (no matching assignment)')
      return { success: true }
    }

    config = stripNotifyAssignments(config, (assignment) => textHasAnyCodexNotifyIdentifier(assignment))
    config = config.replace(/\n{3,}/g, '\n\n').trimEnd()
    if (config) config += '\n'

    await saveCodexConfigText(config)
    debugLog('Codex notify hook uninstalled')
    return { success: true }
  })

  // ── Automation handlers ──
  ipcMain.handle(IPC.AUTOMATION_CREATE, async (_e, automation: AutomationConfig) => {
    automationScheduler.schedule(automation)
  })

  ipcMain.handle(IPC.AUTOMATION_UPDATE, async (_e, automation: AutomationConfig) => {
    automationScheduler.schedule(automation) // reschedules
  })

  ipcMain.handle(IPC.AUTOMATION_DELETE, async (_e, automationId: string) => {
    automationScheduler.unschedule(automationId)
  })

  ipcMain.handle(IPC.AUTOMATION_RUN_NOW, async (_e, automation: AutomationConfig) => {
    automationScheduler.runNow(automation)
  })

  ipcMain.handle(IPC.AUTOMATION_STOP, async (_e, automationId: string) => {
    automationScheduler.unschedule(automationId)
  })

  // Load persisted automations and schedule enabled ones on startup
  ipcMain.handle(IPC.AUTOMATION_LIST, async () => {
    // List is just for init — renderer manages the list in store
    // Main process uses this to bootstrap scheduler from persisted state
    return null
  })

  // ── Clipboard handlers ──
  ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE, async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const buf = img.toPNG()
    const filePath = join(tmpdir(), `terminator-paste-${Date.now()}.png`)
    await writeFile(filePath, buf)
    return filePath
  })

  ipcMain.handle(IPC.CLIPBOARD_READ_TEXT, async () => {
    return clipboard.readText()
  })

  ipcMain.handle(IPC.CLIPBOARD_WRITE_TEXT, async (_e, text: string) => {
    clipboard.writeText(text ?? '')
  })

  // ── State persistence handlers ──
  const stateFilePath = () =>
    join(app.getPath('userData'), 'terminator-state.json')

  ipcMain.handle(IPC.STATE_SAVE, async (_e, data: unknown) => {
    await mkdir(app.getPath('userData'), { recursive: true })
    await saveJsonFile(stateFilePath(), data)
  })

  // Synchronous save for beforeunload — guarantees state is written before window closes
  ipcMain.on(IPC.STATE_SAVE_SYNC, (event, data: unknown) => {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(stateFilePath(), JSON.stringify(data, null, 2), 'utf-8')
      event.returnValue = true
    } catch {
      event.returnValue = false
    }
  })

  ipcMain.handle(IPC.STATE_LOAD, async () => {
    const loaded = await loadJsonFile(stateFilePath(), null)
    const sanitized = sanitizeLoadedState(loaded)
    if (sanitized.changed) {
      await saveJsonFile(stateFilePath(), sanitized.data).catch(() => {})
      const count = sanitized.removedWorkspaceCount
      if (count > 0) {
        console.info(`[state] removed ${count} stale workspace${count === 1 ? '' : 's'}`)
      }
    }
    return sanitized.data
  })
}

export function sendActivateWorkspace(workspaceId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.ACTIVATE_WORKSPACE, workspaceId)
    }
  }
}
