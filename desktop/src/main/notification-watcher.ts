import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { IPC, type AgentActivitySnapshot, type AgentNotifyReason } from '../shared/ipc-channels'
import { debugLog } from '@shared/platform'
import { getMarkerDirs, notifyWorkspace } from './agent-notifier'

const { notifyDir: NOTIFY_DIR, activityDir: ACTIVITY_DIR } = getMarkerDirs()
const POLL_INTERVAL = 500
const CLAUDE_MARKER_SUFFIX = '.claude'
const CODEX_MARKER_SEGMENT = '.codex.'
const CODEX_WAITING_MARKER_SEGMENT = '.codex-wait.'

interface MarkerInfo {
  workspaceId: string
  kind: 'claude' | 'codex_running' | 'codex_waiting'
}

export class NotificationWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private prevSnapshot: AgentActivitySnapshot = this.emptySnapshot()

  start(): void {
    mkdirSync(NOTIFY_DIR, { recursive: true })
    mkdirSync(ACTIVITY_DIR, { recursive: true })
    this.cleanupStartupActivityMarkers()
    this.pollOnce()
    this.timer = setInterval(() => this.pollOnce(), POLL_INTERVAL)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private pollOnce(): void {
    this.pollNotifications()
    this.pollActivity()
  }

  private pollNotifications(): void {
    try {
      const files = readdirSync(NOTIFY_DIR)
      for (const f of files) {
        this.processFile(join(NOTIFY_DIR, f))
      }
    } catch {
      // Directory may not exist yet
    }
  }

  private pollActivity(): void {
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
