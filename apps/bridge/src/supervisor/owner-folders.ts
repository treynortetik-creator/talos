// Which thread folders the OWNER chose, as the supervisor may rely on it (the Mac reads the same file: OwnerFolders.swift).
// Folder trust (folder-trust.ts) is answered only for a folder in here. config.json is not enough: `talos-app lead init` and a
// hand edit write session_opts.cwd without the owner looking at the folder, and the trust card that shows the folder is then
// the owner's check. The file is written by exactly one thing, the bridge, after a signed `config.patch` from the app (the
// owner's Settings, Create / Choose a folder, onboarding all arrive that way) changed a thread's folder or made a thread with one.
//   <talos home>/owner-folders.json   {"v":1,"threads":{"<thread id>":{"cwd":"<as configured>","real":"<its real path then>"}}}
// A record counts only while the thread's configured folder is still exactly `cwd` and the folder still resolves to `real`:
// a later change of folder (by anyone) leaves the old record with nothing to match. A patch that only echoes the folder back
// (Settings sends what it last saw) keeps an old record and never makes one, so a folder an agent set cannot be laundered.
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../fsutil.ts'

export type OwnerFolder = { cwd: string; real: string }
export type OwnerFolders = Record<string, OwnerFolder>

export const ownerFoldersPath = (talosHome: string) => join(talosHome, 'owner-folders.json')
const MAX_BYTES = 256 * 1024

const real = (p: string): string | null => {
  try {
    return realpathSync(p).replace(/(.)\/+$/, '$1')
  } catch {
    return null
  }
}

/** The records on disk; none when the file is missing, a link, too big or not what is written here (never a partial read). */
export function readOwnerFolders(talosHome: string): OwnerFolders {
  const path = ownerFoldersPath(talosHome)
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.size > MAX_BYTES) return {}
    const j = JSON.parse(readFileSync(path, 'utf8')) as { v?: unknown; threads?: unknown }
    if (j.v !== 1 || typeof j.threads !== 'object' || j.threads === null || Array.isArray(j.threads)) return {}
    const out: OwnerFolders = {}
    for (const [id, r] of Object.entries(j.threads)) {
      const o = r as { cwd?: unknown; real?: unknown }
      if (typeof o?.cwd === 'string' && typeof o.real === 'string') out[id] = { cwd: o.cwd, real: o.real }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Is `folder` (the resolved folder a start launches in) the owner's choice for the thread: a record for the thread (or, for a
 * sub-thread that shares its parent's folder, for its parent) that names the folder as configured now and as it resolves now.
 */
export function ownerChose(talosHome: string, ids: readonly string[], configured: string, folder: string): boolean {
  const all = readOwnerFolders(talosHome)
  return ids.some((id) => all[id]?.cwd === configured && all[id]?.real === folder)
}

type ThreadLike = { id: string; session_opts?: { cwd?: unknown } | null }
const cwdOf = (t: ThreadLike | undefined): string | null =>
  typeof t?.session_opts?.cwd === 'string' ? t.session_opts.cwd : null

/**
 * After a signed config.patch was applied: a thread whose folder the patch SET to something new (a new thread, or a changed
 * folder, named in the patch) is recorded as the owner's choice; an old record is kept only while it still matches the folder;
 * everything else is dropped. Returns whether the file changed. Never throws (no record is the safe answer).
 */
export function recordOwnerFolders(
  talosHome: string,
  before: readonly ThreadLike[],
  after: readonly ThreadLike[],
  patchThreads: unknown,
): void {
  const named = new Set<string>()
  if (Array.isArray(patchThreads))
    for (const p of patchThreads as Array<{ id?: unknown; session_opts?: { cwd?: unknown } | null }>)
      if (typeof p?.id === 'string' && typeof p.session_opts?.cwd === 'string') named.add(p.id)
  const old = readOwnerFolders(talosHome)
  const next: OwnerFolders = {}
  for (const t of after) {
    const cwd = cwdOf(t)
    if (cwd === null) continue
    const changed = cwdOf(before.find((b) => b.id === t.id)) !== cwd
    const r = real(cwd)
    if (named.has(t.id) && changed && r !== null) next[t.id] = { cwd, real: r }
    else if (old[t.id]?.cwd === cwd) next[t.id] = old[t.id] as OwnerFolder
  }
  if (JSON.stringify(next) === JSON.stringify(old)) return
  writeFileAtomic(ownerFoldersPath(talosHome), JSON.stringify({ v: 1, threads: next }), 0o600)
}
