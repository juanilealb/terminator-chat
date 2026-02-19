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
  await window.waitForTimeout(1200)
  return { app, window }
}

async function installMockChatBackend(app: ElectronApplication): Promise<void> {
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

    interface PendingTurn {
      turnId: string
      sender: {
        send: (channel: string, payload: unknown) => void
      }
      timerIds: NodeJS.Timeout[]
      completed: boolean
    }

    const threadTurns = new Map<string, number>()
    const pendingTurns = new Map<string, PendingTurn>()

    const emit = (
      sender: Electron.WebContents,
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

    const clearPending = (threadId: string) => {
      const pending = pendingTurns.get(threadId)
      if (!pending) return
      for (const timerId of pending.timerIds) {
        clearTimeout(timerId)
      }
      pendingTurns.delete(threadId)
    }

    for (const channel of Object.values(IPC)) {
      ipcMain.removeHandler(channel)
    }

    ipcMain.handle(IPC.CHAT_LOGIN, async () => ({ success: true }))
    ipcMain.handle(IPC.CHAT_LOGOUT, async () => undefined)
    ipcMain.handle(IPC.CHAT_AUTH_STATUS, async () => ({ loggedIn: true }))
    ipcMain.handle(IPC.CHAT_LIST_MODELS, async () => [
      { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
      { value: 'gpt-5.3-codex-spark', label: 'gpt-5.3-codex-spark' },
    ])

    ipcMain.handle(IPC.CHAT_CREATE_THREAD, async () => {
      const threadId = `mock-thread-${randomUUID()}`
      threadTurns.set(threadId, 0)
      return threadId
    })

    ipcMain.handle(IPC.CHAT_SEND, async (event: { sender: { send: (channel: string, payload: unknown) => void } }, threadId: string, input: unknown) => {
      const currentTurn = (threadTurns.get(threadId) ?? 0) + 1
      threadTurns.set(threadId, currentTurn)
      const turnId = `${threadId}:${currentTurn}`

      clearPending(threadId)

      const sender = event.sender
      emit(sender, threadId, turnId, 'turn.started', 'turn.started', { type: 'turn.started' })

      const pending: PendingTurn = {
        turnId,
        sender,
        timerIds: [],
        completed: false,
      }
      pendingTurns.set(threadId, pending)

      const textInput = typeof input === 'string'
        ? input
        : Array.isArray(input)
          ? input
            .map((item) => {
              if (!item || typeof item !== 'object') return ''
              const text = (item as { text?: unknown }).text
              return typeof text === 'string' ? text : ''
            })
            .filter(Boolean)
            .join('\n')
          : ''
      const normalized = textInput.toLowerCase()

      const safeEmit = (type: string, phase: string, data: unknown) => {
        const latest = pendingTurns.get(threadId)
        if (!latest || latest.turnId !== turnId || latest.completed) return
        emit(sender, threadId, turnId, type, phase, data)
      }

      const completeTurn = (assistantText: string) => {
        const latest = pendingTurns.get(threadId)
        if (!latest || latest.turnId !== turnId || latest.completed) return
        safeEmit('item.completed', 'item.delta', {
          type: 'agent_message',
          id: `agent-${randomUUID()}`,
          text: assistantText,
        })
        safeEmit('turn.completed', 'turn.completed', {
          type: 'turn.completed',
          usage: {
            input_tokens: 120,
            cached_input_tokens: 0,
            output_tokens: 90,
          },
        })
        latest.completed = true
        pendingTurns.delete(threadId)
      }

      const completeTurnWithoutAssistant = () => {
        const latest = pendingTurns.get(threadId)
        if (!latest || latest.turnId !== turnId || latest.completed) return
        safeEmit('turn.completed', 'turn.completed', {
          type: 'turn.completed',
          usage: {
            input_tokens: 120,
            cached_input_tokens: 0,
            output_tokens: 0,
          },
        })
        latest.completed = true
        pendingTurns.delete(threadId)
      }

      if (normalized.includes('long task')) {
        pending.timerIds.push(setTimeout(() => {
          safeEmit('item.started', 'item.delta', {
            type: 'command_execution',
            id: `cmd-${randomUUID()}`,
            command: 'pnpm test --filter smoke',
            aggregated_output: '',
            status: 'in_progress',
          })
        }, 100))

        pending.timerIds.push(setTimeout(() => {
          safeEmit('item.completed', 'item.delta', {
            type: 'command_execution',
            id: `cmd-${randomUUID()}`,
            command: 'pnpm test --filter smoke',
            aggregated_output: 'mock terminal output: tests running and passing',
            exit_code: 0,
            status: 'completed',
          })
          completeTurn(`Done: ${textInput.trim() || 'long task'}`)
        }, 3500))
      } else if (normalized.includes('need question')) {
        pending.timerIds.push(setTimeout(() => {
          safeEmit('item.completed', 'item.delta', {
            type: 'agent_message',
            id: `agent-${randomUUID()}`,
            text: [
              'Question 1/1',
              'How should I continue?',
              '1. Continue',
              '2. Refine plan',
              'Tab to add notes, Enter to submit answer, Esc to interrupt',
            ].join('\n'),
          })
          safeEmit('turn.waiting_input', 'turn.waiting_input', { type: 'turn.waiting_input' })
        }, 140))
      } else if (normalized.includes('empty plan')) {
        pending.timerIds.push(setTimeout(() => {
          completeTurnWithoutAssistant()
        }, 140))
      } else if (normalized.includes('plain question')) {
        pending.timerIds.push(setTimeout(() => {
          completeTurn('Can you confirm the scope?')
        }, 140))
      } else {
        pending.timerIds.push(setTimeout(() => {
          completeTurn(`Done: ${textInput.trim() || 'ok'}`)
        }, 220))
      }

      return { accepted: true, turnId }
    })

    ipcMain.handle(IPC.CHAT_CANCEL, async (_event: unknown, threadId: string) => {
      const pending = pendingTurns.get(threadId)
      if (!pending) return
      for (const timerId of pending.timerIds) {
        clearTimeout(timerId)
      }
      pending.completed = true
      emit(pending.sender, threadId, pending.turnId, 'turn.cancelled', 'turn.cancelled', { type: 'turn.cancelled' })
      pendingTurns.delete(threadId)
    })

    ipcMain.handle(IPC.CHAT_DESTROY_THREAD, async (_event: unknown, threadId: string) => {
      clearPending(threadId)
      threadTurns.delete(threadId)
    })

    ipcMain.handle(IPC.CHAT_RESUME, async () => true)
  })
}

