import { create } from 'zustand'
import type { AppState, PersistedState, Tab } from './types'
import {
  DEFAULT_AGENT_PERMISSION_MODE,
  DEFAULT_PROJECT_OWNERSHIP,
  DEFAULT_SETTINGS,
  DEFAULT_WORKSPACE_TYPE,
  parseProjectOwnership,
  parseAgentPermissionMode,
  isWorkspaceType,
} from './types'

const DEFAULT_PR_LINK_PROVIDER = 'github' as const
const DEFAULT_FALLBACK_BRANCH = 'main'

function normalizeBranchName(input: string): string {
  return input.trim().replace(/^origin\//, '').replace(/^refs\/heads\//, '')
}

function toWorktreeName(branch: string): string {
  const normalized = branch
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'thread'
}

function uniqueWorkspaceName(baseName: string, projectId: string, workspaces: Array<{ projectId: string; name: string }>): string {
  const normalized = baseName.trim() || 'thread'
  const used = new Set(
    workspaces
      .filter((ws) => ws.projectId === projectId)
      .map((ws) => ws.name.toLowerCase()),
  )
  if (!used.has(normalized.toLowerCase())) return normalized

  let suffix = 2
  while (used.has(`${normalized}-${suffix}`.toLowerCase())) {
    suffix += 1
  }
  return `${normalized}-${suffix}`
}

function nextThreadTitle(tabs: Tab[], workspaceId: string): string {
  const count = tabs.filter((tab) => tab.workspaceId === workspaceId && tab.type === 'chat').length
  return `Thread ${count + 1}`
}

function basenameFromPath(dirPath: string): string {
  const normalized = dirPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? dirPath
}

function formatUserError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback
  const invokePrefix = /^Error invoking remote method '[^']+': Error:\s*/i
  return err.message.replace(invokePrefix, '') || fallback
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  workspaces: [],
  tabs: [],
  activeWorkspaceId: null,
  activeTabId: null,
  lastActiveTabByWorkspace: {},
  rightPanelMode: 'files',
  rightPanelOpen: true,
  sidebarCollapsed: false,
  lastSavedTabId: null,
  workspaceDialogProjectId: null,
  lastSelectedBranchByProject: {},
  newThreadDialog: {
    open: false,
    projectId: null,
    mode: 'existing',
    branch: '',
    baseBranch: DEFAULT_FALLBACK_BRANCH,
  },
  settings: { ...DEFAULT_SETTINGS },
  settingsOpen: false,
  confirmDialog: null,
  toasts: [],
  quickOpenVisible: false,
  commandPaletteVisible: false,
  unreadWorkspaceIds: new Set<string>(),
  activeClaudeWorkspaceIds: new Set<string>(),
  waitingClaudeWorkspaceIds: new Set<string>(),
  completedClaudeWorkspaceIds: new Set<string>(),
  runningAgentCount: 0,
  waitingAgentCount: 0,
  prStatusMap: new Map(),
  ghAvailability: new Map(),
  ghErrorMap: new Map(),
  chatMessages: {},
  codexLoggedIn: false,
  chatThread: null,

  addProject: (project) =>
    set((s) => ({
      projects: [
        ...s.projects,
        {
          ...project,
          ownership: parseProjectOwnership(project.ownership ?? s.settings.defaultProjectOwnership),
          prLinkProvider: project.prLinkProvider ?? DEFAULT_PR_LINK_PROVIDER,
        },
      ],
    })),

  removeProject: (id) =>
    set((s) => {
      const removedWsIds = new Set(s.workspaces.filter((w) => w.projectId === id).map((w) => w.id))
      const tabMap = { ...s.lastActiveTabByWorkspace }
      const unreadWorkspaceIds = new Set(
        Array.from(s.unreadWorkspaceIds).filter((wsId) => !removedWsIds.has(wsId)),
      )
      const activeClaudeWorkspaceIds = new Set(
        Array.from(s.activeClaudeWorkspaceIds).filter((wsId) => !removedWsIds.has(wsId)),
      )
      const waitingClaudeWorkspaceIds = new Set(
        Array.from(s.waitingClaudeWorkspaceIds).filter((wsId) => !removedWsIds.has(wsId)),
      )
      const completedClaudeWorkspaceIds = new Set(
        Array.from(s.completedClaudeWorkspaceIds).filter((wsId) => !removedWsIds.has(wsId)),
      )
      for (const wsId of removedWsIds) delete tabMap[wsId]
      return {
        projects: s.projects.filter((p) => p.id !== id),
        workspaces: s.workspaces.filter((w) => w.projectId !== id),
        unreadWorkspaceIds,
        activeClaudeWorkspaceIds,
        waitingClaudeWorkspaceIds,
        completedClaudeWorkspaceIds,
        runningAgentCount: activeClaudeWorkspaceIds.size,
        waitingAgentCount: waitingClaudeWorkspaceIds.size,
        lastActiveTabByWorkspace: tabMap,
      }
    }),

  addWorkspace: (workspace) =>
    set((s) => ({
      workspaces: [...s.workspaces, workspace],
      activeWorkspaceId: workspace.id,
    })),

  removeWorkspace: (id) =>
    set((s) => {
      const newWorkspaces = s.workspaces.filter((w) => w.id !== id)
      const newTabs = s.tabs.filter((t) => t.workspaceId !== id)
      const newUnread = new Set(s.unreadWorkspaceIds)
      const newActiveClaude = new Set(s.activeClaudeWorkspaceIds)
      const newWaitingClaude = new Set(s.waitingClaudeWorkspaceIds)
      const newCompletedClaude = new Set(s.completedClaudeWorkspaceIds)
      newUnread.delete(id)
      newActiveClaude.delete(id)
      newWaitingClaude.delete(id)
      newCompletedClaude.delete(id)
      const tabMap = { ...s.lastActiveTabByWorkspace }
      delete tabMap[id]
      return {
        workspaces: newWorkspaces,
        tabs: newTabs,
        unreadWorkspaceIds: newUnread,
        activeClaudeWorkspaceIds: newActiveClaude,
        waitingClaudeWorkspaceIds: newWaitingClaude,
        completedClaudeWorkspaceIds: newCompletedClaude,
        runningAgentCount: newActiveClaude.size,
        waitingAgentCount: newWaitingClaude.size,
        lastActiveTabByWorkspace: tabMap,
        activeWorkspaceId:
          s.activeWorkspaceId === id
            ? newWorkspaces[0]?.id ?? null
            : s.activeWorkspaceId,
        activeTabId:
          newTabs.find((t) => t.id === s.activeTabId)
            ? s.activeTabId
            : newTabs[0]?.id ?? null,
      }
    }),

  renameWorkspace: (id, name) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => w.id === id ? { ...w, name } : w),
    })),

  updateWorkspaceBranch: (id, branch) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => w.id === id ? { ...w, branch } : w),
    })),

  updateWorkspaceAgentPermissionMode: (id, mode) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => w.id === id ? { ...w, agentPermissionMode: mode } : w),
    })),

  updateWorkspaceMemory: (id, memory) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => w.id === id ? { ...w, memory } : w),
    })),

  setActiveWorkspace: (id) =>
    set((s) => {
      // Remember which tab was active in the workspace we're leaving
      const tabMap = { ...s.lastActiveTabByWorkspace }
      if (s.activeWorkspaceId && s.activeTabId) {
        tabMap[s.activeWorkspaceId] = s.activeTabId
      }

      const wsTabs = s.tabs.filter((t) => t.workspaceId === id)
      const newUnread = new Set(s.unreadWorkspaceIds)
      const newCompleted = new Set(s.completedClaudeWorkspaceIds)
      if (id) newUnread.delete(id)
      if (id) newCompleted.delete(id)

      // Restore remembered tab, falling back to first tab
      const remembered = id ? tabMap[id] : null
      const activeTabId = remembered && wsTabs.some((t) => t.id === remembered)
        ? remembered
        : wsTabs[0]?.id ?? null

      return {
        activeWorkspaceId: id,
        activeTabId,
        lastActiveTabByWorkspace: tabMap,
        unreadWorkspaceIds: newUnread,
        completedClaudeWorkspaceIds: newCompleted,
      }
    }),

  addTab: (tab) =>
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
    })),

  removeTab: (id) =>
    set((s) => {
      const newTabs = s.tabs.filter((t) => t.id !== id)
      const wasActive = s.activeTabId === id
      const wsTabs = newTabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
      return {
        tabs: newTabs,
        activeTabId: wasActive ? (wsTabs[wsTabs.length - 1]?.id ?? null) : s.activeTabId,
      }
    }),

  setActiveTab: (id) => set({ activeTabId: id }),

  setRightPanelMode: (mode) => set({ rightPanelMode: mode }),

  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  nextTab: () => {
    const s = get()
    const wsTabs = s.tabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
    if (wsTabs.length <= 1) return
    const idx = wsTabs.findIndex((t) => t.id === s.activeTabId)
    const next = wsTabs[(idx + 1) % wsTabs.length]
    set({ activeTabId: next.id })
  },

  prevTab: () => {
    const s = get()
    const wsTabs = s.tabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
    if (wsTabs.length <= 1) return
    const idx = wsTabs.findIndex((t) => t.id === s.activeTabId)
    const prev = wsTabs[(idx - 1 + wsTabs.length) % wsTabs.length]
    set({ activeTabId: prev.id })
  },

  createChatForActiveWorkspace: async () => {
    let s = get()
    let workspaceId = s.activeWorkspaceId
    let ws = workspaceId ? s.workspaces.find((w) => w.id === workspaceId) : undefined

    // Quick-start path: if there's no active workspace, ask for a folder and create one.
    if (!ws) {
      const dirPath = await window.api.app.selectDirectory()
      if (!dirPath) return

      const existingWorkspace = s.workspaces.find((w) => w.worktreePath === dirPath)
      if (existingWorkspace) {
        workspaceId = existingWorkspace.id
        get().setActiveWorkspace(workspaceId)
        ws = existingWorkspace
      } else {
        const normalizedPath = dirPath.replace(/\\/g, '/')
        const pathParts = normalizedPath.split('/').filter(Boolean)
        const baseName = pathParts[pathParts.length - 1] || 'workspace'

        let branch = ''
        try {
          branch = await window.api.git.getCurrentBranch(dirPath)
        } catch {
          // Non-git directories are still valid.
        }

        let project = s.projects.find((p) => p.repoPath === dirPath)
        if (!project) {
          project = {
            id: crypto.randomUUID(),
            name: baseName,
            repoPath: dirPath,
            ownership: s.settings.defaultProjectOwnership ?? DEFAULT_PROJECT_OWNERSHIP,
          }
          get().addProject(project)
        }

        const newWorkspace = {
          id: crypto.randomUUID(),
          name: `${baseName}-quick`,
          type: DEFAULT_WORKSPACE_TYPE,
          branch: branch || 'local',
          worktreePath: dirPath,
          projectId: project.id,
          agentPermissionMode: DEFAULT_AGENT_PERMISSION_MODE,
          memory: '',
        }
        get().addWorkspace(newWorkspace)
        workspaceId = newWorkspace.id
        ws = newWorkspace
      }

      s = get()
    }

    if (!workspaceId || !ws) return

    get().addTab({
      id: crypto.randomUUID(),
      workspaceId,
      type: 'chat',
      title: nextThreadTitle(get().tabs, workspaceId),
      threadId: crypto.randomUUID(),
    })
  },

  openDirectory: async (dirPath) => {
    const validDirPath = await window.api.app.addProjectPath(dirPath)
    if (!validDirPath) return

    const existingWorkspace = get().workspaces.find((w) => w.worktreePath === validDirPath)
    if (existingWorkspace) {
      get().setActiveWorkspace(existingWorkspace.id)
      const latest = get()
      const wsTabs = latest.tabs.filter((t) => t.workspaceId === existingWorkspace.id)
      if (wsTabs.length === 0) {
        await latest.createChatForActiveWorkspace()
      } else {
        latest.setActiveTab(wsTabs[wsTabs.length - 1].id)
      }
      return
    }

    const baseName = basenameFromPath(validDirPath) || validDirPath
    let project = get().projects.find((p) => p.repoPath === validDirPath)
    if (!project) {
      const nextSettings = get().settings
      project = {
        id: crypto.randomUUID(),
        name: baseName,
        repoPath: validDirPath,
        ownership: nextSettings.defaultProjectOwnership ?? DEFAULT_PROJECT_OWNERSHIP,
      }
      get().addProject(project)
    }

    const currentState = get()
    let workspace = currentState.workspaces.find(
      (w) => w.projectId === project.id && w.worktreePath === validDirPath
    )
    if (!workspace) {
      let branch = ''
      try {
        branch = await window.api.git.getCurrentBranch(validDirPath)
      } catch {
        // Non-git directories are valid.
      }

      workspace = {
        id: crypto.randomUUID(),
        name: `${baseName}-quick`,
        type: DEFAULT_WORKSPACE_TYPE,
        branch: branch || 'local',
        worktreePath: validDirPath,
        projectId: project.id,
        agentPermissionMode: DEFAULT_AGENT_PERMISSION_MODE,
        memory: '',
      }
      get().addWorkspace(workspace)
    } else {
      get().setActiveWorkspace(workspace.id)
    }

    const latest = get()
    const workspaceTabs = latest.tabs.filter((t) => t.workspaceId === workspace.id)
    if (workspaceTabs.length === 0) {
      await latest.createChatForActiveWorkspace()
      return
    }
    const chatTab = workspaceTabs.find((t) => t.type === 'chat')
    latest.setActiveTab((chatTab ?? workspaceTabs[0]).id)
  },

  closeActiveTab: () => {
    const s = get()
    if (!s.activeTabId) return
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return
    const closeTab = () => {
      const latest = get()
      const latestTab = latest.tabs.find((t) => t.id === tab.id)
      if (!latestTab) return
      latest.removeTab(latestTab.id)
    }

    if (tab.type === 'file' && tab.unsaved && s.settings.confirmOnClose) {
      get().showConfirmDialog({
        title: 'Unsaved changes',
        message: 'This file has unsaved changes. Close anyway?',
        confirmLabel: 'Close',
        destructive: true,
        onConfirm: () => {
          closeTab()
          get().dismissConfirmDialog()
        },
      })
      return
    }

    closeTab()
  },

  setTabUnsaved: (tabId, unsaved) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId && t.type === 'file' ? { ...t, unsaved } : t
      ),
    })),

  notifyTabSaved: (tabId) => {
    set({ lastSavedTabId: tabId })
    setTimeout(() => {
      if (get().lastSavedTabId === tabId) set({ lastSavedTabId: null })
    }, 1200)
  },

  openFileTab: (filePath) => {
    const s = get()
    if (!s.activeWorkspaceId) return
    const existing = s.tabs.find(
      (t) => t.workspaceId === s.activeWorkspaceId && t.type === 'file' && t.filePath === filePath
    )
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }
    get().addTab({
      id: crypto.randomUUID(),
      workspaceId: s.activeWorkspaceId,
      type: 'file',
      filePath,
    })
  },

  nextWorkspace: () => {
    const s = get()
    if (s.workspaces.length <= 1) return
    // Build visual order: workspaces grouped by project, matching sidebar display
    const ordered = s.projects.flatMap((p) =>
      s.workspaces.filter((w) => w.projectId === p.id),
    )
    if (ordered.length <= 1) return
    const idx = ordered.findIndex((w) => w.id === s.activeWorkspaceId)
    const next = ordered[(idx + 1) % ordered.length]
    get().setActiveWorkspace(next.id)
  },

  prevWorkspace: () => {
    const s = get()
    if (s.workspaces.length <= 1) return
    const ordered = s.projects.flatMap((p) =>
      s.workspaces.filter((w) => w.projectId === p.id),
    )
    if (ordered.length <= 1) return
    const idx = ordered.findIndex((w) => w.id === s.activeWorkspaceId)
    const prev = ordered[(idx - 1 + ordered.length) % ordered.length]
    get().setActiveWorkspace(prev.id)
  },

  switchToTabByIndex: (index) => {
    const s = get()
    const wsTabs = s.tabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
    if (index >= 0 && index < wsTabs.length) {
      set({ activeTabId: wsTabs[index].id })
    }
  },

  closeAllWorkspaceTabs: () => {
    const s = get()
    if (!s.activeWorkspaceId) return
    const closeTabs = () => {
      const latest = get()
      const wsId = latest.activeWorkspaceId
      if (!wsId) return
      set((state) => ({
        tabs: state.tabs.filter((t) => t.workspaceId !== wsId),
        activeTabId: null,
      }))
    }

    const wsTabs = s.tabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
    const hasUnsaved = wsTabs.some((t) => t.type === 'file' && t.unsaved)
    if (hasUnsaved && s.settings.confirmOnClose) {
      get().showConfirmDialog({
        title: 'Unsaved changes',
        message: 'Close all tabs? Some have unsaved changes.',
        confirmLabel: 'Close all',
        destructive: true,
        onConfirm: () => {
          closeTabs()
          get().dismissConfirmDialog()
        },
      })
      return
    }

    closeTabs()
  },

  focusOrCreateChat: async () => {
    const s = get()
    const wsTabs = s.activeWorkspaceId
      ? s.tabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
      : []
    const chatTab = wsTabs.find((t) => t.type === 'chat')
    if (chatTab) {
      set({ activeTabId: chatTab.id })
    } else {
      await get().createChatForActiveWorkspace()
    }
  },

  openWorkspaceDialog: (projectId) => set({ workspaceDialogProjectId: projectId }),

  openNewThreadDialog: async () => {
    const s = get()
    const hintedProject = s.newThreadDialog.projectId
      ? s.projects.find((project) => project.id === s.newThreadDialog.projectId)
      : undefined
    const activeWorkspace = s.activeWorkspaceId
      ? s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId)
      : undefined
    const activeProject = activeWorkspace
      ? s.projects.find((project) => project.id === activeWorkspace.projectId)
      : undefined
    const project = hintedProject ?? activeProject ?? (s.projects.length === 1 ? s.projects[0] : undefined)

    if (!project) {
      get().addToast({ id: crypto.randomUUID(), message: 'Select a project first', type: 'info' })
      return
    }

    let targetBranch = 'main'
    try {
      const branches = await window.api.git.getBranches(project.repoPath)
      const normalized = new Set(branches.map((branch) => normalizeBranchName(branch)).filter(Boolean))
      if (!normalized.has('main')) {
        const fallback = normalizeBranchName(await window.api.git.getDefaultBranch(project.repoPath))
        if (fallback) targetBranch = fallback
      }
    } catch {
      // Keep main as default when branch lookup fails.
    }

    set({
      workspaceDialogProjectId: null,
      newThreadDialog: {
        open: false,
        projectId: project.id,
        mode: 'existing',
        branch: targetBranch,
        baseBranch: targetBranch,
      },
    })
    await get().confirmNewThreadDialog()
  },

  closeNewThreadDialog: () =>
    set((s) => ({
      newThreadDialog: {
        ...s.newThreadDialog,
        open: false,
      },
    })),

  setNewThreadDialog: (partial) =>
    set((s) => ({
      newThreadDialog: {
        ...s.newThreadDialog,
        ...partial,
      },
    })),

  confirmNewThreadDialog: async () => {
    const s = get()
    const dialog = s.newThreadDialog
    if (!dialog.projectId) return

    const project = s.projects.find((entry) => entry.id === dialog.projectId)
    if (!project) {
      get().addToast({ id: crypto.randomUUID(), message: 'Project not found', type: 'error' })
      return
    }

    const branch = normalizeBranchName(dialog.branch)
    if (!branch) {
      get().addToast({ id: crypto.randomUUID(), message: 'Branch is required', type: 'error' })
      return
    }

    const baseBranch = normalizeBranchName(dialog.baseBranch) || DEFAULT_FALLBACK_BRANCH
    const mode = dialog.mode === 'new' ? 'new' : 'existing'
    let workspace = s.workspaces.find((entry) => entry.projectId === project.id && entry.branch === branch)

    if (!workspace) {
      const workspaceName = uniqueWorkspaceName(
        toWorktreeName(branch),
        project.id,
        s.workspaces,
      )

      // If branch is already checked out in the main repo path, reuse that context
      // instead of attempting to create a duplicate worktree for the same branch.
      if (mode === 'existing') {
        let projectCurrentBranch = ''
        try {
          projectCurrentBranch = normalizeBranchName(await window.api.git.getCurrentBranch(project.repoPath))
        } catch {
          projectCurrentBranch = ''
        }

        if (projectCurrentBranch === branch) {
          const repoWorkspace = s.workspaces.find(
            (entry) => entry.projectId === project.id && entry.worktreePath === project.repoPath,
          )
          if (repoWorkspace) {
            if (repoWorkspace.branch !== branch) {
              get().updateWorkspaceBranch(repoWorkspace.id, branch)
            }
            workspace = repoWorkspace
            get().setActiveWorkspace(repoWorkspace.id)
          } else {
            workspace = {
              id: crypto.randomUUID(),
              name: workspaceName,
              type: DEFAULT_WORKSPACE_TYPE,
              branch,
              worktreePath: project.repoPath,
              projectId: project.id,
              agentPermissionMode: DEFAULT_AGENT_PERMISSION_MODE,
              memory: '',
            }
            get().addWorkspace(workspace)
          }
        }
      }

      if (!workspace) {
        try {
          const worktreePath = await window.api.git.createWorktree(
            project.repoPath,
            workspaceName,
            branch,
            mode === 'new',
            mode === 'new' ? baseBranch : undefined,
          )
          workspace = {
            id: crypto.randomUUID(),
            name: workspaceName,
            type: DEFAULT_WORKSPACE_TYPE,
            branch,
            worktreePath,
            projectId: project.id,
            agentPermissionMode: DEFAULT_AGENT_PERMISSION_MODE,
            memory: '',
          }
          get().addWorkspace(workspace)
        } catch (err) {
          const msg = formatUserError(err, 'Failed to create worktree')

          // If git says the branch is already checked out in another worktree,
          // adopt that existing context instead of failing the thread creation.
          if (msg === 'BRANCH_CHECKED_OUT' && mode === 'existing') {
            try {
              const listed = await window.api.git.listWorktrees(project.repoPath)
              const matchingWorktree = listed.find(
                (entry) => normalizeBranchName(entry.branch) === branch && entry.path,
              )

              if (matchingWorktree) {
                const existingByPath = s.workspaces.find(
                  (entry) =>
                    entry.projectId === project.id &&
                    entry.worktreePath.toLowerCase() === matchingWorktree.path.toLowerCase(),
                )

                if (existingByPath) {
                  if (existingByPath.branch !== branch) {
                    get().updateWorkspaceBranch(existingByPath.id, branch)
                  }
                  workspace = existingByPath
                  get().setActiveWorkspace(existingByPath.id)
                } else {
                  workspace = {
                    id: crypto.randomUUID(),
                    name: workspaceName,
                    type: DEFAULT_WORKSPACE_TYPE,
                    branch,
                    worktreePath: matchingWorktree.path,
                    projectId: project.id,
                    agentPermissionMode: DEFAULT_AGENT_PERMISSION_MODE,
                    memory: '',
                  }
                  get().addWorkspace(workspace)
                }
              }
            } catch {
              // keep default error path below if we could not recover
            }
          }

          if (!workspace) {
            get().addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
            return
          }
        }
      }
    } else {
      get().setActiveWorkspace(workspace.id)
    }

    const latest = get()
    latest.addTab({
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      type: 'chat',
      title: nextThreadTitle(latest.tabs, workspace.id),
      threadId: crypto.randomUUID(),
    })
    latest.setLastSelectedBranch(project.id, branch)
    latest.closeNewThreadDialog()
  },

  setLastSelectedBranch: (projectId, branch) =>
    set((s) => ({
      lastSelectedBranchByProject: {
        ...s.lastSelectedBranchByProject,
        [projectId]: normalizeBranchName(branch),
      },
    })),

  deleteWorkspace: async (workspaceId) => {
    const s = get()
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    const project = s.projects.find((p) => p.id === ws.projectId)

    // Remove from state immediately so sidebar updates
    get().removeWorkspace(workspaceId)

    // Remove git worktree in background (skip if workspace uses the main repo directly)
    if (project && ws.worktreePath !== project.repoPath) {
      try {
        await window.api.git.removeWorktree(project.repoPath, ws.worktreePath)
      } catch (err) {
        const msg = formatUserError(err, 'Failed to remove worktree')
        get().addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
      }
    }
  },

  updateProject: (id, partial) =>
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, ...partial } : p)),
    })),

  deleteProject: async (projectId) => {
    const s = get()
    const project = s.projects.find((p) => p.id === projectId)
    if (!project) return
    const projectWorkspaces = s.workspaces.filter((w) => w.projectId === projectId)

    // Remove worktrees for all workspaces in this project
    for (const ws of projectWorkspaces) {
      if (ws.worktreePath !== project.repoPath) {
        try {
          await window.api.git.removeWorktree(project.repoPath, ws.worktreePath)
        } catch (err) {
          const msg = formatUserError(err, 'Failed to remove worktree')
          get().addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
        }
      }
    }

    get().removeProject(projectId)
  },

  updateSettings: (partial) =>
    set((s) => ({ settings: { ...s.settings, ...partial } })),

  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),

  showConfirmDialog: (dialog) => set({ confirmDialog: dialog }),

  dismissConfirmDialog: () => set({ confirmDialog: null }),

  addToast: (toast) =>
    set((s) => ({ toasts: [...s.toasts, toast] })),

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  toggleQuickOpen: () => set((s) => ({ quickOpenVisible: !s.quickOpenVisible })),
  closeQuickOpen: () => set({ quickOpenVisible: false }),
  toggleCommandPalette: () => set((s) => ({ commandPaletteVisible: !s.commandPaletteVisible })),
  openCommandPalette: () => set({ commandPaletteVisible: true }),
  closeCommandPalette: () => set({ commandPaletteVisible: false }),
  setCodexLoggedIn: (loggedIn) => set({ codexLoggedIn: loggedIn }),

  setChatThread: (thread) => set({ chatThread: thread }),

  addChatMessage: (message) =>
    set((s) => {
      if (!s.chatThread) return s
      return {
        chatThread: {
          ...s.chatThread,
          messages: [...s.chatThread.messages, message],
        },
      }
    }),

  setChatLoading: (loading) =>
    set((s) => {
      if (!s.chatThread) return s
      return {
        chatThread: { ...s.chatThread, loading },
      }
    }),

  sendChatMessage: (threadId, content) => {
    const userMsg = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content,
      type: 'text' as const,
      timestamp: Date.now(),
    }
    set((s) => ({
      chatMessages: {
        ...s.chatMessages,
        [threadId]: [...(s.chatMessages[threadId] ?? []), userMsg],
      },
    }))

    // Send to main process via IPC
    window.api.chat.send(threadId, content)
  },

  markWorkspaceUnread: (workspaceId) =>
    set((s) => {
      if (s.unreadWorkspaceIds.has(workspaceId)) return s
      const newUnread = new Set(s.unreadWorkspaceIds)
      newUnread.add(workspaceId)
      return { unreadWorkspaceIds: newUnread }
    }),

  clearWorkspaceUnread: (workspaceId) =>
    set((s) => {
      if (!s.unreadWorkspaceIds.has(workspaceId)) return s
      const newUnread = new Set(s.unreadWorkspaceIds)
      newUnread.delete(workspaceId)
      return { unreadWorkspaceIds: newUnread }
    }),

  setWorkspaceAgentStatus: (workspaceId, status) =>
    set((s) => {
      if (!workspaceId) return s

      const activeClaudeWorkspaceIds = new Set(s.activeClaudeWorkspaceIds)
      const waitingClaudeWorkspaceIds = new Set(s.waitingClaudeWorkspaceIds)
      const completedClaudeWorkspaceIds = new Set(s.completedClaudeWorkspaceIds)

      if (status === 'running') {
        activeClaudeWorkspaceIds.add(workspaceId)
        waitingClaudeWorkspaceIds.delete(workspaceId)
        completedClaudeWorkspaceIds.delete(workspaceId)
      } else if (status === 'waiting') {
        activeClaudeWorkspaceIds.delete(workspaceId)
        waitingClaudeWorkspaceIds.add(workspaceId)
        completedClaudeWorkspaceIds.delete(workspaceId)
      } else if (status === 'completed') {
        activeClaudeWorkspaceIds.delete(workspaceId)
        waitingClaudeWorkspaceIds.delete(workspaceId)
        if (workspaceId !== s.activeWorkspaceId) {
          completedClaudeWorkspaceIds.add(workspaceId)
        } else {
          completedClaudeWorkspaceIds.delete(workspaceId)
        }
      } else {
        activeClaudeWorkspaceIds.delete(workspaceId)
        waitingClaudeWorkspaceIds.delete(workspaceId)
        completedClaudeWorkspaceIds.delete(workspaceId)
      }

      return {
        activeClaudeWorkspaceIds,
        waitingClaudeWorkspaceIds,
        completedClaudeWorkspaceIds,
        runningAgentCount: activeClaudeWorkspaceIds.size,
        waitingAgentCount: waitingClaudeWorkspaceIds.size,
      }
    }),

  setActiveClaudeWorkspaces: (workspaceIds) =>
    set((s) => ({
      activeClaudeWorkspaceIds: new Set(workspaceIds),
      runningAgentCount: workspaceIds.length,
      waitingClaudeWorkspaceIds: new Set(),
      waitingAgentCount: 0,
      completedClaudeWorkspaceIds: new Set(
        Array.from(s.completedClaudeWorkspaceIds).filter((wsId) => !workspaceIds.includes(wsId)),
      ),
    })),

  setClaudeActivitySnapshot: (snapshot) =>
    set((s) => {
      const waitingAgentCount = Object.values(snapshot.waitingAgentsByWorkspace).reduce(
        (sum, count) => sum + count,
        0,
      )
      const activeSet = new Set(snapshot.runningWorkspaceIds)
      const waitingSet = new Set(snapshot.waitingWorkspaceIds)
      return {
        activeClaudeWorkspaceIds: activeSet,
        waitingClaudeWorkspaceIds: waitingSet,
        completedClaudeWorkspaceIds: new Set(
          Array.from(s.completedClaudeWorkspaceIds).filter((wsId) => !activeSet.has(wsId) && !waitingSet.has(wsId)),
        ),
        runningAgentCount: snapshot.runningAgentCount,
        waitingAgentCount,
      }
    }),

  setPrStatuses: (projectId, statuses) =>
    set((s) => {
      const newMap = new Map(s.prStatusMap)
      for (const [branch, info] of Object.entries(statuses)) {
        newMap.set(`${projectId}:${branch}`, info)
      }
      return { prStatusMap: newMap }
    }),

  setGhAvailability: (projectId, available, error) =>
    set((s) => {
      const newAvail = new Map(s.ghAvailability)
      newAvail.set(projectId, available)
      const newErrors = new Map(s.ghErrorMap)
      newErrors.set(projectId, error)
      return { ghAvailability: newAvail, ghErrorMap: newErrors }
    }),

  openDiffTab: (workspaceId) => {
    const s = get()
    const existing = s.tabs.find(
      (t) => t.workspaceId === workspaceId && t.type === 'diff'
    )
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }
    get().addTab({
      id: crypto.randomUUID(),
      workspaceId,
      type: 'diff',
    })
  },

  hydrateState: (data) => {
    const projects = (data.projects ?? []).map((project) => ({
      ...project,
      ownership: parseProjectOwnership(project.ownership),
      prLinkProvider: project.prLinkProvider ?? DEFAULT_PR_LINK_PROVIDER,
    }))
    const workspaces = (data.workspaces ?? []).map((workspace) => ({
      ...workspace,
      type: isWorkspaceType(workspace.type) ? workspace.type : DEFAULT_WORKSPACE_TYPE,
      agentPermissionMode: parseAgentPermissionMode(workspace.agentPermissionMode),
    }))
    const saved = data.activeWorkspaceId
    const settings = data.settings ? { ...DEFAULT_SETTINGS, ...data.settings } : { ...DEFAULT_SETTINGS }
    const lastSelectedBranchByProject = data.lastSelectedBranchByProject ?? {}
    const persistedDialog = data.newThreadDialog ?? {}
    const persistedMode = persistedDialog.mode === 'new' ? 'new' : 'existing'
    const activeWorkspaceId = settings.restoreWorkspace
      ? ((saved && workspaces.some((w) => w.id === saved) ? saved : workspaces[0]?.id) ?? null)
      : null
    // Tabs will be reconciled with live PTYs asynchronously after set
    const tabs = data.tabs ?? []
    const activeTabId = data.activeTabId ?? null
    set({
      projects,
      workspaces,
      tabs,
      activeWorkspaceId,
      activeTabId,
      lastActiveTabByWorkspace: data.lastActiveTabByWorkspace ?? {},
      lastSelectedBranchByProject,
      newThreadDialog: {
        open: false,
        projectId: persistedDialog.projectId ?? null,
        mode: persistedMode,
        branch: typeof persistedDialog.branch === 'string' ? persistedDialog.branch : '',
        baseBranch: typeof persistedDialog.baseBranch === 'string' ? persistedDialog.baseBranch : DEFAULT_FALLBACK_BRANCH,
      },
      settings,
    })
  },

  activeWorkspaceTabs: () => {
    const s = get()
    return s.tabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
  },

  activeProject: () => {
    const s = get()
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    return ws ? s.projects.find((p) => p.id === ws.projectId) : undefined
  },
}))

