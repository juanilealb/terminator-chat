import { homedir } from 'os'
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'

export const CODEX_DIR = join(homedir(), '.codex')
export const CODEX_CONFIG_PATH = join(CODEX_DIR, 'config.toml')
export const CODEX_MODELS_CACHE_PATH = join(CODEX_DIR, 'models_cache.json')

export interface CodexModelOption {
  value: string
  label: string
}

export async function loadCodexConfigText(): Promise<string> {
  try {
    return await readFile(CODEX_CONFIG_PATH, 'utf-8')
  } catch {
    return ''
  }
}

export async function saveCodexConfigText(contents: string): Promise<void> {
  await mkdir(CODEX_DIR, { recursive: true })
  await writeFile(CODEX_CONFIG_PATH, contents, 'utf-8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function loadCodexModelOptions(): Promise<CodexModelOption[]> {
  try {
    const raw = await readFile(CODEX_MODELS_CACHE_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed) || !Array.isArray(parsed.models)) return []

    const options = parsed.models
      .map((model) => {
        if (!isRecord(model)) return null

        const value = typeof model.slug === 'string' ? model.slug.trim() : ''
        if (!value) return null
        if (!value.toLowerCase().includes('codex')) return null

        const visibility = typeof model.visibility === 'string' ? model.visibility : 'hide'
        const supportedInApi = model.supported_in_api !== false
        if (visibility !== 'list' || !supportedInApi) return null

        const label = typeof model.display_name === 'string' && model.display_name.trim()
          ? model.display_name
          : value

        const priority = typeof model.priority === 'number' ? model.priority : Number.MAX_SAFE_INTEGER
        return { value, label, priority }
      })
      .filter((model): model is { value: string; label: string; priority: number } => model !== null)
      .sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label))

    const deduped: CodexModelOption[] = []
    const seen = new Set<string>()
    for (const option of options) {
      if (seen.has(option.value)) continue
      seen.add(option.value)
      deduped.push({ value: option.value, label: option.label })
    }
    return deduped
  } catch {
    return []
  }
}
