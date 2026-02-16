import { mkdirSync, readdirSync, readFileSync, unlinkSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { IPC, type AgentActivitySnapshot, type AgentNotifyReason } from '../shared/ipc-channels'
import { debugLog } from '@shared/platform'
import { getMarkerDirs, notifyWorkspace } from './agent-notifier'

const { notifyDir: NOTIFY_DIR, activityDir: ACTIVITY_DIR } = getMarkerDirs()
const RESYNC_INTERVAL_MS = 5_000
const NOTIFY_DEBOUNCE_MS = 60
const ACTIVITY_DEBOUNCE_MS = 90
const CLAUDE_MARKER_SUFFIX = '.claude'
const CODEX_MARKER_SEGMENT = '.codex.'
const CODEX_WAITING_MARKER_SEGMENT = '.codex-wait.'

interface MarkerInfo {
  workspaceId: string
  kind: 'claude' | 'codex_running' | 'codex_waiting'
}

export class NotificationWatcher {
  private resyncTimer: ReturnType<typeof setInterval> | null = null
  private notifyWatcher: FSWatcher | null = null
  private activityWatcher: FSWatcher | null = null
  private notifyDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private activityDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private prevSnapshot: AgentActivitySnapshot = this.emptySnapshot()

  start(): void {
    mkdirSync(NOTIFY_DIR, { recursive: true })
    mkdirSync(ACTIVITY_DIR, { recursive: true })
    this.cleanupStartupActivityMarkers()
    this.processNotifications()
    this.processActivity()
    this.watchDirs()
    this.resyncTimer = setInterval(() => {
      this.processNotifications()
      this.processActivity()
    }, RESYNC_INTERVAL_MS)
  }

  stop(): void {
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer)
      this.resyncTimer = null
    }
    if (this.notifyDebounceTimer) {
      clearTimeout(this.notifyDebounceTimer)
      this.notifyDebounceTimer = null
    }
    if (this.activityDebounceTimer) {
      clearTimeout(this.activityDebounceTimer)
      this.activityDebounceTimer = null
    }
    if (this.notifyWatcher) {
      this.notifyWatcher.close()
      this.notifyWatcher = null
    }
    if (this.activityWatcher) {
      this.activityWatcher.close()
      this.activityWatcher = null
    }
  }

  private watchDirs(): void {
    this.notifyWatcher = this.createWatcher(NOTIFY_DIR, () => this.scheduleNotificationScan())
    this.activityWatcher = this.createWatcher(ACTIVITY_DIR, () => this.scheduleActivityScan())
  }

  private createWatcher(dir: string, onEvent: () => void): FSWatcher | null {
    try {
      return watch(dir, () => onEvent())
    } catch (error) {
      debugLog('Failed to watch marker directory; using periodic resync only', {
        dir,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  private scheduleNotificationScan(): void {
    if (this.notifyDebounceTimer) return
    this.notifyDebounceTimer = setTimeout(() => {
      this.notifyDebounceTimer = null
      this.processNotifications()
    }, NOTIFY_DEBOUNCE_MS)
  }

  private scheduleActivityScan(): void {
    if (this.activityDebounceTimer) return
    this.activityDebounceTimer = setTimeout(() => {
      this.activityDebounceTimer = null
      this.processActivity()
    }, ACTIVITY_DEBOUNCE_MS)
  }

  private processNotifications(): void {
    try {
      const files = readdirSync(NOTIFY_DIR)
      for (const f of files) {
        this.processFile(join(NOTIFY_DIR, f))
      }
    } catch {
      // Directory may not exist yet
    }
  }

  private processActivity(): void {
    try {
      const files = readdirSync(ACTIVITY_DIR)
      const snapshot = this.buildSnapshot(files)

      if (!this.sameSnapshot(snapshot, this.prevSnapshot)) {
        this.notifyTransitions(this.prevSnapshot, snapshot)
        this.prevSnapshot = snapshot
        this.sendActivity(snapshot)
        debugLog('Activity markers changed', {
          runningWorkspaceIds: snapshot.runningWorkspaceIds,
          waitingWorkspaceIds: snapshot.waitingWorkspaceIds,
          runningAgentCount: snapshot.runningAgentCount,
        })
      }
    } catch {
      if (!this.isSnapshotEmpty(this.prevSnapshot)) {
        const prevSnapshot = this.prevSnapshot
        this.prevSnapshot = this.emptySnapshot()
        this.sendActivity(this.prevSnapshot)
        debugLog('Activity markers cleared (activity dir unavailable)')
        for (const wsId of prevSnapshot.runningWorkspaceIds) {
          this.notifyRenderer(wsId, 'completed')
        }
      }
    }
  }

  private processFile(filePath: string): void {
    try {
      const wsId = readFileSync(filePath, 'utf-8').trim()
      if (wsId) {
        debugLog('Notify marker found', { workspaceId: wsId, filePath })
        this.notifyRenderer(wsId, 'completed')
      } else {
        debugLog('Notify marker empty; clearing marker file', { filePath })
      }
      unlinkSync(filePath)
      debugLog('Notify marker cleared', { filePath })
    } catch {
      // File may have been already processed or deleted
    }
  }

  private markerFromName(name: string): MarkerInfo | null {
    const marker = name.trim()
    if (!marker) return null

    if (marker.endsWith(CLAUDE_MARKER_SUFFIX)) {
      const workspaceId = marker.slice(0, -CLAUDE_MARKER_SUFFIX.length)
      return workspaceId ? { workspaceId, kind: 'claude' } : null
    }

    const codexWaitingIdx = marker.indexOf(CODEX_WAITING_MARKER_SEGMENT)
    if (codexWaitingIdx > 0) {
      const workspaceId = marker.slice(0, codexWaitingIdx)
      return workspaceId ? { workspaceId, kind: 'codex_waiting' } : null
    }

    const codexIdx = marker.indexOf(CODEX_MARKER_SEGMENT)
    if (codexIdx > 0) {
      const workspaceId = marker.slice(0, codexIdx)
      return workspaceId ? { workspaceId, kind: 'codex_running' } : null
    }

    // Legacy format is no longer written. Ignore and clean it up to avoid
    // stale always-active spinners after upgrading marker formats.
    return null
  }

  private removeActivityMarker(name: string): void {
    const markerPath = join(ACTIVITY_DIR, name)
    try {
      unlinkSync(markerPath)
      debugLog('Activity marker cleared', { markerPath })
    } catch {
      // Marker may already be gone
    }
  }

  private cleanupStartupActivityMarkers(): void {
    try {
      const files = readdirSync(ACTIVITY_DIR)
      for (const name of files) {
        const info = this.markerFromName(name)
        if (!info) {
          this.removeActivityMarker(name)
          continue
        }
        if (info.kind === 'codex_running' || info.kind === 'codex_waiting') {
          this.removeActivityMarker(name)
        }
      }
    } catch {
      // Best effort.
    }
  }

  private buildSnapshot(files: string[]): AgentActivitySnapshot {
    const runningAgentsByWorkspace: Record<string, number> = {}
    const waitingAgentsByWorkspace: Record<string, number> = {}

    for (const name of files) {
      const info = this.markerFromName(name)
      if (!info) {
        this.removeActivityMarker(name)
        continue
      }

      if (info.kind === 'codex_waiting') {
        waitingAgentsByWorkspace[info.workspaceId] = (waitingAgentsByWorkspace[info.workspaceId] ?? 0) + 1
        continue
      }

      runningAgentsByWorkspace[info.workspaceId] = (runningAgentsByWorkspace[info.workspaceId] ?? 0) + 1
    }

    const runningWorkspaceIds = Object.keys(runningAgentsByWorkspace).sort()
    const waitingWorkspaceIds = Object.keys(waitingAgentsByWorkspace).sort()
    const runningAgentCount = Object.values(runningAgentsByWorkspace).reduce((sum, count) => sum + count, 0)

    return {
      runningWorkspaceIds,
      waitingWorkspaceIds,
      runningAgentsByWorkspace,
      waitingAgentsByWorkspace,
      runningAgentCount,
    }
  }

  private emptySnapshot(): AgentActivitySnapshot {
    return {
      runningWorkspaceIds: [],
      waitingWorkspaceIds: [],
      runningAgentsByWorkspace: {},
      waitingAgentsByWorkspace: {},
      runningAgentCount: 0,
    }
  }

  private isSnapshotEmpty(snapshot: AgentActivitySnapshot): boolean {
    return snapshot.runningWorkspaceIds.length === 0 && snapshot.waitingWorkspaceIds.length === 0
  }

  private sameSnapshot(a: AgentActivitySnapshot, b: AgentActivitySnapshot): boolean {
    const normalizeCounts = (counts: Record<string, number>): string =>
      Object.keys(counts)
        .sort()
        .map((key) => `${key}:${counts[key]}`)
        .join('|')

    return (
      a.runningAgentCount === b.runningAgentCount
      && a.runningWorkspaceIds.join('|') === b.runningWorkspaceIds.join('|')
      && a.waitingWorkspaceIds.join('|') === b.waitingWorkspaceIds.join('|')
      && normalizeCounts(a.runningAgentsByWorkspace) === normalizeCounts(b.runningAgentsByWorkspace)
      && normalizeCounts(a.waitingAgentsByWorkspace) === normalizeCounts(b.waitingAgentsByWorkspace)
    )
  }

  private notifyTransitions(prev: AgentActivitySnapshot, next: AgentActivitySnapshot): void {
    const nextRunning = new Set(next.runningWorkspaceIds)
    const nextWaiting = new Set(next.waitingWorkspaceIds)

    for (const wsId of prev.runningWorkspaceIds) {
      if (nextRunning.has(wsId)) continue
      if (nextWaiting.has(wsId)) {
        this.notifyRenderer(wsId, 'waiting_input')
        continue
      }
      this.notifyRenderer(wsId, 'completed')
    }

    for (const wsId of prev.waitingWorkspaceIds) {
      if (nextRunning.has(wsId) || nextWaiting.has(wsId)) continue
      this.notifyRenderer(wsId, 'completed')
    }
  }

  private notifyRenderer(workspaceId: string, reason: AgentNotifyReason): void {
    notifyWorkspace(workspaceId, reason, { source: 'hook' })
  }

  private sendActivity(snapshot: AgentActivitySnapshot): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.CLAUDE_ACTIVITY_UPDATE, snapshot)
      }
    }
  }
}
