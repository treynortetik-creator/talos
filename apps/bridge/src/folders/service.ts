// The folder lister behind the picker (docs/SECURITY.md "Folder listing"). The app asks which FOLDERS are inside a folder on
// this Mac; this answers with their names and nothing else: no files, no sizes, no times, no contents. It is a read for the
// owner's signed device only (inbound-reads.ts runs the signature check before it is called) and no agent tool reaches it.
//
// What it refuses, always with the one sentence FOLDER_WORDING.refused (a missing folder, a file and a refused folder all read
// the same, so it cannot be used to find out what exists):
//  - anything that is not an absolute path made of plain text: relative, `.` or `..` segments, `//`, NUL or other control
//    characters, half a character (invalid text), longer than a thread's folder may be;
//  - anything outside the owner's home, and home's own refused roots and everything under them (folderRefusedRoots);
//  - a path with a symlink anywhere below home. A symlink is never followed: the listing leaves symlinks out entirely, so there
//    is no way to enter one from the picker either.
// Matching is by letter case folded and with /private/tmp and /tmp the same place, as macOS does, so `.SSH` is `.ssh`.
import { promises as fsp, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  FOLDER_LIST_MAX,
  FOLDER_LIST_TIME_MS,
  FOLDER_NAME_MAX,
  FOLDER_PATH_MAX,
  FOLDER_WORDING,
  type FrameOf,
  parentPath,
} from '@talos-app/protocol'
import { agentDirFromEnv } from '../last-good.ts'
import { claudeConfigDir, defaultLeadRoots } from '../lead/fence.ts'
import { type FolderBody, type FolderServiceSeam, ReadError } from '../v2-seams.ts'

/** The file system calls the lister makes. Tests swap them (a folder that never opens, a disk that spells a path another way). */
export type FolderFs = Pick<typeof fsp, 'opendir' | 'lstat' | 'realpath' | 'stat'>

export type FolderDeps = {
  /** The owner's home folder. Nothing outside it is ever listed. */
  home: string
  /** The Talos data folder (TALOS_APP_HOME). */
  talosHome: string
  /** Claude Code's config folder (`CLAUDE_CONFIG_DIR`, else `<home>/.claude`). */
  claudeDir: string
  /** The main agent folder, when the process knows it (TALOS_AGENT_DIR, the same source the bridge uses everywhere: `agentDirFromEnv`). */
  agentDir?: string | undefined
  /** How long one listing may take. */
  timeMs?: number
  /** The clock, in ms. A test seam. */
  now?: () => number
  /** A test seam: the disk. */
  fs?: Partial<FolderFs>
  /** Where a note goes when a refused root is home itself and is left out. */
  log?: { warn(msg: string, fields?: Record<string, unknown>): void }
}

/**
 * Folders under home that are never listed or entered, besides what a lead's fence already protects (`defaultLeadRoots`:
 * the agent folder, the Claude config folder and its global files, the Talos home, the vault, ~/.ssh, ~/.config/gh, ~/.aws,
 * ~/.npmrc, ~/.netrc). The lead fence's list is reused as it is, not copied. These are the folders a picker must keep out
 * that a lead's command line does not need named: key and token stores (GnuPG, Docker, Kubernetes, the cloud CLIs, other AI
 * tools' folders, pass, keyrings), Talos's own config and inbox folders, and the macOS Library (keychains, mail, browser data).
 * This is the ONE list: the picker and the save path (worker/patch-check.ts) both read it.
 */
export const FOLDER_EXTRA_REFUSED = [
  '.gnupg',
  '.config/talos',
  '.talos-inbox',
  'Library',
  '.docker',
  '.kube',
  '.config/gcloud',
  '.azure',
  '.codex',
  '.gemini',
  '.password-store',
  '.local/share/keyrings',
] as const

