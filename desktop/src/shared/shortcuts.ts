export interface ShortcutBinding {
  mac: string
  win: string
}

export const SHORTCUT_MAP: Record<string, ShortcutBinding> = {
  quickOpenFile: { mac: 'Ctrl+P', win: 'Ctrl+P' },
  commandPalette: { mac: 'Ctrl+Shift+P', win: 'Ctrl+Shift+P' },
  newChat: { mac: 'Ctrl+T', win: 'Ctrl+T' },
  closeTab: { mac: 'Ctrl+W', win: 'Ctrl+W' },
  closeAllTabs: { mac: 'Ctrl+Shift+W', win: 'Ctrl+Shift+W' },
  nextTab: { mac: 'Ctrl+Shift+]', win: 'Ctrl+Shift+]' },
  previousTab: { mac: 'Ctrl+Shift+[', win: 'Ctrl+Shift+[' },
  tabOneToNine: { mac: 'Ctrl+1..9', win: 'Ctrl+1..9' },
  nextWorkspace: { mac: 'Ctrl+Shift+Down', win: 'Ctrl+Shift+Down' },
  previousWorkspace: { mac: 'Ctrl+Shift+Up', win: 'Ctrl+Shift+Up' },
  newWorkspace: { mac: 'Ctrl+N', win: 'Ctrl+N' },
  toggleSidebar: { mac: 'Ctrl+B', win: 'Ctrl+B' },
  toggleRightPanel: { mac: 'Ctrl+Alt+B', win: 'Ctrl+Alt+B' },
  filesPanel: { mac: 'Ctrl+Shift+E', win: 'Ctrl+Shift+E' },
  changesPanel: { mac: 'Ctrl+Shift+G', win: 'Ctrl+Shift+G' },
  memoryPanel: { mac: 'Ctrl+Shift+M', win: 'Ctrl+Shift+M' },
  focusChat: { mac: 'Ctrl+J', win: 'Ctrl+J' },
  increaseFontSize: { mac: 'Ctrl++', win: 'Ctrl++' },
  decreaseFontSize: { mac: 'Ctrl+-', win: 'Ctrl+-' },
  resetFontSize: { mac: 'Ctrl+0', win: 'Ctrl+0' },
  settings: { mac: 'Ctrl+,', win: 'Ctrl+,' },
  commitStagedChanges: { mac: 'Ctrl+Enter', win: 'Ctrl+Enter' },
}
