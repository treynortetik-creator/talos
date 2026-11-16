// The SecretStore backends (supervisor contract, section 5) against spawn spies and a temp folder: no real Keychain or keyring
// is touched. The Secret Service exit codes mirror what secret-tool 0.21 really does (checked on Arch).
import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultKeychainRunner, KeychainError, storeRunner } from '../src/apps/keychain.ts'
import { mountOf, parseMountinfo, pathIssue } from '../src/secrets/platform.ts'
import {
  decodeValue,
  encodeValue,
  fileSecretStore,
  isUnavailableStore,
  macosKeychainStore,
  openSecretStore,
  SecretError,
  type SecretSpawn,
  type SecretSpawnResult,
  secretServiceStore,
  unavailableStore,
} from '../src/secrets/store.ts'

type Call = { argv: string[]; stdin: string | undefined; env: Record<string, string> | undefined }

function spy(handler: (c: Call) => Partial<SecretSpawnResult> = () => ({})) {
  const calls: Call[] = []
  const spawn: SecretSpawn = async (argv, stdin, env) => {
    const c = { argv, stdin, env }
    calls.push(c)
    return { code: 0, stdout: '', stderr: '', ...handler(c) }
  }
  return { calls, spawn }
}

/**
 * A fake secret-tool with a real item table, behaving as secret-tool 0.21 with gnome-keyring 51 does:
 * - down: no bus, every call exits 1 with a message
 * - locked: lookup and clear exit 1 SAY NOTHING (like a missing item) and clear removes nothing; search still lists the item;
 *   store fails with a message
 * - cannotStore: answers lookups (quiet misses) but every store fails (headless WSL: no collection, no prompter)
 */
function fakeSecretTool(opts: { down?: boolean; locked?: boolean; cannotStore?: boolean; onStore?: () => void } = {}) {
  const items = new Map<string, string>()
  const key = (a: string[]) => `${a[a.indexOf('service') + 1]}|${a[a.indexOf('account') + 1]}`
  return {
    items,
    ...spy(({ argv, stdin }) => {
      if (opts.down) return { code: 1, stderr: 'secret-tool: Could not connect: No such file or directory\n' }
      const k = key(argv)
      if (argv[1] === 'lookup') return items.has(k) && !opts.locked ? { stdout: items.get(k) } : { code: 1 }
      if (argv[1] === 'search')
        return items.has(k)
          ? {
              stdout: `[/org/freedesktop/secrets/collection/login/1]\nlabel = x\n`,
              ...(opts.locked ? { stderr: 'secret-tool: Cannot get secret of a locked object\n' } : {}),
            }
          : {}
      if (argv[1] === 'store') {
        opts.onStore?.()
        if (opts.locked) return { code: 1, stderr: 'secret-tool: Cannot create an item in a locked collection\n' }
        if (opts.cannotStore)
          return {
            code: 1,
            stderr: 'secret-tool: Object does not exist at path “/org/freedesktop/secrets/collection/login”\n',
          }
        items.set(k, stdin ?? '')
        return {}
      }
      if (argv[1] === 'clear') return !opts.locked && items.delete(k) ? {} : { code: 1 }
      return { code: 2, stderr: 'usage' }
    }),
  }
}

const SECRET = 'Bearer s3cr3t-value-123'
const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'talos-secrets-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const noIssue = () => null

describe('values', () => {
  it('round-trip any string, and anything without the v1. prefix is not ours', () => {
    const v = 'naïve\n"quoted" $(rm -rf) \u0000 end'
    expect(decodeValue(encodeValue(v))).toBe(v)
    expect(encodeValue(SECRET)).not.toContain('s3cr3t')
    expect(() => decodeValue('plain-text')).toThrow(SecretError)
    expect(() => decodeValue('v1.%%%')).toThrow(SecretError)
  })
})

