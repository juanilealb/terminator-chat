import { toPosixPath } from '@shared/platform'
import type { Workspace } from '../store/types'

const FILE_MENTION_RE = /^file:(.+)$/i
const MAX_FILE_CONTEXT_CHARS = 12000
const TRAILING_FILE_PUNCTUATION_RE = /[),.;!?]+$/

function stripMatchingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function joinWorkspacePath(worktreePath: string, relativePath: string): string {
  const base = worktreePath.replace(/[\\/]+$/, '')
  const cleaned = relativePath.replace(/^\.?[\\/]+/, '')
  return `${base}/${cleaned.replace(/\\/g, '/')}`
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function normalizeLegacyTemplateMentions(template: string): string {
  return template
    .replace(/\{\{\s*(workspace|branch|path|memory|date)\s*\}\}/gi, (_match, token: string) => `@${token.toLowerCase()}`)
    .replace(/\{\{\s*file\s*:\s*([^}]+?)\s*\}\}/gi, (_match, path: string) => `@file:${path.trim()}`)
}

function sanitizeFileMentionPath(value: string): string {
  const stripped = stripMatchingQuotes(value.trim())
  if (!stripped) return ''
  return stripped.replace(TRAILING_FILE_PUNCTUATION_RE, '')
}

export function normalizePreviewUrl(rawValue: string): string {
  const value = rawValue.trim()
  if (!value) return ''
  if (/^\d+$/.test(value)) return `http://localhost:${value}`
  if (/^[\w.-]+:\d+$/.test(value)) return `http://${value}`
  if (/^https?:\/\//i.test(value)) return value
  return `http://${value}`
}

export async function expandPromptTemplate(
  template: string,
  workspace: Workspace | undefined
): Promise<string> {
  const tokenRegex = /@([a-zA-Z][a-zA-Z0-9_-]*(?::(?:"[^"]+"|'[^']+'|[^\s]+))?)/g
  const source = normalizeLegacyTemplateMentions(template)
  const parts: string[] = []
  let cursor = 0

  for (const match of source.matchAll(tokenRegex)) {
    const index = match.index ?? 0
    parts.push(source.slice(cursor, index))
    const token = match[1] ?? ''
    const lower = token.toLowerCase()

    if (!workspace) {
      parts.push(match[0] ?? '')
      cursor = index + (match[0]?.length ?? 0)
      continue
    }

    if (lower === 'workspace') {
      parts.push(workspace.name)
    } else if (lower === 'branch') {
      parts.push(workspace.branch || 'local')
    } else if (lower === 'path') {
      parts.push(toPosixPath(workspace.worktreePath))
    } else if (lower === 'memory') {
      parts.push(workspace.memory?.trim() || '')
    } else if (lower === 'date') {
      parts.push(new Date().toISOString())
    } else {
      const fileMatch = token.match(FILE_MENTION_RE)
      if (fileMatch?.[1]) {
        const relativePath = sanitizeFileMentionPath(fileMatch[1])
        if (!relativePath) {
          parts.push(match[0] ?? '')
        } else {
          try {
            const absolutePath = joinWorkspacePath(workspace.worktreePath, relativePath)
            const content = normalizeLineEndings(await window.api.fs.readFile(absolutePath))
            const excerpt = content.length > MAX_FILE_CONTEXT_CHARS
              ? `${content.slice(0, MAX_FILE_CONTEXT_CHARS)}\n...[truncated]`
              : content
            parts.push(`\n[FILE ${relativePath}]\n${excerpt}\n[/FILE]\n`)
          } catch {
            parts.push(`[Missing file: ${relativePath}]`)
          }
        }
      } else {
        parts.push(match[0] ?? '')
      }
    }

    cursor = index + (match[0]?.length ?? 0)
  }

  parts.push(source.slice(cursor))
  return parts.join('')
}
