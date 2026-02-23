import { ipcMain, dialog, app, BrowserWindow, clipboard, webContents, powerSaveBlocker } from 'electron'
import { join, relative, basename, extname } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { watch, type FSWatcher } from 'fs'
import { pathToFileURL } from 'url'
import { IPC } from '../shared/ipc-channels'
import type { IPty } from 'node-pty'
import type { TerminalEventPayload, ThemePreference } from '../shared/ipc-channels'
import type { CreateWorktreeProgressEvent } from '../shared/workspace-creation'
import { debugLog, toPosixPath } from '@shared/platform'
import { GitService } from './git-service'
import { GithubService } from './github-service'
import { FileService } from './file-service'
import { CodexService } from './codex-service'
import * as openaiAuth from './openai-auth'
import { trustPathForClaude, loadClaudeSettings, saveClaudeSettings, loadJsonFile, saveJsonFile } from './claude-config'
import { loadCodexConfigText, loadCodexModelOptions, saveCodexConfigText } from './codex-config'
import { setWindowActiveWorkspace } from './workspace-presence'

const codexService = new CodexService()

// Filesystem watchers: dirPath → { watcher, debounceTimer }
const fsWatchers = new Map<string, { watcher: FSWatcher; timer: ReturnType<typeof setTimeout> | null }>()
const terminalSessions = new Map<string, TerminalSession>()
const preventSleepSenderIds = new Set<number>()
const preventSleepTrackedSenderIds = new Set<number>()
let preventSleepBlockerId: number | null = null
const EDITOR_LAUNCH_GRACE_MS = (() => {
  const raw = Number.parseInt(process.env.TERMINATOR_EDITOR_LAUNCH_GRACE_MS ?? '', 10)
  if (Number.isFinite(raw)) {
    return Math.min(10000, Math.max(400, raw))
  }
  return 2500
})()

interface TerminalSession {
  sessionId: string
  senderId: number
  worktreePath: string
  ptyProcess: IPty | null
  activeCommand: { command: string; token: string } | null
  markerCarry: string
}

function emitTerminalEvent(senderId: number, payload: TerminalEventPayload): void {
  const sender = webContents.fromId(senderId)
  if (!sender || sender.isDestroyed()) return
  sender.send(IPC.TERMINAL_EVENT, payload)
}

function getOwnedTerminalSession(senderId: number, sessionId: string): TerminalSession {
  const session = terminalSessions.get(sessionId)
  if (!session) {
    throw new Error('Terminal session not found')
  }
  if (session.senderId !== senderId) {
    throw new Error('Terminal session is owned by another window')
  }
  return session
}

function stopTerminalProcess(session: TerminalSession): boolean {
  if (!session.ptyProcess) return false
  session.ptyProcess.kill()
  session.ptyProcess = null
  session.activeCommand = null
  session.markerCarry = ''
  return true
}

function emitTerminalOutput(session: TerminalSession, chunk: string): void {
  if (!chunk) return
  emitTerminalEvent(session.senderId, {
    sessionId: session.sessionId,
    type: 'command.output',
    ts: Date.now(),
    stream: 'stdout',
    chunk,
  })
}

function longestTokenPrefixSuffix(text: string, token: string): number {
  const maxLen = Math.min(token.length - 1, text.length)
  for (let len = maxLen; len > 0; len -= 1) {
    if (token.startsWith(text.slice(-len))) return len
  }
  return 0
}

