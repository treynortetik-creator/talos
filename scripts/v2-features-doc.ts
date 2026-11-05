// Builds docs/V2-FEATURES.md from the v2 features design spec, which lives outside this repo with the rest of the design
// notes. Same pattern as scripts/claude-code-doc.ts:
//
//   node scripts/v2-features-doc.ts <design-spec.md> [--out docs/V2-FEATURES.md] [--check]
//
// Keeps V0 through the source list, drops the design front matter (title, labels, changelog, the review-finding table)
// and everything from the first line that BEGINS with a private-appendix heading (the spec has none today; the rule stays
// so one can never slip in), writes this repo's header with the calls made while building WP-V0, applies those calls to
// the sentences they change, and refuses to write anything that still mentions an appendix or matches a private-path
// pattern. --check compares instead of writing (exit 1 on drift). After copying, run
// `CHECK_PRIVATE_DOCS=<design-spec.md> pnpm check:personal`.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APPENDIX = ['Appendix', 'P'].join(' ')
const HEADER = `# Talos app: v2 features addendum (rev 2)

> Extends the original build spec (not published) (v1 rev 2 + WP8 addendum), [SCHEDULES.md](SCHEDULES.md) and [CLAUDE-CODE.md](CLAUDE-CODE.md),
> and follows SPEC section 0 (builder rules) unchanged. Section numbers are this addendum's own (\`V0\`...). The SPEC
> tables it changes are already updated in SPEC.md. Copied from the design spec by \`scripts/v2-features-doc.ts\`.
> **INFERENCE** marks a claim not checked against a source or a run; **SMOKE** marks one that needs a real device (V9).
>
> **Calls made while building WP-V0** (they win over the text below where they differ; the text is already edited):
> - **Zero-tap share filing.** The bridge, not the agent, appends every Shortcut share to
>   \`$TALOS_APP_HOME/shared-inbox/<day>.md\`, still inside its wrapExternal markers, idempotent on \`share_id\`, and tells
>   the agent it is saved. No agent judgment is involved, so a share has nothing to inject into, and saving costs no tap.
> - **The driving voice follow-up is sent \`silent\`**, so a reply in driving mode pushes once, not twice.
> - **Relay features ride on the existing \`ready.features\`**, which already means "what the relay supports"; there is
>   no separate relay-features field. Modules add theirs with \`registerRelayFeature()\` when they land.
> - **The hourly external check is dropped for now (owner decision; v1.1).** Everything about the GitHub Actions
>   workflow in V0, V2.1, V2.3 rule 4, V2.4, V2.6, V7, V8 and V9.2 is deferred: no \`GET /api/health\`, no
>   \`HEALTH_TOKEN\` or \`HEALTH_CHECK_STALE_H\`, no \`health_check_stale\` push, no \`external_check\` field and no
>   \`examples/health.yml\`. What stays: the relay watchdog (bridge and mod quiet, quiet window respected), optional ntfy,
>   and \`GET /api/status\` behind Settings -> Health.
> - **Owner defaults (V10):** search keeps 90 days by default and \`TALOS_APP_HISTORY_DAYS=0\` keeps text forever (the
>   setting ships in V0); shared items are read, summarised and drafted with no tap, and only side effects get a card.
`

/** The calls above, applied to the sentences they change. Each must match exactly once. */
const SCRUB: Array<[RegExp, string]> = [
  [
    /A "save this" note becomes a one-tap card \("Save to notes\?"\)/,
    'The bridge has already filed it in the shared inbox (zero taps); the agent never saves it again',
  ],
  [
    /- \*\*The cost to the owner\*\* is one tap for "save this" from the iPhone\. Summarising and triaging stay free \(V10 Q3\)\./,
    '- **The cost to the owner** is nothing for "save this": the bridge files every token share. Summarising, triaging and\n  drafting stay free; only side effects take a tap (V10 Q3).',
  ],
  [/a new `ready\.relay_features` that/, 'the existing `ready.features` that'],
  [/the `relay_features` and last-known/, 'the `ready.features` and last-known'],
  [
    /as a follow-up message with a `voice_reply` attachment and `reply_to` the text message\./,
    'as a follow-up message, sent `silent`, with a `voice_reply` attachment and `reply_to` the text message.',
  ],
  [
    /The agent summarises and offers a card\s+\("Save to notes\?", "Draft a reply\?"\), so "do X" from the iPhone share sheet costs one tap\./,
    'The bridge files them with no tap; the agent\n   summarises and drafts freely, and anything with side effects is a card, so "do X" from the iPhone share sheet costs\n   one tap.',
  ],
  // the memory browser's own source folder, not a private notes path
  [/`memory\/deny\.ts`/, '`src/memory/deny.ts`'],
]

/** Patterns that mean private material leaked into the public text. Hits print as line numbers only. */
const PRIVATE: Array<[RegExp, string]> = [
  // `memory/1` is a feature flag, not a notes folder
  [/(^|[\s`("'[])(research|memory)\/(?!1(?![A-Za-z0-9_.-]))[A-Za-z0-9_.-]+/, 'a private notes path'],
  [/\bTG [0-9]/, 'a chat message id'],
  [/\/Users\/[A-Za-z]/, 'a home-directory path'],
  [/~\/(Desktop|Documents|Library)\//, 'a home-directory path'],
  [/\bPRIVATE\b/, 'a PRIVATE marker'],
  [/-REVIEW\.md/, 'a pointer to a design-only review file'],
]

export function build(spec: string): string {
  const lines = spec.split('\n')
  const v0 = lines.findIndex((l) => /^## V0\./.test(l))
  if (v0 < 0) throw new Error('no "## V0." heading in the input')
  let end = lines.findIndex((l, i) => i > v0 && l.startsWith(`## ${APPENDIX}`))
  if (end < 0) end = lines.length
  let body = lines
    .slice(v0, end)
    .join('\n')
    .replace(/\s*(\n---\s*)*$/, '')
  // the review the spec answers is a design-time file; the public copy keeps only its date
  body = body.replace(/^- Review: `[^`]*` \(([0-9-]+)\)\.?$/m, '- Adversarial design review ($1).')
  for (const [re, to] of SCRUB) {
    if (!re.test(body)) throw new Error(`a WP-V0 call no longer matches the spec text (${re.source.slice(0, 40)}...)`)
    body = body.replace(re, to)
  }
  const out = `${HEADER}\n${body}\n`
  const outLines = out.split('\n')
  const at = outLines.findIndex((l) => l.includes(APPENDIX))
  if (at >= 0) throw new Error(`the output mentions a private appendix (output line ${at + 1}); edit the spec`)
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
    ['format', '--stdin-file-path=docs/V2-FEATURES.md'],
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
  const out = outIdx >= 0 ? (argv[outIdx + 1] as string) : join(here, '..', 'docs', 'V2-FEATURES.md')
  if (!src) {
    console.error('usage: node scripts/v2-features-doc.ts <design-spec.md> [--out docs/V2-FEATURES.md] [--check]')
    process.exit(2)
  }
  let text: string
  try {
    text = formatMarkdown(build(readFileSync(src, 'utf8')))
  } catch (e) {
    console.error(`v2-features-doc: ${(e as Error).message}`)
    process.exit(1)
  }
  if (argv.includes('--check')) {
    const same = existsSync(out) && readFileSync(out, 'utf8') === text
    console.log(same ? 'v2-features-doc: up to date' : 'v2-features-doc: docs/V2-FEATURES.md differs from the spec')
    process.exit(same ? 0 : 1)
  }
  writeFileSync(out, text)
  console.log(`v2-features-doc: wrote ${out}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
