// SETUP.md is the one guide a stranger's agent follows (audit gaps 1, 2, 5, 8, 11). Every command it names has to exist and accept
// the flags it shows, so this reads the document and checks each one against the real file: the root installer is run with
// --dry-run under a temporary HOME, `talos-app <sub>` against the CLI's own command list, script paths against the tree.
import { spawnSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseArgv, parseEnvFile } from '../apps/bridge/src/config.ts'
import { COMMANDS } from '../apps/bridge/src/talos.ts'

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const setup = read('SETUP.md')

const made: string[] = []
afterAll(() => {
  for (const d of made) {
    spawnSync('chmod', ['-R', 'u+w', d])
    rmSync(d, { recursive: true, force: true })
  }
})

/** Fenced code blocks and inline code spans, as lines/strings. */
const blocks = [...setup.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] as string)
const codeLines = blocks.flatMap((b) => b.split('\n')).map((l) => l.trim())
const inline = [...setup.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string)
const allCommands = [...codeLines, ...inline]

const stripComment = (l: string) => l.replace(/\s+#\s.*$/, '').trim()

describe('SETUP.md is one ordered guide with the markers an agent needs', () => {
  it('has sections 0 to 11 in order', () => {
    const nums = [...setup.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]))
    expect(nums).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('ends every step and every optional extra with a CHECKPOINT', () => {
    const parts = setup.split(/^(?=## \d+\. |### 9\.\d )/m).filter((p) => /^(## |### )/.test(p))
    const needs = parts.filter((p) => /^## ([1-8]|10)\. /.test(p) || /^### 9\.\d /.test(p))
    expect(needs.length).toBe(8 + 1 + 9)
    for (const p of needs) expect(p, p.split('\n')[0]).toContain('**CHECKPOINT')
  })

  it('marks the human-only steps [YOU]: accounts, Railway, passkey, the pairing y', () => {
    for (const heading of [/^## 2\..*\[YOU\]/m, /^## 4\..*\[YOU\]/m, /^## 7\..*\[YOU\]/m])
      expect(setup).toMatch(heading)
    expect(setup).toMatch(/\[YOU\] Paste the whole `BRIDGE_PUBKEY=`/)
    expect(setup).toMatch(/\[YOU\] Create the passkey/)
    expect(setup).toMatch(/Type `y` only if the\s+words match/)
  })

  it('section 0 says what cannot be identical: the TestFlight build, the agent memory and hooks, the CI', () => {
    const s0 = setup.slice(setup.indexOf('## 0.'), setup.indexOf('## 1.'))
    expect(s0).toMatch(/TestFlight build/)
    expect(s0).toMatch(/memory and hooks/)
    expect(s0).toMatch(/His CI/)
    expect(s0).toMatch(/Never approve a device pairing yourself/)
  })

  it('uses one agent folder name, ~/talos-agent, and never the old ~/my-agent', () => {
    expect(setup).toContain('~/talos-agent')
    // the old name appears only in the migration note for version 1.x users, never as a folder to use
    const stray = chunks(setup).filter((c) => c.includes('my-agent') && !c.includes('Coming from version 1.x'))
    expect(stray).toEqual([])
  })

  it('starts the agent with start-talos.sh (step 6), and the installer writes exactly that file', () => {
    const step6 = setup.slice(setup.indexOf('## 6.'), setup.indexOf('## 7.'))
    expect(step6).toContain('~/talos-agent/start-talos.sh')
    expect(step6.indexOf('start-talos.sh')).toBeLessThan(step6.indexOf('talos-app doctor'))
    expect(read('install.sh')).toContain('LAUNCH="$AGENT_DIR/start-talos.sh"')
  })

  it('makes the web app the phone path, and does not tell anyone to use the maintainer TestFlight', () => {
    expect(setup).toMatch(/web app on the Home Screen is the phone path/)
    expect(setup).not.toMatch(/arrives through TestFlight/)
  })

  it('says Chronos is public, and the old "may still be private" line is gone everywhere in the setup docs', () => {
    expect(setup).toMatch(/Chronos is public/)
    for (const f of ['kit/START-HERE.md', 'kit/install.sh', 'kit/README.md', 'SETUP.md', 'docs/SETUP.md']) {
      expect(read(f), f).not.toMatch(/may still be private/)
    }
  })

  it('has the fork sync and the kit upgrade step in Updating', () => {
    const upd = setup.slice(setup.indexOf('## 10.'), setup.indexOf('## 11.'))
    expect(upd).toContain('git fetch upstream')
    expect(upd).toContain('git merge --ff-only upstream/main')
    expect(upd).toContain('bash kit/scripts/upgrade.sh --into ~/talos-agent --dry-run')
    expect(upd).toContain('talos-app update')
  })
})

describe('the entry points send an agent to SETUP.md', () => {
  it('CLAUDE.md and AGENTS.md start with a pointer, and say the kit/ rule is about editing, not installing', () => {
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      const head = read(f).split('\n').slice(0, 4).join('\n')
      expect(head, f).toContain('[`SETUP.md`](SETUP.md)')
      expect(head, f).toMatch(/Setting Talos up for a user/)
      expect(head, f).toMatch(/about [*_]editing this repo[*_]/)
    }
  })

  it('README Quick start, kit/START-HERE.md, kit/README.md and docs/SETUP.md point into it', () => {
    expect(read('README.md')).toMatch(/Follow \[`SETUP.md`\]\(SETUP.md\)/)
    expect(read('kit/START-HERE.md')).toContain('(../SETUP.md)')
    expect(read('kit/README.md')).toContain('(../SETUP.md)')
    expect(read('docs/SETUP.md')).toContain('(../SETUP.md)')
  })
})

describe('every ./install.sh in SETUP.md runs: --dry-run exits 0 under a temporary HOME', () => {
  const lines = [
    ...new Set(
      allCommands
        .map(stripComment)
        .filter((l) => l.startsWith('./install.sh'))
        .filter((l) => !/[<>]/.test(l)),
    ),
  ]

  const box = mkdtempSync(join(tmpdir(), 'setup-doc-'))
  made.push(box)
  const home = join(box, 'home')
  const bin = join(box, 'bin')
  mkdirSync(home)
  mkdirSync(bin)
  // Stubs for what a CI box may lack (the real claude, the Mac toolchain); real node, pnpm, bun, git and python3 stay on PATH.
  for (const t of ['claude', 'swift', 'xcode-select']) {
    writeFileSync(join(bin, t), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, t), 0o755)
  }

  it('finds the installer commands the guide names', () => {
    expect(lines.length).toBeGreaterThanOrEqual(5)
    expect(lines).toContain('./install.sh --dry-run')
    expect(lines.some((l) => l.includes('--with-chronos') && l.includes('--notify talos'))).toBe(true)
    expect(lines.some((l) => l.includes('--with-parakeet'))).toBe(true)
  })

  for (const line of lines) {
    it(line, () => {
      const args = line.split(/\s+/).slice(1)
      const r = spawnSync('bash', [join(root, 'install.sh'), ...args, '--dry-run'], {
        encoding: 'utf8',
        cwd: root,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: home,
          TALOS_INSTALL_OS: 'Darwin',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      })
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
      expect(r.stderr).not.toContain('unknown option')
    })
  }

  it('the --relay-url example in step 3 is accepted by the installer', () => {
    const r = spawnSync(
      'bash',
      [join(root, 'install.sh'), '--relay-url', 'https://relay.example.com', '--no-app', '--dry-run'],
      {
        encoding: 'utf8',
        cwd: root,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null' },
      },
    )
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
    expect(r.stdout).toContain('--relay-url https://relay.example.com')
    expect(setup).toContain('--relay-url https://relay.example.com')
  })
})

describe('every `talos-app <command>` in SETUP.md is a real command that takes the flags shown', () => {
  const cliSource = read('apps/bridge/src/cli-main.ts')
  const cliCommands = new Set([...cliSource.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1] as string))
  cliCommands.add('help')
  cliCommands.add('commands') // handled in talos.ts, which lists what an agent may run
  // flags are spread over the CLI and the per-command modules
  const flagSource = [
    cliSource,
    ...['adopt', 'lead', 'memory', 'schedules/cli', 'search', 'rollback'].flatMap((m) => {
      const f = `apps/bridge/src/${m}.ts`
      return existsSync(join(root, f)) ? [read(f)] : []
    }),
  ].join('\n')
  const uses = [
    ...allCommands
      .map(stripComment)
      .join('\n')
      .matchAll(/talos-app ([a-z][a-z-]*)([^\n`]*)/g),
  ]
    .map((m) => ({ sub: m[1] as string, rest: (m[2] as string).split(' -- ')[0] as string }))
    .filter((u) => !/^(command|entry|server|is|on|folder|folder\.)$/.test(u.sub))

  it('finds the commands the guide names', () => {
    const subs = new Set(uses.map((u) => u.sub))
    for (const s of [
      'help',
      'doctor',
      'enroll',
      'devices',
      'update',
      'memory',
      'search',
      'install-ask-rules',
      'schedules',
      'lead',
      'rollback',
      'report',
      'logs',
    ])
      expect(subs.has(s), s).toBe(true)
  })

  it('all of them exist', () => {
    expect([...new Set(uses.map((u) => u.sub))].filter((s) => !cliCommands.has(s))).toEqual([])
  })

  it('the --flags shown with them are ones the CLI knows', () => {
    const unknown: string[] = []
    for (const u of uses)
      for (const f of u.rest.match(/--[a-z][a-z-]*/g) ?? []) {
        if (!flagSource.includes(f.slice(2))) unknown.push(`talos-app ${u.sub} ${f}`)
      }
    expect(unknown).toEqual([])
  })
})

describe('every script path in SETUP.md exists and mentions the flags shown', () => {
  /** `~/talos-agent/scripts/x` is the kit's scripts folder, linked into the agent by the installer. */
  const toRepo = (p: string) => p.replace(/^(?:~|%s)\/talos-agent\/scripts\//, 'kit/scripts/')
  const pathRe = /((?:(?:~|%s)\/talos-agent\/scripts|apps|kit|plugins|scripts)\/[A-Za-z0-9_./-]+\.(?:sh|py|ts))/
  const uses: { path: string; line: string }[] = []
  for (const raw of allCommands.map(stripComment)) {
    const m = pathRe.exec(raw)
    if (m && !raw.includes('<')) uses.push({ path: toRepo(m[1] as string), line: raw })
  }
  // start-talos.sh does not exist in the repository: ./install.sh writes it into the agent folder (checked above)
  const generated = (p: string) => p.endsWith('start-talos.sh')

  it('finds the scripts the guide names', () => {
    const paths = new Set(uses.map((u) => u.path))
    for (const p of [
      'apps/bridge/scripts/install.sh',
      'kit/scripts/upgrade.sh',
      'kit/scripts/talos-jobs.py',
      'kit/scripts/verify-install.sh',
      'kit/scripts/voice/setup.sh',
      'apps/desktop/scripts/make-signing-identity.sh',
      'apps/desktop/scripts/build-app.sh',
      'kit/scripts/stt.sh',
    ])
      expect(paths.has(p), p).toBe(true)
  })

  it('all exist', () => {
    expect(uses.filter((u) => !generated(u.path) && !existsSync(join(root, u.path))).map((u) => u.path)).toEqual([])
  })

  it('each script source contains the --flags the guide gives it', () => {
    const bad: string[] = []
    for (const u of uses) {
      if (generated(u.path) || !existsSync(join(root, u.path))) continue
      const src = read(u.path)
      const after = u.line.slice(u.line.indexOf(u.path.split('/').pop() as string))
      for (const f of after.match(/--[a-z][a-z-]*/g) ?? []) if (!src.includes(f)) bad.push(`${u.path} ${f}`)
    }
    expect(bad).toEqual([])
  })
})

describe('the voice lines in SETUP.md, written to a real bridge.env and read by the bridge', () => {
  const printfLines = codeLines.filter((l) => l.startsWith("printf 'TALOS_APP_") && l.includes('bridge.env'))

  it('are there (STT, TTS, extension)', () => {
    expect(printfLines.length).toBe(3)
  })

  it('produce argv that points at the agent folder scripts, with the placeholders the bridge fills in', () => {
    const home = mkdtempSync(join(tmpdir(), 'setup-voice-'))
    made.push(home)
    mkdirSync(join(home, '.config', 'talos', 'app'), { recursive: true })
    for (const l of printfLines) {
      const r = spawnSync('bash', ['-c', l], { env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
    }
    const env = parseEnvFile(readFileSync(join(home, '.config', 'talos', 'app', 'bridge.env'), 'utf8'))
    const stt = parseArgv(env.TALOS_APP_STT_CMD)
    const tts = parseArgv(env.TALOS_APP_TTS_CMD)
    expect(stt).toEqual([join(home, 'talos-agent', 'scripts', 'stt.sh'), '{in}'])
    expect(tts).toEqual([join(home, 'talos-agent', 'scripts', 'tts.sh'), 'file', '{out}', '{text}'])
    expect(env.TALOS_APP_TTS_EXT).toBe('m4a')
  })

  it('tts.sh really writes an m4a through exactly that argv (macOS `say`)', (ctx) => {
    if (process.platform !== 'darwin') return
    const tmp = mkdtempSync(join(tmpdir(), 'setup-tts-'))
    made.push(tmp)
    const probe = spawnSync('say', ['-o', join(tmp, 'probe.aiff'), 'hi'], {
      env: { PATH: process.env.PATH ?? '', HOME: tmp, TALOS_TTS: 'say' },
      timeout: 10_000,
      killSignal: 'SIGKILL',
    })
    if (probe.status !== 0) ctx.skip('macOS speech (say) did not answer within 10 s on this machine')
    // the agent folder's scripts/ is a link to the kit zone; do the same here so the path in the guide is the one that runs
    const agent = join(tmp, 'talos-agent')
    mkdirSync(agent)
    symlinkSync(join(root, 'kit', 'scripts'), join(agent, 'scripts'))
    const out = join(tmp, 'reply.m4a')
    const started = performance.now()
    const r = spawnSync(join(agent, 'scripts', 'tts.sh'), ['file', out, 'Hello from the setup test.'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: tmp, TALOS_TTS: 'say' },
      timeout: 60_000,
    })
    console.info(`tts.sh real call took ${Math.round(performance.now() - started)} ms`)
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
    expect(existsSync(out)).toBe(true)
    accessSync(join(agent, 'scripts', 'tts.sh'), constants.X_OK)
  }, 90_000)
})

/** SETUP.md as list items and paragraphs; a code fence belongs to the item or paragraph it sits in. */
function chunks(text: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  let fence = false
  const flush = () => {
    if (cur.length) out.push(cur.join('\n'))
    cur = []
  }
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (!fence && cur.length === 0 && out.length) cur = [out.pop() as string] // a fence belongs to the paragraph before it
      fence = !fence
      cur.push(line)
      continue
    }
    if (fence) {
      cur.push(line)
      continue
    }
    if (line.trim() === '' || /^(\d+\.|-|#{1,6}|\|)\s/.test(line) || line.startsWith('|')) flush()
    if (line.trim() !== '') cur.push(line)
  }
  flush()
  return out
}

describe('human-only steps are marked in SETUP.md (review fix 6)', () => {
  const owner = COMMANDS.filter((c) => !c.agent_may_run).map((c) => c.name)

  it('knows which commands an agent may not run (talos.ts), including memory on and update', () => {
    expect(owner).toContain('memory on')
    expect(owner).toContain('update')
    expect(owner).toContain('enroll')
  })

  it('every chunk that tells the reader to run one of them says [YOU] or that the agent asks first', () => {
    const bad: string[] = []
    for (const c of chunks(setup)) {
      if (/Do not run/.test(c) || c.startsWith('|') || c.startsWith('**CHECKPOINT')) continue // rules, table rows and read-only checks
      for (const name of owner) {
        const re = new RegExp(`talos-app ${name.replace(/ /g, ' ')}(?![\\w-])`)
        if (re.test(c) && !/\[YOU\]|asks you first/.test(c)) bad.push(`${name}: ${c.split('\n')[0]?.slice(0, 80)}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('git push origin main, the Homebrew install and the xcode-select dialog are marked too', () => {
    const need = [/git push origin main/, /https:\/\/brew\.sh/, /xcode-select --install/]
    for (const re of need) {
      const hit = chunks(setup).filter((c) => re.test(c) && !/Do not/.test(c))
      expect(hit.length, String(re)).toBeGreaterThan(0)
      for (const c of hit) expect(c, c.split('\n')[0]).toMatch(/\[YOU\]|asks you first/)
    }
  })
})

describe('the safety rules still apply to a setup agent (review fix 7)', () => {
  it('the CLAUDE.md and AGENTS.md headers keep the Safety section in force', () => {
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      const head = read(f).split('\n').slice(0, 4).join('\n')
      expect(head, f).not.toMatch(/ignore the contributor notes/)
      expect(head, f).toMatch(/Safety (rules|section).{0,60}still appl/)
    }
  })

  it('SETUP.md section 0 carries the card rule, and does not claim to be the complete list', () => {
    const s0 = setup.slice(setup.indexOf('## 0.'), setup.indexOf('## 1.'))
    expect(s0).toMatch(/sends, posts, deploys, pays or deletes.{0,80}card/is)
    expect(s0).not.toMatch(/\bthree safety rules\b/i)
    expect(s0).toMatch(/summary of the Safety section/i)
  })

  it('SETUP.md says plainly that plain http (even localhost) is refused for the relay on purpose', () => {
    expect(setup).toMatch(/http:\/\/localhost/)
    expect(setup).toMatch(/refused on purpose/)
  })

  it('SETUP.md section 0 carries the other rules itself', () => {
    const s0 = setup.slice(setup.indexOf('## 0.'), setup.indexOf('## 1.'))
    expect(s0).toMatch(/outside.{0,40}(data|not instructions)/is)
    expect(s0).toMatch(/Never commit a key/)
    expect(s0).toMatch(/\.env/)
    expect(s0).toMatch(/\.p8/)
  })
})
