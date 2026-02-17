import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Textarea } from '@fluentui/react-components'
import {
  SaveRegular,
  ArrowUndoRegular,
  DeleteRegular,
} from '@fluentui/react-icons'
import type { Workspace } from '../../store/types'
import { useAppStore } from '../../store/app-store'
import { expandPromptTemplate } from '../../utils/prompt-template'
import { routeExpandedTemplateToChat } from '../../utils/template-routing'
import { dispatchGitStatusChanged } from '../../utils/git-status-events'
import styles from './RightPanel.module.css'

interface Snapshot {
  ref: string
  label: string
  createdAt: number
}

interface Props {
  workspace: Workspace
}

function formatSnapshotDate(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000)
  return date.toLocaleString()
}

export function WorkspaceMemoryPanel({ workspace }: Props) {
  const {
    settings,
    updateWorkspaceMemory,
    addToast,
    showConfirmDialog,
    dismissConfirmDialog,
    focusOrCreateChat,
  } = useAppStore()

  const [snapshotLabel, setSnapshotLabel] = useState('')
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [loadingSnapshots, setLoadingSnapshots] = useState(false)

  const refreshGitStatusCount = useCallback(async () => {
    try {
      const statuses = await window.api.git.getStatus(workspace.worktreePath)
      dispatchGitStatusChanged(workspace.worktreePath, statuses.length)
    } catch {
      // Ignore status sync failures from the memory panel.
    }
  }, [workspace.worktreePath])

  const refreshSnapshots = useCallback(async () => {
    setLoadingSnapshots(true)
    try {
      const data = await window.api.git.listSnapshots(workspace.worktreePath)
      setSnapshots(data)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load snapshots'
      addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
    } finally {
      setLoadingSnapshots(false)
    }
  }, [workspace.worktreePath, addToast])

  useEffect(() => {
    refreshSnapshots()
  }, [refreshSnapshots])

  const applyTemplate = useCallback(
    async (templateName: string, templateContent: string) => {
      try {
        const expanded = await expandPromptTemplate(templateContent, workspace)
        await routeExpandedTemplateToChat({
          workspace,
          templateName,
          expandedPrompt: expanded,
          focusOrCreateChat,
          addToast,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : `Failed to apply template "${templateName}"`
        addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
      }
    },
    [workspace, focusOrCreateChat, addToast]
  )

  const handleCreateSnapshot = useCallback(async () => {
    try {
      const created = await window.api.git.createSnapshot(workspace.worktreePath, snapshotLabel)
      if (!created) {
        addToast({
          id: crypto.randomUUID(),
          message: 'No local changes to snapshot',
          type: 'info',
        })
        return
      }
      setSnapshotLabel('')
      addToast({
        id: crypto.randomUUID(),
        message: `Snapshot created: ${created.label}`,
        type: 'info',
      })
      await refreshSnapshots()
      await refreshGitStatusCount()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create snapshot'
      addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
    }
  }, [workspace.worktreePath, snapshotLabel, refreshSnapshots, refreshGitStatusCount, addToast])

  const restoreSnapshot = useCallback(
    (snapshot: Snapshot) => {
      showConfirmDialog({
        title: 'Restore snapshot',
        message: `Apply snapshot "${snapshot.label}" to current workspace?`,
        confirmLabel: 'Restore',
        destructive: true,
        onConfirm: async () => {
          dismissConfirmDialog()
          try {
            await window.api.git.restoreSnapshot(workspace.worktreePath, snapshot.ref)
            addToast({
              id: crypto.randomUUID(),
              message: `Snapshot restored: ${snapshot.label}`,
              type: 'info',
            })
            await refreshSnapshots()
            await refreshGitStatusCount()
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to restore snapshot'
            addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
          }
        },
      })
    },
    [workspace.worktreePath, showConfirmDialog, dismissConfirmDialog, addToast, refreshSnapshots, refreshGitStatusCount]
  )

  const deleteSnapshot = useCallback(
    (snapshot: Snapshot) => {
      showConfirmDialog({
        title: 'Delete snapshot',
        message: `Delete snapshot "${snapshot.label}"?`,
        confirmLabel: 'Delete',
        destructive: true,
        onConfirm: async () => {
          dismissConfirmDialog()
          try {
            await window.api.git.dropSnapshot(workspace.worktreePath, snapshot.ref)
            addToast({
              id: crypto.randomUUID(),
              message: `Snapshot deleted: ${snapshot.label}`,
              type: 'info',
            })
            await refreshSnapshots()
            await refreshGitStatusCount()
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to delete snapshot'
            addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
          }
        },
      })
    },
    [workspace.worktreePath, showConfirmDialog, dismissConfirmDialog, refreshSnapshots, refreshGitStatusCount, addToast]
  )

  return (
    <div className={styles.memoryPanel}>
      <div className={styles.memorySection}>
        <div className={styles.memoryTitle}>Workspace memory</div>
        <Textarea
          className={styles.memoryInput}
          placeholder="Persistent notes, constraints, links, and reminders for this workspace..."
          value={workspace.memory ?? ''}
          onChange={(_e, data) => updateWorkspaceMemory(workspace.id, data.value)}
          resize="vertical"
          size="small"
          appearance="outline"
        />
      </div>

      <div className={styles.memorySection}>
        <div className={styles.memoryTitle}>Prompt templates</div>
        {settings.promptTemplates.length === 0 ? (
          <div className={styles.memoryEmpty}>No prompt templates configured in settings</div>
        ) : (
          <div className={styles.templateList}>
            {settings.promptTemplates.map((template) => (
              <Button
                key={template.id}
                appearance="outline"
                size="small"
                onClick={() => applyTemplate(template.name, template.content)}
                title={template.content}
              >
                {template.name}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div className={styles.memorySection}>
        <div className={styles.memoryTitle}>Snapshots</div>
        <div className={styles.snapshotCreateRow}>
          <Input
            placeholder="Snapshot label"
            value={snapshotLabel}
            onChange={(_e, data) => setSnapshotLabel(data.value)}
            size="small"
            appearance="outline"
            style={{ flex: 1 }}
          />
          <Button
            appearance="outline"
            size="small"
            onClick={handleCreateSnapshot}
            icon={<SaveRegular />}
          >
            Save
          </Button>
        </div>
        <div className={styles.snapshotList}>
          {loadingSnapshots && <div className={styles.memoryEmpty}>Loading snapshots...</div>}
          {!loadingSnapshots && snapshots.length === 0 && (
            <div className={styles.memoryEmpty}>No snapshots yet</div>
          )}
          {snapshots.map((snapshot) => (
            <div key={snapshot.ref} className={styles.snapshotItem}>
              <div className={styles.snapshotMeta}>
                <span className={styles.snapshotLabel}>{snapshot.label}</span>
                <span className={styles.snapshotDate}>{formatSnapshotDate(snapshot.createdAt)}</span>
              </div>
              <div className={styles.snapshotActions}>
                <Button
                  appearance="subtle"
                  size="small"
                  onClick={() => restoreSnapshot(snapshot)}
                  icon={<ArrowUndoRegular />}
                >
                  Restore
                </Button>
                <Button
                  appearance="subtle"
                  size="small"
                  onClick={() => deleteSnapshot(snapshot)}
                  icon={<DeleteRegular />}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