// ── State persistence ──

function getPersistedSlice(state: AppState): PersistedState {
  return {
    projects: state.projects,
    workspaces: state.workspaces,
    tabs: state.tabs,
    activeWorkspaceId: state.activeWorkspaceId,
    activeTabId: state.activeTabId,
    lastActiveTabByWorkspace: state.lastActiveTabByWorkspace,
    lastSelectedBranchByProject: state.lastSelectedBranchByProject,
    newThreadDialog: {
      ...state.newThreadDialog,
      open: false,
    },
    settings: state.settings,
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function debouncedSave(state: AppState) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    window.api.state.save(getPersistedSlice(state))
  }, 500)
}

// Subscribe to store changes and debounce-save persisted slice
useAppStore.subscribe((state, prevState) => {
  if (
    state.projects !== prevState.projects ||
    state.workspaces !== prevState.workspaces ||
    state.tabs !== prevState.tabs ||
    state.activeTabId !== prevState.activeTabId ||
    state.activeWorkspaceId !== prevState.activeWorkspaceId ||
    state.lastSelectedBranchByProject !== prevState.lastSelectedBranchByProject ||
    state.settings !== prevState.settings
  ) {
    debouncedSave(state)
  }
})

// Flush state to disk synchronously when the window is closing.
// Uses sendSync + writeFileSync so the write completes before the renderer is destroyed.
window.addEventListener('beforeunload', () => {
  if (saveTimer) clearTimeout(saveTimer)
  window.api.state.saveSync(getPersistedSlice(useAppStore.getState()))
})

