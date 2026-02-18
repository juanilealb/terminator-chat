import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
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
  await window.waitForSelector('#root', { timeout: 30000 })
  await window.waitForTimeout(1200)
  return { app, window }
}

async function installInputSmokeMockBackend(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const randomUUID = () => globalThis.crypto.randomUUID()
    const IPC = {
      CHAT_LOGIN: 'chat:login',
      CHAT_LOGOUT: 'chat:logout',
      CHAT_AUTH_STATUS: 'chat:auth-status',
      CHAT_LIST_MODELS: 'chat:list-models',
      CHAT_CREATE_THREAD: 'chat:create-thread',
      CHAT_SEND: 'chat:send',
      CHAT_CANCEL: 'chat:cancel',
      CHAT_DESTROY_THREAD: 'chat:destroy-thread',
      CHAT_RESUME: 'chat:resume',
      CHAT_EVENT: 'chat:event',
    } as const

    const turnSeqByThread = new Map<string, number>()
    const pendingTimers = new Map<string, NodeJS.Timeout[]>()

    const emit = (
      sender: { send: (channel: string, payload: unknown) => void },
      threadId: string,
      turnId: string,
      type: string,
      phase: string,
      data: unknown,
    ) => {
      sender.send(IPC.CHAT_EVENT, {
        eventId: randomUUID(),
        eventVersion: 'sdk-0.101.0',
        threadId,
        turnId,
        type,
        phase,
        ts: Date.now(),
        data,
      })
    }

    for (const channel of Object.values(IPC)) {
      ipcMain.removeHandler(channel)
    }

    ipcMain.handle(IPC.CHAT_LOGIN, async () => ({ success: true }))
    ipcMain.handle(IPC.CHAT_LOGOUT, async () => undefined)
    ipcMain.handle(IPC.CHAT_AUTH_STATUS, async () => ({ loggedIn: true }))
    ipcMain.handle(IPC.CHAT_LIST_MODELS, async () => [{ value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }])
    ipcMain.handle(IPC.CHAT_CREATE_THREAD, async () => {
      const id = `mock-thread-${randomUUID()}`
      turnSeqByThread.set(id, 0)
      return id
    })

    ipcMain.handle(IPC.CHAT_SEND, async (event: { sender: { send: (channel: string, payload: unknown) => void } }, threadId: string, input: unknown) => {
      const next = (turnSeqByThread.get(threadId) ?? 0) + 1
      turnSeqByThread.set(threadId, next)
      const turnId = `${threadId}:${next}`
      const sender = event.sender
      const text = typeof input === 'string' ? input : ''
      const lower = text.toLowerCase()

      emit(sender, threadId, turnId, 'turn.started', 'turn.started', { type: 'turn.started' })

      if (lower.includes('long')) {
        const timers: NodeJS.Timeout[] = []
        timers.push(setTimeout(() => {
          emit(sender, threadId, turnId, 'item.completed', 'item.delta', {
            type: 'agent_message',
            id: `agent-${randomUUID()}`,
            text: `Done: ${text}`,
          })
          emit(sender, threadId, turnId, 'turn.completed', 'turn.completed', {
            type: 'turn.completed',
            usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 },
          })
        }, 1500))
        pendingTimers.set(threadId, timers)
      } else {
        emit(sender, threadId, turnId, 'item.completed', 'item.delta', {
          type: 'agent_message',
          id: `agent-${randomUUID()}`,
          text: `Done: ${text}`,
        })
        emit(sender, threadId, turnId, 'turn.completed', 'turn.completed', {
          type: 'turn.completed',
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 },
        })
      }

      return { accepted: true, turnId }
    })

    ipcMain.handle(IPC.CHAT_CANCEL, async (_event: unknown, threadId: string) => {
      const timers = pendingTimers.get(threadId)
      if (timers) {
        for (const timer of timers) clearTimeout(timer)
      }
      pendingTimers.delete(threadId)
    })
    ipcMain.handle(IPC.CHAT_DESTROY_THREAD, async () => undefined)
    ipcMain.handle(IPC.CHAT_RESUME, async () => true)
  })
}

async function setupChatWorkspace(window: Page): Promise<void> {
  const base = join(tmpdir(), `tc-chat-input-smoke-${Date.now()}`)
  const repoPath = join(base, 'repo')
  const worktreePath = join(base, 'ws')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })

  await window.evaluate(async ({ rp, wp }) => {
    const store = (window as any).__store.getState()
    store.hydrateState({ projects: [], workspaces: [], tabs: [] })
    store.setCodexLoggedIn(true)

    const projectId = crypto.randomUUID()
    const workspaceId = crypto.randomUUID()
    const threadId = crypto.randomUUID()
    const tabId = crypto.randomUUID()

    store.addProject({ id: projectId, name: 'input-smoke-repo', repoPath: rp, ownership: 'personal' })
    store.addWorkspace({
      id: workspaceId,
      name: 'input-smoke-ws',
      type: 'feature',
      branch: 'feature/input-smoke',
      worktreePath: wp,
      projectId,
      agentPermissionMode: 'default',
      memory: '',
    })
    store.addTab({
      id: tabId,
      workspaceId,
      type: 'chat',
      title: 'Input smoke',
      threadId,
    })
    store.setActiveWorkspace(workspaceId)
    store.setActiveTab(tabId)
  }, { rp: repoPath, wp: worktreePath })
}

test.describe('Chat input smoke', () => {
  test('Enter submits and clears composer', async () => {
    const { app, window } = await launchApp()
    try {
      await installInputSmokeMockBackend(app)
      await setupChatWorkspace(window)

      const input = window.locator('textarea[placeholder="Ask the agent..."]').first()
      await expect(input).toBeVisible()

      await input.fill('hello smoke')
      await window.keyboard.press('Enter')

      await expect(input).toHaveValue('')
      await expect(window.locator('text=Done: hello smoke')).toBeVisible({ timeout: 10000 })
    } finally {
      await app.close()
    }
  })

  test('while running, Enter queues next prompt', async () => {
    const { app, window } = await launchApp()
    try {
      await installInputSmokeMockBackend(app)
      await setupChatWorkspace(window)

      const input = window.locator('textarea[placeholder="Ask the agent..."]').first()
      await input.fill('long task for queue')
      await window.keyboard.press('Enter')

      await expect(window.locator('[aria-label="Thinking"]')).toBeVisible({ timeout: 10000 })

      await input.fill('queued follow up')
      await window.keyboard.press('Enter')

      await expect(window.locator('[class*="_queueBarText_"]')).toContainText('queued follow up')
      await expect(window.locator('text=Done: long task for queue')).toBeVisible({ timeout: 12000 })
      await expect(window.locator('text=Done: queued follow up')).toBeVisible({ timeout: 12000 })
    } finally {
      await app.close()
    }
  })
})

