# CLAUDE.md

Terminator Chat — Windows desktop app for conversational AI coding with Codex SDK, integrated Monaco editor, git worktrees, and GitHub integration.

## Repo Structure

Monorepo with root package.json delegating to `desktop/`.

```
terminator-chat/
├── package.json          # Root scripts (proxy to desktop/)
└── desktop/              # Electron app (all source code lives here)
    ├── src/main/         # Main process: git, file, codex, github services, IPC
    ├── src/preload/      # contextBridge (window.api)
    ├── src/renderer/     # React UI (components, store, hooks)
    ├── src/shared/       # IPC channel constants, platform utils (@shared alias)
    ├── claude-hooks/     # Claude Code notification/activity hook scripts
    ├── codex-hooks/      # Codex notification hook scripts
    ├── e2e/              # Playwright tests
    └── USAGE.md          # Detailed app usage guide
```

## Commands

All commands run from repo root via bun:

```bash
bun run dev       # Dev server + Electron
bun run build     # Production build
bun run test      # Playwright e2e tests
bun run rebuild   # Rebuild native modules
bun run dist:win  # Package Windows installer (NSIS)
```

## Tech Stack

Electron 40 · React 19 · TypeScript (strict) · Zustand · Monaco Editor · @openai/codex-sdk · Fluent UI · electron-vite · Playwright · bun

## Architecture

### Main Process (`src/main/`)
- `index.ts` — App entry, window creation, theme detection, single instance lock
- `ipc.ts` — ~60 IPC handlers bridging renderer to services
- `codex-service.ts` — Codex SDK wrapper (lazy-loaded, thread management, streaming events)
- `openai-auth.ts` — OAuth token storage/refresh from `~/.codex/auth.json`
- `git-service.ts` — Git CLI operations (worktrees, staging, branching, PRs via `gh`)
- `github-service.ts` — GitHub GraphQL API (PR statuses, review threads, auth accounts)
- `file-service.ts` — File tree enumeration, read/write
- `notification-watcher.ts` — Polls temp dir markers from agent hooks (500ms interval)
- `claude-config.ts` / `codex-config.ts` — Hook install/uninstall in agent config files

### Renderer (`src/renderer/`)
- **Store**: Zustand in `store/app-store.ts` (~1100 lines). State + actions + persistence.
- **Key components**:
  - `ChatPanel.tsx` (~1750 lines) — Codex chat with streaming, interactive questions, file drops
  - `Sidebar.tsx` (~1520 lines) — Project/workspace tree, PR status, context menus
  - `RightPanel/` — File tree, git changes (staging UI), workspace memory, snapshots
  - `Editor/` — Monaco file editor + diff viewer
- **Hooks**: `useShortcuts`, `usePrStatusPoller`, `useFocusTrap`

### IPC Pattern
Constants in `shared/ipc-channels.ts` → Handlers in `main/ipc.ts` → Bridge in `preload/index.ts` → Consumed via `window.api.*` in renderer.

### Alias
`@shared` resolves to `src/shared/` (with renderer getting `platform.renderer.ts` instead of `platform.ts` via electron-vite config).

## Git Conventions

- Commit style: `type: description` (e.g. `feat:`, `fix:`, `chore:`)
- Branch from `main`
- Package manager: **bun** (not npm/pnpm/yarn)

## Key Patterns

- **Codex SDK is lazy-loaded** — `codex-service.ts` imports `@openai/codex-sdk` dynamically so the app works even if the SDK fails to load
- **Context isolation** — `nodeIntegration: false`, `contextIsolation: true`. All IPC goes through the context bridge.
- **State persistence** — Debounced JSON save to userData + synchronous save on `beforeunload`. Sanitizes stale workspace paths on load.
- **Agent hooks** — Filesystem markers in temp dir. Notification watcher polls and emits IPC events to renderer.
- **PR status** — Burst polling with visibility API awareness (`usePrStatusPoller`)

## Testing

Playwright e2e tests in `desktop/e2e/`. Run with `bun run test`.

Key test files: `git-staging.spec.ts`, `shortcuts.spec.ts`, `codex-activity-indicator.spec.ts`, `pr-status.spec.ts`, `ipc-persistence.spec.ts`.

No unit tests currently — services and store are tested only through e2e.
