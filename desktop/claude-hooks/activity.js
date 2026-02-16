#!/usr/bin/env node

const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const workspaceId = process.env.AGENT_ORCH_WS_ID || ''
if (!workspaceId) process.exit(0)

const activityDir = join(tmpdir(), 'terminator-chat-activity')

try {
  mkdirSync(activityDir, { recursive: true })
  writeFileSync(join(activityDir, `${workspaceId}.claude`), '', 'utf-8')
} catch {
  // Best-effort marker write
}
