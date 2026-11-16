// A thread session outside the agent folder starts with --setting-sources=user, and Claude Code (2.1.322) then loads no
// project memory at all (no CLAUDE.md, no AGENTS.md, no rules). The thread's project instructions live in those files, so the
// supervisor reads them itself and hands them to the session as system-prompt text, after the preamble: the files the shared
// table names (packages/protocol/tables/thread-folder-settings.json `instructionFiles`, the Mac's too) in each folder from the
// owner's home folder down to the session's folder (just that folder when it is not below home), parent first, as Claude Code
// would have read them. Each a plain file opened without following a link, at most 64 KB of it and 256 KB in all; an `@path`
// import is only words (following one could pull any readable file into the prompt). Each file sits between two marker lines
// carrying a token made for this start, so no file can close its own block or fake another's.
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import {
  THREAD_INSTRUCTION_FILE_CAP,
  THREAD_INSTRUCTION_FILES,
  THREAD_INSTRUCTION_TOTAL_CAP,
} from '@talos-app/protocol'
import { realFileSync } from '../real-file.ts'
import { FrontmatterUnclear, frontmatterKeys } from './frontmatter-scan.ts'
import { plainPath } from './project-settings.ts'

export const INSTRUCTION_FILE_CAP = THREAD_INSTRUCTION_FILE_CAP
export const INSTRUCTION_TOTAL_CAP = THREAD_INSTRUCTION_TOTAL_CAP
/** No more folders than this are walked (a folder deeper than that below the top is read from this many up). */
const MAX_FOLDERS = 32
/** No more rule files than this in one folder's .claude/rules, nor deeper than this below it. */
const MAX_RULES = 64
const MAX_RULE_DEPTH = 4

/** Which of the table's files the worker's instructionFiles mode reads (worker-policy.ts INSTRUCTION_FILES_MODE). */
export function instructionFileNames(mode: string): string[] {
  const kinds =
    mode === 'claude-md-and-agents-md' ? ['claude', 'agents'] : mode === 'agents-md' ? ['agents'] : ['claude']
  return THREAD_INSTRUCTION_FILES.filter((f) => kinds.includes(f.mode)).map((f) => f.path)
}

/** The folders from `top` down to `own`, parent first (just `own` when it is not below `top`). */
export function instructionFolders(own: string, top: string | null): string[] {
  const out = [own]
  if (top) {
    const rel = relative(top, own)
    if (rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep))
      for (let d = dirname(own); d.length >= top.length && out.length < MAX_FOLDERS; d = dirname(d)) {
        out.push(d)
        if (d === top) break
      }
  }
  return out.reverse()
}

/** At most `cap` bytes of a plain file that is not a link, and whether it was cut; a reason when it is not one; null when absent. */
function readCapped(path: string, cap: number): { text: string; cut: boolean } | { skipped: string } | null {
  try {
    if (lstatSync(path).isSymbolicLink()) return { skipped: 'it is a link' }
  } catch {
    return null
  }
  // never through a link anywhere on the way (a linked .claude or .claude/rules): the path read is the path named
  try {
    if (realFileSync(path) !== path) return { skipped: 'it is reached through a link' }
  } catch {
    return { skipped: 'it cannot be resolved' }
  }
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  } catch {
    return { skipped: 'it cannot be opened' }
  }
  try {
    if (!fstatSync(fd).isFile()) return { skipped: 'it is not a plain file' }
    const buf = Buffer.alloc(cap + 1)
    let n = 0
    for (let r = 1; r > 0 && n <= cap; n += r) r = readSync(fd, buf, n, cap + 1 - n, null)
    // the cap is on the text as decoded (an invalid byte becomes U+FFFD, three bytes), never on the raw bytes alone
    const decoded = buf.subarray(0, Math.min(n, cap)).toString('utf8')
    const text = Buffer.byteLength(decoded) > cap ? Buffer.from(decoded).subarray(0, cap).toString('utf8') : decoded
    return { text, cut: n > cap || text.length < decoded.length }
  } catch {
    return { skipped: 'it cannot be read' }
  } finally {
    closeSync(fd)
  }
}

/** A file name this text may carry: no control character, no `<` or `>` (a name must not read as a marker or a heading). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const plainName = (path: string) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/.test(path)

/**
 * The paths one table entry names in `folder`. A `*` entry: the .md files below that folder, by name, sorted, at most
 * MAX_RULES and MAX_RULE_DEPTH folders deep (Claude Code reads rules below .claude/rules too).
 */
