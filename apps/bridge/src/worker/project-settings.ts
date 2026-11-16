// What the project settings a thread session loads (`.claude/settings.json` and `.claude/settings.local.json` in its folder,
// and in that folder's git root when it sits below one: Claude Code loads both) may carry. A session with acceptEdits can write
// files in its folder, and Claude Code applies what those files say with no owner card:
//   - `env` reaches every process the session starts, the shell that runs the permission hook among them, and steers Claude
//     Code itself. What can run code before the hook's own `env -i` has no short list (a preload, an imported bash function,
//     xtrace's PS4, GCONV_PATH with a charset, CLAUDE_CODE_SHELL_PREFIX wrapping every hook and command), so `env` is ALLOWED
//     only a short list of Claude Code tunables, in every folder, the agent folder too.
//   - outside the agent folder, only the plain top-level keys below are allowed (no hooks, status lines, helpers, plugins, MCP
//     servers), and `permissions` only `deny` and `ask` (an `allow` rule would let the session skip the card altogether).
//   - the agent folder's own settings carry the kit's hooks, status line and the owner's rules (Main runs with them too): there
//     only the commands Claude Code runs besides those (credential helpers and the like) are refused.
// Checked at each start (the planner), and again by the bridge at every permission request (hub/server.ts) from the folders the
// start recorded. The second check only stops an honest hook (a hijacked one never asks the bridge): the start check and the
// hook's clean environment are the controls.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  permissionRuleProblem,
  THREAD_FOLDER_ALLOWED_ENV,
  THREAD_FOLDER_ALLOWED_KEYS,
  THREAD_FOLDER_ALLOWED_PERMISSION_KEYS,
} from '@talos-app/protocol'
import { ensureDir, writeFileAtomic } from '../fsutil.ts'
import { workerDir } from './files.ts'

/** One folder whose project settings a session loads, and whether it is the agent folder. */
export type CheckedFolder = { folder: string; agent_folder: boolean }
/** What a start records for the bridge's check at each request: every folder whose project settings the session loads. */
export type ProjectCheck = {
  v: 1
  folders: CheckedFolder[]
  /** The --setting-sources the session started with (null: none named; absent: a start before this was recorded). */
  sources?: string | null
}
export const PROJECT_CHECK_FILE = 'project-check.json'
const CHECK_FILE = PROJECT_CHECK_FILE

export function writeProjectCheck(talosHome: string, threadId: string, c: ProjectCheck): void {
  const dir = workerDir(talosHome, threadId)
  ensureDir(dir)
  writeFileAtomic(join(dir, CHECK_FILE), projectCheckText(c), 0o600)
}

/** The record's bytes as written (the launch spec hashes exactly these). */
export const projectCheckText = (c: ProjectCheck): string => `${JSON.stringify(c)}\n`

/** The start's record, or null when there is none (a session started by a build before it) or it is not that shape. */
export function readProjectCheck(talosHome: string, threadId: string): ProjectCheck | null {
  try {
    const r = JSON.parse(readFileSync(join(workerDir(talosHome, threadId), CHECK_FILE), 'utf8')) as {
      v?: unknown
      folders?: unknown
    }
    if (r.v !== 1 || !Array.isArray(r.folders) || r.folders.length === 0 || r.folders.length > 4) return null
    const folders: CheckedFolder[] = []
    for (const f of r.folders as Array<Partial<CheckedFolder>>) {
      if (typeof f?.folder !== 'string' || !isAbsolute(f.folder) || typeof f.agent_folder !== 'boolean') return null
      folders.push({ folder: f.folder, agent_folder: f.agent_folder })
    }
    const sources = (r as { sources?: unknown }).sources
    return { v: 1, folders, ...(typeof sources === 'string' || sources === null ? { sources } : {}) }
  } catch {
    return null
  }
}

