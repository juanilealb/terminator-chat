import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
} from '@fluentui/react-components'
import {
  DEFAULT_PROJECT_OWNERSHIP,
  parseProjectOwnership,
  type ProjectOwnership,
} from '../../store/types'
import styles from './AddProjectDialog.module.css'

interface Props {
  open: boolean
  initialName: string
  repoPath: string
  initialOwnership?: ProjectOwnership
  onCancel: () => void
  onConfirm: (name: string, ownership: ProjectOwnership) => void
}

export function AddProjectDialog({
  open,
  initialName,
  repoPath,
  initialOwnership,
  onCancel,
  onConfirm,
}: Props) {
  const [name, setName] = useState(initialName)
  const [ownership, setOwnership] = useState<ProjectOwnership>(
    parseProjectOwnership(initialOwnership ?? DEFAULT_PROJECT_OWNERSHIP),
  )

  useEffect(() => {
    if (!open) return
    setName(initialName)
    setOwnership(parseProjectOwnership(initialOwnership ?? DEFAULT_PROJECT_OWNERSHIP))
  }, [open, initialName, initialOwnership])

  const handleConfirm = () => {
    const trimmedName = name.trim()
    if (!trimmedName) return
    onConfirm(trimmedName, ownership)
  }

  return (
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onCancel() }}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>New project</DialogTitle>
          <DialogContent className={styles.content}>
            <label className={styles.label}>Repository path</label>
            <input className={styles.input} value={repoPath} readOnly />

            <label className={styles.label}>Project name</label>
            <input
              className={styles.input}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Project name"
              autoFocus
            />

            <label className={styles.label}>Ownership</label>
            <select
              className={styles.input}
              value={ownership}
              onChange={(event) => setOwnership(parseProjectOwnership(event.target.value))}
            >
              <option value="personal">Personal</option>
              <option value="work">Laburo</option>
            </select>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
            <Button appearance="primary" onClick={handleConfirm} disabled={!name.trim()}>
              Create
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
