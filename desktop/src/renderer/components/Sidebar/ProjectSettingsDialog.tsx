import { useState, useCallback } from 'react'
import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
} from '@fluentui/react-components'
import { parseProjectOwnership, type Project, type ProjectOwnership, type PrLinkProvider, type StartupCommand } from '../../store/types'
import styles from './ProjectSettingsDialog.module.css'

interface Props {
  project: Project
  onSave: (settings: {
    startupCommands: StartupCommand[]
    prLinkProvider: PrLinkProvider
    ownership: ProjectOwnership
  }) => void
  onCancel: () => void
}

export function ProjectSettingsDialog({ project, onSave, onCancel }: Props) {
  const [commands, setCommands] = useState<StartupCommand[]>(
    project.startupCommands?.length ? [...project.startupCommands] : []
  )
  const [prLinkProvider, setPrLinkProvider] = useState<PrLinkProvider>(
    project.prLinkProvider ?? 'github'
  )
  const [ownership, setOwnership] = useState<ProjectOwnership>(
    parseProjectOwnership(project.ownership)
  )

  const handleAdd = useCallback(() => {
    setCommands((prev) => [...prev, { name: '', command: '' }])
  }, [])

  const handleRemove = useCallback((index: number) => {
    setCommands((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleChange = useCallback((index: number, field: keyof StartupCommand, value: string) => {
    setCommands((prev) =>
      prev.map((cmd, i) => (i === index ? { ...cmd, [field]: value } : cmd))
    )
  }, [])

  const handleSave = useCallback(() => {
    // Filter out entries with no command
    const filtered = commands.filter((c) => c.command.trim())
    onSave({
      startupCommands: filtered.length > 0 ? filtered : [],
      prLinkProvider,
      ownership,
    })
  }, [commands, onSave, ownership, prLinkProvider])

  return (
    <Dialog open onOpenChange={(_, data) => { if (!data.open) onCancel() }}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>{project.name}</DialogTitle>
          <DialogContent className={styles.content}>
            <label className={styles.label}>Startup Commands</label>
            <div className={styles.hint}>
              Run when creating a workspace.
            </div>

            <div className={styles.commandList}>
              {commands.map((cmd, i) => (
                <div key={i} className={styles.commandRow}>
                  <input
                    className={`${styles.input} ${styles.nameInput}`}
                    value={cmd.name}
                    onChange={(e) => handleChange(i, 'name', e.target.value)}
                    placeholder="Tab name"
                  />
                  <input
                    className={styles.input}
                    value={cmd.command}
                    onChange={(e) => handleChange(i, 'command', e.target.value)}
                    placeholder="command"
                    autoFocus={i === commands.length - 1}
                  />
                  <button
                    aria-label={`Remove startup command ${i + 1}`}
                    className={styles.removeBtn}
                    onClick={() => handleRemove(i)}
                    title="Remove"
                  >
                    &#10005;
                  </button>
                </div>
              ))}

              <button className={styles.addBtn} onClick={handleAdd}>
                <span>+</span>
                <span>Add command</span>
              </button>
            </div>

            <label className={styles.label}>PR Link Provider</label>
            <div className={styles.hint}>
              Where this project opens pull request links.
            </div>
            <select
              className={styles.selectInput}
              value={prLinkProvider}
              onChange={(e) => setPrLinkProvider(e.target.value as PrLinkProvider)}
            >
              <option value="github">GitHub</option>
              <option value="graphite">Graphite</option>
              <option value="devinreview">Devin Review</option>
            </select>

            <label className={styles.label}>Ownership</label>
            <div className={styles.hint}>
              Controls which GitHub account is preferred for this project.
            </div>
            <select
              className={styles.selectInput}
              value={ownership}
              onChange={(e) => setOwnership(parseProjectOwnership(e.target.value))}
            >
              <option value="personal">Personal</option>
              <option value="work">Laburo</option>
            </select>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
            <Button appearance="primary" onClick={handleSave}>Save</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
