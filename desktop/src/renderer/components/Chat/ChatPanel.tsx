import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from '@fluentui/react-components'
import { useAppStore } from '../../store/app-store'
import {
  DEFAULT_AGENT_PERMISSION_MODE,
  DEFAULT_WORKSPACE_TYPE,
  type AgentPermissionMode,
  type ChatMessage,
} from '../../store/types'
import { consumeQueuedPromptInserts } from '../../utils/template-routing'
import type { ChatEventData, ChatThreadItemData } from '../../../shared/ipc-channels'
import { mapChatEventToMessage } from './chat-event-mapper'
import styles from './ChatPanel.module.css'

interface ChatPanelProps {
  threadId: string
  workspaceId: string
  worktreePath?: string
}

const EMPTY_MESSAGES: ChatMessage[] = []

type DropdownOption = { value: string; label: string }
type SessionMode = 'chat' | 'plan'
type BranchScope = 'local' | 'origin'

const SPARK_MODEL_OPTION: DropdownOption = { value: 'gpt-5.3-codex-spark', label: 'gpt-5.3-codex-spark' }
const FALLBACK_MODEL_OPTIONS: DropdownOption[] = [
  { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
  SPARK_MODEL_OPTION,
  { value: 'gpt-5.2-codex', label: 'gpt-5.2-codex' },
  { value: 'gpt-5.1-codex-max', label: 'gpt-5.1-codex-max' },
  { value: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini' },
]

const EFFORT_OPTIONS = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
]

const PERMISSION_OPTIONS: DropdownOption[] = [
  { value: 'default', label: 'Suggest' },
  { value: 'full-permissions', label: 'Full auto' },
]
const CREATE_BRANCH_OPTION_VALUE = '__create_new_branch__'

const PLAN_MODE_PREFIX = [
  'Plan mode is enabled.',
  'Do not execute commands or edit files.',
  'If key details are missing, ask one concise clarifying question at a time and wait for my answer before continuing.',
  'Only provide the implementation plan once uncertainties are resolved.',
].join(' ')

interface ParsedQuestionOption {
  id: string
  index: number
  label: string
  detail?: string
}

interface ParsedInteractiveQuestion {
  header?: string
  prompt: string
  options: ParsedQuestionOption[]
  footer?: string
}

const PLAN_ACTION_EXECUTE_ID = 'plan-execute-now'
const PLAN_ACTION_REFINE_ID = 'plan-refine'
const PLAN_ACTION_EXECUTE_LABEL = 'Start implementation now'
const PLAN_ACTION_REFINE_LABEL = 'Keep planning'
const PLAN_EXECUTE_PROMPT = 'Implement the approved plan now. Start with phase 1 and apply changes directly.'
const PLAN_REFINE_PROMPT = 'Keep planning. Refine the implementation plan with concrete steps, risks, and validation for each phase.'
const DEFAULT_QUESTION_FOOTER = 'Select an option, then press Enter to submit your answer.'
const PLAN_COMPLETION_QUESTION: ParsedInteractiveQuestion = {
  header: 'Plan complete',
  prompt: 'The plan is ready. What should I do next?',
  options: [
    {
      id: PLAN_ACTION_EXECUTE_ID,
      index: 1,
      label: PLAN_ACTION_EXECUTE_LABEL,
      detail: 'Exit plan mode and execute changes now',
    },
    {
      id: PLAN_ACTION_REFINE_ID,
      index: 2,
      label: PLAN_ACTION_REFINE_LABEL,
      detail: 'Stay in plan mode and keep refining',
    },
  ],
  footer: 'Pick one option to continue.',
}

const QUESTION_HEADER_RE = /^question\s+\d+\/\d+/i
const QUESTION_OPTION_RE = /^(?:[>\u203a]\s*)?(\d+)\.\s+(.+)$/
const QUESTION_FOOTER_RE = /(tab to add notes|enter to submit answer|esc to interrupt)/i

function normalizeBranchName(input: string): string {
  return input.trim().replace(/^origin\//, '').replace(/^refs\/heads\//, '')
}

function toWorkspaceNameFromBranch(branch: string): string {
  const normalized = branch
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'thread'
}

function uniqueWorkspaceName(
  baseName: string,
  projectId: string,
  workspaces: Array<{ projectId: string; name: string }>,
): string {
  const normalized = baseName.trim() || 'thread'
  const used = new Set(
    workspaces
      .filter((ws) => ws.projectId === projectId)
      .map((ws) => ws.name.toLowerCase()),
  )
  if (!used.has(normalized.toLowerCase())) return normalized

  let suffix = 2
  while (used.has(`${normalized}-${suffix}`.toLowerCase())) {
    suffix += 1
  }
  return `${normalized}-${suffix}`
}

function formatUserError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback
  const invokePrefix = /^Error invoking remote method '[^']+': Error:\s*/i
  return err.message.replace(invokePrefix, '') || fallback
}

