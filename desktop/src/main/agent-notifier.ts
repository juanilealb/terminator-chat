import { app, BrowserWindow, nativeImage, Notification } from 'electron'
import { join } from 'path'
import { IPC, type AgentNotifyReason } from '../shared/ipc-channels'
import { getTempDir } from '@shared/platform'
import { isWorkspaceInBackground } from './workspace-presence'

const lastNotifiedAtByKey = new Map<string, number>()
const DEFAULT_DEDUPE_MS = 10_000
const CROSS_SOURCE_DEDUPE_MS = 1_200
const NO_TURN_DEDUPE_MS = 1_500

function getNotificationIcon() {
  const candidates = [
    join(app.getAppPath(), 'build', 'icon.png'),
    join(process.resourcesPath, 'build', 'icon.png'),
    join(process.resourcesPath, 'icon.png'),
  ]

  for (const iconPath of candidates) {
    const icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) return icon
  }

  return nativeImage.createEmpty()
}

function shouldSkipNotification(key: string, dedupeMs: number): boolean {
  const now = Date.now()
  const last = lastNotifiedAtByKey.get(key) ?? 0
  if ((now - last) < dedupeMs) return true
  lastNotifiedAtByKey.set(key, now)
  return false
}

function activateWorkspace(workspaceId: string): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  win.webContents.send(IPC.ACTIVATE_WORKSPACE, workspaceId)
}

function showWindowsNotification(workspaceId: string, reason: AgentNotifyReason): void {
  if (!Notification.isSupported()) return

  const body = reason === 'waiting_input'
    ? `Agent waiting for your input in workspace ${workspaceId}`
    : `Agent completed in workspace ${workspaceId}`

  const notification = new Notification({
    title: 'Terminator Chat',
    body,
    icon: getNotificationIcon(),
  })
  notification.on('click', () => activateWorkspace(workspaceId))
  notification.show()
}

export function notifyWorkspace(
  workspaceId: string,
  reason: AgentNotifyReason,
  options?: {
    turnId?: string
    source?: 'hook' | 'chat'
    dedupeMs?: number
  },
): void {
  if (!workspaceId) return

  const dedupeMs = options?.dedupeMs ?? DEFAULT_DEDUPE_MS
  const detailKey = `${workspaceId}:${reason}:${options?.turnId ?? `source:${options?.source ?? 'unknown'}`}`
  const detailDedupeMs = options?.turnId
    ? dedupeMs
    : Math.min(dedupeMs, NO_TURN_DEDUPE_MS)
  if (shouldSkipNotification(detailKey, detailDedupeMs)) return

  const crossSourceKey = `${workspaceId}:${reason}:cross-source`
  if (shouldSkipNotification(crossSourceKey, Math.min(dedupeMs, CROSS_SOURCE_DEDUPE_MS))) return

  let anyBackgroundWindow = false
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (!isWorkspaceInBackground(win, workspaceId)) continue
    anyBackgroundWindow = true
    win.webContents.send(IPC.CLAUDE_NOTIFY_WORKSPACE, {
      workspaceId,
      reason,
      turnId: options?.turnId,
      source: options?.source,
    })
  }

  if (anyBackgroundWindow) {
    showWindowsNotification(workspaceId, reason)
  }
}

export function getMarkerDirs() {
  return {
    notifyDir: join(getTempDir(), 'terminator-chat-notify'),
    activityDir: join(getTempDir(), 'terminator-chat-activity'),
  }
}
