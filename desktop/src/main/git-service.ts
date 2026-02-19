import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { copyFile, mkdir, readdir, rm, writeFile } from 'fs/promises'
import { promisify } from 'util'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import type { CreateWorktreeProgress } from '../shared/workspace-creation'

const execFileAsync = promisify(execFile)

type CreateWorktreeProgressReporter = (progress: CreateWorktreeProgress) => void

export interface WorktreeInfo {
  path: string
  branch: string
  head: string
  isBare: boolean
}

export interface FileStatus {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

export interface FileDiff {
  path: string
  hunks: string // raw unified diff text
}

export interface WorkspaceSnapshot {
  ref: string
  label: string
  createdAt: number
}

export interface PushBranchResult {
  branch: string
}

export type BranchSyncState =
  | 'up-to-date'
  | 'ahead'
  | 'behind'
  | 'diverged'
  | 'no-upstream'
  | 'detached'
  | 'unknown'

export interface BranchSyncStatus {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  state: BranchSyncState
}

export interface PullRequestResult {
  url: string
  created: boolean
  branch: string
}

export interface ShipToMainResult {
  mainBranch: string
  prUrl: string | null
  prCreated: boolean
}

const SNAPSHOT_PREFIX = '[terminator-chat:snapshot]'
const WINDOWS_RESERVED_BASENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export interface PrWorktreeResult {
  worktreePath: string
  branch: string
}

export interface CreateProjectRepoOptions {
  parentDir: string
  projectName: string
  ownership: 'personal' | 'work'
  createRemote?: boolean
  visibility?: 'public' | 'private'
  githubOwner?: string
}

export interface CreateProjectRepoResult {
  repoPath: string
  remoteUrl?: string
  branch: string
}

interface CommitAuthorIdentity {
  name: string
  email: string
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout.trimEnd()
}

async function gh(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout.trim()
}

async function gitConfigGet(cwd: string, key: string, scope: '--local' | '--global'): Promise<string> {
  try {
    const value = await git(['config', scope, '--get', key], cwd)
    return value.trim()
  } catch {
    return ''
  }
}

function fallbackAuthorIdentity(ownership: 'personal' | 'work'): CommitAuthorIdentity {
  if (ownership === 'work') {
    return {
      name: 'jleal-quintana',
      email: 'jleal@quintanaep.com',
    }
  }
  return {
    name: 'juanilealb',
    email: '126987726+juanilealb@users.noreply.github.com',
  }
}

async function resolveCommitAuthorIdentity(
  cwd: string,
  ownership: 'personal' | 'work',
): Promise<CommitAuthorIdentity> {
  const localName = await gitConfigGet(cwd, 'user.name', '--local')
  const localEmail = await gitConfigGet(cwd, 'user.email', '--local')
  if (localName && localEmail) {
    return { name: localName, email: localEmail }
  }

  const globalName = await gitConfigGet(cwd, 'user.name', '--global')
  const globalEmail = await gitConfigGet(cwd, 'user.email', '--global')
  if (globalName && globalEmail) {
    return { name: globalName, email: globalEmail }
  }

  return fallbackAuthorIdentity(ownership)
}

/** Extract a user-friendly message from a git exec error */
function friendlyGitError(err: unknown, fallback: string): string {
  const stderr = (err as any)?.stderr as string | undefined
  if (!stderr) return fallback

  // "fatal: 'branch' is already used by worktree at '/path'"
  const alreadyUsed = stderr.match(/fatal: '([^']+)' is already (?:checked out|used by worktree) at '([^']+)'/)
  if (alreadyUsed) return 'BRANCH_CHECKED_OUT'

  // "fatal: invalid reference: branch-name"
  if (stderr.includes('invalid reference')) {
    const ref = stderr.match(/invalid reference: (.+)/)?.[1]?.trim()
    return ref ? `Branch "${ref}" not found` : 'Branch not found'
  }

  // "fatal: a branch named 'X' already exists"
  if (stderr.includes('a branch named')) return 'BRANCH_ALREADY_EXISTS'

  // "fatal: '/path' already exists"
  if (stderr.includes('already exists')) return 'WORKTREE_PATH_EXISTS'

  // "fatal: not a git repository"
  if (stderr.includes('not a git repository')) return 'Not a git repository'

  // Generic: grab the fatal line
  const fatal = stderr.match(/fatal: (.+)/)?.[1]?.trim()
  if (fatal) return fatal

  return fallback
}

function friendlyGhError(err: unknown, fallback: string): string {
  const code = (err as { code?: string })?.code
  if (code === 'ENOENT') return 'GitHub CLI is not installed'

  const stderr = ((err as { stderr?: string })?.stderr ?? '').trim()
  if (!stderr) return fallback

  const lower = stderr.toLowerCase()
  if (lower.includes('not logged into any github hosts')) {
    return 'GitHub CLI is not authenticated. Run "gh auth login".'
  }
  if (lower.includes('authentication failed')) {
    return 'GitHub CLI authentication failed. Run "gh auth login".'
  }
  if (lower.includes('failed to log in')) {
    return 'GitHub CLI authentication failed. Run "gh auth login".'
  }
  if (lower.includes('token in') && lower.includes('is invalid')) {
    return 'GitHub CLI token is invalid. Run "gh auth login".'
  }
  if (lower.includes('none of the git remotes configured for this repository point to a known github host')) {
    return 'GitHub remote host is not recognized by gh. Use a GitHub remote or pass --repo explicitly.'
  }
  if (lower.includes('could not resolve to a repository')) {
    return 'Repository is not available in GitHub CLI'
  }
  if (lower.includes('no commits between')) {
    return 'No changes to open a pull request'
  }

  return stderr.split('\n').find((line) => line.trim())?.trim() ?? fallback
}

function normalizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/origin\//, '')
    .replace(/^origin\//, '')
}

function isAlreadyMissingWorktreeError(err: unknown): boolean {
  const stderr = ((err as any)?.stderr as string | undefined)?.toLowerCase() ?? ''
  if (!stderr) return false
  return (
    stderr.includes('is not a working tree') ||
    stderr.includes('is not a worktree') ||
    stderr.includes('does not exist') ||
    stderr.includes('no such file or directory')
  )
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a)
  const right = resolve(b)
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase()
  }
  return left === right
}

