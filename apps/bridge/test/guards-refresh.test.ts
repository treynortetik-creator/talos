// `talos-app guards refresh` (guards/refresh.ts): the installed guards rebuilt from this version's code, re-pinned to the bun running
// it, for the checkout they were installed from. Every test runs in a temp Talos home; nothing here reads or writes the owner's real
// home or ~/.claude.
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { loadGuardConfig } from '../src/guards/hook.ts'
import {
  CHECKOUT,
  COLLECT_GRACE_MS,
  currentBun,
  GUARD_HOOK_GONE_REASON,
  guardFiles,
  runInstallGuards,
} from '../src/guards/install.ts'
import { REFRESH_LINE, runGuardsRefresh } from '../src/guards/refresh.ts'
import { buildGuardConfig, denyRules, guardDecision } from '../src/guards/rules.ts'
import { processStartTime } from '../src/proc-identity.ts'
import { refusedForWorkers } from '../src/worker/cli-refusal.ts'

const root = realpathSync(mkdtempSync('/tmp/gr'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const BUN = currentBun()
const quiet = { out: () => {}, err: () => {} }
const capture = () => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
}
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')

let n = 0
/** A fresh world: a Talos home, a user home, Claude Code's folder and a checkout with its own protected-paths list. */
function world(o: { checkout?: string } = {}) {
  const w = join(root, `w${n++}`)
  const userHome = join(w, 'user')
  const home = join(userHome, '.config', 'talos')
  const claudeHome = join(w, 'claude')
  const checkout = o.checkout ?? join(w, 'checkout')
  if (!o.checkout) {
    mkdirSync(join(checkout, 'docs'), { recursive: true })
    mkdirSync(join(checkout, 'apps', 'bridge', 'src'), { recursive: true })
    writeFileSync(join(checkout, 'apps', 'bridge', 'src', 'cli.ts'), '// stand-in\n')
    writeFileSync(join(checkout, 'docs', 'protected-paths.txt'), 'apps/bridge/src/keys.ts\n')
  }
  mkdirSync(home, { recursive: true })
  mkdirSync(claudeHome, { recursive: true })
  const guards = join(home, 'guards')
  const settings = join(guards, 'settings.json')
  return { w, userHome, home, claudeHome, checkout, guards, settings }
}
type World = ReturnType<typeof world>
const install = (x: World, bun = BUN) =>
  expect(
    runInstallGuards(
      { home: x.home, checkout: x.checkout, claudeHome: x.claudeHome, userHome: x.userHome, bun },
      [],
      quiet,
    ),
  ).toBe(0)
const refresh = (x: World, o: { bun?: string; checkout?: string; args?: string[]; now?: number } = {}) => {
  const c = capture()
  const code = runGuardsRefresh(
    { home: x.home, checkout: o.checkout ?? x.checkout, bun: o.bun ?? BUN, ...(o.now ? { now: o.now } : {}) },
    o.args ?? [],
    c.io,
  )
  return { code, line: c.out.join('\n'), err: c.err.join('\n') }
}
/** A refresh after the grace a rules file nothing names is kept for (install.ts COLLECT_GRACE_MS) has passed. */
const refreshLater = (x: World) => refresh(x, { now: Date.now() + COLLECT_GRACE_MS + 60_000 })
const command = (x: World) =>
  JSON.parse(readFileSync(x.settings, 'utf8')).hooks.PreToolUse[0].hooks[0].command as string
/** The rules file the installed hook names (`--config`), and the hash it holds them to. */
const rulesFile = (x: World) => JSON.parse(/--config ("(?:[^"\\]|\\.)*")/.exec(command(x))?.[1] as string) as string
const hookSha = (x: World) => /--sha ([0-9a-f]{64})/.exec(command(x))?.[1] as string
const bytes = (x: World) => ({ settings: readFileSync(x.settings, 'utf8'), rules: readFileSync(rulesFile(x), 'utf8') })
const ruleFiles = (x: World) =>
  readdirSync(x.guards)
    .filter((f) => /^guards(-[0-9a-f]{64})?\.json$/.test(f))
    .sort()
const stamp = (p: string) => {
  const s = statSync(p)
  return `${s.ino} ${s.mtimeMs}`
}
/** A stand-in bun at a Cellar-shaped path that runs the real one: what a hook pinned to an old Homebrew version looks like. */
function cellarBun(x: World, version: string): string {
  const p = join(x.w, 'Cellar', 'bun', version, 'bin', 'bun')
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, `#!/bin/sh\nexec ${JSON.stringify(BUN)} "$@"\n`)
  chmodSync(p, 0o755)
  return p
}
/** A hook command run the way Claude Code runs a command hook: by a shell, the call on stdin. */
function runShell(cmd: string, call: object, home: string) {
  const p = Bun.spawnSync(['/bin/sh', '-c', cmd], {
    stdin: new TextEncoder().encode(JSON.stringify(call)),
    env: { PATH: '/usr/bin:/bin', HOME: home },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const runHookAsClaudeCode = (x: World, call: object) => runShell(command(x), call, x.userHome)
const writeToGuards = (x: World) => ({
  session_id: 's',
  hook_event_name: 'PreToolUse',
  cwd: x.userHome,
  tool_name: 'Write',
  tool_input: { file_path: join(x.guards, 'x.json'), content: '{}' },
})
const ls = (x: World) => ({
  session_id: 's',
  hook_event_name: 'PreToolUse',
  cwd: x.userHome,
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
})
const decision = (out: string) => (out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow')
const LINE = /^guards refresh: (unchanged|changed( (rules|bun|settings))+|refused [a-z-]+)$/
/** A thread session's settings as the Mac writes them at its start: the guards' hooks copied in. */
const liveSession = (x: World, id: string) => {
  mkdirSync(join(x.home, 'workers', id), { recursive: true })
  writeFileSync(join(x.home, 'workers', id, 'settings.json'), readFileSync(x.settings))
}

describe('guards refresh: only what is installed, nothing else', () => {
  test('refuses when the guards are not installed, and never installs them', () => {
    const x = world()
    expect(refresh(x)).toMatchObject({ code: 1, line: `${REFRESH_LINE} refused not-installed` })
    expect(existsSync(x.guards)).toBe(false)
    mkdirSync(x.guards, { mode: 0o700 })
    writeFileSync(join(x.guards, 'main-launch.json'), '{}')
    expect(refresh(x).line).toBe(`${REFRESH_LINE} refused not-installed`)
    expect(existsSync(x.settings) || ruleFiles(x).length > 0).toBe(false)
  })

  test('just installed: a no-op that writes nothing', () => {
    const x = world()
    install(x)
    const before = [stamp(x.settings), stamp(rulesFile(x))]
    const b = bytes(x)
    expect(refresh(x)).toMatchObject({ code: 0, line: `${REFRESH_LINE} unchanged` })
    expect([stamp(x.settings), stamp(rulesFile(x))]).toEqual(before)
    expect(bytes(x)).toEqual(b)
  })

  test('a moved bun: re-pinned to the new one, the rules untouched, and byte for byte what install-guards writes', () => {
    const x = world()
    const old = cellarBun(x, '1.3.11')
    install(x, old)
    expect(command(x)).toContain(old)
    const rulesBefore = stamp(rulesFile(x))
    const fresh = cellarBun(x, '1.4.4')
    expect(refresh(x, { bun: fresh })).toMatchObject({ code: 0, line: `${REFRESH_LINE} changed bun` })
    expect(command(x)).toContain(`exec ${JSON.stringify(fresh)} `)
    expect(command(x)).not.toContain(old)
    expect(stamp(rulesFile(x))).toBe(rulesBefore)
    const refreshed = bytes(x)
    install(x, fresh)
    expect(bytes(x)).toEqual(refreshed)
    expect((statSync(x.settings).mode & 0o777).toString(8)).toBe('600')
    expect((statSync(rulesFile(x)).mode & 0o777).toString(8)).toBe('600')
    expect(refresh(x, { bun: fresh }).line).toBe(`${REFRESH_LINE} unchanged`)
  })

  test('the bun is pinned by its real path, never the link it was run through', () => {
    const x = world()
    install(x)
    const fresh = cellarBun(x, '1.5.0')
    const link = join(x.w, 'bin-bun')
    symlinkSync(fresh, link)
    expect(refresh(x, { bun: link }).line).toBe(`${REFRESH_LINE} changed bun`)
    expect(command(x)).toContain(`exec ${JSON.stringify(fresh)} `)
  })

  test('a release with new rules is named; the hook loads the rules it was given', () => {
    const x = world()
    install(x)
    writeFileSync(join(x.checkout, 'docs', 'protected-paths.txt'), 'apps/bridge/src/keys.ts\napps/relay/src/auth\n')
    expect(refresh(x).line).toBe(`${REFRESH_LINE} changed rules`)
    const cfg = loadGuardConfig(rulesFile(x), hookSha(x))
    expect(cfg.protectedPaths).toContain(join(x.checkout, 'apps', 'relay', 'src', 'auth'))
    expect(JSON.parse(readFileSync(x.settings, 'utf8')).permissions.deny).toEqual(denyRules(cfg))
    expect(existsSync(join(x.guards, '.refresh.lock'))).toBe(false)
  })

  test('the install-time facts come from the installed rules, not from this run', () => {
    const x = world()
    install(x)
    const installed = loadGuardConfig(rulesFile(x), hookSha(x))
    writeFileSync(join(x.checkout, 'docs', 'protected-paths.txt'), 'apps/bridge/src/keys.ts\nmore\n')
    refresh(x)
    const now = loadGuardConfig(rulesFile(x), hookSha(x))
    expect(now.claudeHome).toBe(installed.claudeHome)
    expect(now.userHome).toBe(installed.userHome)
    expect(now.protectedPaths.at(-1)).toBe(installed.protectedPaths.at(-1) as string) // the kit's folder
  })
})

describe('R1-1: the checkout is the one installed; a session folder is never pinned', () => {
  test('another checkout (a copy in an agent folder, or a moved one) is refused: an install in Terminal moves it', () => {
    const x = world()
    install(x)
    const b = bytes(x)
    const files = ruleFiles(x)
    const agentCopy = join(x.w, 'agent', 'talos-app')
    cpSync(x.checkout, agentCopy, { recursive: true })
    writeFileSync(join(agentCopy, 'docs', 'protected-paths.txt'), '') // a gutted copy: protects nothing
    expect(refresh(x, { checkout: agentCopy })).toMatchObject({
      code: 1,
      line: `${REFRESH_LINE} refused checkout-moved`,
    })
    expect(bytes(x)).toEqual(b)
    expect(ruleFiles(x)).toEqual(files)
  })

  test('never pins a bun or a checkout inside the Talos home, nor one that is not there', () => {
    const x = world()
    install(x)
    const inHome = join(x.home, 'workers', 'bun')
    mkdirSync(join(inHome, '..'), { recursive: true })
    writeFileSync(inHome, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const b = bytes(x)
    expect(refresh(x, { bun: inHome }).line).toBe(`${REFRESH_LINE} refused unsafe`)
    expect(refresh(x, { bun: join(x.w, 'no-such-bun') }).line).toBe(`${REFRESH_LINE} refused no-bun`)
    expect(bytes(x)).toEqual(b)
  })
})

describe('the hook fails closed when it cannot start, and only then (R1-3)', () => {
  test('a gone bun or a gone cli.ts: a deny with the fixed reason; a working hook answers as before', () => {
    const x = world({ checkout: CHECKOUT })
    const old = cellarBun(x, '1.3.11')
    install(x, old)
    // working: an ordinary call passes, a guarded one is denied by the rules (exit 0 both)
    expect(runHookAsClaudeCode(x, ls(x))).toMatchObject({ code: 0, out: '' })
    const denied = runHookAsClaudeCode(x, writeToGuards(x))
    expect(denied.code).toBe(0)
    expect(JSON.parse(denied.out).hookSpecificOutput.permissionDecisionReason).toContain('never-change list')
    // brew upgrade bun: the old version's folder is removed
    rmSync(join(x.w, 'Cellar', 'bun', '1.3.11'), { recursive: true })
    for (const call of [ls(x), writeToGuards(x)]) {
      const r = runHookAsClaudeCode(x, call)
      expect(r.code).toBe(0)
      const o = JSON.parse(r.out).hookSpecificOutput
      expect(o).toEqual({
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: GUARD_HOOK_GONE_REASON,
      })
    }
    expect(GUARD_HOOK_GONE_REASON).toBe(
      "This session's guard hook can't start (its Bun moved). Talos is restarting the session; nothing is lost.",
    )
  })

  test('a gone cli.ts denies too; a hook that ran and failed for another reason behaves as before (no fallback)', () => {
    const x = world()
    // a "bun" that runs and exits 3 with nothing printed: a crash of the hook itself
    const crash = join(x.w, 'crash-bun')
    writeFileSync(crash, '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    install(x, crash)
    const r = runHookAsClaudeCode(x, ls(x))
    expect(r).toMatchObject({ code: 3, out: '' })
    // exit 2 from the hook stays exit 2 (Claude Code's own block), with no deny printed beside it
    writeFileSync(crash, '#!/bin/sh\necho blocked >&2\nexit 2\n', { mode: 0o755 })
    expect(runHookAsClaudeCode(x, ls(x))).toMatchObject({ code: 2, out: '' })
    rmSync(join(x.checkout, 'apps', 'bridge', 'src', 'cli.ts'))
    const gone = runHookAsClaudeCode(x, ls(x))
    expect(gone.code).toBe(0)
    expect(JSON.parse(gone.out).hookSpecificOutput.permissionDecisionReason).toBe(GUARD_HOOK_GONE_REASON)
  })

  test('the hook before the fallback (an install made before it) is still read as ours, and measured: a gone bun exits 127', () => {
    const x = world({ checkout: CHECKOUT })
    const old = cellarBun(x, '1.3.11')
    install(x, old)
    // the shape c28d7fbd's install wrote: no fallback, guards.json by name
    const cfg = buildGuardConfig({ home: x.home, checkout: x.checkout, claudeHome: x.claudeHome, userHome: x.userHome })
    const rules = `${JSON.stringify(cfg, null, 2)}\n`
    writeFileSync(join(x.guards, 'guards.json'), rules, { mode: 0o600 })
    const legacy = `${JSON.stringify(old)} ${JSON.stringify(join(x.checkout, 'apps', 'bridge', 'src', 'cli.ts'))} guard-hook --config ${JSON.stringify(join(x.home, 'guards', 'guards.json'))} --sha ${sha256(rules)}`
    const s = JSON.parse(readFileSync(x.settings, 'utf8'))
    s.hooks.PreToolUse[0].hooks[0].command = legacy
    writeFileSync(x.settings, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 })
    rmSync(join(x.w, 'Cellar', 'bun', '1.3.11'), { recursive: true })
    // what a session started under that hook gets now: Claude Code's non-blocking error (code.claude.com/docs/en/hooks)
    const gone = runHookAsClaudeCode(x, writeToGuards(x))
    expect(gone).toMatchObject({ code: 127, out: '' })
    // the shell's own words differ (macOS sh: "No such file or directory"; Linux dash: "…/bun: not found"); 127 is the fact
    expect(gone.err).toMatch(/No such file or directory|not found/)
    // the refresh reads it as ours and writes the new shape
    expect(refresh(x).line).toBe(`${REFRESH_LINE} changed bun settings`)
    expect(command(x)).toContain(`|| printf`)
    expect(decision(runHookAsClaudeCode(x, writeToGuards(x)).out)).toBe('deny')
  })
})

describe('R1-2/R1-4: content-addressed rules; a live session keeps its own', () => {
  test('rules go to guards-<sha>.json, written before the settings that name it; an existing one is never overwritten', () => {
    const x = world()
    install(x)
    expect(rulesFile(x)).toBe(join(x.home, 'guards', `guards-${hookSha(x)}.json`))
    expect(sha256(readFileSync(rulesFile(x)))).toBe(hookSha(x))
    expect(existsSync(join(x.guards, 'guards.json'))).toBe(false)
    // the next rules' file already there with other bytes: refused, nothing written over it
    writeFileSync(join(x.checkout, 'docs', 'protected-paths.txt'), 'apps/bridge/src/keys.ts\nnext\n')
    const cfg = loadGuardConfig(rulesFile(x), hookSha(x))
    const next = guardFiles(
      buildGuardConfig({
        home: x.home,
        checkout: x.checkout,
        claudeHome: cfg.claudeHome,
        userHome: cfg.userHome,
        kitDir: cfg.protectedPaths.at(-1),
      }),
      BUN,
      x.home,
    )
    const squatted = next.rulesFile
    writeFileSync(squatted, '{"planted":true}', { mode: 0o600 })
    const b = bytes(x)
    expect(refresh(x).line).toBe(`${REFRESH_LINE} refused damaged`)
    expect(readFileSync(squatted, 'utf8')).toBe('{"planted":true}')
    expect(bytes(x)).toEqual(b)
  })

  test('a live session on the old rules keeps working through a refresh; its file goes once nothing names it', () => {
    const x = world({ checkout: CHECKOUT })
    install(x)
    liveSession(x, 'trip') // trip started under the pair install wrote
    const current = rulesFile(x)
    const currentCmd = command(x)
    // garden started under an older pair (fewer rules): the pair an older release wrote
    const cfg = loadGuardConfig(current, hookSha(x))
    const aged = guardFiles({ ...cfg, writeDenied: cfg.writeDenied.slice(0, -1) }, BUN, x.home)
    writeFileSync(aged.rulesFile, aged.rules, { mode: 0o600 })
    writeFileSync(x.settings, aged.settings, { mode: 0o600 })
    liveSession(x, 'garden')
    const agedCmd = command(x)
    // the release's refresh: back to the rules this code builds
    expect(refresh(x).line).toBe(`${REFRESH_LINE} changed rules`)
    expect(rulesFile(x)).toBe(current)
    // both sessions' hooks still validate their own files: an ordinary call passes, a guarded one is denied
    for (const c of [agedCmd, currentCmd]) {
      expect(decision(runShell(c, ls(x), x.userHome).out)).toBe('allow')
      expect(decision(runShell(c, writeToGuards(x), x.userHome).out)).toBe('deny')
    }
    expect(existsSync(aged.rulesFile)).toBe(true)
    // garden restarts under the current pair: its old file is collected once nothing has named it for the grace
    liveSession(x, 'garden')
    expect(refresh(x).line).toBe(`${REFRESH_LINE} unchanged`)
    expect(existsSync(aged.rulesFile)).toBe(true)
    refreshLater(x)
    expect(existsSync(aged.rulesFile)).toBe(false)
    rmSync(join(x.home, 'workers'), { recursive: true })
    refresh(x)
    refreshLater(x)
    expect(ruleFiles(x)).toEqual([`guards-${hookSha(x)}.json`])
  })

  test("Main's own launch file keeps the rules it names", () => {
    const x = world()
    install(x)
    const first = rulesFile(x)
    writeFileSync(join(x.guards, 'main-launch.json'), readFileSync(x.settings))
    writeFileSync(join(x.checkout, 'docs', 'protected-paths.txt'), 'apps/bridge/src/keys.ts\nmain\n')
    expect(refresh(x).line).toBe(`${REFRESH_LINE} changed rules`)
    expect(existsSync(first)).toBe(true)
    writeFileSync(join(x.guards, 'main-launch.json'), readFileSync(x.settings))
    refresh(x)
    expect(existsSync(first)).toBe(true)
    refreshLater(x)
    expect(existsSync(first)).toBe(false)
  })

  test('a refresh killed between its two writes leaves a working pair: the old settings name old rules still there', () => {
    const x = world({ checkout: CHECKOUT })
    install(x)
    const cfg = loadGuardConfig(rulesFile(x), hookSha(x))
    // the state after the new rules' file was written and before settings.json: one more file, the old pair untouched
    const next = guardFiles({ ...cfg, writeDenied: [...cfg.writeDenied, '/x'] }, BUN, x.home)
    writeFileSync(next.rulesFile, next.rules, { mode: 0o600 })
    expect(decision(runHookAsClaudeCode(x, ls(x)).out)).toBe('allow')
    expect(decision(runHookAsClaudeCode(x, writeToGuards(x)).out)).toBe('deny')
    // the next refresh finishes; the stray file (named by nothing) is collected after the grace
    expect(refresh(x).line).toBe(`${REFRESH_LINE} unchanged`)
    refreshLater(x)
    expect(ruleFiles(x)).toEqual([`guards-${hookSha(x)}.json`])
  })

  test('an install made before content-addressing (guards.json) is moved to the new shape; guards.json stays while named', () => {
    const x = world()
    install(x)
    const cfg = loadGuardConfig(rulesFile(x), hookSha(x))
    const rules = `${JSON.stringify(cfg, null, 2)}\n`
    rmSync(rulesFile(x))
    writeFileSync(join(x.guards, 'guards.json'), rules, { mode: 0o600 })
    const legacy = `${JSON.stringify(BUN)} ${JSON.stringify(join(x.checkout, 'apps', 'bridge', 'src', 'cli.ts'))} guard-hook --config ${JSON.stringify(join(x.home, 'guards', 'guards.json'))} --sha ${sha256(rules)}`
    const s = JSON.parse(readFileSync(x.settings, 'utf8'))
    s.hooks.PreToolUse[0].hooks[0].command = legacy
    writeFileSync(x.settings, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 })
    liveSession(x, 'trip')
    expect(refresh(x).line).toBe(`${REFRESH_LINE} changed settings`)
    expect(rulesFile(x)).toContain(`guards-${sha256(rules)}.json`)
    expect(existsSync(join(x.guards, 'guards.json'))).toBe(true)
    rmSync(join(x.home, 'workers'), { recursive: true })
    refresh(x)
    refreshLater(x)
    expect(existsSync(join(x.guards, 'guards.json'))).toBe(false)
  })

  test('--remove takes every rules file with it', () => {
    const x = world()
    install(x)
    writeFileSync(join(x.guards, 'guards.json'), '{}')
    expect(
      runInstallGuards(
        { home: x.home, checkout: x.checkout, claudeHome: x.claudeHome, userHome: x.userHome },
        ['--remove'],
        quiet,
      ),
    ).toBe(0)
    expect(existsSync(x.guards)).toBe(false)
  })
})

describe('guards refresh: refusals write nothing and remove nothing', () => {
  const unchangedAfter = (x: World, fn: () => void) => {
    const b = bytes(x)
    fn()
    expect(bytes(x)).toEqual(b)
  }

  test('any argument is refused: there is no rule input and no --remove', () => {
    const x = world()
    install(x)
    for (const args of [['--remove'], ['--config', '/tmp/x.json'], ['x'], ['--checkout', '/tmp'], ['--']])
      unchangedAfter(x, () =>
        expect(refresh(x, { bun: cellarBun(x, '9.9.9'), args })).toMatchObject({
          code: 2,
          line: `${REFRESH_LINE} refused arguments`,
        }),
      )
  })

  test('an edited rules file is damaged: refused, never healed into what the edit says', () => {
    const x = world()
    install(x)
    const cfg = JSON.parse(readFileSync(rulesFile(x), 'utf8'))
    writeFileSync(
      rulesFile(x),
      `${JSON.stringify({ ...cfg, claudeHome: '/tmp/elsewhere', writeDenied: ['/nothing'] }, null, 2)}\n`,
    )
    unchangedAfter(x, () =>
      expect(refresh(x, { bun: cellarBun(x, '2.0.0') }).line).toBe(`${REFRESH_LINE} refused damaged`),
    )
    const f = rulesFile(x)
    rmSync(f)
    expect(refresh(x).line).toBe(`${REFRESH_LINE} refused damaged`)
    expect(existsSync(f)).toBe(false)
  })

  test('R1-5: rules that do not say where the kit is are refused, whatever the environment says', () => {
    const x = world()
    install(x)
    const cfg = loadGuardConfig(rulesFile(x), hookSha(x))
    // vouched rules whose protected list ends inside the checkout: the kit's folder cannot be told from them
    const noKit = { ...cfg, protectedPaths: cfg.protectedPaths.slice(0, -1) }
    const f = guardFiles(noKit, BUN, x.home)
    writeFileSync(f.rulesFile, f.rules, { mode: 0o600 })
    writeFileSync(x.settings, f.settings, { mode: 0o600 })
    const saved = { ...process.env }
    try {
      process.env.TALOS_KIT_HOME = join(x.w, 'hostile-kit')
      process.env.TALOS_VENDOR_DIR = join(x.w, 'hostile-vendor')
      unchangedAfter(x, () =>
        expect(refresh(x, { bun: cellarBun(x, '6.0.0') }).line).toBe(`${REFRESH_LINE} refused damaged`),
      )
    } finally {
      for (const k of ['TALOS_KIT_HOME', 'TALOS_VENDOR_DIR']) if (saved[k] === undefined) delete process.env[k]
    }
  })

  test('a settings file that is not the one install writes is not ours', () => {
    const x = world()
    install(x)
    const real = readFileSync(x.settings, 'utf8')
    for (const text of [
      'not json',
      '{}',
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
      }),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            JSON.parse(real).hooks.PreToolUse[0],
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] },
          ],
        },
      }),
    ]) {
      writeFileSync(x.settings, text)
      expect(refresh(x).line).toBe(`${REFRESH_LINE} refused not-ours`)
      expect(readFileSync(x.settings, 'utf8')).toBe(text)
    }
    // a hook whose --config names a file outside the guards folder
    writeFileSync(x.settings, real.replaceAll(JSON.stringify(join(x.home, 'guards')).slice(1, -1), join(x.w, 'g')))
    expect(refresh(x).line).toBe(`${REFRESH_LINE} refused not-ours`)
  })

  test('guards made for another Talos home are refused there', () => {
    const a = world()
    const b = world()
    install(a)
    mkdirSync(b.guards, { mode: 0o700 })
    const name = rulesFile(a).split('/').at(-1) as string
    writeFileSync(join(b.guards, name), readFileSync(rulesFile(a)), { mode: 0o600 })
    writeFileSync(b.settings, readFileSync(a.settings, 'utf8').replaceAll(a.home, b.home), { mode: 0o600 })
    expect(refresh(b).line).toBe(`${REFRESH_LINE} refused other-home`)
  })

  test('a symlinked guards folder or file is never followed out of the home', () => {
    const x = world()
    install(x)
    const outside = join(x.w, 'outside')
    renameSync(x.guards, outside)
    symlinkSync(outside, x.guards)
    const before = readdirSync(outside).map((f) => stamp(join(outside, f)))
    expect(refresh(x, { bun: cellarBun(x, '3.0.0') }).line).toBe(`${REFRESH_LINE} refused unsafe`)
    expect(readdirSync(outside).map((f) => stamp(join(outside, f)))).toEqual(before)
    rmSync(x.guards)
    renameSync(outside, x.guards)
    const target = join(x.w, 'target.json')
    writeFileSync(target, readFileSync(x.settings))
    rmSync(x.settings)
    symlinkSync(target, x.settings)
    const t = stamp(target)
    expect(refresh(x, { bun: cellarBun(x, '3.0.1') }).line).toBe(`${REFRESH_LINE} refused unsafe`)
    expect(stamp(target)).toBe(t)
    rmSync(x.settings)
    writeFileSync(x.settings, readFileSync(target), { mode: 0o600 })
    linkSync(rulesFile(x), join(x.w, 'hard.json'))
    expect(refresh(x, { bun: cellarBun(x, '3.0.2') }).line).toBe(`${REFRESH_LINE} refused unsafe`)
    rmSync(join(x.w, 'hard.json'))
    chmodSync(x.guards, 0o777)
    expect(refresh(x, { bun: cellarBun(x, '3.0.3') }).line).toBe(`${REFRESH_LINE} refused unsafe`)
    chmodSync(x.guards, 0o700)
    expect(refresh(x, { bun: cellarBun(x, '3.0.4') }).line).toBe(`${REFRESH_LINE} changed bun`)
  })

  test('the output names what changed and never a rule', () => {
    const x = world()
    install(x)
    const cfg = JSON.parse(readFileSync(rulesFile(x), 'utf8'))
    writeFileSync(join(x.checkout, 'docs', 'protected-paths.txt'), 'apps/bridge/src/keys.ts\nz\n')
    for (const r of [refresh(x, { bun: cellarBun(x, '4.0.0') }), refresh(x, { args: ['x'] }), refresh(world())]) {
      expect(r.line).toMatch(LINE)
      for (const p of [...cfg.writeDenied, ...cfg.protectedPaths]) {
        expect(r.line).not.toContain(p)
        expect(r.err).not.toContain(p)
      }
    }
  })
})

