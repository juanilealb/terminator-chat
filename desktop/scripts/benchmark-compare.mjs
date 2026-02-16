import { _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, basename, resolve } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const repoRoot = resolve(__dirname, '..', '..')
const siblingRepoRoot = resolve(repoRoot, '..', 'terminator')
const outputDir = resolve(repoRoot, 'desktop', 'benchmark-results')

const iterations = Number.parseInt(process.env.BENCH_ITERATIONS ?? '5', 10)
const timeoutMs = Number.parseInt(process.env.BENCH_TIMEOUT_MS ?? '20000', 10)
const firstWindowTimeoutMs = Number.parseInt(process.env.BENCH_FIRST_WINDOW_TIMEOUT_MS ?? '60000', 10)

if (!Number.isFinite(iterations) || iterations < 1) {
  throw new Error(`Invalid BENCH_ITERATIONS value: ${process.env.BENCH_ITERATIONS ?? '<empty>'}`)
}

const apps = [
  {
    id: 'terminator-fluent',
    repoPath: repoRoot,
    appPath: resolve(repoRoot, 'desktop', 'out', 'main', 'index.js'),
  },
  {
    id: 'terminator',
    repoPath: siblingRepoRoot,
    appPath: resolve(siblingRepoRoot, 'desktop', 'out', 'main', 'index.js'),
  },
]

for (const app of apps) {
  if (!existsSync(app.repoPath)) {
    throw new Error(`Repo not found: ${app.repoPath}`)
  }
  if (!existsSync(app.appPath)) {
    throw new Error(`Build artifact missing: ${app.appPath}. Run build first.`)
  }
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    const details = [
      `Command failed: ${command} ${args.join(' ')}`,
      `cwd: ${cwd}`,
      `stdout: ${result.stdout ?? ''}`,
      `stderr: ${result.stderr ?? ''}`,
    ].join('\n')
    throw new Error(details)
  }
}

