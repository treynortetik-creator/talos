// memory.folders / memory.roots_set (frames-memory-roots.ts): the owner picks, in Settings, which folders of the agent folder
// the Memory screen's Notes show (owner, 2026-11-15). The same memory.json `talos-app memory init` writes, built the same way.
// Every name the phone sends is checked against this Mac's own listing of the agent folder before it is used: a name is never
// joined onto a path first, so "..", "/" or a look-alike cannot reach outside it. The agent folder's path never leaves the Mac.
// A save also turns Memory browsing on (the phone's settings switch can still only turn it off: config.patch is not used).
import { realpathSync, statSync } from 'node:fs'
import {
  MEMORY_FOLDER_NOTES_MAX,
  MEMORY_FOLDERS_LIST_MAX,
  MEMORY_ROOTS_MAX,
  MEMORY_ROOTS_WORDING,
  type MemoryFoldersResultFrame,
} from '@talos-app/protocol'
import type { z } from 'zod'
import type { BridgeContext } from '../context.ts'
import { configSyncFrame } from '../frames-out.ts'
import { agentDirFromEnv } from '../last-good.ts'
import { slug, subdirs, survey } from './cli.ts'
import {
  DEFAULT_INCLUDE,
  DEFAULT_MAX_FILE_KB,
  loadMemoryConfig,
  type MemoryConfig,
  type MemoryRootCfg,
  parseMemoryConfig,
  writeMemoryConfig,
} from './config.ts'
import { MemoryScope } from './scope.ts'

type Body = Omit<z.infer<typeof MemoryFoldersResultFrame>, 'v' | 'id' | 'ts' | 'type' | 'request_id'>

export type MemoryRootsDeps = {
  home: string
  /** The agent folder when memory.json does not name one yet (TALOS_AGENT_DIR). */
  agentDir: () => string | undefined
  /** Turns the app's Memory switch on (config.json memory_browser), and syncs the apps. */
  switchOn: () => Promise<void> | void
  /** The app's Memory switch now. */
  switchIsOn: () => boolean
}

const realDir = (p: string | undefined): string | null => {
  if (!p) return null
  try {
    const r = realpathSync(p)
    return statSync(r).isDirectory() ? r : null
  } catch {
    return null
  }
}

/** A root the picker manages: a plain top-level folder, by name. Anything else in memory.json (a nested path, `.`) is kept as
 * it is on every save and never shown as picked. */
const plain = (path: string) => path !== '' && path !== '.' && path !== '..' && !/[/\\]/.test(path)

export class MemoryRoots {
  readonly available = true
  constructor(private readonly d: MemoryRootsDeps) {}

  /**
   * memory.json now, or null when there is none; `broken` when there is one that does not parse (it is never overwritten
   * then: the owner fixes it at the Mac). The agent folder must pass the same checks a save would (not home, not the app
   * folder), or there is nothing to list.
   */
  private current(): { cfg: MemoryConfig | null; agentDir: string | null; broken: boolean } {
    const r = loadMemoryConfig(this.d.home)
    if (r.ok) return { cfg: r.config, agentDir: realDir(r.config.agent_dir), broken: false }
    if (!('missing' in r && r.missing)) return { cfg: null, agentDir: null, broken: true }
    const dir = realDir(this.d.agentDir())
    if (!dir) return { cfg: null, agentDir: null, broken: false }
    const ok = parseMemoryConfig({ version: 1, enabled: false, agent_dir: dir, roots: [] }, this.d.home).ok
    return { cfg: null, agentDir: ok ? dir : null, broken: false }
  }

  /** Visible notes in one folder, counted up to MEMORY_FOLDER_NOTES_MAX (a quick walk: the list runs on the read queue). */
  private count(agentDir: string, name: string): number {
    const scope = new MemoryScope({
      version: 1,
      enabled: true,
      agent_dir: agentDir,
      roots: [{ id: 'x', label: 'x', path: name, include: DEFAULT_INCLUDE, exclude: [] }],
      max_file_kb: DEFAULT_MAX_FILE_KB,
    })
    const root = scope.roots[0]
    return root ? scope.walk(root, MEMORY_FOLDER_NOTES_MAX).files.length : 0
  }

