import { useAppStore } from '../store/app-store'
import type { Toast, Workspace } from '../store/types'

interface RouteTemplateToChatOptions {
  workspace?: Workspace
  templateName: string
  expandedPrompt: string
  focusOrCreateChat: () => Promise<void>
  addToast: (toast: Toast) => void
}

interface ChatInsertEventDetail {
  threadId: string
  prompt: string
}

const pendingPromptInsertsByThread = new Map<string, string[]>()

function queuePromptInsert(detail: ChatInsertEventDetail): void {
  const queue = pendingPromptInsertsByThread.get(detail.threadId) ?? []
  queue.push(detail.prompt)
  pendingPromptInsertsByThread.set(detail.threadId, queue)
}

export function queuePromptInsertForThread(threadId: string, prompt: string): void {
  queuePromptInsert({ threadId, prompt })
}

export function consumeQueuedPromptInserts(threadId: string): string[] {
  const queue = pendingPromptInsertsByThread.get(threadId) ?? []
  pendingPromptInsertsByThread.delete(threadId)
  return queue
}

function dispatchInsertPrompt(detail: ChatInsertEventDetail): void {
  window.dispatchEvent(new CustomEvent<ChatInsertEventDetail>('chat:insertPrompt', { detail }))
}

export function dispatchPromptInsertForThread(threadId: string, prompt: string): void {
  dispatchInsertPrompt({ threadId, prompt })
}

export async function routeExpandedTemplateToChat(options: RouteTemplateToChatOptions): Promise<void> {
  const { workspace, templateName, expandedPrompt, focusOrCreateChat, addToast } = options
  const trimmed = expandedPrompt.trim()

  if (!trimmed) {
    addToast({
      id: crypto.randomUUID(),
      message: `Template "${templateName}" expanded to empty text`,
      type: 'info',
    })
    return
  }

  if (workspace) {
    const stateBeforeFocus = useAppStore.getState()
    if (stateBeforeFocus.activeWorkspaceId !== workspace.id) {
      stateBeforeFocus.setActiveWorkspace(workspace.id)
    }
    const hadWorkspaceChatBefore = stateBeforeFocus.tabs.some(
      (tab) => tab.type === 'chat' && tab.workspaceId === workspace.id,
    )

    await focusOrCreateChat()

    const state = useAppStore.getState()
    const workspaceChatTabs = state.tabs.filter(
      (tab) => tab.type === 'chat' && tab.workspaceId === workspace.id,
    )
    const activeWorkspaceChat = workspaceChatTabs.find((tab) => tab.id === state.activeTabId)
    const targetChatTab = activeWorkspaceChat ?? workspaceChatTabs[0]

    if (targetChatTab?.type === 'chat') {
      // If chat was created just now, queue prompt so it still applies after mount.
      if (!hadWorkspaceChatBefore) {
        queuePromptInsert({ threadId: targetChatTab.threadId, prompt: expandedPrompt })
      }

      state.setActiveTab(targetChatTab.id)
      dispatchInsertPrompt({ threadId: targetChatTab.threadId, prompt: expandedPrompt })
      addToast({
        id: crypto.randomUUID(),
        message: `Template "${templateName}" inserted into chat`,
        type: 'success',
      })
      return
    }
  }

  await window.api.clipboard.writeText(expandedPrompt)
  addToast({
    id: crypto.randomUUID(),
    message: `Template "${templateName}" copied to clipboard`,
    type: 'info',
  })
}
