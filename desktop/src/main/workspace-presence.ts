import { type BrowserWindow } from 'electron'

const activeWorkspaceByWindowId = new Map<number, string | null>()

export function setWindowActiveWorkspace(win: BrowserWindow, workspaceId: string | null): void {
  activeWorkspaceByWindowId.set(win.id, workspaceId)
}

export function clearWindowActiveWorkspace(win: BrowserWindow): void {
  activeWorkspaceByWindowId.delete(win.id)
}

export function getWindowActiveWorkspace(win: BrowserWindow): string | null {
  return activeWorkspaceByWindowId.get(win.id) ?? null
}

export function isWorkspaceInBackground(win: BrowserWindow, workspaceId: string): boolean {
  if (win.isDestroyed()) return true
  if (win.isMinimized() || !win.isVisible() || !win.isFocused()) return true

  const activeWorkspaceId = getWindowActiveWorkspace(win)
  // If we don't know the active workspace yet, avoid false-positive notifications.
  if (!activeWorkspaceId) return false

  return activeWorkspaceId !== workspaceId
}
