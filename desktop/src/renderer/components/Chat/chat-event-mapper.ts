import type { ChatEventData } from '../../../shared/ipc-channels'
import type { ChatMessage } from '../../store/types'

interface MapChatEventToMessageInput {
  data: ChatEventData
  eventType: string
  scopedId: string
  timestamp: number
}

type ItemStatus = 'in_progress' | 'completed' | 'failed'

function normalizeItemStatus(eventType: string, fallback: unknown): ItemStatus {
  if (fallback === 'failed') return 'failed'
  if (eventType === 'item.completed') return 'completed'
  if (fallback === 'completed') return 'completed'
  if (fallback === 'in_progress') return 'in_progress'
  return 'in_progress'
}

function assertNever(value: never): never {
  throw new Error(`Unhandled chat event data variant: ${JSON.stringify(value)}`)
}

export function mapChatEventToMessage(input: MapChatEventToMessageInput): ChatMessage | null {
  const { data, eventType, scopedId, timestamp } = input

  switch (data.type) {
    case 'thread.started':
    case 'turn.started':
      return null
    case 'turn.waiting_input':
      return {
        id: scopedId,
        role: 'system',
        content: 'Waiting for your input',
        type: 'text',
        timestamp,
        metadata: {
          lifecycle: data.type,
        },
      }
    case 'turn.completed':
      return {
        id: scopedId,
        role: 'system',
        content: 'Turn completed',
        type: 'text',
        timestamp,
        metadata: {
          lifecycle: data.type,
          usage: data.usage,
        },
      }
    case 'turn.cancelled':
      return {
        id: scopedId,
        role: 'system',
        content: 'Request cancelled',
        type: 'text',
        timestamp,
        metadata: {
          lifecycle: data.type,
        },
      }
    case 'turn.failed':
      return {
        id: scopedId,
        role: 'system',
        content: data.message,
        type: 'text',
        timestamp,
        metadata: {
          error: true,
          lifecycle: data.type,
        },
      }
    case 'agent_message':
      return {
        id: scopedId,
        role: 'assistant',
        content: data.text,
        type: 'text',
        timestamp,
      }
    case 'command_execution':
      return {
        id: scopedId,
        role: 'assistant',
        content: data.command,
        type: 'command',
        timestamp,
        metadata: {
          command: data.command,
          aggregated_output: data.aggregated_output,
          exit_code: data.exit_code,
          status: normalizeItemStatus(eventType, data.status),
        },
      }
    case 'file_change':
      return {
        id: scopedId,
        role: 'assistant',
        content: 'File changes',
        type: 'file-change',
        timestamp,
        metadata: {
          changes: data.changes,
          status: normalizeItemStatus(eventType, data.status),
        },
      }
    case 'mcp_tool_call':
      return {
        id: scopedId,
        role: 'assistant',
        content: '',
        type: 'tool-call',
        timestamp,
        metadata: {
          tool_name: data.type,
          server: data.server,
          tool: data.tool,
          arguments: data.arguments,
          result: data.result,
          status: normalizeItemStatus(eventType, data.status),
          error: data.error?.message,
        },
      }
    case 'web_search':
      return {
        id: scopedId,
        role: 'assistant',
        content: '',
        type: 'tool-call',
        timestamp,
        metadata: {
          tool_name: data.type,
          query: data.query,
          status: normalizeItemStatus(eventType, undefined),
        },
      }
    case 'todo_list':
      return {
        id: scopedId,
        role: 'assistant',
        content: '',
        type: 'tool-call',
        timestamp,
        metadata: {
          tool_name: data.type,
          item_count: data.items.length,
          completed_count: data.items.filter((item) => item.completed).length,
          status: normalizeItemStatus(eventType, undefined),
          items: data.items,
        },
      }
    case 'reasoning':
      return {
        id: scopedId,
        role: 'assistant',
        content: data.text,
        type: 'reasoning',
        timestamp,
      }
    case 'error':
      return {
        id: scopedId,
        role: 'system',
        content: data.message,
        type: 'text',
        timestamp,
        metadata: { error: true, lifecycle: data.type },
      }
    case 'unknown_item':
      return {
        id: scopedId,
        role: 'assistant',
        content: '',
        type: 'tool-call',
        timestamp,
        metadata: {
          tool_name: data.item_type,
          status: normalizeItemStatus(eventType, undefined),
          raw: data.raw,
        },
      }
    case 'unknown_event':
      return {
        id: scopedId,
        role: 'assistant',
        content: '',
        type: 'tool-call',
        timestamp,
        metadata: {
          tool_name: 'unknown_event',
          status: normalizeItemStatus(eventType, undefined),
          raw: data.raw,
        },
      }
  }

  return assertNever(data)
}