function processTerminalData(session: TerminalSession, data: string): void {
  if (!session.activeCommand) {
    emitTerminalOutput(session, data)
    return
  }

  const token = session.activeCommand.token
  let pending = `${session.markerCarry}${data}`
  session.markerCarry = ''

  while (pending.length > 0) {
    const tokenIndex = pending.indexOf(token)
    if (tokenIndex === -1) {
      const keepLen = longestTokenPrefixSuffix(pending, token)
      const flushText = pending.slice(0, pending.length - keepLen)
      emitTerminalOutput(session, flushText)
      session.markerCarry = pending.slice(pending.length - keepLen)
      return
    }

    const beforeToken = pending.slice(0, tokenIndex)
    emitTerminalOutput(session, beforeToken)

    const afterToken = pending.slice(tokenIndex + token.length)
    const exitMatch = afterToken.match(/^(-?\d+)/)
    if (!exitMatch) {
      session.markerCarry = `${token}${afterToken}`
      return
    }

    const exitCode = Number.parseInt(exitMatch[1] ?? '1', 10)
    let consumed = (exitMatch[1] ?? '').length
    if (afterToken.slice(consumed).startsWith('\r\n')) consumed += 2
    else if (afterToken.slice(consumed).startsWith('\n')) consumed += 1

    const finishedSessionId = session.sessionId
    const completionType = exitCode === 0 ? 'command.completed' : 'command.failed'
    emitTerminalEvent(session.senderId, {
      sessionId: finishedSessionId,
      type: completionType,
      ts: Date.now(),
      exitCode,
    })
    session.activeCommand = null
    session.markerCarry = ''

    pending = afterToken.slice(consumed)
    emitTerminalOutput(session, pending)
    return
  }
}

function buildTerminalWrappedCommand(command: string, token: string): string {
  if (process.platform === 'win32') {
    return `& { ${command} }; $__tc_ec = $LASTEXITCODE; if ($null -eq $__tc_ec) { $__tc_ec = 0 }; Write-Output '${token}'$__tc_ec`
  }
  return `{ ${command}; }; __tc_ec=$?; printf '${token}%s\\n' "$__tc_ec"`
}

function getTerminalEnv(): Record<string, string> {
  const entries = Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return Object.fromEntries(entries)
}

function disposeTerminalSession(sessionId: string): void {
  const session = terminalSessions.get(sessionId)
  if (!session) return
  stopTerminalProcess(session)
  terminalSessions.delete(sessionId)
}

function disposeTerminalSessionsForSender(senderId: number): void {
  for (const [sessionId, session] of terminalSessions.entries()) {
    if (session.senderId === senderId) {
      disposeTerminalSession(sessionId)
    }
  }
}

function refreshPreventSleepBlocker(): void {
  const shouldPreventSleep = preventSleepSenderIds.size > 0
  if (shouldPreventSleep) {
    if (preventSleepBlockerId === null || !powerSaveBlocker.isStarted(preventSleepBlockerId)) {
      preventSleepBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    }
    return
  }

  if (preventSleepBlockerId !== null && powerSaveBlocker.isStarted(preventSleepBlockerId)) {
    powerSaveBlocker.stop(preventSleepBlockerId)
  }
  preventSleepBlockerId = null
}