function pickTrimmedText(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function toInteractiveQuestionText(question: ParsedInteractiveQuestion): string {
  const lines: string[] = []
  if (question.header) lines.push(question.header)
  lines.push(question.prompt)
  lines.push('')
  for (const option of question.options) {
    lines.push(option.detail
      ? `${option.index}. ${option.label} - ${option.detail}`
      : `${option.index}. ${option.label}`)
  }
  if (question.footer) {
    lines.push('')
    lines.push(question.footer)
  }
  return lines.join('\n')
}

function parseInteractiveQuestionPayload(payload: Record<string, unknown>): ParsedInteractiveQuestion | null {
  const prompt = pickTrimmedText(payload, 'question', 'prompt', 'text')
  if (!prompt) return null

  const optionsRaw = Array.isArray(payload.options)
    ? payload.options
    : Array.isArray(payload.choices)
      ? payload.choices
      : null
  if (!optionsRaw || optionsRaw.length === 0) return null

  const options: ParsedQuestionOption[] = []
  for (let i = 0; i < optionsRaw.length; i += 1) {
    const option = optionsRaw[i]
    if (typeof option === 'string' && option.trim()) {
      const label = option.trim()
      options.push({ id: `opt-${i + 1}-${label}`, index: i + 1, label })
      continue
    }
    if (!option || typeof option !== 'object') continue
    const entry = option as Record<string, unknown>
    const label = pickTrimmedText(entry, 'label', 'value', 'name')
    if (!label) continue
    const detail = pickTrimmedText(entry, 'description', 'detail')
    const id = pickTrimmedText(entry, 'id')
      ?? `opt-${i + 1}-${label}`
    options.push({
      id,
      index: i + 1,
      label,
      detail: detail ?? undefined,
    })
  }

  if (options.length === 0) return null

  return {
    header: pickTrimmedText(payload, 'header', 'title') ?? undefined,
    prompt,
    options,
    footer: pickTrimmedText(payload, 'footer', 'hint') ?? undefined,
  }
}

function parseInteractiveQuestionMetadata(metadata: Record<string, unknown> | undefined): ParsedInteractiveQuestion | null {
  if (!metadata) return null
  const raw = metadata.interactiveQuestion
  if (!raw || typeof raw !== 'object') return null

  const payload = raw as Record<string, unknown>
  const prompt = pickTrimmedText(payload, 'prompt')
  const optionsRaw = payload.options
  if (!prompt || !Array.isArray(optionsRaw) || optionsRaw.length === 0) return null

  const options: ParsedQuestionOption[] = []
  for (let i = 0; i < optionsRaw.length; i += 1) {
    const option = optionsRaw[i]
    if (!option || typeof option !== 'object') continue
    const entry = option as Record<string, unknown>
    const label = pickTrimmedText(entry, 'label')
    const id = pickTrimmedText(entry, 'id')
    const rawIndex = entry.index
    const parsedIndex = typeof rawIndex === 'number'
      ? rawIndex
      : typeof rawIndex === 'string'
        ? Number.parseInt(rawIndex, 10)
        : Number.NaN
    if (!label || !id) continue
    options.push({
      id,
      label,
      index: Number.isFinite(parsedIndex) ? parsedIndex : i + 1,
      detail: pickTrimmedText(entry, 'detail') ?? undefined,
    })
  }

  if (options.length === 0) return null

  return {
    header: pickTrimmedText(payload, 'header') ?? undefined,
    prompt,
    options,
    footer: pickTrimmedText(payload, 'footer') ?? undefined,
  }
}

function isThreadItemData(data: ChatEventData): data is ChatThreadItemData {
  return 'id' in data && typeof data.id === 'string'
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function looksInteractiveQuestionText(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed) return false
  if (QUESTION_HEADER_RE.test(trimmed)) return true
  return trimmed.includes('?') && /\n\s*(?:[>\u203a]\s*)?1\.\s+/.test(trimmed)
}

function parseInteractiveQuestionText(content: string): ParsedInteractiveQuestion | null {
  const lines = content
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())

  const firstNonEmptyIndex = lines.findIndex((line) => line.trim().length > 0)
  if (firstNonEmptyIndex === -1) return null

  let cursor = firstNonEmptyIndex
  let header: string | undefined
  if (QUESTION_HEADER_RE.test(lines[cursor]!.trim())) {
    header = lines[cursor]!.trim()
    cursor += 1
  }

  while (cursor < lines.length && lines[cursor]!.trim().length === 0) {
    cursor += 1
  }
  if (cursor >= lines.length) return null

  const prompt = lines[cursor]!.trim()
  cursor += 1

  const options: ParsedQuestionOption[] = []
  const footerLines: string[] = []
  let currentOption: ParsedQuestionOption | null = null

  for (; cursor < lines.length; cursor += 1) {
    const trimmed = lines[cursor]!.trim()
    if (!trimmed) continue

    if (QUESTION_FOOTER_RE.test(trimmed)) {
      footerLines.push(trimmed)
      continue
    }

    const match = trimmed.match(QUESTION_OPTION_RE)
    if (match) {
      if (currentOption) options.push(currentOption)
      const index = Number.parseInt(match[1]!, 10)
      const optionText = match[2]!.trim()
      const [labelPart, detailPart] = optionText.split(/\s{2,}| - /, 2)
      currentOption = {
        id: `${index}-${labelPart}`,
        index,
        label: labelPart?.trim() || `Option ${index}`,
        detail: detailPart?.trim() || undefined,
      }
      continue
    }

    if (currentOption) {
      currentOption = {
        ...currentOption,
        detail: currentOption.detail
          ? `${currentOption.detail} ${trimmed}`
          : trimmed,
      }
    }
  }

  if (currentOption) options.push(currentOption)
  if (options.length === 0) return null

  const isLikelyQuestion = Boolean(header) || footerLines.length > 0 || prompt.includes('?')
  if (!isLikelyQuestion) return null

  return {
    header,
    prompt,
    options,
    footer: footerLines.length > 0 ? footerLines.join(' | ') : undefined,
  }
}

function mergeModelOptionsWithRequired(options: DropdownOption[]): DropdownOption[] {
  const merged = [...options]
  if (!merged.some((option) => option.value === SPARK_MODEL_OPTION.value)) {
    merged.push(SPARK_MODEL_OPTION)
  }
  return merged
}

