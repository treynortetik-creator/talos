// "Notes that may matter" (the TypeScript twin of kit/hooks/memory-reflex.py). A thread's own session never runs the kit hook, so
// the bridge does the same lookup for it: find the names an owner message uses, resolve them against the gazetteer the kit already
// builds from the owner's own wiki (kit/scripts/wiki-gazetteer.py), and hand back up to three POINTERS (root, path, title, one
// line, the start of the note). The matcher is a faithful port, rule for rule: alias, then exact title, then a unique surname;
// a name that lands on two notes is dropped; precision over recall. test/memory-reflex-parity.test.ts runs the python hook and
// this port over the same cases and requires the same notes in the same order.
//
// What it adds over the hook: a pointer is given only for a note the memory browser's scope (scope.ts) says is readable, so the
// OS fence and every deny rule stay as they are, and a note is pointed at once per process. It reads no model and no index, it
// never throws (any failure is "no pointers"), and it never logs a message.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { neutralizeControlTags } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { loadMemoryConfig, memoryJsonMtime } from './config.ts'
import { norm } from './reflex-fold.ts'
import { asText, MemoryScope, readCapped } from './scope.ts'
import { splitFrontmatter } from './text.ts'

export const MAX_POINTERS = 3
const MAX_DESC_WORDS = 26
const MAX_CHARS_IN = 6000
const MAX_NGRAM = 6
const EXCERPT_CHARS = 400
const READ_BYTES = 16 * 1024
export const KILL_NAME = 'memory-reflex.off'

const CONNECTORS = new Set(['of', 'the', 'and', 'vs', 'for', 'de', 'van', 'von', 'la', 'di', 'da', 'le', 'du'])
// capitalised words that open a sentence/command but are not part of a name (the hook's list)
const OPENERS = new Set(
  `ask tell ping email text call thanks thank hey hi hello cc and see per with from for did does do what who
whom when why how can could would should will is are was were check send loop remind say said let make get add
update review read open run show find draft write schedule meet meeting also then so but or if now ok okay yes no
please just is its it's i we you he she they my our your his her their give pull grab fetch look tag note log
forward reply forwarded dm slack zoom re fwd after before about on in at to by of as this that these those here
there where which while until once again still`.split(/\s+/),
)

// python's \s and \S are the unicode white space of str.isspace(); JavaScript's differ at U+001C-U+001F, U+0085 and U+FEFF
const WS = String.raw`\t\n\v\f\r \x1c-\x1f\x85\xa0  -     　`
const NS = `[^${WS}]`
const TOK = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu
const SEP_OK = /^(?:[ \t]+|-)\n?$/ // python's `$` also matches before a final newline
/**
 * A run of more than LONG_RUN characters with no space in it is blanked first. It holds no name a person would type, and the
 * email pattern below (the hook's own) takes cubic time on a long run of `@` with no `.`: 6000 of them held read_inbound for 90 s
 * (review 2026-11-15). Bounded runs keep the worst case to tens of ms. The python hook has the same pattern but its own process
 * and a hook timeout, so this is the one place the port differs from it on purpose.
 */
const LONG_RUN = 128
const STRIP: RegExp[] = [
  new RegExp(`${NS}{${LONG_RUN + 1},}`, 'g'),
  /```[\s\S]*?```/g,
  /`[^`\n]*`/g,
  new RegExp(`https?://${NS}+`, 'g'),
  new RegExp(`${NS}+@${NS}+\\.${NS}+`, 'g'),
  new RegExp(`${NS}*/${NS}*`, 'g'),
]
const SENT_LEAD = new Set([...' \t"\'([{*_>#“‘'])
const SENT_END = new Set([...'.!?:;\n\r'])
const LOWER = /[\p{Lowercase}\p{Lt}]/u
const UPPER = /\p{Uppercase}/u
const ALNUM = /^[\p{L}\p{N}]$/u

