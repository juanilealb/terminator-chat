import { readFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'

// Token is stored where the Codex CLI expects it
const AUTH_DIR = join(homedir(), '.codex')
const AUTH_FILE = join(AUTH_DIR, 'auth.json')

// Refresh 5 minutes before expiry
const REFRESH_MARGIN_MS = 5 * 60 * 1000

interface StoredTokens {
  access_token: string
  refresh_token: string
  expires_at: number
}

/**
 * Decode a JWT payload (no verification) to extract claims like `exp`.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8')
    return JSON.parse(payload) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Read tokens from ~/.codex/auth.json.
 * Handles the Codex CLI format: { tokens: { access_token, refresh_token, ... } }
 */
function readTokens(): StoredTokens | null {
  try {
    if (!existsSync(AUTH_FILE)) return null
    const raw = readFileSync(AUTH_FILE, 'utf-8')
    const data = JSON.parse(raw) as Record<string, unknown>

    // Codex CLI format: tokens are nested under a "tokens" key
    const tokens = data.tokens as Record<string, unknown> | undefined
    if (
      tokens &&
      typeof tokens.access_token === 'string' &&
      typeof tokens.refresh_token === 'string'
    ) {
      // Extract expiry from the JWT's exp claim
      let expiresAt = 0
      const claims = decodeJwtPayload(tokens.access_token)
      if (claims && typeof claims.exp === 'number') {
        expiresAt = claims.exp * 1000 // JWT exp is in seconds
      }
      return {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
      }
    }

    return null
  } catch {
    return null
  }
}

export function getStoredToken(): { accessToken: string; refreshToken: string; expiresAt: number } | null {
  const tokens = readTokens()
  if (!tokens) return null
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_at,
  }
}

export function isLoggedIn(): boolean {
  return readTokens() !== null
}

export function logout(): void {
  try {
    if (existsSync(AUTH_FILE)) unlinkSync(AUTH_FILE)
  } catch {
    // ignore
  }
}

export async function refreshIfNeeded(): Promise<string> {
  const tokens = readTokens()
  if (!tokens) throw new Error('Not logged in')

  if (tokens.expires_at > 0 && Date.now() < tokens.expires_at - REFRESH_MARGIN_MS) {
    return tokens.access_token
  }

  // Let the Codex CLI handle refresh — run `codex login status` which triggers
  // a refresh if needed, then re-read the updated auth.json
  try {
    await runCodexLogin()
  } catch {
    // If CLI refresh fails, return the current token and let the SDK try
  }

  const refreshed = readTokens()
  return refreshed?.access_token ?? tokens.access_token
}

/**
 * Find the Codex CLI binary bundled with @openai/codex.
 */
function findCodexBinary(): string | null {
  const platform = process.platform
  const arch = process.arch

  let packageName: string | null = null
  if (platform === 'win32' && arch === 'x64') packageName = '@openai/codex-win32-x64'
  else if (platform === 'win32' && arch === 'arm64') packageName = '@openai/codex-win32-arm64'
  else if (platform === 'darwin' && arch === 'x64') packageName = '@openai/codex-darwin-x64'
  else if (platform === 'darwin' && arch === 'arm64') packageName = '@openai/codex-darwin-arm64'
  else if (platform === 'linux' && arch === 'x64') packageName = '@openai/codex-linux-x64'
  else if (platform === 'linux' && arch === 'arm64') packageName = '@openai/codex-linux-arm64'

  if (!packageName) return null

  // Try to find it relative to this module
  const targets: Record<string, string> = {
    '@openai/codex-win32-x64': 'x86_64-pc-windows-msvc',
    '@openai/codex-win32-arm64': 'aarch64-pc-windows-msvc',
    '@openai/codex-darwin-x64': 'x86_64-apple-darwin',
    '@openai/codex-darwin-arm64': 'aarch64-apple-darwin',
    '@openai/codex-linux-x64': 'x86_64-unknown-linux-musl',
    '@openai/codex-linux-arm64': 'aarch64-unknown-linux-musl',
  }

  const target = targets[packageName]
  if (!target) return null

  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex'

  // Try common node_modules locations
  const candidates = [
    join(__dirname, '..', '..', 'node_modules', packageName, 'vendor', target, 'codex', binaryName),
    join(__dirname, '..', '..', '..', 'node_modules', packageName, 'vendor', target, 'codex', binaryName),
  ]

  // Also try require.resolve
  try {
    const pkgJson = require.resolve(`${packageName}/package.json`)
    const pkgDir = join(pkgJson, '..')
    candidates.unshift(join(pkgDir, 'vendor', target, 'codex', binaryName))
  } catch {
    // package not installed
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return null
}

/**
 * Run `codex login` and wait for it to complete.
 * The CLI handles the full OAuth flow (opens browser, token exchange, writes auth.json).
 */
function runCodexLogin(): Promise<void> {
  return new Promise((resolve, reject) => {
    const binary = findCodexBinary()
    if (!binary) {
      reject(new Error('Codex CLI binary not found. Install @openai/codex package.'))
      return
    }

    console.log(`[OpenAI Auth] Running: ${binary} login`)
    const child = spawn(binary, ['login'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
      console.log('[OpenAI Auth] stdout:', data.toString().trim())
    })
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
      console.log('[OpenAI Auth] stderr:', data.toString().trim())
    })

    child.on('error', (err) => {
      console.error('[OpenAI Auth] Failed to spawn codex:', err)
      reject(err)
    })

    child.on('close', (code) => {
      if (code === 0) {
        console.log('[OpenAI Auth] Login completed successfully')
        resolve()
      } else {
        reject(new Error(`codex login exited with code ${code}: ${stderr || stdout}`))
      }
    })

    // Timeout after 5 minutes
    setTimeout(() => {
      child.kill()
      reject(new Error('Login timed out'))
    }, 5 * 60 * 1000)
  })
}

export async function login(): Promise<{ accessToken: string }> {
  // First check if already logged in
  const existing = readTokens()
  if (existing) {
    return { accessToken: existing.access_token }
  }

  // Use the Codex CLI binary for login — it handles the full OAuth flow
  await runCodexLogin()

  // Re-read tokens after CLI completes
  const tokens = readTokens()
  if (!tokens) {
    throw new Error('Login completed but no tokens found. Try running `codex login` from terminal.')
  }

  return { accessToken: tokens.access_token }
}