interface GithubRepoRef {
  owner: string
  repo: string
}

function parseGithubRemote(url: string): GithubRepoRef | null {
  const trimmed = url.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (parsed.hostname.toLowerCase() !== 'github.com') return null
    const path = parsed.pathname.replace(/^\/+/, '').replace(/\.git$/i, '')
    const [owner, repo] = path.split('/')
    if (!owner || !repo) return null
    return { owner, repo }
  } catch {
    // fall through to SSH parsing
  }

  const sshMatch = trimmed.match(/^[^@]+@github(?:-[^:]+)?:([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/i)
  if (sshMatch) {
    const owner = sshMatch[1]
    const repo = sshMatch[2]
    if (!owner || !repo) return null
    return { owner, repo }
  }

  const plainMatch = trimmed.match(/^github\.com[:/]([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/i)
  if (plainMatch) {
    const owner = plainMatch[1]
    const repo = plainMatch[2]
    if (!owner || !repo) return null
    return { owner, repo }
  }

  return null
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next'])

async function copyEnvFiles(dir: string, destRoot: string, srcRoot: string): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        await copyEnvFiles(join(dir, entry.name), destRoot, srcRoot)
      } else if (entry.isFile() && entry.name.startsWith('.env')) {
        const rel = join(dir, entry.name).slice(srcRoot.length + 1)
        const dest = join(destRoot, rel)
        if (!existsSync(dest)) {
          await mkdir(dirname(dest), { recursive: true }).catch(() => {})
          await copyFile(join(dir, entry.name), dest).catch(() => {})
        }
      }
    }
  } catch {}
}

function reportCreateWorktreeProgress(
  onProgress: CreateWorktreeProgressReporter | undefined,
  progress: CreateWorktreeProgress
): void {
  onProgress?.(progress)
}

function sanitizeWorktreeName(name: string): string {
  const safe = name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
  return safe || 'worktree'
}

function buildWorktreeBaseDirName(repoName: string, worktreeName: string): string {
  const safeWorktreeName = sanitizeWorktreeName(worktreeName)
  return `${repoName}-ws-${safeWorktreeName}`
}

function resolveUniqueWorktreePath(parentDir: string, baseDirName: string): string {
  let attempt = 0
  while (true) {
    const suffix = attempt === 0 ? '' : `-${attempt}`
    const candidatePath = resolve(parentDir, `${baseDirName}${suffix}`)
    if (!existsSync(candidatePath)) {
      return candidatePath
    }
    attempt += 1
  }
}

function sanitizeGithubRepoName(name: string): string {
  const safe = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
  return safe || 'project'
}

function sanitizeLocalFolderName(name: string): string {
  const safe = name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-\s]+/, '')
    .replace(/[.\-\s]+$/, '')
  return safe || 'project'
}

function normalizeStatusPathForChecks(path: string): string {
  let normalized = path.trim().replace(/\\/g, '/')
  if (normalized.includes(' -> ')) {
    const renamedParts = normalized.split(' -> ')
    normalized = renamedParts[renamedParts.length - 1] ?? normalized
  }
  if (
    (normalized.startsWith('"') && normalized.endsWith('"'))
    || (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1)
  }
  return normalized
}

function isWindowsReservedPath(path: string): boolean {
  if (process.platform !== 'win32') return false
  const normalized = normalizeStatusPathForChecks(path)
  const baseName = basename(normalized).replace(/[. ]+$/g, '')
  if (!baseName) return false
  return WINDOWS_RESERVED_BASENAME_RE.test(baseName)
}

function ensureWithinParent(parentDir: string, candidatePath: string): void {
  const parent = resolve(parentDir)
  const candidate = resolve(candidatePath)
  const relPath = relative(parent, candidate)
  const withinParent = relPath === '' || (!relPath.startsWith('..') && !isAbsolute(relPath))
  if (!withinParent) {
    throw new Error('Invalid worktree path')
  }
}

export class GitService {
  static async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const output = await git(['worktree', 'list', '--porcelain'], repoPath)
    if (!output) return []

    const worktrees: WorktreeInfo[] = []
    const blocks = output.split('\n\n')

