// Builds docs/CLAUDE-CODE.md from the Claude Code integration design spec, which lives outside this repo because its last
// section ("## Appendix P") is private evidence from one real install.
//
//   node scripts/claude-code-doc.ts <design-spec.md> [--out docs/CLAUDE-CODE.md] [--check]
//
// Keeps C0 through the source list, drops the design front matter (title, status note, changelog) and everything from
// the first line that BEGINS with the appendix heading, writes this repo's header, and refuses to write anything that
// still mentions the appendix or matches a private-path pattern (private note folders, chat message ids, home paths).
// --check compares instead of writing (exit 1 on drift). After copying, run
// `CHECK_PRIVATE_DOCS=<design-spec.md> pnpm check:personal`: it fails if any appendix line survived anywhere.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APPENDIX = ['Appendix', 'P'].join(' ')
const HEADER = `# Talos app: Claude Code integration addendum (rev 2.1)

> Extends the original build spec (not published) (v1 rev 2 + WP8 addendum) and follows its builder rules (section 0) unchanged. Section
> numbers are this addendum's own (\`C0\`...); where it changes a SPEC section it says so ("replaces 4.9"). The SPEC
> tables it changes are already updated in SPEC.md, and the calls made while building WP-C0/C0.5 are in SPEC.md's
> changelog. Copied from the design spec by \`scripts/claude-code-doc.ts\`.
`

/** Known references to the private appendix in the public text, and what replaces them. */
const SCRUB: Array<[RegExp, string]> = [
  [
    /\*\*WP-C0 copy step\.\*\*[\s\S]*?\(kept out of this file so it doesn't trip its own check\)\./,
    '**WP-C0 copy step.** `scripts/claude-code-doc.ts` copies C0-C12 and the source list from the design spec, drops its\nfront matter and private appendix, and refuses output that mentions the appendix or matches a private-path pattern;\n`check:personal` then runs with the private denylist and the design spec named in `CHECK_PRIVATE_DOCS`.',
  ],
]

/** Patterns that mean private material leaked into the public text. Hits print as line numbers only. */
const PRIVATE: Array<[RegExp, string]> = [
  [/(^|[\s`("'[])(research|memory)\/[A-Za-z0-9_.-]+/, 'a private notes path'],
  [/\bTG [0-9]/, 'a chat message id'],
  [/\/Users\/[A-Za-z]/, 'a home-directory path'],
  [/~\/(Desktop|Documents|Library)\//, 'a home-directory path'],
  [/\bPRIVATE\b/, 'a PRIVATE marker'],
]

export function build(spec: string): string {
  const lines = spec.split('\n')
  const c0 = lines.findIndex((l) => /^## C0\./.test(l))
  if (c0 < 0) throw new Error('no "## C0." heading in the input')
  let end = lines.findIndex((l, i) => i > c0 && l.startsWith(`## ${APPENDIX}`))
  if (end < 0) end = lines.length
  let body = lines
    .slice(c0, end)
    .join('\n')
    .replace(/\s*(\n---\s*)*$/, '')
  for (const [re, to] of SCRUB) body = body.replace(re, to)
  const out = `${HEADER}\n${body}\n`
  const outLines = out.split('\n')
  const at = outLines.findIndex((l) => l.includes(APPENDIX))
  if (at >= 0)
    throw new Error(
      `the output still mentions the private appendix (output line ${at + 1}); add a SCRUB rule or edit the spec`,
    )
  for (const [re, what] of PRIVATE) {
    const hit = outLines.findIndex((l) => re.test(l))
    if (hit >= 0) throw new Error(`the output has ${what} (output line ${hit + 1}); edit the spec`)
  }
  return out
}

/** The repo formats markdown with Biome (tables get padded), so the copy is written already formatted. */
export function formatMarkdown(text: string): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const r = spawnSync(
    join(root, 'node_modules', '.bin', 'biome'),
    ['format', '--stdin-file-path=docs/CLAUDE-CODE.md'],
    {
      cwd: root,
      input: text,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  if (r.status !== 0 || !r.stdout) throw new Error('biome format failed; run pnpm install first')
  return r.stdout
}

function main(argv: string[]) {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--out')
  const outIdx = argv.indexOf('--out')
  const out = outIdx >= 0 ? (argv[outIdx + 1] as string) : join(here, '..', 'docs', 'CLAUDE-CODE.md')
  if (!src) {
    console.error('usage: node scripts/claude-code-doc.ts <design-spec.md> [--out docs/CLAUDE-CODE.md] [--check]')
    process.exit(2)
  }
  let text: string
  try {
    text = formatMarkdown(build(readFileSync(src, 'utf8')))
  } catch (e) {
    console.error(`claude-code-doc: ${(e as Error).message}`)
    process.exit(1)
  }
  if (argv.includes('--check')) {
    const same = existsSync(out) && readFileSync(out, 'utf8') === text
    console.log(same ? 'claude-code-doc: up to date' : 'claude-code-doc: docs/CLAUDE-CODE.md differs from the spec')
    process.exit(same ? 0 : 1)
  }
  writeFileSync(out, text)
  console.log(`claude-code-doc: wrote ${out}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