// the allow-lists: one table for Linux and the Mac (packages/protocol/tables/thread-folder-settings.json)
export const ALLOWED_ENV = THREAD_FOLDER_ALLOWED_ENV
export const ALLOWED_KEYS = THREAD_FOLDER_ALLOWED_KEYS
const ALLOWED_PERMISSION_KEYS = THREAD_FOLDER_ALLOWED_PERMISSION_KEYS

/** How the owner fixes any refusal: the same words on Linux and the Mac. */
export const FIX = "remove it or move this thread's folder"

/** A settings file bigger than this is not read (nor loaded as fit). */
const MAX_SETTINGS_BYTES = 256 * 1024 // the Mac's and the hook's cap

/** The project settings files Claude Code loads from a folder. */
export const projectSettingsFiles = (folder: string) => [
  join(folder, '.claude', 'settings.json'),
  join(folder, '.claude', 'settings.local.json'),
]

/** A key as the owner may be shown it: the thread writes these names, so anything else is not repeated. */
const shown = (keys: string[]) =>
  keys
    .slice(0, 3)
    .map((k) => (/^[A-Za-z0-9_$]{1,40}$/.test(k) ? k : 'a key that cannot be shown'))
    .join(', ')

// for folders only: a file's real path goes through realFileSync (real-file.ts), as realpath can name a hard-linked file by another of its names
const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/**
 * The repo roots whose `.claude/settings.local.json` Claude Code loads for a session in `folder`: the nearest folder at or
 * above it that holds `.git`, and, when that `.git` is a worktree's FILE, the canonical root it leads to (`gitdir:`, then that
 * folder's `commondir`: the main checkout). Claude Code loads the canonical root's, so a thread that writes a `.git` file in its
 * own folder could name any folder as its root: every folder on the way is checked (more than Claude Code loads is safe). A
 * `.git` that is a link, or a pointer that cannot be followed, is a problem (the start is refused), never guessed past.
 */
export function gitRoots(folder: string): { roots: string[] } | { problem: string } {
  let d = real(folder)
  while (d) {
    const dotGit = join(d, '.git')
    let st: ReturnType<typeof lstatSync> | null = null
    try {
      st = lstatSync(dotGit)
    } catch {}
    if (st?.isSymbolicLink()) return { problem: `${dotGit} is a link: ${FIX}` }
    if (st?.isDirectory()) return { roots: [d] }
    if (st?.isFile()) {
      let common: string[] | null
      try {
        common = canonicalOf(d, dotGit)
      } catch {
        common = null // a pointer that cannot be read (its mode, a race): refused like one that cannot be followed
      }
      if (!common) return { problem: `${dotGit} names a repository that cannot be followed: ${FIX}` }
      return { roots: [...new Set([d, ...common])] }
    }
    const up = dirname(d)
    if (up === d) return { roots: [] }
    d = up
  }
  return { roots: [] }
}

/**
 * A worktree's `.git` file to the folders Claude Code could take as the canonical root, read the way it reads them: the whole
 * trimmed text after `gitdir:` (never only up to a line break), resolved LEXICALLY against the folder, then `commondir`
 * against that. Both must already be what they resolve to (no link on the way), so the folder this check reads is the folder
 * Claude Code reads. Both the common folder and its parent are returned (more than Claude Code loads is safe). Null when any
 * of it cannot be followed, or names a path with a control character or a line or paragraph separator in it.
 */
