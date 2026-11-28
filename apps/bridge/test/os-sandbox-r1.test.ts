// Review round 1 of the OS sandbox: the sandbox keys a settings file may carry (an allow-list), what a hook's script loads and where it
// may sit, and a config.json that cannot be read (the lock stays on). Temp folders only.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainLaunchArgs } from '../src/guards/main-launch.ts'
import {
  OS_SANDBOX_DENY_WRITE,
  osSandboxSettings,
  prepareOsSandbox,
  readOsSandboxSwitch,
  SWITCH_RECORD,
} from '../src/guards/os-sandbox.ts'
import { HOME_WRITE_DENIED } from '../src/guards/rules.ts'
import { noticeFor } from '../src/supervisor/notices.ts'
import { mainArgsWithGuards } from '../src/supervisor/worker-policy.ts'

const dirs: string[] = []
const after: Array<() => void> = []
const afterThis = (f: () => void) => after.push(f)
afterEach(() => {
  for (const f of after.splice(0).reverse()) f() // last set, first undone: the oldest value is the one that stays
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p = 'tr1-') => {
  const d = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), p)))
  dirs.push(d)
  return d
}
const put = (p: string, text = '') => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}
/** A home, a user home with a Claude folder, and a session folder; `settings` goes in the folder's project settings. */
function world(over: { project?: object; user?: object; local?: object } = {}) {
  const home = tmp('tr1-home-')
  put(join(home, 'config.json'), '{}')
  const userHome = tmp('tr1-user-')
  const claudeDir = join(userHome, '.claude')
  const folder = tmp('tr1-folder-')
  if (over.user) put(join(claudeDir, 'settings.json'), JSON.stringify(over.user))
  if (over.project) put(join(folder, '.claude', 'settings.json'), JSON.stringify(over.project))
  if (over.local) put(join(folder, '.claude', 'settings.local.json'), JSON.stringify(over.local))
  const start = () =>
    prepareOsSandbox(
      { talosHome: home, userHome, folder, claudeDir, writableRoots: [] },
      { ownerExcludes: () => [], write: () => {} },
    )
  return { home, userHome, claudeDir, folder, start }
}
const refusal = (r: ReturnType<ReturnType<typeof world>['start']>) => ('refusal' in r ? r.refusal : null)
const hookOf = (command: string) => ({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } })

describe('R1-1: only a short list of sandbox keys may be set in a settings file the session loads', () => {
  const BAD: Array<[string, unknown]> = [
    ['allowAppleEvents', true],
    ['allowUnixSockets', ['/x']],
    ['allowAllUnixSockets', true],
    ['allowMachLookup', ['x']],
    ['enableWeakerNetworkIsolation', true],
    ['enableWeakerNestedSandbox', true],
    ['allowNestedUserNamespaces', true],
    ['credentials', {}],
    ['network', { allowedDomains: ['x'] }],
    ['proxy', {}],
    ['tls', {}],
    ['ripgrep', { command: 'x' }],
    ['excludedCommands', ['git']],
    ['filesystem', { allowWrite: ['/'] }],
    ['autoAllowBashIfSandboxed', true],
    ['allowUnsandboxedCommands', true],
    ['enabled', false],
    ['failIfUnavailable', false],
    ['someFutureKey', 1],
  ]
  for (const level of ['user', 'project', 'local'] as const)
    for (const [key, value] of BAD)
      test(`${level} settings with sandbox.${key} refuse the start, naming the file and the key`, () => {
        const w = world({ [level]: { sandbox: { [key]: value } } })
        const line = refusal(w.start())
        expect(line, key).toContain(`sets sandbox.${key},`)
        expect(line).toContain(
          level === 'user'
            ? join(w.claudeDir, 'settings.json')
            : join(w.folder, '.claude', `settings${level === 'local' ? '.local' : ''}.json`),
        )
      })
  test('the harmless keys start: ignoreViolations, enabled true, failIfUnavailable true', () => {
    for (const level of ['user', 'project', 'local'] as const) {
      const w = world({
        [level]: {
          sandbox: {
            autoAllowBashIfSandboxed: false,
            ignoreViolations: { '*': ['/x'] },
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
          },
        },
      })
      expect(refusal(w.start()), level).toBeNull()
    }
  })
  test('our own block turns the Apple-events and weaker-network switches off', () => {
    const w = world()
    const p = osSandboxSettings({ talosHome: w.home, userHome: w.userHome, folder: w.folder, platform: 'linux' })
    expect(p.sandbox).toMatchObject({
      allowAppleEvents: false,
      enableWeakerNetworkIsolation: false,
      autoAllowBashIfSandboxed: false,
    })
  })
})