describe('guards refresh: twice at once', () => {
  test('R1-6: a lock left by a refresh that died, or by a pid since reused, is taken over; a live holder means busy', () => {
    const x = world()
    install(x)
    const lock = join(x.guards, '.refresh.lock')
    const me = `${process.pid} ${processStartTime(process.pid)}`
    writeFileSync(lock, me) // held: this very process, by its start time
    expect(refresh(x, { bun: cellarBun(x, '5.0.0') }).line).toBe(`${REFRESH_LINE} refused busy`)
    writeFileSync(lock, `${process.pid} Thu Jan  1 00:00:00 1970`) // this pid, another start: the holder is gone, the pid reused
    expect(refresh(x, { bun: cellarBun(x, '5.0.1') }).line).toBe(`${REFRESH_LINE} changed bun`)
    const dead = Bun.spawnSync(['/bin/sh', '-c', 'echo $$']).stdout.toString().trim()
    writeFileSync(lock, dead) // the format before start times: a pid alone is never taken for a live holder
    expect(refresh(x, { bun: cellarBun(x, '5.0.2') }).line).toBe(`${REFRESH_LINE} changed bun`)
    writeFileSync(lock, String(process.pid))
    expect(refresh(x, { bun: cellarBun(x, '5.0.3') }).line).toBe(`${REFRESH_LINE} changed bun`)
    expect(existsSync(lock)).toBe(false)
  })

  test('two real refreshes at once: both end well and the pair is whole', async () => {
    const x = world({ checkout: CHECKOUT })
    install(x, cellarBun(x, '0.9.0'))
    const env = { PATH: '/usr/bin:/bin', HOME: x.userHome, TALOS_APP_HOME: x.home }
    const run = () => Bun.spawn([BUN, CLI, 'guards', 'refresh'], { env, stdout: 'pipe', stderr: 'pipe' })
    const ps = [run(), run(), run()]
    const outs = await Promise.all(
      ps.map(async (p) => ({ out: (await new Response(p.stdout).text()).trim(), code: await p.exited })),
    )
    for (const o of outs) expect(o.out).toMatch(LINE)
    expect(outs.filter((o) => o.out === `${REFRESH_LINE} changed bun`).length).toBeGreaterThanOrEqual(1)
    for (const o of outs)
      expect([`${REFRESH_LINE} changed bun`, `${REFRESH_LINE} unchanged`, `${REFRESH_LINE} refused busy`]).toContain(
        o.out,
      )
    expect(() => loadGuardConfig(rulesFile(x), hookSha(x))).not.toThrow()
    expect(command(x)).toContain(`exec ${JSON.stringify(BUN)} `)
  })
})

