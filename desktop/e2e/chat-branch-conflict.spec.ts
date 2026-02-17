import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync } from 'fs'
import { tmpdir } from 'os'

const appPath = resolve(__dirname, '../out/main/index.js')

async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [appPath],
    env: { ...process.env, CI_TEST: '1' },
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 15000 })
  await window.waitForTimeout(1000)
  return { app, window }
}

function createWorkspaceFixture(name: string): {
  repoPath: string
  wsPath: string
} {
  const base = join(tmpdir(), `tc-chat-conflict-${name}-${Date.now()}`)
  const repoPath = join(base, 'repo')
  const wsPath = join(base, 'ws-1')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(wsPath, { recursive: true })
  return { repoPath, wsPath }
}

test.describe('Chat branch conflict lock', () => {
  test('shows conflict dialog when another thread is active on same branch', async () => {
    const fixture = createWorkspaceFixture('same-branch')
    const { app, window } = await launchApp()

    try {
      const targetThreadId = await window.evaluate(async ({ repoPath, wsPath }) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [], tabs: [] })
        store.setCodexLoggedIn(true)

        const projectId = crypto.randomUUID()
        const workspaceId = crypto.randomUUID()
        const activeThreadId = crypto.randomUUID()
        const targetThreadId = crypto.randomUUID()

        store.addProject({
          id: projectId,
          name: 'conflict-project',
          repoPath,
          ownership: 'personal',
        })

        store.addWorkspace({
          id: workspaceId,
          name: 'ws-conflict',
          type: 'feature',
          branch: 'feature/conflict-test',
          worktreePath: wsPath,
          projectId,
          agentPermissionMode: 'default',
          memory: '',
        })

        const activeTabId = crypto.randomUUID()
        store.addTab({
          id: activeTabId,
          workspaceId,
          type: 'chat',
          title: 'Thread 1',
          threadId: activeThreadId,
        })

        const targetTabId = crypto.randomUUID()
        store.addTab({
          id: targetTabId,
          workspaceId,
          type: 'chat',
          title: 'Thread 2',
          threadId: targetThreadId,
        })

        store.setActiveWorkspace(workspaceId)
        store.setActiveTab(targetTabId)
        store.setChatThreadAgentStatus(workspaceId, activeThreadId, 'running')

        return targetThreadId
      }, fixture)

      const input = window.locator('textarea[placeholder="Ask the agent..."]:visible').first()
      await expect(input).toBeVisible()
      await input.fill('Test conflict')

      await window.locator('button[title="Send message"]:not([disabled])').first().click()

      await expect(window.locator('text=Branch is busy')).toBeVisible()
      await expect(window.locator('button:has-text("Keep read-only")')).toBeVisible()
      await expect(window.locator('button:has-text("Create isolated branch")')).toBeVisible()
      await expect(window.locator('button:has-text("Take control")')).toBeVisible()

      await window.locator('button:has-text("Keep read-only")').click()
      await expect(window.locator('text=Branch is busy')).not.toBeVisible()

      const messageCount = await window.evaluate((threadId: string) => {
        const state = (window as any).__store.getState()
        return (state.chatMessages[threadId] ?? []).length
      }, targetThreadId)
      expect(messageCount).toBe(0)
    } finally {
      await app.close()
    }
  })
})
