import { Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@fluentui/react-components'
import { basenameSafe, formatShortcut, toPosixPath } from '@shared/platform'
import { SHORTCUT_MAP } from '@shared/shortcuts'
import { useAppStore } from '../../store/app-store'
import type { ChatMessage, Tab } from '../../store/types'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './TabBar.module.css'

function normalizeTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function resolveHeaderTitle(
  activeTab: Tab | undefined,
  chatMessages: Record<string, ChatMessage[]>,
): string {
  if (!activeTab) return 'No thread selected'

  if (activeTab.type === 'chat') {
    const messages = chatMessages[activeTab.threadId] ?? []
    const firstUserMessage = messages.find(
      (message) => message.role === 'user' && normalizeTitle(message.content).length > 0,
    )
    return firstUserMessage ? normalizeTitle(firstUserMessage.content) : 'New thread'
  }

  if (activeTab.type === 'file') {
    return basenameSafe(toPosixPath(activeTab.filePath)) || activeTab.filePath
  }

  return 'Changes'
}

function VSCodeLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.editorLogo}>
      <path fill="#0078d4" d="M17.9 2.3 8 6.9 4.5 3.8 1.8 6.5l3.7 3.4-3.7 3.4 2.7 2.7L8 13l9.9 4.7c.7.3 1.5-.2 1.5-1V3.3c0-.8-.8-1.3-1.5-1Z" />
    </svg>
  )
}

function CursorLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.editorLogo}>
      <rect x="2" y="2" width="20" height="20" rx="4" fill="#111" />
      <path fill="#fff" d="m7 7 10 5-10 5 2.2-5L7 7Z" />
    </svg>
  )
}

export function TabBar() {
  const {
    activeWorkspaceId,
    activeTabId,
    tabs,
    workspaces,
    chatMessages,
    addToast,
    rightPanelOpen,
    toggleRightPanel,
  } = useAppStore()

  const activeTab = tabs.find((tab) => tab.id === activeTabId && tab.workspaceId === activeWorkspaceId)
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const headerTitle = resolveHeaderTitle(activeTab, chatMessages)

  const handleOpenEditor = async (editor: 'vscode' | 'cursor') => {
    if (!activeWorkspace?.worktreePath) {
      addToast({ id: crypto.randomUUID(), message: 'Select a thread first', type: 'info' })
      return
    }

    try {
      const result = editor === 'vscode'
        ? await window.api.app.openInVSCode(activeWorkspace.worktreePath)
        : await window.api.app.openInCursor(activeWorkspace.worktreePath)
      if (!result.ok) {
        addToast({
          id: crypto.randomUUID(),
          message: result.error ?? `Could not open ${editor === 'vscode' ? 'VS Code' : 'Cursor'}`,
          type: 'error',
        })
      }
    } catch {
      addToast({
        id: crypto.randomUUID(),
        message: `Could not open ${editor === 'vscode' ? 'VS Code' : 'Cursor'}`,
        type: 'error',
      })
    }
  }

  return (
    <div className={styles.tabBar}>
      <div className={styles.titleArea}>
        <span className={styles.threadTitle} title={headerTitle}>
          {headerTitle}
        </span>
      </div>

      <div className={styles.rightControls}>
        <div className={styles.openSplit}>
          <button
            type="button"
            className={styles.openPrimaryButton}
            aria-label="Open in VS Code"
            onClick={() => void handleOpenEditor('vscode')}
          >
            <VSCodeLogo />
            <span className={styles.openLabel}>Open in VS Code</span>
          </button>
          <Menu positioning="below-end">
            <MenuTrigger disableButtonEnhancement>
              <button
                type="button"
                className={styles.openMenuToggle}
                aria-label="Open editor options"
              >
                <span className={styles.openChevron}>{'\u25BE'}</span>
              </button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<VSCodeLogo />} onClick={() => void handleOpenEditor('vscode')}>
                  Open in VS Code
                </MenuItem>
                <MenuItem icon={<CursorLogo />} onClick={() => void handleOpenEditor('cursor')}>
                  Open in Cursor
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>

        <Tooltip
          label={rightPanelOpen ? 'Hide right panel' : 'Show right panel'}
          shortcut={formatShortcut(SHORTCUT_MAP.toggleRightPanel.mac, SHORTCUT_MAP.toggleRightPanel.win)}
        >
          <button
            type="button"
            className={`${styles.edgeButton} ${styles.rightEdgeButton}`}
            onClick={toggleRightPanel}
            aria-label={rightPanelOpen ? 'Hide right panel' : 'Show right panel'}
          >
            <span className={styles.edgeGlyph}>{rightPanelOpen ? '\u203a' : '\u2039'}</span>
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
