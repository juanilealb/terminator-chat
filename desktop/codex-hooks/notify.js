#!/usr/bin/env node

const { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const workspaceId = process.env.AGENT_ORCH_WS_ID || ''
if (!workspaceId) process.exit(0)

const notifyDir = join(tmpdir(), 'terminator-chat-notify')
const activityDir = join(tmpdir(), 'terminator-chat-activity')
const codexMarkerPrefix = `${workspaceId}.codex.`
const codexWaitingMarkerPrefix = `${workspaceId}.codex-wait.`

try {
  mkdirSync(notifyDir, { recursive: true })
  const target = join(notifyDir, `${Date.now()}-${process.pid}`)
  const tmpTarget = `${target}.tmp`
  writeFileSync(tmpTarget, `${workspaceId}\n`, 'utf-8')
  renameSync(tmpTarget, target)
} catch {
  // Best-effort notify marker
}

try {
  const markers = readdirSync(activityDir)
  for (const marker of markers) {
    if (marker.startsWith(codexMarkerPrefix) || marker.startsWith(codexWaitingMarkerPrefix)) {
      rmSync(join(activityDir, marker), { force: true })
    }
  }
} catch {
  // Activity dir may not exist yet
}

try {
  const hasClaudeMarker = readdirSync(activityDir).includes(`${workspaceId}.claude`)
  if (!hasClaudeMarker) {
    rmSync(join(activityDir, workspaceId), { force: true })
  }
} catch {
  // Activity dir may not exist yet
}
