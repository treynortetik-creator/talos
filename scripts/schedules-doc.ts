// Builds docs/SCHEDULES.md from the Schedules design spec, which lives outside this repo because its last section
// ("## Appendix P") is private evidence from one real install.
//
//   node scripts/schedules-doc.ts <design-spec.md> [--out docs/SCHEDULES.md] [--check]
//
// Drops the design front matter (title, status note, changelog) and the private appendix, writes this repo's header, and
// refuses to write anything that still mentions the appendix. --check compares instead of writing (exit 1 on drift).
// After copying, run `CHECK_PRIVATE_DOCS=<design-spec.md> pnpm check:personal`: it fails if any appendix line survived.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APPENDIX = 'Appendix P'
const HEADER = `# Talos app: Schedules addendum (rev 3.1)

> Extends the original build spec (not published) (v1 rev 2 + WP8 addendum) and follows its builder rules (section 0) unchanged. Section
> numbers are this addendum's own (\`S1\`...); where it changes a SPEC section it says so ("adds to 3.4"). The SPEC tables
> it changes are already updated in SPEC.md. Copied from the design spec by \`scripts/schedules-doc.ts\`.
`

/** Known references to the private appendix in the public text, and what replaces them. */
const SCRUB: Array<[RegExp, string]> = [
  [/; dates in Appendix P\)/g, ')'],
  [/minus Appendix P;/g, 'minus its private appendix;'],
]

export function build(spec: string): string {
  const lines = spec.split('\n')
  const s1 = lines.findIndex((l) => /^## S1\./.test(l))
  if (s1 < 0) throw new Error('no "## S1." heading in the input')
  let end = lines.findIndex((l, i) => i > s1 && l.startsWith(`## ${APPENDIX}`))
  if (end < 0) end = lines.length
  let body = lines
    .slice(s1, end)
    .join('\n')
    .replace(/\s*(\n---\s*)*$/, '')
  for (const [re, to] of SCRUB) body = body.replace(re, to)
  const out = `${HEADER}\n${body}\n`
  if (out.includes(APPENDIX)) {
    const at = out.split('\n').findIndex((l) => l.includes(APPENDIX)) + 1
    throw new Error(
      `the output still mentions the private appendix (output line ${at}); add a SCRUB rule or edit the spec`,
    )
  }
  return out
}

function main(argv: string[]) {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--out')
  const outIdx = argv.indexOf('--out')
  const out = outIdx >= 0 ? (argv[outIdx + 1] as string) : join(here, '..', 'docs', 'SCHEDULES.md')
  if (!src) {
    console.error('usage: node scripts/schedules-doc.ts <design-spec.md> [--out docs/SCHEDULES.md] [--check]')
    process.exit(2)
  }
  let text: string
  try {
    text = build(readFileSync(src, 'utf8'))
  } catch (e) {
    console.error(`schedules-doc: ${(e as Error).message}`)
    process.exit(1)
  }
  if (argv.includes('--check')) {
    const same = existsSync(out) && readFileSync(out, 'utf8') === text
    console.log(same ? 'schedules-doc: up to date' : 'schedules-doc: docs/SCHEDULES.md differs from the spec')
    process.exit(same ? 0 : 1)
  }
  writeFileSync(out, text)
  console.log(`schedules-doc: wrote ${out}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
