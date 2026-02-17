import { useEffect, useState, useCallback, useRef, memo } from 'react'
import { PatchDiff } from '@pierre/diffs/react'
import { basenameSafe, toPosixPath } from '@shared/platform'
import { useAppStore } from '../../store/app-store'
import styles from './Editor.module.css'

interface FileStatus {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

interface DiffFileData {
  filePath: string
  patch: string
  status: string
}

interface Props {
  worktreePath: string
  active: boolean
}

const STATUS_LABELS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

function isAbsolutePathSafe(filePath: string): boolean {
  const normalized = toPosixPath(filePath)
  return normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:\//.test(normalized)
}

function joinWorktreePath(worktreePath: string, filePath: string): string {
  if (isAbsolutePathSafe(filePath)) return filePath

  const useBackslash = worktreePath.includes('\\')
  const separator = useBackslash ? '\\' : '/'
  const root = worktreePath.replace(/[\\/]+$/g, '')
  const relPosix = toPosixPath(filePath).replace(/^\/+/g, '')
  const rel = useBackslash ? relPosix.replace(/\//g, '\\') : relPosix
  if (!root) return `${separator}${rel}`
  return `${root}${separator}${rel}`
}

// ── Per-file diff section ──

interface DiffFileSectionProps {
  data: DiffFileData
  inline: boolean
  worktreePath: string
  onOpenFile: (filePath: string) => void
}

const DiffFileSection = memo(function DiffFileSection({
  data,
  inline,
  worktreePath,
  onOpenFile,
}: DiffFileSectionProps) {
  const displayPath = toPosixPath(data.filePath)
  const pathParts = displayPath.split(/[\\/]/)
  const fileName = pathParts[pathParts.length - 1] || basenameSafe(displayPath)
  const dir = pathParts.length > 1 ? `${pathParts.slice(0, -1).join('/')}/` : ''

  const fullPath = joinWorktreePath(worktreePath, data.filePath)

  return (
    <div className={styles.diffFileSection} id={`diff-${data.filePath}`}>
      <div
        className={styles.fileHeader}
        onClick={() => onOpenFile(fullPath)}
      >
        <span className={`${styles.fileHeaderBadge} ${styles[data.status] || ''}`}>
          {STATUS_LABELS[data.status] || '?'}
        </span>
        <span className={styles.fileHeaderPath}>
          {dir && <span className={styles.fileHeaderDir}>{dir}</span>}
          {fileName}
        </span>
      </div>
      <PatchDiff
        patch={data.patch}
        options={{
          theme: 'tokyo-night',
          themeType: 'dark',
          diffStyle: inline ? 'unified' : 'split',
          diffIndicators: 'bars',
          lineDiffType: 'word-alt',
          overflow: 'scroll',
          expandUnchanged: false,
          disableFileHeader: true,
        }}
      />
    </div>
  )
})

// ── File strip (jump nav) ──

function FileStrip({
  files,
  activeFile,
}: {
  files: DiffFileData[]
  activeFile: string | null
}) {
  const scrollTo = (filePath: string) => {
    const el = document.getElementById(`diff-${filePath}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className={styles.fileStrip}>
      {files.map((f) => (
        <button
          key={f.filePath}
          className={`${styles.fileStripItem} ${f.filePath === activeFile ? styles.active : ''}`}
          onClick={() => scrollTo(f.filePath)}
        >
          {basenameSafe(toPosixPath(f.filePath))}
        </button>
      ))}
    </div>
  )
}

// ── Main DiffViewer ──

export function DiffViewer({ worktreePath, active }: Props) {
  const [files, setFiles] = useState<DiffFileData[]>([])
  const [loading, setLoading] = useState(true)
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const { settings, updateSettings, openFileTab } = useAppStore()
  const inline = settings.diffInline

  // Load all changed files
  const loadFiles = useCallback(async () => {
    try {
      const statuses: FileStatus[] = await window.api.git.getStatus(worktreePath)
      const results = await Promise.all(
        statuses.map(async (file) => {
          try {
            let patch = await window.api.git.getFileDiff(worktreePath, file.path)

            // For added/untracked files, git diff returns empty — build synthetic patch
            if (!patch && (file.status === 'added' || file.status === 'untracked')) {
              const fullPath = joinWorktreePath(worktreePath, file.path)
              const content = await window.api.fs.readFile(fullPath)
              const lines = content.split('\n')
              patch = [
                `--- /dev/null`,
                `+++ b/${file.path}`,
                `@@ -0,0 +1,${lines.length} @@`,
                ...lines.map((l: string) => `+${l}`),
              ].join('\n')
            }

            // For deleted files with no diff, build synthetic removal patch
            if (!patch && file.status === 'deleted') {
              patch = `--- a/${file.path}\n+++ /dev/null\n@@ -1,0 +0,0 @@\n`
            }

            return { filePath: toPosixPath(file.path), patch: patch || '', status: file.status }
          } catch (error) {
            console.warn('Skipping diff entry due read/parsing error', { filePath: file.path, error })
            return null
          }
        }),
      )
      setFiles(results.filter((entry): entry is DiffFileData => entry !== null))
    } catch (err) {
      console.error('Failed to load diffs:', err)
    } finally {
      setLoading(false)
    }
  }, [worktreePath])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  // Auto-refresh on filesystem changes
  useEffect(() => {
    window.api.fs.watchDir(worktreePath)
    const unsub = window.api.fs.onDirChanged((changedDir: string) => {
      if (changedDir === worktreePath) loadFiles()
    })
    return () => {
      unsub()
      window.api.fs.unwatchDir(worktreePath)
    }
  }, [worktreePath, loadFiles])

  // Listen for scroll-to-file events from ChangedFiles panel
  useEffect(() => {
    const handler = (e: Event) => {
      const filePath = (e as CustomEvent<string>).detail
      // Small delay to let tab render if newly created
      requestAnimationFrame(() => {
        const el = document.getElementById(`diff-${filePath}`)
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
    window.addEventListener('diff:scrollToFile', handler)
    return () => window.removeEventListener('diff:scrollToFile', handler)
  }, [])

  // IntersectionObserver to highlight active file in strip
  useEffect(() => {
    if (!scrollAreaRef.current || files.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.id
            if (id.startsWith('diff-')) {
              setActiveFile(id.slice(5))
            }
          }
        }
      },
      { root: scrollAreaRef.current, threshold: 0.3 },
    )

    for (const f of files) {
      const el = document.getElementById(`diff-${f.filePath}`)
      if (el) observer.observe(el)
    }

    return () => observer.disconnect()
  }, [files])

  if (loading) {
    return (
      <div className={styles.diffViewerContainer}>
        <div className={styles.diffEmpty}>
          <span className={styles.diffEmptyText}>Loading changes...</span>
        </div>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className={styles.diffViewerContainer}>
        <div className={styles.diffEmpty}>
          <span className={styles.diffEmptyIcon}>&#10003;</span>
          <span className={styles.diffEmptyText}>No changes</span>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.diffViewerContainer}>
      {/* Toolbar */}
      <div className={styles.diffToolbar}>
        <span className={styles.diffFileCount}>
          {files.length} changed file{files.length !== 1 ? 's' : ''}
        </span>
        <div className={styles.diffToggle}>
          <button
            className={`${styles.diffToggleOption} ${!inline ? styles.active : ''}`}
            onClick={() => updateSettings({ diffInline: false })}
          >
            Side by side
          </button>
          <button
            className={`${styles.diffToggleOption} ${inline ? styles.active : ''}`}
            onClick={() => updateSettings({ diffInline: true })}
          >
            Inline
          </button>
        </div>
      </div>

      {/* File strip */}
      <FileStrip files={files} activeFile={activeFile} />

      {/* Stacked diffs */}
      <div ref={scrollAreaRef} className={styles.diffScrollArea}>
        {files.map((f) => (
          <DiffFileSection
            key={f.filePath}
            data={f}
            inline={inline}
            worktreePath={worktreePath}
            onOpenFile={openFileTab}
          />
        ))}
      </div>
    </div>
  )
}
