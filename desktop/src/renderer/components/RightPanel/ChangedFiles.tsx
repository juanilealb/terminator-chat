import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Button,
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

type CommitFlowAction = 'commit' | 'ship-main' | 'ship-main-close'

interface CommitFlowOption {
  id: CommitFlowAction
  label: string
  tooltip: string
}

const COMMIT_FLOW_OPTIONS: CommitFlowOption[] = [
  {
    id: 'commit',
    label: 'Commit',
    tooltip: 'Commit changes',
  },
  {
    id: 'ship-main',
    label: 'Ship to main',
    tooltip: 'Commit, push branch, and open a PR to main',
  },
  {
    id: 'ship-main-close',
    label: 'Ship to main and close workspace',
    tooltip: 'Commit, push branch, open a PR to main, and close workspace',
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

export function ChangedFiles({ worktreePath, workspaceId, isActive }: Props) {
  const [files, setFiles] = useState<FileStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [commitFlow, setCommitFlow] = useState<CommitFlowAction>('commit')
  const refreshSeqRef = useRef(0)
  const lastAutofilledCommitMsgRef = useRef<string>('')
  const {
    openDiffTab,
    addToast,
    deleteWorkspace,
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

      if (commitFlow === 'ship-main' || commitFlow === 'ship-main-close') {
        if (!project) {
          throw new Error('Project not found for this workspace')
        }
        const sourceBranch = await window.api.git.getCurrentBranch(worktreePath)
        if (!sourceBranch || sourceBranch === 'HEAD') {
          throw new Error('Cannot ship workspace from detached HEAD')
        }
        const closesWorkspace = commitFlow === 'ship-main-close'
        const result = await window.api.git.shipBranchToMain(project.repoPath, sourceBranch)

        if (result.prUrl) {
          const prMsg = result.prCreated
            ? `PR to ${result.mainBranch} created.`
            : `PR to ${result.mainBranch} already exists.`
          addToast({
            id: crypto.randomUUID(),
            message: closesWorkspace
              ? `Pushed ${sourceBranch}, and closed workspace. ${prMsg}`
              : `Pushed ${sourceBranch}. ${prMsg}`,
            type: 'info',
          })
          window.open(result.prUrl)
        } else {
          addToast({
            id: crypto.randomUUID(),
            message: closesWorkspace
              ? `Pushed ${sourceBranch} and closed workspace.`
              : `Pushed ${sourceBranch}.`,
            type: 'info',
          })
        }

        if (closesWorkspace) {
          await deleteWorkspace(workspaceId)
        }
        lastAutofilledCommitMsgRef.current = defaultCommitPrefix
        setCommitMsg(defaultCommitPrefix)
        return
      }

      addToast({
        id: crypto.randomUUID(),
        message: 'Commit created',
        type: 'info',
      })
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
    project,
    deleteWorkspace,
    workspaceId,
    addToast,
  ])

  const handleCommitFlowSelect = useCallback((flow: CommitFlowAction) => {
    setCommitFlow(flow)
  }, [])

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

  if (files.length === 0) {
    return (
      <div className={styles.emptyState}>
        <CheckmarkCircleRegular className={styles.emptyIcon} />
        <span className={styles.emptyText}>No changes</span>
      </div>
    )
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleCommitFlow()
    }
  }

  const canCommit = !busy && !!commitMsg.trim() && (staged.length > 0 || unstaged.length > 0)
  const commitFlowOption = COMMIT_FLOW_OPTIONS.find((option) => option.id === commitFlow) ?? COMMIT_FLOW_OPTIONS[0]

  return (
    <div className={styles.changedFilesList}>
      {/* Commit input */}
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
