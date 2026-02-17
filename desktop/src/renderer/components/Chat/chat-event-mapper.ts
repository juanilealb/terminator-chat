import type { ChatEventData } from '../../../shared/ipc-channels'
import type { ChatMessage } from '../../store/types'

interface MapChatEventToMessageInput {
  data: ChatEventData
  eventType: string
  scopedId: string
  timestamp: number
}

export function mapChatEventToMessage(input: MapChatEventToMessageInput): ChatMessage | null {
  const { data, eventType, scopedId, timestamp } = input

  switch (data.type) {
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
          status: data.status,
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
          status: data.status,
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
          status: data.status,
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
          status: eventType === 'item.completed' ? 'completed' : 'in_progress',
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
          status: eventType === 'item.completed' ? 'completed' : 'in_progress',
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
        metadata: { error: true },
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
          status: eventType === 'item.completed' ? 'completed' : 'in_progress',
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
          status: 'in_progress',
          raw: data.raw,
        },
      }
    default:
      return null
  }
}