/**
 * What a live bridge lists with: the owner's real home, the Talos home, the Claude config folder (an unusable
 * `CLAUDE_CONFIG_DIR` falls back to `<home>/.claude`, which is also always refused) and the agent folder TALOS_AGENT_DIR names.
 * `over` is the tests' temp home.
 */
export function folderDeps(
  talosHome: string,
  processEnv: Record<string, string | undefined> = process.env,
  over: Partial<FolderDeps> = {},
): FolderDeps {
  const home = over.home ?? homedir()
  let claudeDir: string
  try {
    claudeDir = claudeConfigDir(home, processEnv.CLAUDE_CONFIG_DIR)
  } catch {
    claudeDir = join(home, '.claude')
  }
  const agentDir = agentDirFromEnv(processEnv)
  return { home, talosHome, claudeDir, ...(agentDir ? { agentDir } : {}), ...over }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
/** One spelling to compare by: composed text (macOS may hand back decomposed), no case (`.SSH`, `.ſsh`), `/private/tmp` = `/tmp`. */
export const foldPath = (p: string) =>
  p
    .normalize('NFC')
    .replace(/^\/private(?=\/)/, '')
    .toUpperCase()
    .toLowerCase()
const within = (p: string, root: string) => p === root || p.startsWith(`${root}/`)
const byName = (a: string, b: string) => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0
}

/** Every root the picker refuses, as absolute paths. A root that is home itself is left out (it would refuse everything); `onHome` hears of it. */
export function folderRefusedRoots(
  d: Pick<FolderDeps, 'home' | 'talosHome' | 'claudeDir' | 'agentDir'>,
  onHome?: (root: string) => void,
): string[] {
  const lead = defaultLeadRoots({
    agentDir: d.agentDir ?? '',
    talosHome: d.talosHome,
    home: d.home,
    claudeDir: d.claudeDir,
  })
  const home = d.home.replace(/\/+$/, '')
  const all = [...new Set([...lead, ...FOLDER_EXTRA_REFUSED.map((p) => join(home, p))])].filter((r) => r !== '')
  return all.filter((r) => {
    if (foldPath(r.replace(/\/+$/, '')) !== foldPath(home)) return true
    onHome?.(r)
    return false
  })
}

/** True when `path` is a refused root or inside one. `roots` come from `folderRefusedRoots`; each is checked as written and as the disk resolves it. */
export function underRefusedRoot(
  path: string,
  roots: readonly string[],
  realOf: (p: string) => string = (p) => p,
): boolean {
  const p = foldPath(path)
  return roots.some((r) => within(p, foldPath(r)) || within(p, foldPath(realOf(r))))
}

function code(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code
}

export class FolderService implements FolderServiceSeam {
  readonly available = true
  private readonly timeMs: number
  private readonly now: () => number
  private readonly home: string
  private readonly refused: string[]
  private readonly fs: FolderFs

  constructor(private readonly deps: FolderDeps) {
    this.timeMs = deps.timeMs ?? FOLDER_LIST_TIME_MS
    this.now = deps.now ?? Date.now
    this.home = deps.home.replace(/\/+$/, '')
    this.fs = { ...fsp, ...deps.fs } as FolderFs
    const roots = folderRefusedRoots(deps, (r) =>
      deps.log?.warn('a refused folder root is the home folder itself, so it is ignored (the rest are still refused)', {
        root: r,
      }),
    )
    // each root both as written and as the disk resolves it (a Talos home reached through a symlink), folded
    this.refused = [...new Set(roots.flatMap((r) => [foldPath(r), foldPath(realOrSync(r))]))]
  }

  private refuse(): never {
    throw new ReadError('bad_frame', FOLDER_WORDING.refused)
  }

  /** A failed disk call: the system saying no is told in words; anything else (not there, not a folder) reads as the one refusal. */
  private failed(e: unknown): never {
    if (e instanceof ReadError) throw e
    if (code(e) === 'EACCES' || code(e) === 'EPERM') throw new ReadError('bad_frame', FOLDER_WORDING.noAccess)
    return this.refuse()
  }

