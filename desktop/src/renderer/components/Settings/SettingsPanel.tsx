import { useEffect, useState } from 'react'
import {
  Card,
  Switch,
  Dropdown,
  Option,
  SpinButton,
  Input,
  Textarea,
  Button,
  Body1Strong,
  Caption1,
  Subtitle2,
  Table,
  TableHeader,
  TableRow,
  TableBody,
  TableCell,
  TableHeaderCell,
} from '@fluentui/react-components'
import { formatShortcut } from '@shared/platform'
import { SHORTCUT_MAP, type ShortcutBinding } from '@shared/shortcuts'
import { useAppStore } from '../../store/app-store'
import { PROJECT_OWNERSHIPS, type ProjectOwnership, type PromptTemplate, type Settings } from '../../store/types'
import type { ThemePreference } from '@shared/ipc-channels'
import type { GithubAuthAccountsResult } from '@shared/github-types'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './SettingsPanel.module.css'

const SHORTCUTS: Array<{ action: string; binding: ShortcutBinding }> = [
  { action: 'Quick open file', binding: SHORTCUT_MAP.quickOpenFile },
  { action: 'Command palette', binding: SHORTCUT_MAP.commandPalette },
  { action: 'New thread', binding: SHORTCUT_MAP.newChat },
  { action: 'Close tab', binding: SHORTCUT_MAP.closeTab },
  { action: 'Close all tabs', binding: SHORTCUT_MAP.closeAllTabs },
  { action: 'Next tab', binding: SHORTCUT_MAP.nextTab },
  { action: 'Previous tab', binding: SHORTCUT_MAP.previousTab },
  { action: 'Tab 1–9', binding: SHORTCUT_MAP.tabOneToNine },
  { action: 'Next workspace', binding: SHORTCUT_MAP.nextWorkspace },
  { action: 'Previous workspace', binding: SHORTCUT_MAP.previousWorkspace },
  { action: 'New thread context', binding: SHORTCUT_MAP.newWorkspace },
  { action: 'Toggle sidebar', binding: SHORTCUT_MAP.toggleSidebar },
  { action: 'Toggle right panel', binding: SHORTCUT_MAP.toggleRightPanel },
  { action: 'Files panel', binding: SHORTCUT_MAP.filesPanel },
  { action: 'Changes panel', binding: SHORTCUT_MAP.changesPanel },
  { action: 'Memory panel', binding: SHORTCUT_MAP.memoryPanel },
  { action: 'Focus chat', binding: SHORTCUT_MAP.focusChat },
  { action: 'Increase font size', binding: SHORTCUT_MAP.increaseFontSize },
  { action: 'Decrease font size', binding: SHORTCUT_MAP.decreaseFontSize },
  { action: 'Reset font size', binding: SHORTCUT_MAP.resetFontSize },
  { action: 'Settings', binding: SHORTCUT_MAP.settings },
]

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'Follow system' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

const PROJECT_OWNERSHIP_OPTIONS: Array<{ value: ProjectOwnership; label: string }> = [
  { value: 'personal', label: 'Personal' },
  { value: 'work', label: 'Laburo' },
]

function SettingRow({ label, description, children }: {
  label: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className={styles.settingRow}>
      <div className={styles.settingText}>
        <Body1Strong>{label}</Body1Strong>
        <Caption1 className={styles.settingDescription}>{description}</Caption1>
      </div>
      {children}
    </div>
  )
}

function TemplateEditorRow({
  template,
  onChange,
  onDelete,
}: {
  template: PromptTemplate
  onChange: (partial: Partial<PromptTemplate>) => void
  onDelete: () => void
}) {
  return (
    <Card className={styles.templateCard}>
      <div className={styles.templateCardHeader}>
        <Input
          className={styles.templateNameInput}
          value={template.name}
          onChange={(_, data) => onChange({ name: data.value })}
          placeholder="Template name"
          size="small"
        />
        <Button appearance="subtle" size="small" className={styles.templateDeleteBtn} onClick={onDelete}>
          Delete
        </Button>
      </div>
      <Textarea
        className={styles.templateContentInput}
        value={template.content}
        onChange={(_, data) => onChange({ content: data.value })}
        placeholder="Template text. Mentions: @workspace @branch @path @memory @file:README.md"
        resize="vertical"
        size="small"
      />
    </Card>
  )
}

