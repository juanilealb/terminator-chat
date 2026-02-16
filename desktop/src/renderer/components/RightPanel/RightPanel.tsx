import { useCallback, useEffect, useRef, useState } from 'react'
import {
  TabList,
  Tab,
  CounterBadge,
  type SelectTabData,
  type SelectTabEvent,
} from '@fluentui/react-components'
import { formatShortcut } from '@shared/platform'
import { SHORTCUT_MAP } from '@shared/shortcuts'
import { useAppStore } from '../../store/app-store'
import { subscribeGitStatusChanged } from '../../utils/git-status-events'
import { FileTree } from './FileTree'
import { ChangedFiles } from './ChangedFiles'
import { WorkspaceMemoryPanel } from './WorkspaceMemoryPanel'
import styles from './RightPanel.module.css'

type PanelMode = 'files' | 'changes' | 'memory'

export function RightPanel() {
  const {
    rightPanelMode,
    setRightPanelMode,
    activeWorkspaceId,
    workspaces,
  } = useAppStore()
  const [changeCount, setChangeCount] = useState(0)
  const countSeqRef = useRef(0)

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const worktreePath = workspace?.worktreePath

  const refreshChangeCount = useCallback(async () => {
    if (!worktreePath) {
      setChangeCount(0)
      return
    }
    const seq = ++countSeqRef.current
    try {
      const statuses = await window.api.git.getStatus(worktreePath)
      if (seq !== countSeqRef.current) return
      setChangeCount(statuses.length)
    } catch {
      if (seq !== countSeqRef.current) return
      setChangeCount(0)
    }
  }, [worktreePath])

  useEffect(() => {
    if (!worktreePath) {
      setChangeCount(0)
      return
    }
    void refreshChangeCount()

    window.api.fs.watchDir(worktreePath)
    const unsub = window.api.fs.onDirChanged((changedPath: string) => {
      if (changedPath === worktreePath) void refreshChangeCount()
    })
    const unsubStatus = subscribeGitStatusChanged(worktreePath, (count) => {
      setChangeCount(count)
    })

    return () => {
      unsub()
      unsubStatus()
      window.api.fs.unwatchDir(worktreePath)
    }
  }, [worktreePath, refreshChangeCount])

  useEffect(() => {
    if (rightPanelMode === 'changes') {
      void refreshChangeCount()
    }
  }, [rightPanelMode, refreshChangeCount])

  const handleTabSelect = useCallback(
    (_event: SelectTabEvent, data: SelectTabData) => {
      setRightPanelMode(data.value as PanelMode)
    },
    [setRightPanelMode]
  )

  return (
    <div className={styles.rightPanel}>
      <div className={styles.header}>
        <div className={styles.tabViewport}>
          <TabList
            selectedValue={rightPanelMode}
            onTabSelect={handleTabSelect}
            appearance="subtle"
            size="small"
            className={styles.tabList}
          >
            <Tab
              value="files"
              title={`Files (${formatShortcut(SHORTCUT_MAP.filesPanel.mac, SHORTCUT_MAP.filesPanel.win)})`}
            >
              Files
            </Tab>
            <Tab
              value="changes"
              title={`Changes (${formatShortcut(SHORTCUT_MAP.changesPanel.mac, SHORTCUT_MAP.changesPanel.win)})`}
            >
              Changes
              {changeCount > 0 && (
                <CounterBadge
                  count={changeCount}
                  size="small"
                  appearance="filled"
                  className={styles.badge}
                />
              )}
            </Tab>
            <Tab
              value="memory"
              title={`Memory (${formatShortcut(SHORTCUT_MAP.memoryPanel.mac, SHORTCUT_MAP.memoryPanel.win)})`}
            >
              Memory
            </Tab>
          </TabList>
        </div>
      </div>

      <div className={styles.content}>
        {!workspace ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon}>[ ]</span>
            <span className={styles.emptyText}>
              Select a workspace to browse files, snapshots, and preview
            </span>
          </div>
        ) : (
          <>
            <div style={{ display: rightPanelMode === 'files' ? 'contents' : 'none' }}>
              <FileTree worktreePath={workspace.worktreePath} isActive={rightPanelMode === 'files'} />
            </div>
            <div style={{ display: rightPanelMode === 'changes' ? 'contents' : 'none' }}>
              <ChangedFiles
                worktreePath={workspace.worktreePath}
                workspaceId={workspace.id}
                isActive={rightPanelMode === 'changes'}
              />
            </div>
            <div style={{ display: rightPanelMode === 'memory' ? 'contents' : 'none' }}>
              <WorkspaceMemoryPanel workspace={workspace} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
