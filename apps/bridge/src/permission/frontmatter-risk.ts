// What an edit to an agent, skill or command file would change in its frontmatter that matters to permissions. A thread's edit of
// those files (the thread fence off) asks the owner by card; the card says, in plain words, when the edit adds, removes or changes
// a key that lets the agent approve its own actions, use other tools or run on another model. A key scan, not a YAML parser:
// the keys are read by worker/frontmatter-scan.ts (the reader the hook and the Mac share), and a file it cannot read for
// certain is said to be unclear, never guessed past.
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { FrontmatterUnclear, frontmatterKeys } from '../worker/frontmatter-scan.ts'

/** The same normalisation the hook's readers use (kit/hooks/permission-relay.py `_norm_key`). */
const norm = (k: string): string => k.toLowerCase().replaceAll('-', '').replaceAll('_', '')

/** The known keys that change what an agent may do, each with the one sentence the card says about it. */
export const RISKY_KEYS: ReadonlyArray<{ key: string; says: string }> = [
  { key: 'hooks', says: 'this lets the agent run its own hook, which can approve its own actions' },
  { key: 'permissionMode', says: 'this changes how much the agent may do without asking' },
  { key: 'tools', says: 'this changes which tools the agent may use' },
  { key: 'allowed-tools', says: 'this changes which tools the agent may use' },
  { key: 'disallowedTools', says: 'this changes which tools the agent may use' },
  { key: 'mcpServers', says: 'this gives the agent its own connector servers' },
  { key: 'model', says: 'this changes which model the agent runs on' },
  // a rename can make an agent with powers the owner allowed stand in for one Claude calls by name (general-purpose, Explore)
  {
    key: 'name',
    says: 'this names or renames the agent, so it can stand in for another one Claude calls by that name',
  },
]

/**
 * The only top-level keys an edit may add, remove or change without a warning: they say how the file is shown and when it is
 * offered, never what it may do. Every other key (a known risky one, one Claude Code adds later, a YAML merge key `<<`) warns.
 */
export const HARMLESS_KEYS = ['description', 'color', 'argument-hint', 'when_to_use'] as const

export const FRONTMATTER_UNCLEAR_SAYS =
  "Claude can't read this file's settings block for certain; check it before you allow it"
export const RUNNABLE_FILE_SAYS = 'this file can run as a program when a skill or hook uses it'
export const RUNS_COMMAND_SAYS = 'this adds a command that runs when the skill or command is used'
export const TOUCHES_AGENT_FILES_SAYS = 'this command touches your Claude agent, skill or command files'

const RISKY = new Map(RISKY_KEYS.map((r) => [norm(r.key), r.says]))
const HARMLESS = new Set(HARMLESS_KEYS.map(norm))
const MERGE = '<<'

const sayFor = (normKey: string, shown: string): string => {
  if (normKey === MERGE)
    return `this merges in settings that are not shown here (${MERGE}), which can change what the agent may do`
  const known = RISKY.get(normKey)
  if (known) return known
  const plain = shown.length > 0 && shown.length <= 64 && /^[\w$.-]+$/.test(shown)
  return `this changes a setting (${plain ? shown : 'a key that is not a plain name'}) that can change what the agent may do`
}

const text = (t: string): string => {
  const x = t.startsWith('\ufeff') ? t.slice(1) : t
  return x.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

/** The frontmatter's lines (between the first line `---` and the next), or null when the file has none. */
function frontmatterLines(t: string): string[] | null {
  const lines = text(t).split('\n')
  if (!(lines[0] ?? '').startsWith('---')) return null
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  return end < 0 ? null : lines.slice(1, end)
}

const indentOf = (l: string): number => l.length - l.trimStart().length
const skippable = (l: string): boolean => l.trim() === '' || l.trimStart().startsWith('#')

/** Plain name of a top-level line's key, read the way the scan reads one (quotes dropped). */
function keyOfLine(l: string): string | null {
  const m = /^\s*(?:"([^"\\]*)"|'((?:[^']|'')*)'|([^\s:#][^:#]*?))\s*:(?:\s|$)/.exec(l)
  if (!m) return null
  return (m[1] ?? m[2]?.replaceAll("''", "'") ?? m[3] ?? '').trim()
}

type Entry = { shown: string; raw: string }