function OpenAIAccountSection() {
  const codexLoggedIn = useAppStore((s) => s.codexLoggedIn)
  const setCodexLoggedIn = useAppStore((s) => s.setCodexLoggedIn)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleLogin = async () => {
    setLoading(true)
    setError(null)
    try {
      await window.api.chat.login()
      setCodexLoggedIn(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Login failed'
      setError(msg)
      console.error('[Settings] Login error:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = async () => {
    setLoading(true)
    setError(null)
    try {
      await window.api.chat.logout()
      setCodexLoggedIn(false)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  return (
    <SettingRow
      label="OpenAI account"
      description={error ?? 'Sign in with your ChatGPT account to use the Codex agent'}
    >
      {codexLoggedIn ? (
        <Button
          appearance="subtle"
          size="small"
          className={styles.dangerBtn}
          onClick={handleLogout}
          disabled={loading}
        >
          {loading ? 'Signing out...' : 'Sign out'}
        </Button>
      ) : (
        <Button
          appearance="primary"
          size="small"
          onClick={handleLogin}
          disabled={loading}
        >
          {loading ? 'Signing in...' : 'Sign in with ChatGPT'}
        </Button>
      )}
    </SettingRow>
  )
}

function ClaudeHooksSection() {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    window.api.claude.checkHooks().then((result: { installed: boolean }) => {
      setInstalled(result.installed)
    }).catch(() => setInstalled(false))
  }, [])

  const handleInstall = async () => {
    setInstalling(true)
    try {
      await window.api.claude.installHooks()
      setInstalled(true)
    } catch {
      setInstalled(false)
    } finally {
      setInstalling(false)
    }
  }

  const handleUninstall = async () => {
    setInstalling(true)
    try {
      await window.api.claude.uninstallHooks()
      setInstalled(false)
    } catch {
      // keep current state
    } finally {
      setInstalling(false)
    }
  }

  return (
    <SettingRow
      label="Claude Code hooks"
      description="Show an unread indicator when Claude Code finishes responding in a workspace"
    >
      {installed === true ? (
        <Button
          appearance="subtle"
          size="small"
          className={styles.dangerBtn}
          onClick={handleUninstall}
          disabled={installing}
        >
          {installing ? 'Removing...' : 'Uninstall'}
        </Button>
      ) : (
        <Button
          appearance="primary"
          size="small"
          onClick={handleInstall}
          disabled={installing || installed === null}
        >
          {installing ? 'Installing...' : 'Install'}
        </Button>
      )}
    </SettingRow>
  )
}

function CodexNotifySection() {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    window.api.codex.checkNotify().then((result: { installed: boolean }) => {
      setInstalled(result.installed)
    }).catch(() => setInstalled(false))
  }, [])

  const handleInstall = async () => {
    setInstalling(true)
    try {
      await window.api.codex.installNotify()
      setInstalled(true)
    } catch {
      setInstalled(false)
    } finally {
      setInstalling(false)
    }
  }

  const handleUninstall = async () => {
    setInstalling(true)
    try {
      await window.api.codex.uninstallNotify()
      setInstalled(false)
    } catch {
      // keep current state
    } finally {
      setInstalling(false)
    }
  }

  return (
    <SettingRow
      label="Codex notify hook"
      description="Show done/unread state for Codex turns and clear active state when a turn completes"
    >
      {installed === true ? (
        <Button
          appearance="subtle"
          size="small"
          className={styles.dangerBtn}
          onClick={handleUninstall}
          disabled={installing}
        >
          {installing ? 'Removing...' : 'Uninstall'}
        </Button>
      ) : (
        <Button
          appearance="primary"
          size="small"
          onClick={handleInstall}
          disabled={installing || installed === null}
        >
          {installing ? 'Installing...' : 'Install'}
        </Button>
      )}
    </SettingRow>
  )
}

const shortcutColumns = [
  { columnKey: 'action', label: 'Action' },
  { columnKey: 'shortcut', label: 'Shortcut' },
]

export function SettingsPanel() {
  const { settings, updateSettings, toggleSettings } = useAppStore()
  const [githubAccounts, setGithubAccounts] = useState<string[]>([])
  const [githubAccountsLoading, setGithubAccountsLoading] = useState(false)
  const [githubAccountsError, setGithubAccountsError] = useState<string | null>(null)

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    updateSettings({ [key]: value })
  }

  const loadGithubAccounts = async () => {
    setGithubAccountsLoading(true)
    setGithubAccountsError(null)
    try {
      const result = await window.api.github.listAuthAccounts('github.com') as GithubAuthAccountsResult
      if (!result.available) {
        setGithubAccounts([])
        setGithubAccountsError(
          result.error === 'gh_not_installed'
            ? 'GitHub CLI no está instalado.'
            : 'No hay cuentas autenticadas en gh.',
        )
        return
      }
      setGithubAccounts(result.data)
    } catch {
      setGithubAccounts([])
      setGithubAccountsError('No se pudieron cargar las cuentas de gh.')
    } finally {
      setGithubAccountsLoading(false)
    }
  }

  const githubAccountOptions = Array.from(
    new Set(
      [
        ...githubAccounts,
        settings.githubPersonalLogin.trim(),
        settings.githubWorkLogin.trim(),
      ].filter(Boolean),
    ),
  )

  const updateTemplate = (id: string, partial: Partial<PromptTemplate>) => {
    update('promptTemplates', settings.promptTemplates.map((template) =>
      template.id === id ? { ...template, ...partial } : template
    ))
  }

  const addTemplate = () => {
    update('promptTemplates', [
      ...settings.promptTemplates,
      {
        id: crypto.randomUUID(),
        name: 'New template',
        content: '',
      },
    ])
  }

  const removeTemplate = (id: string) => {
    update('promptTemplates', settings.promptTemplates.filter((template) => template.id !== id))
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleSettings()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleSettings])

  useEffect(() => {
    void loadGithubAccounts()
  }, [])

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.headerLeft}>
            <Tooltip
              label="Back"
              shortcut={formatShortcut(SHORTCUT_MAP.settings.mac, SHORTCUT_MAP.settings.win)}
            >
              <button aria-label="Back to workspace" className={styles.backBtn} onClick={toggleSettings}>&#x2190;</button>
            </Tooltip>
            <Subtitle2>Settings</Subtitle2>
          </div>
        </div>
      </div>

      <div className={styles.content}>
        <div className={styles.inner}>
          {/* Appearance */}
          <div className={styles.section}>
            <Caption1 className={styles.sectionLabel}>Appearance</Caption1>
            <Card className={styles.card}>
              <SettingRow
                label="Theme"
                description="Follow Windows theme, or force dark/light mode"
              >
                <Dropdown
                  className={styles.dropdown}
                  value={THEME_OPTIONS.find((o) => o.value === settings.themePreference)?.label ?? 'Follow system'}
                  selectedOptions={[settings.themePreference]}
                  onOptionSelect={(_, data) => update('themePreference', data.optionValue as ThemePreference)}
                  size="small"
                >
                  {THEME_OPTIONS.map((option) => (
                    <Option key={option.value} value={option.value}>
                      {option.label}
                    </Option>
                  ))}
                </Dropdown>
              </SettingRow>

              <SettingRow
                label="Editor font size"
                description="Font size in pixels for file and diff editors"
              >
                <SpinButton
                  className={styles.spinButton}
                  value={settings.editorFontSize}
                  min={8}
                  max={32}
                  onChange={(_, data) => {
                    if (data.value !== undefined && data.value !== null) {
                      update('editorFontSize', data.value)
                    }
                  }}
                  size="small"
                />
              </SettingRow>
            </Card>
          </div>

          {/* General */}
          <div className={styles.section}>
            <Caption1 className={styles.sectionLabel}>General</Caption1>
            <Card className={styles.card}>
              <SettingRow
                label="Confirm on close"
                description="Show confirmation when closing tabs with unsaved changes"
              >
                <Switch
                  checked={settings.confirmOnClose}
                  onChange={(_, data) => update('confirmOnClose', data.checked)}
                />
              </SettingRow>

              <SettingRow
                label="Auto-save on blur"
                description="Automatically save files when switching away from a tab"
              >
                <Switch
                  checked={settings.autoSaveOnBlur}
                  onChange={(_, data) => update('autoSaveOnBlur', data.checked)}
                />
              </SettingRow>

              <SettingRow
                label="Restore workspace"
                description="Restore the last active workspace when the app starts"
              >
                <Switch
                  checked={settings.restoreWorkspace}
                  onChange={(_, data) => update('restoreWorkspace', data.checked)}
                />
              </SettingRow>

              <SettingRow
                label="Inline diffs"
                description="Show diffs inline instead of side-by-side"
              >
                <Switch
                  checked={settings.diffInline}
                  onChange={(_, data) => update('diffInline', data.checked)}
                />
              </SettingRow>

              <SettingRow
                label="PR link provider"
                description="Set per project in Project Settings (gear icon in the sidebar)."
              >
                <span />
              </SettingRow>
            </Card>
          </div>

          {/* GitHub */}
          <div className={styles.section}>
            <Caption1 className={styles.sectionLabel}>GitHub</Caption1>
            <Card className={styles.card}>
              <SettingRow
                label="Default project ownership"
                description="Used as the default value when creating a new project."
              >
                <Dropdown
                  className={styles.dropdown}
                  value={PROJECT_OWNERSHIP_OPTIONS.find((o) => o.value === settings.defaultProjectOwnership)?.label ?? 'Personal'}
                  selectedOptions={[settings.defaultProjectOwnership]}
                  onOptionSelect={(_, data) => {
                    if (!data.optionValue) return
                    update('defaultProjectOwnership', data.optionValue as ProjectOwnership)
                  }}
                  size="small"
                >
                  {PROJECT_OWNERSHIPS.map((option) => (
                    <Option key={option} value={option}>
                      {PROJECT_OWNERSHIP_OPTIONS.find((o) => o.value === option)?.label ?? option}
                    </Option>
                  ))}
                </Dropdown>
              </SettingRow>

              <SettingRow
                label="Personal account login"
                description="Cuenta usada para proyectos Personal."
              >
                <Dropdown
                  className={styles.dropdown}
                  value={settings.githubPersonalLogin || 'No definida'}
                  selectedOptions={[settings.githubPersonalLogin || '__none__']}
                  onOptionSelect={(_, data) =>
                    update(
                      'githubPersonalLogin',
                      data.optionValue === '__none__' ? '' : String(data.optionValue ?? ''),
                    )
                  }
                  size="small"
                >
                  <Option value="__none__">No definida</Option>
                  {githubAccountOptions.map((account) => (
                    <Option key={`personal-${account}`} value={account}>
                      {account}
                    </Option>
                  ))}
                </Dropdown>
              </SettingRow>

              <SettingRow
                label="Work account login"
                description="Cuenta usada para proyectos Laburo."
              >
                <Dropdown
                  className={styles.dropdown}
                  value={settings.githubWorkLogin || 'No definida'}
                  selectedOptions={[settings.githubWorkLogin || '__none__']}
                  onOptionSelect={(_, data) =>
                    update(
                      'githubWorkLogin',
                      data.optionValue === '__none__' ? '' : String(data.optionValue ?? ''),
                    )
                  }
                  size="small"
                >
                  <Option value="__none__">No definida</Option>
                  {githubAccountOptions.map((account) => (
                    <Option key={`work-${account}`} value={account}>
                      {account}
                    </Option>
                  ))}
                </Dropdown>
              </SettingRow>

              <SettingRow
                label="Detected gh accounts"
                description={githubAccountsError ?? `${githubAccounts.length} account(s) detected.`}
              >
                <Button
                  appearance="secondary"
                  size="small"
                  onClick={() => {
                    void loadGithubAccounts()
                  }}
                  disabled={githubAccountsLoading}
                >
                  {githubAccountsLoading ? 'Refreshing...' : 'Refresh'}
                </Button>
              </SettingRow>
            </Card>
          </div>

          {/* Agent Integrations */}
          <div className={styles.section}>
            <Caption1 className={styles.sectionLabel}>Agent Integrations</Caption1>
            <Card className={styles.card}>
              <OpenAIAccountSection />
              <ClaudeHooksSection />
              <CodexNotifySection />
            </Card>
          </div>

          {/* Prompt Templates */}
          <div className={styles.section}>
            <Caption1 className={styles.sectionLabel}>Prompt templates</Caption1>
            <Card className={styles.card}>
              <Caption1 className={styles.templateHelp}>
                Reusable prompts for command palette and workspace memory. Mentions:{' '}
                <code>@workspace</code>, <code>@branch</code>, <code>@path</code>, <code>@memory</code>, <code>@file:&lt;relative-path&gt;</code>.
              </Caption1>
              {settings.promptTemplates.map((template) => (
                <TemplateEditorRow
                  key={template.id}
                  template={template}
                  onChange={(partial) => updateTemplate(template.id, partial)}
                  onDelete={() => removeTemplate(template.id)}
                />
              ))}
              <Button
                appearance="primary"
                size="small"
                className={styles.addTemplateBtn}
                onClick={addTemplate}
              >
                Add template
              </Button>
            </Card>
          </div>

          {/* Keyboard Shortcuts */}
          <div className={styles.section}>
            <Caption1 className={styles.sectionLabel}>Keyboard Shortcuts</Caption1>
            <Card className={styles.card}>
              <Table size="small" className={styles.shortcutTable}>
                <TableHeader>
                  <TableRow>
                    {shortcutColumns.map((col) => (
                      <TableHeaderCell key={col.columnKey}>
                        <Caption1>{col.label}</Caption1>
                      </TableHeaderCell>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {SHORTCUTS.map((s) => (
                    <TableRow key={s.action}>
                      <TableCell>
                        <Caption1>{s.action}</Caption1>
                      </TableCell>
                      <TableCell>
                        <kbd className={styles.kbd}>{formatShortcut(s.binding.mac, s.binding.win)}</kbd>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