  private isRefused(path: string): boolean {
    const p = foldPath(path)
    return this.refused.some((r) => within(p, r))
  }

  /** The path as plain text the Mac will use, or a refusal. */
  private clean(path: unknown): string {
    if (typeof path !== 'string' || path.length === 0 || path.length > FOLDER_PATH_MAX) return this.refuse()
    if (CONTROL.test(path) || LONE_SURROGATE.test(path) || path.includes('�')) return this.refuse()
    if (!path.startsWith('/')) return this.refuse()
    const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
    const parts = trimmed.split('/').slice(1)
    if (parts.some((s) => s === '' || s === '.' || s === '..')) return this.refuse()
    return trimmed
  }

  /**
   * Throws unless `path` is a real folder inside home, reached through no symlink, and not a refused root or under one, by
   * the way it was written and by the way the disk spells it. Returns the disk's own spelling.
   */
  private async check(path: string): Promise<string> {
    if (!within(foldPath(path), foldPath(this.home)) || this.isRefused(path)) this.refuse()
    try {
      // walk down from home: every step must be a plain folder (lstat does not follow), so no symlink is ever crossed
      let cur = this.home
      for (const part of path.slice(this.home.length).split('/').filter(Boolean)) {
        cur = join(cur, part)
        const st = await this.fs.lstat(cur)
        if (st.isSymbolicLink() || !st.isDirectory()) this.refuse()
      }
      if (!(await this.fs.stat(this.home)).isDirectory()) this.refuse()
      // the disk's own spelling of the folder: another case or another Unicode form of a refused root is still that root
      const real = await this.fs.realpath(path)
      if (this.isRefused(real)) this.refuse()
      return real
    } catch (e) {
      return this.failed(e)
    }
  }

  async list(f: Pick<FrameOf<'fs.list'>, 'path' | 'hidden'>): Promise<FolderBody> {
    const base = { home: this.home, ...(this.deps.agentDir ? { agent_dir: this.deps.agentDir } : {}) }
    if (f.path === null) return { ...base, entries: [], more: 0 }
    const path = this.clean(f.path)
    const stop = { now: false }
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        stop.now = true
        reject(new ReadError('internal', FOLDER_WORDING.slow))
      }, this.timeMs)
    })
    try {
      const names = await Promise.race([this.read(path, f.hidden, stop), late])
      names.sort(byName)
      const shown = names.slice(0, FOLDER_LIST_MAX)
      return {
        ...base,
        path,
        parent: path === this.home ? null : parentPath(path),
        entries: shown.map((name) => ({ name })),
        more: names.length - shown.length,
      }
    } finally {
      clearTimeout(timer)
      stop.now = true
    }
  }

  private async read(path: string, hidden: boolean, stop: { now: boolean }): Promise<string[]> {
    const real = await this.check(path)
    const started = this.now()
    const names: string[] = []
    try {
      const dir = await this.fs.opendir(path)
      for await (const e of dir) {
        if (stop.now) break
        if (this.now() - started > this.timeMs) throw new ReadError('internal', FOLDER_WORDING.slow)
        const name = e.name
        // a symlink (the entry type says so; nothing is followed) and a file are left out, and so is anything the app could
        // not name back: a control character, broken text, or a name too long to send
        if (!e.isDirectory()) continue
        if (name.length === 0 || name.length > FOLDER_NAME_MAX || CONTROL.test(name) || name.includes('�')) continue
        if (name.includes('/')) continue
        if (!hidden && name.startsWith('.')) continue
        if (this.isRefused(join(path, name))) continue
        names.push(name)
      }
      // the folder may have been swapped for another place while it was read: look at the disk again before any name goes out
      const again = await this.fs.realpath(path)
      if (foldPath(again) !== foldPath(real) || this.isRefused(again)) this.refuse()
    } catch (e) {
      return this.failed(e)
    }
    return names
  }
}

function realOrSync(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