function createTempRepo(label) {
  const repoPath = join(
    tmpdir(),
    `terminator-bench-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  const remotePath = join(
    tmpdir(),
    `terminator-bench-remote-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.git`
  )

  mkdirSync(repoPath, { recursive: true })
  writeFileSync(join(repoPath, 'README.md'), '# Benchmark repo\n')
  mkdirSync(join(repoPath, 'src'), { recursive: true })
  writeFileSync(join(repoPath, 'src', 'index.ts'), 'export const value = 1\n')

  runCommand('git', ['init'], repoPath)
  runCommand('git', ['checkout', '-b', 'main'], repoPath)
  runCommand('git', ['add', '.'], repoPath)
  runCommand(
    'git',
    ['-c', 'user.name=Benchmark Bot', '-c', 'user.email=benchmark@example.com', 'commit', '-m', 'initial commit'],
    repoPath
  )
  runCommand('git', ['init', '--bare', remotePath], repoPath)
  runCommand('git', ['remote', 'add', 'origin', remotePath], repoPath)
  runCommand('git', ['-c', 'core.hooksPath=/dev/null', 'push', '-u', 'origin', 'main'], repoPath)

  return { repoPath, remotePath }
}

function cleanupRepoArtifacts(repoPath, remotePath) {
  try {
    if (existsSync(repoPath)) {
      rmSync(repoPath, { recursive: true, force: true })
    }
    if (remotePath && existsSync(remotePath)) {
      rmSync(remotePath, { recursive: true, force: true })
    }

    const parent = resolve(repoPath, '..')
    const prefix = `${basename(repoPath)}-ws-`
    for (const entry of readdirSync(parent)) {
      if (entry.startsWith(prefix)) {
        rmSync(join(parent, entry), { recursive: true, force: true })
      }
    }
  } catch {
    // Best effort cleanup.
  }
}

function startTimer() {
  return process.hrtime.bigint()
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function summarize(values) {
  if (values.length === 0) {
    return { count: 0, mean: 0, median: 0, min: 0, max: 0 }
  }
  const total = values.reduce((sum, value) => sum + value, 0)
  return {
    count: values.length,
    mean: total / values.length,
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  }
}

function formatMs(value) {
  return `${value.toFixed(1)} ms`
}

async function runSingleBenchmark(app, runIndex) {
  const repoArtifacts = createTempRepo(`${app.id}-${runIndex}`)
  const repoPath = repoArtifacts.repoPath
  const run = {
    appId: app.id,
    runIndex,
    metrics: {},
    notes: [],
    success: true,
  }

  let appProcess = null
  let window = null
  let terminalPtyId = null

  try {
    const launchStart = startTimer()
    const appEnv = { ...process.env }
    const profileSuffix = `bench-${process.pid}-${runIndex}-${Date.now()}`
    if (app.id === 'terminator-fluent') {
      appEnv.TERMINATOR_FLUENT_PROFILE = profileSuffix
    } else {
      appEnv.TERMINATOR_PROFILE = profileSuffix
    }

    appProcess = await electron.launch({
      args: [app.appPath],
      cwd: join(app.repoPath, 'desktop'),
      env: appEnv,
    })
    window = await appProcess.firstWindow({ timeout: firstWindowTimeoutMs })
    await window.waitForLoadState('domcontentloaded', { timeout: timeoutMs })
    await window.waitForSelector('#root', { timeout: timeoutMs })
    run.metrics.launchMs = elapsedMs(launchStart)

    const projectName = `perf-project-${runIndex}`
    const workspaceName = `perf-ws-${runIndex}`
    const branchName = `perf-branch-${runIndex}`

    const addProjectStart = startTimer()
    const projectId = await window.evaluate(({ currentRepoPath, currentProjectName }) => {
      const store = window.__store.getState()
      store.hydrateState({ projects: [], workspaces: [] })
      const id = crypto.randomUUID()
      store.addProject({ id, name: currentProjectName, repoPath: currentRepoPath })
      return id
    }, { currentRepoPath: repoPath, currentProjectName: projectName })
    await window.locator('[class*="projectHeader"]', { hasText: projectName }).first().waitFor({ state: 'visible', timeout: timeoutMs })
    run.metrics.projectAddUiMs = elapsedMs(addProjectStart)

    const createWorkspaceStart = startTimer()
    const workspaceData = await window.evaluate(
      async ({ currentRepoPath, currentProjectId, currentWorkspaceName, currentBranchName }) => {
        const store = window.__store.getState()
        const worktreePath = await window.api.git.createWorktree(
          currentRepoPath,
          currentWorkspaceName,
          currentBranchName,
          true
        )
        const workspaceId = crypto.randomUUID()
        store.addWorkspace({
          id: workspaceId,
          name: currentWorkspaceName,
          branch: currentBranchName,
          worktreePath,
          projectId: currentProjectId,
        })
        return { workspaceId, worktreePath }
      },
      {
        currentRepoPath: repoPath,
        currentProjectId: projectId,
        currentWorkspaceName: workspaceName,
        currentBranchName: branchName,
      }
    )
    await window.locator('[class*="workspaceItem"]', { hasText: branchName }).first().waitFor({ state: 'visible', timeout: timeoutMs })
    run.metrics.workspaceCreateMs = elapsedMs(createWorkspaceStart)

    const openTerminalStart = startTimer()
    const terminalData = await window.evaluate(async ({ workspaceId, worktreePath }) => {
      const store = window.__store.getState()
      const ptyId = await window.api.pty.create(worktreePath, 'powershell.exe')
      store.addTab({
        id: crypto.randomUUID(),
        workspaceId,
        type: 'terminal',
        title: 'Terminal',
        ptyId,
      })
      return { ptyId }
    }, workspaceData)
    terminalPtyId = terminalData.ptyId
    await window.locator('[class*="tabTitle"]', { hasText: 'Terminal' }).first().waitFor({ state: 'visible', timeout: timeoutMs })
    run.metrics.terminalOpenUiMs = elapsedMs(openTerminalStart)

    const echoToken = `PERF_ECHO_${runIndex}`
    const echoStart = startTimer()
    const gotEcho = await window.evaluate(({ ptyId, token, currentTimeoutMs }) => {
      return new Promise((resolve) => {
        const unsubscribe = window.api.pty.onData(ptyId, (data) => {
          if (typeof data === 'string' && data.includes(token)) {
            unsubscribe()
            resolve(true)
          }
        })

        window.api.pty.write(ptyId, `Write-Output ${token}\r`)

        setTimeout(() => {
          unsubscribe()
          resolve(false)
        }, currentTimeoutMs)
      })
    }, { ptyId: terminalData.ptyId, token: echoToken, currentTimeoutMs: timeoutMs })
    run.metrics.terminalEchoRttMs = elapsedMs(echoStart)
    if (!gotEcho) {
      run.success = false
      run.notes.push('Terminal echo token not observed before timeout')
    }

    const gitStatusStart = startTimer()
    await window.evaluate(async ({ worktreePath }) => {
      return await window.api.git.getStatus(worktreePath)
    }, { worktreePath: workspaceData.worktreePath })
    run.metrics.gitStatusMs = elapsedMs(gitStatusStart)

    const fileTreeStart = startTimer()
    await window.evaluate(async ({ worktreePath }) => {
      return await window.api.fs.getTree(worktreePath)
    }, { worktreePath: workspaceData.worktreePath })
    run.metrics.fileTreeMs = elapsedMs(fileTreeStart)
  } catch (error) {
    run.success = false
    run.notes.push(String(error))
  } finally {
    if (window && terminalPtyId) {
      try {
        await window.evaluate((ptyId) => {
          window.api.pty.destroy(ptyId)
        }, terminalPtyId)
      } catch {
        // Ignore cleanup failures.
      }
    }
    if (appProcess) {
      try {
        await appProcess.close()
      } catch {
        // Ignore close failures.
      }
    }
    cleanupRepoArtifacts(repoArtifacts.repoPath, repoArtifacts.remotePath)
  }

  return run
}

function collectMetricRuns(runs, metricName) {
  return runs
    .map((run) => run.metrics[metricName])
    .filter((value) => Number.isFinite(value))
}

function summarizeAppRuns(runs) {
  const metricNames = [
    'launchMs',
    'projectAddUiMs',
    'workspaceCreateMs',
    'terminalOpenUiMs',
    'terminalEchoRttMs',
    'gitStatusMs',
    'fileTreeMs',
  ]

  const summary = {}
  for (const metricName of metricNames) {
    summary[metricName] = summarize(collectMetricRuns(runs, metricName))
  }
  summary.failures = runs.filter((run) => !run.success).length
  return summary
}

function renderSummaryMarkdown(result) {
  const fluent = result.summary['terminator-fluent']
  const classic = result.summary.terminator

  const metricMeta = [
    ['launchMs', 'Abrir app'],
    ['projectAddUiMs', 'Agregar proyecto (UI visible)'],
    ['workspaceCreateMs', 'Crear workspace'],
    ['terminalOpenUiMs', 'Abrir terminal (UI visible)'],
    ['terminalEchoRttMs', 'Latencia comando terminal'],
    ['gitStatusMs', 'Git status'],
    ['fileTreeMs', 'Cargar árbol de archivos'],
  ]

  const lines = []
  lines.push(`# Benchmark comparativo`)
  lines.push('')
  lines.push(`Fecha: ${result.generatedAt}`)
  lines.push(`Iteraciones por app: ${result.iterations}`)
  lines.push('')
  lines.push(`| Métrica | Terminator Fluent (mean) | Terminator (mean) | Mejora Fluent |`)
  lines.push(`|---|---:|---:|---:|`)

  for (const [metricKey, label] of metricMeta) {
    const fluentMean = fluent[metricKey].mean
    const classicMean = classic[metricKey].mean
    const improvement = classicMean > 0 ? ((classicMean - fluentMean) / classicMean) * 100 : 0
    const improvementLabel = `${improvement >= 0 ? '+' : ''}${improvement.toFixed(1)}%`
    lines.push(`| ${label} | ${formatMs(fluentMean)} | ${formatMs(classicMean)} | ${improvementLabel} |`)
  }

  lines.push('')
  lines.push(`Fallas Terminator Fluent: ${fluent.failures}`)
  lines.push(`Fallas Terminator: ${classic.failures}`)
  lines.push('')
  lines.push(`Notas:`)
  lines.push(`- Menor tiempo es mejor en todas las métricas.`)
  lines.push(`- El orden por ronda se alternó para reducir sesgo de caché/calor.`)

  return lines.join('\n')
}

async function main() {
  console.log(`Running benchmark with ${iterations} iterations per app...`)

  const runsByApp = {
    'terminator-fluent': [],
    terminator: [],
  }

  let globalRun = 0
  for (let round = 1; round <= iterations; round += 1) {
    const roundOrder = round % 2 === 1 ? [apps[0], apps[1]] : [apps[1], apps[0]]
    for (const app of roundOrder) {
      globalRun += 1
      const appRunIndex = runsByApp[app.id].length + 1
      console.log(`[run ${globalRun}] ${app.id} iteration ${appRunIndex}/${iterations}`)
      const run = await runSingleBenchmark(app, appRunIndex)
      runsByApp[app.id].push(run)
      const launchValue = run.metrics.launchMs
      if (Number.isFinite(launchValue)) {
        console.log(`  launch: ${formatMs(launchValue)}`)
      }
      if (!run.success) {
        console.log(`  failed: ${run.notes.join(' | ')}`)
      }
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    iterations,
    timeoutMs,
    firstWindowTimeoutMs,
    runsByApp,
    summary: {
      'terminator-fluent': summarizeAppRuns(runsByApp['terminator-fluent']),
      terminator: summarizeAppRuns(runsByApp.terminator),
    },
  }

  mkdirSync(outputDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = join(outputDir, `compare-speed-${stamp}.json`)
  const markdownPath = join(outputDir, `compare-speed-${stamp}.md`)

  writeFileSync(jsonPath, JSON.stringify(result, null, 2))
  writeFileSync(markdownPath, renderSummaryMarkdown(result))

  console.log('')
  console.log(`Benchmark complete.`)
  console.log(`JSON: ${jsonPath}`)
  console.log(`Markdown: ${markdownPath}`)
}

await main()
