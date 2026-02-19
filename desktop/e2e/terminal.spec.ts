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
  await window.waitForSelector('#root', { timeout: 20000 })
  await window.waitForTimeout(1000)
  return { app, window }
}

async function installCommandMockBackend(app: ElectronApplication): Promise<void> {
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

    for (const channel of Object.values(IPC)) {
      ipcMain.removeHandler(channel)
    }

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

      const command = lower.includes('wrapped')
        ? '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Select-String -Path README.md -Pattern test"'
        : 'pnpm test --filter smoke'

      if (lower.includes('many')) {
        for (let i = 0; i < 12; i += 1) {
          emit(sender, threadId, turnId, 'item.completed', 'item.delta', {
            type: 'command_execution',
            id: `cmd-${randomUUID()}`,
            command: `echo cmd-${i}`,
            aggregated_output: `output-${i}`,
            exit_code: 0,
            status: 'completed',
          })
        }
      } else if (lower.includes('fail')) {
        emit(sender, threadId, turnId, 'item.completed', 'item.delta', {
          type: 'command_execution',
          id: `cmd-${randomUUID()}`,
          command,
          aggregated_output: 'mock terminal output: failed command',
          exit_code: 1,
          status: 'failed',
        })
      } else {
        emit(sender, threadId, turnId, 'item.completed', 'item.delta', {
          type: 'command_execution',
          id: `cmd-${randomUUID()}`,
          command,
          aggregated_output: 'mock terminal output: tests running and passing',
          exit_code: 0,
          status: 'completed',
        })
      }

      emit(sender, threadId, turnId, 'turn.completed', 'turn.completed', {
        type: 'turn.completed',
        usage: { input_tokens: 30, cached_input_tokens: 0, output_tokens: 20 },
      })

      return { accepted: true, turnId }
    })

    ipcMain.handle(IPC.CHAT_CANCEL, async () => undefined)
    ipcMain.handle(IPC.CHAT_DESTROY_THREAD, async () => undefined)
    ipcMain.handle(IPC.CHAT_RESUME, async () => true)
  })
}

async function setupChatWorkspace(window: Page): Promise<void> {
  const base = join(tmpdir(), `tc-terminal-chat-${Date.now()}`)
  const repoPath = join(base, 'repo')
  const worktreePath = join(base, 'ws-1')
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

    store.addProject({ id: projectId, name: 'terminal-mock-repo', repoPath: rp, ownership: 'personal' })
    store.addWorkspace({
      id: workspaceId,
      name: 'terminal-mock-ws',
      type: 'feature',
      branch: 'feature/terminal-mock',
      worktreePath: wp,
      projectId,
      agentPermissionMode: 'default',
      memory: '',
    })
    store.addTab({
      id: tabId,
      workspaceId,
      type: 'chat',
      title: 'Terminal through chat',
      threadId,
    })
    store.setActiveWorkspace(workspaceId)
    store.setActiveTab(tabId)
  }, { rp: repoPath, wp: worktreePath })
}

test.describe('Terminal-like command flow in chat', () => {
  test('renders command output for successful execution', async () => {
    const { app, window } = await launchApp()
    try {
      await installCommandMockBackend(app)
      await setupChatWorkspace(window)

      const input = window.locator('textarea[placeholder="Ask the agent..."]').first()
      await expect(input).toBeVisible()
      await input.fill('run command success')
      await window.keyboard.press('Enter')

      await expect
        .poll(async () => await window.locator('text=pnpm test --filter smoke').count(), { timeout: 10000 })
        .toBeGreaterThan(0)
      await expect
        .poll(async () => await window.locator('text=mock terminal output: tests running and passing').count(), { timeout: 10000 })
        .toBeGreaterThan(0)
      await expect
        .poll(async () => await window.locator('text=exit 0').count(), { timeout: 10000 })
        .toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })

  test('renders failed command status and exit code', async () => {
    const { app, window } = await launchApp()
    try {
      await installCommandMockBackend(app)
      await setupChatWorkspace(window)

      const input = window.locator('textarea[placeholder="Ask the agent..."]').first()
      await input.fill('run command fail')
      await window.keyboard.press('Enter')

      await expect
        .poll(async () => await window.locator('text=mock terminal output: failed command').count(), { timeout: 10000 })
        .toBeGreaterThan(0)
      await expect
        .poll(async () => await window.locator('text=Failed').count(), { timeout: 10000 })
        .toBeGreaterThan(0)
      await expect
        .poll(async () => await window.locator('text=exit 1').count(), { timeout: 10000 })
        .toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })

  test('caps timeline and shows earlier command toggle after 10+', async () => {
    const { app, window } = await launchApp()
    try {
      await installCommandMockBackend(app)
      await setupChatWorkspace(window)

      const input = window.locator('textarea[placeholder="Ask the agent..."]').first()
      await input.fill('run many commands')
      await window.keyboard.press('Enter')

      await expect(window.locator('button:has-text("Show 2 earlier")')).toBeVisible({ timeout: 10000 })
    } finally {
      await app.close()
    }
  })
})

