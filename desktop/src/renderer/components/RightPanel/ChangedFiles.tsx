import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Textarea,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
} from '@fluentui/react-components'
import {
  AddRegular,
  SubtractRegular,
  ArrowUndoRegular,
  ChevronDownRegular,
  CheckmarkCircleRegular,
} from '@fluentui/react-icons'
import { basenameSafe, formatShortcut, toPosixPath } from '@shared/platform'
import { SHORTCUT_MAP } from '@shared/shortcuts'
import { useAppStore } from '../../store/app-store'
import { DEFAULT_WORKSPACE_TYPE, type WorkspaceType } from '../../store/types'
import { dispatchGitStatusChanged } from '../../utils/git-status-events'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './RightPanel.module.css'

interface FileStatus {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

interface Props {
  worktreePath: string
  workspaceId: string
  isActive?: boolean
}

const STATUS_LABELS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

type CommitFlowAction =
  | 'commit'
  | 'commit-push'
  | 'commit-pr'

interface CommitFlowOption {
  id: CommitFlowAction
  label: string
  tooltip: string
}

type BranchSwitchMode = 'existing' | 'new'

const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop'])

const COMMIT_FLOW_OPTIONS: CommitFlowOption[] = [
  {
    id: 'commit',
    label: 'Commit only',
    tooltip: 'Create commit only',
  },
  {
    id: 'commit-push',
    label: 'Commit and push',
    tooltip: 'Create commit and push current branch',
  },
  {
    id: 'commit-pr',
    label: 'Commit and update PR',
    tooltip: 'Create commit, push branch, and create/update the PR for this branch',
  },
]

const COMMIT_PREFIX_BY_TYPE: Record<WorkspaceType, string> = {
  bug: 'fix: ',
  feature: 'feat: ',
  chore: 'chore: ',
  refactor: 'refactor: ',
  docs: 'docs: ',
  test: 'test: ',
  spike: 'spike: ',
}

function commitPrefixForType(workspaceType?: WorkspaceType): string {
  return COMMIT_PREFIX_BY_TYPE[workspaceType ?? DEFAULT_WORKSPACE_TYPE]
}

function formatUserError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback
  const invokePrefix = /^Error invoking remote method '[^']+': Error:\s*/i
  return err.message.replace(invokePrefix, '') || fallback
}