function releasePreventSleepForSender(senderId: number): void {
  preventSleepSenderIds.delete(senderId)
  preventSleepTrackedSenderIds.delete(senderId)
  refreshPreventSleepBlocker()
}

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
    console.error('[Terminator Chat] Git operation failed', {
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

  ipcMain.handle(IPC.GIT_OPEN_OR_CREATE_PR, async (_e, worktreePath: string, baseBranch?: string) => {
    return runGitOperation('open-or-create-pr', { worktreePath, baseBranch }, () =>
      GitService.openOrCreatePullRequest(worktreePath, baseBranch),
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

  ipcMain.handle(IPC.GIT_FETCH_ORIGIN, async (_e, repoPath: string) => {
    return runGitOperation('fetch-origin', { repoPath }, () =>
      GitService.fetchOrigin(repoPath),
    )
  })

  ipcMain.handle(IPC.GIT_PULL_CURRENT_BRANCH, async (_e, worktreePath: string) => {
    return runGitOperation('pull-current-branch', { worktreePath }, () =>
      GitService.pullCurrentBranch(worktreePath),
    )
  })

  ipcMain.handle(IPC.GIT_GET_BRANCH_SYNC_STATUS, async (_e, worktreePath: string) => {
    return runGitOperation('get-branch-sync-status', { worktreePath }, () =>
      GitService.getBranchSyncStatus(worktreePath),
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

  ipcMain.handle(IPC.GIT_MOVE_LOCAL_CHANGES, async (_e, sourceWorktreePath: string, targetWorktreePath: string) => {
    return runGitOperation('move-local-changes', { sourceWorktreePath, targetWorktreePath }, () =>
      GitService.moveLocalChanges(sourceWorktreePath, targetWorktreePath),
    )
  })

  // ── GitHub handlers ──
  ipcMain.handle(IPC.GITHUB_GET_PR_STATUSES, async (_e, repoPath: string, branches: string[], preferredLogin?: string) => {
    return GithubService.getPrStatuses(repoPath, branches, preferredLogin)
  })

  ipcMain.handle(IPC.GITHUB_LIST_OPEN_PRS, async (_e, repoPath: string, preferredLogin?: string) => {
    return GithubService.listOpenPrs(repoPath, preferredLogin)
  })

  ipcMain.handle(IPC.GITHUB_LIST_AUTH_ACCOUNTS, async (_e, host = 'github.com') => {
    return GithubService.listAuthAccounts(host)
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

  ipcMain.handle(
    IPC.APP_CREATE_PROJECT,
    async (
      _e,
      input: {
        parentDir: string
        projectName: string
        ownership: 'personal' | 'work'
        createRemote?: boolean
        visibility?: 'public' | 'private'
        githubOwner?: string
      },
    ) =>
      runGitOperation(
        'app:create-project',
        { parentDir: input.parentDir, projectName: input.projectName, ownership: input.ownership, createRemote: input.createRemote },
        () => GitService.createProjectRepository(input),
      ),
  )

  ipcMain.handle(IPC.APP_GET_DATA_PATH, async () => {
    return app.getPath('userData')
  })

  ipcMain.on(IPC.APP_SET_UNREAD_COUNT, (_e, count: number) => {
    const normalizedCount = Number.isFinite(count)
      ? Math.max(0, Math.floor(count))
      : 0
    options.onUnreadCountChanged?.(normalizedCount)
  })

  ipcMain.on(IPC.APP_SET_ACTIVE_WORKSPACE, (_e, workspaceId: unknown) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) return
    if (typeof workspaceId === 'string' && workspaceId.trim().length > 0) {
      setWindowActiveWorkspace(win, workspaceId)
      return
    }
    setWindowActiveWorkspace(win, null)
  })

  ipcMain.on(IPC.APP_SET_PREVENT_SLEEP, (_e, enabled: unknown) => {
    const senderId = _e.sender.id
    const shouldEnable = enabled === true
    if (!shouldEnable) {
      releasePreventSleepForSender(senderId)
      return
    }

    preventSleepSenderIds.add(senderId)
    if (!preventSleepTrackedSenderIds.has(senderId)) {
      preventSleepTrackedSenderIds.add(senderId)
      _e.sender.once('destroyed', () => {
        releasePreventSleepForSender(senderId)
      })
    }
    refreshPreventSleepBlocker()
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

  type EditorKind = 'vscode' | 'cursor'

  type LaunchAttempt =
    | { kind: 'direct'; command: string; args: string[] }
    | { kind: 'cmd'; command: string; args: string[] }

  function pushIfExists(target: LaunchAttempt[], filePath: string, args: string[]): void {
    if (existsSync(filePath)) {
      target.push({ kind: 'direct', command: filePath, args })
    }
  }

  function pushCommandVariants(target: LaunchAttempt[], filePath: string, dirPath: string): void {
    pushIfExists(target, filePath, ['-n', dirPath])
    pushIfExists(target, filePath, [dirPath])
  }

  function pushScriptCommandVariants(target: LaunchAttempt[], filePath: string, dirPath: string): void {
    if (!existsSync(filePath)) return
    const folderUri = toFolderUri(dirPath)
    target.push({ kind: 'cmd', command: filePath, args: ['-n', dirPath] })
    target.push({ kind: 'cmd', command: filePath, args: ['--new-window', dirPath] })
    target.push({ kind: 'cmd', command: filePath, args: ['--folder-uri', folderUri] })
    target.push({ kind: 'cmd', command: filePath, args: [dirPath] })
  }

  function toFolderUri(dirPath: string): string {
    return pathToFileURL(dirPath).toString()
  }

  function pushCliAttempts(target: LaunchAttempt[], commandName: string, dirPath: string): void {
    const folderUri = toFolderUri(dirPath)
    target.push({ kind: 'cmd', command: commandName, args: ['-n', dirPath] })
    target.push({ kind: 'cmd', command: commandName, args: ['--new-window', dirPath] })
    target.push({ kind: 'cmd', command: commandName, args: ['--folder-uri', folderUri] })
    target.push({ kind: 'cmd', command: commandName, args: [dirPath] })
  }

  function pushVSCodeCommandVariants(target: LaunchAttempt[], filePath: string, dirPath: string): void {
    const folderUri = toFolderUri(dirPath)
    pushIfExists(target, filePath, ['--new-window', dirPath])
    pushIfExists(target, filePath, ['--folder-uri', folderUri])
    pushIfExists(target, filePath, ['-n', dirPath])
    pushIfExists(target, filePath, [dirPath])
  }

  function buildEditorLaunchAttempts(editor: EditorKind, dirPath: string): LaunchAttempt[] {
    const attempts: LaunchAttempt[] = []
    const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
    const programFiles = process.env.ProgramFiles ?? ''
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? ''
    if (process.platform === 'win32') {
      if (editor === 'vscode') {
        // Prefer CLI variants first. They return reliable exit codes and consistently open folders.
        pushScriptCommandVariants(attempts, `${localAppData}\\Programs\\Microsoft VS Code\\bin\\code.cmd`, dirPath)
        pushScriptCommandVariants(attempts, `${programFiles}\\Microsoft VS Code\\bin\\code.cmd`, dirPath)
        pushScriptCommandVariants(attempts, `${programFilesX86}\\Microsoft VS Code\\bin\\code.cmd`, dirPath)
        pushScriptCommandVariants(attempts, `${localAppData}\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd`, dirPath)

        // PATH CLI fallbacks
        pushCliAttempts(attempts, 'code', dirPath)
        pushCliAttempts(attempts, 'code-insiders', dirPath)
        pushCliAttempts(attempts, 'codium', dirPath)

        // As a last resort, try direct executables.
        pushVSCodeCommandVariants(attempts, `${localAppData}\\Programs\\Microsoft VS Code\\Code.exe`, dirPath)
        pushVSCodeCommandVariants(attempts, `${programFiles}\\Microsoft VS Code\\Code.exe`, dirPath)
        pushVSCodeCommandVariants(attempts, `${programFilesX86}\\Microsoft VS Code\\Code.exe`, dirPath)
        pushVSCodeCommandVariants(attempts, `${localAppData}\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe`, dirPath)
        pushVSCodeCommandVariants(attempts, `${programFiles}\\Microsoft VS Code Insiders\\Code - Insiders.exe`, dirPath)
        pushVSCodeCommandVariants(attempts, `${programFilesX86}\\Microsoft VS Code Insiders\\Code - Insiders.exe`, dirPath)
      } else {
        pushCommandVariants(attempts, `${localAppData}\\Programs\\Cursor\\Cursor.exe`, dirPath)
        pushCommandVariants(attempts, `${programFiles}\\Cursor\\Cursor.exe`, dirPath)
        pushCommandVariants(attempts, `${programFilesX86}\\Cursor\\Cursor.exe`, dirPath)
        pushScriptCommandVariants(attempts, `${localAppData}\\Programs\\Cursor\\resources\\app\\bin\\cursor.cmd`, dirPath)
        pushScriptCommandVariants(attempts, `${programFiles}\\Cursor\\resources\\app\\bin\\cursor.cmd`, dirPath)
        pushScriptCommandVariants(attempts, `${programFilesX86}\\Cursor\\resources\\app\\bin\\cursor.cmd`, dirPath)

        // CLI fallback
        pushCliAttempts(attempts, 'cursor', dirPath)
      }

      return attempts
    }

    const cmdName = editor === 'vscode' ? 'code' : 'cursor'
    attempts.push({ kind: 'direct', command: cmdName, args: ['-n', dirPath] })
    return attempts
  }

  function describeAttempt(attempt: LaunchAttempt): string {
    return basename(attempt.command)
  }

  function launchErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message
    return 'launch failed'
  }

  async function runLaunchAttempt(attempt: LaunchAttempt, cwdPath: string): Promise<{ ok: boolean; error?: string }> {
    const { spawn } = await import('child_process')
    const commonOptions = {
      detached: true,
      stdio: 'ignore' as const,
      windowsHide: true,
      cwd: cwdPath,
    }

    if (attempt.kind === 'cmd') {
      return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const child = spawn('cmd.exe', ['/d', '/c', attempt.command, ...attempt.args], commonOptions)
        child.once('error', (error) => resolve({ ok: false, error: launchErrorMessage(error) }))
        child.once('close', (code) => {
          if (code === 0) resolve({ ok: true })
          else resolve({ ok: false, error: `exit ${code ?? 'null'}` })
        })
        child.once('spawn', () => child.unref())
      })
    }

    return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      let settled = false
      let closeTimer: NodeJS.Timeout | null = null
      const finish = (result: { ok: boolean; error?: string }) => {
        if (settled) return
        settled = true
        if (closeTimer) clearTimeout(closeTimer)
        resolve(result)
      }
      const child = spawn(attempt.command, attempt.args, commonOptions)
      child.once('error', (error) => finish({ ok: false, error: launchErrorMessage(error) }))
      child.once('spawn', () => {
        child.unref()
        // Some launchers fail immediately after spawn (bad args/path/permissions).
        // Wait a short grace period so we can catch a fast non-zero exit.
        closeTimer = setTimeout(() => finish({ ok: true }), EDITOR_LAUNCH_GRACE_MS)
      })
      child.once('close', (code) => {
        if (code === 0) finish({ ok: true })
        else finish({ ok: false, error: `exit ${code ?? 'null'}` })
      })
    })
  }

  async function openInEditor(editor: EditorKind, dirPath: string): Promise<{ ok: boolean; error?: string }> {
    if (typeof dirPath !== 'string' || !dirPath.trim()) {
      return { ok: false, error: 'No folder selected' }
    }
    if (!existsSync(dirPath)) {
      return { ok: false, error: 'Folder does not exist' }
    }

    const attempts = buildEditorLaunchAttempts(editor, dirPath)
    const failureHints: string[] = []
    for (const attempt of attempts) {
      const launched = await runLaunchAttempt(attempt, dirPath)
      if (launched.ok) {
        return { ok: true }
      }
      if (launched.error) {
        failureHints.push(`${describeAttempt(attempt)}: ${launched.error}`)
      }
    }

    const debugHint = failureHints.length > 0
      ? ` Last attempt: ${failureHints[failureHints.length - 1]}.`
      : ''
    if (editor === 'vscode') {
      return {
        ok: false,
        error: `Could not open VS Code. Install the "code" command in PATH or reinstall VS Code with CLI support.${debugHint}`,
      }
    }
    return {
      ok: false,
      error: `Could not open Cursor. Install the "cursor" command in PATH from Cursor Command Palette.${debugHint}`,
    }
  }

  ipcMain.handle(IPC.APP_OPEN_IN_VSCODE, async (_e, dirPath: string) => {
    return openInEditor('vscode', dirPath)
  })

  ipcMain.handle(IPC.APP_OPEN_IN_CURSOR, async (_e, dirPath: string) => {
    return openInEditor('cursor', dirPath)
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

  // ── Clipboard handlers ──
  ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE, async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const buf = img.toPNG()
    const filePath = join(tmpdir(), `terminator-chat-paste-${Date.now()}.png`)
    await writeFile(filePath, buf)
    return filePath
  })

  ipcMain.handle(IPC.CLIPBOARD_READ_TEXT, async () => {
    return clipboard.readText()
  })

  ipcMain.handle(IPC.CLIPBOARD_WRITE_TEXT, async (_e, text: string) => {
    clipboard.writeText(text ?? '')
  })

  // ── Terminal handlers ──
  ipcMain.handle(IPC.TERMINAL_CREATE_SESSION, async (e, worktreePath: string) => {
    if (typeof worktreePath !== 'string' || !worktreePath.trim()) {
      throw new Error('Invalid terminal path')
    }
    if (!existsSync(worktreePath)) {
      throw new Error('Terminal path does not exist')
    }

    const { spawn } = await import('node-pty')
    const isWindows = process.platform === 'win32'
    const shell = isWindows ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')
    const args = isWindows ? ['-NoLogo', '-NoProfile'] : []

    const sessionId = crypto.randomUUID()
    const senderId = e.sender.id
    const session: TerminalSession = {
      sessionId,
      senderId,
      worktreePath,
      ptyProcess: null,
      activeCommand: null,
      markerCarry: '',
    }
    const ptyProcess = spawn(shell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: worktreePath,
      env: getTerminalEnv(),
    })
    session.ptyProcess = ptyProcess
    terminalSessions.set(sessionId, session)

    ptyProcess.onData((chunk) => {
      processTerminalData(session, chunk)
    })

    ptyProcess.onExit(({ exitCode }) => {
      if (session.activeCommand) {
        emitTerminalEvent(session.senderId, {
          sessionId: session.sessionId,
          type: 'command.failed',
          ts: Date.now(),
          exitCode,
          message: 'Terminal session exited unexpectedly',
        })
        session.activeCommand = null
      }
      session.ptyProcess = null
      terminalSessions.delete(session.sessionId)
    })

    e.sender.once('destroyed', () => {
      disposeTerminalSessionsForSender(senderId)
    })

    return { sessionId }
  })

  ipcMain.handle(IPC.TERMINAL_DISPOSE_SESSION, async (e, sessionId: string) => {
    getOwnedTerminalSession(e.sender.id, sessionId)
    disposeTerminalSession(sessionId)
  })

  ipcMain.handle(IPC.TERMINAL_CLEAR_OUTPUT, async (e, sessionId: string) => {
    const session = getOwnedTerminalSession(e.sender.id, sessionId)
    session.markerCarry = ''
    emitTerminalEvent(e.sender.id, {
      sessionId,
      type: 'session.cleared',
      ts: Date.now(),
    })
  })

  ipcMain.handle(IPC.TERMINAL_KILL_COMMAND, async (e, sessionId: string) => {
    const session = getOwnedTerminalSession(e.sender.id, sessionId)
    if (!session.ptyProcess) {
      return { stopped: false }
    }

    session.ptyProcess.write('\u0003')
    if (session.activeCommand) {
      session.activeCommand = null
      session.markerCarry = ''
    }
    emitTerminalEvent(session.senderId, {
      sessionId,
      type: 'command.cancelled',
      ts: Date.now(),
    })

    const stopped = true
    return { stopped }
  })

  ipcMain.handle(IPC.TERMINAL_RUN_COMMAND, async (e, sessionId: string, command: string) => {
    const session = getOwnedTerminalSession(e.sender.id, sessionId)
    const normalizedCommand = typeof command === 'string' ? command.trim() : ''
    if (!normalizedCommand) {
      throw new Error('Command is required')
    }
    if (!session.ptyProcess) {
      throw new Error('Terminal session is not available')
    }
    if (session.activeCommand) {
      throw new Error('A command is already running in this terminal')
    }

    const token = `__TC_DONE_${crypto.randomUUID().replace(/-/g, '')}__`
    session.activeCommand = { command: normalizedCommand, token }
    session.markerCarry = ''
    const wrappedCommand = buildTerminalWrappedCommand(normalizedCommand, token)

    emitTerminalEvent(session.senderId, {
      sessionId,
      type: 'command.started',
      ts: Date.now(),
      command: normalizedCommand,
    })
    session.ptyProcess.write(`${wrappedCommand}\r`)

    return { started: true as const }
  })

  ipcMain.handle(IPC.TERMINAL_WRITE_INPUT, async (e, sessionId: string, data: string) => {
    const session = getOwnedTerminalSession(e.sender.id, sessionId)
    if (!session.ptyProcess) {
      throw new Error('Terminal session is not available')
    }

    const normalizedData = typeof data === 'string' ? data : ''
    session.ptyProcess.write(normalizedData)
    return { written: true as const }
  })

  ipcMain.handle(IPC.TERMINAL_RESIZE, async (e, sessionId: string, cols: number, rows: number) => {
    const session = getOwnedTerminalSession(e.sender.id, sessionId)
    if (!session.ptyProcess) {
      return { resized: false as const }
    }

    const normalizedCols = Number.isFinite(cols) ? Math.max(20, Math.floor(cols)) : 120
    const normalizedRows = Number.isFinite(rows) ? Math.max(4, Math.floor(rows)) : 30
    session.ptyProcess.resize(normalizedCols, normalizedRows)
    return { resized: true as const }
  })

  // ── State persistence handlers ──
  const stateFilePath = () =>
    join(app.getPath('userData'), 'terminator-chat-state.json')

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

  // ── Chat / Codex handlers ──
  // Initialize from stored token on startup (async, non-blocking)
  const storedToken = openaiAuth.getStoredToken()
  if (storedToken) {
    codexService.setAccessToken(storedToken.accessToken).catch((err) => {
      console.error('[Terminator Chat] Failed to initialize stored token:', err)
    })
  }

  ipcMain.handle(IPC.CHAT_LOGIN, async () => {
    console.log('[Terminator Chat] Login requested, starting OAuth flow...')
    try {
      const result = await openaiAuth.login()
      await codexService.setAccessToken(result.accessToken)
      console.log('[Terminator Chat] Login successful')
      return { success: true }
    } catch (err) {
      console.error('[Terminator Chat] Login failed:', err)
      throw err
    }
  })

  ipcMain.handle(IPC.CHAT_LOGOUT, async () => {
    openaiAuth.logout()
    codexService.setAccessToken(null)
  })

  ipcMain.handle(IPC.CHAT_AUTH_STATUS, () => {
    return { loggedIn: openaiAuth.isLoggedIn() }
  })

  ipcMain.handle(IPC.CHAT_LIST_MODELS, async () => {
    return loadCodexModelOptions()
  })

  ipcMain.handle(
    IPC.CHAT_CREATE_THREAD,
    async (
      _e,
      workingDir: string,
      model?: string,
      effort?: string,
      options?: {
        sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
        approvalMode?: 'never' | 'on-request' | 'on-failure' | 'untrusted'
      },
      workspaceId?: string,
      workspaceLabel?: string,
    ) => {
      // Refresh token if needed before creating thread
      try {
        const token = await openaiAuth.refreshIfNeeded()
        await codexService.setAccessToken(token)
      } catch {
        // Token may still be valid, let it try
      }
      return codexService.createThread(workingDir, model, effort, options, workspaceId, workspaceLabel)
    },
  )

  ipcMain.handle(IPC.CHAT_SEND, async (e, threadId: string, input: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    return codexService.sendMessage(threadId, input as any, win)
  })

  ipcMain.handle(IPC.CHAT_CANCEL, async (_e, threadId: string) => {
    codexService.cancelTurn(threadId)
  })

  ipcMain.handle(IPC.CHAT_DESTROY_THREAD, async (_e, threadId: string) => {
    codexService.destroyThread(threadId)
  })

  ipcMain.handle(IPC.CHAT_RESUME, async (_e, threadId: string) => {
    return codexService.resumeThread(threadId)
  })

  ipcMain.handle(IPC.CHAT_SAVE_LOCAL_IMAGE, async (_e, bytes: unknown, fileName?: string) => {
    let buffer: Buffer | null = null
    if (bytes instanceof ArrayBuffer) {
      buffer = Buffer.from(bytes)
    } else if (ArrayBuffer.isView(bytes)) {
      buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    }
    if (!buffer || buffer.byteLength === 0) {
      throw new Error('Image data is empty')
    }

    const rawExt = extname((fileName ?? '').trim()).toLowerCase()
    const ext = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff']
      .includes(rawExt)
      ? rawExt
      : '.png'
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const filePath = join(tmpdir(), `terminator-chat-upload-${suffix}${ext}`)
    await writeFile(filePath, buffer)
    return filePath
  })
}