/** python str.isupper(): no lowercase or titlecase letter, and at least one uppercase one. */
const isUpperStr = (s: string) => !LOWER.test(s) && UPPER.test(s)
/** The code point that ends just before `end`. */
function cpBefore(text: string, end: number): string {
  const lo = text.charCodeAt(end - 1)
  if (lo >= 0xdc00 && lo <= 0xdfff && end >= 2) {
    const hi = text.charCodeAt(end - 2)
    if (hi >= 0xd800 && hi <= 0xdbff) return text.slice(end - 2, end)
  }
  return text.slice(end - 1, end)
}

type Tok = { raw: string; k: string; s: number; e: number; ss: boolean; join: boolean }

function tokenize(input: string): Tok[] {
  let text = input
  for (const rx of STRIP) text = text.replace(rx, (m) => ' '.repeat(m.length)) // same length: offsets stay true
  const toks: Tok[] = []
  for (const m of text.matchAll(TOK)) {
    const raw = m[0]
    const s = m.index as number
    const e = s + raw.length
    // sentence start: nothing but quotes, brackets and bullets between here and a terminator or the line start
    let j = s - 1
    while (j >= 0 && SENT_LEAD.has(text[j] as string)) j--
    const ss = j < 0 || SENT_END.has(text[j] as string)
    // "Node.js", "report.md", "notes.Final": a dotted token is a file or domain, not a name
    const dotted =
      /^\.[A-Za-z0-9]/.test(text.slice(e, e + 2)) ||
      (s >= 2 && text[s - 1] === '.' && ALNUM.test(cpBefore(text, s - 1)))
    toks.push({ raw, k: dotted ? '' : norm(raw), s, e, ss, join: false })
  }
  for (let i = 0; i < toks.length - 1; i++) {
    const a = toks[i] as Tok
    a.join = SEP_OK.test(text.slice(a.e, (toks[i + 1] as Tok).s))
  }
  return toks
}

const caseState = (raw: string): 'caps' | 'title' | 'lower' => {
  if ([...raw].length > 1 && isUpperStr(raw)) return 'caps'
  const first = String.fromCodePoint(raw.codePointAt(0) as number)
  return isUpperStr(first) ? 'title' : 'lower'
}
const isCapWord = (t: Tok) => isUpperStr(String.fromCodePoint(t.raw.codePointAt(0) as number)) && t.raw !== 'I'

export type GazNote = { p: string; t: string; d: string; e?: number; pe?: number }
export type Gazetteer = {
  /** The agent folder the file was built for (realpath), when it says. */
  repo: string | undefined
  notes: GazNote[]
  alias: Map<string, number[]>
  title: Map<string, number[]>
  surname: Map<string, number[]>
  given: Map<string, number[]>
  ordinary: Set<string>
  caps: Set<string>
  ignore: Set<string>
}

const uniq = (xs: number[]): number[] => [...new Set(xs)]