function canonicalOf(root: string, dotGit: string): string[] | null {
  const text = smallText(dotGit, 4096)?.trim()
  if (!text?.startsWith('gitdir:')) return null
  const gitdirText = text.slice('gitdir:'.length).trim()
  if (gitdirText === '' || ODD_PATH.test(gitdirText)) return null
  const g = resolve(root, gitdirText)
  if (real(g) !== g) return null
  let u = g
  const commondirFile = join(g, 'commondir')
  let st: ReturnType<typeof lstatSync> | null = null
  try {
    st = lstatSync(commondirFile)
  } catch {}
  if (st) {
    const c = smallText(commondirFile, 4096)?.trim()
    if (!c || ODD_PATH.test(c)) return null
    u = resolve(g, c)
    if (real(u) !== u) return null
  }
  return [...new Set([basename(u) === '.git' ? dirname(u) : u, u, dirname(u)])]
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const ODD_PATH = /[\u0000-\u001f\u007f\u2028\u2029]/

/**
 * A small regular file's text, or null when it is not one: opened without blocking and judged by its own descriptor, so a FIFO
 * or a device (a link to /dev/zero) at that path never stalls the bridge or the supervisor. Throws ENOENT when it is not there.
 */
export function smallText(path: string, max: number, noFollow = false): string | null {
  // noFollow: a link at the path itself is never followed (ELOOP is thrown)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0))
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > max) return null
    // never more than max bytes, even from a file that grows after the fstat
    const buf = Buffer.alloc(max + 1)
    let n = 0
    for (let r = 1; r > 0 && n <= max; n += r) r = readSync(fd, buf, n, max + 1 - n, null)
    if (n > max) return null
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Every folder whose project settings a session in `folder` loads: the folder, and its repo roots when those are others. */
export function sessionSettingsFolders(
  folder: string,
  agentDir: string,
): { folders: CheckedFolder[] } | { problem: string } {
  const agent = real(agentDir)
  const own = real(folder) ?? folder
  const roots = gitRoots(own)
  if ('problem' in roots) return roots
  const folders: CheckedFolder[] = [{ folder: own, agent_folder: own === agent }]
  // a root is held to the full lists even when it is the agent folder (as on the Mac): only the session's own folder is spared
  for (const r of roots.roots) if (r !== own) folders.push({ folder: r, agent_folder: false })
  return { folders }
}

/**
 * Null when the folder's project settings are fit for a thread session; else the reason, in words for the owner. A file that
 * is not there is fine; one that is there and cannot be read as a JSON object is refused (what Claude Code makes of it is not
 * this check's to guess).
 */
export function projectSettingsProblem(folder: string, isAgentFolder: boolean): string | null {
  for (const file of projectSettingsFiles(folder)) {
    let text: string | null
    try {
      text = smallText(file, MAX_SETTINGS_BYTES)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
      return `${file} cannot be read: ${FIX}`
    }
    if (text === null) return `${file} is not a plain file of at most 256 KB: ${FIX}`
    if (text.trim() === '') continue // an empty file is no settings (as the Mac and the hook read it)
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return `${file} is not valid JSON: ${FIX}`
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return `${file} is not a settings object: ${FIX}`
    const s = raw as Record<string, unknown>
    if (s.env !== undefined) {
      if (s.env === null || typeof s.env !== 'object' || Array.isArray(s.env))
        return `${file} has an env that is not an object: ${FIX}`
      // a key off the list, or a value that is not plain text or a number (what else would Claude Code make of it?)
      const env = s.env as Record<string, unknown>
      const other = Object.keys(env).filter(
        (k) => !ALLOWED_ENV.has(k) || !['string', 'number', 'boolean'].includes(typeof env[k]),
      )
      if (other.length > 0) return `${file} sets ${shown(other)} in env, which a thread session may not set: ${FIX}`
    }
    // the agent folder's own settings carry the kit's hooks and status line and the owner's rules: only env is held there
    if (isAgentFolder) continue
    const other = Object.keys(s).filter((k) => !ALLOWED_KEYS.has(k))
    if (other.length > 0) return `${file} has ${shown(other)}, which only the agent folder's settings may have: ${FIX}`
    if (s.permissions !== undefined) {
      if (s.permissions === null || typeof s.permissions !== 'object' || Array.isArray(s.permissions))
        return `${file} has permissions that are not an object: ${FIX}`
      const widen = Object.keys(s.permissions).filter((k) => !ALLOWED_PERMISSION_KEYS.has(k))
      if (widen.length > 0)
        return `${file} has permissions ${shown(widen)}, which only the agent folder's settings may have: ${FIX}`
    }
  }
  return null
}

/** The first problem among every folder a session loads project settings from, or null. */
export function sessionSettingsProblem(folders: readonly CheckedFolder[]): string | null {
  for (const f of folders) {
    const why = projectSettingsProblem(f.folder, f.agent_folder)
    if (why) return why
  }
  return null
}

/** A line for the owner with every control, bidi or invisible character (a thread can name a file with them) shown as U+XXXX. */
export function plainPath(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is shown
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
    (c) => `U+${(c.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}`,
  )
}

