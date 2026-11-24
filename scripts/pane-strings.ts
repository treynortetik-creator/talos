// The owner rule behind docs/PANE-PROMPTS: nothing that needs the owner lives only in a session's terminal. So no text the owner reads may
// mention a terminal at all: the app ("Terminals", "Terminal"), `tmux attach`, "in its pane", "ssh to", "run claude /login". The rule is the
// WORD, not an instruction shape: "press Esc in this thread's pane in Terminals" and "Check the session in Terminals" fail as much as "open
// Terminals". This scans the three trees that make owner-facing text (the Mac app, the bridge, the web app).
//
// What is NOT owner text and is left alone: comments, and the settings and developer text that is meant for a developer (row `advanced` in the
// test's allowlist). What is owner text and not converted yet sits in ALLOWED with the plan row (the pane-prompts plan, rows
// 1 to 12) that removes it. An entry that no longer matches anything fails the test: delete the entry when the string goes.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** The patterns an owner must never be told. Each is matched against one non-comment line of source. */
export const FORBIDDEN: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'open-terminals', re: /\bopen (?:this thread )?(?:in )?terminals?\b/i },
  // the Mac's Terminals window (plural, capital T), or the Terminal app named as the place to go ("in Terminal", "open Terminal"). A feature name
  // alone ("Terminal screen", an icon label) is not a place the owner is sent, and lower-case "terminal" is the general word.
  { id: 'terminals-app', re: /\bTerminals\b/ },
  { id: 'terminal-app', re: /\b(?:in|open|from|into|via|run it in) (?:the |a |your |this )?Terminal\b/ },
  // a key the owner is told to press in a session ("press Esc in …"): the pane is where they are sent, however the place is spelled
  { id: 'press-esc', re: /\bpress Esc\b/i },
  // a session's pane named as the place to go
  { id: 'in-its-pane', re: /\bin (?:its|their|the|that|this|this thread's|Main's|a|each|every) pane\b/i },
  { id: 'tmux-attach', re: /tmux attach/i },
  { id: 'ssh', re: /\bssh (?:to|into)\b/i },
  { id: 'run-login', re: /\b(?:run|type) `?(?:claude )?\/login/i },
  { id: 'attach-on', re: /\battach on\b/i },
]

export type Allowed = {
  /** Path from the repository root, forward slashes. */
  file: string
  /** A substring of the offending line (its exact words, so a new string in the same file is still caught). */
  line: string
  why: string
  /** Where it is converted: a row of the pane-prompts plan, or `advanced` for settings and developer text. */
  row: string
}

export const ROOTS = ['apps/desktop/Sources', 'apps/bridge/src', 'apps/web/src'] as const
const EXT = /\.(swift|ts|tsx)$/

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p)
    else if (EXT.test(name)) yield p
  }
}

const isComment = (t: string) => t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#')
/** A line's code and strings, without a trailing `// remark` (a remark after code is a comment too, never shown). */
const codePart = (t: string): string => {
  const at = t.indexOf(' // ')
  return at < 0 ? t : t.slice(0, at)
}

export type Hit = { file: string; line: number; id: string; text: string }

/** Every forbidden instruction on a non-comment line under `roots`. */
export function scan(root: string, roots: readonly string[] = ROOTS): Hit[] {
  const hits: Hit[] = []
  for (const r of roots) {
    let base: string
    try {
      base = join(root, r)
      statSync(base)
    } catch {
      continue
    }
    for (const f of walk(base)) {
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((text, i) => {
        if (isComment(text.trim())) return
        const code = codePart(text)
        for (const { id, re } of FORBIDDEN)
          if (re.test(code))
            hits.push({ file: relative(root, f).replaceAll('\\', '/'), line: i + 1, id, text: text.trim() })
      })
    }
  }
  return hits
}

/** The hits no allowlist entry covers, and the entries that cover nothing. */
export function judge(hits: Hit[], allowed: readonly Allowed[]): { uncovered: Hit[]; stale: Allowed[] } {
  const used = new Set<Allowed>()
  const uncovered = hits.filter((h) => {
    const a = allowed.find((x) => x.file === h.file && h.text.includes(x.line))
    if (a) used.add(a)
    return !a
  })
  return { uncovered, stale: allowed.filter((a) => !used.has(a)) }
}