function resolve(toks: Tok[], g: Gazetteer): Array<{ idx: number; arm: number; len: number; pos: number }> {
  const { notes, alias, title, surname, given, ordinary, caps, ignore } = g
  const ranked: Array<{ idx: number; arm: number; len: number; pos: number }> = []
  const note = (i: number) => notes[i] as GazNote
  const nameWord = (i: number) => {
    const t = toks[i] as Tok
    return isCapWord(t) && !(t.ss && OPENERS.has(t.k))
  }
  const isolated = (i: number) => {
    const prev = i > 0 && (toks[i - 1] as Tok).join && nameWord(i - 1)
    const next = i + 1 < toks.length && (toks[i] as Tok).join && nameWord(i + 1)
    return !(prev || next)
  }
  const ruleOkMulti = (nt: GazNote, n: number, sl: Tok[]) => {
    if (nt.pe) return true // a person's full name: any case
    if (nt.e && n >= 3) return true
    return sl.every((t) => isCapWord(t) || CONNECTORS.has(t.k))
  }
  const N = toks.length
  let i = 0
  while (i < N) {
    let matched = false
    // multi-word spans, longest first
    const top = Math.min(MAX_NGRAM, N - i)
    for (let n = top; n > 1; n--) {
      let joined = true
      for (let d = 0; d < n - 1; d++) if (!(toks[i + d] as Tok).join) joined = false
      if (!joined) continue
      const sl = toks.slice(i, i + n)
      const key = sl.map((t) => t.k).join(' ')
      let hits: number[]
      let arm: number
      const viaAlias = alias.get(key)
      const viaTitle = title.get(key)
      if (viaAlias) {
        hits = [...viaAlias]
        arm = 0
      } else if (viaTitle) {
        hits = viaTitle.filter((h) => ruleOkMulti(note(h), n, sl))
        arm = 1
      } else continue
      if (!hits.length) continue
      hits = uniq(hits)
      if (hits.length < 2) ranked.push({ idx: hits[0] as number, arm, len: n, pos: (sl[0] as Tok).s })
      i += n
      matched = true
      break
    }
    if (matched) continue
    // single word
    const t = toks[i] as Tok
    const k = t.k
    const st = caseState(t.raw)
    if (k && !ignore.has(k) && (k.length >= 3 || alias.has(k))) {
      const viaAlias = alias.get(k)
      if (viaAlias) {
        // an explicit alias: any case, trusted
        const hits = uniq(viaAlias)
        if (hits.length < 2) ranked.push({ idx: hits[0] as number, arm: 0, len: 1, pos: t.s })
      } else {
        let okCase = st === 'title' || (st === 'caps' && caps.has(k))
        const tit = (title.get(k) ?? []).filter((h) => note(h).e)
        const first = tit[0]
        // "quasarfin", "acmecorp": coined names
        if (st === 'lower' && tit.length && !ordinary.has(k) && k.length >= 5 && !note(first as number).pe)
          okCase = true
        // "Ready" opens sentences; "Orrery" does not
        if (okCase && ordinary.has(k) && (st !== 'title' || t.ss)) okCase = false
        if (okCase) {
          let main = [...tit]
          if (st === 'title' && surname.has(k) && isolated(i)) main = main.concat(surname.get(k) as number[])
          main = uniq(main)
          if (main.length) {
            const cands = uniq(main.concat(main.some((h) => note(h).pe) ? (given.get(k) ?? []) : []))
            if (cands.length < 2) {
              const idx = main[0] as number
              ranked.push({ idx, arm: tit.includes(idx) ? 1 : 2, len: 1, pos: t.s })
            }
          }
        }
      }
    }
    i++
  }
  return ranked
}

/** python `str.lstrip()`: its white space, not JavaScript's. */
const pyLstrip = (s: string) => s.replace(new RegExp(`^[${WS}]+`), '')

/**
 * The notes (indexes into `gaz.notes`) the words name, best first, each note once: alias before title before surname, a longer
 * span first, an entity before a concept, then the earlier in the message. The hook then takes the first three that pass its own
 * checks; callers here do the same (`notesFor`).
 */
export function matchNames(text: string, gaz: Gazetteer): number[] {
  let head = pyLstrip(text)
  if ([...head].length > MAX_CHARS_IN) head = [...head].slice(0, MAX_CHARS_IN).join('')
  if (!head.trim()) return []
  const toks = tokenize(head)
  if (!toks.length) return []
  const ranked = resolve(toks, gaz)
  const ent = (r: { idx: number }) => ((gaz.notes[r.idx] as GazNote).e ? 0 : 1)
  ranked.sort((a, b) => a.arm - b.arm || b.len - a.len || ent(a) - ent(b) || a.pos - b.pos)
  const seen = new Set<string>()
  const out: number[] = []
  for (const r of ranked) {
    const p = (gaz.notes[r.idx] as GazNote).p
    if (seen.has(p)) continue
    seen.add(p)
    out.push(r.idx)
  }
  return out
}

// ---- the gazetteer file ---------------------------------------------------------------------------------------------------

/** `<XDG_STATE_HOME or ~/.local/state>/talos/<folder>-<sha1(folder)[:8]>/gazetteer.json`: kit/hooks/_talos_common.py state_dir(). */
export function gazetteerPath(agentRoot: string, env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state')
  const slug = `${basename(agentRoot) || 'agent'}-${createHash('sha1').update(agentRoot, 'utf8').digest('hex').slice(0, 8)}`
  return join(base, 'talos', slug, 'gazetteer.json')
}

