import { useEffect, useMemo, useState } from 'react'
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

export interface AddProjectDialogSubmission {
  mode: 'existing' | 'new'
  name: string
  ownership: ProjectOwnership
  existingPath?: string
  parentDir?: string
  createRemote?: boolean
  visibility?: 'public' | 'private'
}

interface Props {
  open: boolean
  initialName?: string
  initialPath?: string
  initialOwnership?: ProjectOwnership
  preferredPersonalLogin?: string
  preferredWorkLogin?: string
  onCancel: () => void
  onConfirm: (payload: AddProjectDialogSubmission) => void
}

function folderNameFromPath(input: string): string {
  const normalized = input.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized) return ''
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

export function AddProjectDialog({
  open,
  initialName,
  initialPath,
  initialOwnership,
  preferredPersonalLogin,
  preferredWorkLogin,
  onCancel,
  onConfirm,
}: Props) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [name, setName] = useState(initialName ?? '')
  const [ownership, setOwnership] = useState<ProjectOwnership>(
    parseProjectOwnership(initialOwnership ?? DEFAULT_PROJECT_OWNERSHIP),
  )
  const [existingPath, setExistingPath] = useState(initialPath ?? '')
  const [parentDir, setParentDir] = useState('')
  const [createRemote, setCreateRemote] = useState(true)
  const [visibility, setVisibility] = useState<'public' | 'private'>('private')
  const existingName = useMemo(() => folderNameFromPath(existingPath), [existingPath])

  const ownerPreview = useMemo(() => {
    if (ownership === 'work') return (preferredWorkLogin?.trim() || 'jleal-quintana')
    return (preferredPersonalLogin?.trim() || 'juanilealb')
  }, [ownership, preferredPersonalLogin, preferredWorkLogin])

  useEffect(() => {
    if (!open) return
    setMode(initialPath ? 'existing' : 'new')
    setName(initialName ?? '')
    setOwnership(parseProjectOwnership(initialOwnership ?? DEFAULT_PROJECT_OWNERSHIP))
    setExistingPath(initialPath ?? '')
    setParentDir('')
    setCreateRemote(true)
    setVisibility('private')
  }, [open, initialName, initialOwnership, initialPath])

  useEffect(() => {
    if (mode !== 'existing') return
    setName(existingName)
  }, [existingName, mode])

  const handleBrowseExistingPath = async () => {
    const dir = await window.api.app.selectDirectory()
    if (!dir) return
    setExistingPath(dir)
  }

  const handleBrowseParentDir = async () => {
    const dir = await window.api.app.selectDirectory()
    if (!dir) return
    setParentDir(dir)
  }

  const handleConfirm = () => {
    const trimmedName = name.trim()
    if (!trimmedName) return
    if (mode === 'existing') {
      const path = existingPath.trim()
      if (!path) return
      onConfirm({
        mode,
        name: existingName || trimmedName,
        ownership,
        existingPath: path,
      })
      return
    }

    const parent = parentDir.trim()
    if (!parent) return
    onConfirm({
      mode,
      name: trimmedName,
      ownership,
      parentDir: parent,
      createRemote,
      visibility,
    })
  }

  const canConfirm = mode === 'existing'
    ? Boolean(existingPath.trim())
    : Boolean(name.trim() && parentDir.trim())

  return (
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onCancel() }}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>New project</DialogTitle>
          <DialogContent className={styles.content}>
            <label className={styles.label}>Start from</label>
            <div className={styles.segmented}>
              <button
                type="button"
                className={`${styles.segment} ${mode === 'existing' ? styles.segmentActive : ''}`}
                onClick={() => setMode('existing')}
              >
                Existing folder
              </button>
              <button
                type="button"
                className={`${styles.segment} ${mode === 'new' ? styles.segmentActive : ''}`}
                onClick={() => setMode('new')}
              >
                Create repo
              </button>
            </div>

            <label className={styles.label}>Project name</label>
            <input
              className={styles.input}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Project name"
              autoFocus
              readOnly={mode === 'existing'}
            />

            {mode === 'existing' ? (
              <>
                <label className={styles.label}>Repository path</label>
                <div className={styles.row}>
                  <input
                    className={styles.input}
                    value={existingPath}
                    onChange={(event) => setExistingPath(event.target.value)}
                    placeholder="C:\\dev\\my-repo"
                  />
                  <Button appearance="secondary" onClick={() => void handleBrowseExistingPath()}>
                    Browse
                  </Button>
                </div>
              </>
            ) : (
              <>
                <label className={styles.label}>Parent folder</label>
                <div className={styles.row}>
                  <input
                    className={styles.input}
                    value={parentDir}
                    onChange={(event) => setParentDir(event.target.value)}
                    placeholder="C:\\dev"
                  />
                  <Button appearance="secondary" onClick={() => void handleBrowseParentDir()}>
                    Browse
                  </Button>
                </div>
              </>
            )}

            <label className={styles.label}>Ownership</label>
            <select
              className={styles.input}
              value={ownership}
              onChange={(event) => setOwnership(parseProjectOwnership(event.target.value))}
            >
              <option value="personal">Personal</option>
              <option value="work">Laburo</option>
            </select>

            {mode === 'new' && (
              <>
                <label className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={createRemote}
                    onChange={(event) => setCreateRemote(event.target.checked)}
                  />
                  <span>Create GitHub repository</span>
                </label>
                {createRemote && (
                  <>
                    <label className={styles.label}>Visibility</label>
                    <select
                      className={styles.input}
                      value={visibility}
                      onChange={(event) => setVisibility(event.target.value === 'public' ? 'public' : 'private')}
                    >
                      <option value="private">Private</option>
                      <option value="public">Public</option>
                    </select>
                    <div className={styles.hint}>GitHub owner: {ownerPreview}</div>
                  </>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
            <Button appearance="primary" onClick={handleConfirm} disabled={!canConfirm}>
              Create
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
