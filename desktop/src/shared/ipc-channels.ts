export type ThemePreference = 'system' | 'dark' | 'light'

export interface ThemeChangedPayload {
  dark: boolean
  accentColor: string
}

export type AgentNotifyReason = 'completed' | 'waiting_input'

export interface AgentNotifyEvent {
  workspaceId: string
  reason: AgentNotifyReason
  turnId?: string
  source?: 'hook' | 'chat'
}

export interface AgentActivitySnapshot {
  runningWorkspaceIds: string[]
  waitingWorkspaceIds: string[]
  runningAgentsByWorkspace: Record<string, number>
  waitingAgentsByWorkspace: Record<string, number>
  runningAgentCount: number
}

export type ChatLifecyclePhase =
  | 'thread.started'
  | 'turn.started'
  | 'item.delta'
  | 'turn.waiting_input'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled'
  | 'error'
  | 'unknown'

export interface ChatEventPayload {
  eventId: string
  threadId: string
  workspaceId?: string
  turnId?: string
  type: string
  phase: ChatLifecyclePhase
  ts: number
  data: Record<string, unknown>
}

// IPC channel constants shared between main and renderer

export const IPC = {
  // Git operations
  GIT_LIST_WORKTREES: 'git:list-worktrees',
  GIT_CREATE_WORKTREE: 'git:create-worktree',
  GIT_CREATE_WORKTREE_FROM_PR: 'git:create-worktree-from-pr',
  GIT_CREATE_WORKTREE_PROGRESS: 'git:create-worktree-progress',
  GIT_REMOVE_WORKTREE: 'git:remove-worktree',
  GIT_GET_STATUS: 'git:get-status',
  GIT_GET_DIFF: 'git:get-diff',
  GIT_GET_FILE_DIFF: 'git:get-file-diff',
  GIT_GET_BRANCHES: 'git:get-branches',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_DISCARD: 'git:discard',
  GIT_COMMIT: 'git:commit',
  GIT_PUSH_CURRENT_BRANCH: 'git:push-current-branch',
  GIT_OPEN_OR_CREATE_PR: 'git:open-or-create-pr',
  GIT_SHIP_BRANCH_TO_MAIN: 'git:ship-branch-to-main',
  GIT_GET_CURRENT_BRANCH: 'git:get-current-branch',
  GIT_GET_DEFAULT_BRANCH: 'git:get-default-branch',
  GIT_CREATE_SNAPSHOT: 'git:create-snapshot',
  GIT_LIST_SNAPSHOTS: 'git:list-snapshots',
  GIT_RESTORE_SNAPSHOT: 'git:restore-snapshot',
  GIT_DROP_SNAPSHOT: 'git:drop-snapshot',

  // File operations
  FS_GET_TREE: 'fs:get-tree',
  FS_GET_TREE_WITH_STATUS: 'fs:get-tree-with-status',
  FS_READ_FILE: 'fs:read-file',
  FS_WRITE_FILE: 'fs:write-file',
  FS_WATCH_START: 'fs:watch-start',
  FS_WATCH_STOP: 'fs:watch-stop',
  FS_WATCH_CHANGED: 'fs:watch-changed',

  // App operations
  APP_SELECT_DIRECTORY: 'app:select-directory',
  APP_ADD_PROJECT_PATH: 'app:add-project-path',
  APP_GET_DATA_PATH: 'app:get-data-path',
  APP_SET_UNREAD_COUNT: 'app:set-unread-count',
  APP_SET_ACTIVE_WORKSPACE: 'app:set-active-workspace',
  APP_OPEN_DIRECTORY: 'app:open-directory',
  APP_SET_THEME_SOURCE: 'app:set-theme-source',
  APP_WINDOW_MINIMIZE: 'app:window-minimize',
  APP_WINDOW_TOGGLE_MAXIMIZE: 'app:window-toggle-maximize',
  APP_WINDOW_CLOSE: 'app:window-close',
  APP_WINDOW_IS_MAXIMIZED: 'app:window-is-maximized',
  APP_WINDOW_MAXIMIZED_CHANGED: 'app:window-maximized-changed',
  APP_OPEN_IN_VSCODE: 'app:open-in-vscode',
  APP_OPEN_IN_CURSOR: 'app:open-in-cursor',
  ACTIVATE_WORKSPACE: 'app:activate-workspace',
  THEME_CHANGED: 'theme:changed',

  // Claude Code integration
  CLAUDE_TRUST_PATH: 'claude:trust-path',
  CLAUDE_INSTALL_HOOKS: 'claude:install-hooks',
  CLAUDE_UNINSTALL_HOOKS: 'claude:uninstall-hooks',
  CLAUDE_CHECK_HOOKS: 'claude:check-hooks',
  CLAUDE_NOTIFY_WORKSPACE: 'claude:notify-workspace',
  CLAUDE_ACTIVITY_UPDATE: 'claude:activity-update',

  // Codex integration
  CODEX_INSTALL_NOTIFY: 'codex:install-notify',
  CODEX_UNINSTALL_NOTIFY: 'codex:uninstall-notify',
  CODEX_CHECK_NOTIFY: 'codex:check-notify',

  // Chat / Codex SDK
  CHAT_LOGIN: 'chat:login',
  CHAT_LOGOUT: 'chat:logout',
  CHAT_AUTH_STATUS: 'chat:auth-status',
  CHAT_LIST_MODELS: 'chat:list-models',
  CHAT_CREATE_THREAD: 'chat:create-thread',
  CHAT_SEND: 'chat:send',
  CHAT_CANCEL: 'chat:cancel',
  CHAT_DESTROY_THREAD: 'chat:destroy-thread',
  CHAT_EVENT: 'chat:event',
  CHAT_RESUME: 'chat:resume',

  // GitHub operations
  GITHUB_GET_PR_STATUSES: 'github:get-pr-statuses',
  GITHUB_LIST_OPEN_PRS: 'github:list-open-prs',
  GITHUB_LIST_AUTH_ACCOUNTS: 'github:list-auth-accounts',

  // Clipboard operations
  CLIPBOARD_SAVE_IMAGE: 'clipboard:save-image',
  CLIPBOARD_READ_TEXT: 'clipboard:read-text',
  CLIPBOARD_WRITE_TEXT: 'clipboard:write-text',

  // State persistence
  STATE_SAVE: 'state:save',
  STATE_SAVE_SYNC: 'state:save-sync',
  STATE_LOAD: 'state:load',
} as const