const isIdx = (v: unknown, n: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < n
function table(v: unknown, n: number): Map<string, number[]> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const out = new Map<string, number[]>()
  for (const [k, list] of Object.entries(v)) {
    if (!Array.isArray(list) || !list.every((x) => isIdx(x, n))) return null
    out.set(k, list as number[])
  }
  return out
}
const strings = (v: unknown): Set<string> | null =>
  v === undefined
    ? new Set()
    : Array.isArray(v) && v.every((x) => typeof x === 'string')
      ? new Set(v as string[])
      : null

function parseGazetteer(raw: unknown): Gazetteer | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.version !== 1 || !Array.isArray(o.notes)) return null
  const notes: GazNote[] = []
  for (const n of o.notes) {
    if (typeof n !== 'object' || n === null) return null
    const x = n as Record<string, unknown>
    if (typeof x.p !== 'string' || typeof x.t !== 'string') return null
    notes.push({ p: x.p, t: x.t, d: typeof x.d === 'string' ? x.d : '', e: x.e ? 1 : 0, pe: x.pe ? 1 : 0 })
  }
  const alias = table(o.alias, notes.length)
  const title = table(o.title, notes.length)
  const surname = table(o.surname, notes.length)
  const given = table(o.given, notes.length)
  const ordinary = strings(o.ordinary)
  const caps = strings(o.caps)
  const ignore = strings(o.ignore)
  if (!alias || !title || !surname || !given || !ordinary || !caps || !ignore) return null
  return {
    repo: typeof o.repo === 'string' ? o.repo : undefined,
    notes,
    alias,
    title,
    surname,
    given,
    ordinary,
    caps,
    ignore,
  }
}

const loaded = new Map<string, { mtimeMs: number; size: number; gaz: Gazetteer | null }>()

