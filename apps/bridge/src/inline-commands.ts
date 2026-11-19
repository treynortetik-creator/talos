// Finds shell commands written as inline code in an agent reply. The web app draws a Run button only on a fenced block whose
// language is empty, sh, bash, zsh or shell (`RUN_LANGS` in the protocol; apps/web `runBlocks`), never on an inline span, so
// a command in backticks cannot be run with a tap. The reply tool uses this to tell the agent, after the send, to use a block.

/** The first word of an inline span that marks it as a command. One list; the match is exact and case-sensitive. */
export const INLINE_COMMAND_WORDS: readonly string[] = [
  'talos-app', 'git', 'gh', 'npm', 'pnpm', 'npx', 'bun', 'brew', 'docker', 'colima', 'bash', 'sh', 'zsh', 'cd',
  'python3', 'python', 'swift', 'xcodebuild', 'curl', 'ssh', 'make', 'cargo', 'go', 'node', 'launchctl', 'osascript',
  'open', 'kill', 'pkill', 'rm', 'mv', 'cp', 'chmod', 'sudo',
] // biome-ignore format: one compact list

const WORDS = new Set(INLINE_COMMAND_WORDS)
const FENCE_OPEN = /^[ \t>]*(`{3,}|~{3,})(.*)$/
const TICK = 96 // "`"

/** The text with every fenced block (``` or ~~~, closed or not) blanked out. An unclosed fence runs to the end. */
function withoutFences(text: string): string {
  const out: string[] = []
  let open: { ch: string; len: number } | null = null
  for (const line of text.split(/\r\n?|\n/)) {
    if (open) {
      const m = FENCE_OPEN.exec(line)
      const run = m?.[1] ?? ''
      if (m && run[0] === open.ch && run.length >= open.len && m[2]?.trim() === '') open = null
      out.push('')
      continue
    }
    const m = FENCE_OPEN.exec(line)
    // a backtick fence's info string has no backtick in it: ```x``` on one line is an inline span, not a fence
    if (m && !(m[1]?.startsWith('`') && m[2]?.includes('`'))) {
      open = { ch: (m[1] as string)[0] as string, len: (m[1] as string).length }
      out.push('')
    } else out.push(line)
  }
  return out.join('\n')
}

/**
 * The inline code spans (their text) in `text`, outside fences, that start with a command word followed by something.
 * A span that is only the word (`git`) names a tool and is not a command, so it does not match. Spans follow CommonMark:
 * a run of N backticks closes at the next run of exactly N; one leading and trailing space is dropped; a backslash before a
 * backtick makes that one backtick plain text. Linear in the text size.
 */
export function inlineCommands(text: string): string[] {
  const s = withoutFences(text)
  type Run = { at: number; len: number }
  const runs: Run[] = []
  for (let i = 0; i < s.length; ) {
    if (s.charCodeAt(i) !== TICK) {
      i++
      continue
    }
    let slashes = 0
    for (let k = i - 1; k >= 0 && s[k] === '\\'; k--) slashes++
    const start = i
    while (i < s.length && s.charCodeAt(i) === TICK) i++
    const escaped = slashes % 2 === 1
    const at = escaped ? start + 1 : start
    if (i - at > 0) runs.push({ at, len: i - at })
  }
  const byLen = new Map<number, number[]>()
  runs.forEach((r, idx) => {
    const l = byLen.get(r.len)
    if (l) l.push(idx)
    else byLen.set(r.len, [idx])
  })
  const ptr = new Map<number, number>()
  const found: string[] = []
  for (let a = 0; a < runs.length; a++) {
    const open = runs[a] as Run
    const list = byLen.get(open.len) as number[]
    let p = ptr.get(open.len) ?? 0
    while (p < list.length && (list[p] as number) <= a) p++
    ptr.set(open.len, p)
    const b = list[p]
    if (b === undefined) continue
    const close = runs[b] as Run
    let span = s.slice(open.at + open.len, close.at).replace(/\n/g, ' ')
    if (span.length > 2 && span.startsWith(' ') && span.endsWith(' ') && span.trim() !== '') span = span.slice(1, -1)
    a = b // the closer is spent
    const words = span.trim().split(/\s+/)
    if (words.length >= 2 && WORDS.has(words[0] as string)) found.push(span.trim())
  }
  return found
}

/** The line the reply tool adds to its result, or null when nothing matched. */
export function inlineCommandNote(text: string): string | null {
  const found = inlineCommands(text)
  const first = found[0]
  if (first === undefined) return null
  const shown = first.length > 60 ? `${[...first].slice(0, 60).join('')}…` : first
  const more = found.length > 1 ? ` and ${found.length - 1} more` : ''
  return `Commands go in a \`\`\`sh block so Run appears: \`${shown}\`${more}`
}
