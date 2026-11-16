// The oldest Bun Talos supports, and the words a person on an older one sees. The doctor, `talos-app update`, the bridge's
// own start and apps/bridge/scripts/install.sh all use these. Run as a script (`bun bun-floor.ts [version]`, the running
// Bun's own version by default) it exits 1 with those words on stderr for an older Bun, and 0 silently otherwise.
// The root install.sh and scripts/gate.sh hold the same number; scripts/root-install-preflight.test.ts keeps them equal.

export const BUN_FLOOR = '1.4.4'

/** Numbers only, as gate.sh and install.sh compare: 1.4.4-canary.1 counts as 1.4.4. */
export function bunAtLeast(v: string, min: string): boolean {
  const a = v
    .replace(/[-+].*/, '')
    .split('.')
    .map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

/** How to get a newer Bun, one line per platform. */
const UPGRADE_HOW = [
  'macOS or Linux (or a WSL distro you set up yourself): bun upgrade (no Bun at all: curl -fsSL https://bun.sh/install | bash)',
  'Windows, set up with Talos Setup: download the newest Talos Setup and open it; it installs the Bun Talos needs in its WSL distro',
]
const UPGRADE = 'Upgrade it, then restart the agent:'

/** What to tell a person on `version`, or undefined when it is new enough. */
export function bunTooOld(version: string): string | undefined {
  if (bunAtLeast(version, BUN_FLOOR)) return undefined
  return [
    `Bun ${version} is older than ${BUN_FLOOR}, the oldest Talos supports. ${UPGRADE}`,
    ...UPGRADE_HOW.map((l) => `  ${l}`),
  ].join('\n')
}

/** The doctor's `bun version` row: the upgrade lines go under a FAIL, indented past the level column. */
export function bunDoctorRow(version: string): { level: 'ok' | 'FAIL'; detail: string } {
  const detail = `${version} (needs ${BUN_FLOOR} or newer)`
  if (bunAtLeast(version, BUN_FLOOR)) return { level: 'ok', detail }
  return { level: 'FAIL', detail: [`${detail}. ${UPGRADE}`, ...UPGRADE_HOW.map((l) => `      ${l}`)].join('\n') }
}

/**
 * The bridge's start on an older Bun: an error log line (which files a problem report, so the phone shows it) and the words
 * on stderr (Claude Code's MCP log). The bridge keeps running: refusing would leave the phone with no word at all.
 */
export function reportOldBun(
  version: string,
  log: { error: (msg: string, fields?: Record<string, unknown>) => void },
  write: (s: string) => void,
): void {
  const words = bunTooOld(version)
  if (!words) return
  log.error(
    'bun is older than the oldest Talos supports: upgrade it (talos-app doctor says how), then restart the agent',
    {
      bun: version,
      needs: BUN_FLOOR,
    },
  )
  write(`talos-app bridge: ${words}\n`)
}

if (import.meta.main) {
  const words = bunTooOld(process.argv[2] || Bun.version)
  if (words) {
    process.stderr.write(`${words}\n`)
    process.exit(1)
  }
}
