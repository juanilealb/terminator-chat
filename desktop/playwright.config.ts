import { defineConfig } from '@playwright/test'

process.env.GIT_AUTHOR_NAME ??= 'Terminator Chat E2E'
process.env.GIT_AUTHOR_EMAIL ??= 'terminator-chat-e2e@example.com'
process.env.GIT_COMMITTER_NAME ??= process.env.GIT_AUTHOR_NAME
process.env.GIT_COMMITTER_EMAIL ??= process.env.GIT_AUTHOR_EMAIL

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  // Run tests serially to avoid multiple Electron windows fighting for focus
  workers: 1,
  projects: [
    {
      name: 'electron',
    },
  ],
})
