import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const appPath = resolve(__dirname, '../out/main/index.js')
const ACTIVITY_DIR = join(tmpdir(), 'terminator-chat-activity')

async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({ args: [appPath], env: { ...process.env, CI_TEST: '1' } })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 20000 })
  await window.waitForTimeout(1000)
  return { app, window }
}

function createWorkspaceFixture(name: string): {
  repoPath: string
  ws1Path: string
  ws2Path: string
} {
  const base = join(tmpdir(), `tc-activity-${name}-${Date.now()}`)
  const repoPath = join(base, 'repo')
  const ws1Path = join(base, 'ws-1')
  const ws2Path = join(base, 'ws-2')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(ws1Path, { recursive: true })
  mkdirSync(ws2Path, { recursive: true })
  return { repoPath, ws1Path, ws2Path }
}

function clearWorkspaceMarkers(workspaceId: string): void {
  mkdirSync(ACTIVITY_DIR, { recursive: true })
  for (const fileName of readdirSync(ACTIVITY_DIR)) {
    if (fileName.startsWith(`${workspaceId}.codex.`) || fileName.startsWith(`${workspaceId}.codex-wait.`)) {
      try {
        unlinkSync(join(ACTIVITY_DIR, fileName))
      } catch {
        // best effort cleanup
      }
    }
  }
}

function writeActivityMarker(workspaceId: string, state: 'running' | 'waiting'): void {
  mkdirSync(ACTIVITY_DIR, { recursive: true })
  const suffix = state === 'waiting' ? 'codex-wait' : 'codex'
  const markerPath = join(ACTIVITY_DIR, `${workspaceId}.${suffix}.${Date.now()}`)
  writeFileSync(markerPath, '')
}

async function setupSingleWorkspace(window: Page, paths: { repoPath: string; ws1Path: string }) {
  return await window.evaluate(async ({ repoPath, ws1Path }) => {
    const store = (window as any).__store.getState()
    store.hydrateState({ projects: [], workspaces: [], tabs: [] })

    const projectId = crypto.randomUUID()
    store.addProject({
      id: projectId,
      name: 'test-repo',
      repoPath,
      ownership: 'personal',
    })

    const ws1Id = crypto.randomUUID()
    store.addWorkspace({
      id: ws1Id,
      name: 'ws-1',
      type: 'feature',
      branch: 'branch-1',
      worktreePath: ws1Path,
      projectId,
      agentPermissionMode: 'default',
      memory: '',
    })

    const tabId = crypto.randomUUID()
    store.addTab({
      id: tabId,
      workspaceId: ws1Id,
      type: 'chat',
      title: 'Thread 1',
      threadId: crypto.randomUUID(),
    })
    store.setActiveWorkspace(ws1Id)
    store.setActiveTab(tabId)

    return { ws1Id }
  }, paths)
}

async function setupTwoWorkspaces(window: Page, paths: { repoPath: string; ws1Path: string; ws2Path: string }) {
  return await window.evaluate(async ({ repoPath, ws1Path, ws2Path }) => {
    const store = (window as any).__store.getState()
    store.hydrateState({ projects: [], workspaces: [], tabs: [] })

    const projectId = crypto.randomUUID()
    store.addProject({
      id: projectId,
      name: 'test-repo',
      repoPath,
      ownership: 'personal',
    })

    const ws1Id = crypto.randomUUID()
    store.addWorkspace({
      id: ws1Id,
      name: 'ws-1',
      type: 'feature',
      branch: 'branch-1',
      worktreePath: ws1Path,
      projectId,
      agentPermissionMode: 'default',
      memory: '',
    })
    const ws1TabId = crypto.randomUUID()
    store.addTab({
      id: ws1TabId,
      workspaceId: ws1Id,
      type: 'chat',
      title: 'Thread 1',
      threadId: crypto.randomUUID(),
    })

    const ws2Id = crypto.randomUUID()
    store.addWorkspace({
      id: ws2Id,
      name: 'ws-2',
      type: 'feature',
      branch: 'branch-2',
      worktreePath: ws2Path,
      projectId,
      agentPermissionMode: 'default',
      memory: '',
    })
    const ws2TabId = crypto.randomUUID()
    store.addTab({
      id: ws2TabId,
      workspaceId: ws2Id,
      type: 'chat',
      title: 'Thread 2',
      threadId: crypto.randomUUID(),
    })

    store.setActiveWorkspace(ws2Id)
    store.setActiveTab(ws2TabId)

    return { ws1Id, ws2Id }
  }, paths)
}

