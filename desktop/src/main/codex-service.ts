import { type BrowserWindow } from 'electron'
import {
  IPC,
  type ChatEventData,
  type ChatEventPayload,
  type ChatLifecyclePhase,
  type ChatThreadItemData,
  type ChatUsage,
} from '../shared/ipc-channels'
import { notifyWorkspace } from './agent-notifier'
import { resolveBundledCodexBinaryPath } from './openai-auth'

// Lazy-import the SDK so that if it fails to load (e.g. on Windows where the
// codex binary may not exist) the rest of the main process still works.
let Codex: any = null
let sdkLoadError: string | null = null

async function ensureSdk(): Promise<void> {
  if (Codex) return
  if (sdkLoadError) throw new Error(sdkLoadError)
  try {
    const mod = await import('@openai/codex-sdk')
    Codex = mod.Codex
  } catch (err) {
    sdkLoadError = err instanceof Error ? err.message : String(err)
    console.error('[CodexService] Failed to load @openai/codex-sdk:', sdkLoadError)
    throw new Error(`Codex SDK failed to load: ${sdkLoadError}`)
  }
}

export type CodexUserInput = string | Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }>
export type CodexThreadOptions = {
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalMode?: 'never' | 'on-request' | 'on-failure' | 'untrusted'
}

interface ThreadContext {
  thread: any
  workspaceId: string | null
  workspaceLabel: string | null
  turnSequence: number
}

export class CodexService {
  private codex: any = null
  private threads = new Map<string, ThreadContext>()
  private abortControllers = new Map<string, AbortController>()
  private pendingCancelThreads = new Set<string>()

  async setAccessToken(token: string | null): Promise<void> {
    if (!token) {
      this.codex = null
      return
    }
    await ensureSdk()
    const codexPathOverride = resolveBundledCodexBinaryPath() ?? undefined
    this.codex = new Codex(codexPathOverride ? { codexPathOverride } : undefined)
  }

  isReady(): boolean {
    return this.codex !== null
  }

  createThread(
    workingDir: string,
    model?: string,
    effort?: string,
    threadOptions?: CodexThreadOptions,
    workspaceId?: string,
    workspaceLabel?: string,
  ): string {
    if (!this.codex) throw new Error('Not logged in. Sign in with your ChatGPT account first.')
    const opts: Record<string, unknown> = {
      workingDirectory: workingDir,
      skipGitRepoCheck: true,
    }
    if (model) opts.model = model
    if (effort) opts.modelReasoningEffort = effort
    if (threadOptions?.sandboxMode) opts.sandboxMode = threadOptions.sandboxMode
    if (threadOptions?.approvalMode) opts.approvalPolicy = threadOptions.approvalMode
    const thread = this.codex.startThread(opts)
    const id = crypto.randomUUID()
    this.threads.set(id, {
      thread,
      workspaceId: workspaceId ?? null,
      workspaceLabel: workspaceLabel?.trim() || null,
      turnSequence: 0,
    })
    return id
  }

  async sendMessage(threadId: string, input: CodexUserInput, win: BrowserWindow): Promise<{ accepted: true; turnId: string }> {
    const context = this.threads.get(threadId)
    if (!context) {
      this.emitEvent(win, {
        threadId,
        type: 'error',
        phase: 'error',
        data: { type: 'error', id: '', message: 'Thread not found' },
      })
      return { accepted: true, turnId: '' }
    }

    const turnId = `${threadId}:${context.turnSequence + 1}`
    context.turnSequence += 1
    this.emitEvent(win, {
      threadId,
      workspaceId: context.workspaceId ?? undefined,
      turnId,
      type: 'turn.started',
      phase: 'turn.started',
      data: { type: 'turn.started' },
    })

    // Fire-and-forget streaming so the IPC invoke resolves immediately.
    void this.runTurn(context, threadId, turnId, input, win)

    return { accepted: true, turnId }
  }