/** The raw entry of each top-level key (normalised name -> its lines joined): the top-level line and what follows it up to the next. */
function entries(body: string[], keys: string[]): Map<string, Entry> | 'flow' {
  const first = body.find((l) => !skippable(l))
  if (first === undefined) return new Map()
  if (first.trimStart().startsWith('{') || first.trimStart().startsWith('[')) return 'flow'
  const top = indentOf(first)
  const out = new Map<string, Entry>()
  const seen: string[] = []
  let current: string | null = null
  for (const l of body) {
    if (!skippable(l) && indentOf(l) === top) {
      const k = keyOfLine(l)
      if (k === null) throw new FrontmatterUnclear('a top-level line that is not a key')
      seen.push(k)
      current = norm(k)
      const had = out.get(current)
      out.set(current, { shown: had?.shown ?? k, raw: `${had?.raw ?? ''}${l.trimEnd()}\n` })
    } else if (current !== null) {
      const had = out.get(current) as Entry
      out.set(current, { shown: had.shown, raw: `${had.raw}${l.trimEnd()}\n` })
    }
  }
  // the lines and the scan must agree on the keys, or neither is believed
  if (seen.length !== keys.length || seen.some((k, i) => k !== keys[i]))
    throw new FrontmatterUnclear('the keys read by line differ from the scan')
  for (const [k, v] of out) out.set(k, { shown: v.shown, raw: v.raw.replace(/\s+$/, '') })
  return out
}

/**
 * The sentences for every top-level frontmatter key outside HARMLESS_KEYS that was added, removed or changed between `before` and
 * `after`; [] when only harmless keys or the body changed. A merge key (`<<`) always counts. A frontmatter that cannot be read for
 * certain gives the one unclear sentence.
 */
export function riskyFrontmatterChange(before: string, after: string): string[] {
  try {
    const kb = frontmatterKeys(before)
    const ka = frontmatterKeys(after)
    const bb = frontmatterLines(before) ?? []
    const ba = frontmatterLines(after) ?? []
    const eb = entries(bb, kb)
    const ea = entries(ba, ka)
    const out = new Set<string>()
    if (eb === 'flow' || ea === 'flow') {
      // one flow mapping cannot be split by line: any key outside the harmless ones, on either side, counts when the block changed
      const merge = [...kb, ...ka].some((k) => norm(k) === MERGE)
      if (!merge && bb.join('\n') === ba.join('\n')) return []
      for (const k of [...kb, ...ka]) if (!HARMLESS.has(norm(k))) out.add(sayFor(norm(k), k))
    } else {
      for (const k of new Set([...eb.keys(), ...ea.keys()])) {
        if (HARMLESS.has(k)) continue
        const x = eb.get(k)
        const y = ea.get(k)
        if (k === MERGE || x?.raw !== y?.raw) out.add(sayFor(k, (y ?? x)?.shown ?? k))
      }
    }
    // the known sentences first, in their own order
    const known = RISKY_KEYS.map((r) => r.says).filter((s) => out.has(s))
    return [...new Set([...known, ...out])]
  } catch (e) {
    if (e instanceof FrontmatterUnclear) return [FRONTMATTER_UNCLEAR_SAYS]
    throw e
  }
}

const applyOne = (t: string, oldS: unknown, newS: unknown, all: unknown): string | null => {
  if (typeof oldS !== 'string' || typeof newS !== 'string' || oldS === '') return null
  const parts = t.split(oldS)
  if (parts.length < 2) return null
  if (parts.length > 2 && all !== true) return null
  return parts.join(newS)
}

/**
 * The file's text before and after a Write, Edit or MultiEdit; null when it cannot be told (NotebookEdit, an edit whose old_string
 * is not there once, an input that is not shaped like the tool's). `readCurrent` gives the file's text, or null when there is none.
 */
export function editedText(
  toolName: string,
  toolInput: unknown,
  readCurrent: () => string | null,
): { before: string; after: string } | null {
  const input = (typeof toolInput === 'object' && toolInput !== null ? toolInput : {}) as Record<string, unknown>
  if (toolName === 'Write') {
    if (typeof input.content !== 'string') return null
    return { before: readCurrent() ?? '', after: input.content }
  }
  if (toolName !== 'Edit' && toolName !== 'MultiEdit') return null
  const before = readCurrent()
  if (before === null) return null
  const edits =
    toolName === 'Edit'
      ? [input]
      : Array.isArray(input.edits)
        ? (input.edits as unknown[]).map((e) =>
            typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : {},
          )
        : null
  if (edits === null || edits.length === 0) return null
  let after = before
  for (const e of edits) {
    const next = applyOne(after, e.old_string, e.new_string, e.replace_all)
    if (next === null) return null
    after = next
  }
  return { before, after }
}

/** The largest agent, skill or command file the card reads to compare (a bigger one counts as unclear). */
const READ_CAP = 256 * 1024
const WATCHED = new Set(['agents', 'skills', 'commands'])

