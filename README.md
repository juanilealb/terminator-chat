# Terminator Chat

A Windows desktop app for conversational AI coding with integrated chat, code editor, and git — powered by [OpenAI Codex SDK](https://github.com/openai/codex).

> **Origin:** Evolved from the [Terminator](https://github.com/owengretzinger/terminator) project by [@owengretzinger](https://github.com/owengretzinger). Terminator Chat replaces the terminal-based workflow with a chat-first interface built on the Codex SDK.

---

## What It Does

Open any git repo, create isolated workspaces (git worktrees), and chat with Codex to write, review, and ship code — all from one window.

### Core Features

- **Chat with Codex** — Streaming conversation threads via the Codex SDK. Supports code execution, file changes, web search, MCP tool calls, reasoning traces, and interactive questions from the agent.
- **Multi-workspace** — Each workspace is a git worktree with its own branch. Work on multiple features in parallel without conflicts.
- **Monaco code editor** — View and edit files with syntax highlighting. Inline diff viewer for staged/unstaged changes.
- **Git integration** — Stage, unstage, discard, commit, push, create PRs, and ship branches to main. Full worktree lifecycle management.
- **GitHub integration** — PR status checks (CI, reviews, merge state) via GraphQL API. Multiple `gh auth` accounts supported.
- **File tree** — Browse project files with git status indicators (modified, added, untracked). Respects `.gitignore`.
- **Workspace memory** — Persistent notes per workspace, injected into prompts via `@memory` template.
- **Prompt templates** — Mention-aware expansion: `@workspace`, `@branch`, `@file:path/to/file`, `@memory`, `@date`.
- **Snapshots** — Checkpoint your workspace state (backed by `git stash`). Create, restore, and delete snapshots from the command palette.
- **Agent hooks** — Claude Code and Codex activity/notification hooks. Unread indicators and activity spinners per workspace.
- **Command palette** — Fuzzy command search (`Ctrl+Shift+P`) with slash commands for snapshots, memory, and workspace actions.
- **Quick Open** — Fuzzy file search (`Ctrl+P`) across the active workspace.
- **Settings** — Theme (dark/light/system), font size, GitHub account mapping (personal/work), prompt template CRUD, agent permission modes, hook management.
- **Windows native** — Custom title bar, NSIS installer with "Open in Terminator Chat" context menu, taskbar jump list, badge overlay for unread notifications.

---

## Getting Started

### Prerequisites

- **Windows 10/11**
- **[Bun](https://bun.sh)** (package manager & runtime)
- **[Git](https://git-scm.com/download/win)**
- **[OpenAI Codex CLI](https://github.com/openai/codex)** — The chat feature authenticates via the Codex CLI's OAuth flow

Optional:
- **[GitHub CLI (`gh`)](https://cli.github.com/)** — For PR status, creating PRs, and GitHub account management
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** — For Claude hook integration

### Install & Run

```bash
git clone https://github.com/juanilealb/terminator-chat.git
cd terminator-chat

bun run setup    # Install dependencies
bun run dev      # Start in dev mode
```

### Build & Package

```bash
bun run build      # Production build
bun run dist:win   # Package as Windows installer (NSIS)
```

### Run Tests

```bash
bun run test       # Playwright e2e tests
```

---

## Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Quick Open file | `Ctrl+P` |
| Command palette | `Ctrl+Shift+P` |
| New chat thread | `Ctrl+T` |
| Close tab | `Ctrl+W` |
| Close all tabs | `Ctrl+Shift+W` |
| Next / Previous tab | `Ctrl+Shift+]` / `Ctrl+Shift+[` |
| Jump to tab 1–9 | `Ctrl+1..9` |
| New workspace | `Ctrl+N` |
| Next / Previous workspace | `Ctrl+Shift+↓` / `Ctrl+Shift+↑` |
| Toggle sidebar | `Ctrl+B` |
| Toggle right panel | `Ctrl+Alt+B` |
| Files panel | `Ctrl+Shift+E` |
| Changes panel | `Ctrl+Shift+G` |
| Memory panel | `Ctrl+Shift+M` |
| Focus chat | `Ctrl+J` |
| Commit staged changes | `Ctrl+Enter` |
| Settings | `Ctrl+,` |
| Zoom in / out / reset | `Ctrl++` / `Ctrl+-` / `Ctrl+0` |

---

## How It Works

### Projects & Workspaces

1. **Open a project** — Any local git repository.
2. **Create workspaces** — Each workspace is a git worktree with its own branch, allowing isolated parallel work.
3. **Chat with Codex** — Each workspace can have multiple chat threads. The agent executes code, modifies files, and searches the web within the workspace's worktree.
4. **Review & ship** — Use the built-in git staging UI to review changes, commit, push, and create PRs.

### Agent Integration

Terminator Chat integrates with **Claude Code** and **OpenAI Codex** through hook scripts:

- **Notification hooks** — Agents signal when they finish or need input. Triggers native Windows notifications and unread badges.
- **Activity hooks** — Agents signal when they're actively running. Shows spinners in the sidebar per workspace.
- Hooks are installed/uninstalled from Settings. They modify `~/.claude/settings.json` (Claude) and `~/.codex/config.toml` (Codex).

### Codex SDK Authentication

The chat feature uses the [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk) which authenticates via OpenAI's OAuth device flow. On first use, the app opens a browser for login. Tokens are stored in `~/.codex/auth.json` and refreshed automatically.

### Debug Mode

```bash
set TERMINATOR_DEBUG=1
bun run dev
```

Logs platform info, hook operations, git status, IPC calls, and path normalization.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Electron 40 |
| UI | React 19 + TypeScript (strict) |
| State | Zustand |
| Editor | Monaco Editor |
| Chat | @openai/codex-sdk |
| Styling | Fluent UI (React Components) + CSS Modules |
| Build | electron-vite + Bun |
| Packaging | electron-builder (NSIS) |
| Tests | Playwright (e2e) |

---

## Project Structure

```
terminator-chat/
├── package.json                # Root scripts (proxy to desktop/)
└── desktop/
    ├── src/
    │   ├── main/               # Main process
    │   │   ├── index.ts        # App entry, window creation, theme
    │   │   ├── ipc.ts          # IPC handlers (~60 channels)
    │   │   ├── git-service.ts  # Git + gh CLI operations
    │   │   ├── github-service.ts # GitHub GraphQL API (PR status, accounts)
    │   │   ├── file-service.ts # File tree, read/write
    │   │   ├── codex-service.ts # Codex SDK wrapper (threads, streaming)
    │   │   ├── openai-auth.ts  # OAuth token management
    │   │   ├── claude-config.ts # Claude settings.json manipulation
    │   │   ├── codex-config.ts # Codex config.toml manipulation
    │   │   ├── notification-watcher.ts # Hook marker polling
    │   │   └── window-state.ts # Window position persistence
    │   ├── preload/
    │   │   └── index.ts        # Context bridge (window.api)
    │   ├── renderer/
    │   │   ├── App.tsx         # Root component, theme, layout
    │   │   ├── store/          # Zustand store + types
    │   │   ├── components/
    │   │   │   ├── Chat/       # ChatPanel, NewThreadDialog
    │   │   │   ├── Sidebar/    # Project/workspace tree, dialogs
    │   │   │   ├── Editor/     # Monaco file editor, diff viewer
    │   │   │   ├── RightPanel/ # File tree, git changes, memory
    │   │   │   ├── Settings/   # Settings panel
    │   │   │   ├── CommandPalette/
    │   │   │   ├── QuickOpen/
    │   │   │   ├── TabBar/
    │   │   │   └── Toast/
    │   │   ├── hooks/          # useShortcuts, usePrStatusPoller, useFocusTrap
    │   │   ├── utils/          # Prompt templates, git events, github profile
    │   │   └── styles/         # Design tokens, global CSS
    │   └── shared/             # IPC channels, platform utils, shortcuts, types
    ├── claude-hooks/           # Claude Code hook scripts (.js)
    ├── codex-hooks/            # Codex hook scripts (.js)
    ├── e2e/                    # Playwright e2e tests
    ├── electron-builder.yml    # Windows build config
    └── USAGE.md                # Detailed usage guide
```

---

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Commit with conventional commits (`feat:`, `fix:`, `chore:`)
4. Push and open a PR

---

## Credits

- Original [Terminator](https://github.com/owengretzinger/terminator) project by [@owengretzinger](https://github.com/owengretzinger)
- Terminator Chat by [@Juanilealb](https://github.com/Juanilealb)

---

## License

ISC