    for (const block of blocks) {
      const lines = block.split('\n')
      const info: Partial<WorktreeInfo> = { isBare: false }
      for (const line of lines) {
        if (line.startsWith('worktree ')) info.path = line.slice(9)
        else if (line.startsWith('HEAD ')) info.head = line.slice(5)
        else if (line.startsWith('branch ')) info.branch = line.slice(7).replace('refs/heads/', '')
        else if (line === 'bare') info.isBare = true
      }
      if (info.path) {
        worktrees.push(info as WorktreeInfo)
      }
    }
    return worktrees
  }

  /** Sanitize a string into a valid git branch name */
  static sanitizeBranchName(name: string): string {
    return name
      .trim()
      .replace(/\s+/g, '-')       // spaces → dashes
      .replace(/\.{2,}/g, '-')    // consecutive dots (..)
      .replace(/[\x00-\x1f\x7f~^:?*[\]\\]/g, '-') // control chars & git-illegal chars
      .replace(/\/{2,}/g, '/')    // collapse consecutive slashes
      .replace(/\/\./g, '/-')     // no component starting with dot
      .replace(/@\{/g, '-')       // no @{
      .replace(/\.lock(\/|$)/g, '-lock$1') // no .lock component
      .replace(/^[.\-/]+/, '')    // no leading dot, dash, or slash
      .replace(/[.\-/]+$/, '')    // no trailing dot, dash, or slash
  }

  static async getDefaultBranch(repoPath: string): Promise<string> {
    const hasOrigin = await GitService.hasRemote(repoPath, 'origin')
    if (hasOrigin) {
      // Best effort sync of origin/HEAD. Network hiccups should not block worktree creation.
      await git(['remote', 'set-head', 'origin', '--auto'], repoPath).catch(() => {})

      const ref = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoPath).catch(() => '')
      // "refs/remotes/origin/main" -> "origin/main"
      if (ref) return ref.replace('refs/remotes/', '')

      // Fallback for repos where origin/HEAD is unset.
      for (const candidate of ['origin/main', 'origin/master']) {
        const exists = await git(['rev-parse', '--verify', `refs/remotes/${candidate}`], repoPath)
          .then(() => true, () => false)
        if (exists) return candidate
      }
    }

    const local = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath).catch(() => '')
    if (local && local !== 'HEAD') return local

    for (const candidate of ['main', 'master']) {
      const exists = await git(['rev-parse', '--verify', `refs/heads/${candidate}`], repoPath)
        .then(() => true, () => false)
      if (exists) return candidate
    }

    return 'main'
  }

  static async hasRemote(repoPath: string, remoteName: string): Promise<boolean> {
    return git(['remote', 'get-url', remoteName], repoPath).then(
      () => true,
      () => false
    )
  }

  static async createProjectRepository(options: CreateProjectRepoOptions): Promise<CreateProjectRepoResult> {
    const projectName = options.projectName.trim()
    if (!projectName) throw new Error('Project name is required')
    const parentDir = resolve(options.parentDir)
    const localFolderName = sanitizeLocalFolderName(projectName)
    const repoPath = resolve(parentDir, localFolderName)
    ensureWithinParent(parentDir, repoPath)

    if (existsSync(repoPath)) {
      throw new Error('PROJECT_PATH_EXISTS')
    }

    await mkdir(repoPath, { recursive: true })

    // Initialize git repository with a deterministic default branch.
    try {
      await git(['init', '-b', 'main'], repoPath)
    } catch {
      await git(['init'], repoPath)
      await git(['branch', '-M', 'main'], repoPath).catch(() => {})
    }

    const readmePath = join(repoPath, 'README.md')
    await writeFile(readmePath, `# ${projectName}\n`, 'utf-8')

    await git(['add', 'README.md'], repoPath)

    const author = await resolveCommitAuthorIdentity(repoPath, options.ownership)

    try {
      await git(
        [
          '-c', `user.name=${author.name}`,
          '-c', `user.email=${author.email}`,
          'commit',
          '-m',
          'chore: bootstrap repository',
        ],
        repoPath,
      )
    } catch (err) {
      throw new Error(friendlyGitError(err, 'Failed to create initial commit'))
    }

    if (!options.createRemote) {
      return { repoPath, branch: 'main' }
    }

    const visibility = options.visibility === 'public' ? 'public' : 'private'
    const owner = (options.githubOwner?.trim() || (options.ownership === 'work' ? 'jleal-quintana' : 'juanilealb'))
    const repoSlug = sanitizeGithubRepoName(projectName)
    const remoteUrl = options.ownership === 'work'
      ? `git@github.com:${owner}/${repoSlug}.git`
      : `git@github-personal:${owner}/${repoSlug}.git`

    try {
      const createArgs = [
        'repo',
        'create',
        `${owner}/${repoSlug}`,
        visibility === 'public' ? '--public' : '--private',
        '--confirm',
      ]
      await gh(createArgs, repoPath)
    } catch (err) {
      throw new Error(friendlyGhError(err, 'Failed to create GitHub repository'))
    }

    try {
      if (await GitService.hasRemote(repoPath, 'origin')) {
        await git(['remote', 'set-url', 'origin', remoteUrl], repoPath)
      } else {
        await git(['remote', 'add', 'origin', remoteUrl], repoPath)
      }
      await git(['push', '-u', 'origin', 'main'], repoPath)
    } catch (err) {
      throw new Error(friendlyGitError(err, 'GitHub repository created but failed to configure/push origin'))
    }

    return { repoPath, remoteUrl, branch: 'main' }
  }

  static async createWorktree(
    repoPath: string,
    name: string,
    branch: string,
    newBranch: boolean,
    baseBranch?: string,
    force = false,
    onProgress?: CreateWorktreeProgressReporter
  ): Promise<string> {
    const requestedBranch = branch.trim()
    branch = GitService.sanitizeBranchName(requestedBranch)
    if (!branch) throw new Error('Branch name is empty after sanitization')

    const parentDir = dirname(repoPath)
    const repoName = basename(repoPath)
    const worktreeBaseDirName = buildWorktreeBaseDirName(repoName, name)
    const preferredWorktreePath = resolve(parentDir, worktreeBaseDirName)
    const worktreePath = force
      ? preferredWorktreePath
      : resolveUniqueWorktreePath(parentDir, worktreeBaseDirName)
    ensureWithinParent(parentDir, worktreePath)
    const hasOrigin = await GitService.hasRemote(repoPath, 'origin')

    // Clean up stale worktree refs
    reportCreateWorktreeProgress(onProgress, {
      stage: 'prune-worktrees',
      message: 'Cleaning stale worktree references...',
    })
    await git(['worktree', 'prune'], repoPath).catch(() => {})

    if (hasOrigin) {
      // Fetch remote refs so worktree branches from latest state
      reportCreateWorktreeProgress(onProgress, {
        stage: 'fetch-origin',
        message: 'Syncing remote...',
      })
      await git(['fetch', '--prune', 'origin'], repoPath)
    }

    // Auto-detect base branch when creating a new branch without explicit base
    if (newBranch && !baseBranch) {
      reportCreateWorktreeProgress(onProgress, {
        stage: 'resolve-default-branch',
        message: 'Resolving default base branch...',
      })
      baseBranch = await GitService.getDefaultBranch(repoPath)
    }

    reportCreateWorktreeProgress(onProgress, {
      stage: 'prepare-worktree-dir',
      message: 'Preparing worktree directory...',
    })
    if (existsSync(worktreePath)) {
      if (!force) {
        throw new Error('WORKTREE_PATH_EXISTS')
      }
      await rm(worktreePath, { recursive: true, force: true })
    }

    // Pre-check if branch exists so we never need -b retry
    reportCreateWorktreeProgress(onProgress, {
      stage: 'inspect-branch',
      message: 'Checking branch state...',
    })
    let branchExists = await git(['rev-parse', '--verify', `refs/heads/${branch}`], repoPath)
      .then(() => true, () => false)

    // If checking out an existing branch that doesn't exist locally or on origin,
    // try fetching it as a GitHub PR branch (fork PRs aren't included in normal fetch)
    if (!newBranch && !branchExists) {
      const remoteExists = hasOrigin
        ? await git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], repoPath)
          .then(() => true, () => false)
        : false
      if (!remoteExists) {
        try {
          const headCandidates = [requestedBranch]
          if (requestedBranch.includes(':')) {
            const prBranch = requestedBranch.split(':')[1]
            if (prBranch && !headCandidates.includes(prBranch)) headCandidates.push(prBranch)
          }
          if (!headCandidates.includes(branch)) headCandidates.push(branch)

          let prNumber = ''
          for (const headCandidate of headCandidates) {
            const { stdout } = await execFileAsync('gh', [
              // Resolve repo from cwd for broad gh CLI compatibility.
              'pr', 'list', '--head', headCandidate, '--json', 'number',
              '--jq', '.[0].number',
            ], { cwd: repoPath, windowsHide: true })
            prNumber = stdout.trim()
            if (prNumber) break
          }
          if (prNumber) {
            await git(['fetch', 'origin', `pull/${prNumber}/head:${branch}`], repoPath)
            branchExists = true
          }
        } catch {
          // gh not available or no matching PR — fall through to normal error
        }
      }
    }

    const args = ['worktree', 'add']
    if (force) args.push('--force')
    if (newBranch && !branchExists) {
      args.push('-b', branch, worktreePath)
      if (baseBranch) args.push(baseBranch)
    } else {
      args.push(worktreePath, branch)
    }

    try {
      reportCreateWorktreeProgress(onProgress, {
        stage: 'create-worktree',
        message: 'Creating worktree...',
      })
      await git(args, repoPath)
    } catch (err) {
      const msg = friendlyGitError(err, 'Failed to create worktree')
      if (msg === 'BRANCH_CHECKED_OUT' && !force) throw new Error(msg)
      throw new Error(msg)
    }

    // Fast-forward existing branches to match upstream
    if (hasOrigin && (!newBranch || branchExists)) {
      reportCreateWorktreeProgress(onProgress, {
        stage: 'sync-branch',
        message: 'Fast-forwarding branch...',
      })
      await git(['pull', '--ff-only'], worktreePath).catch(() => {})
    }

    // Copy .env files that are missing from the worktree (gitignored) from the main repo
    reportCreateWorktreeProgress(onProgress, {
      stage: 'copy-env-files',
      message: 'Copying env files...',
    })
    await copyEnvFiles(repoPath, worktreePath, repoPath)

    return worktreePath
  }

  static async createWorktreeFromPr(
    repoPath: string,
    name: string,
    prNumber: number,
    localBranch: string,
    force = false,
    onProgress?: CreateWorktreeProgressReporter
  ): Promise<PrWorktreeResult> {
    const parsedPrNumber = Number(prNumber)
    if (!Number.isInteger(parsedPrNumber) || parsedPrNumber <= 0) {
      throw new Error('Invalid pull request number')
    }

    const requestedBranch = localBranch.trim()
    const branch = GitService.sanitizeBranchName(requestedBranch)
    if (!branch) throw new Error('Branch name is empty after sanitization')

    const parentDir = dirname(repoPath)
    const repoName = basename(repoPath)
    const worktreeBaseDirName = buildWorktreeBaseDirName(repoName, name)
    const preferredWorktreePath = resolve(parentDir, worktreeBaseDirName)
    const worktreePath = force
      ? preferredWorktreePath
      : resolveUniqueWorktreePath(parentDir, worktreeBaseDirName)
    ensureWithinParent(parentDir, worktreePath)

    reportCreateWorktreeProgress(onProgress, {
      stage: 'prune-worktrees',
      message: 'Cleaning stale worktree references...',
    })
    await git(['worktree', 'prune'], repoPath).catch(() => {})

    const hasOrigin = await GitService.hasRemote(repoPath, 'origin')
    if (!hasOrigin) {
      throw new Error('No origin remote found')
    }

    reportCreateWorktreeProgress(onProgress, {
      stage: 'fetch-origin',
      message: `Fetching PR #${parsedPrNumber}...`,
    })
    try {
      await git(['fetch', '--prune', 'origin'], repoPath).catch(() => {})
      await git(['fetch', 'origin', `+pull/${parsedPrNumber}/head:${branch}`], repoPath)
    } catch (err) {
      const msg = friendlyGitError(err, `Failed to fetch PR #${parsedPrNumber}`)
      if (msg.includes('couldn\'t find remote ref') || msg.includes('no such remote ref')) {
        throw new Error(`Pull request #${parsedPrNumber} not found`)
      }
      throw new Error(msg)
    }

    reportCreateWorktreeProgress(onProgress, {
      stage: 'prepare-worktree-dir',
      message: 'Preparing worktree directory...',
    })
    if (existsSync(worktreePath)) {
      if (!force) {
        throw new Error('WORKTREE_PATH_EXISTS')
      }
      await rm(worktreePath, { recursive: true, force: true })
    }

    reportCreateWorktreeProgress(onProgress, {
      stage: 'create-worktree',
      message: 'Creating worktree...',
    })
    const args = ['worktree', 'add']
    if (force) args.push('--force')
    args.push(worktreePath, branch)

    try {
      await git(args, repoPath)
    } catch (err) {
      const msg = friendlyGitError(err, 'Failed to create worktree')
      if (msg === 'BRANCH_CHECKED_OUT' && !force) throw new Error(msg)
      throw new Error(msg)
    }

    reportCreateWorktreeProgress(onProgress, {
      stage: 'sync-branch',
      message: 'Fast-forwarding branch...',
    })
    await git(['pull', '--ff-only'], worktreePath).catch(() => {})

    reportCreateWorktreeProgress(onProgress, {
      stage: 'copy-env-files',
      message: 'Copying env files...',
    })
    await copyEnvFiles(repoPath, worktreePath, repoPath)

    return { worktreePath, branch }
  }

  static async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    if (samePath(repoPath, worktreePath)) {
      return
    }

    try {
      await git(['worktree', 'remove', worktreePath, '--force'], repoPath)
    } catch (err) {
      if (!isAlreadyMissingWorktreeError(err)) {
        throw new Error(friendlyGitError(err, 'Failed to remove worktree'))
      }
    }

    try {
      await rm(worktreePath, { recursive: true, force: true })
    } catch (err) {
      throw new Error(friendlyGitError(err, 'Worktree removed from git but failed to delete folder'))
    }
  }

  static async getTopLevel(cwd: string): Promise<string> {
    return git(['rev-parse', '--show-toplevel'], cwd)
  }

  static async getCurrentBranch(worktreePath: string): Promise<string> {
    if (!existsSync(worktreePath)) return ''
    try {
      return await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)
    } catch {
      return ''
    }
  }

  static async fetchOrigin(repoPath: string): Promise<void> {
    const hasOrigin = await GitService.hasRemote(repoPath, 'origin')
    if (!hasOrigin) {
      throw new Error('No origin remote found')
    }
    try {
      await git(['fetch', '--prune', 'origin'], repoPath)
    } catch (err) {
      throw new Error(friendlyGitError(err, 'Failed to fetch origin'))
    }
  }

  static async pullCurrentBranch(worktreePath: string): Promise<PushBranchResult> {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath).catch(() => '')
    if (!branch || branch === 'HEAD') {
      throw new Error('Cannot sync detached HEAD')
    }

    const dirty = await git(['status', '--porcelain=v1', '-uall'], worktreePath).catch(() => '')
    if (dirty.trim()) {
      throw new Error('Workspace has local changes. Commit, stash, or discard before sync.')
    }

    try {
      await git(['pull', '--ff-only'], worktreePath)
    } catch (err) {
      throw new Error(friendlyGitError(err, 'Failed to sync current branch'))
    }
    return { branch }
  }

  static async getBranchSyncStatus(worktreePath: string): Promise<BranchSyncStatus> {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath).catch(() => '')
    if (!branch) {
      return {
        branch: '',
        upstream: null,
        ahead: 0,
        behind: 0,
        state: 'unknown',
      }
    }
    if (branch === 'HEAD') {
      return {
        branch,
        upstream: null,
        ahead: 0,
        behind: 0,
        state: 'detached',
      }
    }

    let upstream = await git(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      worktreePath
    ).catch(() => '')

    if (!upstream) {
      const fallbackUpstream = `origin/${branch}`
      const hasFallbackUpstream = await git(
        ['rev-parse', '--verify', `refs/remotes/${fallbackUpstream}`],
        worktreePath,
      ).then(() => true, () => false)

      if (!hasFallbackUpstream) {
        return {
          branch,
          upstream: null,
          ahead: 0,
          behind: 0,
          state: 'no-upstream',
        }
      }
      upstream = fallbackUpstream
    }

    try {
      const output = await git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], worktreePath)
      const [behindRaw = '0', aheadRaw = '0'] = output.trim().split(/\s+/)
      const behind = Number.parseInt(behindRaw, 10) || 0
      const ahead = Number.parseInt(aheadRaw, 10) || 0
      const state: BranchSyncState = ahead > 0 && behind > 0
        ? 'diverged'
        : ahead > 0
          ? 'ahead'
          : behind > 0
            ? 'behind'
            : 'up-to-date'

      return {
        branch,
        upstream,
        ahead,
        behind,
        state,
      }
    } catch {
      return {
        branch,
        upstream,
        ahead: 0,
        behind: 0,
        state: 'unknown',
      }
    }
  }

  static async getStatus(worktreePath: string): Promise<FileStatus[]> {
    const output = await git(
      ['status', '--porcelain=v1', '-uall'],
      worktreePath
    )
    if (!output) return []

    const results: FileStatus[] = []

    for (const line of output.split('\n')) {
      const indexStatus = line[0]
      const workStatus = line[1]
      const path = line.slice(3)
      if (isWindowsReservedPath(path)) {
        continue
      }

      if (indexStatus === '?' && workStatus === '?') {
        results.push({ path, status: 'untracked', staged: false })
        continue
      }

      // Staged entry (index has a real status)
      if (indexStatus !== ' ' && indexStatus !== '?') {
        const status: FileStatus['status'] =
          indexStatus === 'A' ? 'added' :
          indexStatus === 'D' ? 'deleted' :
          indexStatus === 'R' ? 'renamed' : 'modified'
        results.push({ path, status, staged: true })
      }

      // Unstaged entry (worktree has a real status)
      if (workStatus !== ' ' && workStatus !== '?') {
        const status: FileStatus['status'] =
          workStatus === 'D' ? 'deleted' : 'modified'
        results.push({ path, status, staged: false })
      }
    }

    return results
  }

  static async getDiff(worktreePath: string, staged: boolean): Promise<FileDiff[]> {
    const args = ['diff']
    if (staged) args.push('--staged')
    args.push('--unified=3')

    const output = await git(args, worktreePath)
    if (!output) return []

    // Split by file boundaries
    const files: FileDiff[] = []
    const parts = output.split(/^diff --git /m).filter(Boolean)

    for (const part of parts) {
      const firstLine = part.split('\n')[0]
      // Extract b/path from "a/path b/path"
      const match = firstLine.match(/b\/(.+)$/)
      if (match) {
        files.push({
          path: match[1],
          hunks: 'diff --git ' + part,
        })
      }
    }

    return files
  }

  static async getFileDiff(worktreePath: string, filePath: string): Promise<string> {
    try {
      // Try unstaged first
      const unstaged = await git(['diff', '--', filePath], worktreePath)
      if (unstaged) return unstaged
      // Then staged
      return await git(['diff', '--staged', '--', filePath], worktreePath)
    } catch {
      return ''
    }
  }

  static async getBranches(repoPath: string): Promise<string[]> {
    const [localOut, remoteOut] = await Promise.all([
      git(['branch', '--list', '--format=%(refname:short)'], repoPath),
      git(['branch', '-r', '--format=%(refname:short)'], repoPath).catch(() => ''),
    ])
    const seen = new Set<string>()
    const branches: string[] = []
    // Add local branches first
    for (const name of localOut.split('\n').filter(Boolean)) {
      seen.add(name)
      branches.push(name)
    }
    // Add remote branches, stripping remote prefix and deduplicating
    for (const raw of remoteOut.split('\n').filter(Boolean)) {
      if (raw.endsWith('/HEAD')) continue
      // "origin/feature-x" → "feature-x", "origin/feat/sub" → "feat/sub"
      const slash = raw.indexOf('/')
      const name = slash >= 0 ? raw.slice(slash + 1) : raw
      if (!seen.has(name)) {
        seen.add(name)
        branches.push(name)
      }
    }
    return branches
  }

  static async stage(worktreePath: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await git(['add', '--', ...paths], worktreePath)
  }

  static async unstage(worktreePath: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await git(['reset', 'HEAD', '--', ...paths], worktreePath)
  }

  static async discard(worktreePath: string, paths: string[], untracked: string[]): Promise<void> {
    const safePaths = paths.filter((path) => !isWindowsReservedPath(path))
    const safeUntracked = untracked.filter((path) => !isWindowsReservedPath(path))

    if (safePaths.length > 0) {
      await git(['checkout', '--', ...safePaths], worktreePath)
    }
    if (safeUntracked.length > 0) {
      await git(['clean', '-f', '--', ...safeUntracked], worktreePath)
    }
  }

  static async commit(worktreePath: string, message: string): Promise<void> {
    await git(['commit', '-m', message], worktreePath)
  }

  static async pushCurrentBranch(worktreePath: string): Promise<PushBranchResult> {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)
    if (!branch || branch === 'HEAD') {
      throw new Error('Cannot push detached HEAD')
    }
    try {
      await git(['push', '--set-upstream', 'origin', branch], worktreePath)
    } catch (err) {
      throw new Error(friendlyGitError(err, 'Failed to push current branch'))
    }
    return { branch }
  }

  private static async ensureGhAuthenticated(repoPath: string): Promise<void> {
    try {
      await gh(['auth', 'status'], repoPath)
    } catch (err) {
      throw new Error(friendlyGhError(err, 'GitHub CLI is not authenticated. Run "gh auth login".'))
    }
  }

  private static async resolvePrTarget(
    repoPath: string,
    sourceBranch: string
  ): Promise<{ repoRef?: string; headRef: string }> {
    const originUrl = await git(['remote', 'get-url', 'origin'], repoPath).catch(() => '')
    const originRepo = parseGithubRemote(originUrl)
    if (!originRepo) {
      return { headRef: sourceBranch }
    }

    let targetRepo = originRepo
    let headRef = sourceBranch
    if (await GitService.hasRemote(repoPath, 'upstream')) {
      const upstreamUrl = await git(['remote', 'get-url', 'upstream'], repoPath).catch(() => '')
      const upstreamRepo = parseGithubRemote(upstreamUrl)
      if (
        upstreamRepo &&
        (upstreamRepo.owner !== originRepo.owner || upstreamRepo.repo !== originRepo.repo)
      ) {
        targetRepo = upstreamRepo
        headRef = `${originRepo.owner}:${sourceBranch}`
      }
    }

    return {
      repoRef: `${targetRepo.owner}/${targetRepo.repo}`,
      headRef,
    }
  }

  private static async findOpenPrUrl(
    repoPath: string,
    headRef: string,
    baseBranch?: string,
    repoRef?: string
  ): Promise<string | null> {
    try {
      const args = ['pr', 'list']
      if (repoRef) args.push('--repo', repoRef)
      args.push('--head', headRef)
      if (baseBranch) args.push('--base', baseBranch)
      args.push('--state', 'open', '--json', 'url', '--jq', '.[0].url')
      const out = await gh(
        args,
        repoPath
      )
      const url = out.trim()
      if (!url || url === 'null') return null
      return url
    } catch {
      return null
    }
  }

  static async openOrCreatePullRequest(worktreePath: string, baseBranch?: string): Promise<PullRequestResult> {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)
    if (!branch || branch === 'HEAD') {
      throw new Error('Cannot open pull request from detached HEAD')
    }
    if (branch === 'main' || branch === 'master') {
      throw new Error(`Cannot open pull request from ${branch}`)
    }
    const normalizedBaseBranch = normalizeBranchName(baseBranch ?? '')
    if (normalizedBaseBranch && normalizedBaseBranch === branch) {
      throw new Error('PR base branch cannot be the same as source branch')
    }

    await GitService.ensureGhAuthenticated(worktreePath)
    const { repoRef, headRef } = await GitService.resolvePrTarget(worktreePath, branch)

    const existing = await GitService.findOpenPrUrl(worktreePath, headRef, normalizedBaseBranch || undefined, repoRef)
    if (existing) {
      return { url: existing, created: false, branch }
    }

    try {
      const createArgs = ['pr', 'create']
      if (repoRef) createArgs.push('--repo', repoRef)
      createArgs.push('--fill', '--head', headRef)
      if (normalizedBaseBranch) {
        createArgs.push('--base', normalizedBaseBranch)
      }
      const createdUrl = await gh(
        createArgs,
        worktreePath
      )
      const url = createdUrl.trim()
      if (!url) throw new Error('Pull request created but URL was not returned')
      return { url, created: true, branch }
    } catch (err) {
      const maybeExisting = await GitService.findOpenPrUrl(
        worktreePath,
        headRef,
        normalizedBaseBranch || undefined,
        repoRef,
      )
      if (maybeExisting) {
        return { url: maybeExisting, created: false, branch }
      }
      throw new Error(friendlyGhError(err, 'Failed to create pull request'))
    }
  }

  private static async openOrCreateSourceToMainPr(
    repoPath: string,
    sourceBranch: string,
    mainBranch: string
  ): Promise<{ url: string; created: boolean }> {
    await GitService.ensureGhAuthenticated(repoPath)
    const { repoRef, headRef } = await GitService.resolvePrTarget(repoPath, sourceBranch)
    const existingUrl = await GitService.findOpenPrUrl(repoPath, headRef, mainBranch, repoRef)
    if (existingUrl) {
      return { url: existingUrl, created: false }
    }

    const createArgs = ['pr', 'create']
    if (repoRef) createArgs.push('--repo', repoRef)
    createArgs.push('--head', headRef, '--base', mainBranch, '--fill')

    const createdUrl = await gh(
      createArgs,
      repoPath
    )
    const url = createdUrl.trim()
    if (!url) throw new Error('Pull request created but URL was not returned')
    return { url, created: true }
  }

  static async shipBranchToMain(repoPath: string, sourceBranch: string): Promise<ShipToMainResult> {
    const source = sourceBranch.trim()
    if (!source) {
      throw new Error('Source branch is required')
    }

    const defaultRef = await GitService.getDefaultBranch(repoPath)
    const mainBranch = defaultRef.startsWith('origin/') ? defaultRef.slice('origin/'.length) : defaultRef
    if (!mainBranch) {
      throw new Error('Failed to resolve main branch')
    }
    if (source === mainBranch) {
      throw new Error('Source branch is already main')
    }

    const sourceExists = await git(['rev-parse', '--verify', `refs/heads/${source}`], repoPath).then(
      () => true,
      () => false
    )
    if (!sourceExists) {
      throw new Error(`Branch "${source}" not found`)
    }

    try {
      await git(['fetch', '--prune', 'origin'], repoPath)
    } catch (err) {
      throw new Error(friendlyGitError(err, 'Failed to fetch origin before shipping branch'))
    }

    const remoteSourceRef = `refs/remotes/origin/${source}`
    const remoteBranchExists = await git(['rev-parse', '--verify', remoteSourceRef], repoPath).then(
      () => true,
      () => false
    )

    let shouldPush = true
    if (remoteBranchExists) {
      const counts = await git(['rev-list', '--left-right', '--count', `${source}...origin/${source}`], repoPath)
      const [aheadRaw = '0', behindRaw = '0'] = counts.trim().split(/\s+/)
      const ahead = Number.parseInt(aheadRaw, 10)
      const behind = Number.parseInt(behindRaw, 10)

      if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
        throw new Error(`Failed to compare ${source} with origin/${source}`)
      }
      if (behind > 0) {
        throw new Error(
          `Branch "${source}" is behind origin/${source}. Pull/rebase before opening or updating the PR.`
        )
      }

      // Nothing new to push: keep going so we can still open/reuse an existing PR.
      shouldPush = ahead > 0
    }

    if (shouldPush) {
      try {
        if (remoteBranchExists) {
          await git(['push', 'origin', `${source}:${source}`], repoPath)
        } else {
          await git(['push', '--set-upstream', 'origin', source], repoPath)
        }
      } catch (err) {
        throw new Error(friendlyGitError(err, `Failed to push ${source} to origin`))
      }
    }

    try {
      const pr = await GitService.openOrCreateSourceToMainPr(repoPath, source, mainBranch)
      return {
        mainBranch,
        prUrl: pr.url,
        prCreated: pr.created,
      }
    } catch (err) {
      if (err instanceof Error && err.message) {
        throw new Error(err.message)
      }
      throw new Error(friendlyGhError(err, `Pushed ${source}, but failed to open pull request`))
    }
  }

  static async createSnapshot(worktreePath: string, label?: string): Promise<WorkspaceSnapshot | null> {
    // `git stash create` returns a commit hash without mutating the working tree.
    // If there are no local modifications, it returns an empty string.
    const commit = (await git(['stash', 'create'], worktreePath)).trim()
    if (!commit) return null

    const normalizedLabel = (label ?? '').trim() || 'Snapshot'
    const message = `${SNAPSHOT_PREFIX} ${normalizedLabel}`
    await git(['stash', 'store', '-m', message, commit], worktreePath)

    const snapshots = await GitService.listSnapshots(worktreePath)
    return snapshots[0] ?? null
  }

  static async listSnapshots(worktreePath: string): Promise<WorkspaceSnapshot[]> {
    const output = await git(['stash', 'list', '--format=%gd%x09%ct%x09%s'], worktreePath)
    if (!output) return []

    const snapshots: WorkspaceSnapshot[] = []
    for (const line of output.split('\n')) {
      const [ref, createdAtText, subject] = line.split('\t')
      if (!ref || !createdAtText || !subject) continue
      if (!subject.startsWith(SNAPSHOT_PREFIX)) continue

      const createdAt = Number.parseInt(createdAtText, 10)
      snapshots.push({
        ref,
        createdAt: Number.isFinite(createdAt) ? createdAt : Math.floor(Date.now() / 1000),
        label: subject.slice(SNAPSHOT_PREFIX.length).trim() || 'Snapshot',
      })
    }

    return snapshots
  }

  static async restoreSnapshot(worktreePath: string, ref: string): Promise<void> {
    await git(['stash', 'apply', '--index', ref], worktreePath)
  }

  static async dropSnapshot(worktreePath: string, ref: string): Promise<void> {
    await git(['stash', 'drop', ref], worktreePath)
  }
}