async function setupChatWorkspace(window: Page, repoName: string): Promise<void> {
  const base = join(tmpdir(), `tc-chat-runtime-${repoName}-${Date.now()}`)
  const repoPath = join(base, 'repo')
  const worktreePath = join(base, 'ws-1')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })

  await window.evaluate(async ({ repoPath: rp, worktreePath: wp }) => {
    const store = (window as any).__store.getState()
    store.hydrateState({ projects: [], workspaces: [], tabs: [] })
    store.setCodexLoggedIn(true)

    const projectId = crypto.randomUUID()
    const workspaceId = crypto.randomUUID()
    const threadId = crypto.randomUUID()
    const tabId = crypto.randomUUID()

    store.addProject({
      id: projectId,
      name: 'chat-runtime-repo',
      repoPath: rp,
      ownership: 'personal',
    })

    store.addWorkspace({
      id: workspaceId,
      name: 'chat-runtime-ws',
      type: 'feature',
      branch: 'feature/runtime-check',
      worktreePath: wp,
      projectId,
      agentPermissionMode: 'default',
      memory: '',
    })

    store.addTab({
      id: tabId,
      workspaceId,
      type: 'chat',
      title: 'Runtime thread',
      threadId,
    })

    store.setActiveWorkspace(workspaceId)
    store.setActiveTab(tabId)
  }, { repoPath, worktreePath })
}

