// Which folder the Files pane shows for a thread, and what it never shows: the Mac's own rules, never the app's.
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BridgeOptions } from '../bridge-options.ts'
import { claudeConfigDir } from '../claude-dir.ts'
import type { BridgeContext } from '../context.ts'
import { FOLDER_EXTRA_REFUSED, foldPath } from '../folders/service.ts'
import { agentDirFromEnv } from '../last-good.ts'
import { LEAD_SECRET_PATHS } from '../lead/fence.ts'
import { dedicatedThreads } from '../supervisor/workers-wiring.ts'
import type { AgentsMdDeps } from './agents-md.ts'
import { AGENTS_MD, AgentsMdService } from './agents-md.ts'
import { FilesPutService } from './put.ts'
import { type FilesDeps, FilesService } from './service.ts'

/**
 * The folder a thread's session works in, so the one its Files pane shows: a thread with its own session works in its own
 * folder (`session_opts.cwd`, else the agent folder), by the same rules the supervisor starts it with; every other thread of
 * the config, Main included, works in the agent folder. Null for a thread the config does not have, or when there is no
 * agent folder to fall back to.
 */
export function filesRootFor(config: unknown, agentDir: string | undefined, threadId: string): string | null {
  const threads = (config as { threads?: unknown } | null)?.threads
  if (!Array.isArray(threads) || !threads.some((t) => (t as { id?: unknown } | null)?.id === threadId)) return null
  const own = dedicatedThreads(config, agentDir ?? '')?.find((w) => w.id === threadId)
  const root = own ? own.cwd : agentDir
  return root ? root : null
}

/**
 * Never shown, even inside a thread's folder: the Talos home, Claude's config, the secret stores every lead protects, the
 * macOS Library and the other key and token folders the folder picker refuses. The agent folder is NOT here: it is the folder
 * Main and every shared thread show.
 */
export function filesRefusedRoots(o: { home: string; talosHome: string; claudeDir: string }): string[] {
  return [
    o.talosHome,
    o.claudeDir,
    join(o.home, '.claude'),
    join(o.home, '.claude.json'),
    join(o.home, 'private-agent-vault'),
    ...LEAD_SECRET_PATHS.map((p) => join(o.home, p)),
    ...FOLDER_EXTRA_REFUSED.map((p) => join(o.home, p)),
  ]
}

/** What a live main bridge shows files with. */
export function filesDeps(o: {
  talosHome: string
  config: () => unknown
  media: FilesDeps['media']
  env?: Record<string, string | undefined>
  home?: string
}): FilesDeps {
  const env = o.env ?? process.env
  const home = o.home ?? homedir()
  let claudeDir: string
  try {
    claudeDir = claudeConfigDir(home, env.CLAUDE_CONFIG_DIR)
  } catch {
    claudeDir = join(home, '.claude')
  }
  const agentDir = agentDirFromEnv(env)
  return {
    rootFor: (id) => filesRootFor(o.config(), agentDir, id),
    refused: filesRefusedRoots({ home, talosHome: o.talosHome, claudeDir }),
    media: o.media,
  }
}

/**
 * The folder a thread's AGENTS.md editor works in: a dedicated thread's own folder, never the shared agent folder or one that
 * holds it (a save there would be Main's and every shared thread's instructions too). Compared as the disk resolves both.
 */
export function agentsMdFolderFor(config: unknown, agentDir: string | undefined, threadId: string): string | null {
  const own = dedicatedThreads(config, agentDir ?? '')?.find((w) => w.id === threadId)
  if (!own?.cwd) return null
  // a sub-thread that works in its parent's folder (none of its own, or the same) uses the parent's file: it must not edit it
  if (own.sub && !own.sub.ownCwd) return null
  // for folders only: a file's real path goes through realFileSync (real-file.ts), as realpath can name a hard-linked file by another of its names
  const real = (p: string) => {
    try {
      return foldPath(realpathSync(p))
    } catch {
      return foldPath(p)
    }
  }
  // the agent folder, or a folder it is inside: Claude Code reads AGENTS.md from the folders above a session's too, so a save
  // there would reach Main's sessions as well. A sub-thread's folder inside its parent's is meant to (it inherits).
  if (agentDir) {
    const mine = real(own.cwd)
    const agent = real(agentDir)
    if (agent === mine || agent.startsWith(`${mine}/`)) return null
  }
  return own.cwd
}

/** What a live main bridge edits AGENTS.md with: the Files pane's fence, and the Mac's records under its home. */
export function agentsMdDeps(o: {
  talosHome: string
  config: () => unknown
  files: Pick<FilesService, 'fencedName'>
  env?: Record<string, string | undefined>
}): AgentsMdDeps {
  const agentDir = agentDirFromEnv(o.env ?? process.env)
  return {
    ownFolder: (id) => agentsMdFolderFor(o.config(), agentDir, id),
    fenced: (id) => o.files.fencedName(id, AGENTS_MD),
    stateDir: (id) => join(o.talosHome, 'threads', id),
  }
}

/**
 * The Files pane's fenced reads, the thread's AGENTS.md editor and uploads into a thread's folder, on a live main bridge:
 * one fence (FilesService) under all three. `opts` holds tests' deps over the live ones.
 */
export function installFiles(
  ctx: BridgeContext,
  o: { talosHome: string; now: () => number },
  opts: Pick<BridgeOptions, 'files' | 'agentsMd' | 'filesPut'>,
): void {
  const config = () => ctx.config.config
  const files = new FilesService({
    ...filesDeps({ talosHome: o.talosHome, config, media: ctx.media }),
    ...(opts.files ?? {}),
  })
  ctx.files = files
  // the thread's AGENTS.md in its settings, inside the same fence (a thread with a folder of its own only)
  ctx.agentsMd = new AgentsMdService({
    ...agentsMdDeps({ talosHome: o.talosHome, config, files }),
    ...(opts.agentsMd ?? {}),
  })
  // uploads into a thread's folder, inside the same fence; the media is fetched and checked, never kept here
  const media = ctx.media
  ctx.filesPut = new FilesPutService({
    fencedDir: (id, dir) => files.fencedDir(id, dir),
    fetch: (ref) => media.fetchVerified(ref),
    now: o.now,
    ...(opts.filesPut ?? {}),
  })
}