test.describe('Codex activity indicator', () => {
  test.beforeEach(() => {
    mkdirSync(ACTIVITY_DIR, { recursive: true })
  })

  test('marks workspace running while codex marker exists and clears when removed', async () => {
    const fixture = createWorkspaceFixture('running')
    const { app, window } = await launchApp()

    try {
      const { ws1Id } = await setupSingleWorkspace(window, { repoPath: fixture.repoPath, ws1Path: fixture.ws1Path })
      clearWorkspaceMarkers(ws1Id)
      await window.waitForTimeout(700)

      writeActivityMarker(ws1Id, 'running')
      await window.waitForFunction(
        (workspaceId: string) => (window as any).__store.getState().activeClaudeWorkspaceIds.has(workspaceId),
        ws1Id,
        { timeout: 7000 },
      )

      clearWorkspaceMarkers(ws1Id)
      await window.waitForFunction(
        (workspaceId: string) => !(window as any).__store.getState().activeClaudeWorkspaceIds.has(workspaceId),
        ws1Id,
        { timeout: 7000 },
      )
    } finally {
      await app.close()
    }
  })

  test('marks workspace waiting while codex waiting marker exists', async () => {
    const fixture = createWorkspaceFixture('waiting')
    const { app, window } = await launchApp()

    try {
      const { ws1Id } = await setupSingleWorkspace(window, { repoPath: fixture.repoPath, ws1Path: fixture.ws1Path })
      clearWorkspaceMarkers(ws1Id)
      await window.waitForTimeout(700)

      writeActivityMarker(ws1Id, 'waiting')
      await window.waitForFunction(
        (workspaceId: string) => (window as any).__store.getState().waitingClaudeWorkspaceIds.has(workspaceId),
        ws1Id,
        { timeout: 7000 },
      )

      clearWorkspaceMarkers(ws1Id)
      await window.waitForFunction(
        (workspaceId: string) => !(window as any).__store.getState().waitingClaudeWorkspaceIds.has(workspaceId),
        ws1Id,
        { timeout: 7000 },
      )
    } finally {
      await app.close()
    }
  })

  test('background completion marks workspace as completed and unread', async () => {
    const fixture = createWorkspaceFixture('completed-unread')
    const { app, window } = await launchApp()

    try {
      const { ws1Id } = await setupTwoWorkspaces(window, fixture)
      clearWorkspaceMarkers(ws1Id)
      await window.waitForTimeout(700)

      writeActivityMarker(ws1Id, 'running')
      await window.waitForFunction(
        (workspaceId: string) => (window as any).__store.getState().activeClaudeWorkspaceIds.has(workspaceId),
        ws1Id,
        { timeout: 7000 },
      )

      clearWorkspaceMarkers(ws1Id)
      await window.waitForFunction(
        (workspaceId: string) =>
          (window as any).__store.getState().completedClaudeWorkspaceIds.has(workspaceId)
          && (window as any).__store.getState().unreadWorkspaceIds.has(workspaceId),
        ws1Id,
        { timeout: 9000 },
      )
    } finally {
      await app.close()
    }
  })

  test('running to waiting transition updates waiting state', async () => {
    const fixture = createWorkspaceFixture('running-to-waiting')
    const { app, window } = await launchApp()

    try {
      const { ws1Id } = await setupTwoWorkspaces(window, fixture)
      clearWorkspaceMarkers(ws1Id)
      await window.waitForTimeout(700)

      writeActivityMarker(ws1Id, 'running')
      await window.waitForFunction(
        (workspaceId: string) => (window as any).__store.getState().activeClaudeWorkspaceIds.has(workspaceId),
        ws1Id,
        { timeout: 7000 },
      )

      clearWorkspaceMarkers(ws1Id)
      writeActivityMarker(ws1Id, 'waiting')

      await window.waitForFunction(
        (workspaceId: string) =>
          !(window as any).__store.getState().activeClaudeWorkspaceIds.has(workspaceId)
          && (window as any).__store.getState().waitingClaudeWorkspaceIds.has(workspaceId),
        ws1Id,
        { timeout: 9000 },
      )
    } finally {
      await app.close()
    }
  })

  test('waiting snapshot wins over running when both target same workspace', async () => {
    const fixture = createWorkspaceFixture('waiting-priority')
    const { app, window } = await launchApp()

    try {
      const { ws1Id } = await setupSingleWorkspace(window, {
        repoPath: fixture.repoPath,
        ws1Path: fixture.ws1Path,
      })

      const stateAfterSnapshot = await window.evaluate((workspaceId: string) => {
        const store = (window as any).__store.getState()
        store.setWorkspaceAgentStatus(workspaceId, 'running')
        store.setClaudeActivitySnapshot({
          runningWorkspaceIds: [workspaceId],
          waitingWorkspaceIds: [workspaceId],
          runningAgentsByWorkspace: { [workspaceId]: 1 },
          waitingAgentsByWorkspace: { [workspaceId]: 1 },
          runningAgentCount: 1,
        })
        const next = (window as any).__store.getState()
        return {
          isRunning: next.activeClaudeWorkspaceIds.has(workspaceId),
          isWaiting: next.waitingClaudeWorkspaceIds.has(workspaceId),
        }
      }, ws1Id)

      expect(stateAfterSnapshot.isRunning).toBe(false)
      expect(stateAfterSnapshot.isWaiting).toBe(true)
    } finally {
      await app.close()
    }
  })
})