/** The gazetteer at `path`, cached until the file changes. Null when it is missing, unreadable, not JSON or not version 1. */
export function loadGazetteer(path: string): Gazetteer | null {
  try {
    const st = statSync(path)
    const hit = loaded.get(path)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.gaz
    let gaz: Gazetteer | null = null
    try {
      gaz = parseGazetteer(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      gaz = null
    }
    loaded.set(path, { mtimeMs: st.mtimeMs, size: st.size, gaz })
    return gaz
  } catch {
    loaded.delete(path)
    return null
  }
}

// ---- pointers -------------------------------------------------------------------------------------------------------------

export type NotePointer = { root: string; path: string; title: string; description: string; excerpt: string }

/** The hook's `clip`: wikilinks and emphasis out, leading bullets out, at most `n` words. */
function clip(desc: string, n: number): string {
  let d = desc.replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, a: string, b?: string) => b || a)
  d = d.replace(/[*`_]{1,3}/g, '')
  d = d.replace(/^[^\p{L}\p{N}_"'([]+/u, '')
  const w = d.split(new RegExp(`[${WS}]+`)).filter(Boolean)
  return w.length <= n ? w.join(' ') : `${w.slice(0, n).join(' ')}...`
}

/** The first ~400 characters of a note's body, white space collapsed, cut back to a word, "…" when cut. */
export function excerptOf(body: string, max = EXCERPT_CHARS): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  let cut = flat.slice(0, max)
  if (flat[max] !== ' ') {
    const sp = cut.lastIndexOf(' ')
    if (sp > 0) cut = cut.slice(0, sp)
    else if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1)
  }
  return `${cut.trimEnd()}…`
}

/** The memory root a note path (relative to the agent folder) falls under, and the path inside it. First root wins. */
function rootOf(scope: MemoryScope, p: string): { root: string; rel: string } | null {
  for (const r of scope.roots) {
    const base = r.cfg.path.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
    if (base && base !== '.' && p.startsWith(`${base}/`) && p.length > base.length + 1)
      return { root: r.id, rel: p.slice(base.length + 1) }
  }
  return null
}

export type ReflexDeps = {
  gaz: Gazetteer
  scope: MemoryScope
  /** `root/path` of every note already pointed at in this process; the ones chosen are added. */
  seen: Set<string>
}

/** Up to three pointers for the notes the words name that the scope says are readable and that were not pointed at before. */
export function notesFor(text: string, deps: ReflexDeps): NotePointer[] {
  const out: NotePointer[] = []
  const paths = new Set<string>()
  for (const idx of matchNames(text, deps.gaz)) {
    if (out.length >= MAX_POINTERS) break
    const note = deps.gaz.notes[idx] as GazNote
    const at = rootOf(deps.scope, note.p)
    if (!at || deps.seen.has(`${at.root}/${at.rel}`) || paths.has(note.p)) continue
    const o = deps.scope.open(at.root, at.rel)
    if (!o) continue
    let body: string | null = null
    try {
      const buf = asText(readCapped(o, READ_BYTES), o.size > READ_BYTES)
      if (buf) body = splitFrontmatter(buf.toString('utf8')).body
    } finally {
      o.close()
    }
    if (body === null) continue
    paths.add(note.p)
    out.push({
      root: at.root,
      path: at.rel,
      title: neutralizeControlTags(note.t),
      description: neutralizeControlTags(clip(note.d, MAX_DESC_WORDS)),
      excerpt: neutralizeControlTags(excerptOf(body)),
    })
  }
  // marked only once every pointer was made: a read that throws part way gives none, and none are spent
  for (const p of out) deps.seen.add(`${p.root}/${p.path}`)
  return out
}

// ---- the bridge's side ----------------------------------------------------------------------------------------------------

const scopes = new WeakMap<
  BridgeContext,
  { mtimeMs: number; scope: MemoryScope | null; agentDir: string; maxBytes: number }
>()
const pointed = new WeakMap<BridgeContext, Set<string>>()

/**
 * The memory scope a thread session reads through: the one memory.json describes, built here because `ctx.memory` is only the
 * live main bridge's. Null (no pointers, and the tool says "not found") when there is no memory.json, it is off or unreadable,
 * or the app's Memory switch is off. Cached until memory.json changes.
 */
export function scopeFor(ctx: BridgeContext): { scope: MemoryScope; agentDir: string; maxBytes: number } | null {
  try {
    if (!ctx.config.config.memory_browser) return null
    const mtimeMs = memoryJsonMtime(ctx.env.home)
    let hit = scopes.get(ctx)
    if (!hit || hit.mtimeMs !== mtimeMs) {
      const cfg = loadMemoryConfig(ctx.env.home)
      hit = {
        mtimeMs,
        scope: cfg.ok && cfg.config.enabled ? new MemoryScope(cfg.config) : null,
        agentDir: cfg.ok ? cfg.config.agent_dir : '',
        maxBytes: cfg.ok ? cfg.config.max_file_kb * 1024 : 0,
      }
      scopes.set(ctx, hit)
    }
    return hit.scope ? { scope: hit.scope, agentDir: hit.agentDir, maxBytes: hit.maxBytes } : null
  } catch {
    return null
  }
}

/** Forgets which notes this process already pointed at (tests, and a restart does it anyway). */
export function forgetPointers(ctx: BridgeContext): void {
  pointed.delete(ctx)
}

const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * The pointers for one owner message, or none: any off switch, a missing or stale gazetteer, no readable note, or any error at
 * all gives []. Never throws and never logs the text.
 */
export function lookupNotes(ctx: BridgeContext, text: string): NotePointer[] {
  try {
    if (ctx.config.config.dev?.note_lookup === false) return []
    if (process.env.TALOS_MEMORY_REFLEX_OFF === '1') return []
    const s = scopeFor(ctx)
    if (!s) return []
    const path = gazetteerPath(s.agentDir, process.env)
    if (existsSync(join(dirname(path), KILL_NAME))) return []
    const gaz = loadGazetteer(path)
    // a gazetteer built for another folder points at nothing here
    if (!gaz || (gaz.repo !== undefined && real(gaz.repo) !== s.agentDir)) return []
    const seen = pointed.get(ctx) ?? new Set<string>()
    pointed.set(ctx, seen)
    return notesFor(text, { gaz, scope: s.scope, seen })
  } catch {
    return []
  }
}