describe('guards refresh through the real CLI: no rule input from the environment, the argv or the agent folder', () => {
  test('hostile variables, a planted agent folder and extra words change nothing it writes', () => {
    const x = world({ checkout: CHECKOUT })
    install(x)
    const agent = join(x.w, 'agent')
    mkdirSync(join(agent, 'docs'), { recursive: true })
    mkdirSync(join(agent, '.claude'), { recursive: true })
    writeFileSync(join(agent, 'docs', 'protected-paths.txt'), '')
    writeFileSync(join(agent, 'guards.json'), '{}')
    writeFileSync(join(agent, '.claude', 'settings.json'), '{"permissions":{"deny":[]}}')
    writeFileSync(join(agent, '.mcp.json'), '{"mcpServers":{}}')
    const b = bytes(x)
    const run = (extra: Record<string, string>, args: string[] = []) => {
      const p = Bun.spawnSync([BUN, CLI, 'guards', 'refresh', ...args], {
        cwd: agent,
        env: { PATH: '/usr/bin:/bin', HOME: x.userHome, TALOS_APP_HOME: x.home, ...extra },
      })
      return { code: p.exitCode, out: p.stdout.toString().trim() }
    }
    expect(run({})).toEqual({ code: 0, out: `${REFRESH_LINE} unchanged` })
    const hostile = {
      CLAUDE_CONFIG_DIR: join(x.w, 'fake-claude'),
      TALOS_KIT_HOME: join(x.w, 'fake-kit'),
      TALOS_VENDOR_DIR: join(x.w, 'fake-vendor'),
      XDG_DATA_HOME: join(x.w, 'fake-xdg'),
      HOME: join(x.w, 'fake-home'),
      USERPROFILE: join(x.w, 'fake-home'),
    }
    expect(run(hostile)).toEqual({ code: 0, out: `${REFRESH_LINE} unchanged` })
    expect(bytes(x)).toEqual(b)
    for (const args of [['--remove'], ['--checkout', agent], [agent]]) {
      expect(run(hostile, args)).toEqual({ code: 2, out: `${REFRESH_LINE} refused arguments` })
      expect(bytes(x)).toEqual(b)
    }
    const w = Bun.spawnSync([BUN, CLI, 'guards', 'refresh'], {
      cwd: agent,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: x.userHome,
        TALOS_APP_HOME: x.home,
        TALOS_SESSION_ROLE: 'worker',
        TALOS_APP_WORKER_THREAD: 't',
      },
    })
    expect(w.exitCode).toBe(1)
    expect(w.stdout.toString()).toBe('')
    expect(refusedForWorkers(['guards', 'refresh'])).toBe(true)
  })

  test('a session cannot spell it: the hook and the deny rules keep it to the app', () => {
    const x = world({ checkout: CHECKOUT })
    install(x)
    const cfg = loadGuardConfig(rulesFile(x), hookSha(x))
    for (const cmd of [
      'talos-app guards refresh',
      'TALOS_APP_HOME=/tmp/x talos-app guards refresh',
      `bun ${CLI} guards refresh`,
      `bun run ${CLI} guards refresh`,
      'bash -c "talos-app guards refresh"',
      'echo $(talos-app guards refresh)',
    ]) {
      const d = guardDecision({ tool_name: 'Bash', tool_input: { command: cmd } }, cfg)
      expect(d?.deny, cmd).toContain('run by the Talos app at each start of Main')
    }
    expect(
      guardDecision({ tool_name: 'Bash', tool_input: { command: 'grep -rn "guards refresh" docs' } }, cfg),
    ).toBeUndefined()
    expect(JSON.parse(readFileSync(x.settings, 'utf8')).permissions.deny).toContain('Bash(talos-app guards:*)')
  })
})

