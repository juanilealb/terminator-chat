export const AGENT_PERMISSION_MODES = ['default', 'full-permissions'] as const

export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number]

export const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = 'default'

export function isAgentPermissionMode(value: unknown): value is AgentPermissionMode {
  return typeof value === 'string' && AGENT_PERMISSION_MODES.includes(value as AgentPermissionMode)
}

export function parseAgentPermissionMode(value: unknown): AgentPermissionMode {
  if (isAgentPermissionMode(value)) return value
  // Legacy value kept for backward compatibility with persisted workspaces.
  if (value === 'yolo') return 'default'
  return DEFAULT_AGENT_PERMISSION_MODE
}