describe('macos_keychain (against a spawn spy)', () => {
  it('writes through `security -i` with the value on stdin, never argv, after reading that the slot is free', async () => {
    const s = spy(({ argv }) => (argv[1] === 'find-generic-password' ? { code: 44 } : {}))
    await macosKeychainStore(s.spawn).set('com.talos.app.launch-seal', 'confirmed-launch-v1', SECRET)
    expect(s.calls.map((c) => c.argv[1])).toEqual(['find-generic-password', '-i'])
    expect(s.calls[1]?.stdin).toStartWith(
      'add-generic-password -U -s com.talos.app.launch-seal -a confirmed-launch-v1 -w v1.',
    )
    expect(JSON.stringify(s.calls)).not.toContain('s3cr3t')
  })
  it('never replaces an item that is not ours, or one it cannot read', async () => {
    const theirs = spy(({ argv }) => (argv[1] === 'find-generic-password' ? { stdout: 'someone-else\n' } : {}))
    await expect(macosKeychainStore(theirs.spawn).set('svc', 'acct', 'x')).rejects.toMatchObject({ code: 'not_ours' })
    expect(theirs.calls.length).toBe(1)
    const locked = spy(() => ({ code: 36 }))
    await expect(macosKeychainStore(locked.spawn).set('svc', 'acct', 'x')).rejects.toMatchObject({ code: 'locked' })
    expect(locked.calls.length).toBe(1)
  })
  it('never sends a line `security -i` would cut (about 4 KB): a large value is refused, nothing written', async () => {
    const s = spy(({ argv }) => (argv[1] === 'find-generic-password' ? { code: 44 } : {}))
    await expect(macosKeychainStore(s.spawn).set('svc', 'acct', 'x'.repeat(4000))).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(s.calls.map((c) => c.argv[1])).toEqual(['find-generic-password'])
    await macosKeychainStore(s.spawn).set('svc', 'acct', 'x'.repeat(2500))
    expect(s.calls.at(-1)?.argv[1]).toBe('-i')
  })
  it('a missing item is undefined; deleting a missing item is fine', async () => {
    const s = spy(() => ({ code: 44 }))
    const k = macosKeychainStore(s.spawn)
    expect(await k.get('svc', 'acct')).toBeUndefined()
    await k.delete('svc', 'acct')
  })
  it('refuses a name that could break the `security -i` line', async () => {
    const s = spy()
    const k = macosKeychainStore(s.spawn)
    for (const bad of ['a b', 'a\nadd-generic-password', 'a"b', '', 'x'.repeat(201)])
      await expect(k.set('svc', bad, 'v')).rejects.toMatchObject({ code: 'bad_account' })
    expect(s.calls.length).toBe(0)
  })
  it('a tool that cannot start is unavailable', async () => {
    const k = macosKeychainStore(async () => {
      throw new Error('ENOENT')
    })
    await expect(k.get('svc', 'acct')).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('secret_service (against a fake secret-tool)', () => {
  it('stores with the value on stdin, no newline, and reads it back', async () => {
    const t = fakeSecretTool()
    const st = secretServiceStore(t.spawn)
    await st.set('talos-app.direct', 'abc/oauth', SECRET)
    const store = t.calls.find((c) => c.argv[1] === 'store')
    expect(store?.argv).toEqual([
      'secret-tool',
      'store',
      '--label=Talos: talos-app.direct abc/oauth',
      'service',
      'talos-app.direct',
      'account',
      'abc/oauth',
    ])
    expect(store?.stdin?.endsWith('\n')).toBe(false)
    expect(JSON.stringify(t.calls)).not.toContain('s3cr3t')
    expect(await st.get('talos-app.direct', 'abc/oauth')).toBe(SECRET)
    await st.delete('talos-app.direct', 'abc/oauth')
    expect(await st.get('talos-app.direct', 'abc/oauth')).toBeUndefined()
    await st.delete('talos-app.direct', 'abc/oauth') // missing: exit 1, nothing on stderr
  })
  it('tells a missing item (exit 1, quiet) from a keyring that is down (exit 1 with a message)', async () => {
    const down = secretServiceStore(fakeSecretTool({ down: true }).spawn)
    await expect(down.get('svc', 'acct')).rejects.toMatchObject({ code: 'unavailable' })
    await expect(down.delete('svc', 'acct')).rejects.toMatchObject({ code: 'unavailable' })
  })
  it('never replaces an item another program keeps under the same attributes', async () => {
    const t = fakeSecretTool()
    t.items.set('svc|acct', 'their-password')
    await expect(secretServiceStore(t.spawn).set('svc', 'acct', 'mine')).rejects.toMatchObject({ code: 'not_ours' })
    expect(t.items.get('svc|acct')).toBe('their-password')
  })
  it('a LOCKED keyring is not "missing": get and set say locked, and delete never reports a kept token gone', async () => {
    const t = fakeSecretTool({ locked: true })
    t.items.set('talos-app.direct|abc/oauth', encodeValue(SECRET))
    const st = secretServiceStore(t.spawn)
    await expect(st.get('talos-app.direct', 'abc/oauth')).rejects.toMatchObject({ code: 'locked' })
    await expect(st.set('talos-app.direct', 'abc/oauth', 'x')).rejects.toMatchObject({ code: 'locked' })
    await expect(st.delete('talos-app.direct', 'abc/oauth')).rejects.toMatchObject({ code: 'locked' })
    expect(t.items.has('talos-app.direct|abc/oauth')).toBe(true)
    // a truly missing item in a locked keyring is still just missing
    expect(await st.get('talos-app.direct', 'other/oauth')).toBeUndefined()
  })
  it('a prompt nobody answers (the tool killed at the limit) is locked, not missing', async () => {
    const st = secretServiceStore(spy(() => ({ code: -1 })).spawn)
    await expect(st.get('svc', 'acct')).rejects.toMatchObject({ code: 'locked' })
  })
})

describe('file_0600', () => {
  it('round-trips into a 0700 folder and 0600 files whose names say nothing', async () => {
    const dir = join(tmp(), 'secrets')
    const st = fileSecretStore(dir, { pathIssue: noIssue })
    expect(await st.get('svc', 'acct')).toBeUndefined()
    await st.set('com.talos.app.launch-seal', 'confirmed-launch-v1', SECRET)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const files = readdirSync(dir)
    expect(files.length).toBe(1)
    expect(files[0]).toMatch(/^[0-9a-f]{32}\.secret$/)
    expect(statSync(join(dir, files[0] as string)).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dir, files[0] as string), 'utf8')).not.toContain('s3cr3t')
    expect(await st.get('com.talos.app.launch-seal', 'confirmed-launch-v1')).toBe(SECRET)
    await st.set('com.talos.app.launch-seal', 'confirmed-launch-v1', 'second')
    expect(await st.get('com.talos.app.launch-seal', 'confirmed-launch-v1')).toBe('second')
    expect(readdirSync(dir).length).toBe(1) // no temp file left behind
    await st.delete('com.talos.app.launch-seal', 'confirmed-launch-v1')
    expect(readdirSync(dir).length).toBe(0)
    await st.delete('com.talos.app.launch-seal', 'confirmed-launch-v1')
  })
  it('refuses a folder others can open, and touches nothing in it', async () => {
    const dir = join(tmp(), 'secrets')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    const st = fileSecretStore(dir, { pathIssue: noIssue })
    await expect(st.set('svc', 'acct', 'v')).rejects.toMatchObject({ code: 'not_ours' })
    await expect(st.get('svc', 'acct')).rejects.toMatchObject({ code: 'not_ours' })
    expect(readdirSync(dir).length).toBe(0)
  })
  it('refuses a folder that is a link', async () => {
    const root = tmp()
    mkdirSync(join(root, 'real'), { mode: 0o700 })
    symlinkSync(join(root, 'real'), join(root, 'secrets'))
    await expect(
      fileSecretStore(join(root, 'secrets'), { pathIssue: noIssue }).set('svc', 'acct', 'v'),
    ).rejects.toMatchObject({
      code: 'not_ours',
    })
    expect(readdirSync(join(root, 'real')).length).toBe(0)
  })
  it('refuses an item file that is a link, a hard link, readable by others, or someone else’s item, and never replaces it', async () => {
    const dir = join(tmp(), 'secrets')
    const st = fileSecretStore(dir, { pathIssue: noIssue })
    await st.set('svc', 'acct', 'mine')
    const name = readdirSync(dir)[0] as string
    const path = join(dir, name)
    const good = readFileSync(path, 'utf8')

    chmodSync(path, 0o644)
    await expect(st.get('svc', 'acct')).rejects.toMatchObject({ code: 'not_ours' })
    await expect(st.set('svc', 'acct', 'x')).rejects.toMatchObject({ code: 'not_ours' })
    chmodSync(path, 0o600)

    linkSync(path, join(tmp(), 'elsewhere'))
    await expect(st.get('svc', 'acct')).rejects.toMatchObject({ code: 'not_ours' })
    rmSync(path)
    writeFileSync(path, good, { mode: 0o600 })

    const outside = join(tmp(), 'outside')
    writeFileSync(outside, good, { mode: 0o600 })
    rmSync(path)
    symlinkSync(outside, path)
    await expect(st.get('svc', 'acct')).rejects.toMatchObject({ code: 'not_ours' })
    await expect(st.set('svc', 'acct', 'x')).rejects.toMatchObject({ code: 'not_ours' })
    expect(readFileSync(outside, 'utf8')).toBe(good)
    rmSync(path)

    // a file for another (service, account) put under this item's name
    writeFileSync(path, JSON.stringify({ service: 'other', account: 'acct', value: encodeValue('x') }), { mode: 0o600 })
    await expect(st.get('svc', 'acct')).rejects.toMatchObject({ code: 'not_ours' })
  })
  it('refuses a Windows drive: nothing is written', async () => {
    const dir = join(tmp(), 'secrets')
    const st = fileSecretStore(dir, { pathIssue: () => 'windows_drive' })
    await expect(st.set('svc', 'acct', 'v')).rejects.toMatchObject({ code: 'unavailable' })
    expect(existsSync(dir)).toBe(false)
  })
})

describe('pathIssue (WSL)', () => {
  // a real WSL 2 mountinfo: the ext4 root, WSLg's tmpfs, C: on 9p (drvfs), and D: moved by automount.root = /win/
  const WSL2 = [
    '61 1 8:32 / / rw,relatime - ext4 /dev/sdc rw,discard,errors=remount-ro,data=ordered',
    '70 61 0:44 / /mnt/wsl rw,relatime shared:1 - tmpfs none rw',
    '85 61 0:58 / /mnt/c rw,noatime - 9p drvfs rw,dirsync,aname=drvfs;path=C:\\;uid=1000;gid=1000,trans=virtio',
    '86 61 0:59 / /win/d rw,noatime - 9p drvfs rw,aname=drvfs;path=D:\\,trans=virtio',
    '87 61 0:60 / /mnt/My\\040Drive rw - virtiofs drvfsa rw',
  ].join('\n')
  const mounts = parseMountinfo(WSL2)

  it('a path on a Windows drive is refused wherever the drive is mounted, judged by its filesystem type', () => {
    expect(pathIssue('/mnt/c/Users/alex/.config/talos', true, mounts)).toBe('windows_drive')
    expect(pathIssue('/mnt/c', true, mounts)).toBe('windows_drive')
    expect(pathIssue('/win/d/talos/secrets', true, mounts)).toBe('windows_drive')
    expect(pathIssue('/mnt/My Drive/x', true, mounts)).toBe('windows_drive')
    expect(pathIssue('/mnt/wsl/x', true, mounts)).toBeNull()
    expect(pathIssue('/mnt/cx/y', true, mounts)).toBeNull()
    expect(pathIssue('/home/alex/.config/talos', true, mounts)).toBeNull()
    expect(pathIssue('/mnt/c/Users', false, mounts)).toBeNull()
  })
  it('the mount point is decoded, and the deepest mount that holds the path counts', () => {
    expect(mounts.map((m) => m.at)).toEqual(['/', '/mnt/wsl', '/mnt/c', '/win/d', '/mnt/My Drive'])
    const stacked = parseMountinfo(`${WSL2}\n90 86 8:40 / /win/d/linuxdisk rw - ext4 /dev/sdd rw`)
    expect(pathIssue('/win/d/linuxdisk/talos', true, stacked)).toBeNull()
    expect(pathIssue('/win/d/other', true, stacked)).toBe('windows_drive')
    // under the default root the name alone refuses, even a Linux disk stacked there: refusing too much is the safe side
    const underC = parseMountinfo(`${WSL2}\n91 85 8:41 / /mnt/c/linuxdisk rw - ext4 /dev/sde rw`)
    expect(pathIssue('/mnt/c/linuxdisk/talos', true, underC)).toBe('windows_drive')
  })
  it('the default /mnt/<drive> root is refused whatever mountinfo says (an unknown type, nothing usable)', () => {
    const odd = parseMountinfo(`${WSL2.replace(' - 9p drvfs rw,dirsync', ' - fuse.drvfs drvfs rw,dirsync')}`)
    expect(pathIssue('/mnt/c/Users/alex/talos', true, odd)).toBe('windows_drive')
    expect(pathIssue('/mnt/c/Users/alex/talos', true, [])).toBe('windows_drive')
    expect(pathIssue('/mnt/c/Users/alex/talos', true, parseMountinfo('garbage'))).toBe('windows_drive')
    expect(pathIssue('/home/alex', true, [])).toBeNull()
  })
  it('without a readable mountinfo, the default /mnt/<drive> root is used', () => {
    expect(pathIssue('/mnt/c/Users/alex/.config/talos', true, null)).toBe('windows_drive')
    expect(pathIssue('/win/d/x', true, null)).toBeNull()
    expect(pathIssue('/home/alex', true, null)).toBeNull()
  })
  it('a relative path is resolved first', () => {
    const cwd = process.cwd()
    try {
      process.chdir('/')
      expect(pathIssue('mnt/c/nope/secrets', true, mounts)).toBe('windows_drive')
    } finally {
      process.chdir(cwd)
    }
  })
  it('a link on the Linux disk that leads to a drive counts as the drive', () => {
    const root = tmp()
    mkdirSync(join(root, 'drive'))
    // a mount point is a real path (mountinfo lists them resolved); macOS's temp folder is itself behind a link
    const drive = realpathSync(join(root, 'drive'))
    symlinkSync(drive, join(root, 'cfg'))
    const withDrive = [...mounts, { at: drive, fsType: '9p' }]
    expect(pathIssue(join(root, 'cfg', 'secrets'), true, withDrive)).toBe('windows_drive')
    expect(pathIssue(join(root, 'cfg', 'secrets'), true, mounts)).toBeNull()
  })
  it('this machine’s own mountinfo parses (Linux)', () => {
    if (process.platform !== 'linux') return
    const own = parseMountinfo(readFileSync('/proc/self/mountinfo', 'utf8'))
    expect(own.some((m) => m.at === '/')).toBe(true)
    expect(mountOf('/', own)?.at).toBe('/')
  })
})

describe('openSecretStore', () => {
  /** No session bus socket where one is looked for, unless a test makes one. */
  const linux = (home: string, env: NodeJS.ProcessEnv, spawn: SecretSpawn) =>
    openSecretStore({ home, platform: 'linux', env, spawn, pathIssue: noIssue, runtimeDir: tmp() })
  const BUS = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }

  it('macOS: always the Keychain', async () => {
    const st = await openSecretStore({ home: tmp(), platform: 'darwin', env: {}, spawn: spy().spawn })
    expect(st.backend).toBe('macos_keychain')
  })
  it('a keyring that really stores: secret_service, remembered, and the probe item is gone again', async () => {
    const home = tmp()
    const t = fakeSecretTool()
    const st = await linux(home, BUS, t.spawn)
    expect(st.backend).toBe('secret_service')
    expect(st.strength).toBe('os_keyring')
    expect(t.calls.map((c) => c.argv[1])).toContain('store')
    expect(t.items.size).toBe(0)
    expect(t.calls.every((c) => c.env?.DBUS_SESSION_BUS_ADDRESS === BUS.DBUS_SESSION_BUS_ADDRESS)).toBe(true)
    expect(readFileSync(join(home, 'secret-backend'), 'utf8')).toBe('secret_service\n')
    expect(statSync(join(home, 'secret-backend')).mode & 0o777).toBe(0o600)
  })
  it('headless WSL with gnome-keyring installed (answers, no collection), even with WSLg’s DISPLAY: the 0600 file', async () => {
    const home = tmp()
    const st = await linux(
      home,
      { ...BUS, DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' },
      fakeSecretTool({ cannotStore: true }).spawn,
    )
    expect(st.backend).toBe('file_0600')
    expect(st.strength).toBe('file')
    expect(readFileSync(join(home, 'secret-backend'), 'utf8')).toBe('file_0600\n')
  })
  it('WSLg’s DISPLAY with no secret-tool at all: the 0600 file', async () => {
    const home = tmp()
    const st = await linux(home, { ...BUS, DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, async () => {
      throw new Error('ENOENT')
    })
    expect(st.backend).toBe('file_0600')
  })
  it('a bus with no Secret Service on it: the 0600 file', async () => {
    const home = tmp()
    const st = await linux(home, BUS, fakeSecretTool({ down: true }).spawn)
    expect(st.backend).toBe('file_0600')
  })
  it('no session bus at all: the 0600 file, remembered', async () => {
    const home = tmp()
    const s = spy()
    const st = await linux(home, {}, s.spawn)
    expect(st.backend).toBe('file_0600')
    expect(s.calls.length).toBe(0)
    expect(readFileSync(join(home, 'secret-backend'), 'utf8')).toBe('file_0600\n')
  })
  for (const [why, env] of [
    ['on the desktop', { ...BUS, WAYLAND_DISPLAY: 'wayland-1' }],
    ['over ssh (no screen)', BUS],
  ] as const)
    it(`a keyring that is there but locked, ${why}: every call fails, nothing is remembered, nothing goes to a file`, async () => {
      const home = tmp()
      const st = await linux(home, env, fakeSecretTool({ locked: true }).spawn)
      expect(isUnavailableStore(st)).toBe(true)
      await expect(st.set('svc', 'acct', 'v')).rejects.toMatchObject({ code: 'unavailable' })
      expect(existsSync(join(home, 'secret-backend'))).toBe(false)
      expect(existsSync(join(home, 'secrets'))).toBe(false)
    })
  it('a probe that times out (a prompt nobody answers) decides nothing', async () => {
    const home = tmp()
    const st = await linux(home, BUS, spy(() => ({ code: -1 })).spawn)
    expect(isUnavailableStore(st)).toBe(true)
    expect(existsSync(join(home, 'secret-backend'))).toBe(false)
  })
  it('a process without the bus in its environment (ssh, cron) finds the owner’s bus socket', async () => {
    const home = tmp()
    const run = tmp()
    const server = createServer().listen(join(run, 'bus'))
    await new Promise((r) => server.once('listening', r))
    try {
      const t = fakeSecretTool()
      const st = await openSecretStore({ home, platform: 'linux', env: {}, spawn: t.spawn, runtimeDir: run })
      expect(st.backend).toBe('secret_service')
      expect(t.calls[0]?.env?.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${join(run, 'bus')}`)
    } finally {
      server.close()
    }
  })
  it('two first starts agree: the one that wrote the choice first wins, the other uses it', async () => {
    const home = tmp()
    // another process (with no bus) remembers the file while this one is still probing the keyring
    const t = fakeSecretTool({ onStore: () => writeFileSync(join(home, 'secret-backend'), 'file_0600\n') })
    const st = await linux(home, BUS, t.spawn)
    expect(st.backend).toBe('file_0600')
    expect(readFileSync(join(home, 'secret-backend'), 'utf8')).toBe('file_0600\n')
    expect(readdirSync(home).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
  it('a remembered keyring that is down later fails every call; it never moves secrets to the file', async () => {
    const home = tmp()
    writeFileSync(join(home, 'secret-backend'), 'secret_service\n')
    const st = await linux(home, BUS, fakeSecretTool({ down: true }).spawn)
    expect(st.backend).toBe('secret_service')
    expect(isUnavailableStore(st)).toBe(true)
    await expect(st.set('svc', 'acct', 'v')).rejects.toMatchObject({ code: 'unavailable' })
    await expect(st.get('svc', 'acct')).rejects.toMatchObject({ code: 'unavailable' })
    expect(existsSync(join(home, 'secrets'))).toBe(false)
  })
  it('a remembered choice that names nothing known fails every call', async () => {
    const home = tmp()
    writeFileSync(join(home, 'secret-backend'), 'plaintext\n')
    const st = await linux(home, BUS, fakeSecretTool().spawn)
    await expect(st.get('svc', 'acct')).rejects.toMatchObject({ code: 'unavailable' })
  })
  it('TALOS_SECRET_BACKEND forces a backend and is not remembered; an unknown one fails every call', async () => {
    const home = tmp()
    const forced = await linux(home, { ...BUS, TALOS_SECRET_BACKEND: 'file_0600' }, fakeSecretTool().spawn)
    expect(forced.backend).toBe('file_0600')
    expect(existsSync(join(home, 'secret-backend'))).toBe(false)
    const bad = await linux(home, { TALOS_SECRET_BACKEND: 'plaintext' }, spy().spawn)
    await expect(bad.get('svc', 'acct')).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('the bridge runner on a SecretStore', () => {
  it('keeps the Mac account rule and the talos-app.direct service, and reports store errors as KeychainError', async () => {
    const t = fakeSecretTool()
    const runner = storeRunner(async () => secretServiceStore(t.spawn))
    const acct = `${'a'.repeat(16)}/oauth`
    await runner.write(acct, SECRET)
    expect(t.items.has(`talos-app.direct|${acct}`)).toBe(true)
    expect(await runner.read(acct)).toBe(SECRET)
    await expect(runner.write('../../etc', 'x')).rejects.toBeInstanceOf(KeychainError)
    t.items.set(`talos-app.direct|${acct}`, 'theirs')
    const err = await runner.write(acct, 'x').catch((e) => e)
    expect(err).toBeInstanceOf(KeychainError)
    expect(err.kind).toBe('unavailable')
  })
  it('off macOS, a store that was unavailable is opened again only after a minute, not on every call', async () => {
    if (process.platform === 'darwin') return
    let t = 0
    let opens = 0
    const runner = defaultKeychainRunner(
      tmp(),
      async () => {
        opens++
        return unavailableStore('secret_service', 'locked')
      },
      () => t,
    )
    const acct = `${'a'.repeat(16)}/oauth`
    for (let i = 0; i < 5; i++) await runner.read(acct).catch(() => {})
    expect(opens).toBe(1)
    t = 61_000
    await runner.read(acct).catch(() => {})
    await runner.read(acct).catch(() => {})
    expect(opens).toBe(2)
  })
  it('a store that cannot open is unavailable, not a crash', async () => {
    const runner = storeRunner(async () => {
      throw new Error('boom')
    })
    await expect(runner.read(`${'a'.repeat(16)}/oauth`)).rejects.toBeInstanceOf(KeychainError)
  })
})