test.describe('Chat runtime flows', () => {
  test('queue pauses on question and resumes after answer', async () => {
    const { app, window } = await launchApp()

    try {
      await installMockChatBackend(app)
      await setupChatWorkspace(window, 'queue-question')

      const input = window.locator('textarea[placeholder="Ask the agent..."]').first()
      await expect(input).toBeVisible({ timeout: 20000 })

      await input.fill('long task alpha')
      await window.locator('button[title="Send message"]:not([disabled])').first().click()

      await expect(window.locator('[aria-label="Thinking"]')).toBeVisible({ timeout: 10000 })

      await input.fill('need question')
      await window.keyboard.press('Enter')
      await input.fill('after question')
      await window.keyboard.press('Enter')

      await expect(window.locator('text=How should I continue?')).toBeVisible({ timeout: 15000 })
      await expect(window.locator('[class*="queueBarStatus"]')).toContainText('Waiting for input')
      await expect(window.locator('[class*="_queueBarText_"]')).toContainText('after question')

      await expect
        .poll(async () => await window.locator('text=pnpm test --filter smoke').count(), { timeout: 10000 })
        .toBeGreaterThan(0)
      await expect
        .poll(
          async () => await window.locator('text=mock terminal output: tests running and passing').count(),
          { timeout: 10000 },
        )
        .toBeGreaterThan(0)

      await window.locator('button:has-text("Continue")').first().click()
      await expect(input).toHaveValue('Continue')
      await window.locator('button[title="Send message"]:not([disabled])').first().click()

      await expect(window.locator('text=Done: Continue')).toBeVisible({ timeout: 12000 })
      await expect(window.locator('text=Done: after question')).toBeVisible({ timeout: 12000 })

      await expect(window.locator('[class*="queueBar"]')).toHaveCount(0, { timeout: 12000 })
    } finally {
      await app.close()
    }
  })

  test('send-next-now cancels running turn and executes queued prompt', async () => {
    const { app, window } = await launchApp()

    try {
      await installMockChatBackend(app)
      await setupChatWorkspace(window, 'send-now')

      const input = window.locator('textarea[placeholder="Ask the agent..."]').first()
      await expect(input).toBeVisible({ timeout: 20000 })

      await input.fill('long task beta')
      await window.locator('button[title="Send message"]:not([disabled])').first().click()
      await expect(window.locator('[aria-label="Thinking"]')).toBeVisible({ timeout: 10000 })

      await input.fill('quick after stop')
      await window.keyboard.press('Enter')

      await window.locator('[class*="queueBarSendBtn"]').first().click()

      await expect(window.locator('text=Request cancelled')).toBeVisible({ timeout: 10000 })
      await expect(window.locator('text=Done: quick after stop')).toBeVisible({ timeout: 12000 })
    } finally {
      await app.close()
    }
  })

  test('opening settings does not stop an in-flight turn', async () => {
    const { app, window } = await launchApp()

    try {
      await installMockChatBackend(app)
      await setupChatWorkspace(window, 'settings-inflight')

      const input = window.locator('textarea[placeholder="Ask the agent..."]').first()
      await expect(input).toBeVisible({ timeout: 20000 })

      await input.fill('long task while settings open')
      await window.locator('button[title="Send message"]:not([disabled])').first().click()
      await expect(window.locator('[aria-label="Thinking"]')).toBeVisible({ timeout: 10000 })

      await window.keyboard.press('Control+,')
      await expect(window.locator('button[aria-label="Back to workspace"]')).toBeVisible({ timeout: 5000 })

      await window.waitForTimeout(4200)

      await window.locator('button[aria-label="Back to workspace"]').click()
      await expect(window.getByText('long task while settings open').first()).toBeVisible({ timeout: 12000 })
    } finally {
      await app.close()
    }
  })

  test('plan completion card appears only after real plan content', async () => {
    const { app, window } = await launchApp()

    try {
      await installMockChatBackend(app)
      await setupChatWorkspace(window, 'plan-completion-guard')

      const input = window.locator('textarea[placeholder="Ask the agent..."]').first()
      await expect(input).toBeVisible({ timeout: 20000 })

      await input.click()
      await window.keyboard.down('Shift')
      await window.keyboard.press('Tab')
      await window.keyboard.up('Shift')
      const planInput = window.locator('textarea[placeholder="Ask for a plan... (Shift+Tab to toggle)"]').first()
      await expect(planInput).toBeVisible()

      await planInput.fill('empty plan')
      await window.locator('button[title="Send message"]:not([disabled])').first().click()
      await expect(window.locator('text=The plan is ready. What should I do next?')).toHaveCount(0, { timeout: 4000 })

      await planInput.fill('plain question')
      await window.locator('button[title="Send message"]:not([disabled])').first().click()
      await expect(window.locator('text=Can you confirm the scope?')).toBeVisible({ timeout: 10000 })
      await expect(window.locator('text=The plan is ready. What should I do next?')).toHaveCount(0)

      await planInput.fill('real plan please')
      await window.locator('button[title="Send message"]:not([disabled])').first().click()
      await expect(window.locator('text=Done:')).toBeVisible({ timeout: 10000 })
      await expect(window.locator('text=The plan is ready. What should I do next?')).toBeVisible({ timeout: 10000 })
    } finally {
      await app.close()
    }
  })
})
