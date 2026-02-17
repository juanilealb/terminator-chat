import { describe, expect, it } from 'bun:test'
import type { ChatEventData } from '../../../shared/ipc-channels'
import { mapChatEventToMessage } from './chat-event-mapper'

function map(data: ChatEventData, eventType: string = 'item.updated') {
  return mapChatEventToMessage({
    data,
    eventType,
    scopedId: 'test-id',
    timestamp: 123,
  })
}

describe('chat-event-mapper', () => {
  it('returns null for non-rendered lifecycle events', () => {
    expect(map({ type: 'thread.started', thread_id: 'thread-1' }, 'thread.started')).toBeNull()
    expect(map({ type: 'turn.started' }, 'turn.started')).toBeNull()
  })

  it('maps lifecycle cards and errors', () => {
    expect(map({ type: 'turn.waiting_input' }, 'turn.waiting_input')?.metadata?.lifecycle).toBe('turn.waiting_input')
    expect(map({ type: 'turn.cancelled' }, 'turn.cancelled')?.metadata?.lifecycle).toBe('turn.cancelled')
    expect(map({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 2, output_tokens: 3 } }, 'turn.completed')?.metadata?.usage).toEqual({
      input_tokens: 1,
      cached_input_tokens: 2,
      output_tokens: 3,
    })
    expect(map({ type: 'turn.failed', message: 'failed' }, 'turn.failed')?.metadata?.error).toBe(true)
    expect(map({ type: 'error', message: 'error' }, 'error')?.metadata?.error).toBe(true)
  })

  it('maps all supported item payloads', () => {
    expect(map({ type: 'agent_message', id: 'a', text: 'hello' }, 'item.updated')?.type).toBe('text')
    expect(map({ type: 'reasoning', id: 'r', text: 'think' }, 'item.updated')?.type).toBe('reasoning')
    expect(map({
      type: 'command_execution',
      id: 'c',
      command: 'echo ok',
      aggregated_output: 'ok',
      status: 'in_progress',
    }, 'item.completed')?.metadata?.status).toBe('completed')
    expect(map({
      type: 'file_change',
      id: 'f',
      changes: [{ path: 'a.ts', kind: 'update' }],
      status: 'completed',
    }, 'item.updated')?.type).toBe('file-change')
    expect(map({
      type: 'mcp_tool_call',
      id: 'm',
      server: 'fs',
      tool: 'read',
      arguments: { path: 'a.ts' },
      status: 'in_progress',
    }, 'item.completed')?.metadata?.status).toBe('completed')
    expect(map({ type: 'web_search', id: 'w', query: 'codex sdk' }, 'item.started')?.type).toBe('tool-call')
    expect(map({ type: 'todo_list', id: 't', items: [{ text: 'one', completed: false }] }, 'item.completed')?.metadata?.status).toBe('completed')
    expect(map({ type: 'error', id: 'e', message: 'item error' }, 'item.completed')?.metadata?.error).toBe(true)
    expect(map({ type: 'unknown_item', id: 'u', item_type: 'future', raw: { x: 1 } }, 'item.updated')?.type).toBe('tool-call')
    expect(map({ type: 'unknown_event', raw: { x: 1 } }, 'item.completed')?.metadata?.status).toBe('completed')
  })
})