// Load persisted state on startup
export async function hydrateFromDisk(): Promise<void> {
  try {
    const data = await window.api.state.load()
    if (data) {
      useAppStore.getState().hydrateState(data)
    }
  } catch (err) {
    console.error('Failed to load persisted state:', err)
  }

  // Drop any stale tabs whose workspace no longer exists
  {
    const store = useAppStore.getState()
    const wsIds = new Set(store.workspaces.map((w) => w.id))
    const validTabs = store.tabs.filter((t) => wsIds.has(t.workspaceId))
    if (validTabs.length !== store.tabs.length) {
      const activeTabId = validTabs.find((t) => t.id === store.activeTabId)
        ? store.activeTabId
        : (validTabs.find((t) => t.workspaceId === store.activeWorkspaceId)?.id ?? null)
      useAppStore.setState({ tabs: validTabs, activeTabId })
    }
  }

  // Check Codex auth status
  try {
    const authStatus = await window.api.chat.getAuthStatus()
    useAppStore.setState({ codexLoggedIn: authStatus.loggedIn })
  } catch {
    // ignore — auth check is best-effort
  }

  // Listen for chat events from Codex service in main process
  window.api.chat.onEvent((event) => {
    const store = useAppStore.getState()
    const { threadId, type, data } = event

    if (type === 'message.completed' && data && typeof data === 'object' && 'content' in data) {
      const msg = data as { id: string; role: 'assistant'; content: string }
      store.chatMessages[threadId] // check exists
      useAppStore.setState((s) => ({
        chatMessages: {
          ...s.chatMessages,
          [threadId]: [
            ...(s.chatMessages[threadId] ?? []),
            {
              id: msg.id ?? crypto.randomUUID(),
              role: 'assistant',
              content: msg.content,
              timestamp: Date.now(),
            },
          ],
        },
      }))
    }

    if (type === 'error' && data && typeof data === 'object' && 'message' in data) {
      store.addToast({
        id: crypto.randomUUID(),
        message: `Chat error: ${(data as { message: string }).message}`,
        type: 'error',
      })
    }
  })
}

