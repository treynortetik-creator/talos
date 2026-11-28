// What the owner reads about adding a plugin to his agent (agent-plugins.ts, and the Settings plugin list in the app), in ONE place. The card
// names the exact command the bridge runs on his tap; the warning is plain, one tick, never a refusal (Pantheon, 2026-11-26).
export const PLUGIN_WORDS = {
  /** On the card, and in the Settings list line for an enabled plugin that has such a hook. Exactly these words. */
  approves: 'This plugin can approve tool calls without asking your phone.',
  /** The Settings list line (the app draws it under the plugin's name). */
  approvesLine: 'Can approve tool calls without asking your phone',
  title: (plugin: string) => `Add the ${plugin} plugin to your agent?`,
  summary:
    'It is installed for your agent: thread sessions load it (a running one restarts after its turn) and Main loads it after its next restart or reload. Plugin code runs with your agent’s rights.',
  marketplace: 'Marketplace',
  plugin: (key: string) => `Plugin: ${key}`,
  hooks: (events: readonly string[]) => (events.length === 0 ? 'Hooks: none' : `Hooks: ${events.join(', ')}`),
  hooksUnknown: 'Hooks: not checked (the plugin is not on this computer yet)',
  hooksUnreadable: 'Hooks: could not be read, so it may approve tool calls',
  /** A hooks file in a form Claude Code does not load (a bare event table): shown instead of listing events. */
  hooksMalformed: 'Hooks: this plugin\u2019s hooks file is malformed and Claude Code may not load it',
  /** The plugin runs a command at install (a server\u2019s command or headersHelper): the CLI asks, and Talos accepts only because the owner saw this. */
  runsCommand: (cmds: readonly string[]) => `This plugin runs a command when it installs: ${cmds.join('; ')}`,
  runsUnknown: 'Could not tell whether this plugin runs a command when it installs.',
  /** The marketplace has not been added: the install would exit 1 and add nothing. Talos does not add one (it needs a source the owner names). */
  noMarketplace: (marketplace: string) =>
    `The ${marketplace} marketplace is not added on this computer yet, so nothing can be installed from it. Run \`claude plugin marketplace add <source>\` there first, then ask again.`,
  /** The whole command the bridge runs, the claude path first. */
  command: (argv: readonly string[]) => `Runs: ${argv.join(' ')}`,
  primary: 'Add plugin',
  kill: 'Cancel',
  // what the request is answered with
  asked: (key: string) => `Asked the owner to add ${key}. Nothing was installed yet.`,
  badName: 'A plugin is named like name and marketplace, with letters, digits, dots, dashes and underscores only.',
  rooted: 'On this computer plugins are installed by the administrator, not from the phone. Nothing was done.',
  noClaude: 'Claude Code was not found on this computer, so nothing was installed.',
  unreadableFiles: 'the agent\u2019s plugin files could not be read.',
  already: (key: string) => `${key} is already installed and switched on.`,
  pending: (key: string) => `The owner was already asked about ${key}.`,
  // what the card ends with
  added: (key: string) =>
    `Added ${key}. Thread sessions load it (a running one restarts after its turn); Main loads it after its next restart or reload.`,
  servers: (n: number) => (n === 1 ? ' It has 1 MCP server.' : ` It has ${n} MCP servers.`),
  offered: (n: number) =>
    n === 1 ? ' Asked about adding it to 1 thread’s MCP list.' : ` Asked about adding it to ${n} threads’ MCP lists.`,
  failed: (why: string) => `Nothing was added: ${why}`,
  installFailed: (code: string) => `claude plugin install did not finish (${code}).`,
  notThere: 'it did not appear in the installed plugins after the install.',
  notSigned: 'This approval was not signed by your device.',
  restarted:
    'The bridge restarted while this was running, so it is not known whether the plugin was added. Look in Settings > Session > Plugins, and ask again if it is not there.',
} as const