describe('R1-5: a config.json that cannot be read keeps the last known state of the extra lock, and off when there is none', () => {
  const home = (text: string | null) => {
    const h = tmp('tr1-cfg-')
    if (text !== null) writeFileSync(join(h, 'config.json'), text)
    return h
  }
  const UNREADABLE = ['{ nope', '', 'null', '[]']
  const lineOf = (v: boolean) => `{"os_sandbox": ${v}}`
  const told = (h: string) => {
    const calls: Array<[string, boolean]> = []
    const on = readOsSandboxSwitch(h, undefined, (why, kept) => calls.push([why, kept]))
    return { on, calls }
  }
  test('absent file or absent key is off; os_sandbox true is on', () => {
    expect(readOsSandboxSwitch(home(null))).toBe(false)
    expect(readOsSandboxSwitch(home('{}'))).toBe(false)
    expect(readOsSandboxSwitch(home('{"os_sandbox": false}'))).toBe(false)
    expect(readOsSandboxSwitch(home('{"os_sandbox": true}'))).toBe(true)
  })
  test('never on before: corrupt, empty, not-an-object or unreadable is OFF, and the caller is told why once', () => {
    for (const text of UNREADABLE) {
      const r = told(home(text))
      expect(r.on, text).toBe(false)
      expect(r.calls.length, text).toBe(1)
      expect(r.calls[0]?.[1], text).toBe(false)
    }
    const dirAsFile = tmp('tr1-cfg-')
    mkdirSync(join(dirAsFile, 'config.json'))
    const r = told(dirAsFile)
    expect(r.on).toBe(false)
    expect(r.calls.length).toBe(1)
  })
  test('it was on at the last good reading: every kind of damage keeps it on, and says so', () => {
    for (const text of UNREADABLE) {
      const h = home(lineOf(true))
      expect(readOsSandboxSwitch(h)).toBe(true) // the good reading
      writeFileSync(join(h, 'config.json'), text)
      const r = told(h)
      expect(r.on, text).toBe(true)
      expect(
        r.calls.map((c) => c[1]),
        text,
      ).toEqual([true])
    }
  })
  test('it was off at the last good reading: damage keeps it off; turning it on and off again moves the record each time', () => {
    const h = home(lineOf(true))
    expect(readOsSandboxSwitch(h)).toBe(true)
    writeFileSync(join(h, 'config.json'), lineOf(false))
    expect(readOsSandboxSwitch(h)).toBe(false) // the owner turned it off: that is the state now
    writeFileSync(join(h, 'config.json'), '{ nope')
    expect(told(h)).toEqual({ on: false, calls: [[expect.any(String), false]] })
    writeFileSync(join(h, 'config.json'), lineOf(true))
    expect(readOsSandboxSwitch(h)).toBe(true)
    writeFileSync(join(h, 'config.json'), '')
    expect(told(h).on).toBe(true)
  })
  test('a missing record, or one that says anything but on, is no record: off', () => {
    const h = home('{ nope')
    for (const bytes of [null, 'ON-ish', '', 'true', 'yes']) {
      if (bytes !== null) put(join(h, SWITCH_RECORD), bytes)
      expect(told(h).on, String(bytes)).toBe(false)
    }
  })
  test('the record sits under a name the sandbox and the guards keep sessions from writing, and the sandbox’s own deny list covers it', () => {
    const rel = SWITCH_RECORD.split('/')[0] as string
    expect(OS_SANDBOX_DENY_WRITE).toContain(rel)
    expect(HOME_WRITE_DENIED).toContain(rel as never)
    const w = world()
    writeFileSync(join(w.home, 'config.json'), lineOf(true))
    readOsSandboxSwitch(w.home)
    const pieces = osSandboxSettings({
      talosHome: w.home,
      userHome: w.userHome,
      folder: w.folder,
      platform: 'linux',
      trusted: null,
    })
    const deny = pieces.sandbox.filesystem.denyWrite
    expect(existsSync(join(w.home, SWITCH_RECORD))).toBe(true)
    expect(deny.some((d) => join(w.home, SWITCH_RECORD).startsWith(`${d}/`))).toBe(true)
    expect(pieces.sandbox.filesystem.allowWrite).toEqual([]) // and nothing in the home is writable from a session
  })
  test('a read that fails because the home is not there writes nothing and makes no folder', () => {
    const gone = join(tmp('tr1-cfg-'), 'never-made')
    expect(readOsSandboxSwitch(gone, () => '{"os_sandbox": true}')).toBe(true)
    expect(existsSync(gone)).toBe(false)
  })
  test('Main’s launch with a corrupt config.json and the lock on before: carries the sandbox, and says so', () => {
    const h = home(lineOf(true))
    const folder = tmp('tr1-folder-')
    mainLaunchArgs(['--x'], h, { cwd: folder }) // the good launch
    writeFileSync(join(h, 'config.json'), '{ nope')
    const r = mainLaunchArgs(['--x'], h, { cwd: folder })
    expect(r.refusal).toBeUndefined()
    expect(JSON.parse(r.args[r.args.indexOf('--settings') + 1] as string).sandbox.enabled).toBe(true)
    expect(r.note).toBe("Talos couldn't read its settings, so the extra lock stays on")
  })
  test('Main’s launch with a corrupt config.json and no earlier state: no sandbox, and no word about the lock', () => {
    const r = mainLaunchArgs(['--x'], home('{ nope'), { cwd: tmp('tr1-folder-') })
    expect(r.refusal).toBeUndefined()
    expect(r.note).toBeUndefined()
    expect(r.args.join(' ')).not.toContain('"sandbox"')
  })
  test('an absent key starts Main without the sandbox and without a note', () => {
    const r = mainLaunchArgs(['--x'], home('{}'), { cwd: tmp('tr1-folder-') })
    expect(r.note).toBeUndefined()
    expect(r.args.join(' ')).not.toContain('"sandbox"')
  })
  test('the supervisor audits it either way, and tells the owner only when the lock was kept on', () => {
    const h = home(lineOf(true))
    const folder = tmp('tr1-folder-')
    mainArgsWithGuards(['--x'], h, folder, { audit: () => {}, tell: () => {} })
    writeFileSync(join(h, 'config.json'), '{ nope')
    const audit: string[] = []
    const told: unknown[] = []
    mainArgsWithGuards(['--x'], h, folder, { audit: (e) => audit.push(e), tell: (e) => told.push(e) })
    expect(audit).toContain('os_sandbox_config_unreadable')
    expect(told).toEqual([{ kind: 'lock_note', text: "Talos couldn't read its settings, so the extra lock stays on" }])
    expect(noticeFor(told[0] as never, null, '10:00', 'view')).toMatchObject({
      body: "Talos couldn't read its settings, so the extra lock stays on",
      phone: null,
    })
    // never on: the audit line is there for whoever looks, and the owner hears nothing about a lock he never asked for
    const off: string[] = []
    const offTold: unknown[] = []
    mainArgsWithGuards(['--x'], home('{ nope'), tmp('tr1-folder-'), {
      audit: (e) => off.push(e),
      tell: (e) => offTold.push(e),
    })
    expect(off).toContain('os_sandbox_config_unreadable')
    expect(offTold).toEqual([])
    const quiet: unknown[] = []
    mainArgsWithGuards(['--x'], home('{}'), tmp('tr1-folder-'), { audit: () => {}, tell: (e) => quiet.push(e) })
    expect(quiet).toEqual([])
  })
})
