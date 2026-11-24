// How a shell command line splits into simple commands, and what each one writes, as far as its words say. Used by the guard rules
// (rules.ts); a pattern guard, complete for nothing (see bashDecision there).
import { basename } from 'node:path'

/** Words that run the next command rather than being it. */
export const WRAPPERS = new Set([
  'env',
  'sudo',
  'doas',
  'nohup',
  'time',
  'exec',
  'command',
  'builtin',
  'nice',
  'xargs',
  'stdbuf',
  'timeout',
  'caffeinate',
  'script',
  'unbuffer',
  'expect',
  'faketty',
])

/** One simple command: its words (quotes removed) and the files its unquoted redirections write. */
export type Parsed = { words: string[]; redirects: string[] }

/**
 * A command line split into simple commands, each a list of words with quotes removed, and the targets of its redirections
 * (`>`, `>>`, `>|`, `&>`, `2>`, `>&file`; not `2>&1` or `>&2`). Quotes keep `;` and `|` inside a word, and a `>` that is quoted or
 * escaped is no redirection (`echo ">" x`, `echo "x>"|cmd`).
 */
export function parseCommands(cmd: string): Parsed[] {
  const out: Parsed[] = []
  let words: string[] = []
  let redirects: string[] = []
  let word = ''
  let has = false
  let q: '' | "'" | '"' = ''
  // redirection state: the word holds an unquoted operator, whose last character ends at opEnd; the target is what follows it in
  // the word, or the next word when nothing does
  let inRedir = false
  let opEnd = 0
  let pending = false
  const addTarget = (t: string) => {
    if (t !== '' && !/^\d+$|^-$/.test(t)) redirects.push(t)
  }
  const endWord = () => {
    if (has) {
      if (inRedir) {
        const t = word.slice(opEnd)
        pending = t === ''
        if (!pending) addTarget(t)
      } else if (pending) {
        addTarget(word)
        pending = false
      }
      words.push(word)
    }
    word = ''
    has = false
    inRedir = false
    opEnd = 0
  }
  const endCmd = () => {
    endWord()
    pending = false
    if (words.length) out.push({ words, redirects })
    words = []
    redirects = []
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] as string
    if (q === "'") {
      if (c === "'") q = ''
      else word += c
      continue
    }
    if (c === '\\' && i + 1 < cmd.length) {
      word += cmd[++i]
      has = true
      continue
    }
    if (q === '"') {
      if (c === '"') q = ''
      else word += c
      continue
    }
    const justOp = inRedir && word.length === opEnd
    if (c === "'" || c === '"') {
      q = c
      has = true
    } else if (c === '>') {
      // a second `>` after an operator extends it; one after a target starts the next redirection
      if (inRedir && !justOp) addTarget(word.slice(opEnd))
      word += c
      inRedir = true
      opEnd = word.length
      has = true
    } else if (justOp && (c === '|' || c === '&')) {
      // `>|` is a redirect and not a pipe; `>&` takes a file or an fd
      word += c
      opEnd = word.length
    } else if (/[;&|\n()`]/.test(c)) endCmd()
    else if (/\s/.test(c)) endWord()
    else {
      word += c
      has = true
    }
  }
  endCmd()
  return out
}
export const simpleCommands = (cmd: string): string[][] => parseCommands(cmd).map((p) => p.words)

/** Verbs whose every non-option word is written, moved or removed. */
const TARGET_ALL = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'truncate',
  'chmod',
  'chown',
  'touch',
  'tee',
  'mv',
  'patch',
  // a link made to or from a protected file writes it through the other name: every word counts
  'ln',
])
/** Verbs that write their last word (cp a b, ln -s a b, install a b, rsync a b). */
export const TARGET_LAST = new Set(['cp', 'install', 'rsync'])
const INTERPRETERS = /^(?:python[\d.]*|node|ruby|perl|bun|deno|php|lua|osascript|sh|bash|zsh|dash|ksh)$/

/** The word after `flag` (or after `--flag=`) in a command's words. */
function flagValue(words: string[], flags: string[]): string[] {
  const out: string[] = []
  words.forEach((w, k) => {
    if (flags.includes(w) && words[k + 1] !== undefined) out.push(words[k + 1] as string)
    for (const f of flags) if (f.startsWith('--') && w.startsWith(`${f}=`)) out.push(w.slice(f.length + 1))
  })
  return out
}
/** Where curl and wget put what they fetch: the named file or folder, else the folder they run in ('.'). */
function downloadTargets(head: string, words: string[]): string[] {
  if (head === 'curl') {
    const named = flagValue(words, ['-o', '--output', '--output-dir'])
    return named.length ? named : words.some((w) => w === '-O' || w === '--remote-name') ? ['.'] : []
  }
  const named = flagValue(words, ['-O', '--output-document', '-P', '--directory-prefix'])
  return named.length ? named : ['.']
}
/** Where tar and unzip unpack: the folder given (-C, --directory, -d), else the folder they run in; none for a listing or an archive made. */
function unpackTargets(head: string, words: string[]): string[] {
  if (head === 'unzip') return flagValue(words, ['-d'])
  const extracting = words.some(
    (w, k) => w === '--extract' || (/^-?[A-Za-z]*x[A-Za-z]*$/.test(w) && (k === 0 || w.startsWith('-'))),
  )
  if (!extracting) return []
  const dir = flagValue(words, ['-C', '--directory'])
  return dir.length ? dir : ['.']
}

/** The head word's index (past wrappers and `NAME=value`), and the verb. */
export function headOf(words: string[]): { i: number; head: string } {
  let i = 0
  while (
    words[i] !== undefined &&
    (WRAPPERS.has(basename(words[i] as string)) || /^[A-Za-z_]\w*=/.test(words[i] as string))
  )
    i++
  return { i, head: basename(words[i] ?? '') }
}

/** A copy-like verb's sources, its destination (the last word, or the `-t` / `--target-directory` one) and whether it recurses. */
export function copySpec(words: string[], from: number): { dest?: string; sources: string[]; recursive: boolean } {
  const pos: string[] = []
  let dest: string | undefined
  let recursive = false
  for (let k = from; k < words.length; k++) {
    const w = words[k] as string
    if (w === '-t' || w === '--target-directory') dest = words[++k]
    else if (w.startsWith('--target-directory=')) dest = w.slice('--target-directory='.length)
    else if (w === '--recursive' || w === '--archive' || /^-[A-Za-z]*[rRa][A-Za-z]*$/.test(w)) recursive = true
    else if (!w.startsWith('-')) pos.push(w)
  }
  if (dest === undefined) dest = pos.pop()
  return { dest, sources: pos, recursive }
}

/**
 * What one simple command writes, as far as its words say: its redirect targets, its writing verb's targets, the files of an
 * in-place `sed -i`/`perl -i`, `dd of=`, and every word of an interpreter (its script can write anything it names). As written.
 */
export function targetsOf(p: Parsed): string[] {
  const out: string[] = [...p.redirects]
  const { words } = p
  const { i, head } = headOf(words)
  const args = words.slice(i + 1).filter((w) => !w.startsWith('-'))
  if (TARGET_ALL.has(head)) out.push(...args)
  else if (TARGET_LAST.has(head)) {
    const d = copySpec(words, i + 1).dest
    if (d !== undefined) out.push(d)
  } else if ((head === 'sed' || head === 'perl') && words.slice(i + 1).some((w) => /^-\S*i/.test(w))) out.push(...args)
  else if (head === 'dd') out.push(...words.filter((w) => w.startsWith('of=')).map((w) => w.slice(3)))
  else if (head === 'curl' || head === 'wget') out.push(...downloadTargets(head, words.slice(i + 1)))
  else if (head === 'tar' || head === 'unzip') out.push(...unpackTargets(head, words.slice(i + 1)))
  else if (head === 'find' && words.some((w) => /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(w)))
    out.push(...args)
  else if (INTERPRETERS.test(head)) out.push(...words.slice(i + 1))
  return out
}