  private async runTurn(
    context: ThreadContext,
    threadId: string,
    turnId: string,
    input: CodexUserInput,
    win: BrowserWindow,
  ): Promise<void> {
    const { thread, workspaceId, workspaceLabel } = context
    const normalizedWorkspaceId = workspaceId ?? undefined
    const waitingNotified = { value: false }
    let emittedTerminalPhase = false

    const emitTerminalPhase = (type: 'turn.completed' | 'turn.failed' | 'turn.cancelled', data: ChatEventData) => {
      if (emittedTerminalPhase) return
      emittedTerminalPhase = true
      this.emitEvent(win, {
        threadId,
        workspaceId: normalizedWorkspaceId,
        turnId,
        type,
        phase: type,
        data,
      })

      if (!workspaceId) return
      if (type === 'turn.completed') {
        notifyWorkspace(workspaceId, 'completed', { turnId, source: 'chat', workspaceLabel: workspaceLabel ?? undefined })
      }
    }

    const emitWaitingInput = () => {
      if (!workspaceId || waitingNotified.value) return
      waitingNotified.value = true
      this.emitEvent(win, {
        threadId,
        workspaceId: normalizedWorkspaceId,
        turnId,
        type: 'turn.waiting_input',
        phase: 'turn.waiting_input',
        data: { type: 'turn.waiting_input' },
      })
      notifyWorkspace(workspaceId, 'waiting_input', { turnId, source: 'chat', workspaceLabel: workspaceLabel ?? undefined })
    }

    const controller = new AbortController()
    this.abortControllers.set(threadId, controller)
    if (this.pendingCancelThreads.has(threadId)) {
      controller.abort()
      this.pendingCancelThreads.delete(threadId)
    }

    try {
      const { events } = await thread.runStreamed(input, { signal: controller.signal })
      for await (const event of events) {
        if (controller.signal.aborted) {
          emitTerminalPhase('turn.cancelled', { type: 'turn.cancelled' })
          break
        }
        if (win.isDestroyed()) break

        const serialized = serializeEvent(event)
        if (event.type === 'turn.completed') {
          emitTerminalPhase('turn.completed', serialized)
          continue
        }
        if (event.type === 'turn.failed' || event.type === 'error') {
          emitTerminalPhase('turn.failed', serialized)
          continue
        }
        if (event.type === 'turn.started') {
          continue
        }

        this.emitEvent(win, {
          threadId,
          workspaceId: normalizedWorkspaceId,
          turnId,
          type: event.type,
          phase: mapPhase(event.type),
          data: serialized,
        })

        if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
          if (looksLikeWaitingInput(serialized)) {
            emitWaitingInput()
          }
        }
      }

      if (controller.signal.aborted) {
        emitTerminalPhase('turn.cancelled', { type: 'turn.cancelled' })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      if (controller.signal.aborted) {
        emitTerminalPhase('turn.cancelled', { type: 'turn.cancelled' })
      } else {
        emitTerminalPhase('turn.failed', { type: 'turn.failed', message })
      }
    } finally {
      this.abortControllers.delete(threadId)
      this.pendingCancelThreads.delete(threadId)
    }
  }

  private emitEvent(
    win: BrowserWindow,
    payload: {
      threadId: string
      type: string
      phase: ChatLifecyclePhase
      data: ChatEventData
      workspaceId?: string
      turnId?: string
    },
  ): void {
    if (win.isDestroyed()) return
    const event: ChatEventPayload = {
      eventId: crypto.randomUUID(),
      eventVersion: 'sdk-0.101.0',
      ts: Date.now(),
      threadId: payload.threadId,
      workspaceId: payload.workspaceId,
      turnId: payload.turnId,
      type: payload.type,
      phase: payload.phase,
      data: payload.data,
    }
    win.webContents.send(IPC.CHAT_EVENT, event)
  }

  cancelTurn(threadId: string): void {
    const controller = this.abortControllers.get(threadId)
    if (controller) {
      controller.abort()
      this.abortControllers.delete(threadId)
      this.pendingCancelThreads.delete(threadId)
      return
    }
    // If cancel arrives before the turn registers its controller, remember it
    // and abort as soon as sendMessage starts.
    this.pendingCancelThreads.add(threadId)
  }

  resumeThread(threadId: string): boolean {
    return this.threads.has(threadId)
  }

  destroyThread(threadId: string): void {
    const controller = this.abortControllers.get(threadId)
    if (controller) controller.abort()
    this.abortControllers.delete(threadId)
    this.pendingCancelThreads.delete(threadId)
    this.threads.delete(threadId)
  }
}

function mapPhase(type: string): ChatLifecyclePhase {
  if (type === 'turn.started') return 'turn.started'
  if (type === 'turn.completed') return 'turn.completed'
  if (type === 'turn.failed') return 'turn.failed'
  if (type === 'error') return 'error'
  if (type === 'thread.started') return 'thread.started'
  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') return 'item.delta'
  return 'unknown'
}

function serializeEvent(event: any): ChatEventData {
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return serializeItem(event.item)
    case 'turn.completed':
      return { type: 'turn.completed', usage: toChatUsage(event.usage) }
    case 'turn.failed':
      return { type: 'turn.failed', message: toStringOrFallback(event?.error?.message, 'Turn failed') }
    case 'thread.started':
      return { type: 'thread.started', thread_id: toStringOrFallback(event.thread_id, '') }
    case 'turn.started':
      return { type: 'turn.started' }
    case 'error':
      return { type: 'error', message: toStringOrFallback(event.message, 'Unknown error') }
    default:
      return {
        type: 'unknown_event',
        raw: ensureRecord(event, { type: 'unknown_event' }),
      }
  }
}