function ToolbarDropdown({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const selected = options.find((o) => o.value === value)

  return (
    <div className={styles.dropdown} ref={ref}>
      <button
        className={styles.dropdownTrigger}
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        type="button"
      >
        {selected?.label ?? value}
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className={styles.dropdownMenu}>
          {options.map((opt) => (
            <button
              key={opt.value}
              className={`${styles.dropdownItem} ${opt.value === value ? styles.dropdownItemActive : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false) }}
              type="button"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ContextDropdown({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  align = 'left',
}: {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  ariaLabel: string
  disabled?: boolean
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const selected = options.find((option) => option.value === value)

  return (
    <div className={styles.contextSelect} ref={ref}>
      <button
        type="button"
        className={`${styles.contextSelectTrigger} ${open ? styles.contextSelectTriggerOpen : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (disabled) return
          setOpen((current) => !current)
        }}
      >
        <span className={styles.contextSelectLabel}>{selected?.label ?? value}</span>
        <svg className={styles.contextSelectChevron} width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div
          className={`${styles.contextSelectMenu} ${
            align === 'right' ? styles.contextSelectMenuRight : styles.contextSelectMenuLeft
          }`}
          role="listbox"
          aria-label={ariaLabel}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${styles.contextSelectItem} ${
                option.value === value ? styles.contextSelectItemActive : ''
              }`}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface AttachedImage {
  path: string
  name: string
  previewUrl: string
}

type ChatRenderItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'tool-calls'; key: string; messages: ChatMessage[] }

function formatMessageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  })
}

interface MarkdownTextBlock {
  kind: 'text'
  text: string
}

interface MarkdownCodeBlock {
  kind: 'code'
  lang: string
  code: string
}

type MarkdownBlock = MarkdownTextBlock | MarkdownCodeBlock

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const fenceRe = /```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g
  let cursor = 0

  for (const match of content.matchAll(fenceRe)) {
    const start = match.index ?? 0
    const end = start + (match[0]?.length ?? 0)

    if (start > cursor) {
      const text = content.slice(cursor, start)
      if (text.trim().length > 0) blocks.push({ kind: 'text', text })
    }

    blocks.push({
      kind: 'code',
      lang: (match[1] ?? '').trim(),
      code: (match[2] ?? '').replace(/\n$/, ''),
    })
    cursor = end
  }

  if (cursor < content.length) {
    const text = content.slice(cursor)
    if (text.trim().length > 0) blocks.push({ kind: 'text', text })
  }

  if (blocks.length === 0) return [{ kind: 'text', text: content }]
  return blocks
}

function renderBoldSegments(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const boldRe = /\*\*([^*]+)\*\*/g
  let cursor = 0
  let index = 0

  for (const match of text.matchAll(boldRe)) {
    const start = match.index ?? 0
    const end = start + (match[0]?.length ?? 0)

    if (start > cursor) {
      nodes.push(
        <span key={`${keyPrefix}-plain-${index}`}>{text.slice(cursor, start)}</span>,
      )
      index += 1
    }

    nodes.push(
      <strong key={`${keyPrefix}-bold-${index}`} className={styles.markdownStrong}>
        {match[1]}
      </strong>,
    )
    index += 1
    cursor = end
  }

  if (cursor < text.length) {
    nodes.push(
      <span key={`${keyPrefix}-tail-${index}`}>{text.slice(cursor)}</span>,
    )
  }

  return nodes
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const codeRe = /`([^`\n]+)`/g
  let cursor = 0
  let index = 0

  for (const match of text.matchAll(codeRe)) {
    const start = match.index ?? 0
    const end = start + (match[0]?.length ?? 0)

    if (start > cursor) {
      nodes.push(...renderBoldSegments(text.slice(cursor, start), `${keyPrefix}-seg-${index}`))
      index += 1
    }

    nodes.push(
      <code key={`${keyPrefix}-code-${index}`} className={styles.markdownInlineCode}>
        {match[1]}
      </code>,
    )
    index += 1
    cursor = end
  }

  if (cursor < text.length) {
    nodes.push(...renderBoldSegments(text.slice(cursor), `${keyPrefix}-tail-${index}`))
  }

  return nodes
}

function renderTextParagraph(paragraph: string, key: string): ReactNode {
  const lines = paragraph
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length > 0 && lines.every((line) => /^[-*]\s+/.test(line))) {
    return (
      <ul key={key} className={styles.markdownList}>
        {lines.map((line, idx) => (
          <li key={`${key}-li-${idx}`}>{renderInlineMarkdown(line.replace(/^[-*]\s+/, ''), `${key}-li-${idx}`)}</li>
        ))}
      </ul>
    )
  }

  if (lines.length > 0 && lines.every((line) => /^\d+\.\s+/.test(line))) {
    return (
      <ol key={key} className={styles.markdownList}>
        {lines.map((line, idx) => (
          <li key={`${key}-li-${idx}`}>{renderInlineMarkdown(line.replace(/^\d+\.\s+/, ''), `${key}-li-${idx}`)}</li>
        ))}
      </ol>
    )
  }

  return (
    <p key={key} className={styles.markdownParagraph}>
      {renderInlineMarkdown(paragraph, key)}
    </p>
  )
}

function renderAssistantMarkdown(content: string): ReactNode {
  const blocks = parseMarkdownBlocks(content)

  return (
    <div className={styles.markdownRoot}>
      {blocks.map((block, blockIndex) => {
        if (block.kind === 'code') {
          return (
            <div key={`code-${blockIndex}`} className={styles.markdownCodeWrapper}>
              {block.lang && <div className={styles.markdownCodeLang}>{block.lang}</div>}
              <pre className={styles.markdownCodeBlock}>
                <code>{block.code}</code>
              </pre>
            </div>
          )
        }

        return block.text
          .split(/\n{2,}/)
          .map((paragraph, paragraphIndex) =>
            renderTextParagraph(paragraph, `text-${blockIndex}-${paragraphIndex}`),
          )
      })}
    </div>
  )
}

function isToolCallMessage(message: ChatMessage): boolean {
  return message.type === 'command' || message.type === 'file-change' || message.type === 'tool-call'
}

function getToolCallText(message: ChatMessage): string {
  if (message.type === 'tool-call') {
    const toolName = (message.metadata?.tool_name as string | undefined)?.trim()
    const server = (message.metadata?.server as string | undefined)?.trim()
    const tool = (message.metadata?.tool as string | undefined)?.trim()
    const query = (message.metadata?.query as string | undefined)?.trim()
    const status = (message.metadata?.status as string | undefined)?.trim()

    if (server && tool) return `Tool call ${server}.${tool}${status ? ` (${status})` : ''}`
    if (query) return `Web search "${query}"`
    if (toolName) return `Tool call ${toolName}${status ? ` (${status})` : ''}`
    return 'Tool call'
  }

  if (message.type === 'command') {
    const toolName = (message.metadata?.tool_name as string | undefined)?.trim()
    const command = (message.metadata?.command as string) ?? message.content
    const trimmed = command.trim()
    if (trimmed) return `Command run ${trimmed}`
    if (toolName) return `Tool call ${toolName}`
    return 'Tool call'
  }

  if (message.type === 'file-change') {
    const changes = (message.metadata?.changes as Array<{ path: string; kind: string }>) ?? []
    return changes.length > 0
      ? `File changes (${changes.length})`
      : 'File changes'
  }

  return message.content || 'Tool call'
}

function QuestionCard({
  question,
  timestamp,
  onSelect,
}: {
  question: ParsedInteractiveQuestion
  timestamp: number
  onSelect: (answer: string, optionId: string) => void
}) {
  return (
    <div className={`${styles.message} ${styles.messageAssistant}`}>
      <div className={styles.questionCard}>
        {question.header && <div className={styles.questionHeader}>{question.header}</div>}
        <div className={styles.questionPrompt}>{question.prompt}</div>
        <div className={styles.questionOptions}>
          {question.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={styles.questionOption}
              onClick={() => onSelect(option.label, option.id)}
            >
              <span className={styles.questionOptionIndex}>{option.index}.</span>
              <span className={styles.questionOptionBody}>
                <span className={styles.questionOptionLabel}>{option.label}</span>
                {option.detail && <span className={styles.questionOptionDetail}>{option.detail}</span>}
              </span>
            </button>
          ))}
        </div>
        <div className={styles.questionFooter}>
          {question.footer ?? DEFAULT_QUESTION_FOOTER}
        </div>
      </div>
      <div className={styles.messageTime}>{formatMessageTime(timestamp)}</div>
    </div>
  )
}

function MessageBubble({
  message,
  onQuestionOptionSelect,
}: {
  message: ChatMessage
  onQuestionOptionSelect: (answer: string, optionId: string) => void
}) {
  const [reasoningOpen, setReasoningOpen] = useState(false)

  if (message.type === 'reasoning') {
    return (
      <div className={`${styles.message} ${styles.messageAssistant}`}>
        <div className={styles.reasoningBlock}>
          <button
            className={styles.reasoningToggle}
            onClick={() => setReasoningOpen(!reasoningOpen)}
          >
            <span className={`${styles.reasoningArrow} ${reasoningOpen ? styles.reasoningArrowOpen : ''}`}>
              &#x25B6;
            </span>
            Reasoning
          </button>
          {reasoningOpen && (
            <div className={styles.reasoningContent}>{message.content}</div>
          )}
        </div>
        <div className={styles.messageTime}>{formatMessageTime(message.timestamp)}</div>
      </div>
    )
  }

  // Error messages
  if (message.role === 'system' && message.metadata?.error) {
    return (
      <div className={styles.errorBubble}>{message.content}</div>
    )
  }

  // Regular text messages
  const roleClass = message.role === 'user' ? styles.messageUser :
                    message.role === 'assistant' ? styles.messageAssistant :
                    styles.messageSystem
  const isUser = message.role === 'user'
  const content = message.content.trim()
  if (!isUser && !content) return null

  if (message.role === 'assistant' && message.type === 'text') {
    const parsedQuestion = parseInteractiveQuestionMetadata(message.metadata) ?? parseInteractiveQuestionText(content)
    if (parsedQuestion) {
      return (
        <QuestionCard
          question={parsedQuestion}
          timestamp={message.timestamp}
          onSelect={onQuestionOptionSelect}
        />
      )
    }
  }

  return (
    <div className={`${styles.message} ${roleClass}`}>
      {isUser ? (
        <div className={`${styles.bubble} ${styles.bubbleUser}`}>{message.content}</div>
      ) : (
        <div className={styles.assistantText}>{renderAssistantMarkdown(message.content)}</div>
      )}
      {message.role === 'assistant' && (
        <div className={styles.messageTime}>{formatMessageTime(message.timestamp)}</div>
      )}
    </div>
  )
}

function ToolCallsBlock({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className={`${styles.message} ${styles.messageAssistant}`}>
      <div className={styles.toolCallsBlock}>
        <div className={styles.toolCallsHeader}>Tool calls ({messages.length})</div>
        <div className={styles.toolCallsList}>
          {messages.map((message) => (
            <div key={message.id} className={styles.toolCallsItem}>
              <span className={styles.toolCallsBullet}>*</span>
              <span className={styles.toolCallsText}>{getToolCallText(message)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className={styles.messageTime}>
        {formatMessageTime(messages[messages.length - 1]!.timestamp)}
      </div>
    </div>
  )
}

function LoadingIndicator() {
  return (
    <div className={`${styles.message} ${styles.messageAssistant}`}>
      <div className={styles.loadingDots} aria-label="Thinking">
        <div className={styles.loadingDot} />
        <div className={styles.loadingDot} />
        <div className={styles.loadingDot} />
      </div>
    </div>
  )
}

export function ChatPanel({ threadId, workspaceId, worktreePath }: ChatPanelProps) {
  const codexLoggedIn = useAppStore((s) => s.codexLoggedIn)
  const setCodexLoggedIn = useAppStore((s) => s.setCodexLoggedIn)
  const updateWorkspaceAgentPermissionMode = useAppStore((s) => s.updateWorkspaceAgentPermissionMode)
  const updateWorkspaceBranch = useAppStore((s) => s.updateWorkspaceBranch)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const setLastSelectedBranch = useAppStore((s) => s.setLastSelectedBranch)
  const createChatForActiveWorkspace = useAppStore((s) => s.createChatForActiveWorkspace)
  const setChatThreadAgentStatus = useAppStore((s) => s.setChatThreadAgentStatus)
  const addWorkspace = useAppStore((s) => s.addWorkspace)
  const addToast = useAppStore((s) => s.addToast)
  const projects = useAppStore((s) => s.projects)
  const workspaces = useAppStore((s) => s.workspaces)
  const messages = useAppStore((s) => s.chatMessages[threadId] ?? EMPTY_MESSAGES)
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const agentPermissionMode = workspace?.agentPermissionMode ?? 'default'

  const [input, setInput] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [modelOptions, setModelOptions] = useState<DropdownOption[]>(FALLBACK_MODEL_OPTIONS)
  const [model, setModel] = useState(FALLBACK_MODEL_OPTIONS[0]?.value ?? 'gpt-5.3-codex')
  const [effort, setEffort] = useState('high')
  const [sessionMode, setSessionMode] = useState<SessionMode>('chat')
  const [branchScope, setBranchScope] = useState<BranchScope>('local')
  const [originBranches, setOriginBranches] = useState<string[]>([])
  const [createBranchOpen, setCreateBranchOpen] = useState(false)
  const [createBranchName, setCreateBranchName] = useState('')
  const [createBranchBase, setCreateBranchBase] = useState('main')
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // The tab's threadId is a local UUID. The real Codex SDK thread ID is different.
  const realThreadIdRef = useRef<string | null>(null)
  // Guard against SDK item-id reuse across turns. We scope all item ids by turn.
  const eventTurnSequenceRef = useRef(0)
  const activeTurnHasItemsRef = useRef(false)
  const hiddenThreadToastDedupeRef = useRef(new Map<string, number>())

  useEffect(() => {
    const appendPrompt = (prompt: string) => {
      setInput((prev) => (prev.trim().length > 0 ? `${prev}\n\n${prompt}` : prompt))
      if (textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`
      }
    }

    const pendingPrompts = consumeQueuedPromptInserts(threadId)
    if (pendingPrompts.length > 0) {
      appendPrompt(pendingPrompts.join('\n\n'))
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string; prompt?: string }>).detail
      if (!detail || detail.threadId !== threadId || typeof detail.prompt !== 'string') return

      appendPrompt(detail.prompt)
    }

    window.addEventListener('chat:insertPrompt', handler)
    return () => {
      window.removeEventListener('chat:insertPrompt', handler)
    }
  }, [threadId])

  const renderItems = useMemo<ChatRenderItem[]>(() => {
    if (messages.length === 0) return []

    const items: ChatRenderItem[] = []
    let currentToolMessages: ChatMessage[] = []

    for (const message of messages) {
      if (isToolCallMessage(message)) {
        currentToolMessages.push(message)
        continue
      }

      if (currentToolMessages.length > 0) {
        const key = currentToolMessages.map((m) => m.id).join(':')
        items.push({ kind: 'tool-calls', key, messages: currentToolMessages })
        currentToolMessages = []
      }

      items.push({ kind: 'message', message })
    }

    if (currentToolMessages.length > 0) {
      const key = currentToolMessages.map((m) => m.id).join(':')
      items.push({ kind: 'tool-calls', key, messages: currentToolMessages })
    }

    return items
  }, [messages])

  const activeProject = useMemo(
    () => (workspace ? projects.find((project) => project.id === workspace.projectId) : undefined),
    [workspace, projects],
  )

  const branchContexts = useMemo(() => {
    if (!activeProject) return []
    const inProject = workspaces.filter((entry) => entry.projectId === activeProject.id)
    const seen = new Set<string>()
    return inProject
      .filter((entry) => {
        if (!entry.branch || seen.has(entry.branch)) return false
        seen.add(entry.branch)
        return true
      })
      .map((entry) => ({ workspaceId: entry.id, branch: entry.branch }))
  }, [activeProject, workspaces])

  useEffect(() => {
    if (branchScope !== 'origin' || !activeProject) {
      return
    }
    let cancelled = false

    void window.api.git.getBranches(activeProject.repoPath)
      .then((branches) => {
        if (cancelled) return
        const normalized = Array.from(
          new Set(branches.map((branch) => normalizeBranchName(branch)).filter(Boolean)),
        )
        const localSet = new Set(branchContexts.map((entry) => normalizeBranchName(entry.branch)))
        const remoteCandidates = normalized.filter((branch) => !localSet.has(branch))
        setOriginBranches(remoteCandidates.length > 0 ? remoteCandidates : normalized)
      })
      .catch(() => {
        if (!cancelled) setOriginBranches([])
      })

    return () => {
      cancelled = true
    }
  }, [branchScope, activeProject, branchContexts])

  const contextBranchOptions = useMemo(() => {
    if (!workspace) return []
    if (branchScope === 'local') {
      return branchContexts.length > 0
        ? branchContexts.map((entry) => entry.branch)
        : [workspace.branch]
    }
    const merged = originBranches.length > 0
      ? originBranches
      : [workspace.branch]
    if (!merged.includes(workspace.branch)) {
      return [workspace.branch, ...merged]
    }
    return merged
  }, [branchScope, branchContexts, originBranches, workspace])

  const branchScopeOptions = useMemo<DropdownOption[]>(
    () => [
      { value: 'local', label: 'Local' },
      { value: 'origin', label: 'Origin' },
    ],
    [],
  )

  const contextBranchDropdownOptions = useMemo<DropdownOption[]>(
    () => [
      ...contextBranchOptions.map((branch) => ({ value: branch, label: branch })),
      { value: CREATE_BRANCH_OPTION_VALUE, label: '+ Create new branch...' },
    ],
    [contextBranchOptions],
  )

  useEffect(() => {
    if (!workspace?.branch) return
    setCreateBranchBase(workspace.branch)
  }, [workspace?.branch])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [input])

  // Auto-scroll to bottom on new content and while loading.
  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
    })
    return () => cancelAnimationFrame(raf)
  }, [messages, loading])

  useEffect(() => {
    let cancelled = false
    const listModels = (window.api.chat as { listModels?: () => Promise<DropdownOption[]> }).listModels
    if (typeof listModels !== 'function') {
      return () => {
        cancelled = true
      }
    }
    listModels()
      .then((options) => {
        if (cancelled || options.length === 0) return
        const mergedOptions = mergeModelOptionsWithRequired(options)
        setModelOptions(mergedOptions)
        setModel((current) => (
          mergedOptions.some((option) => option.value === current)
            ? current
            : mergedOptions[0]!.value
        ))
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err ?? '')
        if (message.includes("No handler registered for 'chat:list-models'")) return
        console.warn('[ChatPanel] Failed to load model list, using fallback models:', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const resetRuntimeThreadState = useCallback(() => {
    const previousThreadId = realThreadIdRef.current
    if (previousThreadId) {
      void window.api.chat.destroyThread(previousThreadId).catch(() => {})
    }
    realThreadIdRef.current = null
    eventTurnSequenceRef.current = 0
    activeTurnHasItemsRef.current = false
  }, [])

  useEffect(() => {
    return () => {
      const previousThreadId = realThreadIdRef.current
      if (previousThreadId) {
        void window.api.chat.destroyThread(previousThreadId).catch(() => {})
      }
      if (workspaceId) {
        setChatThreadAgentStatus(workspaceId, threadId, 'idle')
      }
    }
  }, [workspaceId, threadId, setChatThreadAgentStatus])

  const toScopedItemId = useCallback((rawId: unknown) => {
    const normalizedRawId = typeof rawId === 'string' && rawId.trim().length > 0
      ? rawId.trim()
      : crypto.randomUUID()

    if (eventTurnSequenceRef.current === 0) {
      eventTurnSequenceRef.current = 1
    }

    return `${eventTurnSequenceRef.current}:${normalizedRawId}`
  }, [])

  const appendChatMessage = useCallback((message: ChatMessage) => {
    useAppStore.setState((state) => ({
      chatMessages: {
        ...state.chatMessages,
        [threadId]: [...(state.chatMessages[threadId] ?? []), message],
      },
    }))
  }, [threadId])

  const appendPlanCompletionCard = useCallback((turnId?: string) => {
    useAppStore.setState((state) => {
      const existing = state.chatMessages[threadId] ?? []
      const alreadyShown = existing.some((message) => (
        message.role === 'assistant'
        && message.type === 'text'
        && message.metadata?.planCompletionCard === true
        && (!turnId || message.metadata?.turnId === turnId)
      ))
      if (alreadyShown) return {}

      const cardMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: toInteractiveQuestionText(PLAN_COMPLETION_QUESTION),
        type: 'text',
        timestamp: Date.now(),
        metadata: {
          interactiveQuestion: PLAN_COMPLETION_QUESTION,
          planCompletionCard: true,
          turnId: turnId ?? '',
        },
      }

      return {
        chatMessages: {
          ...state.chatMessages,
          [threadId]: [...existing, cardMessage],
        },
      }
    })
  }, [threadId])

  const notifyInactiveChatTab = useCallback((reason: 'waiting_input' | 'completed') => {
    if (!workspaceId) return

    const state = useAppStore.getState()
    if (state.activeWorkspaceId !== workspaceId) return

    const tab = state.tabs.find(
      (entry) => entry.type === 'chat' && entry.workspaceId === workspaceId && entry.threadId === threadId,
    )
    if (!tab || tab.id === state.activeTabId) return

    const dedupeKey = `${reason}:${workspaceId}:${threadId}`
    const now = Date.now()
    const last = hiddenThreadToastDedupeRef.current.get(dedupeKey) ?? 0
    if ((now - last) < 1500) return
    hiddenThreadToastDedupeRef.current.set(dedupeKey, now)

    const workspaceName = state.workspaces.find((ws) => ws.id === workspaceId)?.name ?? workspaceId
    const message = reason === 'waiting_input'
      ? `Another chat in ${workspaceName} is waiting for your input`
      : `Another chat in ${workspaceName} completed`

    state.addToast({
      id: crypto.randomUUID(),
      message,
      type: reason === 'completed' ? 'success' : 'info',
    })
  }, [threadId, workspaceId])

  // Listen for chat events from main process
  useEffect(() => {
    const unsub = window.api.chat.onEvent((event) => {
      const { threadId: eventThreadId, type, phase, data, turnId: eventTurnId } = event
      const realId = realThreadIdRef.current
      if (!realId || eventThreadId !== realId) return

      const typedData = data as ChatEventData

      if (phase === 'turn.started') {
        if (!activeTurnHasItemsRef.current) {
          eventTurnSequenceRef.current += 1
        }
        activeTurnHasItemsRef.current = false
        if (workspaceId) setChatThreadAgentStatus(workspaceId, threadId, 'running')
        return
      }

      if (phase === 'turn.waiting_input') {
        setLoading(false)
        if (workspaceId) setChatThreadAgentStatus(workspaceId, threadId, 'waiting')
        notifyInactiveChatTab('waiting_input')
        return
      }

      if (type === 'item.started' || type === 'item.completed' || type === 'item.updated') {
        activeTurnHasItemsRef.current = true
        const timestamp = Date.now()
        const scopedId = toScopedItemId(isThreadItemData(typedData) ? typedData.id : undefined)
        let msg = mapChatEventToMessage({
          data: typedData,
          eventType: type,
          scopedId,
          timestamp,
        })

        if (typedData.type === 'agent_message') {
          const parsedTextQuestion = parseInteractiveQuestionText(typedData.text)
          if (parsedTextQuestion || looksInteractiveQuestionText(typedData.text)) {
            setLoading(false)
            if (workspaceId) setChatThreadAgentStatus(workspaceId, threadId, 'waiting')
            notifyInactiveChatTab('waiting_input')
          }
          if (msg && parsedTextQuestion) {
            msg = {
              ...msg,
              metadata: { interactiveQuestion: parsedTextQuestion },
            }
          }
        } else if (typedData.type === 'unknown_item') {
          const raw = toRecord(typedData.raw)
          if (raw) {
            const interactiveQuestion = parseInteractiveQuestionPayload(raw)
            if (interactiveQuestion) {
              setLoading(false)
              if (workspaceId) setChatThreadAgentStatus(workspaceId, threadId, 'waiting')
              notifyInactiveChatTab('waiting_input')
              msg = {
                id: scopedId,
                role: 'assistant',
                content: toInteractiveQuestionText(interactiveQuestion),
                type: 'text',
                timestamp,
                metadata: {
                  interactiveQuestion,
                },
              }
            }
          }
        }

        if (msg) {
          useAppStore.setState((s) => {
            const existing = s.chatMessages[threadId] ?? []
            const idx = existing.findIndex((m) => m.id === msg.id)
            const updated = idx >= 0
              ? existing.map((m, i) => (i === idx ? msg : m))
              : [...existing, msg]
            return {
              chatMessages: { ...s.chatMessages, [threadId]: updated },
            }
          })
        }
      } else if (phase === 'turn.completed') {
        setLoading(false)
        activeTurnHasItemsRef.current = false
        if (workspaceId) setChatThreadAgentStatus(workspaceId, threadId, 'completed')
        notifyInactiveChatTab('completed')
        if (sessionMode === 'plan') {
          appendPlanCompletionCard(eventTurnId)
        }
      } else if (phase === 'turn.cancelled') {
        setLoading(false)
        activeTurnHasItemsRef.current = false
        if (workspaceId) setChatThreadAgentStatus(workspaceId, threadId, 'idle')
      } else if (phase === 'turn.failed' || phase === 'error') {
        setLoading(false)
        activeTurnHasItemsRef.current = false
        if (workspaceId) setChatThreadAgentStatus(workspaceId, threadId, 'idle')
        const message = typedData.type === 'error' || typedData.type === 'turn.failed'
          ? typedData.message
          : 'An error occurred'
        useAppStore.setState((s) => ({
          chatMessages: {
            ...s.chatMessages,
            [threadId]: [...(s.chatMessages[threadId] ?? []), {
              id: crypto.randomUUID(),
              role: 'system' as const,
              content: message,
              type: 'text' as const,
              timestamp: Date.now(),
              metadata: { error: true },
            }],
          },
        }))
      } else {
        // Forward-compatible fallback: if future SDK versions send question-like
        // top-level events, surface them as assistant messages.
        const topLevelPayload = typedData.type === 'unknown_event'
          ? toRecord(typedData.raw)
          : toRecord(typedData)

        const interactiveQuestion = topLevelPayload
          ? parseInteractiveQuestionPayload(topLevelPayload)
          : null
        if (interactiveQuestion) {
          setLoading(false)
          if (workspaceId) setChatThreadAgentStatus(workspaceId, threadId, 'waiting')
          notifyInactiveChatTab('waiting_input')
          appendChatMessage({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: toInteractiveQuestionText(interactiveQuestion),
            type: 'text',
            timestamp: Date.now(),
            metadata: {
              interactiveQuestion,
            },
          })
          return
        }

        const fallbackMessage = mapChatEventToMessage({
          data: typedData,
          eventType: type,
          scopedId: crypto.randomUUID(),
          timestamp: Date.now(),
        })
        if (fallbackMessage) {
          appendChatMessage(fallbackMessage)
        }
      }
    })
    return unsub
  }, [
    threadId,
    workspaceId,
    toScopedItemId,
    setChatThreadAgentStatus,
    notifyInactiveChatTab,
    appendChatMessage,
    appendPlanCompletionCard,
    sessionMode,
  ])

  const handleLogin = useCallback(async () => {
    setLoginLoading(true)
    setLoginError(null)
    try {
      await window.api.chat.login()
      setCodexLoggedIn(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Login failed'
      setLoginError(msg)
      console.error('[ChatPanel] Login error:', err)
    } finally {
      setLoginLoading(false)
    }
  }, [setCodexLoggedIn])

  const handleSend = useCallback(async (overrides?: {
    text?: string
    mode?: SessionMode
    images?: AttachedImage[]
  }) => {
    const text = overrides?.text ?? input
    const images = overrides?.images ?? attachedImages
    const trimmed = text.trim()
    if ((!trimmed && images.length === 0) || !worktreePath) return

    const effectiveMode = overrides?.mode ?? sessionMode
    const isPlanMode = effectiveMode === 'plan'
    const planPrompt = trimmed
      ? `${PLAN_MODE_PREFIX}\n\nUser request:\n${trimmed}`
      : `${PLAN_MODE_PREFIX}\n\nAnalyze the attached image(s) and provide a plan.`
    const threadOptions = isPlanMode
      ? {
          sandboxMode: 'read-only' as const,
          approvalMode: 'on-request' as const,
        }
      : agentPermissionMode === 'full-permissions'
        ? {
            sandboxMode: 'danger-full-access' as const,
            approvalMode: 'never' as const,
          }
        : {
            sandboxMode: 'workspace-write' as const,
            approvalMode: 'on-request' as const,
          }

    // Create real Codex thread if needed (pass model & effort)
    if (!realThreadIdRef.current) {
      try {
        const realId = await window.api.chat.createThread(
          worktreePath,
          model,
          effort,
          threadOptions,
          workspaceId,
          workspace?.name,
        )
        realThreadIdRef.current = realId
        eventTurnSequenceRef.current = 0
        activeTurnHasItemsRef.current = false
      } catch (err) {
        useAppStore.setState((s) => ({
          chatMessages: {
            ...s.chatMessages,
            [threadId]: [...(s.chatMessages[threadId] ?? []), {
              id: crypto.randomUUID(),
              role: 'system' as const,
              content: err instanceof Error ? err.message : 'Failed to create thread',
              type: 'text' as const,
              timestamp: Date.now(),
              metadata: { error: true },
            }],
          },
        }))
        return
      }
    }

    // Add user message to store
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed || (images.length > 0 ? `[${images.length} image(s)]` : ''),
      type: 'text',
      timestamp: Date.now(),
    }
    useAppStore.setState((s) => ({
      chatMessages: {
        ...s.chatMessages,
        [threadId]: [...(s.chatMessages[threadId] ?? []), userMsg],
      },
    }))

    setInput('')
    setAttachedImages([])
    setLoading(true)
    if (workspaceId) setChatThreadAgentStatus(workspaceId, threadId, 'running')

    // Auto-resize textarea
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    // Build input payload
    let sendInput: string | Array<{ type: string; text?: string; path?: string }>
    if (images.length > 0) {
      const parts: Array<{ type: string; text?: string; path?: string }> = []
      if (isPlanMode || trimmed) {
        parts.push({ type: 'text', text: isPlanMode ? planPrompt : trimmed })
      }
      for (const img of images) {
        parts.push({ type: 'local_image', path: img.path })
      }
      sendInput = parts
    } else {
      sendInput = isPlanMode ? planPrompt : trimmed
    }

    // Send to backend
    try {
      await window.api.chat.send(realThreadIdRef.current!, sendInput)
    } catch (err) {
      setLoading(false)
      if (workspaceId) setChatThreadAgentStatus(workspaceId, threadId, 'idle')
      useAppStore.setState((s) => ({
        chatMessages: {
          ...s.chatMessages,
          [threadId]: [...(s.chatMessages[threadId] ?? []), {
            id: crypto.randomUUID(),
            role: 'system' as const,
            content: err instanceof Error ? err.message : 'Failed to send message',
            type: 'text' as const,
            timestamp: Date.now(),
            metadata: { error: true },
          }],
        },
      }))
    }
  }, [
    input,
    worktreePath,
    threadId,
    workspaceId,
    workspace?.name,
    model,
    effort,
    attachedImages,
    sessionMode,
    agentPermissionMode,
    setChatThreadAgentStatus,
  ])

  const handleQuestionOptionSelect = useCallback((answer: string, optionId: string) => {
    setLoading(false)

    if (optionId === PLAN_ACTION_EXECUTE_ID) {
      setSessionMode('chat')
      resetRuntimeThreadState()
      void handleSend({
        text: PLAN_EXECUTE_PROMPT,
        mode: 'chat',
        images: [],
      })
      return
    }

    if (optionId === PLAN_ACTION_REFINE_ID) {
      setSessionMode('plan')
      void handleSend({
        text: PLAN_REFINE_PROMPT,
        mode: 'plan',
        images: [],
      })
      return
    }

    setInput(answer)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`
    })
  }, [handleSend, resetRuntimeThreadState])

  const handleCancel = useCallback(() => {
    if (realThreadIdRef.current) {
      window.api.chat.cancel(realThreadIdRef.current)
    }
    setLoading(false)
    if (workspaceId) setChatThreadAgentStatus(workspaceId, threadId, 'idle')
  }, [workspaceId, threadId, setChatThreadAgentStatus])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      setSessionMode((current) => (current === 'chat' ? 'plan' : 'chat'))
      resetRuntimeThreadState()
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }, [handleSend, resetRuntimeThreadState])

  const handleTextareaInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    // Auto-resize
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [])

  // Image attachment helpers
  const addImageFiles = useCallback((files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'))
    const newImages: AttachedImage[] = imageFiles.map((f) => ({
      path: (f as any).path || f.name,
      name: f.name,
      previewUrl: URL.createObjectURL(f),
    }))
    setAttachedImages((prev) => [...prev, ...newImages])
  }, [])

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const removed = prev[index]
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return prev.filter((_, i) => i !== index)
    })
  }, [])

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) {
      addImageFiles(e.dataTransfer.files)
    }
  }, [addImageFiles])

  // Paste handler for images
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const savedPath = await window.api.clipboard.saveImage()
        if (savedPath) {
          setAttachedImages((prev) => [...prev, {
            path: savedPath,
            name: 'pasted-image.png',
            previewUrl: `file://${savedPath}`,
          }])
        }
        return
      }
    }
  }, [])

  const handleSwitchBranchContext = useCallback(async (targetBranch: string) => {
    if (!activeProject || !workspace) return
    const normalizedTargetBranch = normalizeBranchName(targetBranch)
    if (normalizedTargetBranch === normalizeBranchName(workspace.branch)) return

    let targetWorkspace = workspaces.find(
      (entry) =>
        entry.projectId === activeProject.id &&
        normalizeBranchName(entry.branch) === normalizedTargetBranch,
    )

    if (!targetWorkspace) {
      const workspaceName = uniqueWorkspaceName(
        toWorkspaceNameFromBranch(normalizedTargetBranch),
        activeProject.id,
        workspaces,
      )

      try {
        const worktreePath = await window.api.git.createWorktree(
          activeProject.repoPath,
          workspaceName,
          normalizedTargetBranch,
          false,
        )

        targetWorkspace = {
          id: crypto.randomUUID(),
          name: workspaceName,
          type: DEFAULT_WORKSPACE_TYPE,
          branch: normalizedTargetBranch,
          worktreePath,
          projectId: activeProject.id,
          agentPermissionMode: DEFAULT_AGENT_PERMISSION_MODE,
          memory: '',
        }
        addWorkspace(targetWorkspace)
      } catch (err) {
        const msg = formatUserError(err, 'Failed to switch branch context')

        if (msg === 'BRANCH_CHECKED_OUT') {
          try {
            const listed = await window.api.git.listWorktrees(activeProject.repoPath)
            const matchingWorktree = listed.find(
              (entry) =>
                normalizeBranchName(entry.branch) === normalizedTargetBranch &&
                entry.path,
            )

            if (matchingWorktree) {
              const existingByPath = workspaces.find(
                (entry) =>
                  entry.projectId === activeProject.id &&
                  entry.worktreePath.toLowerCase() === matchingWorktree.path.toLowerCase(),
              )

              if (existingByPath) {
                if (normalizeBranchName(existingByPath.branch) !== normalizedTargetBranch) {
                  updateWorkspaceBranch(existingByPath.id, normalizedTargetBranch)
                }
                targetWorkspace = existingByPath
              } else {
                targetWorkspace = {
                  id: crypto.randomUUID(),
                  name: workspaceName,
                  type: DEFAULT_WORKSPACE_TYPE,
                  branch: normalizedTargetBranch,
                  worktreePath: matchingWorktree.path,
                  projectId: activeProject.id,
                  agentPermissionMode: DEFAULT_AGENT_PERMISSION_MODE,
                  memory: '',
                }
                addWorkspace(targetWorkspace)
              }
            }
          } catch {
            // Keep default error path below when recovery fails.
          }
        }

        if (!targetWorkspace) {
          addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
          return
        }
      }
    }

    setActiveWorkspace(targetWorkspace.id)
    setLastSelectedBranch(activeProject.id, normalizedTargetBranch)

    const latest = useAppStore.getState()
    const hasTabs = latest.tabs.some((tab) => tab.workspaceId === targetWorkspace.id)
    if (!hasTabs) {
      await createChatForActiveWorkspace()
    }
  }, [
    activeProject,
    workspace,
    workspaces,
    addWorkspace,
    addToast,
    updateWorkspaceBranch,
    setActiveWorkspace,
    setLastSelectedBranch,
    createChatForActiveWorkspace,
  ])

  const handleCreateBranchContext = useCallback(async () => {
    if (!activeProject || !workspace) return

    const branch = normalizeBranchName(createBranchName)
    const baseBranch = normalizeBranchName(createBranchBase) || normalizeBranchName(workspace.branch) || 'main'
    if (!branch) {
      addToast({ id: crypto.randomUUID(), message: 'Branch name is required', type: 'error' })
      return
    }

    if (branch === normalizeBranchName(workspace.branch)) {
      setCreateBranchOpen(false)
      return
    }

    setCreatingBranch(true)
    try {
      let targetWorkspace = workspaces.find(
        (entry) =>
          entry.projectId === activeProject.id &&
          normalizeBranchName(entry.branch) === branch,
      )

      if (!targetWorkspace) {
        const workspaceName = uniqueWorkspaceName(
          toWorkspaceNameFromBranch(branch),
          activeProject.id,
          workspaces,
        )

        const worktreePath = await window.api.git.createWorktree(
          activeProject.repoPath,
          workspaceName,
          branch,
          true,
          baseBranch,
        )

        targetWorkspace = {
          id: crypto.randomUUID(),
          name: workspaceName,
          type: DEFAULT_WORKSPACE_TYPE,
          branch,
          worktreePath,
          projectId: activeProject.id,
          agentPermissionMode: DEFAULT_AGENT_PERMISSION_MODE,
          memory: '',
        }
        addWorkspace(targetWorkspace)
      }

      setActiveWorkspace(targetWorkspace.id)
      setLastSelectedBranch(activeProject.id, branch)

      const latest = useAppStore.getState()
      const hasTabs = latest.tabs.some((tab) => tab.workspaceId === targetWorkspace.id)
      if (!hasTabs) {
        await createChatForActiveWorkspace()
      }

      setCreateBranchOpen(false)
      setCreateBranchName('')
    } catch (err) {
      const msg = formatUserError(err, 'Failed to create branch context')
      addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
    } finally {
      setCreatingBranch(false)
    }
  }, [
    activeProject,
    workspace,
    createBranchName,
    createBranchBase,
    workspaces,
    addWorkspace,
    addToast,
    setActiveWorkspace,
    setLastSelectedBranch,
    createChatForActiveWorkspace,
  ])

  // File picker
  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addImageFiles(e.target.files)
    }
    e.target.value = ''
  }, [addImageFiles])

  // Not logged in — show login prompt
  if (!codexLoggedIn) {
    return (
      <div className={styles.panel}>
        <div className={styles.emptyState}>
          <div className={styles.emptyText}>
            Sign in with your ChatGPT account to start chatting with the Codex agent
          </div>
          <Button
            appearance="primary"
            onClick={handleLogin}
            disabled={loginLoading}
          >
            {loginLoading ? 'Signing in...' : 'Sign in with ChatGPT'}
          </Button>
          {loginError && (
            <div className={styles.errorBubble}>{loginError}</div>
          )}
        </div>
      </div>
    )
  }

  // No workspace / worktreePath
  if (!worktreePath) {
    return (
      <div className={styles.panel}>
        <div className={styles.emptyState}>
          <div className={styles.emptyText}>
            Select a thread to start chatting
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      {messages.length === 0 && !loading ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyText}>
            Start a conversation in this thread. The branch for this thread stays fixed.
          </div>
        </div>
      ) : (
        <div className={styles.messages} ref={messagesContainerRef}>
          {renderItems.map((item) => (
            item.kind === 'message' ? (
              <MessageBubble
                key={item.message.id}
                message={item.message}
                onQuestionOptionSelect={handleQuestionOptionSelect}
              />
            ) : (
              <ToolCallsBlock key={item.key} messages={item.messages} />
            )
          ))}
          {loading && <LoadingIndicator />}
          <div ref={messagesEndRef} />
        </div>
      )}

      <div className={styles.inputWrapper}>
        {sessionMode === 'plan' && (
          <div className={styles.planModeBanner}>
            Plan mode active
          </div>
        )}
        <div
          className={`${styles.inputContainer} ${isDragging ? styles.inputContainerDragOver : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <textarea
            ref={textareaRef}
            className={styles.inputField}
            value={input}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={sessionMode === 'plan' ? 'Ask for a plan... (Shift+Tab to toggle)' : 'Ask the agent...'}
            rows={1}
            disabled={loading}
          />

          {/* Image preview row */}
          {attachedImages.length > 0 && (
            <div className={styles.imagePreviewRow}>
              {attachedImages.map((img, i) => (
                <div key={i} className={styles.imageThumb}>
                  <img src={img.previewUrl} alt={img.name} />
                  <button
                    className={styles.imageRemoveBtn}
                    onClick={() => removeImage(i)}
                    title="Remove image"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Toolbar row */}
          <div className={styles.toolbar}>
            <ToolbarDropdown
              value={model}
              options={modelOptions}
              onChange={(v) => {
                setModel(v)
                // Reset thread so next message creates a new one with updated model
                resetRuntimeThreadState()
              }}
              disabled={loading}
            />

            <span className={styles.separator} />

            <ToolbarDropdown
              value={effort}
              options={EFFORT_OPTIONS}
              onChange={(v) => {
                setEffort(v)
                resetRuntimeThreadState()
              }}
              disabled={loading}
            />

            <span className={styles.separator} />

            <ToolbarDropdown
              value={agentPermissionMode}
              options={PERMISSION_OPTIONS}
              onChange={(value) => {
                if (!workspaceId) return
                updateWorkspaceAgentPermissionMode(workspaceId, value as AgentPermissionMode)
                resetRuntimeThreadState()
              }}
              disabled={loading || !workspaceId}
            />

            <div className={styles.toolbarSpacer} />

            {/* Attach button */}
            <button
              className={styles.attachBtn}
              onClick={handleAttachClick}
              disabled={loading}
              title="Attach image"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.5 7.5l-6.4 6.4a3.5 3.5 0 1 1-5-5l6.4-6.4a2.1 2.1 0 1 1 3 3L6.1 11.9a.7.7 0 1 1-1-1l5.7-5.6" />
              </svg>
            </button>

            {/* Send / Stop button */}
            {loading ? (
              <button
                className={`${styles.sendBtn} ${styles.sendBtnStop}`}
                onClick={handleCancel}
                title="Stop"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <rect x="2" y="2" width="10" height="10" rx="1.5" />
                </svg>
              </button>
            ) : (
              <button
                className={styles.sendBtn}
                onClick={handleSend}
                disabled={!input.trim() && attachedImages.length === 0}
                title="Send message"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <path d="M7 1.5v9M3.5 5L7 1.5 10.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                </svg>
              </button>
            )}
          </div>

          {/* Drag overlay */}
          {isDragging && (
            <div className={styles.dragOverlay}>
              Drop image here
            </div>
          )}

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileSelected}
            style={{ display: 'none' }}
          />
        </div>
        {workspace?.branch && (
          <div className={styles.contextRow}>
            <ContextDropdown
              value={branchScope}
              options={branchScopeOptions}
              ariaLabel="Branch source"
              disabled={loading}
              onChange={(value) => setBranchScope(value === 'origin' ? 'origin' : 'local')}
            />
            <ContextDropdown
              value={workspace.branch}
              options={contextBranchDropdownOptions}
              ariaLabel="Branch context"
              align="right"
              disabled={loading || creatingBranch || contextBranchDropdownOptions.length === 0}
              onChange={(value) => {
                if (value === CREATE_BRANCH_OPTION_VALUE) {
                  setCreateBranchBase(workspace.branch || 'main')
                  setCreateBranchName('')
                  setCreateBranchOpen(true)
                  return
                }
                void handleSwitchBranchContext(value)
              }}
            />
          </div>
        )}
      </div>

      <Dialog
        open={createBranchOpen}
        onOpenChange={(_, data) => {
          if (!data.open && !creatingBranch) setCreateBranchOpen(false)
        }}
      >
        <DialogSurface className={styles.createBranchSurface}>
          <DialogBody>
            <DialogTitle>Create branch</DialogTitle>
            <DialogContent className={styles.createBranchContent}>
              <label className={styles.createBranchLabel}>Branch name</label>
              <input
                className={styles.createBranchInput}
                value={createBranchName}
                onChange={(event) => setCreateBranchName(normalizeBranchName(event.target.value))}
                placeholder="feature/my-change"
                disabled={creatingBranch}
              />
              <label className={styles.createBranchLabel}>Base branch</label>
              <input
                className={styles.createBranchInput}
                value={createBranchBase}
                onChange={(event) => setCreateBranchBase(normalizeBranchName(event.target.value))}
                placeholder="main"
                disabled={creatingBranch}
              />
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => setCreateBranchOpen(false)}
                disabled={creatingBranch}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={() => { void handleCreateBranchContext() }}
                disabled={creatingBranch || !createBranchName.trim()}
              >
                {creatingBranch ? 'Creating...' : 'Create branch'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}
