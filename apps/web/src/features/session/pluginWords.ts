// What Settings > Session says about plugins and about adding one, in ONE place. The card the owner then taps is the bridge's (plugins/plugin-words.ts).
export const PLUGIN_WEB_WORDS = {
  /** Under an enabled plugin in the list that has a PermissionRequest or PreToolUse hook. A warning, never a block. */
  approvesLine: 'Can approve tool calls without asking your phone',
  addTitle: 'Add a plugin to your agent',
  addHelp: 'Main and every thread session load it. You get a card to approve; nothing is installed before that.',
  pluginLabel: 'Plugin name',
  marketLabel: 'Marketplace',
  addButton: 'Ask me to add it',
  sending: 'Asking…',
  noClient: 'This build cannot send that.',
  macOffline: 'Your computer is offline. Try again when it is back.',
  slow: 'Your computer has not answered yet. If a card comes, use it; otherwise try again.',
  badName: 'Use letters, digits, dots, dashes and underscores only.',
} as const
