// Docs-vs-code audit (README.md, docs/SETUP.md, docs/CUSTOMIZE.md, docs/SECURITY.md, docs/THREADS.md).
// Each test asserts that a doc and the source agree, and names the finding of the bug hunt it came from
// (docs/audits/2026-11-10-bughunt-cli-docs.md); the docs were fixed to agree, and these keep them agreeing. Sources are
// read as text so nothing here starts a process or needs the network.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const flat = (s: string) => s.replace(/\s+/g, ' ')

const readme = read('README.md')
const setup = read('docs/SETUP.md')
const customize = read('docs/CUSTOMIZE.md')
const security = read('docs/SECURITY.md')
const threads = read('docs/THREADS.md')

describe('docs/SETUP.md against the installer and the CLI', () => {
  // FINDING 1: SETUP.md Step 4 says "`talos-app` never loads the agent folder's `.env` file into that environment". The
  // PATH wrapper keeps that promise with `bun --no-env-file`, but the launch script the root install.sh writes
  // (~/talos-agent/start-talos.sh, the first way Step 4 tells you to start the agent) runs `bun run cli.ts start` without
  // it, so bun loads the .env of the folder it is run in and `start` passes it on to claude.
  it('every launcher the installers write for `talos-app start` keeps the .env out, as Step 4 promises', () => {
    expect(flat(setup)).toContain("never loads the agent folder's `.env` file")
    const wrapper = read('apps/bridge/scripts/install.sh')
      .split('\n')
      .find((l) => l.includes('exec') && l.includes('run $(shq "$BRIDGE_DIR/src/cli.ts")'))
    expect(wrapper).toContain('--no-env-file') // the wrapper does it
    const launch = read('install.sh')
      .split('\n')
      .find((l) => l.includes("printf 'exec bun") && l.includes('start --agent-dir'))
    expect(launch, 'the start-talos.sh line in install.sh').toBeDefined()
    expect(launch).toContain('--no-env-file')
  })

  // FINDING 2: SETUP.md Upgrading says how many things are left and numbers them 0 to 5; `talos-app update` prints the same
  // steps. Step 0 ("Sync your fork first") is a double-quoted string, so every quote kind counts, as in bughunt-cli C14.
  it('`talos-app update` lists as many follow-up steps as the Upgrading section says it does', () => {
    const words: Record<string, number> = { Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7 }
    const m = /(\w+) things are still yours to do\. The command lists them/.exec(flat(setup))
    expect(m, 'the sentence in docs/SETUP.md').not.toBeNull()
    const said = words[(m as RegExpExecArray)[1] as string]
    const cli = read('apps/bridge/src/cli-main.ts')
    const body = cli.slice(cli.indexOf('async function cmdUpdate'), cli.indexOf('const CODEX_USAGE'))
    // one number per step: a step worded per computer (the Mac's and the others', a3671458) is still one step
    const printed = [...new Set([...body.matchAll(/["'`] {2}(\d)\. /g)].map((x) => x[1]))]
    expect(printed).toEqual(['0', '1', '2', '3', '4', '5'])
    expect(printed.length).toBe(said)
  })

  // FINDING 2b: the same section says an agent on the plugin layout ("every new install") updates the kit with
  // `talos update`; the command's own step 4 only names kit/scripts/upgrade.sh, which the doc calls the older way.
  it('the kit step `talos-app update` prints names the command the Upgrading section gives for new installs', () => {
    expect(flat(setup)).toMatch(/plugin layout \(every new install\) updates with `talos update --dry-run`/)
    const cli = read('apps/bridge/src/cli-main.ts')
    const body = cli.slice(cli.indexOf('async function cmdUpdate'), cli.indexOf('const CODEX_USAGE'))
    const step4 = body.split('\n').find((l) => /['`] {2}4\. /.test(l)) ?? ''
    expect(step4).toContain('talos update')
  })
})

describe('docs/SECURITY.md against the bridge', () => {
  // FINDING 3: "Terminal check" lists the human-only commands and says the table in talos.ts (`needs_terminal`) is the
  // one list. The table also gates `theme reset` and `lead init`; neither is in the doc's list (nor in the attacker table).
  it('the Terminal check paragraph names every terminal-only `talos-app` command in talos.ts', () => {
    const src = read('apps/bridge/src/talos.ts')
    const kit = new Set(['update', 'rollback', 'restore']) // KIT_NAMES: terminal-only under `talos`, not `talos-app`
    const names = [...src.matchAll(/ownerTerminal\(\s*'([^']+)'/g)]
      .map((m) => m[1] as string)
      .filter((n) => !kit.has(n))
    expect(names).toContain('enroll')
    const text = flat(security)
    const para = text.slice(
      text.indexOf('**Terminal check.**'),
      text.indexOf("**Main's development-channel warning.**"),
    )
    expect(para.length).toBeGreaterThan(100)
    const missing = names.filter((n) => !para.includes(`\`${n}\``))
    expect(missing).toEqual([])
  })

  // FINDING 4: "Folder listing" says the refused roots are the lead fence's list "plus `~/.gnupg`, `~/.config/talos`,
  // `~/.talos-inbox` and `~/Library`". FOLDER_EXTRA_REFUSED has twelve entries, not four.
  it('the folder picker section names every extra refused root in FOLDER_EXTRA_REFUSED', () => {
    const src = read('apps/bridge/src/folders/service.ts')
    const block = /export const FOLDER_EXTRA_REFUSED = \[([\s\S]*?)\] as const/.exec(src)
    expect(block).not.toBeNull()
    const roots = [...((block as RegExpExecArray)[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string)
    expect(roots).toContain('.gnupg')
    const text = flat(security)
    const section = text.slice(text.indexOf('## Folder listing'), text.indexOf('## Reporting a problem'))
    const missing = roots.filter((r) => !section.includes(`\`~/${r}\``))
    expect(missing).toEqual([])
  })

  // FINDING 5: "Folder listing" cited "docs/OPTION-C.md 9.2" for the Choose… button. OPTION-C.md has no numbered
  // sections at all and never mentions the button; docs/desktop.md describes it.
  it('the doc SECURITY.md cites for the Choose… button describes it, and every numbered section it cites exists', () => {
    const cite = /Choose… button \((docs\/[A-Za-z-]+\.md)[^)]*\)/.exec(security)
    expect(cite, 'a doc cited beside the Choose… button').not.toBeNull()
    expect(read((cite as RegExpExecArray)[1] as string)).toContain('Choose…')
    for (const [, file, n] of security.matchAll(/(docs\/[A-Za-z-]+\.md) (\d+\.\d+)/g))
      expect(
        read(file as string)
          .split('\n')
          .some((l) => l.startsWith('#') && l.includes(n as string)),
        `${file} ${n}`,
      ).toBe(true)
  })
})

describe('docs/THREADS.md against the web app', () => {
  // FINDING 6: the "Where" table said of Settings > Agent: "The older full editor (name, live-call context, archive,
  // arrows) stays." The Agent settings section holds only a paragraph and a "Manage threads" link.
  it('the Where table says what Settings > Agent has: the Manage threads link, not an editor', () => {
    const row = threads.split('\n').find((l) => l.startsWith('| Settings > Agent')) ?? ''
    const section = read('apps/web/src/features/agent-config/AgentSettingsSection.tsx')
    expect(row).toContain('Manage threads')
    expect(row).toContain('/threads?manage=1')
    expect(section).toContain('/threads?manage=1')
    // a row that promises an archive control or move buttons needs them in the section
    if (/archive|arrows/i.test(row)) expect(section).toMatch(/Archive thread|Move up|Move down/)
  })

  // FINDING 7 (cosmetic): "Saving" quotes the timeout message as "your Mac hasn't confirmed this yet". The app says
  // "Your Mac hasn't confirmed this change yet. It applies when your Mac picks it up."
  it('the save-timeout sentence THREADS.md quotes is one the app shows', () => {
    const q = /20 s, then "([^"]+)"/.exec(flat(threads))
    expect(q).not.toBeNull()
    const quoted = ((q as RegExpExecArray)[1] as string).toLowerCase()
    const app = read('apps/web/src/lib/socket-client-owner.ts').toLowerCase()
    expect(app).toContain(quoted)
  })
})

describe('README.md and .env.example against the source', () => {
  // FINDING 8: "Working in the repo" says `pnpm test` is "Vitest: protocol, testkit, integrations, relay, web, scripts".
  // vitest.config.ts also has a `mobile` project.
  it('the `pnpm test` line names every Vitest project', () => {
    const projects = [...read('vitest.config.ts').matchAll(/name: '([a-z]+)'/g)].map((m) => m[1] as string)
    expect(projects).toContain('scripts')
    const line = readme.split('\n').find((l) => l.startsWith('pnpm test ')) ?? ''
    expect(line).toContain('Vitest:')
    const missing = projects.filter((p) => !new RegExp(`\\b${p}\\b`).test(line))
    expect(missing).toEqual([])
  })

  // FINDING 9: README called .env.example "the list of every environment variable" and SETUP.md Step 2 said it "lists
  // every variable". It is the relay's file: the bridge's settings go in bridge.env. It also lacked TALOS_VERSION, which
  // the relay reads, and filed TALOS_WEB_DIR, which the relay reads too, under "Not read by the relay".
  it('.env.example lists every variable the relay reads, and README and SETUP.md say that is what it is', () => {
    expect(flat(readme)).toContain('every environment variable the relay reads')
    expect(flat(setup)).toContain('lists every variable the relay reads')
    const example = read('.env.example')
    const has = (k: string) => new RegExp(`^#? ?${k}=`, 'm').test(example)
    const relay = ['apps/relay/src/index.ts', 'apps/relay/src/version.ts']
      .flatMap((f) => [...read(f).matchAll(/process\.env\.([A-Z0-9_]+)/g)])
      .map((m) => m[1] as string)
    expect(relay).toContain('TALOS_VERSION')
    expect(relay.filter((k) => !has(k))).toEqual([])
    expect(example).not.toContain('Not read by the relay')
  })

  // FINDING 10: .env.example (which SETUP.md Step 2 sends you to) says MEDIA_MAX_MB takes "1 to 500". The relay's
  // schema caps it at 50, as SETUP.md's table says; a value above 50 fails with "Invalid relay environment".
  it('.env.example and SETUP.md give the MEDIA_MAX_MB range the relay enforces', () => {
    const m = /MEDIA_MAX_MB: int\((\d+), (\d+), (\d+)\)/.exec(read('apps/relay/src/env.ts'))
    expect(m).not.toBeNull()
    const [, , min, max] = m as RegExpExecArray
    const row = setup.split('\n').find((l) => l.startsWith('| `MEDIA_MAX_MB`')) ?? ''
    expect(row).toContain(`(${min} to ${max})`)
    const comment = read('.env.example')
      .split('\n')
      .find((l) => l.startsWith('# Largest upload in megabytes'))
    expect(comment).toContain(`(${min} to ${max})`)
  })
})

describe('docs/CUSTOMIZE.md structure', () => {
  // FINDING 11: the first line promises "a theme token, a setting, a card kind and an agent tool". There is no card
  // kind heading: the whole CARD_KIND_TABLE guide sits under "## A setting", after its single bullet.
  it('has a section for each of the four things its first line promises', () => {
    expect(customize).toContain('Where to change a theme token, a setting, a card kind and an agent tool.')
    const headings = customize
      .split('\n')
      .filter((l) => l.startsWith('## '))
      .map((l) => l.toLowerCase())
    for (const topic of ['theme token', 'setting', 'card kind', 'agent tool'])
      expect(
        headings.some((h) => h.includes(topic)),
        topic,
      ).toBe(true)
  })
})