const lowerParts = (p: string): string[] =>
  p
    .split('/')
    .filter((x) => x !== '' && x !== '.')
    .map((x) => x.toLowerCase())

/**
 * Is `file` an agents, skills or commands file Claude Code reads: one of those folders right after a `.claude` folder, or directly
 * under one of `configDirs` (Claude's config folder, `<home>/.claude`)? Any case. A `src/commands/x.ts` of a project is not.
 */
export function isWatchedAgentFile(file: string, configDirs: readonly string[] = []): boolean {
  const parts = lowerParts(file)
  for (let i = 0; i + 1 < parts.length; i++)
    if (parts[i] === '.claude' && WATCHED.has(parts[i + 1] as string)) return true
  for (const dir of configDirs) {
    for (const form of new Set([dir, resolvedPath(dir)])) {
      const base = lowerParts(form)
      if (
        base.length > 0 &&
        parts.length > base.length + 1 &&
        base.every((x, i) => parts[i] === x) &&
        WATCHED.has(parts[base.length] as string)
      )
        return true
    }
  }
  return false
}

/** The path with its deepest existing parent resolved (links followed there), the rest kept as written. */
export function resolvedPath(file: string): string {
  const rest: string[] = []
  let dir = dirname(file)
  rest.unshift(basename(file))
  for (;;) {
    try {
      return join(realpathSync(dir), ...rest)
    } catch {
      const up = dirname(dir)
      if (up === dir) return file
      rest.unshift(basename(dir))
      dir = up
    }
  }
}

/** The file's text, null when there is none; throws for a link, a file over the cap or anything unreadable. */
function readSmall(file: string): string | null {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > READ_CAP) throw new Error('not a small plain file')
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** A line that runs a command when a skill or command is used: inline !`cmd`, or a ```! fence. */
const runsCommand = (l: string): boolean => l.includes('!`') || /^\s*```!/.test(l)

/** Does the edit add or change a line that runs a command? */
function addsCommandLine(before: string, after: string): boolean {
  const had = new Set(text(before).split('\n'))
  return text(after)
    .split('\n')
    .some((l) => runsCommand(l) && !had.has(l))
}

const COMMAND_PATH = /(?:^|[\s'"=:(])[^\s'"]*\.claude\/(?:agents|skills|commands)(?:\/|[\s'")]|$)/i

/**
 * What a card for a file tool's edit under an agents, skills or commands folder, or for a Bash command naming one, says first
 * (plain sentences; the card adds "Careful: "), or [] when there is nothing to say. A file that cannot be read safely, an edit that
 * cannot be applied and a NotebookEdit are unclear and say so. `configDirs` are Claude's config folder and `<home>/.claude`.
 */
export function agentFileWarning(
  toolName: string,
  toolInput: unknown,
  cwd: string | undefined,
  configDirs: readonly string[] = [],
): string[] {
  const input = (typeof toolInput === 'object' && toolInput !== null ? toolInput : {}) as Record<string, unknown>
  if (toolName === 'Bash') {
    const c = input.command
    if (typeof c !== 'string') return []
    const low = c.toLowerCase()
    const named = configDirs.some((dir) =>
      ['agents', 'skills', 'commands'].some((d) => low.includes(`${dir}/${d}`.toLowerCase())),
    )
    return COMMAND_PATH.test(c) || named ? [TOUCHES_AGENT_FILES_SAYS] : []
  }
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return []
  const fp = toolName === 'NotebookEdit' ? (input.notebook_path ?? input.file_path) : input.file_path
  if (typeof fp !== 'string' || fp === '') return []
  const given = isAbsolute(fp) ? normalize(fp) : cwd && isAbsolute(cwd) ? resolve(cwd, fp) : null
  if (given === null) return []
  const file = resolvedPath(given)
  if (!isWatchedAgentFile(given, configDirs) && !isWatchedAgentFile(file, configDirs)) return []
  if (toolName === 'NotebookEdit') return [FRONTMATTER_UNCLEAR_SAYS]
  const out: string[] = []
  if (!file.toLowerCase().endsWith('.md')) out.push(RUNNABLE_FILE_SAYS)
  else {
    try {
      const t = editedText(toolName, toolInput, () => readSmall(file))
      if (!t) out.push(FRONTMATTER_UNCLEAR_SAYS)
      else {
        if (addsCommandLine(t.before, t.after)) out.push(RUNS_COMMAND_SAYS)
        out.push(...riskyFrontmatterChange(t.before, t.after))
      }
    } catch {
      out.push(FRONTMATTER_UNCLEAR_SAYS)
    }
  }
  return [...new Set(out)]
}
