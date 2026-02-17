import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const appPath = resolve(__dirname, '../out/main/index.js')
const NOTIFY_DIR = join(tmpdir(), 'terminator-chat-notify')

async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({ args: [appPath], env: { ...process.env, CI_TEST: '1' } })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 10000 })
  await window.waitForTimeout(1000)
  return { app, window }
}

function createWorkspaceFixture(name: string): {
  repoPath: string
  ws1Path: string
  ws2Path: string
} {
  const base = join(tmpdir(), `tc-unread-${name}-${Date.now()}`)
  const repoPath = join(base, 'repo')
  const ws1Path = join(base, 'ws-1')
  const ws2Path = join(base, 'ws-2')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(ws1Path, { recursive: true })
  mkdirSync(ws2Path, { recursive: true })
  return { repoPath, ws1Path, ws2Path }
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

function writeSignalFile(workspaceId: string): void {
  mkdirSync(NOTIFY_DIR, { recursive: true })
  writeFileSync(join(NOTIFY_DIR, `test-${Date.now()}-${Math.random()}`), workspaceId)
}

test.describe('Unread indicator', () => {
  test('notification signal marks non-active workspace as unread', async () => {
    const fixture = createWorkspaceFixture('set-unread')
    const { app, window } = await launchApp()

    try {
      const { ws1Id } = await setupTwoWorkspaces(window, fixture)
      await window.waitForTimeout(700)

      writeSignalFile(ws1Id)

      await window.waitForFunction(
        (workspaceId: string) => (window as any).__store.getState().unreadWorkspaceIds.has(workspaceId),
        ws1Id,
        { timeout: 7000 },
      )
    } finally {
      await app.close()
    }
  })

  test('switching to unread workspace clears indicator', async () => {
    const fixture = createWorkspaceFixture('clear-unread')
    const { app, window } = await launchApp()

    try {
      const { ws1Id } = await setupTwoWorkspaces(window, fixture)
      await window.waitForTimeout(700)
      writeSignalFile(ws1Id)

      await window.waitForFunction(
        (workspaceId: string) => (window as any).__store.getState().unreadWorkspaceIds.has(workspaceId),
        ws1Id,
        { timeout: 7000 },
      )

      await window.evaluate((workspaceId: string) => {
        ;(window as any).__store.getState().setActiveWorkspace(workspaceId)
      }, ws1Id)

      await window.waitForFunction(
        (workspaceId: string) => !(window as any).__store.getState().unreadWorkspaceIds.has(workspaceId),
        ws1Id,
        { timeout: 5000 },
      )
    } finally {
      await app.close()
    }
  })

  test('notification for active workspace does not show unread indicator', async () => {
    const fixture = createWorkspaceFixture('active-no-unread')
    const { app, window } = await launchApp()

    try {
      const { ws2Id } = await setupTwoWorkspaces(window, fixture)
      await window.waitForTimeout(700)

      writeSignalFile(ws2Id)
      await window.waitForTimeout(1500)

      const hasUnread = await window.evaluate((workspaceId: string) => {
        return (window as any).__store.getState().unreadWorkspaceIds.has(workspaceId)
      }, ws2Id)
      expect(hasUnread).toBe(false)
    } finally {
      await app.close()
    }
  })
})