  private body(
    cur: { cfg: MemoryConfig | null; agentDir: string | null; broken: boolean },
    extra: Partial<Body> = {},
  ): Body {
    const { cfg, agentDir, broken } = cur
    const names = agentDir ? subdirs(agentDir, '').slice(0, MEMORY_FOLDERS_LIST_MAX) : []
    const listed = new Set(names)
    // picked: the plain top-level roots that are in the list (a link, a nested path or `.` is kept but never shown)
    const chosen = (cfg?.roots ?? []).map((r) => r.path).filter((p) => plain(p) && listed.has(p))
    return {
      folders: names.map((name) => ({ name, notes: this.count(agentDir as string, name) })),
      chosen: chosen.slice(0, MEMORY_ROOTS_MAX),
      enabled: Boolean(cfg?.enabled && this.d.switchIsOn()),
      ...(broken ? { error: MEMORY_ROOTS_WORDING.broken } : agentDir ? {} : { error: MEMORY_ROOTS_WORDING.notSetUp }),
      ...extra,
    }
  }

  list(): Body {
    return this.body(this.current())
  }

  /** Signature, freshness and replay are the read queue's (inbound-reads.ts onReadFrame). */
  async set(names: readonly string[]): Promise<Body> {
    const cur = this.current()
    const { cfg, agentDir, broken } = cur
    if (broken) return this.body(cur)
    if (!agentDir) return this.body(cur, { error: MEMORY_ROOTS_WORDING.notSetUp })
    // exact entries of this Mac's own listing, nothing else
    const listed = new Set(subdirs(agentDir, ''))
    const wanted = [...new Set(names)]
    if (wanted.length > MEMORY_ROOTS_MAX || wanted.some((n) => !listed.has(n)))
      return this.body(cur, { error: MEMORY_ROOTS_WORDING.unknown })
    const before = cfg?.roots ?? []
    // roots the picker does not manage stay exactly as they are
    const untouched = before.filter((r) => !(plain(r.path) && listed.has(r.path)))
    const kept = new Map(before.filter((r) => plain(r.path)).map((r) => [r.path, r]))
    const taken = new Set(untouched.map((r) => r.id))
    const picked: MemoryRootCfg[] = wanted.map((name) => {
      const was = kept.get(name)
      if (was) {
        taken.add(was.id)
        return was
      }
      return { id: '', label: name.slice(0, 40), path: name, include: DEFAULT_INCLUDE, exclude: [] }
    })
    for (const r of picked) if (!r.id) r.id = slug(r.path, taken)
    const roots = [...untouched, ...picked]
    if (roots.length > MEMORY_ROOTS_MAX) return this.body(cur, { error: MEMORY_ROOTS_WORDING.saveFailed })
    const next: MemoryConfig = {
      version: 1,
      enabled: picked.length > 0 || untouched.length > 0,
      agent_dir: agentDir,
      roots,
      max_file_kb: cfg?.max_file_kb ?? DEFAULT_MAX_FILE_KB,
    }
    const parsed = parseMemoryConfig(next, this.d.home)
    if (!parsed.ok) return this.body(cur, { error: MEMORY_ROOTS_WORDING.saveFailed })
    try {
      writeMemoryConfig(this.d.home, parsed.config)
    } catch {
      return this.body(cur, { error: MEMORY_ROOTS_WORDING.saveFailed })
    }
    if (picked.length > 0) await this.d.switchOn()
    return this.body({ cfg: parsed.config, agentDir, broken: false }, { saved: true })
  }
}

/** The live wiring: the app home, the agent folder (a test's, else TALOS_AGENT_DIR), and the config.json switch (synced to
 * the apps when it changes). */
export function memoryRootsFor(ctx: BridgeContext, agentDir?: string): MemoryRoots {
  return new MemoryRoots({
    home: ctx.env.home,
    agentDir: () => agentDir ?? agentDirFromEnv(process.env),
    switchIsOn: () => ctx.config.config.memory_browser,
    switchOn: async () => {
      if (ctx.config.config.memory_browser) return
      const after = ctx.config.update((c) => ({ ...c, memory_browser: true }))
      await ctx.transport
        .sendDurable(configSyncFrame(ctx.clock.now(), after))
        .then(() => ctx.config.markSynced(after))
        .catch((e) => ctx.log.warn('config.sync not sent', { error: (e as Error).message }))
    },
  })
}