describe('Fable R2', () => {
  /** The thread settings fixture, written by Swift's JSONSerialization as WorkerSpec writes it (slashes escaped), for this home. */
  const swiftThreadSettings = (x: World, sha: string) =>
    readFileSync(join(import.meta.dir, 'fixtures', 'guards', 'thread-settings-swift.bytes'), 'utf8')
      .replaceAll('\\/home\\/alex\\/.config\\/talos', x.home.replaceAll('/', '\\/'))
      .replaceAll('a'.repeat(64), sha)

  test('R2-1: a thread settings file as the Mac writes it (escaped slashes) keeps the rules file its hook names', () => {
    const x = world()
    install(x)
    const fixture = readFileSync(join(import.meta.dir, 'fixtures', 'guards', 'thread-settings-swift.bytes'), 'utf8')
    expect(fixture).toContain('\\/guards\\/guards-') // what the Swift encoder really writes
    const oldSha = 'b'.repeat(64)
    const oldFile = join(x.guards, `guards-${oldSha}.json`)
    writeFileSync(oldFile, '{}', { mode: 0o600 })
    mkdirSync(join(x.home, 'workers', 'trip'), { recursive: true })
    writeFileSync(join(x.home, 'workers', 'trip', 'settings.json'), swiftThreadSettings(x, oldSha))
    refresh(x)
    refreshLater(x)
    expect(existsSync(oldFile)).toBe(true)
    // trip gone: collected after the grace
    rmSync(join(x.home, 'workers', 'trip'), { recursive: true })
    refresh(x)
    refreshLater(x)
    expect(existsSync(oldFile)).toBe(false)
  })

  test('R2-1: a settings file that cannot be read as JSON means nothing is collected', () => {
    const x = world()
    install(x)
    const stray = join(x.guards, `guards-${'c'.repeat(64)}.json`)
    writeFileSync(stray, '{}', { mode: 0o600 })
    mkdirSync(join(x.home, 'workers', 'trip'), { recursive: true })
    writeFileSync(join(x.home, 'workers', 'trip', 'settings.json'), '{"hooks": half written')
    refresh(x)
    refreshLater(x)
    expect(existsSync(stray)).toBe(true)
    rmSync(join(x.home, 'workers', 'trip', 'settings.json'))
    refresh(x)
    refreshLater(x)
    expect(existsSync(stray)).toBe(false)
  })

  test('Attack-4: a thread that read the old settings just before a refresh switched them still finds its rules file', () => {
    const x = world()
    install(x)
    const before = readFileSync(x.settings) // a thread start reads the guards here...
    const oldFile = rulesFile(x)
    writeFileSync(join(x.checkout, 'docs', 'protected-paths.txt'), 'apps/bridge/src/keys.ts\nrace\n')
    expect(refresh(x).line).toBe(`${REFRESH_LINE} changed rules`) // ...a refresh switches them...
    expect(existsSync(oldFile)).toBe(true)
    // ...and the thread's own settings file lands a moment later, naming the old file: within the grace, so it is still there
    mkdirSync(join(x.home, 'workers', 'trip'), { recursive: true })
    writeFileSync(join(x.home, 'workers', 'trip', 'settings.json'), before)
    refresh(x, { now: Date.now() + 60_000 })
    refreshLater(x)
    expect(existsSync(oldFile)).toBe(true)
    // a file nothing names is kept for the grace, then collected
    rmSync(join(x.home, 'workers'), { recursive: true })
    refresh(x, { now: Date.now() + COLLECT_GRACE_MS + 120_000 })
    expect(existsSync(oldFile)).toBe(true)
    refresh(x, { now: Date.now() + 2 * COLLECT_GRACE_MS + 240_000 })
    expect(existsSync(oldFile)).toBe(false)
    expect(COLLECT_GRACE_MS).toBeGreaterThanOrEqual(10 * 60_000)
  })

  test('R2-2: a pinned bun that is a folder, or a file that cannot run, gets the deny too', () => {
    const x = world()
    const asFolder = join(x.w, 'Cellar', 'bun', 'dir', 'bin', 'bun')
    mkdirSync(asFolder, { recursive: true })
    install(x, asFolder)
    expect(JSON.parse(runHookAsClaudeCode(x, ls(x)).out).hookSpecificOutput.permissionDecisionReason).toBe(
      GUARD_HOOK_GONE_REASON,
    )
    const notRunnable = join(x.w, 'plain-bun')
    writeFileSync(notRunnable, 'not a program', { mode: 0o644 })
    install(x, notRunnable)
    const r = runHookAsClaudeCode(x, ls(x))
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason).toBe(GUARD_HOOK_GONE_REASON)
  })

  test('a path with $ or a backtick in it is refused by install and the refresh: the hook quotes them for a shell', () => {
    const x = world()
    const odd = join(x.w, 'co$HOME')
    cpSync(x.checkout, odd, { recursive: true })
    const c = capture()
    expect(
      runInstallGuards({ home: x.home, checkout: odd, claudeHome: x.claudeHome, userHome: x.userHome }, [], c.io),
    ).toBe(1)
    expect(c.err.join('\n')).toContain('$')
    expect(existsSync(x.settings)).toBe(false)
    install(x)
    const b = bytes(x)
    const tick = join(x.w, 'b`id`')
    mkdirSync(tick, { recursive: true })
    const bun = join(tick, 'bun')
    writeFileSync(bun, '#!/bin/sh\n', { mode: 0o755 })
    expect(refresh(x, { bun }).line).toBe(`${REFRESH_LINE} refused unsafe`)
    expect(bytes(x)).toEqual(b)
  })
})
