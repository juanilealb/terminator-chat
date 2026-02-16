import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { tmpdir } from 'os'

export const isWindows = true
const DEBUG_PREFIX = '[Terminator Chat]'
let cachedDebugEnabled: boolean | null = null
let cachedDefaultShellProfile: ShellProfile | null = null
let didLogShellResolution = false

export interface ShellProfile {
  shell: string
  args: string[]
  wslAvailable: boolean
}

export function isDebugLoggingEnabled(): boolean {
  if (cachedDebugEnabled !== null) return cachedDebugEnabled
  cachedDebugEnabled =
    typeof process !== 'undefined'
    && !!process.env
    && process.env.TERMINATOR_CHAT_DEBUG === '1'
  return cachedDebugEnabled
}

export function debugLog(message: string, details?: unknown): void {
  if (!isDebugLoggingEnabled()) return
  if (details === undefined) {
    console.log(`${DEBUG_PREFIX} ${message}`)
    return
  }
  console.log(`${DEBUG_PREFIX} ${message}`, details)
}

function commandExists(command: string): boolean {
  try {
    const result = spawnSync('where', [command], { stdio: 'ignore' })
    return result.status === 0
  } catch {
    return false
  }
}

function shellExists(shell: string): boolean {
  const trimmed = shell.trim()
  if (!trimmed) return false
  if (trimmed.includes('\\') || trimmed.includes('/') || trimmed.includes(':')) {
    return existsSync(trimmed)
  }
  return commandExists(trimmed)
}

function normalizeShellName(shell: string): string {
  const normalized = shell.replace(/[\\/]+$/g, '')
  const segments = normalized.split(/[\\/]/)
  const basename = segments[segments.length - 1] || normalized
  return basename.toLowerCase()
}

export function defaultShellArgsFor(shell: string): string[] {
  const shellName = normalizeShellName(shell)
  if (shellName === 'cmd' || shellName === 'cmd.exe') {
    return ['/K', 'chcp 65001>nul']
  }
  if (
    shellName === 'pwsh' ||
    shellName === 'pwsh.exe' ||
    shellName === 'powershell' ||
    shellName === 'powershell.exe'
  ) {
    return ['-NoLogo']
  }
  return []
}

export function resolveDefaultShellProfile(): ShellProfile {
  if (cachedDefaultShellProfile) return cachedDefaultShellProfile

  const windowsShells = ['pwsh.exe', 'powershell.exe', 'cmd.exe']
  const wslAvailable = commandExists('wsl.exe')
  const comSpec = process.env.ComSpec?.trim()
  let resolved = windowsShells.find((shell) => commandExists(shell)) ?? ''

  if (!resolved && comSpec && shellExists(comSpec)) {
    resolved = comSpec
  }
  if (!resolved) {
    resolved = 'cmd.exe'
  }

  cachedDefaultShellProfile = {
    shell: resolved,
    args: defaultShellArgsFor(resolved),
    wslAvailable,
  }

  if (!didLogShellResolution) {
    didLogShellResolution = true
    debugLog('Resolved default shell', {
      shell: resolved,
      args: cachedDefaultShellProfile.args,
      candidates: windowsShells,
      comSpec,
      wslAvailable,
    })
  }
  return cachedDefaultShellProfile
}

export function resolveDefaultShell(): string {
  return resolveDefaultShellProfile().shell
}

export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/')
}

export function basenameSafe(p: string): string {
  const normalized = p.replace(/[\\/]+$/g, '')
  const segments = normalized.split(/[\\/]/)
  return segments[segments.length - 1] || normalized
}

export function formatShortcut(_mac: string, win: string): string {
  return win
}

export function getTempDir(): string {
  return tmpdir()
}