function looksLikeWaitingInput(data: ChatEventData): boolean {
  if (data.type !== 'agent_message') return false
  const text = data.text.trim()
  if (!text) return false
  if (/^question\s+\d+\/\d+/i.test(text)) return true
  if (/tab to add notes|enter to submit answer|esc to interrupt/i.test(text)) return true
  return false
}

function serializeItem(item: any): ChatThreadItemData {
  switch (item.type) {
    case 'agent_message':
      return {
        type: 'agent_message',
        id: toStringOrFallback(item.id, ''),
        text: toStringOrFallback(item.text, ''),
      }
    case 'reasoning':
      return {
        type: 'reasoning',
        id: toStringOrFallback(item.id, ''),
        text: toStringOrFallback(item.text, ''),
      }
    case 'command_execution':
      return {
        type: 'command_execution',
        id: toStringOrFallback(item.id, ''),
        command: toStringOrFallback(item.command, ''),
        aggregated_output: toStringOrFallback(item.aggregated_output, ''),
        exit_code: typeof item.exit_code === 'number' ? item.exit_code : undefined,
        status: item.status === 'completed' || item.status === 'failed' ? item.status : 'in_progress',
      }
    case 'file_change':
      return {
        type: 'file_change',
        id: toStringOrFallback(item.id, ''),
        changes: normalizeFileChanges(item.changes),
        status: item.status === 'failed' ? 'failed' : 'completed',
      }
    case 'mcp_tool_call':
      return {
        type: 'mcp_tool_call',
        id: toStringOrFallback(item.id, ''),
        server: toStringOrFallback(item.server, ''),
        tool: toStringOrFallback(item.tool, ''),
        arguments: item.arguments,
        result: normalizeMcpResult(item.result),
        error: normalizeMcpError(item.error),
        status: item.status === 'completed' || item.status === 'failed' ? item.status : 'in_progress',
      }
    case 'web_search':
      return {
        type: 'web_search',
        id: toStringOrFallback(item.id, ''),
        query: toStringOrFallback(item.query, ''),
      }
    case 'todo_list':
      return {
        type: 'todo_list',
        id: toStringOrFallback(item.id, ''),
        items: normalizeTodoItems(item.items),
      }
    case 'error':
      return {
        type: 'error',
        id: toStringOrFallback(item.id, ''),
        message: toStringOrFallback(item.message, 'Unknown item error'),
      }
    default:
      return {
        type: 'unknown_item',
        id: toStringOrFallback(item?.id, ''),
        item_type: toStringOrFallback(item?.type, 'unknown'),
        raw: ensureRecord(item, { type: 'unknown_item' }),
      }
  }
}

function ensureRecord(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  if (value && typeof value === 'object') {
    try {
      const parsed = JSON.parse(JSON.stringify(value))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Fall through to fallback
    }
  }
  return fallback
}

function toStringOrFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function toChatUsage(value: unknown): ChatUsage {
  const raw = ensureRecord(value, {})
  return {
    input_tokens: typeof raw.input_tokens === 'number' ? raw.input_tokens : 0,
    cached_input_tokens: typeof raw.cached_input_tokens === 'number' ? raw.cached_input_tokens : 0,
    output_tokens: typeof raw.output_tokens === 'number' ? raw.output_tokens : 0,
  }
}

function normalizeFileChanges(value: unknown): Array<{ path: string; kind: 'add' | 'delete' | 'update' }> {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      const record = ensureRecord(entry, {})
      const path = toStringOrFallback(record.path, '')
      const kind = record.kind === 'add' || record.kind === 'delete' ? record.kind : 'update'
      if (!path) return null
      return { path, kind }
    })
    .filter((entry): entry is { path: string; kind: 'add' | 'delete' | 'update' } => entry !== null)
}

function normalizeTodoItems(value: unknown): Array<{ text: string; completed: boolean }> {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      const record = ensureRecord(entry, {})
      const text = toStringOrFallback(record.text, '').trim()
      if (!text) return null
      return { text, completed: record.completed === true }
    })
    .filter((entry): entry is { text: string; completed: boolean } => entry !== null)
}

function normalizeMcpResult(value: unknown): { content: unknown[]; structured_content: unknown } | undefined {
  const record = ensureRecord(value, {})
  if (Object.keys(record).length === 0) return undefined
  const content = Array.isArray(record.content) ? record.content : []
  return {
    content,
    structured_content: record.structured_content,
  }
}

function normalizeMcpError(value: unknown): { message: string } | undefined {
  const record = ensureRecord(value, {})
  const message = toStringOrFallback(record.message, '').trim()
  if (!message) return undefined
  return { message }
}
