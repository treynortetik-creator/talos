// The looser person-name forms (the TypeScript twin of kit/hooks/_talos_names.py; test/memory-reflex-parity.test.ts keeps them
// equal). The strict resolver in reflex.ts handles alias, exact title and unique surname. This adds three forms for PEOPLE only,
// each anchored so it cannot guess from a bare word, and ranked LAST: a loose hit never replaces a strict one.
//
//   initial + surname   "R. Harlow"      the initial starts the given name of exactly one person with that surname
//   reversed            "Harlow, Robin"  equals a person note's full title read backwards
//   surname typo        "Robin Harlov"   the first name (or its initial) matches, the surname is one edit from a real one and has
//                                        at least 5 letters. No first name, no guess.
//
// Ambiguity is dropped, never guessed. Only person notes are returned. The `ignore` list applies to the RESOLVED name too.
import { norm } from './reflex-fold.ts'

export type NamesGaz = {
  notes: Array<{ t: string; pe?: number }>
  title: Map<string, number[]>
  surname: Map<string, number[]>
  ignore: Set<string>
}
export type LooseHit = { idx: number; name: string; form: 'initial' | 'reversed' | 'typo' }

const W = String.raw`[\p{L}\p{N}_]`
const CAP = String.raw`[A-Z]\p{L}*(?:['’\-]\p{L}+)?` // one capitalised name word
const INITIAL = new RegExp(String.raw`(?<!${W}|\.)([A-Z])\.[ \t]+(${CAP})`, 'gu')
const REVERSED = new RegExp(String.raw`(?<!${W})(${CAP})[ \t]*,[ \t]+(${CAP})`, 'gu')
const PAIR = new RegExp(String.raw`(?<!${W}|\.)(?=((?:[A-Z]\.|${CAP})[ \t]+(${CAP})))`, 'gu')
const PREV_CAP = new RegExp(String.raw`(?<!${W})${CAP}[ \t]+$`, 'u') // the text before an initial ends in a capitalised word
const MIN_TYPO_LEN = 5

/** True when the edit distance of a and b is exactly 1. */
export function edit1(x: string, y: string): boolean {
  let a = x
  let b = y
  if (a === b || Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    let d = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
    return d === 1
  }
  if (a.length > b.length) [a, b] = [b, a]
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return a.slice(i) === b.slice(i + 1)
}

const bare = (t: string) => t.replace(/\s*[([].*$/s, '')
const full = (n: { t: string }) => norm(bare(n.t))
const given = (n: { t: string }) => {
  const w = full(n).split(' ').filter(Boolean)
  return w.length >= 2 ? (w[0] as string) : ''
}

function surnames(g: NamesGaz): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const [k, v] of g.surname) out.set(k, [...v])
  g.notes.forEach((n, i) => {
    if (!n.pe) return
    const w = full(n).split(' ').filter(Boolean)
    const last = w[w.length - 1]
    if (w.length >= 2 && last && last.length >= 3) {
      const l = out.get(last) ?? []
      if (!l.includes(i)) l.push(i)
      out.set(last, l)
    }
  })
  return out
}

/** Hits for the loose forms in `text` (code, URLs and paths already blanked). */
export function looseMatches(text: string, g: NamesGaz): LooseHit[] {
  const sur = surnames(g)
  const hits: LooseHit[] = []
  const persons = (idxs: number[]) => [...new Set(idxs)].filter((i) => (g.notes[i] as { pe?: number }).pe)
  const add = (cands: number[], name: string, form: LooseHit['form']) => {
    const c = [...new Set(cands)]
    if (c.length !== 1) return // none, or ambiguous: dropped, never guessed
    if (g.ignore.has(full(g.notes[c[0] as number] as { t: string }))) return // decided after ambiguity
    hits.push({ idx: c[0] as number, name, form })
  }
  for (const m of text.matchAll(INITIAL)) {
    const start = m.index as number
    if (PREV_CAP.test(text.slice(Math.max(0, start - 40), start))) continue // "Robin R. Harlow": R. is a middle initial
    const ini = (m[1] as string).toLowerCase()
    const s = norm(m[2] as string)
    add(
      persons(sur.get(s) ?? []).filter((i) => given(g.notes[i] as { t: string }).startsWith(ini)),
      `${ini}. ${s}`,
      'initial',
    )
  }
  for (const m of text.matchAll(REVERSED)) {
    const s = norm(m[1] as string)
    const giv = norm(m[2] as string)
    if (s && giv) add(persons(g.title.get(`${giv} ${s}`) ?? []), `${s}, ${giv}`, 'reversed')
  }
  for (const m of text.matchAll(PAIR)) {
    const first = ((m[1] as string).split(/\s+/)[0] as string).replace(/\.+$/, '')
    const last = norm(m[2] as string)
    if (last.length < MIN_TYPO_LEN || sur.has(last) || last.includes(' ')) continue
    const fn = norm(first)
    const cands: number[] = []
    for (const s of sur.keys()) {
      if (s.length < MIN_TYPO_LEN || !edit1(last, s)) continue
      for (const i of persons(sur.get(s) as number[])) {
        const gv = given(g.notes[i] as { t: string })
        if (gv && ((fn.length === 1 && gv.startsWith(fn)) || (fn.length > 1 && gv === fn))) cands.push(i)
      }
    }
    add(cands, `${fn} ${last}`, 'typo')
  }
  const seen = new Set<number>()
  return hits.filter((h) => !seen.has(h.idx) && seen.add(h.idx))
}
