import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from '@fluentui/react-components'
import { useAppStore } from '../../store/app-store'
import styles from './NewThreadDialog.module.css'

function normalizeBranch(input: string): string {
  return input.trim().replace(/^origin\//, '').replace(/^refs\/heads\//, '')
}

export function NewThreadDialog() {
  const {
    newThreadDialog,
    projects,
    closeNewThreadDialog,
    setNewThreadDialog,
    confirmNewThreadDialog,
  } = useAppStore()
  const [branches, setBranches] = useState<string[]>([])
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [creating, setCreating] = useState(false)

  const project = projects.find((entry) => entry.id === newThreadDialog.projectId)
  const listId = useMemo(() => `new-thread-branches-${newThreadDialog.projectId ?? 'none'}`, [newThreadDialog.projectId])

  useEffect(() => {
    if (!newThreadDialog.open || !project) return
    let cancelled = false
    setLoadingBranches(true)
    window.api.git.getBranches(project.repoPath)
      .then((list) => {
        if (cancelled) return
        const normalized = Array.from(new Set(list.map((branch) => normalizeBranch(branch)).filter(Boolean)))
        setBranches(normalized)
        if (!newThreadDialog.branch && normalized.length > 0) {
          setNewThreadDialog({ branch: normalized[0] })
        }
      })
      .catch(() => {
        if (!cancelled) setBranches([])
      })
      .finally(() => {
        if (!cancelled) setLoadingBranches(false)
      })
    return () => {
      cancelled = true
    }
  }, [newThreadDialog.open, project, newThreadDialog.branch, setNewThreadDialog])

  if (!newThreadDialog.open) return null

  const startDisabled = !project || !newThreadDialog.branch.trim() || creating

  const handleStart = async () => {
    if (startDisabled) return
    setCreating(true)
    try {
      await confirmNewThreadDialog()
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open onOpenChange={(_, data) => { if (!data.open && !creating) closeNewThreadDialog() }}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>New thread</DialogTitle>
          <DialogContent className={styles.content}>
            <div className={styles.projectLine}>
              <span className={styles.label}>Project</span>
              <span className={styles.value}>{project?.name ?? 'Unknown project'}</span>
            </div>

            <label className={styles.label}>Context mode</label>
            <div className={styles.modeToggle}>
              <button
                type="button"
                className={`${styles.modeButton} ${newThreadDialog.mode === 'existing' ? styles.modeButtonActive : ''}`}
                onClick={() => setNewThreadDialog({ mode: 'existing' })}
                disabled={creating}
              >
                Existing branch
              </button>
              <button
                type="button"
                className={`${styles.modeButton} ${newThreadDialog.mode === 'new' ? styles.modeButtonActive : ''}`}
                onClick={() => setNewThreadDialog({ mode: 'new' })}
                disabled={creating}
              >
                New branch
              </button>
            </div>

            <label className={styles.label}>Branch</label>
            <input
              className={styles.input}
              value={newThreadDialog.branch}
              onChange={(event) => setNewThreadDialog({ branch: normalizeBranch(event.target.value) })}
              placeholder="main"
              list={listId}
              disabled={creating}
            />
            <datalist id={listId}>
              {branches.map((branch) => (
                <option key={branch} value={branch} />
              ))}
            </datalist>

            {newThreadDialog.mode === 'new' && (
              <>
                <label className={styles.label}>Base branch</label>
                <input
                  className={styles.input}
                  value={newThreadDialog.baseBranch}
                  onChange={(event) => setNewThreadDialog({ baseBranch: normalizeBranch(event.target.value) })}
                  placeholder="main"
                  list={listId}
                  disabled={creating}
                />
              </>
            )}

            <div className={styles.hint}>
              {loadingBranches
                ? 'Loading branches...'
                : 'Changing branch here switches context/workspace; it does not retarget the current thread.'}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={closeNewThreadDialog} disabled={creating}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={handleStart} disabled={startDisabled}>
              {creating ? 'Starting...' : 'Start thread'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}