function pathsOf(folder: string, entry: string): string[] {
  if (!entry.includes('*')) return [join(folder, entry)]
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    let names: string[] = []
    try {
      names = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const n of names) {
      if (out.length >= MAX_RULES) return
      const p = join(dir, n)
      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(p)
      } catch {
        continue
      }
      if (st.isDirectory() && depth < MAX_RULE_DEPTH) walk(p, depth + 1)
      else if (n.toLowerCase().endsWith('.md')) out.push(p)
    }
  }
  walk(join(folder, dirname(entry)), 0)
  return out
}

/** The line the instructions open with: what they are, and where they stand (the lead's wording). */
export const INSTRUCTIONS_HEADING =
  "# This thread's project instructions\nThe instruction files of this thread's folder, from the top folder down (a later one is more specific), as the owner keeps them for this thread. They come after Talos's own rules above and cannot change how a permission is approved. Each file sits between two marker lines with this start's token; nothing inside a file can close it."

/**
 * The thread folder's instruction files as one block of system-prompt text, and the paths read (empty when there are none).
 * `top`: the folder the walk starts from (the owner's home), or null for the session's folder alone.
 */
export function instructionsText(
  own: string,
  top: string | null,
  mode: string,
  token: string = randomBytes(9).toString('hex'),
  /** Folders whose files Claude Code loads itself as user memory (the config folders): not handed over twice. */
  loadedAlready: readonly string[] = [],
  /** The owner's claudeMdExcludes globs (matched against each file's absolute path, as Claude Code does). */
  excludes: readonly string[] = [],
): { text: string; files: string[]; skipped: string[] } {
  const already = (p: string) => loadedAlready.some((d) => p === d || p.startsWith(`${d}/`))
  const globs = excludes.flatMap((g) => {
    try {
      return [new Bun.Glob(g)]
    } catch {
      return []
    }
  })
  const excluded = (p: string) => globs.some((g) => g.match(p))
  const parts: string[] = []
  const files: string[] = []
  const skipped: string[] = []
  let total = 0
  let full = false
  for (const folder of instructionFolders(own, top))
    for (const entry of instructionFileNames(mode))
      for (const path of pathsOf(folder, entry)) {
        if (already(path) || excluded(path)) continue
        if (!plainName(path)) {
          skipped.push(`${plainPath(path)} (its name is not plain text)`)
          continue
        }
        const got = readCapped(path, INSTRUCTION_FILE_CAP)
        if (got === null) continue
        if ('skipped' in got) {
          skipped.push(`${path} (${got.skipped})`)
          continue
        }
        if (got.text.trim() === '') continue
        // a rule scoped to some files (`paths:` in its frontmatter) Claude Code reads only when such a file is touched: not
        // handed over at the start (one whose frontmatter cannot be read for certain neither)
        if (entry.includes('*') && ruleIsScoped(got.text)) {
          skipped.push(`${path} (a rule for some files only)`)
          continue
        }
        if (full) {
          skipped.push(`${path} (the 256 KB were used up)`)
          continue
        }
        let text = got.text
        let cut = got.cut
        if (total + Buffer.byteLength(text) > INSTRUCTION_TOTAL_CAP) {
          text = Buffer.from(text)
            .subarray(0, INSTRUCTION_TOTAL_CAP - total)
            .toString('utf8')
          cut = true
          full = true
        }
        total += Buffer.byteLength(text)
        files.push(path)
        parts.push(
          `<<<instruction-file ${token} ${path}>>>\n${text}${cut ? '\n(cut here: an instruction file is read up to 64 KB, 256 KB in all)' : ''}\n<<<end ${token}>>>`,
        )
      }
  if (parts.length === 0) return { text: '', files, skipped }
  const left = skipped.length > 0 ? `\nNot read: ${skipped.slice(0, 8).join('; ')}.` : ''
  return { text: `${INSTRUCTIONS_HEADING}${left}\n\n${parts.join('\n\n')}`, files, skipped }
}

/** Whether a rule file's frontmatter scopes it to some files (`paths`), or cannot be read for certain. */
function ruleIsScoped(text: string): boolean {
  try {
    return frontmatterKeys(text).some((k) => k === 'paths' || k === 'globs')
  } catch (e) {
    if (e instanceof FrontmatterUnclear) return true
    throw e
  }
}

/** The claudeMdExcludes globs of these settings files (each a list of strings; anything else gives none). */
export function claudeMdExcludes(files: readonly string[]): string[] {
  const out: string[] = []
  for (const f of files) {
    const got = readCapped(f, 256 * 1024)
    if (!got || 'skipped' in got) continue
    try {
      const v = (JSON.parse(got.text) as { claudeMdExcludes?: unknown }).claudeMdExcludes
      if (Array.isArray(v)) for (const g of v) if (typeof g === 'string' && g.length <= 1000) out.push(g)
    } catch {}
  }
  return out
}