/**
 * The deny and ask rules of these folders' own settings files, each path rule made absolute where it was written (a session
 * that loads only the user's settings would lose them otherwise; they only narrow what it may do). Nothing is ever dropped:
 * a file that is there but cannot be read whole as settings (a link, too big, not JSON, the wrong shape, a non-string entry)
 * or a rule outside the grammar this check reads (permissionRuleProblem) would let the session do what the folder's owner
 * forbade, so `refused` names it and the start is refused. A file that is not there, or empty, holds no rules.
 */
export function folderNarrowingRules(
  folders: readonly CheckedFolder[],
  absolutize: (rule: string, slashAnchor: string, cwdAnchor: string) => string,
): { deny: string[]; ask: string[]; refused: string | null } {
  const deny = new Set<string>()
  const ask = new Set<string>()
  let refused: string | null = null
  const refuse = (file: string, why: string) => {
    refused ??= `${plainPath(file)}: ${why}`
  }
  for (const f of folders)
    for (const file of projectSettingsFiles(f.folder)) {
      // a file that could hold deny or ask rules is read whole or the start is refused: never its rules quietly lost
      let st: ReturnType<typeof lstatSync> | null = null
      try {
        st = lstatSync(file)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') continue // not there: nothing to carry
        refuse(file, `cannot be looked at (${code}), so its deny and ask rules cannot be carried over`)
        continue
      }
      if (st.isSymbolicLink()) {
        refuse(file, 'is a link, so its deny and ask rules cannot be carried over')
        continue
      }
      let s: unknown
      try {
        const text = smallText(file, MAX_SETTINGS_BYTES, true)
        if (text === null) {
          refuse(file, 'is not a plain file of at most 256 KB, so its deny and ask rules cannot be carried over')
          continue
        }
        if (text.trim() === '') continue // empty: no settings (as Claude Code, the Mac and the hook read it)
        s = JSON.parse(text)
      } catch {
        refuse(file, 'cannot be read as JSON, so its deny and ask rules cannot be carried over')
        continue
      }
      if (s === null || typeof s !== 'object' || Array.isArray(s)) {
        refuse(file, 'is not a settings object')
        continue
      }
      const perms = (s as { permissions?: unknown }).permissions
      if (perms === undefined) continue
      if (perms === null || typeof perms !== 'object' || Array.isArray(perms)) {
        refuse(file, '"permissions" is not an object')
        continue
      }
      for (const [key, into] of [
        ['deny', deny],
        ['ask', ask],
      ] as const) {
        const list = (perms as Record<string, unknown>)[key]
        if (list === undefined) continue
        if (!Array.isArray(list)) {
          refuse(file, `"permissions.${key}" is not a list`)
          continue
        }
        for (const r of list) {
          if (typeof r !== 'string') {
            refuse(file, `"permissions.${key}" holds something that is not a rule`)
            continue
          }
          const why = permissionRuleProblem(r)
          if (why) refuse(file, `${key} rule ${JSON.stringify(plainPath(r.slice(0, 80)))}: ${why}`)
          else into.add(absolutize(r, f.folder, f.folder))
        }
      }
    }
  return { deny: [...deny], ask: [...ask], refused }
}
