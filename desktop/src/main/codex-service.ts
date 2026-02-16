import { type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'

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

export class CodexService {
  private codex: any = null
  private threads = new Map<string, any>()
  private abortControllers = new Map<string, AbortController>()
  private pendingCancelThreads = new Set<string>()

  async setAccessToken(token: string | null): Promise<void> {
    if (!token) {
      this.codex = null
      return
    }
    await ensureSdk()
    this.codex = new Codex()
  }

  isReady(): boolean {
    return this.codex !== null
  }

  createThread(
    workingDir: string,
    model?: string,
    effort?: string,
    threadOptions?: CodexThreadOptions,
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
    this.threads.set(id, thread)
    return id
  }

  async sendMessage(threadId: string, input: CodexUserInput, win: BrowserWindow): Promise<void> {
    const thread = this.threads.get(threadId)
    if (!thread) {
      win.webContents.send(IPC.CHAT_EVENT, {
        threadId,
        type: 'error',
        data: { type: 'error', id: '', message: 'Thread not found' },
      })
      return
    }

    const controller = new AbortController()
    this.abortControllers.set(threadId, controller)
    if (this.pendingCancelThreads.has(threadId)) {
      controller.abort()
      this.pendingCancelThreads.delete(threadId)
    }

    let emittedSyntheticTurnCompleted = false
    const emitTurnCompletedIfNeeded = () => {
      if (emittedSyntheticTurnCompleted || win.isDestroyed()) return
      emittedSyntheticTurnCompleted = true
      win.webContents.send(IPC.CHAT_EVENT, {
        threadId,
        type: 'turn.completed',
        data: { type: 'turn.completed' },
      })
    }

    try {
      const { events } = await thread.runStreamed(input, { signal: controller.signal })
      for await (const event of events) {
        if (controller.signal.aborted) {
          emitTurnCompletedIfNeeded()
          break
        }
        if (win.isDestroyed()) break
        win.webContents.send(IPC.CHAT_EVENT, {
          threadId,
          type: event.type,
          data: serializeEvent(event),
        })
      }
    } catch (err) {
      if (!win.isDestroyed()) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        // Don't report abort as an error
        if (controller.signal.aborted) {
          emitTurnCompletedIfNeeded()
        } else {
          win.webContents.send(IPC.CHAT_EVENT, {
            threadId,
            type: 'error',
            data: { type: 'error', id: '', message },
          })
        }
      }
    } finally {
      this.abortControllers.delete(threadId)
      this.pendingCancelThreads.delete(threadId)
    }
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
    this.threads.delete(threadId)
  }
}

function serializeEvent(event: any): Record<string, unknown> {
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return serializeItem(event.item)
    case 'turn.completed':
      return { type: 'turn.completed', usage: event.usage }
    case 'turn.failed':
      return { type: 'turn.failed', message: event.error.message }
    case 'thread.started':
      return { type: 'thread.started', thread_id: event.thread_id }
    case 'turn.started':
      return { type: 'turn.started' }
    case 'error':
      return { type: 'error', message: event.message }
    default:
      return { type: 'unknown' }
  }
}

function serializeItem(item: any): Record<string, unknown> {
  switch (item.type) {
    case 'agent_message':
      return { type: 'agent_message', id: item.id, text: item.text }
    case 'reasoning':
      return { type: 'reasoning', id: item.id, text: item.text }
    case 'command_execution':
      return {
        type: 'command_execution',
        id: item.id,
        command: item.command,
        aggregated_output: item.aggregated_output,
        exit_code: item.exit_code,
        status: item.status,
      }
    case 'file_change':
      return {
        type: 'file_change',
        id: item.id,
        changes: item.changes,
        status: item.status,
      }
    case 'mcp_tool_call':
      return {
        type: 'mcp_tool_call',
        id: item.id,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status: item.status,
      }
    case 'web_search':
      return {
        type: 'web_search',
        id: item.id,
        query: item.query,
      }
    case 'todo_list':
      return {
        type: 'todo_list',
        id: item.id,
        items: item.items,
      }
    case 'error':
      return { type: 'error', id: item.id, message: item.message }
    default:
      return { type: item.type, id: (item as { id: string }).id }
  }
}
