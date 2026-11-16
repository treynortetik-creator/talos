// What a thread session's folders may hold besides their settings files, now that a thread session loads only the user's
// settings (`--setting-sources=user`: its folder's .claude/settings*.json never load, and their check is a warning). Claude Code
// still reads a folder's skills, custom commands and subagents (`.claude/{skills,commands,agents}/**/*.md`), and their YAML
// frontmatter can carry hooks of their own, tools allowed with no card, MCP servers or a permission mode. And a link anywhere in
// `.claude`, at `.mcp.json` or at a `.env*` file would let what this check reads differ from what Claude Code (or a tool) reads.
// So, in the session's own folder, every folder between it and its repo roots, and the roots:
//   - a link at `.claude` or anywhere under it, at `.mcp.json`, or at a `.env*` file refuses the start;
//   - a skill, command or agent file whose frontmatter has a refused key (the shared table), or one the shared reader cannot read
//     for certain (frontmatter-scan.ts, the Mac's and the hook's reader), refuses the start.
// Checked at each start (the planner) and again by the bridge at every permission request (hub/server.ts).
import { lstatSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { THREAD_FOLDER_REFUSED_FRONTMATTER_KEYS } from '@talos-app/protocol'
import { FrontmatterUnclear, frontmatterKeys } from './frontmatter-scan.ts'
import { FIX, smallText } from './project-settings.ts'

/** The folders under `.claude` whose markdown files Claude Code reads as skills, commands and subagents. */
export const FRONTMATTER_FOLDERS = ['skills', 'commands', 'agents'] as const
/** At most this many entries are looked at under one `.claude`; more refuses (never a partial check). */
const MAX_ENTRIES = 5000
/** No deeper than this under `.claude`. */
const MAX_DEPTH = 24 // the Mac's and the hook's caps
/** A skill, command or agent file bigger than this is not read (and refuses). */
const MAX_FILE_BYTES = 256 * 1024

/** A key compared as Claude Code might spell it: no case, no `-` or `_`. */
const norm = (k: string) => k.toLowerCase().replaceAll(/[-_]/g, '')
const REFUSED = new Set(THREAD_FOLDER_REFUSED_FRONTMATTER_KEYS.map(norm))
/** A key as the owner may be shown it (the thread writes it). */
const shown = (k: string) => (/^[A-Za-z0-9_-]{1,40}$/.test(k) ? k : 'a key that cannot be shown')

/**
 * The session's own folder, every folder between it and each repo root above it, and the roots (a canonical root elsewhere,
 * a worktree's main checkout, is only itself): every folder a file this check guards could be read from.
 */
export function folderChain(own: string, roots: readonly string[]): string[] {
  const out = [own]
  for (const r of roots) {
    const rel = relative(r, own)
    if (rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep)) {
      for (let d = dirname(own); d !== r && d.length > r.length; d = dirname(d)) out.push(d)
    }
    out.push(r)
  }
  return [...new Set(out)]
}

/** Null when nothing in the folder this check guards is a link; else the reason, for the owner. */
export function linkProblem(folder: string): string | null {
  const lst = (p: string) => {
    try {
      return lstatSync(p)
    } catch {
      return null
    }
  }
  const claude = join(folder, '.claude')
  const top = lst(claude)
  if (top?.isSymbolicLink()) return `${claude} is a link: ${FIX}`
  const mcp = join(folder, '.mcp.json')
  if (lst(mcp)?.isSymbolicLink()) return `${mcp} is a link: ${FIX}`
  let names: string[] = []
  try {
    names = readdirSync(folder)
  } catch {}
  for (const n of names)
    if (n.startsWith('.env') && lst(join(folder, n))?.isSymbolicLink()) return `${join(folder, n)} is a link: ${FIX}`
  if (!top?.isDirectory()) return null
  let seen = 0
  const walk = (d: string, depth: number): string | null => {
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return `${d} cannot be read: ${FIX}`
    }
    for (const n of entries) {
      if (++seen > MAX_ENTRIES) return `${claude} holds more files than can be checked: ${FIX}`
      const p = join(d, n)
      const st = lst(p)
      if (!st) return `${p} cannot be read: ${FIX}`
      if (st.isSymbolicLink()) return `${p} is a link: ${FIX}`
      if (st.isDirectory()) {
        if (depth >= MAX_DEPTH) return `${p} is nested too deep to check: ${FIX}`
        const why = walk(p, depth + 1)
        if (why) return why
      }
    }
    return null
  }
  return walk(claude, 0)
}

/** Null when no skill, command or agent file in the folder carries a refused key; else the reason, for the owner. */
export function frontmatterProblem(folder: string): string | null {
  for (const kind of FRONTMATTER_FOLDERS) {
    const root = join(folder, '.claude', kind)
    const files: string[] = []
    const walk = (d: string, depth: number) => {
      let entries: string[]
      try {
        entries = readdirSync(d)
      } catch {
        return
      }
      for (const n of entries) {
        const p = join(d, n)
        let st: ReturnType<typeof lstatSync>
        try {
          st = lstatSync(p)
        } catch {
          continue
        }
        if (st.isDirectory() && depth < MAX_DEPTH) walk(p, depth + 1)
        else if (n.toLowerCase().endsWith('.md')) files.push(p)
      }
    }
    walk(root, 0)
    for (const file of files) {
      let text: string | null
      try {
        text = smallText(file, MAX_FILE_BYTES, true)
      } catch {
        return `${file} cannot be read as a plain file: ${FIX}`
      }
      if (text === null) return `${file} is not a plain file of at most 256 KB: ${FIX}`
      let keys: string[]
      try {
        keys = frontmatterKeys(text)
      } catch (e) {
        if (!(e instanceof FrontmatterUnclear)) throw e
        return `${file}: ${e.message}, so what it runs is not known: ${FIX}`
      }
      const bad = keys.find((k) => REFUSED.has(norm(k)))
      if (bad !== undefined)
        return `${file} has ${shown(bad)} in its frontmatter, which a thread session may not carry: ${FIX}`
    }
  }
  return null
}

/** The first refusal among the folders of a session (links, then skill, command and agent files), or null. */
export function sessionFilesProblem(folders: readonly string[]): string | null {
  for (const f of folders) {
    const why = linkProblem(f) ?? frontmatterProblem(f)
    if (why) return why
  }
  return null
}
