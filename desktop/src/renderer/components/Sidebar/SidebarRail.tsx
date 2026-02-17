import { Fragment, useCallback, useMemo, useState } from 'react'
import { formatShortcut } from '@shared/platform'
import { SHORTCUT_MAP } from '@shared/shortcuts'
import { useAppStore } from '../../store/app-store'
import { AddProjectDialog, type AddProjectDialogSubmission } from './AddProjectDialog'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './SidebarRail.module.css'

interface WorkspaceWithState {
  id: string
  name: string
  projectId: string
  projectName: string
  isActive: boolean
  isRunning: boolean
  isWaiting: boolean
  isCompleted: boolean
  isUnread: boolean
}

interface AddProjectDraft {
  initialName?: string
  initialPath?: string
}

export function SidebarRail() {
  const projects = useAppStore((s) => s.projects)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeClaudeWorkspaceIds = useAppStore((s) => s.activeClaudeWorkspaceIds)
  const waitingClaudeWorkspaceIds = useAppStore((s) => s.waitingClaudeWorkspaceIds)
  const completedClaudeWorkspaceIds = useAppStore((s) => s.completedClaudeWorkspaceIds)
  const unreadWorkspaceIds = useAppStore((s) => s.unreadWorkspaceIds)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const openNewThreadDialog = useAppStore((s) => s.openNewThreadDialog)
  const setNewThreadDialog = useAppStore((s) => s.setNewThreadDialog)
  const addProject = useAppStore((s) => s.addProject)
  const addToast = useAppStore((s) => s.addToast)
  const toggleSettings = useAppStore((s) => s.toggleSettings)
  const settings = useAppStore((s) => s.settings)
  const defaultProjectOwnership = useAppStore((s) => s.settings.defaultProjectOwnership)
  const [addProjectDraft, setAddProjectDraft] = useState<AddProjectDraft | null>(null)

  const activeProjectId =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.projectId ?? null

  const ordered = useMemo<WorkspaceWithState[]>(() => {
    const projectNameById = new Map(projects.map((project) => [project.id, project.name]))
    return projects.flatMap((project) =>
      workspaces
        .filter((workspace) => workspace.projectId === project.id)
        .map((workspace) => {
          const isRunning = activeClaudeWorkspaceIds.has(workspace.id)
          const isWaiting = !isRunning && waitingClaudeWorkspaceIds.has(workspace.id)
          const isCompleted = !isRunning && !isWaiting && completedClaudeWorkspaceIds.has(workspace.id)
          const isUnread = !isRunning && !isWaiting && !isCompleted && unreadWorkspaceIds.has(workspace.id)
          return {
            id: workspace.id,
            name: workspace.name,
            projectId: workspace.projectId,
            projectName: projectNameById.get(workspace.projectId) ?? 'Project',
            isActive: workspace.id === activeWorkspaceId,
            isRunning,
            isWaiting,
            isCompleted,
            isUnread,
          }
        }),
    )
  }, [
    projects,
    workspaces,
    activeWorkspaceId,
    activeClaudeWorkspaceIds,
    waitingClaudeWorkspaceIds,
    completedClaudeWorkspaceIds,
    unreadWorkspaceIds,
  ])

  const handleAddProject = useCallback(() => {
    setAddProjectDraft({})
  }, [])

  const handleConfirmAddProject = useCallback(async (payload: AddProjectDialogSubmission) => {
    if (!addProjectDraft) return

    if (payload.mode === 'existing') {
      const repoPath = (payload.existingPath ?? '').trim()
      if (!repoPath) return
      const validPath = await window.api.app.addProjectPath(repoPath)
      if (!validPath) {
        addToast({ id: crypto.randomUUID(), message: 'Folder not found.', type: 'error' })
        return
      }
      const existingProject = projects.find((project) => project.repoPath === validPath)
      if (existingProject) {
        addToast({
          id: crypto.randomUUID(),
          message: `Project "${existingProject.name}" already exists.`,
          type: 'info',
        })
        return
      }
      addProject({
        id: crypto.randomUUID(),
        name: payload.name,
        repoPath: validPath,
        ownership: payload.ownership,
      })
      setAddProjectDraft(null)
      return
    }

    try {
      const owner = payload.ownership === 'work'
        ? (settings.githubWorkLogin.trim() || 'jleal-quintana')
        : (settings.githubPersonalLogin.trim() || 'juanilealb')
      const result = await window.api.app.createProject({
        parentDir: payload.parentDir ?? '',
        projectName: payload.name,
        ownership: payload.ownership,
        createRemote: payload.createRemote,
        visibility: payload.visibility,
        githubOwner: owner,
      })
      addProject({
        id: crypto.randomUUID(),
        name: payload.name,
        repoPath: result.repoPath,
        ownership: payload.ownership,
      })
      setAddProjectDraft(null)
      addToast({
        id: crypto.randomUUID(),
        message: payload.createRemote
          ? `Project "${payload.name}" created with GitHub remote.`
          : `Project "${payload.name}" created locally.`,
        type: 'success',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create project'
      addToast({ id: crypto.randomUUID(), message, type: 'error' })
    }
  }, [addProject, addProjectDraft, addToast, projects, settings.githubPersonalLogin, settings.githubWorkLogin])

  const handleNewThread = useCallback(() => {
    const targetProject = (activeProjectId && projects.find((project) => project.id === activeProjectId))
      ?? projects[projects.length - 1]
      ?? null
    if (!targetProject) {
      addToast({ id: crypto.randomUUID(), message: 'Add a project first', type: 'info' })
      return
    }
    setNewThreadDialog({ projectId: targetProject.id })
    void openNewThreadDialog()
  }, [activeProjectId, addToast, openNewThreadDialog, projects, setNewThreadDialog])

  return (
    <div className={styles.rail}>
      <div className={styles.railHeader}>
        <div className={styles.sidebarToggleSlot}>
          <Tooltip
            label="Expand sidebar"
            shortcut={formatShortcut(SHORTCUT_MAP.toggleSidebar.mac, SHORTCUT_MAP.toggleSidebar.win)}
          >
            <button
              type="button"
              className={styles.sidebarToggle}
              onClick={toggleSidebar}
              aria-label="Expand sidebar"
            >
              <span className={styles.sidebarToggleGlyph}>&#x203a;</span>
            </button>
          </Tooltip>
        </div>
      </div>

      <div className={styles.workspaceList}>
        <div className={styles.primaryActionSlot}>
          <Tooltip
            label="New thread"
            shortcut={formatShortcut(SHORTCUT_MAP.newWorkspace.mac, SHORTCUT_MAP.newWorkspace.win)}
          >
            <button
              type="button"
              className={`${styles.sidebarToggle} ${styles.actionButton}`}
              aria-label="New thread"
              onClick={handleNewThread}
            >
              <span className={styles.actionGlyph}>+</span>
            </button>
          </Tooltip>
        </div>

        {ordered.length === 0 ? (
          <div className={styles.emptyMarker} title="No workspaces" aria-hidden="true" />
        ) : (
          ordered.map((workspace, index) => {
            const stateClass = workspace.isRunning
              ? styles.running
              : workspace.isWaiting
                ? styles.waiting
                : workspace.isCompleted
                  ? styles.completed
                : workspace.isUnread
                  ? styles.unread
                  : ''
            const hasProjectDivider =
              index > 0 && ordered[index - 1]?.projectId !== workspace.projectId

            return (
              <Fragment key={workspace.id}>
                {hasProjectDivider && <div className={styles.projectDivider} aria-hidden="true" />}
                <Tooltip label={`${workspace.projectName} - ${workspace.name}`}>
                  <button
                    className={`${styles.workspaceButton} ${workspace.isActive ? styles.active : ''} ${stateClass}`}
                    onClick={() => setActiveWorkspace(workspace.id)}
                    aria-label={`${workspace.projectName} ${workspace.name}`}
                  />
                </Tooltip>
              </Fragment>
            )
          })
        )}
      </div>

      <div className={styles.actions}>
        <div className={styles.actionSlot}>
          <Tooltip label="New project">
            <button
              type="button"
              className={`${styles.sidebarToggle} ${styles.actionButton}`}
              aria-label="New project"
              onClick={() => {
                void handleAddProject()
              }}
            >
              <span className={styles.actionGlyph}>+</span>
            </button>
          </Tooltip>
        </div>
        <div className={styles.actionSlot}>
          <Tooltip
            label="Settings"
            shortcut={formatShortcut(SHORTCUT_MAP.settings.mac, SHORTCUT_MAP.settings.win)}
          >
            <button
              type="button"
              className={`${styles.sidebarToggle} ${styles.actionButton}`}
              aria-label="Open settings"
              onClick={toggleSettings}
            >
              <span className={styles.actionGlyph}>&#x2699;</span>
            </button>
          </Tooltip>
        </div>
      </div>

      {addProjectDraft && (
        <AddProjectDialog
          open
          initialName={addProjectDraft.initialName}
          initialPath={addProjectDraft.initialPath}
          initialOwnership={defaultProjectOwnership}
          preferredPersonalLogin={settings.githubPersonalLogin}
          preferredWorkLogin={settings.githubWorkLogin}
          onCancel={() => setAddProjectDraft(null)}
          onConfirm={handleConfirmAddProject}
        />
      )}
    </div>
  )
}
