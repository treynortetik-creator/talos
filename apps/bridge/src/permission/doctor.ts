// `talos-app doctor` checks for the permission relay (docs/CLAUDE-CODE.md C3.5). A permission prompt goes to EVERY channel
// that declares the relay and the first answer wins, so a phone approval is only as strong as the weakest channel loaded.
// Read-only: it looks at settings files and the process list and never changes either.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Channel plugins that can answer a permission prompt from another app (Telegram's too, though Talos no longer mirrors to it). */
export const OTHER_CHANNEL_PLUGINS = ['telegram', 'imessage', 'discord', 'fakechat'] as const

function readEnabledPlugins(path: string): string[] {
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as { enabledPlugins?: Record<string, unknown> }
    return Object.entries(cfg.enabledPlugins ?? {})
      .filter(([, on]) => on === true)
      .map(([k]) => k)
  } catch {
    return []
  }
}

/** `--channels` and `--dangerously-load-development-channels` (CC-C1-REVIEW F7: the second one has no `--channels`). */
const CHANNEL_FLAG = /--(?:dangerously-load-development-)?channels\b/

/**
 * The channels a `claude` command line loads: the arguments after `--channels` / `--dangerously-load-development-channels`
 * up to the next flag, as `plugin:name@market` or `server:name`. Returns the bare names.
 */
export function channelNames(line: string): string[] {
  const out: string[] = []
  const toks = line.split(/\s+/)
  let inList = false
  for (const t of toks) {
    if (/^--/.test(t)) {
      inList = CHANNEL_FLAG.test(t)
      const eq = t.indexOf('=')
      if (inList && eq > 0) pushEntry(t.slice(eq + 1), out)
      continue
    }
    if (inList) pushEntry(t, out)
  }
  return out
}
function pushEntry(entry: string, out: string[]) {
  const m = /^(?:plugin|server):([A-Za-z0-9_.-]+)/.exec(entry)
  if (m?.[1]) out.push(m[1].toLowerCase())
}

/** Command lines of this process's ancestors (the bridge runs under `bun run` under `claude`); [] when `ps` fails. */
export function ancestorCommandLines(startPid = process.ppid): string[] {
  const out: string[] = []
  let pid = startPid
  for (let i = 0; i < 6 && pid > 1; i++) {
    try {
      const r = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 })
      const m = /^\s*(\d+)\s+(.*)$/s.exec(r.stdout ?? '')
      if (r.status !== 0 || !m) break
      out.push(m[2] ?? '')
      pid = Number(m[1])
    } catch {
      break
    }
  }
  return out
}

/** Other channels (not Talos) the launching `claude` loaded. They may answer a permission prompt too. */
export function otherChannelsFromLines(lines: string[], self = 'talos-app'): string[] {
  const names = new Set<string>()
  for (const l of lines) for (const n of channelNames(l)) if (n !== self) names.add(n)
  return [...names].sort()
}

/** `ps` output lines that look like a Claude Code launch; empty when `ps` is not available. */
export function claudeProcessLines(): string[] {
  try {
    const r = spawnSync('ps', ['-axo', 'command'], { encoding: 'utf8', timeout: 5000 })
    if (r.status !== 0) return []
    return r.stdout.split('\n').filter((l) => /\bclaude\b/.test(l) && CHANNEL_FLAG.test(l))
  } catch {
    return []
  }
}

export type OtherChannels = { names: string[]; where: string[] }

/**
 * Other relaying channels that are enabled in the user's or the agent folder's settings, or on a running `claude` command
 * line (`--channels plugin:telegram@…`). Talos's own server is never listed.
 */
export function findOtherChannels(opts: {
  claudeDir: string
  agentDir: string
  processes?: () => string[]
}): OtherChannels {
  const names = new Set<string>()
  const where = new Set<string>()
  const files = [
    join(opts.claudeDir, 'settings.json'),
    join(opts.agentDir, '.claude', 'settings.json'),
    join(opts.agentDir, '.claude', 'settings.local.json'),
  ]
  for (const f of files)
    for (const key of readEnabledPlugins(f)) {
      const name = key.split('@')[0] ?? ''
      if ((OTHER_CHANNEL_PLUGINS as readonly string[]).includes(name)) {
        names.add(name)
        where.add(f)
      }
    }
  for (const name of otherChannelsFromLines((opts.processes ?? claudeProcessLines)())) {
    names.add(name)
    where.add('a running claude command line')
  }
  return { names: [...names].sort(), where: [...where] }
}