function normalizeBranchName(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  return trimmed
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/origin\//, '')
    .replace(/^origin\//, '')
}

function sanitizeBranchInput(input: string): string {
  return normalizeBranchName(input)
    .replace(/\s+/g, '-')
    .replace(/[\x00-\x1f\x7f~^:?*[\]\\]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
}

function sameWorktreePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  return normalize(left) === normalize(right)
}

export function ChangedFiles({ worktreePath, workspaceId, isActive }: Props) {
  const [files, setFiles] = useState<FileStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [commitFlow, setCommitFlow] = useState<CommitFlowAction>('commit')
  const [allRepoBranches, setAllRepoBranches] = useState<string[]>([])
  const [availableBaseBranches, setAvailableBaseBranches] = useState<string[]>([])
  const [selectedBaseBranch, setSelectedBaseBranch] = useState('')
  const [defaultBaseBranch, setDefaultBaseBranch] = useState('main')
  const [branchSwitchOpen, setBranchSwitchOpen] = useState(false)
  const [branchSwitchMode, setBranchSwitchMode] = useState<BranchSwitchMode>('existing')
  const [branchSwitchTarget, setBranchSwitchTarget] = useState('')
  const [branchSwitchBase, setBranchSwitchBase] = useState('')
  const [switchingBranchContext, setSwitchingBranchContext] = useState(false)
  const refreshSeqRef = useRef(0)
  const lastAutofilledCommitMsgRef = useRef<string>('')
  const {
    openDiffTab,
    addToast,
    setNewThreadDialog,
    confirmNewThreadDialog,
    workspaces,
    projects,
  } = useAppStore()

  const workspace = workspaces.find((w) => w.id === workspaceId)
  const project = workspace ? projects.find((p) => p.id === workspace.projectId) : undefined
  const defaultCommitPrefix = commitPrefixForType(workspace?.type)

  useEffect(() => {
    setCommitMsg((prev) => {
      if (prev.trim().length === 0 || prev === lastAutofilledCommitMsgRef.current) {
        lastAutofilledCommitMsgRef.current = defaultCommitPrefix
        return defaultCommitPrefix
      }
      return prev
    })
  }, [defaultCommitPrefix, workspaceId])

  useEffect(() => {
    if (!project) {
      setAllRepoBranches([])
      setAvailableBaseBranches([])
      setSelectedBaseBranch('')
      setDefaultBaseBranch('main')
      return
    }

    let cancelled = false
    void Promise.all([
      window.api.git.getBranches(project.repoPath).catch(() => [] as string[]),
      window.api.git.getDefaultBranch(project.repoPath).catch(() => 'main'),
      window.api.git.getCurrentBranch(worktreePath).catch(() => ''),
    ]).then(([branches, defaultBranchRaw, currentBranchRaw]) => {
      if (cancelled) return
      const currentBranch = normalizeBranchName(currentBranchRaw)
      const normalizedDefault = normalizeBranchName(defaultBranchRaw) || 'main'
      const normalizedBranches = Array.from(
        new Set(
          branches
            .map((entry) => normalizeBranchName(entry))
            .filter((entry) => !!entry),
        ),
      )
      normalizedBranches.sort((a, b) => a.localeCompare(b))
      const uniqueBranches = Array.from(
        new Set(
          normalizedBranches
            .filter((entry) => entry !== currentBranch),
        ),
      )
      uniqueBranches.sort((a, b) => a.localeCompare(b))
      if (normalizedDefault && !uniqueBranches.includes(normalizedDefault)) {
        uniqueBranches.unshift(normalizedDefault)
      }

      setAllRepoBranches(normalizedBranches)
      setDefaultBaseBranch(normalizedDefault)
      setAvailableBaseBranches(uniqueBranches)
      setSelectedBaseBranch((prev) => {
        if (prev && uniqueBranches.includes(prev)) return prev
        return normalizedDefault || uniqueBranches[0] || ''
      })
    })

    return () => {
      cancelled = true
    }
  }, [project, worktreePath])

  const lastRefreshRef = useRef(0)

  const refresh = useCallback(async (showLoading = false) => {
    // Throttle: skip silent refreshes that arrive too fast
    const now = Date.now()
    if (!showLoading && now - lastRefreshRef.current < 1000) return

    const seq = ++refreshSeqRef.current
    if (showLoading) setLoading(true)

    try {
      const statuses = await window.api.git.getStatus(worktreePath)
      if (seq !== refreshSeqRef.current) return
      lastRefreshRef.current = Date.now()
      setFiles(statuses)
      dispatchGitStatusChanged(worktreePath, statuses.length)
    } catch {
      if (seq !== refreshSeqRef.current) return
      // Only clear files on explicit loading refresh; silent refreshes keep previous state
      if (showLoading) {
        setFiles([])
        dispatchGitStatusChanged(worktreePath, 0)
      }
    } finally {
      // Always clear loading if this is the latest request, regardless of showLoading.
      // This prevents loading getting stuck when a silent refresh overtakes an initial load.
      if (seq === refreshSeqRef.current) {
        setLoading(false)
      }
    }
  }, [worktreePath])

  useEffect(() => {
    void refresh(true)
  }, [refresh])

  useEffect(() => {
    window.api.fs.watchDir(worktreePath)
    const cleanup = window.api.fs.onDirChanged((changedPath) => {
      if (changedPath === worktreePath) {
        void refresh()
      }
    })
    return () => {
      cleanup()
      window.api.fs.unwatchDir(worktreePath)
    }
  }, [worktreePath, refresh])

  useEffect(() => {
    if (isActive) {
      void refresh()
    }
  }, [isActive, refresh])

  const staged = files.filter((f) => f.staged)
  const unstaged = files.filter((f) => !f.staged)
  const hasChanges = files.length > 0

  const runGitOp = useCallback(async (op: () => Promise<void>) => {
    setBusy(true)
    try {
      await op()
    } catch (err) {
      const msg = formatUserError(err, 'Git operation failed')
      addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
    } finally {
      // Reset throttle so user-initiated ops always get fresh status
      lastRefreshRef.current = 0
      await refresh()
      setBusy(false)
    }
  }, [refresh, addToast])

  const stageFiles = useCallback((paths: string[]) => {
    runGitOp(() => window.api.git.stage(worktreePath, paths))
  }, [worktreePath, runGitOp])

  const unstageFiles = useCallback((paths: string[]) => {
    runGitOp(() => window.api.git.unstage(worktreePath, paths))
  }, [worktreePath, runGitOp])

  const discardFiles = useCallback((file: FileStatus) => {
    if (file.status === 'untracked') {
      runGitOp(() => window.api.git.discard(worktreePath, [], [file.path]))
    } else {
      runGitOp(() => window.api.git.discard(worktreePath, [file.path], []))
    }
  }, [worktreePath, runGitOp])

  const resolveSelectedPrBaseBranch = useCallback(() => {
    const base = normalizeBranchName(selectedBaseBranch || '')
    return base || undefined
  }, [selectedBaseBranch])

  const handleCommitFlow = useCallback(() => {
    const message = commitMsg.trim()
    if (!message) return

    const shouldStageAllFirst = staged.length === 0 && unstaged.length > 0
    if (staged.length === 0 && !shouldStageAllFirst) return

    void runGitOp(async () => {
      if (shouldStageAllFirst) {
        await window.api.git.stage(worktreePath, unstaged.map((f) => f.path))
      }
      await window.api.git.commit(worktreePath, message)

      if (commitFlow === 'commit') {
        addToast({
          id: crypto.randomUUID(),
          message: 'Commit created',
          type: 'info',
        })
        lastAutofilledCommitMsgRef.current = defaultCommitPrefix
        setCommitMsg(defaultCommitPrefix)
        return
      }

      if (commitFlow === 'commit-push') {
        const pushed = await window.api.git.pushCurrentBranch(worktreePath)
        addToast({
          id: crypto.randomUUID(),
          message: `Committed and pushed ${pushed.branch}.`,
          type: 'info',
        })
        lastAutofilledCommitMsgRef.current = defaultCommitPrefix
        setCommitMsg(defaultCommitPrefix)
        return
      }

      if (commitFlow === 'commit-pr') {
        const pushed = await window.api.git.pushCurrentBranch(worktreePath)
        const baseBranch = resolveSelectedPrBaseBranch()
        const pr = await window.api.git.openOrCreatePr(worktreePath, baseBranch)
        addToast({
          id: crypto.randomUUID(),
          message: pr.created
            ? `Committed, pushed ${pushed.branch}, and created PR${baseBranch ? ` to ${baseBranch}` : ''}.`
            : `Committed, pushed ${pushed.branch}, and updated existing PR${baseBranch ? ` to ${baseBranch}` : ''}.`,
          type: 'info',
        })
        window.open(pr.url)
        lastAutofilledCommitMsgRef.current = defaultCommitPrefix
        setCommitMsg(defaultCommitPrefix)
        return
      }

      addToast({ id: crypto.randomUUID(), message: 'Commit created', type: 'info' })
      lastAutofilledCommitMsgRef.current = defaultCommitPrefix
      setCommitMsg(defaultCommitPrefix)
    })
  }, [
    commitMsg,
    staged.length,
    unstaged,
    runGitOp,
    worktreePath,
    commitFlow,
    defaultCommitPrefix,
    resolveSelectedPrBaseBranch,
    addToast,
  ])

  const handlePushBranch = useCallback(() => {
    void runGitOp(async () => {
      const pushed = await window.api.git.pushCurrentBranch(worktreePath)
      addToast({
        id: crypto.randomUUID(),
        message: `Pushed ${pushed.branch}.`,
        type: 'info',
      })
    })
  }, [worktreePath, runGitOp, addToast])

  const handleSyncBranch = useCallback(() => {
    void runGitOp(async () => {
      const pulled = await window.api.git.pullCurrentBranch(worktreePath)
      addToast({
        id: crypto.randomUUID(),
        message: `Synced ${pulled.branch}.`,
        type: 'info',
      })
      window.dispatchEvent(new Event('terminator:pr-poll-hint'))
    })
  }, [worktreePath, runGitOp, addToast])

  const handleOpenOrCreatePr = useCallback((pushFirst: boolean) => {
    void runGitOp(async () => {
      let pushedBranch: string | null = null
      if (pushFirst) {
        const pushed = await window.api.git.pushCurrentBranch(worktreePath)
        pushedBranch = pushed.branch
      }

      const baseBranch = resolveSelectedPrBaseBranch()
      const pr = await window.api.git.openOrCreatePr(worktreePath, baseBranch)
      addToast({
        id: crypto.randomUUID(),
        message: pushFirst
          ? pr.created
            ? `Pushed ${pushedBranch ?? pr.branch} and created PR${baseBranch ? ` to ${baseBranch}` : ''}.`
            : `Pushed ${pushedBranch ?? pr.branch} and updated existing PR${baseBranch ? ` to ${baseBranch}` : ''}.`
          : pr.created
            ? `Created PR${baseBranch ? ` to ${baseBranch}` : ''}.`
            : `Updated existing PR${baseBranch ? ` to ${baseBranch}` : ''}.`,
        type: 'info',
      })
      window.open(pr.url)
    })
  }, [worktreePath, runGitOp, addToast, resolveSelectedPrBaseBranch])

  const handleCommitFlowSelect = useCallback((flow: CommitFlowAction) => {
    setCommitFlow(flow)
  }, [])

  const handleOpenBranchSwitch = useCallback(() => {
    const currentBranch = normalizeBranchName(workspace?.branch ?? '')
    const defaultMode: BranchSwitchMode = PROTECTED_BRANCHES.has(currentBranch) ? 'new' : 'existing'
    setBranchSwitchMode(defaultMode)
    setBranchSwitchTarget(defaultMode === 'existing' ? (availableBaseBranches[0] ?? '') : '')
    setBranchSwitchBase(currentBranch || defaultBaseBranch || 'main')
    setBranchSwitchOpen(true)
  }, [workspace?.branch, availableBaseBranches, defaultBaseBranch])

  const handleSwitchBranchContext = useCallback(async () => {
    if (!project) {
      addToast({ id: crypto.randomUUID(), message: 'Project not found for this workspace', type: 'error' })
      return
    }

    const currentBranch = normalizeBranchName(workspace?.branch ?? '')
    const targetBranch = normalizeBranchName(branchSwitchTarget)
    if (!targetBranch) {
      addToast({ id: crypto.randomUUID(), message: 'Branch is required', type: 'error' })
      return
    }
    if (targetBranch === currentBranch) {
      setBranchSwitchOpen(false)
      return
    }

    const resolvedBaseBranch = normalizeBranchName(branchSwitchBase || currentBranch || defaultBaseBranch) || 'main'
    const sourceWorktreePath = worktreePath

    setSwitchingBranchContext(true)
    try {
      const sourceStatuses = await window.api.git.getStatus(sourceWorktreePath).catch(() => [] as FileStatus[])
      const sourceHadLocalChanges = sourceStatuses.length > 0

      setNewThreadDialog({
        open: false,
        projectId: project.id,
        mode: branchSwitchMode,
        branch: targetBranch,
        baseBranch: resolvedBaseBranch,
      })
      await confirmNewThreadDialog()

      const latest = useAppStore.getState()
      const activeWorkspace = latest.workspaces.find((entry) => entry.id === latest.activeWorkspaceId)
      if (activeWorkspace && normalizeBranchName(activeWorkspace.branch) === targetBranch) {
        let movedChanges = false
        if (sourceHadLocalChanges && !sameWorktreePath(sourceWorktreePath, activeWorkspace.worktreePath)) {
          const moved = await window.api.git.moveLocalChanges(sourceWorktreePath, activeWorkspace.worktreePath)
          movedChanges = moved.moved
        }

        addToast({
          id: crypto.randomUUID(),
          message: movedChanges
            ? `Switched context to ${targetBranch} and moved local changes.`
            : `Switched context to ${targetBranch}.`,
          type: 'info',
        })
        setBranchSwitchOpen(false)
      }
    } catch (err) {
      addToast({
        id: crypto.randomUUID(),
        message: formatUserError(err, 'Failed to switch branch context'),
        type: 'error',
      })
    } finally {
      setSwitchingBranchContext(false)
    }
  }, [
    project,
    workspace?.branch,
    branchSwitchTarget,
    branchSwitchBase,
    defaultBaseBranch,
    branchSwitchMode,
    worktreePath,
    setNewThreadDialog,
    confirmNewThreadDialog,
    addToast,
  ])

  const openDiff = useCallback((path: string) => {
    openDiffTab(workspaceId)
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('diff:scrollToFile', { detail: path }))
    })
  }, [openDiffTab, workspaceId])

  if (loading) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyText}>Checking changes...</span>
      </div>
    )
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleCommitFlow()
    }
  }

  const commitFlowOption = COMMIT_FLOW_OPTIONS.find((option) => option.id === commitFlow) ?? COMMIT_FLOW_OPTIONS[0]
  const selectedPrBaseLabel = resolveSelectedPrBaseBranch() ?? 'repository default'
  const canCommit =
    !busy &&
    !!commitMsg.trim() &&
    (staged.length > 0 || unstaged.length > 0)
  const branchDisplayName = normalizeBranchName(workspace?.branch ?? '') || 'detached'
  const isProtectedBranch = PROTECTED_BRANCHES.has(branchDisplayName)
  const branchSwitchListId = `branch-switch-list-${workspaceId}`
  const branchSwitchBusy = busy || switchingBranchContext
  const canSubmitBranchSwitch = branchSwitchTarget.trim().length > 0 && (
    branchSwitchMode === 'existing' || !!normalizeBranchName(branchSwitchBase)
  )

  return (
    <div className={styles.changedFilesList}>
      <div className={styles.branchActionsCard}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>Branch actions</span>
          <span className={styles.branchBadge}>{branchDisplayName}</span>
        </div>
        <div className={styles.flowDetailRow}>
          <span className={styles.flowDetailLabel}>PR base</span>
          <select
            className={styles.flowSelect}
            value={selectedBaseBranch}
            onChange={(event) => setSelectedBaseBranch(normalizeBranchName(event.target.value))}
            disabled={busy}
          >
            <option value="">Repository default</option>
            {availableBaseBranches.map((branch) => (
              <option key={branch} value={branch}>
                {branch}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.branchActionsRow}>
          <Button
            appearance="secondary"
            size="small"
            disabled={busy}
            onClick={handlePushBranch}
            title={`Push current branch (${branchDisplayName}) to origin`}
          >
            Push branch
          </Button>
          <Button
            appearance="secondary"
            size="small"
            disabled={busy}
            onClick={handleSyncBranch}
            title={`Fast-forward pull ${branchDisplayName} from origin`}
          >
            Sync branch
          </Button>
          <Button
            appearance="secondary"
            size="small"
            disabled={busy}
            onClick={() => handleOpenOrCreatePr(false)}
            title={`Open or update PR from ${branchDisplayName} to ${selectedPrBaseLabel}`}
          >
            Open or update PR
          </Button>
          <Button
            appearance="primary"
            size="small"
            disabled={busy}
            onClick={() => handleOpenOrCreatePr(true)}
            title={`Push ${branchDisplayName} and open or update PR to ${selectedPrBaseLabel}`}
          >
            Push + update PR
          </Button>
          <Button
            appearance="outline"
            size="small"
            disabled={branchSwitchBusy}
            onClick={handleOpenBranchSwitch}
            title="Switch to another branch context (creates/reuses workspace)"
          >
            {isProtectedBranch ? 'Move off protected branch' : 'Move to another branch'}
          </Button>
        </div>
        {isProtectedBranch && (
          <div className={styles.branchProtectionHint}>
            This thread is on <span className={styles.branchActionsHintValue}>{branchDisplayName}</span>. Use a feature branch before opening a PR to <span className={styles.branchActionsHintValue}>{branchDisplayName}</span>.
          </div>
        )}
        <div className={styles.branchActionsHint}>
          Source branch <span className={styles.branchActionsHintValue}>{branchDisplayName}</span> to base{' '}
          <span className={styles.branchActionsHintValue}>{selectedPrBaseLabel}</span>
        </div>
      </div>

      <Dialog
        open={branchSwitchOpen}
        onOpenChange={(_, data) => {
          if (!data.open && !switchingBranchContext) setBranchSwitchOpen(false)
        }}
      >
        <DialogSurface className={styles.branchSwitchSurface}>
          <DialogBody>
            <DialogTitle>Move branch context</DialogTitle>
            <DialogContent className={styles.branchSwitchContent}>
              <div className={styles.branchSwitchModeToggle}>
                <button
                  type="button"
                  className={`${styles.branchSwitchModeButton} ${branchSwitchMode === 'existing' ? styles.branchSwitchModeButtonActive : ''}`}
                  onClick={() => setBranchSwitchMode('existing')}
                  disabled={branchSwitchBusy}
                >
                  Use existing branch
                </button>
                <button
                  type="button"
                  className={`${styles.branchSwitchModeButton} ${branchSwitchMode === 'new' ? styles.branchSwitchModeButtonActive : ''}`}
                  onClick={() => setBranchSwitchMode('new')}
                  disabled={branchSwitchBusy}
                >
                  Create new branch
                </button>
              </div>

              <label className={styles.branchSwitchLabel}>Branch</label>
              <input
                className={styles.branchSwitchInput}
                value={branchSwitchTarget}
                onChange={(event) => setBranchSwitchTarget(sanitizeBranchInput(event.target.value))}
                placeholder={branchSwitchMode === 'new' ? 'feature/my-change' : 'develop'}
                list={branchSwitchListId}
                disabled={branchSwitchBusy}
              />
              <datalist id={branchSwitchListId}>
                {allRepoBranches.map((branch) => (
                  <option key={branch} value={branch} />
                ))}
              </datalist>

              {branchSwitchMode === 'new' && (
                <>
                  <label className={styles.branchSwitchLabel}>Base branch</label>
                  <input
                    className={styles.branchSwitchInput}
                    value={branchSwitchBase}
                    onChange={(event) => setBranchSwitchBase(sanitizeBranchInput(event.target.value))}
                    placeholder="develop"
                    list={branchSwitchListId}
                    disabled={branchSwitchBusy}
                  />
                </>
              )}

              <div className={styles.branchSwitchHint}>
                {branchSwitchMode === 'new'
                  ? 'Creates an isolated worktree from the selected base branch, moves this thread there, and carries local tracked/untracked changes.'
                  : 'Reuses or creates a worktree for the selected branch, moves this thread there, and carries local tracked/untracked changes.'}
              </div>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => setBranchSwitchOpen(false)}
                disabled={branchSwitchBusy}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={() => { void handleSwitchBranchContext() }}
                disabled={!canSubmitBranchSwitch || branchSwitchBusy}
              >
                {switchingBranchContext
                  ? 'Switching...'
                  : branchSwitchMode === 'new'
                    ? 'Create and switch'
                    : 'Switch branch'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Commit input */}
      {hasChanges && (
        <div className={styles.commitArea}>
          <Textarea
            className={styles.commitInput}
            placeholder="Commit message"
            value={commitMsg}
            onChange={(_e, data) => setCommitMsg(data.value)}
            onKeyDown={handleKeyDown}
            resize="vertical"
            size="small"
            appearance="outline"
          />
          <div className={styles.commitActions}>
            <Tooltip
              label={commitFlowOption.tooltip}
              shortcut={formatShortcut(
                SHORTCUT_MAP.commitStagedChanges.mac,
                SHORTCUT_MAP.commitStagedChanges.win
              )}
            >
              <Button
                className={styles.commitButton}
                disabled={!canCommit}
                onClick={handleCommitFlow}
                size="small"
              >
                {commitFlowOption.label}
              </Button>
            </Tooltip>
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button
                  className={styles.commitMenuToggle}
                  aria-label="Commit flow options"
                  disabled={busy}
                  size="small"
                  icon={<ChevronDownRegular />}
                />
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  {COMMIT_FLOW_OPTIONS.map((option) => (
                    <MenuItem
                      key={option.id}
                      onClick={() => handleCommitFlowSelect(option.id)}
                    >
                      {option.label}
                    </MenuItem>
                  ))}
                </MenuList>
              </MenuPopover>
            </Menu>
          </div>
        </div>
      )}

      {!hasChanges && (
        <div className={styles.noChangesBanner}>
          <CheckmarkCircleRegular className={styles.emptyIcon} />
          <span className={styles.emptyText}>No local changes</span>
        </div>
      )}

      {hasChanges && (
        <>
          {/* Staged section */}
          {staged.length > 0 && (
            <div className={styles.changeSection}>
              <div className={styles.sectionHeader}>
                <span className={styles.sectionLabel}>Staged Changes</span>
                <span className={styles.sectionCount}>{staged.length}</span>
                <span className={styles.sectionActions}>
                  <Tooltip label="Unstage All">
                    <Button
                      aria-label="Unstage all files"
                      appearance="subtle"
                      size="small"
                      disabled={busy}
                      onClick={() => unstageFiles(staged.map((f) => f.path))}
                      icon={<SubtractRegular />}
                    />
                  </Tooltip>
                </span>
              </div>
              {staged.map((file) => (
                <FileRow
                  key={`staged-${file.path}`}
                  file={file}
                  busy={busy}
                  onAction={() => unstageFiles([file.path])}
                  actionIcon={<SubtractRegular />}
                  actionTitle="Unstage"
                  onOpenDiff={openDiff}
                />
              ))}
            </div>
          )}

          {/* Unstaged section */}
          {unstaged.length > 0 && (
            <div className={styles.changeSection}>
              <div className={styles.sectionHeader}>
                <span className={styles.sectionLabel}>Changes</span>
                <span className={styles.sectionCount}>{unstaged.length}</span>
                <span className={styles.sectionActions}>
                  <Tooltip label="Discard All">
                    <Button
                      aria-label="Discard all unstaged changes"
                      appearance="subtle"
                      size="small"
                      disabled={busy}
                      onClick={() => {
                        const tracked = unstaged.filter((f) => f.status !== 'untracked').map((f) => f.path)
                        const untracked = unstaged.filter((f) => f.status === 'untracked').map((f) => f.path)
                        runGitOp(() => window.api.git.discard(worktreePath, tracked, untracked))
                      }}
                      icon={<ArrowUndoRegular />}
                    />
                  </Tooltip>
                  <Tooltip label="Stage All">
                    <Button
                      aria-label="Stage all files"
                      appearance="subtle"
                      size="small"
                      disabled={busy}
                      onClick={() => stageFiles(unstaged.map((f) => f.path))}
                      icon={<AddRegular />}
                    />
                  </Tooltip>
                </span>
              </div>
              {unstaged.map((file) => (
                <FileRow
                  key={`unstaged-${file.path}`}
                  file={file}
                  busy={busy}
                  onAction={() => stageFiles([file.path])}
                  actionIcon={<AddRegular />}
                  actionTitle="Stage"
                  onDiscard={() => discardFiles(file)}
                  onOpenDiff={openDiff}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function FileRow({
  file,
  busy,
  onAction,
  actionIcon,
  actionTitle,
  onDiscard,
  onOpenDiff,
}: {
  file: FileStatus
  busy: boolean
  onAction: () => void
  actionIcon: React.ReactNode
  actionTitle: string
  onDiscard?: () => void
  onOpenDiff: (path: string) => void
}) {
  const displayPath = toPosixPath(file.path)
  const fileName = basenameSafe(displayPath)
  const dir = displayPath.slice(0, Math.max(0, displayPath.length - fileName.length))

  return (
    <div className={styles.changedFile}>
      <span className={`${styles.statusBadge} ${styles[file.status]}`}>
        {STATUS_LABELS[file.status]}
      </span>
      <span
        className={styles.changePath}
        onClick={() => onOpenDiff(toPosixPath(file.path))}
      >
        {dir && <span className={styles.changeDir}>{dir}</span>}
        {fileName}
      </span>
      <span className={styles.fileActions}>
        {onDiscard && (
          <Tooltip label="Discard Changes">
            <Button
              aria-label={`Discard changes in ${displayPath}`}
              appearance="subtle"
              size="small"
              disabled={busy}
              onClick={onDiscard}
              icon={<ArrowUndoRegular />}
            />
          </Tooltip>
        )}
        <Tooltip label={actionTitle}>
          <Button
            aria-label={`${actionTitle} ${displayPath}`}
            appearance="subtle"
            size="small"
            disabled={busy}
            onClick={onAction}
            icon={actionIcon}
          />
        </Tooltip>
      </span>
    </div>
  )
}
