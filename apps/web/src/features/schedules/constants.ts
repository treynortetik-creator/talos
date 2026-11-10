// Strings and limits the Schedules tab shares (docs/SCHEDULES.md S5). The Chronos install URL is the one place a fork
// changes to point at its own scheduler.
export const CHRONOS_INSTALL_URL = 'https://github.com/treynortetik-creator/chronos'
export const CHRONOS_INSTALL_CMD = `git clone ${CHRONOS_INSTALL_URL} ~/chronos && ~/chronos/install.sh`
export const CHRONOS_UPDATE_CMD = 'git pull && ./install.sh'

/** The create form's prompt cap (S2.4). */
export const PROMPT_CAP_BYTES = 16 * 1024
/** Lines of the prompt shown before "Show all" (S5.3). */
export const PROMPT_PREVIEW_LINES = 6
/** Recent runs shown on a detail (S5.3). */
export const RECENT_RUNS = 10
/** A failure in the last 24 h puts the dot on the tab (S5.1). */
export const FAILED_DOT_WINDOW_MS = 24 * 60 * 60 * 1000

/** The search box shows once there are more jobs than this. */
export const SEARCH_AFTER = 15

export const COPY = {
  nextUp: 'Next to run',
  oneOffGroup: 'One-off',
  chipFailed: 'Failed',
  chipPaused: 'Paused or off',
  chipOneOff: 'One-off',
  filters: 'Show only',
  search: 'Search jobs',
  filterEmpty: 'No job matches.',
  groupFailed: 'a job failed',
  editJob: 'Edit {name}',
  edit: 'Edit',
  editOffline: 'Your Mac is offline. Edit when it is back.',
  jobOne: '1 job',
  jobMany: '{n} jobs',
  nextRun: 'next {when}',
  switchOn: 'Turn on {name}',
  switchRuns: '{name} runs on schedule',
  statusOff: 'Off',
  statusCommand: 'Command · read-only',
  statusEvents: 'On events · read-only',
  statusPaused: 'Paused',
  editWhy: 'Edit it at the Mac.',
  title: 'Schedules',
  empty: 'No scheduled jobs yet. Tell {agent} what to do and when.',
  noScheduler: 'No scheduler on your Mac yet. {agent} uses Chronos to run jobs on a schedule.',
  afterInstall: 'Then run `talos-app schedules adopt` and restart your session.',
  oldChronos: 'Schedules need 0.3 or newer.',
  bridgeOld: 'Update Talos on your Mac to use Schedules.',
  updateApp: 'Update the app to use Schedules.',
  turnedOff: 'Schedules are turned off on your Mac (`TALOS_APP_SCHEDULER=off`).',
  noAnswer: "Your Mac didn't answer. Try again.",
  offline: 'Your Mac is offline. This list is from {time}. Changes and Run now need your Mac.',
  conflict: '⚠ The job changed on your Mac before you approved. Nothing was saved.',
  fullPerms: 'Full permissions, nobody watching',
} as const

export const fill = (s: string, vars: Record<string, string>): string =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`)
