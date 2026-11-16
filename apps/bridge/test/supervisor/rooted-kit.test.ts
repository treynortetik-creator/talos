// The kit root keeps (supervisor/rooted-kit.ts, Fable R1-2 tier 1): on a box with /etc/talos only root's kit is used, checked
// against root's own record of it; anything else fails closed, in words the Windows user follows. "root" is this test's own uid
// (ROOTED_KIT points at the test's folders); the real-root case is that a file this user owns is never root's.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { realFileSync } from '../../src/real-file.ts'
import {
  KIT_MARKETPLACE,
  kitAnchor,
  MANAGED_SETTINGS,
  managedProblem,
  marketplaceProblem,
  ROOTED_KIT,
} from '../../src/supervisor/rooted-kit.ts'
import { releaseContentSha, releaseHook, releaseOwnerOk } from '../../src/supervisor/worker-hook.ts'
import {
  HOOK_CLEAN_LINE_ROOTED,
  permissionHookCommand,
  rootedHookOnly,
  WorkerSpecRefused,
} from '../../src/supervisor/worker-spec.ts'
import { cleanupReleases, seal, sealedRelease, unseal } from './kit-release-fixture.ts'

afterAll(cleanupReleases)
const ME = process.getuid?.() ?? 0
const saved = { ...ROOTED_KIT }
const dirs: string[] = []
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-rooted-kit-')))
  dirs.push(d)
  return d
}
// a box that is no Talos distro: no marker folder at all
beforeEach(() =>
  Object.assign(ROOTED_KIT, {
    marker: join(tmp(), 'no-talos-wsl', 'marker'),
    etc: join(tmp(), 'no-etc-talos'),
    root: ME,
  }),
)
afterEach(() => {
  Object.assign(ROOTED_KIT, saved)
  for (const d of dirs.splice(0)) {
    try {
      unseal(d) // a sealed release built in the test's own folder
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

/** Root's kit's marketplace manifest, as kit-update lays it: the fixed bytes, read-only, in a 0755 folder. */
function writeMarketplace(vendor: string) {
  const dir = join(vendor, '.claude-plugin')
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  chmodSync(dir, 0o755)
  rmSync(join(dir, 'marketplace.json'), { force: true }) // read-only: replaced, never written over
  writeFileSync(join(dir, 'marketplace.json'), KIT_MARKETPLACE)
  chmodSync(join(dir, 'marketplace.json'), 0o444)
}

/** A box root set up: /etc/talos (0755) with kit-release, and root's kit (a sealed release) as ROOTED_KIT.vendor. */
function rootedBox(o: { record?: Record<string, unknown> | string | null; vendor?: string; etc?: boolean } = {}) {
  const box = tmp()
  // the Talos distro's marker root writes at install (/etc/talos-wsl/marker): what makes this box root's
  mkdirSync(join(box, 'talos-wsl'), { mode: 0o755 })
  chmodSync(join(box, 'talos-wsl'), 0o755)
  const marker = join(box, 'talos-wsl', 'marker')
  writeFileSync(marker, 'talos\n')
  chmodSync(marker, 0o644)
  const etc = join(box, 'etc-talos')
  if (o.etc !== false) {
    mkdirSync(etc, { mode: 0o755 })
    chmodSync(etc, 0o755)
  }
  // root's kit one level down in the box: its parent is the test's own folder, never the system temp folder (Fable R2-2)
  const vendor = o.vendor ?? sealedRelease({ fresh: true, under: box })
  const plugin = join(vendor, 'current', 'talos-kit')
  const record =
    o.record === undefined ? { v: 1, version: '9.9.9-test', content_sha256: releaseContentSha(plugin) } : o.record
  if (record !== null && o.etc !== false) {
    writeFileSync(join(etc, 'kit-release'), typeof record === 'string' ? record : JSON.stringify(record))
    chmodSync(join(etc, 'kit-release'), 0o644)
  }
  // root's kit's marketplace manifest, the fixed bytes kit-update writes
  writeMarketplace(vendor)
  // root's Claude Code policy (A'): exactly the bytes kit-update writes
  const managed = join(box, 'claude-code', 'managed-settings.json')
  mkdirSync(dirname(managed), { mode: 0o755 })
  chmodSync(dirname(managed), 0o755)
  writeFileSync(managed, MANAGED_SETTINGS)
  chmodSync(managed, 0o644)
  Object.assign(ROOTED_KIT, { marker, etc, vendor, root: ME, managed })
  return { etc, vendor, plugin, marker, managed }
}

describe('which kit: a box that is no Talos distro is unchanged, a Talos distro uses only root’s', () => {
  it('no marker: the home kit, as before', () => {
    expect(kitAnchor()).toEqual({ mode: 'home' })
    expect(releaseHook(sealedRelease())).toHaveProperty('source')
  })
  it('a plain Linux box with /etc/talos (made for launch-approved) and no marker: still the home kit (Fable R1-1)', () => {
    const etc = join(tmp(), 'etc-talos')
    mkdirSync(etc, { mode: 0o755 })
    Object.assign(ROOTED_KIT, { etc })
    expect(kitAnchor()).toEqual({ mode: 'home' })
  })
  it('the marker but no /etc/talos yet (no launch approved yet): refused, never the home kit (Fable R1-2)', () => {
    rootedBox({ etc: false })
    const r = releaseHook(sealedRelease())
    expect('problem' in r ? r.problem : JSON.stringify(r)).toContain('not installed for this PC yet')
  })
  // each case changes only the marker, and the refusal names the marker: nothing after it could be what refused (Fable R2-5)
  const markerRefused = (b: { marker: string }) => {
    const r = kitAnchor()
    expect('refused' in r ? r.refused : JSON.stringify(r)).toContain(`${b.marker} is not root's own`)
  }
  it('a marker that is not root’s plain file: refused', () => {
    const b = rootedBox()
    expect(kitAnchor()).toHaveProperty('mode', 'rooted')
    rmSync(b.marker)
    symlinkSync(join(b.etc, 'kit-release'), b.marker)
    markerRefused(b)
    rmSync(b.marker)
    mkdirSync(b.marker)
    markerRefused(b)
    rmSync(b.marker, { recursive: true })
    writeFileSync(b.marker, 'talos\n')
    chmodSync(b.marker, 0o666)
    markerRefused(b)
  })
  it('the marker’s folder there without a good marker, or not root’s: refused, never the home kit (Fable R2-4)', () => {
    const b = rootedBox()
    rmSync(b.marker)
    expect(kitAnchor()).toHaveProperty('refused')
    writeFileSync(b.marker, 'talos\n')
    chmodSync(dirname(b.marker), 0o777)
    const r = kitAnchor()
    expect('refused' in r ? r.refused : '').toContain("talos-wsl is not root's own folder")
    chmodSync(dirname(b.marker), 0o755)
    expect(kitAnchor()).toHaveProperty('mode', 'rooted')
  })
  it('root’s kit and record: the hook comes from root’s kit, whatever vendor the caller names', () => {
    const b = rootedBox()
    const other = sealedRelease({ fresh: true }) // the home kit, also sealed and fine: never used here
    const r = releaseHook(other)
    expect(r).toHaveProperty('source')
    expect((r as { source: string }).source.startsWith(realpathSync(b.vendor))).toBe(true)
  })
})

describe('fails closed, with the words the Windows user follows', () => {
  // the problem read as text first (Bun's toMatchObject with an asymmetric matcher rewrites the property it checks)
  const refused = (r: ReturnType<typeof releaseHook>, words: string) => {
    const problem = 'problem' in r ? r.problem : `no problem: ${JSON.stringify(r)}`
    expect(problem).toContain(words)
    // the words a Windows user with no terminal follows
    expect(problem).toContain('choose "Update the kit"')
  }
  it('no record yet: refused, never the home kit', () => {
    rootedBox({ record: null })
    refused(releaseHook(sealedRelease()), 'not installed for this PC yet')
  })
  it('a record whose digest does not match root’s kit (the kit changed after root sealed it)', () => {
    rootedBox({ record: { v: 1, version: '9.9.9-test', content_sha256: 'a'.repeat(64) } })
    refused(releaseHook(sealedRelease()), "does not match root's record")
  })
  it('a record naming another version than the one current points at', () => {
    const b = rootedBox()
    const plugin = join(b.vendor, 'current', 'talos-kit')
    rootedBox({ vendor: b.vendor, record: { v: 1, version: '9.9.8', content_sha256: releaseContentSha(plugin) } })
    refused(releaseHook(sealedRelease()), 'not the one root recorded')
  })
  it('a record that is not one: not JSON, wrong version field, a bad digest, too big', () => {
    for (const record of [
      'not json',
      { v: 2, version: '9.9.9-test', content_sha256: 'a'.repeat(64) },
      { v: 1, version: '../x', content_sha256: 'a'.repeat(64) },
      { v: 1, version: '9.9.9-test', content_sha256: 'XYZ' },
      `{"v":1,"pad":"${'x'.repeat(5000)}"}`,
    ]) {
      rootedBox({ record })
      expect(releaseHook(sealedRelease()), JSON.stringify(record).slice(0, 40)).toHaveProperty('problem')
    }
  })
  it('the record or /etc/talos not root’s, or writable by others: refused', () => {
    const b = rootedBox()
    Object.assign(ROOTED_KIT, { root: ME + 1 })
    refused(releaseHook(sealedRelease()), "not root's own")
    Object.assign(ROOTED_KIT, { root: ME })
    chmodSync(join(b.etc, 'kit-release'), 0o666)
    expect(releaseHook(sealedRelease())).toHaveProperty('problem')
    chmodSync(join(b.etc, 'kit-release'), 0o644)
    chmodSync(b.etc, 0o777)
    expect(releaseHook(sealedRelease())).toHaveProperty('problem')
  })
  it('a folder above root’s kit that others can write: refused, it could be swapped (Fable R1-3)', () => {
    const b = rootedBox()
    const parent = dirname(b.vendor) // the test's own box folder (R2-2: never the system temp folder)
    expect(parent.startsWith(realpathSync(tmpdir()))).toBe(true)
    expect(parent).not.toBe(realpathSync(tmpdir()))
    const was = statSync(parent).mode & 0o7777
    chmodSync(parent, 0o777)
    try {
      refused(releaseHook(sealedRelease()), 'or one above it')
    } finally {
      chmodSync(parent, was)
    }
  })
  it('root’s releases folder writable by others: refused by the rooted folder checks (Fable R1-4)', () => {
    const b = rootedBox()
    chmodSync(join(b.vendor, 'releases'), 0o777)
    try {
      refused(releaseHook(sealedRelease()), "is not root's own")
    } finally {
      chmodSync(join(b.vendor, 'releases'), 0o755)
    }
  })
  it('a link for the record: never followed', () => {
    const b = rootedBox()
    const real = join(tmp(), 'kit-release')
    writeFileSync(real, JSON.stringify({ v: 1, version: '9.9.9-test', content_sha256: releaseContentSha(b.plugin) }))
    rmSync(join(b.etc, 'kit-release'))
    symlinkSync(real, join(b.etc, 'kit-release'))
    expect(releaseHook(sealedRelease())).toHaveProperty('problem')
  })
  it('the kit edited after root sealed it (even resealed by the same user): refused', () => {
    const b = rootedBox()
    const release = join(b.vendor, 'releases', '9.9.9-test')
    unseal(release)
    writeFileSync(join(b.plugin, 'hooks', 'permission-relay.py'), '# rewritten\n')
    // its own record recomputed, as the user could: root's record still says otherwise
    writeFileSync(join(b.plugin, '.talos-release'), `content_sha256=${releaseContentSha(b.plugin)}\n`)
    seal(release) // sealed again, read-only as before: only root's record can tell
    refused(releaseHook(sealedRelease()), "does not match root's record")
  })
  it.skipIf(ME === 0)('as the real check runs it (root = 0): this user’s own kit and record are never root’s', () => {
    rootedBox()
    Object.assign(ROOTED_KIT, { root: 0 })
    expect(releaseHook(sealedRelease())).toHaveProperty('problem')
  })
})

describe('who may own a release file', () => {
  it('rooted: root alone, never this account; home: this account or root', () => {
    expect(releaseOwnerOk(0, { root: 0 }, 1000)).toBe(true)
    expect(releaseOwnerOk(1000, { root: 0 }, 1000)).toBe(false) // the talos user's own file in root's kit
    expect(releaseOwnerOk(1001, { root: 0 }, 1000)).toBe(false)
    expect(releaseOwnerOk(1000, null, 1000)).toBe(true)
    expect(releaseOwnerOk(0, null, 1000)).toBe(true)
    expect(releaseOwnerOk(1001, null, 1000)).toBe(false)
  })
})

describe('the content digest root and the supervisor both work out (the shared vector)', () => {
  it('packages/protocol/fixtures/kit-content-sha.json: built here, releaseContentSha gives its digest', () => {
    const vec = JSON.parse(
      readFileSync(join(import.meta.dir, '../../../../packages/protocol/fixtures/kit-content-sha.json'), 'utf8'),
    ) as { files: Array<{ path: string; exec?: boolean; mode?: string; text: string }>; content_sha256: string }
    const root = tmp()
    for (const f of vec.files) {
      const p = join(root, f.path)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, f.text)
      chmodSync(p, f.mode ? Number.parseInt(f.mode, 8) : f.exec ? 0o755 : 0o644)
    }
    expect(releaseContentSha(root)).toBe(vec.content_sha256)
  })
})

describe('a Talos distro’s worker settings run exactly the hook Talos built from root’s file (Fable R3-1, R3-5)', () => {
  // pure: runs on any temp folder, a Mac's too (no launch is built here)
  const fixed = {
    talosHome: '/home/alex/.talos',
    home: '/home/alex',
    thread: 'trip',
    folder: '/home/alex/agent',
    rooted: true,
  }
  function box() {
    const root = tmp()
    const dir = join(root, 'releases')
    const hooks = join(dir, '9.9.9', 'talos-kit', 'hooks')
    mkdirSync(hooks, { recursive: true })
    const script = join(hooks, 'permission-relay.py')
    writeFileSync(script, '# hook\n')
    const command = permissionHookCommand(script, '/usr/bin/python3', fixed)
    const statusLine = '/usr/bin/python3 -I /x/usage.py'
    const settings = (): Record<string, any> => ({
      enabledPlugins: { 'telegram@claude-plugins-official': false },
      env: {},
      pluginConfigs: {},
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', timeout: 3600, command }] }] },
      permissions: { deny: ['Read(//x)'], ask: [], disableAutoMode: 'disable' },
      disableSkillShellExecution: true,
      statusLine: { type: 'command', command: statusLine, padding: 0 },
    })
    return { root, dir, script, command, statusLine, settings }
  }
  type R = { dir: string; script: string; command: string; statusLine: string }
  const refusedBy = (settings: Record<string, unknown>, r: R) =>
    expect(() => rootedHookOnly(settings, r)).toThrow(WorkerSpecRefused)
  it('the hook Talos built, alone: passes', () => {
    const b = box()
    expect(() => rootedHookOnly(b.settings(), b)).not.toThrow()
  })
  it('an extra key on the hook or its entry (async, a matcher): refused (Fable R4-3)', () => {
    const b = box()
    const s = b.settings()
    s.hooks.PermissionRequest[0].hooks[0].async = true
    refusedBy(s, b)
    const t = b.settings()
    t.hooks.PermissionRequest[0].matcher = 'Bash'
    refusedBy(t, b)
  })
  it('a top-level key buildWorkerSpec never writes, another status line, skill shell lines on: refused (Fable R4-2)', () => {
    const b = box()
    refusedBy({ ...b.settings(), apiKeyHelper: '/home/alex/x.sh' }, b)
    refusedBy({ ...b.settings(), statusLine: { type: 'command', command: '/home/alex/x.sh', padding: 0 } }, b)
    refusedBy({ ...b.settings(), disableSkillShellExecution: false }, b)
    const { statusLine: _s, ...noLine } = b.settings()
    refusedBy(noLine, b)
  })
  it('a __proto__ member is a key like any other, never the prototype the exact compare skips (Fable R4-4)', () => {
    const b = box()
    const s = JSON.parse(JSON.stringify(b.settings()).replace('"hooks":{', '"hooks":{"__proto__":{"PreToolUse":[]},'))
    expect(Object.keys(s.hooks)).toContain('__proto__')
    refusedBy(s, b)
  })
  it('the same start of a command with another program after it: refused (the whole command is compared)', () => {
    const b = box()
    const s = b.settings()
    s.hooks.PermissionRequest[0]!.hooks[0]!.command = `f='${b.script}'; exec /usr/bin/env -i /home/alex/x.sh`
    refusedBy(s, b)
  })
  it('a second PermissionRequest entry, or a second hook in the entry: refused', () => {
    const b = box()
    const s = b.settings()
    s.hooks.PermissionRequest.push({ hooks: [{ type: 'command', timeout: 3600, command: b.command }] })
    refusedBy(s, b)
    const t = b.settings()
    t.hooks.PermissionRequest[0]!.hooks.push({ type: 'command', timeout: 3600, command: '/bin/true' })
    refusedBy(t, b)
  })
  it('any other hook event (a PreToolUse that could answer allow, as the guards’ file brings): refused', () => {
    const b = box()
    const s = {
      ...b.settings(),
      hooks: { ...b.settings().hooks, PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] },
    }
    refusedBy(s, b)
  })
  it('permissions that widen (allow, more folders): refused; deny, ask and the mode (held to Main’s by the ceiling) pass', () => {
    const b = box()
    refusedBy({ ...b.settings(), permissions: { deny: [], allow: ['Bash'] } }, b)
    refusedBy({ ...b.settings(), permissions: { additionalDirectories: ['/'], disableAutoMode: 'disable' } }, b)
    refusedBy({ ...b.settings(), permissions: { deny: [] } }, b) // auto mode left on
    expect(() =>
      rootedHookOnly(
        { ...b.settings(), permissions: { deny: [], defaultMode: 'default', disableAutoMode: 'disable' } },
        b,
      ),
    ).not.toThrow()
  })
  it('a script outside root’s releases: a sibling folder named alike, a link into it, a path with ..: refused', () => {
    const b = box()
    const evil = join(b.root, 'releases-evil', 'permission-relay.py')
    mkdirSync(dirname(evil), { recursive: true })
    writeFileSync(evil, '# not root’s\n')
    refusedBy(b.settings(), { ...b, script: evil })
    const link = join(b.dir, 'link.py')
    symlinkSync(evil, link)
    refusedBy(b.settings(), { ...b, script: link })
    refusedBy(b.settings(), {
      ...b,
      script: `${b.dir}/9.9.9/../9.9.9/talos-kit/hooks/permission-relay.py`, // a .. kept (join folds it away)
    })
    refusedBy(b.settings(), { ...b, script: join(b.dir, 'gone.py') })
  })
  it('root’s hook file gone (an update removed its release): the prompt is denied with words, never left waiting unseen', () => {
    const out = execFileSync('/bin/sh', ['-c', HOOK_CLEAN_LINE_ROOTED, join(tmp(), 'gone.py'), '/usr/bin/python3'], {
      encoding: 'utf8',
    })
    const j = JSON.parse(out)
    expect(j.hookSpecificOutput.decision.behavior).toBe('deny')
    expect(j.hookSpecificOutput.decision.message).toContain('restart the thread')
    // and the command a rooted session runs uses that line, with the hook told it is rooted (no cache from the talos home)
    expect(permissionHookCommand('/r/h.py', '/usr/bin/python3', fixed)).toContain('TALOS_APP_HOOK_ROOTED=1')
    expect(permissionHookCommand('/r/h.py', '/usr/bin/python3', { ...fixed, rooted: false })).not.toContain('ROOTED')
  })
})

describe('root’s kit holds no cached Python code (Fable R3-2)', () => {
  it('a __pycache__ folder or a .pyc in root’s release: refused', () => {
    for (const name of ['__pycache__', 'x.pyc']) {
      const b = rootedBox()
      const release = join(b.vendor, 'releases', '9.9.9-test')
      unseal(release)
      const p = join(b.plugin, 'hooks', name)
      if (name.endsWith('.pyc')) writeFileSync(p, 'x')
      else mkdirSync(p)
      seal(release)
      const r = releaseHook(sealedRelease())
      expect('problem' in r ? r.problem : JSON.stringify(r)).toContain('cached Python code')
    }
  })
})

describe('root’s Claude Code policy on a Talos distro (A’: only root’s kit loads as a marketplace)', () => {
  const refusedWith = (words: string) => {
    const r = kitAnchor()
    expect('refused' in r ? r.refused : JSON.stringify(r)).toContain(words)
  }
  it('the shared fixture is exactly the bytes the supervisor wants (kit-update writes the same)', () => {
    const f = readFileSync(
      join(import.meta.dir, '../../../../packages/protocol/fixtures/managed-settings.json'),
      'utf8',
    )
    expect(f).toBe(MANAGED_SETTINGS)
  })
  it('root’s policy as written: rooted', () => {
    rootedBox()
    expect(kitAnchor()).toHaveProperty('mode', 'rooted')
  })
  it('missing, other bytes, writable by others, a link, a folder others can write: refused', () => {
    const b = rootedBox()
    rmSync(b.managed)
    refusedWith('is missing')
    writeFileSync(b.managed, MANAGED_SETTINGS.replace('/opt/talos-app/kit', '/home/alex/kit'))
    refusedWith('is not the policy Talos installs')
    writeFileSync(b.managed, MANAGED_SETTINGS.trimEnd()) // the newline is part of the bytes
    refusedWith('is not the policy Talos installs')
    writeFileSync(b.managed, MANAGED_SETTINGS)
    chmodSync(b.managed, 0o666)
    refusedWith("is not root's own policy")
    chmodSync(b.managed, 0o644)
    const real = join(tmp(), 'policy.json')
    writeFileSync(real, MANAGED_SETTINGS)
    rmSync(b.managed)
    symlinkSync(real, b.managed)
    refusedWith('is missing') // a link is never followed
    rmSync(b.managed)
    writeFileSync(b.managed, MANAGED_SETTINGS)
    chmodSync(dirname(b.managed), 0o777)
    try {
      refusedWith("is not root's own folder")
    } finally {
      chmodSync(dirname(b.managed), 0o755)
    }
  })
  it('a drop-in beside it (its list is joined to the file’s, so it could let another marketplace load): refused; an empty folder passes', () => {
    const b = rootedBox()
    const d = join(dirname(b.managed), 'managed-settings.d')
    mkdirSync(d)
    expect(kitAnchor()).toHaveProperty('mode', 'rooted')
    writeFileSync(join(d, '50-x.json'), '{}')
    refusedWith('holds a policy beside Talos')
  })
})

describe('root’s kit’s marketplace manifest (which plugin the one allowlisted marketplace offers)', () => {
  const refusedWith = (words: string) => {
    const r = kitAnchor()
    expect('refused' in r ? r.refused : JSON.stringify(r)).toContain(words)
  }
  it('the shared fixture is the supervisor’s bytes and exactly what kit/scripts/plugin-release.py lays out', () => {
    const fix = join(import.meta.dir, '../../../../packages/protocol/fixtures/kit-marketplace.json')
    expect(readFileSync(fix, 'utf8')).toBe(KIT_MARKETPLACE)
    const script = join(import.meta.dir, '../../../../kit/scripts/plugin-release.py')
    const out = execFileSync(
      'python3',
      [
        '-I',
        '-c',
        'import importlib.util,sys\nspec=importlib.util.spec_from_file_location("pr",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nsys.stdout.write(m.dump(m.marketplace_manifest()))',
        script,
      ],
      { encoding: 'utf8' },
    )
    expect(out).toBe(KIT_MARKETPLACE)
  })
  it('missing, other bytes, writable, a link: refused', () => {
    const b = rootedBox()
    const file = join(b.vendor, '.claude-plugin', 'marketplace.json')
    rmSync(file)
    refusedWith('marketplace.json is missing')
    writeFileSync(file, KIT_MARKETPLACE.replace('./current/talos-kit', '/home/alex/evil'))
    chmodSync(file, 0o444)
    refusedWith('is not the one Talos installs')
    rmSync(file, { force: true })
    writeFileSync(file, KIT_MARKETPLACE)
    chmodSync(file, 0o644)
    refusedWith("is not root's read-only file")
    rmSync(file)
    const real = join(tmp(), 'm.json')
    writeFileSync(real, KIT_MARKETPLACE)
    symlinkSync(real, file)
    refusedWith('marketplace.json is missing') // a link is never followed
    rmSync(file)
    writeMarketplace(b.vendor)
    expect(kitAnchor()).toHaveProperty('mode', 'rooted')
  })
})

// What these reach: each check's folder owner rule. The FILE owner checks (the policy, the drop-in folder, the manifest: a file
// or folder of another uid inside a folder of root's) cannot be built without root, so no test here reaches them (Fable R2-1).
describe('the policy and manifest checks by owner, called directly (Fable R1-5)', () => {
  it('a policy or a manifest that is not root’s (root = another uid): refused at each check itself', () => {
    const b = rootedBox()
    expect(managedProblem(b.managed, ME)).toBeNull()
    expect(managedProblem(b.managed, ME + 1)).toContain("is not root's own folder")
    expect(marketplaceProblem(b.vendor, ME)).toBeNull()
    expect(marketplaceProblem(b.vendor, ME + 1)).toContain("is not root's own folder")
  })
  it('managed-settings.d as a link, a file, unreadable, or others can write it: refused', () => {
    const b = rootedBox()
    const d = join(dirname(b.managed), 'managed-settings.d')
    symlinkSync(tmp(), d)
    expect(managedProblem(b.managed, ME)).toContain('is not an empty folder')
    rmSync(d)
    writeFileSync(d, '{}')
    expect(managedProblem(b.managed, ME)).toContain('is not an empty folder')
    rmSync(d)
    mkdirSync(d)
    chmodSync(d, 0o777)
    expect(managedProblem(b.managed, ME)).toContain("is not root's own folder")
    chmodSync(d, 0o755)
    expect(managedProblem(b.managed, ME)).toBeNull()
    if (ME !== 0) {
      chmodSync(d, 0o000)
      try {
        expect(managedProblem(b.managed, ME)).toContain('cannot be looked at')
      } finally {
        chmodSync(d, 0o755)
      }
    }
  })
})

describe('the hook script with a second hard-linked name (realFileSync, never realpath)', () => {
  it('a hard link to root’s hook elsewhere (in the talos user’s home): still the name it was found under, and it passes', () => {
    const root = tmp()
    const dir = join(root, 'releases')
    const hooks = join(dir, '9.9.9', 'talos-kit', 'hooks')
    mkdirSync(hooks, { recursive: true })
    const script = join(hooks, 'permission-relay.py')
    writeFileSync(script, '# hook\n')
    // a second name for the same file, outside root's releases: the one realpath may answer with on a Mac
    const home = join(tmp(), 'home')
    mkdirSync(home)
    linkSync(script, join(home, 'relay.py'))
    expect(statSync(script).nlink).toBe(2)
    // on Linux realpath gives this name too: only the source audit (test/real-file.test.ts) tells realFileSync from realpathSync here
    expect(realFileSync(script)).toBe(script)
    const fixed = {
      talosHome: '/home/alex/.talos',
      home: '/home/alex',
      thread: 'trip',
      folder: '/home/alex/agent',
      rooted: true,
    }
    const command = permissionHookCommand(script, '/usr/bin/python3', fixed)
    const statusLine = '/usr/bin/python3 -I /x/usage.py'
    const settings = {
      enabledPlugins: {},
      env: {},
      pluginConfigs: {},
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', timeout: 3600, command }] }] },
      permissions: { deny: [], disableAutoMode: 'disable' },
      disableSkillShellExecution: true,
      statusLine: { type: 'command', command: statusLine, padding: 0 },
    }
    expect(() => rootedHookOnly(settings, { dir, script, command, statusLine })).not.toThrow()
    // and the home name itself is never root's hook: outside the releases folder, refused. The command stays the one the settings
    // hold, so the hooks comparison passes and only the script check can refuse (Fable's last look)
    const other = join(home, 'relay.py')
    expect(() => rootedHookOnly(settings, { dir, script: other, command, statusLine })).toThrow(
      `the permission hook script ${other} is not root's file`,
    )
  })
})
