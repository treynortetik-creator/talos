// Windows step 1 (docs/WINDOWS-PLAN.md section 8): the setup that runs inside the `talos` WSL distro, as root. These run the
// real script against a scratch root (TALOS_WSL_ROOT), so what it writes to /etc is checked here, on Linux, without a distro.
// mount and umount are stand-ins that record what they were asked (TALOS_WSL_MOUNT / TALOS_WSL_UMOUNT) and change the
// scratch /proc/mounts as the real ones would (a tmpfs mounted is listed, an unmount takes the top mount there and, lazily,
// what sits under it), so what the script checks after its own mounts is checked against what they did. wslinfo is one too.
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
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
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGP_EVEN_WORDS, PGP_ODD_WORDS } from '../packages/protocol/src/pgp-words.ts'
import { ROOT } from './size-report.ts'

const SCRIPT = join(ROOT, 'apps', 'windows', 'distro', 'talos-wsl.sh')
// Tests marked with this run on Linux only (the distro is Linux). On macOS two things differ: talos-wsl.sh's status and stop
// path call GNU `timeout`, which macOS lacks, so each `timeout 3 runuser ...` and `timeout 5 systemctl ...` fails before the
// stand-ins run; and tmpdir() is under /var, a link to /private/var, so installDefaults()'s claude_path is not its own real
// path and launch.py refuses it as unapprovable.
const linuxOnly = process.platform !== 'linux'
let root: string
let bin: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'talos-wsl-'))
  mkdirSync(join(root, 'etc'))
  bin = join(root, '.bin')
  mkdirSync(bin)
  // MOUNT_FAILS fails every mount, PRIVATE_FAILS only --make-*private, UMOUNT_FAILS every unmount
  writeFileSync(join(bin, 'fake-mount'), FAKE_MOUNT, { mode: 0o755 })
  writeFileSync(join(bin, 'fake-umount'), FAKE_UMOUNT, { mode: 0o755 })
  writeFileSync(join(bin, 'fake-wslinfo'), '#!/bin/sh\necho "${NETMODE-nat}"\n', { mode: 0o755 })
})
const FAKE_MOUNT = [
  '#!/bin/sh',
  'printf "mount %s\\n" "$*" >> "$FAKE_ROOT/.calls"',
  '[ -z "$MOUNT_FAILS" ] || exit 1',
  'case "$1" in --make-*) [ -z "$PRIVATE_FAILS" ] || exit 1; exit 0 ;; esac',
  // MOUNT_FAIL_RO: only a read-only mount fails (so putting the read-write one back works)
  'case "$4" in ro,*) [ -z "$MOUNT_FAIL_RO" ] || exit 1 ;; esac',
  // mount -t tmpfs -o OPTS SOURCE TARGET: listed, as the kernel would
  'if [ "$2" = tmpfs ] && [ -f "$FAKE_ROOT/proc/mounts" ]; then',
  '  printf "%s %s tmpfs rw 0 0\\n" "$5" "${6#"$FAKE_ROOT"}" >> "$FAKE_ROOT/proc/mounts"',
  'fi',
  '',
].join('\n')
const FAKE_UMOUNT = [
  '#!/bin/sh',
  'printf "umount %s\\n" "$*" >> "$FAKE_ROOT/.calls"',
  '[ -z "$UMOUNT_FAILS" ] || exit 1',
  'lazy=0; if [ "$1" = -l ]; then lazy=1; shift; fi',
  'm="$FAKE_ROOT/proc/mounts"; [ -f "$m" ] || exit 0',
  // the top mount at the target goes; a lazy unmount takes what sits under it too
  'awk -v t="${1#"$FAKE_ROOT"}" -v lazy=$lazy \'{ l[NR] = $0; p[NR] = $2; if ($2 == t) top = NR }',
  '  END { for (i = 1; i <= NR; i++) if (i != top && !(lazy && index(p[i], t "/") == 1)) print l[i] }\' "$m" > "$m.x"',
  'mv "$m.x" "$m"',
  '',
].join('\n')
afterEach(() => rmSync(root, { recursive: true, force: true }))

const baseEnv = (): Record<string, string> => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  TALOS_WSL_ROOT: root,
  TALOS_WSL_UID: '1000',
  TALOS_WSL_GID: '1000',
  TALOS_WSL_MOUNT: join(bin, 'fake-mount'),
  TALOS_WSL_UMOUNT: join(bin, 'fake-umount'),
  TALOS_WSL_WSLINFO: join(bin, 'fake-wslinfo'),
  FAKE_ROOT: root,
  // the distro "started" after any wsl.conf a test writes, so what it says counts as applied
  TALOS_WSL_STARTED: String(Math.floor(Date.now() / 1000) + 3600),
})
function runWith(env: Record<string, string>, ...args: string[]) {
  const r = spawnSync('bash', [SCRIPT, ...args], { env: { ...baseEnv(), ...env }, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const run = (...args: string[]) => runWith({}, ...args)
const etc = (f: string) => readFileSync(join(root, 'etc', f), 'utf8')
const calls = () =>
  existsSync(join(root, '.calls')) ? readFileSync(join(root, '.calls'), 'utf8').trim().split('\n') : []
const fstabLines = () =>
  existsSync(join(root, 'etc', 'fstab'))
    ? etc('fstab')
        .split('\n')
        .filter((l) => l.includes('drvfs'))
    : []
const lastLine = (out: string) => out.trim().split('\n').at(-1)

describe('wsl.conf', () => {
  it('turns interop and automount off, systemd on, mounts what fstab lists, and logs in as talos', () => {
    expect(run('wsl-conf').code).toBe(0)
    const conf = etc('wsl.conf')
    for (const line of [
      '[boot]',
      'systemd=true',
      '[user]',
      'default=talos',
      '[interop]',
      'enabled=false',
      'appendWindowsPath=false',
      '[automount]',
      'mountFsTab=true',
    ])
      expect(conf.split('\n')).toContain(line)
    expect(conf).toMatch(/\[interop\]\nenabled=false/)
    expect(conf).toMatch(/\[automount\]\nenabled=false/)
  })

  it('keeps a wsl.conf it did not write, as a backup, and is a no-op the second time', () => {
    writeFileSync(join(root, 'etc', 'wsl.conf'), '[network]\nhostname=mine\n')
    expect(run('wsl-conf').code).toBe(0)
    expect(readFileSync(join(root, 'etc', 'wsl.conf.before-talos'), 'utf8')).toBe('[network]\nhostname=mine\n')
    const first = etc('wsl.conf')
    const again = run('wsl-conf')
    expect(again.code).toBe(0)
    expect(again.out).toContain('already')
    expect(etc('wsl.conf')).toBe(first)
  })
})

describe('isolation from Windows (R1-3, R2-1, R2-2, R2-4, R2-9: interop, drives, WSLg, the shared /mnt/wsl, networking)', () => {
  const ROOTFS = '/dev/sdc / ext4 rw,relatime 0 0\n'
  const SHARED_WSL = 'none /mnt/wsl tmpfs rw,relatime 0 0\n'
  const PRIVATE_WSL = 'talos-private /mnt/wsl tmpfs rw,relatime,size=64k,mode=755 0 0\n'
  const WSLG =
    'none /mnt/wslg tmpfs rw 0 0\n/dev/sdd /mnt/wslg/distro ext4 ro 0 0\nnone /mnt/wslg/run/user/1000 tmpfs rw 0 0\n' +
    'none /tmp/.X11-unix tmpfs ro 0 0\n'
  const mounts = () => readFileSync(join(root, 'proc', 'mounts'), 'utf8')
  function proc(o: { interop?: boolean; mounts?: string; wsl?: string; wslFile?: string } = {}) {
    rmSync(join(root, 'proc'), { recursive: true, force: true })
    rmSync(join(root, 'mnt'), { recursive: true, force: true })
    mkdirSync(join(root, 'proc', 'sys', 'fs', 'binfmt_misc'), { recursive: true })
    // interop: wsl.conf leaves it on (and WSL's entry is there); otherwise wsl.conf turns it off, as `wsl-conf` writes it
    writeFileSync(join(root, 'etc', 'wsl.conf'), o.interop ? '[boot]\nsystemd=true\n' : '[interop]\nenabled = False\n')
    if (o.interop) writeFileSync(join(root, 'proc', 'sys', 'fs', 'binfmt_misc', 'WSLInterop'), 'enabled\n')
    writeFileSync(join(root, 'proc', 'mounts'), ROOTFS + (o.wsl ?? PRIVATE_WSL) + (o.mounts ?? ''))
    mkdirSync(join(root, 'mnt', 'wsl'), { recursive: true })
    if (o.wslFile) writeFileSync(join(root, 'mnt', 'wsl', o.wslFile), 'x\n')
  }

  it('passes with all of them off (an empty /mnt/c folder is not a mount; a share at /mnt/win is fine)', () => {
    // with protected folders on record and ordinary shares mounted (found live: that made it exit 1 with no word)
    run('protect-add', 'C:\\Users\\alex\\Projects\\talos-app')
    proc({
      mounts:
        'C:\\134Users\\134alex\\134Projects\\134atlas /mnt/win/atlas 9p rw,aname=drvfs 0 0\n' +
        'C:\\134Users\\134alex\\134Projects\\134notes /mnt/win/notes 9p rw,aname=drvfs 0 0\n',
    })
    mkdirSync(join(root, 'mnt', 'c'), { recursive: true })
    const r = run('isolation')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
  })

  it('fails on interop, a mounted drive, any WSLg mount, the shared /mnt/wsl, mirrored networking, and says which', () => {
    const fails = (o: Parameters<typeof proc>[0], says: string, env: Record<string, string> = {}) => {
      proc(o)
      const r = runWith(env, 'isolation')
      expect(r.code, says).toBe(1)
      expect(r.err, says).toContain(says)
    }
    fails({ interop: true }, 'interop')
    fails({ mounts: 'C:\\134 /mnt/c 9p rw,noatime,aname=drvfs 0 0\n' }, '/mnt/c')
    fails({ mounts: 'none /mnt/wslg tmpfs rw 0 0\n' }, 'WSLg')
    fails({ mounts: 'none /mnt/wslg/run/user/1000 tmpfs rw 0 0\n' }, 'WSLg')
    fails({ mounts: '/dev/sdc /tmp/.X11-unix ext4 ro 0 0\n' }, 'WSLg')
    fails({ wsl: SHARED_WSL }, 'every distro shares')
    fails({ wslFile: 'docker-desktop-bind-mounts' }, 'more than')
    // R2-9: WSL's networking, at every check, not only at install
    fails({}, 'mirrored', { NETMODE: 'mirrored' })
    fails({}, 'cannot tell', { NETMODE: '' })
  })

  it("interop is what wsl.conf says, as WSL applied it at the distro's start; WSL's binfmt entry is no sign", () => {
    // WSL registers its .exe entry at start even with interop off (found live): with wsl.conf turning it off, it passes
    proc()
    writeFileSync(join(root, 'proc', 'sys', 'fs', 'binfmt_misc', 'WSLInterop'), 'enabled\n')
    writeFileSync(join(root, 'proc', 'sys', 'fs', 'binfmt_misc', 'WSLInterop-late'), 'enabled\n')
    expect(run('isolation').code).toBe(0)
    // a wsl.conf that says enabled=true last, or has no [interop] off at all, is interop on
    writeFileSync(join(root, 'etc', 'wsl.conf'), '[interop]\nenabled=false\n[interop]\nenabled=true\n')
    expect(run('isolation').err).toContain('interop is on')
    writeFileSync(join(root, 'etc', 'wsl.conf'), '[automount]\nenabled=false\n')
    expect(run('isolation').err).toContain('does not turn it off')
    // turned off, but after this start of the distro: not applied yet
    writeFileSync(join(root, 'etc', 'wsl.conf'), '[interop]\nenabled=false\n')
    expect(runWith({ TALOS_WSL_STARTED: '1000' }, 'isolation').err).toContain('counts only from its next start')
  })

  it("passes from a working directory the caller cannot read (found live: as talos from root's home it ended silently)", () => {
    proc()
    const dark = join(root, 'dark')
    mkdirSync(dark)
    // in it, then shut to everyone: as talos in root's home (0700)
    const r = spawnSync(
      'bash',
      ['-c', 'cd "$1" && chmod 0 . && bash "$2" isolation; s=$?; chmod 755 "$1"; exit $s', 'x', dark, SCRIPT],
      {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          TALOS_WSL_ROOT: root,
          TALOS_WSL_WSLINFO: join(bin, 'fake-wslinfo'),
          TALOS_WSL_STARTED: String(Math.floor(Date.now() / 1000) + 3600),
        },
        encoding: 'utf8',
      },
    )
    // macOS's bash warns about the unreadable folder itself as it starts, before the script runs ("shell-init: error
    // retrieving current directory: getcwd ...", "chdir: error retrieving current directory ..."): those lines are bash's,
    // not the script's. Nothing else may be there.
    const own = r.stderr
      .split('\n')
      .filter(
        (l) =>
          l !== '' &&
          !/^(shell-init|chdir|job-working-directory): error retrieving current directory: getcwd/.test(
            l.replace(/^\S*bash(: line \d+)?: /, ''),
          ),
      )
    expect(own).toEqual([])
    expect(r.status).toBe(0)
  })

  it("isolate-mounts never takes out or changes WSL's interop entry: it is one for the whole VM, the owner's other distros' too (R4-2)", () => {
    proc({ wsl: SHARED_WSL, mounts: WSLG })
    const bf = join(root, 'proc', 'sys', 'fs', 'binfmt_misc')
    writeFileSync(join(bf, 'register'), '')
    writeFileSync(join(bf, 'WSLInterop'), 'enabled\n')
    expect(run('isolate-mounts').code).toBe(0)
    expect(readFileSync(join(bf, 'WSLInterop'), 'utf8')).toBe('enabled\n')
    // there, it is left alone: nothing registered over it
    expect(readFileSync(join(bf, 'register'), 'utf8')).toBe('')
    // the script's only write under binfmt_misc is to `register`, and nothing writes the -1 that takes an entry out
    const script = readFileSync(SCRIPT, 'utf8')
    expect(script).not.toMatch(/>\s*"?\$?[^\s]*binfmt_misc/)
    expect([...script.matchAll(/>\s*"\$d\/([^"]*)"/g)].map((m) => m[1])).toEqual(['register'])
    expect(script).not.toMatch(/echo -1|printf[^\n]*-1/)
  })

  it("gives the interop entry back when WSL took it out at this distro's start (the other distros' .exe files)", () => {
    proc({ wsl: SHARED_WSL, mounts: WSLG })
    const bf = join(root, 'proc', 'sys', 'fs', 'binfmt_misc')
    writeFileSync(join(bf, 'register'), '')
    expect(run('isolate-mounts').code).toBe(0)
    // exactly as WSL's own systemd-binfmt drop-in registers it
    expect(readFileSync(join(bf, 'register'), 'utf8')).toBe(':WSLInterop:M::MZ::/init:P\n')
  })

  it('give-back-interop does the same on its own (uninstall.ps1 runs it before it stops the distro)', () => {
    const bf = join(root, 'proc', 'sys', 'fs', 'binfmt_misc')
    mkdirSync(bf, { recursive: true })
    writeFileSync(join(bf, 'register'), '')
    expect(run('give-back-interop').code).toBe(0)
    expect(readFileSync(join(bf, 'register'), 'utf8')).toBe(':WSLInterop:M::MZ::/init:P\n')
    writeFileSync(join(bf, 'register'), '')
    writeFileSync(join(bf, 'WSLInterop'), 'enabled\n')
    expect(run('give-back-interop').code).toBe(0)
    expect(readFileSync(join(bf, 'register'), 'utf8')).toBe('')
  })

  it('reads wsl.conf as WSL does: the last `enabled` wins, and only a literal false is off (R4-6)', () => {
    const conf = (text: string) => {
      proc()
      writeFileSync(join(root, 'etc', 'wsl.conf'), text)
      return run('isolation').code
    }
    expect(conf('[interop]\nenabled = false   # Talos\n')).toBe(0)
    expect(conf('[interop]\nenabled=FALSE\n')).toBe(0)
    expect(conf('[interop]\nenabled=true\nenabled=false\n')).toBe(0)
    for (const on of [
      'enabled=1',
      'enabled=0',
      'enabled=yes',
      'enabled=no',
      'enabled=fasle',
      'appendWindowsPath=false',
    ])
      expect(conf(`[interop]\n${on}\n`), on).toBe(1)
    expect(conf('[interop]\nenabled=false\n[interop]\nenabled=1\n')).toBe(1)
    expect(conf('[automount]\nenabled=false\n[interop]\n')).toBe(1)
    // only a # comment is cut, and spaces only around the key and the value (R5-1)
    expect(conf('[ interop ]\n  enabled   =   false  \n')).toBe(0)
    for (const on of ['en abled=false', 'enabled=fal se', 'enabled=false;x', 'enabled=false ; x'])
      expect(conf(`[interop]\n${on}\n`), on).toBe(1)
  })

  it('takes only /proc/mounts as proof of the private /mnt/wsl, never a file in it (R2-4)', () => {
    // the mark file of the round 1 version, in the shared /mnt/wsl: not proof
    proc({ wsl: SHARED_WSL, wslFile: '.talos-private' })
    expect(run('isolation').err).toContain('every distro shares')
    // the private tmpfs, then the shared one mounted over it again: what is on top counts
    proc({ wsl: PRIVATE_WSL + SHARED_WSL })
    expect(run('isolation').err).toContain('every distro shares')
    // a tmpfs that only calls itself talos-private but is not a tmpfs
    proc({ wsl: 'talos-private /mnt/wsl ext4 rw 0 0\n' })
    expect(run('isolation').err).toContain('every distro shares')
  })

  it('isolate-mounts makes every mount private, the parents first, before it unmounts or covers any (R2-1)', () => {
    proc({ wsl: SHARED_WSL, mounts: WSLG })
    // WSL's /etc/resolv.conf is a link to /mnt/wsl/resolv.conf (found live on Titan)
    writeFileSync(
      join(root, 'mnt', 'wsl', 'resolv.conf'),
      '# This file was automatically generated by WSL\nnameserver 10.255.255.254\nsearch lan\noptions edns0\n',
    )
    const r = run('isolate-mounts')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    const c = calls()
    const at = (call: string) => {
      const i = c.indexOf(call)
      expect(i, call).toBeGreaterThanOrEqual(0)
      return i
    }
    const firstUnmount = c.findIndex((l) => l.startsWith('umount'))
    // an unmount propagates through its PARENT's peer group: /mnt/wslg is private before any of its children goes
    for (const m of ['/mnt/wslg', '/mnt/wslg/distro', '/mnt/wslg/run/user/1000', '/tmp/.X11-unix'])
      expect(at(`mount --make-rprivate ${root}${m}`), m).toBeLessThan(firstUnmount)
    expect(at(`mount --make-rprivate ${root}/mnt/wslg`)).toBeLessThan(
      at(`mount --make-rprivate ${root}/mnt/wslg/distro`),
    )
    // deepest first, so no parent is busy
    expect(at(`umount -l ${root}/mnt/wslg/run/user/1000`)).toBeLessThan(at(`umount -l ${root}/mnt/wslg`))
    // /mnt/wsl: private, unmounted, then the private tmpfs, made private too
    const tmpfs = at(`mount -t tmpfs -o size=64k,mode=755 talos-private ${root}/mnt/wsl`)
    expect(at(`mount --make-rprivate ${root}/mnt/wsl`)).toBeLessThan(at(`umount -l ${root}/mnt/wsl`))
    expect(at(`umount -l ${root}/mnt/wsl`)).toBeLessThan(tmpfs)
    expect(tmpfs).toBeLessThan(at(`mount --make-private ${root}/mnt/wsl`))
    // what is mounted now, as the check after it read it: no WSLg, the private /mnt/wsl on top
    expect(mounts()).not.toMatch(/wslg|X11/)
    expect(mounts().trim().split('\n').at(-1)).toMatch(/^talos-private \/mnt\/wsl tmpfs /)
    expect(lastLine(r.out)).toMatch(/^isolated from Windows: /)
    expect(readFileSync(join(root, 'mnt', 'wsl', 'resolv.conf'), 'utf8')).toBe(
      'nameserver 10.255.255.254\nsearch lan\n',
    )
    // the second time there is nothing to do
    rmSync(join(root, '.calls'))
    expect(run('isolate-mounts').code).toBe(0)
    expect(calls()).toEqual([])
  })

  it("isolate-mounts adds WSL's NAT gateway as a second nameserver, the tunnel first, so a dead tunnel does not cut the relay", () => {
    proc({ wsl: SHARED_WSL })
    writeFileSync(join(root, 'mnt', 'wsl', 'resolv.conf'), 'nameserver 10.255.255.254\nsearch lan\n')
    // the route table as the kernel writes it: the default route via 172.21.32.1 (little-endian hex 01 20 15 AC; in
    // lowercase here, which is read the same)
    mkdirSync(join(root, 'proc', 'net'), { recursive: true })
    writeFileSync(
      join(root, 'proc', 'net', 'route'),
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
        'eth0\t00000000\t012015ac\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' +
        'eth0\t002015AC\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0\n',
    )
    const r = run('isolate-mounts')
    expect(r.code, r.err).toBe(0)
    expect(readFileSync(join(root, 'mnt', 'wsl', 'resolv.conf'), 'utf8')).toBe(
      'nameserver 10.255.255.254\nsearch lan\nnameserver 172.21.32.1\noptions timeout:2 attempts:2\n',
    )
    expect(lastLine(r.out)).toMatch(/^isolated from Windows: /)
  })

  it('isolate-mounts takes the default route with the lowest metric, as the kernel does (a VPN listed first)', () => {
    proc({ wsl: SHARED_WSL })
    writeFileSync(join(root, 'mnt', 'wsl', 'resolv.conf'), 'nameserver 10.255.255.254\n')
    mkdirSync(join(root, 'proc', 'net'), { recursive: true })
    writeFileSync(
      join(root, 'proc', 'net', 'route'),
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n' +
        'tun0\t00000000\t0100080A\t0003\t0\t0\t50\t00000000\n' +
        'eth0\t00000000\t012015AC\t0003\t0\t0\t0\t00000000\n',
    )
    expect(run('isolate-mounts').code).toBe(0)
    expect(readFileSync(join(root, 'mnt', 'wsl', 'resolv.conf'), 'utf8')).toBe(
      'nameserver 10.255.255.254\nnameserver 172.21.32.1\noptions timeout:2 attempts:2\n',
    )
  })

  it('isolate-mounts adds no second nameserver when WSL already names the gateway, or there is no default route', () => {
    for (const [conf, route] of [
      ['nameserver 172.21.32.1\n', 'Iface\tDestination\tGateway\neth0\t00000000\t012015AC\n'],
      ['nameserver 172.21.32.1 \n', 'Iface\tDestination\tGateway\neth0\t00000000\t012015ac\n'],
      ['nameserver 10.255.255.254\n', 'Iface\tDestination\tGateway\neth0\t002015AC\t00000000\n'],
    ] as const) {
      proc({ wsl: SHARED_WSL })
      writeFileSync(join(root, 'mnt', 'wsl', 'resolv.conf'), conf)
      mkdirSync(join(root, 'proc', 'net'), { recursive: true })
      writeFileSync(join(root, 'proc', 'net', 'route'), route)
      expect(run('isolate-mounts').code).toBe(0)
      expect(readFileSync(join(root, 'mnt', 'wsl', 'resolv.conf'), 'utf8')).toBe(conf)
    }
  })

  it('isolate-mounts unmounts nothing if a mount cannot be made private, and fails (R2-1)', () => {
    proc({ wsl: SHARED_WSL, mounts: WSLG })
    const r = runWith({ PRIVATE_FAILS: '1' }, 'isolate-mounts')
    expect(r.code).toBe(1)
    expect(r.err).toContain('could not make /mnt/wslg private; nothing was unmounted')
    expect(calls().filter((l) => l.startsWith('umount') || l.startsWith('mount -t'))).toEqual([])
  })

  it('isolate-mounts fails when the check after it still finds something (interop here), so the boot unit fails', () => {
    proc({ interop: true, wsl: SHARED_WSL, mounts: WSLG })
    const r = run('isolate-mounts')
    expect(r.code).toBe(1)
    expect(r.err).toContain('interop is on')
  })

  it("the boot units: isolation after WSL's own WSLg setup, and talos's user manager only after it (R2-2)", () => {
    const [isolate, gate] = run('units').out.split('----\n') as [string, string]
    const after = /^After=(.*)$/m.exec(isolate)?.[1]?.split(' ') ?? []
    // tmpfiles recreates /tmp/.X11-unix and WSL's generated wslg.service binds WSLg there again: both come first
    for (const u of ['systemd-tmpfiles-setup.service', 'wslg.service', 'tmp.mount', 'local-fs.target'])
      expect(after, u).toContain(u)
    expect(isolate).toMatch(/^Before=.*systemd-user-sessions\.service/m)
    expect(isolate).toContain('ExecStart=/opt/talos-wsl/talos-wsl.sh isolate-mounts')
    // the user manager (the supervisor runs in it) needs the unit to have succeeded, and checks isolation itself, as root
    expect(gate).toMatch(/^Requires=talos-isolate\.service$/m)
    expect(gate).toMatch(/^After=talos-isolate\.service$/m)
    expect(gate).toMatch(/^ExecStartPre=\+\/opt\/talos-wsl\/talos-wsl\.sh isolation$/m)
  })

  it('logins as talos are refused while isolation is broken; root still gets in (R3-2)', () => {
    const login = run('units').out.split('----\n')[2] ?? ''
    expect(login).toContain('if [ "$(id -u)" != 0 ] && ! /opt/talos-wsl/talos-wsl.sh isolation')
    expect(login).toMatch(/\n {2}exit 1\n/)
  })

  it('hold, what the keep-alive runs, ends at once and says why when isolation is broken (R3-2, R3-7)', () => {
    proc({ interop: true })
    const r = run('hold')
    expect(r.code).toBe(1)
    expect(r.err).toContain('refused: talos-wsl: interop is on')
  })

  it('hold keeps checking while it holds, and ends saying why once isolation breaks (R4-8)', async () => {
    proc()
    const { spawn } = await import('node:child_process')
    const child = spawn('bash', [SCRIPT, 'hold'], {
      env: { ...baseEnv(), TALOS_WSL_HOLD_CHECK_S: '0.2' },
    })
    let err = ''
    child.stderr.on('data', (d) => {
      err += String(d)
    })
    const ended = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
    await new Promise((r) => setTimeout(r, 600))
    expect(child.exitCode).toBeNull() // still holding
    mkdirSync(join(root, 'mnt', 'c'), { recursive: true })
    writeFileSync(
      join(root, 'proc', 'mounts'),
      `${readFileSync(join(root, 'proc', 'mounts'), 'utf8')}C:\\134 /mnt/c 9p rw 0 0\n`,
    )
    expect(await ended).toBe(1)
    expect(err).toContain('refused: talos-wsl: Windows drives are mounted: /mnt/c')
  })

  it('run -- <command> runs it only while isolated; a shell through the login check is refused while broken (R4-1, R4-5)', () => {
    proc()
    const ok = run('run', '--', 'sh', '-c', 'echo ran')
    expect(ok.code).toBe(0)
    expect(ok.out).toBe('ran\n')
    proc({ interop: true })
    const no = run('run', '--', 'sh', '-c', 'echo ran')
    expect(no.code).toBe(1)
    expect(no.out).toBe('')
    expect(no.err).toContain('refused: talos-wsl: interop is on')
    // the login check itself, sourced by a shell as /etc/profile.d would be, pointed at this script
    const parts = run('units').out.split('----\n')
    const login = (parts[2] ?? '').replaceAll('/opt/talos-wsl/talos-wsl.sh', `bash ${SCRIPT}`)
    writeFileSync(join(root, 'login.sh'), login)
    const shell = (env: Record<string, string>) =>
      spawnSync('bash', ['-c', `. "${join(root, 'login.sh')}"; echo "a shell"`], {
        env: { ...baseEnv(), ...env },
        encoding: 'utf8',
      })
    const refusedShell = shell({})
    expect(refusedShell.status).toBe(1)
    expect(refusedShell.stdout).toBe('')
    expect(refusedShell.stderr).toContain('does not let you in')
    proc()
    expect(shell({}).stdout).toBe('a shell\n')
    // claude, as Windows starts it (no login shell): the wrapper itself, run, pointed at this script (R5-3)
    const home = join(root, 'home-talos')
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    writeFileSync(join(home, '.local', 'bin', 'claude'), '#!/bin/sh\necho "the real claude: $*"\n', { mode: 0o755 })
    writeFileSync(join(root, 'claude'), (parts[3] ?? '').replaceAll('/opt/talos-wsl/talos-wsl.sh', `bash ${SCRIPT}`), {
      mode: 0o755,
    })
    const claude = () =>
      spawnSync(join(root, 'claude'), ['--version'], { env: { ...baseEnv(), HOME: home }, encoding: 'utf8' })
    expect(claude().stdout).toBe('the real claude: --version\n')
    proc({ interop: true })
    const shut = claude()
    expect(shut.status).toBe(1)
    expect(shut.stdout).toBe('')
    expect(shut.stderr).toContain('refused: talos-wsl: interop is on')
    // root-setup puts it at /usr/local/bin/claude, written by root (put_unit) and 755
    const sh = readFileSync(SCRIPT, 'utf8')
    expect(sh).toContain('put_unit claude_wrapper /usr/local/bin/claude')
    expect(sh).toContain('chmod 755 /usr/local/bin/claude')
  })

  it('says what it is not cut off from: the localhost of the other WSL distros (R3-3)', () => {
    proc()
    expect(run('isolation').out).toContain("localhost is still shared with this PC's other WSL distros")
  })
})

describe('a Windows folder for a thread', () => {
  const opts = 'rw,metadata,nofail,uid=1000,gid=1000,umask=022,fmask=011'

  it('is mounted first, then one drvfs line in fstab, owned by talos, at /mnt/win/<name>, with spaces escaped', () => {
    const r = run('folder-add', 'C:\\Users\\alex\\My Projects\\Atlas App')
    expect(r.code).toBe(0)
    expect(lastLine(r.out)).toBe('/mnt/win/atlas-app')
    expect(calls()).toEqual([
      `mount -t drvfs -o ${opts} C:\\Users\\alex\\My Projects\\Atlas App ${root}/mnt/win/atlas-app`,
    ])
    // nofail: a folder deleted on the Windows side must not stop the distro's start or its systemd user session
    expect(fstabLines()).toEqual([`C:/Users/alex/My\\040Projects/Atlas\\040App /mnt/win/atlas-app drvfs ${opts} 0 0`])
  })

  it('a folder that does not mount is not recorded, and its mount point goes (R1-8)', () => {
    const r = runWith({ MOUNT_FAILS: '1' }, 'folder-add', 'C:\\Users\\alex\\Projects\\gone')
    expect(r.code).not.toBe(0)
    expect(fstabLines()).toEqual([])
    expect(existsSync(join(root, 'mnt', 'win', 'gone'))).toBe(false)
  })

  it('--read-only mounts it ro (an agent cannot plant files there, git hooks included: R1-12)', () => {
    const r = run('folder-add', '--read-only', 'C:\\Users\\alex\\Projects\\atlas')
    expect(r.code).toBe(0)
    expect(r.out).toContain('read-only')
    expect(fstabLines()[0]).toContain(' drvfs ro,metadata,nofail,')
  })

  it('a stray trailing quote from a Windows argument is not part of the name (R1-8)', () => {
    expect(lastLine(run('folder-add', 'C:\\Users\\alex\\Projects\\atlas\\"').out)).toBe('/mnt/win/atlas')
    expect(fstabLines()[0]?.startsWith('C:/Users/alex/Projects/atlas ')).toBe(true)
  })

  it('the same folder twice is one line; another folder with the same name gets its own', () => {
    run('folder-add', 'C:\\Users\\alex\\Projects\\atlas')
    expect(lastLine(run('folder-add', 'c:\\users\\alex\\projects\\atlas\\').out)).toBe('/mnt/win/atlas')
    expect(fstabLines()).toHaveLength(1) // Windows paths fold case, and a trailing backslash is the same folder
    expect(lastLine(run('folder-add', 'D:\\Work\\atlas').out)).toBe('/mnt/win/atlas-2')
    expect(fstabLines()).toHaveLength(2)
  })

  it('a folder with spaces shared twice is still one line (found live on Titan: the escaped spaces did not compare)', () => {
    run('folder-add', 'C:\\Users\\Public\\Documents\\Talos E2E Test')
    const again = run('folder-add', 'C:\\Users\\Public\\Documents\\Talos E2E Test')
    expect(again.out).toContain('already shared')
    expect(lastLine(again.out)).toBe('/mnt/win/talos-e2e-test')
    expect(fstabLines()).toHaveLength(1)
  })

  it('refuses drives, system folders, profiles, secrets anywhere, and other spellings of them (R1-4)', () => {
    for (const bad of [
      'C:\\',
      'C:',
      'C:\\Windows',
      'c:\\WINDOWS\\System32',
      'C:\\Windows.old\\x',
      'C:\\Program Files\\App',
      'C:\\Program Files (x86)',
      'C:\\ProgramData\\x',
      'C:\\Documents and Settings\\alex',
      'C:\\Users',
      'C:\\Users\\alex',
      'C:\\Users\\All Users\\x',
      'C:\\Users\\alex\\AppData\\Roaming',
      'C:\\Users\\alex\\Application Data',
      'D:\\backup\\AppData\\Local',
      'C:\\Users\\alex\\.ssh',
      'C:\\Users\\alex\\Projects\\.aws',
      'D:\\keys\\.gnupg',
      'C:\\PROGRA~1\\App',
      'C:\\Users\\alex\\MYPROJ~1',
      'C:\\Users\\alex\\\\Projects',
      'C:\\Users\\alex\\Projects.',
      'C:\\Users\\alex\\Projects \\x',
      'relative\\path',
      '\\\\server\\share\\x',
      '\\\\?\\C:\\Users\\alex\\x',
      'C:\\Users\\alex\\..\\bob\\x',
    ]) {
      const r = run('folder-add', bad)
      expect(r.code, bad).not.toBe(0)
      expect(r.err, bad).not.toBe('')
    }
    expect(fstabLines()).toEqual([])
    expect(calls()).toEqual([])
  })

  it("refuses Talos's own files on the Windows side: a share that is one, holds one or sits inside one (R1-1)", () => {
    expect(run('protect-add', 'C:\\Users\\alex\\Projects\\talos-app').code).toBe(0)
    run('protect-add', 'C:\\Users\\alex\\Projects\\talos-app')
    expect(
      readFileSync(join(root, 'etc', 'talos-wsl', 'protected'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1)
    for (const bad of [
      'C:\\Users\\alex\\Projects\\talos-app',
      'c:\\users\\alex\\projects\\TALOS-APP\\apps\\windows',
      'C:\\Users\\alex\\Projects',
    ]) {
      const r = run('folder-add', bad)
      expect(r.code, bad).not.toBe(0)
    }
    expect(calls()).toEqual([])
    // a sibling is fine, and so is a folder whose name only starts the same
    expect(run('folder-add', 'C:\\Users\\alex\\Projects\\atlas').code).toBe(0)
    expect(run('folder-add', 'C:\\Users\\alex\\Projects\\talos-app-notes').code).toBe(0)
  })

  it('protecting a folder already shared takes the share out: an install over an older one leaves none (R2-5)', () => {
    run('folder-add', 'C:\\Users\\alex\\Projects\\talos-app\\docs')
    run('folder-add', 'C:\\Users\\alex\\Projects\\atlas')
    const r = run('protect-add', 'c:\\users\\alex\\projects\\TALOS-APP')
    expect(r.code).toBe(0)
    expect(r.out).toContain('it was shared at /mnt/win/docs; no longer')
    expect(calls()).toContain(`umount ${root}/mnt/win/docs`)
    expect(fstabLines().map((l) => l.split(' ')[1])).toEqual(['/mnt/win/atlas'])
  })

  describe('shared again in the other mode (R2-3)', () => {
    const W = 'C:\\Users\\alex\\Projects\\atlas'
    const ro = opts.replace(/^rw,/, 'ro,')
    it('read-write, then --read-only: mounted again read-only, and fstab says so', () => {
      run('folder-add', W)
      rmSync(join(root, '.calls'))
      const r = run('folder-add', '--read-only', W)
      expect(r.code).toBe(0)
      expect(r.out).toContain('(read-only), was read-write')
      expect(lastLine(r.out)).toBe('/mnt/win/atlas')
      // not lazy: a folder in use is refused, not left writable behind a read-only mount point
      expect(calls()).toEqual([`umount ${root}/mnt/win/atlas`, `mount -t drvfs -o ${ro} ${W} ${root}/mnt/win/atlas`])
      expect(fstabLines()).toEqual([`C:/Users/alex/Projects/atlas /mnt/win/atlas drvfs ${ro} 0 0`])
    })
    it('read-only, then read-write: mounted again read-write', () => {
      run('folder-add', '--read-only', W)
      const r = run('folder-add', W)
      expect(r.out).toContain('(read-write), was read-only')
      expect(fstabLines()).toEqual([`C:/Users/alex/Projects/atlas /mnt/win/atlas drvfs ${opts} 0 0`])
    })
    it('the same mode again changes nothing', () => {
      run('folder-add', '--read-only', W)
      rmSync(join(root, '.calls'))
      expect(run('folder-add', '--read-only', W).out).toContain('already shared (read-only)')
      expect(calls()).toEqual([])
    })
    it('a folder in use is refused loudly and stays as it was', () => {
      run('folder-add', W)
      const r = runWith({ UMOUNT_FAILS: '1' }, 'folder-add', '--read-only', W)
      expect(r.code).toBe(1)
      expect(r.err).toContain('could not unmount')
      expect(r.err).toContain('so it stays read-write')
      expect(fstabLines()).toEqual([`C:/Users/alex/Projects/atlas /mnt/win/atlas drvfs ${opts} 0 0`])
    })
    it('a new mode that does not mount puts the old one back and says so', () => {
      run('folder-add', W)
      rmSync(join(root, '.calls'))
      const r = runWith({ MOUNT_FAIL_RO: '1' }, 'folder-add', '--read-only', W)
      expect(r.code).toBe(1)
      expect(r.err).toContain('it is mounted read-write again, as before')
      expect(calls().at(-1)).toBe(`mount -t drvfs -o ${opts} ${W} ${root}/mnt/win/atlas`)
      expect(fstabLines()[0]).toContain(` drvfs ${opts} `)
    })
    it('when the old mode does not mount again either, it says it is not mounted now, not that it stays (R3-6)', () => {
      run('folder-add', W)
      const r = runWith({ MOUNT_FAILS: '1' }, 'folder-add', '--read-only', W)
      expect(r.code).toBe(1)
      expect(r.err).toContain('it is not mounted now; fstab still shares it read-write')
      expect(r.err).not.toContain('again, as before')
      expect(fstabLines()[0]).toContain(` drvfs ${opts} `)
    })
  })

  describe('a mode change that would overlap a share in the other mode (R4-3)', () => {
    it('a read-only parent made read-write, over a read-only child, is refused', () => {
      run('folder-add', '--read-only', 'C:\\Users\\alex\\Projects\\atlas\\docs')
      run('folder-add', '--read-only', 'C:\\Users\\alex\\Projects\\atlas')
      const r = run('folder-add', 'C:\\Users\\alex\\Projects\\atlas')
      expect(r.code).toBe(1)
      expect(r.err).toContain('is shared read-only at /mnt/win/docs')
      expect(fstabLines().every((l) => l.includes(' drvfs ro,'))).toBe(true)
    })
    it('a read-write child made read-only, inside a read-write parent, is refused', () => {
      run('folder-add', 'C:\\Users\\alex\\Projects\\atlas')
      run('folder-add', 'C:\\Users\\alex\\Projects\\atlas\\docs')
      const r = run('folder-add', '--read-only', 'C:\\Users\\alex\\Projects\\atlas\\docs')
      expect(r.code).toBe(1)
      expect(r.err).toContain('is shared read-write at /mnt/win/atlas')
      expect(fstabLines().every((l) => l.includes(' drvfs rw,'))).toBe(true)
    })
    it('a share alone changes mode as before (it is not in its own way)', () => {
      run('folder-add', 'C:\\Users\\alex\\Projects\\atlas')
      expect(run('folder-add', '--read-only', 'C:\\Users\\alex\\Projects\\atlas').code).toBe(0)
    })
  })

  describe('a share of a parent or child in the other mode (R3-4)', () => {
    it('a read-write share holding a read-only one is refused, naming it', () => {
      run('folder-add', '--read-only', 'C:\\Users\\alex\\Projects\\atlas\\docs')
      const r = run('folder-add', 'C:\\Users\\alex\\Projects\\atlas')
      expect(r.code).toBe(1)
      expect(r.err).toContain('C:\\Users\\alex\\Projects\\atlas\\docs is shared read-only at /mnt/win/docs')
      expect(fstabLines()).toHaveLength(1)
    })
    it('a read-write share inside a read-only one is refused too', () => {
      run('folder-add', '--read-only', 'C:\\Users\\alex\\Projects\\atlas')
      expect(run('folder-add', 'C:\\Users\\alex\\Projects\\atlas\\docs').code).toBe(1)
    })
    it('a read-only share inside a read-write one is refused: it would be writable through the parent', () => {
      run('folder-add', 'C:\\Users\\alex\\Projects\\atlas')
      const r = run('folder-add', '--read-only', 'C:\\Users\\alex\\Projects\\atlas\\docs')
      expect(r.code).toBe(1)
      expect(r.err).toContain('is shared read-write at /mnt/win/atlas')
    })
    it('the same mode overlapping is fine, and so is a sibling in the other mode', () => {
      run('folder-add', 'C:\\Users\\alex\\Projects\\atlas')
      expect(run('folder-add', 'C:\\Users\\alex\\Projects\\atlas\\docs').code).toBe(0)
      expect(run('folder-add', '--read-only', 'C:\\Users\\alex\\Projects\\atlas-notes').code).toBe(0)
    })
  })

  describe('a share that cannot be unmounted (R3-1)', () => {
    it('folder-remove refuses, says so, and keeps its fstab line: never "no longer shared" while it is live', () => {
      run('folder-add', 'C:\\Users\\alex\\Projects\\atlas')
      const r = runWith({ UMOUNT_FAILS: '1' }, 'folder-remove', '/mnt/win/atlas')
      expect(r.code).toBe(1)
      expect(r.err).toContain('is in use in the distro')
      expect(r.out).not.toContain('no longer shared')
      expect(fstabLines()).toHaveLength(1)
    })
    it('one that is not mounted at all (its folder deleted on Windows) is removed', () => {
      run('folder-add', 'C:\\Users\\alex\\Projects\\atlas')
      mkdirSync(join(root, 'proc'), { recursive: true })
      writeFileSync(join(root, 'proc', 'mounts'), '/dev/sdc / ext4 rw 0 0\n')
      const r = runWith({ UMOUNT_FAILS: '1' }, 'folder-remove', '/mnt/win/atlas')
      expect(r.code).toBe(0)
      expect(fstabLines()).toEqual([])
    })
    it('protect-add over a share in use takes its line out, says it stays mounted until a restart, and exits 3', () => {
      run('folder-add', 'C:\\Users\\alex\\Projects\\talos-app\\docs')
      const r = runWith({ UMOUNT_FAILS: '1' }, 'protect-add', 'C:\\Users\\alex\\Projects\\talos-app')
      expect(r.code).toBe(3)
      expect(r.out).toContain('stays mounted until the distro restarts')
      expect(r.out).not.toContain('; no longer')
      expect(fstabLines()).toEqual([])
    })
    it('isolation refuses while a share of a protected folder is still mounted', () => {
      run('protect-add', 'C:\\Users\\alex\\Projects\\talos-app')
      mkdirSync(join(root, 'proc', 'sys', 'fs', 'binfmt_misc'), { recursive: true })
      mkdirSync(join(root, 'mnt', 'wsl'), { recursive: true })
      writeFileSync(
        join(root, 'proc', 'mounts'),
        '/dev/sdc / ext4 rw 0 0\ntalos-private /mnt/wsl tmpfs rw 0 0\n' +
          'C:\\134Users\\134alex\\134Projects\\134talos-app\\134docs /mnt/win/docs 9p rw,aname=drvfs 0 0\n',
      )
      const r = run('isolation')
      expect(r.code).toBe(1)
      expect(r.err).toContain("a share of Talos's own files is still mounted: /mnt/win/docs")
    })
  })

  it('leaves every other fstab line alone, and remove unmounts and takes out only its own', () => {
    writeFileSync(join(root, 'etc', 'fstab'), 'LABEL=cloudimg-rootfs / ext4 defaults 0 1\n')
    run('folder-add', 'C:\\Users\\alex\\Projects\\atlas')
    run('folder-add', 'C:\\Users\\alex\\Projects\\notes')
    expect(run('folder-remove', '/mnt/win/atlas').code).toBe(0)
    expect(calls().some((l) => l.startsWith('umount') && l.endsWith(`${root}/mnt/win/atlas`))).toBe(true)
    expect(etc('fstab')).toContain('LABEL=cloudimg-rootfs / ext4 defaults 0 1')
    expect(fstabLines().map((l) => l.split(' ')[1])).toEqual(['/mnt/win/notes'])
    expect(run('folder-remove', '/mnt/win/nothing-here').code).not.toBe(0)
  })

  it('folder-list prints each mounted Windows folder and where it is', () => {
    run('folder-add', 'C:\\Users\\alex\\Projects\\atlas')
    expect(run('folder-list').out.trim()).toBe('/mnt/win/atlas\tC:\\Users\\alex\\Projects\\atlas')
  })
})

describe('the status the tray reads every 30 s (Windows step 2; Fable R1-1, R1-2 on edb035b3)', () => {
  // stand-ins on PATH: runuser (the tray asks systemd, as talos, about the supervisor: $FAKE_STATE, after $FAKE_DELAY s;
  // and reads Main's state file as talos: $FAKE_MAIN), id (talos is uid 1000 here), and systemctl and loginctl that write
  // down what they were asked (the agent stopped when the distro is not cut off from Windows)
  const withState = (state: string, exit = 0, main?: string, delay = 0) => {
    writeFileSync(
      join(bin, 'runuser'),
      `#!/bin/sh\n[ "$FAKE_DELAY" = 0 ] || sleep "$FAKE_DELAY"\ncase "$*" in *head*) [ -n "$FAKE_MAIN" ] && echo "$FAKE_MAIN"; exit 0 ;; esac\necho "$FAKE_STATE"\nexit ${exit}\n`,
      { mode: 0o755 },
    )
    writeFileSync(
      join(bin, 'id'),
      '#!/bin/sh\n[ "$1 $2" = "-u talos" ] && { echo 1000; exit 0; }\nexec /usr/bin/id "$@"\n',
      {
        mode: 0o755,
      },
    )
    for (const c of ['systemctl', 'loginctl'])
      writeFileSync(join(bin, `fake-${c}`), `#!/bin/sh\necho "${c} $*" >> "$TALOS_WSL_ROOT/.stops"\n`, { mode: 0o755 })
    return {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      FAKE_STATE: state,
      FAKE_MAIN: main ?? '',
      FAKE_DELAY: String(delay),
      TALOS_WSL_SYSTEMCTL: join(bin, 'fake-systemctl'),
      TALOS_WSL_LOGINCTL: join(bin, 'fake-loginctl'),
    }
  }
  const stops = () =>
    existsSync(join(root, '.stops')) ? readFileSync(join(root, '.stops'), 'utf8').trim().split('\n') : []
  const proc = (o: { interop?: boolean } = {}) => {
    mkdirSync(join(root, 'proc', 'sys', 'fs', 'binfmt_misc'), { recursive: true })
    writeFileSync(join(root, 'etc', 'wsl.conf'), o.interop ? '[boot]\nsystemd=true\n' : '[interop]\nenabled=false\n')
    writeFileSync(join(root, 'proc', 'mounts'), '/dev/sdc / ext4 rw 0 0\ntalos-private /mnt/wsl tmpfs rw 0 0\n')
    mkdirSync(join(root, 'mnt', 'wsl'), { recursive: true })
  }

  it.skipIf(linuxOnly)('isolation first, on a line of its own, then the supervisor and Main (Linux)', () => {
    proc()
    const r = runWith(withState('active'), 'status')
    expect(r.code).toBe(0)
    expect(r.out).toBe('isolated=yes\nsupervisor=active main=unknown launch=unknown\n')
    expect(stops()).toEqual([])
  })

  it.skipIf(linuxOnly)('a supervisor restarting or stopped, as systemd names it (Linux)', () => {
    proc()
    expect(runWith(withState('activating', 3), 'status').out).toBe(
      'isolated=yes\nsupervisor=activating main=unknown launch=unknown\n',
    )
    expect(runWith(withState('inactive', 3), 'status').out).toBe(
      'isolated=yes\nsupervisor=inactive main=unknown launch=unknown\n',
    )
    expect(runWith(withState('failed', 3), 'status').out).toBe(
      'isolated=yes\nsupervisor=failed main=unknown launch=unknown\n',
    )
  })

  it.skipIf(linuxOnly)(
    'not cut off from Windows: says so first, and stops the agent (its user manager and its logins), as root (Linux)',
    () => {
      proc({ interop: true })
      const r = runWith(withState('active'), 'status')
      expect(r.code).toBe(0)
      expect(r.out.split('\n')[0]).toBe('isolated=no')
      expect(stops()).toEqual([`systemctl stop --no-block user${'@'}1000.service`, 'loginctl terminate-user talos'])
    },
  )

  it.skipIf(linuxOnly)('hold stops the agent too before it ends, saying why (Linux)', () => {
    proc({ interop: true })
    const r = runWith(withState('active'), 'hold')
    expect(r.code).toBe(1)
    expect(r.err).toContain('refused: ')
    expect(stops()).toEqual([`systemctl stop --no-block user${'@'}1000.service`, 'loginctl terminate-user talos'])
  })

  it.skipIf(linuxOnly)(
    'a stalled user manager (the agent can SIGSTOP its own) is "unknown" within seconds, and isolation still comes first (Linux)',
    () => {
      proc({ interop: true })
      const t = Date.now()
      const r = runWith(withState('active', 0, 'main=running', 20), 'status')
      expect(Date.now() - t).toBeLessThan(8000)
      expect(r.out).toBe('isolated=no\nsupervisor=unknown main=unknown launch=unknown\n')
    },
    15000,
  )

  it.skipIf(linuxOnly)('an answer it cannot read is "unknown", never a word the tray would trust (Linux)', () => {
    proc()
    expect(runWith(withState('active; rm -rf /'), 'status').out).toBe(
      'isolated=yes\nsupervisor=unknown main=unknown launch=unknown\n',
    )
    expect(runWith(withState(''), 'status').out).toBe('isolated=yes\nsupervisor=unknown main=unknown launch=unknown\n')
  })

  it.skipIf(linuxOnly)(
    "Main's own state, read as talos, in the supervisor's words only (the tray's \"not signed in\") (Linux)",
    () => {
      proc()
      const line = (main: string) => runWith(withState('active', 0, main), 'status').out
      expect(line('main=signin')).toBe('isolated=yes\nsupervisor=active main=signin launch=unknown\n')
      expect(line('main=running')).toBe('isolated=yes\nsupervisor=active main=running launch=unknown\n')
      expect(line('main=waiting:trust')).toBe('isolated=yes\nsupervisor=active main=waiting:trust launch=unknown\n')
      expect(line('main=waiting:rm -rf')).toBe('isolated=yes\nsupervisor=active main=unknown launch=unknown\n')
      expect(line('running')).toBe('isolated=yes\nsupervisor=active main=unknown launch=unknown\n')
    },
  )

  it("each status gives WSL's interop entry back to the other distros, but only while cut off from Windows (R3-6)", () => {
    proc()
    const bf = join(root, 'proc', 'sys', 'fs', 'binfmt_misc')
    writeFileSync(join(bf, 'register'), '')
    expect(runWith(withState('active'), 'status').out.split('\n')[0]).toBe('isolated=yes')
    expect(readFileSync(join(bf, 'register'), 'utf8')).toBe(':WSLInterop:M::MZ::/init:P\n')
    proc({ interop: true })
    writeFileSync(join(bf, 'register'), '')
    expect(runWith(withState('active'), 'status').out.split('\n')[0]).toBe('isolated=no')
    expect(readFileSync(join(bf, 'register'), 'utf8')).toBe('')
  })

  it("systemd-binfmt never unregisters WSL's entries at this distro's shutdown, and its start gives the entry back", () => {
    const units = run('units').out.split('----\n')
    const dropin = units[units.length - 1]
    expect(dropin).toMatch(/^\[Service\]$/m)
    expect(dropin).toMatch(/^ExecStop=$/m)
    expect(dropin).toMatch(/^ExecStart=$/m)
    expect(dropin).toMatch(/^ExecStart=\/opt\/talos-wsl\/talos-wsl\.sh give-back-interop$/m)
    expect(readFileSync(SCRIPT, 'utf8')).toContain(
      'put_unit binfmt_dropin /etc/systemd/system/systemd-binfmt.service.d/talos.conf',
    )
  })

  it('in the test root, the stop commands default to `true`: a test never stops the real machine', () => {
    const sh = readFileSync(SCRIPT, 'utf8')
    expect(sh).toMatch(/SYSTEMCTL="\$\{TALOS_WSL_SYSTEMCTL:-\$\(\[ -n "\$R" \] && echo true \|\| echo systemctl\)\}"/)
    expect(sh).toMatch(/LOGINCTL="\$\{TALOS_WSL_LOGINCTL:-\$\(\[ -n "\$R" \] && echo true \|\| echo loginctl\)\}"/)
  })
})

// The update of the distro's checkout to the release Setup carries (setup-user.sh update_repo), run on its own against real git
// repositories: a plain fast-forward, a checkout with a commit of its own, uncommitted edits, and no checkout yet.
describe('setup-user.sh: the checkout becomes the release, keeping what it had of its own', () => {
  const sh = readFileSync(join(ROOT, 'apps', 'windows', 'distro', 'setup-user.sh'), 'utf8')
  const fn = sh.slice(sh.indexOf('# >>> update_repo'), sh.indexOf('# <<< update_repo'))
  const g = (cwd: string, ...a: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' })
  /** a release repo with two commits, its bundle at the second, and a checkout of the first */
  function world() {
    const t = mkdtempSync(join(tmpdir(), 'upd-repo-'))
    made.push(t)
    const src = join(t, 'src')
    mkdirSync(src)
    g(src, 'init', '-q', '-b', 'main')
    writeFileSync(join(src, 'a.txt'), 'one\n')
    g(src, 'add', '-A')
    g(src, 'commit', '-qm', 'one')
    const repo = join(t, 'talos-app')
    g(t, 'clone', '-q', src, repo)
    writeFileSync(join(src, 'a.txt'), 'two\n')
    g(src, 'commit', '-qam', 'two')
    const bundle = join(t, 'talos-src.bundle')
    g(src, 'bundle', 'create', '-q', bundle, 'HEAD', 'main')
    const release = g(src, 'rev-parse', 'HEAD').stdout.trim()
    return { t, repo, bundle, release }
  }
  const made: string[] = []
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  /** the function alone, as setup-user.sh runs it (set -euo pipefail), with no git identity or global config of the runner's */
  const update = (repo: string, bundle: string, dry = '0') => {
    const home = mkdtempSync(join(tmpdir(), 'upd-home-'))
    made.push(home)
    return spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail\nrun() { if [ "$DRY" = 1 ]; then echo "would run: $1"; else "$@"; fi; }\nDRY="$3" REPO="$1" BUNDLE="$2"\n${fn}\nupdate_repo`,
        'x',
        repo,
        bundle,
        dry,
      ],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      },
    )
  }
  const isRelease = (w: ReturnType<typeof world>) => {
    expect(g(w.repo, 'rev-parse', 'HEAD').stdout.trim()).toBe(w.release)
    expect(g(w.repo, 'status', '--porcelain').stdout).toBe('')
  }
  it('fast-forwards a checkout that is only behind, and says nothing', () => {
    const w = world()
    const r = update(w.repo, w.bundle)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('')
    expect(g(w.repo, 'rev-parse', 'HEAD').stdout.trim()).toBe(w.release)
  })
  it('a checkout with a commit of its own becomes the release, and that commit is kept on a talos-before branch', () => {
    const w = world()
    writeFileSync(join(w.repo, 'b.txt'), 'mine\n')
    g(w.repo, 'add', '-A')
    g(w.repo, 'commit', '-qm', 'a commit in the distro')
    const mine = g(w.repo, 'rev-parse', 'HEAD').stdout.trim()
    const r = update(w.repo, w.bundle)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/had changes of its own: they are kept \(branch talos-before-\d{8}-\d{6}/)
    expect(g(w.repo, 'rev-parse', 'HEAD').stdout.trim()).toBe(w.release)
    const kept = g(w.repo, 'branch', '--list', 'talos-before-*', '--format=%(objectname)').stdout.trim()
    expect(kept).toBe(mine)
  })
  it('uncommitted edits are kept in a stash, and the work tree is the release', () => {
    const w = world()
    writeFileSync(join(w.repo, 'a.txt'), 'edited, not committed\n')
    writeFileSync(join(w.repo, 'new.txt'), 'untracked\n')
    const r = update(w.repo, w.bundle)
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(join(w.repo, 'a.txt'), 'utf8')).toBe('two\n')
    expect(g(w.repo, 'status', '--porcelain').stdout).toBe('')
    expect(g(w.repo, 'stash', 'list').stdout).toMatch(/talos-before-\d{8}-\d{6}/)
    // the stash really holds both edits
    expect(g(w.repo, 'stash', 'show', '--include-untracked', '--name-only', 'stash@{0}').stdout).toMatch(
      /a\.txt[\s\S]*new\.txt/,
    )
  })
  it('a merge left half-done with a conflict is given up, its commit kept, and the checkout is the release (Fable)', () => {
    const w = world()
    g(w.repo, 'checkout', '-qb', 'side')
    writeFileSync(join(w.repo, 'a.txt'), 'side\n')
    g(w.repo, 'commit', '-qam', 'side')
    g(w.repo, 'checkout', '-q', '-')
    writeFileSync(join(w.repo, 'a.txt'), 'main side\n')
    g(w.repo, 'commit', '-qam', 'main side')
    expect(g(w.repo, 'merge', 'side').status).not.toBe(0) // a conflict: the merge stays in progress
    const r = update(w.repo, w.bundle)
    expect(r.status, r.stderr).toBe(0)
    isRelease(w)
    expect(g(w.repo, 'branch', '--list', 'talos-before-*').stdout).toMatch(/talos-before-/)
  })
  it('a lock left by a git that died does not stop it (Fable)', () => {
    const w = world()
    writeFileSync(join(w.repo, '.git', 'index.lock'), '')
    const r = update(w.repo, w.bundle)
    expect(r.status, r.stderr).toBe(0)
    isRelease(w)
  })
  it('a checkout ahead of the release (commits on top of it) becomes the release, those commits kept (Fable)', () => {
    const w = world()
    g(w.repo, 'pull', '-q', w.bundle, 'main')
    writeFileSync(join(w.repo, 'c.txt'), 'on top\n')
    g(w.repo, 'add', '-A')
    g(w.repo, 'commit', '-qm', 'on top of the release')
    const mine = g(w.repo, 'rev-parse', 'HEAD').stdout.trim()
    const r = update(w.repo, w.bundle)
    expect(r.status, r.stderr).toBe(0)
    isRelease(w)
    expect(g(w.repo, 'branch', '--list', 'talos-before-*', '--format=%(objectname)').stdout.trim()).toBe(mine)
  })
  it('an edit to a file the release does not touch is kept, not built (a fast-forward alone would leave it) (Fable)', () => {
    const w = world()
    writeFileSync(join(w.repo, 'untouched.txt'), 'x\n')
    g(w.repo, 'add', '-A')
    g(w.repo, 'commit', '-qm', 'a file the release lacks')
    g(w.repo, 'reset', '-q', '--hard', 'HEAD~1')
    writeFileSync(join(w.repo, 'later.txt'), 'edited\n') // untracked, and the release never names it
    const r = update(w.repo, w.bundle)
    expect(r.status, r.stderr).toBe(0)
    isRelease(w)
    expect(existsSync(join(w.repo, 'later.txt'))).toBe(false)
    expect(g(w.repo, 'stash', 'list').stdout).toMatch(/talos-before-/)
  })
  it('a dry run changes nothing and says what it would do', () => {
    const w = world()
    const before = g(w.repo, 'rev-parse', 'HEAD').stdout.trim()
    const r = update(w.repo, w.bundle, '1')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('would make')
    expect(g(w.repo, 'rev-parse', 'HEAD').stdout.trim()).toBe(before)
  })
  it('with no checkout yet, clones the release', () => {
    const w = world()
    const fresh = join(w.t, 'fresh')
    const r = update(fresh, w.bundle)
    expect(r.status, r.stderr).toBe(0)
    expect(g(fresh, 'rev-parse', 'HEAD').stdout.trim()).toBe(w.release)
  })
})

describe('setup-user.sh: what it downloads (R1-6)', () => {
  const sh = readFileSync(join(ROOT, 'apps', 'windows', 'distro', 'setup-user.sh'), 'utf8')
  it('pins every download to a SHA-256 written in the script, and runs no script from the network', () => {
    for (const tool of ['NODE', 'BUN', 'PNPM', 'CLAUDE', 'CHRONOS'])
      expect(sh, tool).toMatch(new RegExp(`^${tool}_SHA256=[0-9a-f]{64} `, 'm'))
    expect(sh).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/)
    expect(sh).not.toMatch(/SHASUMS|^\s*(run )?npm /m)
    // Claude Code's own install step is told the pinned version, not left to pick "latest" (R2-6)
    expect(sh).toMatch(/"\$d\/claude" install "\$CLAUDE_VERSION"/)
    // and it stays that version (R3-8): the auto-updater is off for sessions and in Claude Code's own settings
    expect(sh).toContain("'export DISABLE_AUTOUPDATER=1'")
    expect(sh).toContain("env['DISABLE_AUTOUPDATER'] = '1'")
    // every curl is the one inside fetch_pinned
    expect(sh.match(/\bcurl /g)).toHaveLength(1)
  })
  it('pins the pnpm that package.json names', () => {
    const pm = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).packageManager
    expect(`pnpm@${/^PNPM_VERSION=([\d.]+)/m.exec(sh)?.[1]}`).toBe(pm)
  })
})

// Chronos in the distro (setup-user.sh install_chronos), run on its own: the download is a stand-in tarball, its install.sh
// and bin/chronos stand-ins that write down how they were run. Real tar, real files.
describe("setup-user.sh: Chronos, pinned, with a fresh install's jobs Talos's to run", () => {
  const sh = readFileSync(join(ROOT, 'apps', 'windows', 'distro', 'setup-user.sh'), 'utf8')
  const fn = sh.slice(sh.indexOf('# >>> install_chronos'), sh.indexOf('# <<< install_chronos'))
  const commit = /^CHRONOS_COMMIT=([0-9a-f]{40}) /m.exec(sh)?.[1] ?? ''
  const made: string[] = []
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  /** a home, and a tarball laid out as codeload's: chronos-<commit>/install.sh, whose stand-in makes what install.sh makes */
  function world() {
    const t = mkdtempSync(join(tmpdir(), 'chronos-'))
    made.push(t)
    const home = join(t, 'home')
    mkdirSync(home)
    const src = join(t, 'src', `chronos-${commit}`)
    mkdirSync(join(src, 'bin'), { recursive: true })
    writeFileSync(
      join(src, 'install.sh'),
      '#!/bin/sh\necho "install.sh $*" >> "$HOME/.ran"\nmkdir -p "$HOME/.local/share/chronos/bin" "$HOME/.config/chronos"\n' +
        '[ -f "$HOME/.config/chronos/jobs.json" ] || echo "[]" > "$HOME/.config/chronos/jobs.json"\n' +
        'cp "$(dirname "$0")/bin/chronos" "$HOME/.local/share/chronos/bin/chronos"\n',
      { mode: 0o755 },
    )
    writeFileSync(
      join(src, 'bin', 'chronos'),
      '#!/bin/sh\necho "chronos $*" >> "$HOME/.ran"\necho \'{"ok": true}\'\n',
      {
        mode: 0o755,
      },
    )
    const tgz = join(t, 'chronos.tgz')
    expect(spawnSync('tar', ['-czf', tgz, '-C', join(t, 'src'), `chronos-${commit}`]).status).toBe(0)
    return { t, home, tgz }
  }
  const install = (w: ReturnType<typeof world>, dry = '0') =>
    spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail\nrun() { if [ "$DRY" = 1 ]; then echo "would run: $1"; else "$@"; fi; }\n` +
          `fetch_pinned() { echo "fetch $1 $2" >> "$HOME/.ran"; cp "$TGZ" "$3"; }\n` +
          `DRY="$1" CHRONOS_COMMIT=${commit} CHRONOS_SHA256=abc\n${fn}\ninstall_chronos`,
        'x',
        dry,
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: w.home, TGZ: w.tgz } },
    )
  const ran = (w: ReturnType<typeof world>) => {
    const p = join(w.home, '.ran')
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }
  const SWITCH = 'chronos api config set session_runner talos approval_required true\n'

  it('a fresh install: the pinned tarball from codeload, its install.sh as on a Mac, then its jobs handed to Talos', () => {
    const w = world()
    const r = install(w)
    expect(r.status, r.stderr).toBe(0)
    expect(ran(w)).toBe(
      `fetch https://codeload.github.com/treynortetik-creator/chronos/tar.gz/${commit} abc\n` +
        `install.sh --quiet --no-ui --workspace ${w.home}/chronos-workspace\n` +
        SWITCH,
    )
    expect(r.stdout).toBe('Chronos: set up for Talos\n')
  })

  it('a second run changes nothing', () => {
    const w = world()
    expect(install(w).status).toBe(0)
    const before = ran(w)
    const r = install(w)
    expect(r.status, r.stderr).toBe(0)
    expect(ran(w)).toBe(before)
    expect(r.stdout).toBe('')
  })

  it('jobs the owner already had are left as they are: installed, but never switched', () => {
    const w = world()
    mkdirSync(join(w.home, '.config', 'chronos'), { recursive: true })
    writeFileSync(join(w.home, '.config', 'chronos', 'jobs.json'), '[{"id":"mine"}]\n')
    expect(install(w).status).toBe(0)
    expect(ran(w)).toContain('install.sh ')
    expect(ran(w)).not.toContain('config set')
  })

  it('a run stopped between the install and the switch makes the switch on the next run', () => {
    const w = world()
    // the switch fails once: Setup stops there (set -e), the install done and pinned
    writeFileSync(join(w.home, '.fail-once'), '')
    const failing = install({
      ...w,
      tgz: (() => {
        const src = join(w.t, 'src', `chronos-${commit}`)
        writeFileSync(
          join(src, 'bin', 'chronos'),
          '#!/bin/sh\necho "chronos $*" >> "$HOME/.ran"\n[ -e "$HOME/.fail-once" ] && { rm "$HOME/.fail-once"; exit 1; }\necho \'{"ok": true}\'\n',
          { mode: 0o755 },
        )
        const tgz = join(w.t, 'failing.tgz')
        spawnSync('tar', ['-czf', tgz, '-C', join(w.t, 'src'), `chronos-${commit}`])
        return tgz
      })(),
    })
    expect(failing.status).not.toBe(0)
    const r = install(w)
    expect(r.status, r.stderr).toBe(0)
    expect(ran(w).split(SWITCH)).toHaveLength(3) // tried, failed; made on the second run
    expect(ran(w).match(/install\.sh /g)).toHaveLength(1)
  })

  it("a refusal in Chronos's answer (exit 0, no ok) fails Setup and keeps the mark, so the next run switches", () => {
    const w = world()
    const src = join(w.t, 'src', `chronos-${commit}`)
    writeFileSync(
      join(src, 'bin', 'chronos'),
      '#!/bin/sh\necho "chronos $*" >> "$HOME/.ran"\n' +
        'if [ -e "$HOME/.refuse" ]; then echo \'{"error": {"code": "bad_request"}}\'; else echo \'{"ok": true}\'; fi\n',
      { mode: 0o755 },
    )
    spawnSync('tar', ['-czf', w.tgz, '-C', join(w.t, 'src'), `chronos-${commit}`])
    writeFileSync(join(w.home, '.refuse'), '')
    const r = install(w)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('Chronos did not take the switch to Talos')
    rmSync(join(w.home, '.refuse'))
    expect(install(w).stdout).toBe('Chronos: set up for Talos\n')
    expect(ran(w).split(SWITCH)).toHaveLength(3)
  })

  it('a dry run after a stopped run says it would switch, and keeps the mark for the real run', () => {
    const w = world()
    writeFileSync(join(w.home, '.fail-once'), '')
    const src = join(w.t, 'src', `chronos-${commit}`)
    writeFileSync(
      join(src, 'bin', 'chronos'),
      '#!/bin/sh\necho "chronos $*" >> "$HOME/.ran"\n[ -e "$HOME/.fail-once" ] && { rm "$HOME/.fail-once"; exit 1; }\necho \'{"ok": true}\'\n',
      { mode: 0o755 },
    )
    spawnSync('tar', ['-czf', w.tgz, '-C', join(w.t, 'src'), `chronos-${commit}`])
    expect(install(w).status).not.toBe(0)
    const dry = install(w, '1')
    expect(dry.status, dry.stderr).toBe(0)
    expect(dry.stdout).toContain('would hand')
    expect(existsSync(join(w.home, '.config', 'chronos', '.talos-adopt'))).toBe(true)
    expect(install(w).stdout).toBe('Chronos: set up for Talos\n')
  })

  it('the config folder gone (the runtime kept) is a fresh install again: installed and switched', () => {
    const w = world()
    expect(install(w).status).toBe(0)
    rmSync(join(w.home, '.config', 'chronos'), { recursive: true })
    const r = install(w)
    expect(r.status, r.stderr).toBe(0)
    expect(ran(w).match(/install\.sh /g)).toHaveLength(2)
    expect(ran(w).split(SWITCH)).toHaveLength(3)
  })

  it('a download that is not the pinned file installs nothing and fails', () => {
    const w = world()
    const r = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail\nrun() { "$@"; }\nfetch_pinned() { return 1; }\nDRY=0 CHRONOS_COMMIT=${commit} CHRONOS_SHA256=abc\n${fn}\ninstall_chronos`,
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: w.home } },
    )
    expect(r.status).not.toBe(0)
    expect(ran(w)).toBe('')
    expect(existsSync(join(w.home, '.local', 'share', 'chronos', '.talos-pin'))).toBe(false)
  })

  it('a dry run says what it would do and changes nothing', () => {
    const w = world()
    const r = install(w, '1')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('would run: fetch_pinned')
    expect(ran(w)).toBe('')
    expect(existsSync(join(w.home, '.local'))).toBe(false)
  })
})

describe("launch.py: the owner's approval of how Talos starts Claude (Hestia's contract; Fable R2 on c9a60023)", () => {
  const LAUNCH = join(ROOT, 'apps', 'windows', 'distro', 'launch.py')
  const py = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0
  const fp = (input: string) => spawnSync('python3', ['-I', LAUNCH, 'fingerprint'], { input, encoding: 'utf8' })
  const vectors = JSON.parse(
    readFileSync(join(ROOT, 'packages', 'protocol', 'fixtures', 'launch-fingerprint.json'), 'utf8'),
  ) as {
    cases: {
      name: string
      supervisor: unknown
      approvable?: boolean
      fingerprint?: string
      parts?: Record<string, string>
    }[]
  }

  it.skipIf(!py)('works out the shared test vectors as the supervisor does, and refuses the ones it refuses', () => {
    for (const c of vectors.cases) {
      const r = fp(JSON.stringify(c.supervisor))
      const approvable = c.approvable ?? true
      if (!approvable) {
        expect(r.status, c.name).toBe(1)
        continue
      }
      expect(r.status, c.name).toBe(0)
      expect(JSON.parse(r.stdout), c.name).toEqual({ fingerprint: c.fingerprint, parts: c.parts })
    }
  })

  it.skipIf(!py)(
    'the strict rule: no defaults, absolute paths, real text; anything else is not approvable, before any hash',
    () => {
      const ok = { agent_dir: '/a', claude_path: '/c', args: [] }
      expect(fp(JSON.stringify(ok)).status).toBe(0)
      for (const bad of [
        'not json',
        '[]',
        '"x"',
        JSON.stringify({ agent_dir: '/a', claude_path: '/c' }),
        JSON.stringify({ ...ok, args: 'x' }),
        JSON.stringify({ ...ok, args: [1] }),
        JSON.stringify({ ...ok, env: false }),
        JSON.stringify({ ...ok, env: '' }),
        JSON.stringify({ ...ok, env: [] }),
        JSON.stringify({ ...ok, env: { A: 1 } }),
        JSON.stringify({ ...ok, claude_path: 'claude' }),
        JSON.stringify({ ...ok, agent_dir: '~/agent' }),
        '{"agent_dir":"/a","claude_path":"/c","args":["\\ud800"]}',
      ]) {
        const r = fp(bad)
        expect(r.status, bad).toBe(1)
        expect(r.stderr, bad).toContain('not approvable')
        expect(r.stderr, bad).not.toContain('Traceback')
      }
    },
  )

  describe('check, approve, approve-install, state and relay-key, run for real in a test root', () => {
    let t = ''
    const env = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', TALOS_LAUNCH_TEST_ROOT: t })
    const launch = (...args: string[]) =>
      spawnSync('python3', ['-I', LAUNCH, ...args], { env: env(), encoding: 'utf8' })
    const check = () => JSON.parse(launch('check').stdout) as Record<string, unknown>
    const approved = () => join(t, 'etc-talos', 'launch-approved')
    let claude = ''
    const supervisor = (o: Record<string, unknown> = {}) =>
      writeFileSync(
        join(t, 'app', 'supervisor.json'),
        JSON.stringify({ agent_dir: '/home/talos/talos-agent', claude_path: claude, args: ['--a'], ...o }),
      )
    beforeEach(() => {
      t = realpathSync(mkdtempSync(join(tmpdir(), 'talos-launch-')))
      mkdirSync(join(t, 'app'))
      mkdirSync(join(t, 'bin'))
      writeFileSync(join(t, 'bin', 'claude'), '#!/bin/sh\n', { mode: 0o755 })
      claude = realpathSync(join(t, 'bin', 'claude'))
      supervisor()
    })
    afterEach(() => rmSync(t, { recursive: true, force: true }))

    // what install_defaults() works out in the test root: <t>/home/talos, and the version root's setup-user.sh pins
    const installDefaults = () => {
      const home = join(t, 'home', 'talos')
      return {
        agent_dir: join(home, 'talos-agent'),
        claude_path: join(home, '.local', 'share', 'claude', 'versions', '2.1.322'),
        args: [
          '--plugin-dir',
          join(home, 'talos-app', 'plugins', 'talos-app-mod'),
          '--dangerously-load-development-channels',
          'server:talos-app',
        ],
      }
    }
    const freshInstall = () => {
      rmSync(join(t, 'app', 'supervisor.json'))
      writeFileSync(join(t, 'setup-user.sh'), '#!/bin/sh\nCLAUDE_VERSION=2.1.322\n', { mode: 0o755 })
      const d = installDefaults()
      mkdirSync(join(d.claude_path, '..'), { recursive: true })
      writeFileSync(d.claude_path, '#!/bin/sh\n', { mode: 0o755 })
      return d
    }

    it.skipIf(!py || linuxOnly)(
      'install approves only its own launch, worked out by root, before the supervisor first starts (R3-2) (Linux)',
      () => {
        const d = freshInstall()
        expect(launch('approve-install').stdout).toContain('approved the install')
        // setup-user.sh then writes exactly that launch: approved
        writeFileSync(join(t, 'app', 'supervisor.json'), JSON.stringify(d))
        expect(check()).toMatchObject({ approved: true })
        expect(launch('state').stdout.trim()).toBe('approved')
      },
    )

    it.skipIf(!py || linuxOnly)(
      'install approves nothing once Talos has run, or once anything is approved, whatever supervisor.json says (Linux)',
      () => {
        const d = freshInstall()
        // the agent ran (a supervisor.json exists), with its own flag added; the owner runs Setup again
        writeFileSync(join(t, 'app', 'supervisor.json'), JSON.stringify({ ...d, args: [...d.args, '--dangerous'] }))
        expect(launch('approve-install').stdout).toContain('not approved here: Talos has started before')
        expect(existsSync(approved())).toBe(false)
        expect(launch('state').stdout.trim()).toBe('pending')
        // an approval exists: nothing either
        rmSync(join(t, 'app', 'supervisor.json'))
        launch('approve-install')
        const fp = JSON.parse(readFileSync(approved(), 'utf8')).fingerprint
        writeFileSync(join(t, 'app', 'supervisor.json'), JSON.stringify({ ...d, args: ['--other'] }))
        rmSync(join(t, 'app', 'supervisor.json'))
        expect(launch('approve-install').stdout).toContain('there is an approval already')
        expect(JSON.parse(readFileSync(approved(), 'utf8')).fingerprint).toBe(fp)
      },
    )

    it.skipIf(!py)('install defaults come from root-only inputs: a setup-user.sh others can write is refused', () => {
      freshInstall()
      chmodSync(join(t, 'setup-user.sh'), 0o666)
      const r = launch('approve-install')
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("is not root's own")
      expect(existsSync(approved())).toBe(false)
    })

    it.skipIf(!py)(
      "the window's lines are root's: one argument a line, quoted, hidden characters written out, changes first (R3-3)",
      () => {
        launch('approve', check().fingerprint as string)
        const show = (args: string[]) => {
          supervisor({ args })
          return check() as { display: string[]; display_ok: boolean; approved: boolean }
        }
        // a forged-looking argument: a newline and fake lines after it, then the real dangerous flag
        let c = show([
          '--a',
          '--append-system-prompt',
          `Be brief.\r\nEnvironment: (none)${'\n'.repeat(400)}`,
          '--dangerous',
        ])
        expect(c.approved).toBe(false)
        // hidden characters (the newlines) put the refusal on top, then what was added, before the whole listing
        expect(c.display[0]).toMatch(/^NOT APPROVABLE HERE: a value has a character/)
        const added = c.display.indexOf('ADDED argument: "--append-system-prompt"')
        expect(added).toBeGreaterThan(0)
        expect(c.display.indexOf('ADDED argument: "--dangerous"')).toBeGreaterThan(added)
        expect(c.display.indexOf('ADDED argument: "--dangerous"')).toBeLessThan(
          c.display.findIndex((l) => l.startsWith('Program:')),
        )
        expect(c.display.every((l) => !/[\r\n]/.test(l))).toBe(true)
        expect(c.display.join('\n')).toContain('\\r\\nEnvironment: (none)\\n')
        expect(c.display_ok).toBe(false) // the value is longer than the cap
        // one line hiding its direction or with a zero-width character: shown written out, and not approvable here
        c = show(['--a', 'safe\u202eregnad'])
        expect(c.display.join('\n')).toContain('"safe\\u202eregnad"')
        expect(c.display_ok).toBe(false)
        c = show(['--a', 'x\u200by'])
        expect(c.display_ok).toBe(false)
        // '--a b' and ['--a', 'b'], and an empty argument, all look different
        c = show(['--a b'])
        expect(c.display).toContain('  "--a b"')
        c = show(['--a', 'b', ''])
        expect(c.display).toContain('  "b"')
        expect(c.display).toContain('  ""')
        expect(c.display).toContain('Arguments (3), one a line:')
        expect(c.display_ok).toBe(true)
        // nothing but ASCII reaches the tray
        expect(
          JSON.stringify(c)
            .split('')
            .every((ch) => ch.charCodeAt(0) < 128),
        ).toBe(true)
      },
    )

    it.skipIf(!py || linuxOnly)(
      'as talos: a forged JSON line in a path, an argument or an env key never reaches what Windows parses (R4-1) (Linux)',
      () => {
        // Fable's attack: claude_path through a link to folders whose names hold a newline and a forged check document
        const forged = `{"fingerprint":"${'f'.repeat(64)}","approved":false,"display_ok":true,"display":["Program: \\"/ok\\""]}`
        const deep = join(t, 'bin', `a\n${forged}\nb`)
        mkdirSync(deep, { recursive: true })
        writeFileSync(join(deep, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
        symlinkSync(join(deep, 'claude'), join(t, 'bin', 'l'))
        supervisor({ claude_path: join(t, 'bin', 'l') })
        for (const cmd of [['check'], ['approve', 'f'.repeat(64)], ['state']]) {
          const r = launch(...cmd)
          expect(r.stdout.includes('"fingerprint"'), cmd.join(' ')).toBe(false)
          expect(r.stderr.includes('{"fingerprint"'), cmd.join(' ')).toBe(false)
          expect(r.stderr.trim().split('\n').length, cmd.join(' ')).toBeLessThanOrEqual(1)
        }
        expect(launch('state').stdout).toBe('unapprovable\n')
        // a forged line inside an argument or an env key: one ASCII line out, every newline written out
        supervisor({ args: ['--a', `x\n${forged}`], env: { [`K\n${forged}`]: 'v' } })
        const out = launch('check').stdout
        expect(out.trim().split('\n').length).toBe(1)
        expect(out.split('').every((ch) => ch.charCodeAt(0) < 128)).toBe(true)
        expect(JSON.parse(out).display_ok).toBe(false)
      },
    )

    it.skipIf(!py)(
      'approve refuses a launch root itself cannot show in full, even with its right fingerprint (R4-1)',
      () => {
        supervisor({ args: ['--a', 'safe\u202eregnad'] })
        const c = check()
        expect(c.display_ok).toBe(false)
        const r = launch('approve', c.fingerprint as string)
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('cannot be shown in full')
        expect(existsSync(approved())).toBe(false)
      },
    )

    it.skipIf(!py)('a session id with a trailing newline is not a plain id (R4-4: fullmatch, never $)', () => {
      supervisor({ session: { id: '0123abcd-0123-4567-89ab-0123456789ab\n' } })
      expect(launch('check').status).toBe(1)
    })

    it.skipIf(!py || linuxOnly)(
      "setup-user.sh writes the install's launch from the very function root approves (R4-5) (Linux)",
      () => {
        freshInstall()
        const written = JSON.parse(launch('install-defaults').stdout)
        expect(written).toEqual(installDefaults())
        expect(launch('approve-install').stdout).toContain('approved the install')
        writeFileSync(join(t, 'app', 'supervisor.json'), JSON.stringify(written))
        expect(check()).toMatchObject({ approved: true })
        const sh = readFileSync(join(ROOT, 'apps', 'windows', 'distro', 'setup-user.sh'), 'utf8')
        expect(sh).toContain('python3 -I /opt/talos-wsl/launch.py install-defaults >"$conf.tmp"')
        expect(sh).not.toMatch(/--dangerously-load-development-channels/)
      },
    )

    it.skipIf(!py)("session ids are plain ids or the file is not approvable (R3-4, Hestia's rule)", () => {
      const id = '0123abcd-0123-4567-89ab-0123456789ab'
      for (const [session, ok] of [
        [{ id }, true],
        [{ id: null, previous_ids: [id] }, true],
        [{ id: '--dangerously-skip-permissions' }, false],
        [{ id: `${id} --x` }, false],
        [{ id, previous_ids: ['--settings=/x'] }, false],
        [{ id, previous_ids: 'x' }, false],
        ['x', false],
      ] as [unknown, boolean][]) {
        supervisor({ session })
        expect(launch('check').status, JSON.stringify(session)).toBe(ok ? 0 : 1)
      }
    })

    it.skipIf(!py)('approve stores the fingerprint it works out itself, only when it equals the one shown', () => {
      const shown = check().fingerprint as string
      supervisor({ args: ['--changed-after-it-was-shown'] })
      const r = launch('approve', shown)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('it changed again')
      expect(existsSync(approved())).toBe(false)
      const now = check().fingerprint as string
      expect(launch('approve', now).status).toBe(0)
      expect(JSON.parse(readFileSync(approved(), 'utf8')).fingerprint).toBe(now)
      expect(statSync(approved()).mode & 0o777).toBe(0o644)
      for (const arg of ['', 'x'.repeat(64), now.toUpperCase()]) expect(launch('approve', arg).status).toBe(1)
    })

    it.skipIf(!py || linuxOnly)(
      'a claude_path that is not its own real path (a link) is not approvable (Linux)',
      () => {
        symlinkSync(claude, join(t, 'bin', 'claude-link'))
        supervisor({ claude_path: join(t, 'bin', 'claude-link') })
        const r = launch('check')
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('not the program')
        supervisor({ claude_path: join(t, 'bin', 'missing') })
        expect(launch('check').status).toBe(1)
      },
    )

    it.skipIf(!py)(
      'an approval that is a link, empty, not JSON, not an object, too large or group-writable counts as none',
      () => {
        const etc = join(t, 'etc-talos')
        mkdirSync(etc, { mode: 0o755 })
        const states: [string, () => void][] = [
          ['a link', () => symlinkSync(join(t, 'app', 'supervisor.json'), approved())],
          ['empty', () => writeFileSync(approved(), '', { mode: 0o644 })],
          ['not JSON', () => writeFileSync(approved(), 'nope', { mode: 0o644 })],
          ['not an object', () => writeFileSync(approved(), '[1]', { mode: 0o644 })],
          ['over 4 KB', () => writeFileSync(approved(), `{"v":1,"x":"${'a'.repeat(5000)}"}`, { mode: 0o644 })],
          [
            'group-writable',
            () => {
              launch('approve', check().fingerprint as string)
              chmodSync(approved(), 0o664)
            },
          ],
        ]
        for (const [name, make] of states) {
          rmSync(approved(), { force: true })
          make()
          const r = launch('check')
          expect(r.status, name).toBe(0)
          expect(JSON.parse(r.stdout).approved, name).toBe(false)
          expect(r.stderr, name).not.toContain('Traceback')
        }
      },
    )

    it.skipIf(!py)('a FIFO at supervisor.json is no answer, not a hang; a group-writable /etc/talos is refused', () => {
      rmSync(join(t, 'app', 'supervisor.json'))
      spawnSync('mkfifo', [join(t, 'app', 'supervisor.json')])
      const at = Date.now()
      const r = launch('check')
      expect(Date.now() - at).toBeLessThan(5000)
      expect(r.status).toBe(1)
      expect(r.stderr).not.toContain('Traceback')
      rmSync(join(t, 'app', 'supervisor.json'))
      supervisor()
      const fp = check().fingerprint as string
      mkdirSync(join(t, 'etc-talos'), { mode: 0o775 })
      chmodSync(join(t, 'etc-talos'), 0o775)
      const w = launch('approve', fp)
      expect(w.status).toBe(1)
      expect(w.stderr).toContain('not a root-owned folder')
    })

    it.skipIf(!py)(
      'relay-set normalises as TalosWin.ps1 does: trailing slashes go, scheme and host lowercased (R7-3)',
      () => {
        const stored = (url: string) => {
          const r = launch('relay-set', url)
          return r.status === 0
            ? JSON.parse(readFileSync(join(t, 'etc-talos', 'relay'), 'utf8')).url
            : `refused ${r.status}`
        }
        expect(stored('https://relay.example.com/')).toBe('https://relay.example.com')
        expect(stored('HTTPS://Relay.Example.COM//')).toBe('https://relay.example.com')
        expect(stored('https://Relay.example.com/V1/Path/')).toBe('https://relay.example.com/V1/Path')
        expect(stored('https://u:p@example.com')).toBe('refused 1')
        expect(stored('https://relay')).toBe('refused 1')
      },
    )

    it.skipIf(!py)('relay-key keeps the first key it saw, and says `changed` when bridge.key no longer has it', () => {
      const key = (pub: string) => writeFileSync(join(t, 'app', 'bridge.key'), JSON.stringify({ v: 1, public: pub }))
      key('A'.repeat(43))
      expect(launch('relay-key').stdout).toBe(`BRIDGE_PUBKEY=${'A'.repeat(43)}\n`)
      key('Z'.repeat(43))
      expect(launch('relay-key').stdout).toBe(`BRIDGE_PUBKEY=${'A'.repeat(43)}\nchanged\n`)
      rmSync(join(t, 'app', 'bridge.key'))
      expect(launch('relay-key').stdout).toBe(`BRIDGE_PUBKEY=${'A'.repeat(43)}\nchanged\n`)
      expect(JSON.parse(readFileSync(join(t, 'etc-talos', 'relay-pubkey'), 'utf8')).public).toBe('A'.repeat(43))
    })
  })

  it("outside a test root, check and approve run only as root, and read talos's files as talos", () => {
    const src = readFileSync(LAUNCH, 'utf8')
    expect(src).toContain('if os.getuid() != 0 and not TEST_ROOT:')
    expect(src).toContain('"runuser", "-u", USER, "--", "sh", "-c"')
    expect(src).not.toMatch(/open\([^)]*supervisor/)
    if (py && process.getuid?.() !== 0) {
      const r = spawnSync('python3', ['-I', LAUNCH, 'check'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      })
      expect(r.stderr).toContain('runs as root')
    }
  })
})

describe('signin.py, run for real against a stand-in claude (Fable R1-2, R1-8 on f3575ba1)', () => {
  const SIGNIN = join(ROOT, 'apps', 'windows', 'distro', 'signin.py')
  const py = spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' }).status === 0
  const me = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim()
  const URL = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&response_type=code&state=xyz'
  const TOKEN = `sk-ant-oat01-${'A1b2_C3d4-'.repeat(9)}xyz`
  // a stand-in for `claude setup-token` that writes in pieces, with pauses, as a pty read can see it: $1 how it ends
  const fake = (home: string, ending: string) => {
    const f = join(home, 'fake-claude')
    const half = (s: string) => [s.slice(0, Math.floor(s.length / 2)), s.slice(Math.floor(s.length / 2))]
    const [u1, u2] = half(URL)
    const [t1, t2] = half(TOKEN)
    const endings: Record<string, string> = {
      split: `printf '%s' '${t1}'; sleep 0.6; printf '%s\\r\\n\\r\\nStore this token securely.\\r\\n' '${t2}'; sleep 5`,
      eof: `printf 'Your OAuth token:\\r\\n%s' '${TOKEN}'; exit 0`,
      cut: `printf 'Your OAuth token:\\r\\n%s' '${t1}'; exit 0`,
      bad: `printf '\\r\\nOAuth error: Invalid code. Press Enter to retry. ${t1}\\r\\n'; sleep 5`,
      other: `printf '\\r\\nSomething failed at the server: tell nobody\\r\\n'; sleep 5`,
    }
    writeFileSync(
      f,
      `#!/bin/sh\nprintf "Browser didn't open? Use the url below\\r\\n\\r\\n%s" '${u1}'\nsleep 0.6\nprintf '%s\\r\\n\\r\\nPaste code here if prompted > ' '${u2}'\nread -r code\n${endings[ending]}\n`,
      { mode: 0o755 },
    )
    return f
  }
  const drive = (ending: string) =>
    new Promise<{ events: { event: string; url?: string; message?: string }[]; raw: string; home: string }>((res) => {
      const home = mkdtempSync(join(tmpdir(), 'talos-signin-'))
      const p = spawn('python3', ['-I', SIGNIN], {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          TALOS_SIGNIN_USER: me,
          TALOS_SIGNIN_HOME: home,
          TALOS_SIGNIN_CLAUDE: fake(home, ending),
        },
      })
      let raw = ''
      p.stdout.on('data', (b: Buffer) => {
        raw += b.toString()
        if (raw.includes('"event":"code"') && !raw.includes('#sent')) {
          raw += '#sent'
          p.stdin.write('goodcode#state123\n')
        }
      })
      p.on('close', () => {
        raw = raw.replace('#sent', '')
        const events = raw
          .split('\n')
          .filter((l) => l.startsWith('{'))
          .map((l) => JSON.parse(l))
        res({ events, raw, home })
      })
    })
  const token = (home: string) => join(home, '.config', 'talos', 'app', 'claude-oauth-token')

  it.skipIf(!py)(
    'a link and a token each split across reads are taken whole, and only once something ends them',
    async () => {
      const r = await drive('split')
      expect(r.events.map((e) => e.event)).toEqual(['url', 'code', 'signed_in'])
      expect(r.events[0]?.url).toBe(URL)
      expect(readFileSync(token(r.home), 'utf8')).toBe(`${TOKEN}\n`)
      expect(statSync(token(r.home)).mode & 0o777).toBe(0o600)
      expect(r.raw).not.toContain('sk-ant')
    },
    20000,
  )

  it.skipIf(!py)(
    "a token Claude Code's output ends right after counts: its end ends the token",
    async () => {
      const r = await drive('eof')
      expect(r.events.at(-1)?.event).toBe('signed_in')
      expect(readFileSync(token(r.home), 'utf8')).toBe(`${TOKEN}\n`)
    },
    20000,
  )

  it.skipIf(!py)(
    'a token cut short is never stored, and never called signed in',
    async () => {
      const r = await drive('cut')
      expect(r.events.at(-1)?.event).toBe('error')
      expect(existsSync(token(r.home))).toBe(false)
      expect(r.raw).not.toContain('sk-ant')
    },
    20000,
  )

  it.skipIf(!py)(
    "failures are fixed plain sentences: none of Claude Code's own text, and no token, is passed on",
    async () => {
      const bad = await drive('bad')
      expect(bad.events.at(-1)).toEqual({
        event: 'error',
        message: expect.stringContaining('did not accept that code'),
      })
      expect(bad.raw).not.toContain('OAuth error')
      expect(bad.raw).not.toContain('sk-ant')
      const other = await drive('other')
      expect(other.events.at(-1)?.message).toBe('Claude Code could not sign you in. Try again in a minute.')
      expect(other.raw).not.toContain('tell nobody')
    },
    30000,
  )
})
describe.skipIf(linuxOnly)('restart and restore, root verbs for the tray: fixed words only (Linux)', () => {
  // stand-ins: id (talos is 1000), getent (talos's home), runuser (prints $FAKE_OUT, exits $FAKE_RC, and writes down what it
  // ran), and systemctl/loginctl for the user manager (written down too)
  const stubs = () => {
    writeFileSync(
      join(bin, 'id'),
      '#!/bin/sh\n[ "$1 $2" = "-u talos" ] && { echo 1000; exit 0; }\nexec /usr/bin/id "$@"\n',
      { mode: 0o755 },
    )
    writeFileSync(join(bin, 'getent'), '#!/bin/sh\necho "talos:x:1000:1000::/home/talos:/bin/bash"\n', { mode: 0o755 })
    writeFileSync(
      join(bin, 'runuser'),
      '#!/bin/sh\necho "runuser $*" >> "$TALOS_WSL_ROOT/.ran"\nprintf "%s" "$FAKE_OUT"\nexit "${FAKE_RC:-0}"\n',
      { mode: 0o755 },
    )
    writeFileSync(join(bin, 'fake-systemctl'), '#!/bin/sh\necho "systemctl $*" >> "$TALOS_WSL_ROOT/.ran"\n', {
      mode: 0o755,
    })
    // root's own launch state (launch.py state): $FAKE_LAUNCH, approved unless a test says otherwise
    writeFileSync(join(bin, 'fake-launch.py'), 'import os\nprint(os.environ.get("FAKE_LAUNCH", "approved"))\n')
    return (out = '', rc = 0, launch = 'approved') => ({
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      FAKE_OUT: out,
      FAKE_RC: String(rc),
      FAKE_LAUNCH: launch,
      TALOS_WSL_SYSTEMCTL: join(bin, 'fake-systemctl'),
      TALOS_WSL_LAUNCH: join(bin, 'fake-launch.py'),
    })
  }
  const ran = () => (existsSync(join(root, '.ran')) ? readFileSync(join(root, '.ran'), 'utf8') : '')
  const proc = (o: { interop?: boolean } = {}) => {
    mkdirSync(join(root, 'proc', 'sys', 'fs', 'binfmt_misc'), { recursive: true })
    writeFileSync(join(root, 'etc', 'wsl.conf'), o.interop ? '[boot]\nsystemd=true\n' : '[interop]\nenabled=false\n')
    writeFileSync(join(root, 'proc', 'mounts'), '/dev/sdc / ext4 rw 0 0\ntalos-private /mnt/wsl tmpfs rw 0 0\n')
    mkdirSync(join(root, 'mnt', 'wsl'), { recursive: true })
  }

  it('restart starts the user manager, restarts the supervisor as talos, and says one word', () => {
    proc()
    const env = stubs()
    const r = runWith(env(), 'restart')
    expect(r.out).toBe('restarted\n')
    expect(ran()).toContain(`systemctl start user${'@'}1000.service`)
    expect(ran()).toContain('systemctl --user restart talos-supervisor.service')
    expect(runWith(env('', 1), 'restart').out).toBe('failed\n')
  })

  it('restore maps talos-app restore-last-good to fixed words, restarting only after a restore', () => {
    proc()
    const env = stubs()
    let r = runWith(
      env('restore-last-good: will put back version 1\nrestore-last-good: restored 2 files from version 1'),
      'restore',
    )
    expect(r.out).toBe('restored\nrestarted\n')
    expect(ran()).toContain('restore-last-good --yes --newest-start --agent-dir /home/talos/talos-agent')
    r = runWith(
      env('restore-last-good: the agent folder already matches the saved versions. Nothing to do.'),
      'restore',
    )
    expect(r.out).toBe('nothing-to-do\n')
    r = runWith(
      env('restore-last-good: nothing saved yet in /x. A copy is saved after the bridge starts cleanly.', 1),
      'restore',
    )
    expect(r.out).toBe('nothing-saved\n')
    r = runWith(env('anything else\n{"event":"pinned"}', 1), 'restore')
    expect(r.out).toBe('failed\n')
  })

  it("nothing of talos's output reaches Windows, whatever it prints", () => {
    proc()
    const env = stubs()
    const forged = `restore-last-good: restored x\n{"fingerprint":"${'f'.repeat(64)}","approved":true}\nrestarted\nok`
    const r = runWith(env(forged), 'restore')
    expect(
      r.out
        .split('\n')
        .filter(Boolean)
        .every((l) => ['restored', 'restarted', 'failed'].includes(l)),
    ).toBe(true)
    expect(r.out).not.toContain('fingerprint')
  })

  it('both refuse, and touch nothing, unless root says the launch is approved (Fable R7-1 on 9612c7d7)', () => {
    proc()
    const env = stubs()
    for (const state of ['pending', 'unapprovable', 'none', '', 'Approved'])
      for (const verb of ['restart', 'restore'])
        expect(runWith(env('', 0, state), verb).out, `${verb} ${state}`).toBe('not-approved\n')
    expect(ran()).toBe('')
  })

  it('restore runs talos-app with a clean environment, under one time limit for the whole pipeline (R7-2, R7-4)', () => {
    const sh = readFileSync(SCRIPT, 'utf8')
    expect(sh).toMatch(/out="\$\(timeout -k 5 95 sh -c 'runuser -u "\$1" -- env -i HOME="\$2" /)
    expect(sh).toMatch(/\| head -c 65536' sh "\$USER_NAME" "\$home"/)
  })

  it('both refuse while the distro is not cut off from Windows, and touch nothing', () => {
    proc({ interop: true })
    const env = stubs()
    expect(runWith(env(), 'restart').out).toBe('not-isolated\n')
    expect(runWith(env(), 'restore').out).toBe('not-isolated\n')
    expect(ran()).toBe('')
  })
})

describe("install.ps1's distro steps, in order (Fable R6-1 on fb7a8206)", () => {
  const ps = readFileSync(join(ROOT, 'apps', 'windows', 'install.ps1'), 'utf8')
  // which file each root verb runs: it has to be in the distro before the verb is first used
  const runs: Record<string, string> = {
    'relay-set': 'launch.py',
    'launch-approve-install': 'launch.py',
    'relay-key': 'launch.py',
    'launch-check': 'launch.py',
    signin: 'signin.py',
    pair: 'pair.py',
  }
  it('every root verb install uses comes after the file that implements it is put in place', () => {
    for (const [verb, file] of Object.entries(runs)) {
      const use = ps.indexOf(`'/opt/talos-wsl/talos-wsl.sh', '${verb}'`)
      if (use < 0) continue
      const put = ps.indexOf(`PutRoot (Join-Path $here 'distro\\${file}')`)
      expect(put, `${verb} needs ${file}`).toBeGreaterThan(0)
      expect(put, `${file} is put in place before ${verb}`).toBeLessThan(use)
    }
    // talos-wsl.sh itself first of all
    expect(ps.indexOf("PutRoot (Join-Path $here 'distro\\talos-wsl.sh')")).toBeLessThan(
      ps.indexOf("'/opt/talos-wsl/talos-wsl.sh', '"),
    )
  })
  it('a relay-set refusal is never swallowed, and the relay rule is one rule on every side (R6-3)', () => {
    expect(ps).toMatch(/'relay-set', \$RelayUrl\)\r?\n/)
    const win = /\$script:TalosRelayRule = '\^(.+)\\z'/.exec(
      readFileSync(join(ROOT, 'apps', 'windows', 'TalosWin.ps1'), 'utf8'),
    )?.[1]
    for (const py of ['launch.py', 'pair.py']) {
      const src = readFileSync(join(ROOT, 'apps', 'windows', 'distro', py), 'utf8')
      expect(/^RELAY = re\.compile\(r"(.+)"\)$/m.exec(src)?.[1], py).toBe(win)
    }
  })
})

describe('pair.py passes the four words only as PGP list words (the list has "Yucat\u00e1n"), and nothing else', () => {
  it('a confirm with Yucatán is passed on; one with a space, a digit or a control character is not', () => {
    const run = (words: string[]) =>
      spawnSync(
        'python3',
        [
          '-I',
          '-c',
          [
            'import importlib.util, json, sys',
            'spec = importlib.util.spec_from_file_location("pair", sys.argv[1])',
            'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
            'e = {"event": "confirm", "device_name": "iPhone", "words": json.loads(sys.argv[2])}',
            'print(json.dumps(m.checked(e, "https://relay.example.com")))',
          ].join('\n'),
          join(ROOT, 'apps', 'windows', 'distro', 'pair.py'),
          JSON.stringify(words),
        ],
        { encoding: 'utf8' },
      )
    // four PGP list words in their places (Titan's list check replaced the letters-only class)
    const ok = run(['Zulu', 'Yucat\u00e1n', 'aardvark', 'adroitness'])
    expect(ok.status, ok.stderr).toBe(0)
    expect(JSON.parse(ok.stdout).words).toEqual(['Zulu', 'Yucat\u00e1n', 'aardvark', 'adroitness'])
    for (const bad of [
      ['a b', 'c', 'd', 'e'],
      ['a', '1', 'c', 'd'],
      ['aardvark', 'adroitness', 'absurd', 'x\u001b'],
      ['aardvark', 'adroitness', 'absurd', 'd_e'],
      ['aardvark', 'adroitness', 'absurd', 'x\u00b2'], // a superscript digit
      ['aardvark', 'adroitness', 'absurd', '\u2167'], // a Roman numeral
      ['aardvark', 'adroitness', 'absurd', 'a\u3164'], // an invisible letter
      ['aardvark', 'adroitness', 'absurd', 'Yucata\u0301n'], // decomposed
      ['aardvark', 'adroitness', 'absurd', 'a\u200f'], // a direction mark
      ['aardvark', 'adroitness', 'absurd', '\u05d0'], // right-to-left
      ['aardvark', 'adroitness', 'absurd', 'a'.repeat(25)],
      // by position, on every platform (Fable on 84354b1f): membership in the union of both halves is not enough
      ['adroitness', 'aardvark', 'adviser', 'absurd'], // odd and even swapped
      ['aardvark', 'adroitness', 'absurd', 'aardvark'], // an even word in an odd place
      ['Zulu', 'Yucatán', 'aardvark', 'Yucatán'.toLowerCase()], // case
    ]) {
      const r = run(bad)
      expect(r.status, r.stderr).toBe(0)
      expect(JSON.parse(r.stdout), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('test stand-ins are ignored as root (Pantheon on bbdcdd36, Fable R5-5)', () => {
  it('talos-wsl.sh drops every TALOS_WSL_* name as root before it reads any, and lists each one it reads', () => {
    const sh = readFileSync(SCRIPT, 'utf8')
    const gate = sh.indexOf(
      'if [ "$EUID" -eq 0 ]; then\n  for v in $(compgen -v TALOS_WSL_ || true); do unset "$v"; done\nfi',
    )
    expect(gate).toBeGreaterThan(0)
    const used = [...new Set([...sh.matchAll(/TALOS_WSL_([A-Z_]+)/g)].map((m) => m[1]))].sort()
    const listed = /^# {3}(ROOT, [A-Z_, ]+)\.$/m.exec(sh)?.[1].split(', ').sort()
    expect(listed).toEqual(used)
    // the first read of any of them comes after the gate
    expect(sh.indexOf('${TALOS_WSL_')).toBeGreaterThan(gate)
  })
  it('every root helper honours its test names only when not root', () => {
    const py = (f: string) => readFileSync(join(ROOT, 'apps', 'windows', 'distro', f), 'utf8')
    expect(py('launch.py')).toMatch(
      /^TEST_ROOT = \(os\.environ\.get\("TALOS_LAUNCH_TEST_ROOT"\) if os\.getuid\(\) != 0 else None\)/m,
    )
    for (const f of ['pair.py', 'signin.py']) {
      expect(py(f), f).toMatch(/^TESTING = os\.getuid\(\) != 0$/m)
      for (const m of py(f).matchAll(/os\.environ\.get\("TALOS_[A-Z_]+"\)( if TESTING else None)?/g))
        expect(m[1], `${f}: ${m[0]}`).toBe(' if TESTING else None')
    }
  })
})

describe("pair.py's own copy of the PGP word list", () => {
  it('equals packages/protocol/src/pgp-words.ts, both halves, in order', () => {
    const code = [
      'import importlib.util, json, sys',
      "spec = importlib.util.spec_from_file_location('pair', sys.argv[1])",
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'print(json.dumps({"even": list(m.PGP_EVEN), "odd": list(m.PGP_ODD)}))',
    ].join('\n')
    const r = spawnSync('python3', ['-I', '-c', code, join(ROOT, 'apps', 'windows', 'distro', 'pair.py')], {
      encoding: 'utf8',
      timeout: 20000,
    })
    const got = JSON.parse(r.stdout) as { even: string[]; odd: string[] }
    expect(got.even).toEqual([...PGP_EVEN_WORDS])
    expect(got.odd).toEqual([...PGP_ODD_WORDS])
    expect(got.odd[255]).toBe('Yucatán')
  })
})

describe('group time limits (the fleet rule, 2026-11-12)', () => {
  it.skipIf(linuxOnly)(
    "launch.py's run_group kills the whole group on its limit, nothing it started is left (Linux)",
    () => {
      const tag = `talos-rg-${process.pid}-${Date.now()}`
      const code = [
        'import importlib.util, subprocess, sys',
        `spec = importlib.util.spec_from_file_location('launch', '${join(ROOT, 'apps', 'windows', 'distro', 'launch.py')}')`,
        'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
        'try:',
        `    m.run_group(['bash', '-c', 'sleep 30 & exec -a ${tag} sleep 30'], 1, stdout=subprocess.DEVNULL)`,
        '    print("no limit")',
        'except subprocess.TimeoutExpired:',
        '    print("limit")',
      ].join('\n')
      const r = spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 20000 })
      expect(r.stdout.trim()).toBe('limit')
      // neither the shell's background sleep nor the exec'd one survives
      expect(spawnSync('pgrep', ['-f', tag], { encoding: 'utf8' }).stdout.trim()).toBe('')
      expect(readFileSync(join(ROOT, 'apps', 'windows', 'distro', 'talos-wsl.sh'), 'utf8')).not.toMatch(
        /\btimeout (\d|--foreground)/,
      )
    },
  )
})

describe.skipIf(linuxOnly)('pair.py, run for real against a stand-in talos-app enroll --json (Linux)', () => {
  const PAIR = join(ROOT, 'apps', 'windows', 'distro', 'pair.py')
  const me = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim()
  const RELAY = 'https://relay.example.com'
  const CODE = '0123456789ABCDEFGHJKMNPQRS'
  const LINK = `${RELAY}/enroll#${CODE}`
  const ev = (o: Record<string, unknown>) => `printf '%s\\r\\n' '${JSON.stringify(o)}'`
  // the stand-in runs the case's own script (pair.py gives enroll a clean environment, so it is written into the file)
  const fake = (dir: string, script: string) => {
    const f = join(dir, 'talos-app')
    writeFileSync(
      f,
      `#!/bin/bash
${script}
`,
      { mode: 0o755 },
    )
    return f
  }
  const answerPart = [
    'read -r a; a=$(printf "%s" "$a" | tr -d "\\r")',
    `if [ "$a" = y ]; then ${ev({ event: 'answered', yes: true })}; ${ev({ event: 'pinned', device_id: 'dev_123' })}; exit 0; fi`,
    `${ev({ event: 'answered', yes: false })}; exit 0`,
  ].join('\n')
  const confirm = ev({
    event: 'confirm',
    device_name: 'Her iPhone',
    words: ['aardvark', 'adroitness', 'absurd', 'adviser'],
  })
  const drive = (
    script: string,
    answer = 'y',
    relay: string | null = RELAY,
    answerAfterMs = 700,
    closeOn?: string, // the event after which stdin closes (the window was closed)
  ) => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-pair-'))
    const relayFile = join(dir, 'relay')
    if (relay !== null) writeFileSync(relayFile, JSON.stringify({ v: 1, url: relay }), { mode: 0o644 })
    return new Promise<{ events: Record<string, unknown>[]; raw: string; ms: number }>((res) => {
      const at = Date.now()
      const p = spawn('python3', ['-I', PAIR], {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          TALOS_PAIR_USER: me,
          TALOS_PAIR_APP: fake(dir, script),
          TALOS_PAIR_RELAY: relayFile,
        },
      })
      let raw = ''
      p.stdout.on('data', (b: Buffer) => {
        raw += b.toString()
        if (closeOn && !p.stdin.writableEnded && new RegExp(`"event": ?"${closeOn}"`).test(raw)) p.stdin.end()
        if (closeOn) return
        if (raw.includes('"event": "confirm"') || raw.includes('"event":"confirm"')) {
          if (!raw.includes('#sent')) {
            raw += '#sent'
            setTimeout(() => p.stdin.write(`${answer}\n`), answerAfterMs)
          }
        }
      })
      p.on('close', () =>
        res({
          raw: raw.replace('#sent', ''),
          ms: Date.now() - at,
          events: raw
            .replace('#sent', '')
            .split('\n')
            .filter((l) => l.startsWith('{'))
            .map((l) => JSON.parse(l)),
        }),
      )
    })
  }

  it('passes only four words of the PGP list, even/odd/even/odd, an accented one included', async () => {
    const link = ev({ event: 'link', link: LINK, expires_at: '2026-11-12T20:00:00Z' })
    const shown = async (words: string[]) =>
      (
        await drive([link, ev({ event: 'confirm', device_name: 'Her iPhone', words }), 'exit 0'].join('\n'))
      ).events.some((e) => e.event === 'confirm')
    expect(await shown(['Zulu', 'Yucatán', 'aardvark', 'adroitness'])).toBe(true)
    for (const words of [
      ['adroitness', 'aardvark', 'absurd', 'adviser'], // odd and even swapped
      ['aardvark', 'adroitness', 'absurd', 'Click'], // not on the list
      ['Aardvark', 'adroitness', 'absurd', 'adviser'], // case
      ['aardvark', 'Yucatan', 'absurd', 'adviser'], // the accent left out
      ['aardvark', 'adroitness', 'absurd'], // three
    ])
      expect(await shown(words), words.join(' ')).toBe(false)
  }, 60000)

  it('with no live bridge (bridge_not_live), ends with error not-ready: no link, no QR, and enroll is ended', async () => {
    const mark = join(mkdtempSync(join(tmpdir(), 'talos-pair-mark-')), 'still-running')
    const r = await drive(
      [
        ev({ event: 'warning', code: 'bridge_not_live', text: 'Main is not signed in' }),
        // what enroll does next: the link; then, if it were still alive 2 s on, a mark
        ev({ event: 'link', link: LINK, expires_at: '2026-11-12T20:00:00Z' }),
        `sleep 2; touch '${mark}'`,
        confirm,
        answerPart,
      ].join('\n'),
    )
    expect(r.events).toEqual([{ event: 'error', code: 'not-ready' }])
    expect(r.raw).not.toContain('enroll#')
    await new Promise((res) => setTimeout(res, 2500))
    expect(existsSync(mark)).toBe(false)
  }, 30000)

  it('the window closing (stdin ends) stops the pairing with no end event of its own, and enroll is ended', async () => {
    const mark = join(mkdtempSync(join(tmpdir(), 'talos-pair-mark-')), 'still-running')
    const r = await drive(
      [ev({ event: 'link', link: LINK, expires_at: '2026-11-12T20:00:00Z' }), `sleep 3; touch '${mark}'`, confirm].join(
        '\n',
      ),
      'y',
      RELAY,
      700,
      'qr',
    )
    expect(r.events.map((e) => e.event)).toEqual(['link', 'qr'])
    expect(r.ms).toBeLessThan(3000)
    await new Promise((res) => setTimeout(res, 3500))
    expect(existsSync(mark)).toBe(false)
  }, 30000)

  it('bridge_not_live after a link, or after a confirm, ends it at once with not-ready, and nothing is pinned', async () => {
    const late = ev({ event: 'warning', code: 'bridge_not_live', text: 'went away' })
    const link = ev({ event: 'link', link: LINK, expires_at: '2026-11-12T20:00:00Z' })
    const a = await drive([link, late, confirm, answerPart].join('\n'))
    expect(a.events.map((e) => e.event)).toEqual(['link', 'qr', 'error'])
    expect(a.events[2]).toEqual({ event: 'error', code: 'not-ready' })
    const b = await drive([link, confirm, late, answerPart].join('\n'))
    expect(b.events.map((e) => e.event)).toEqual(['link', 'qr', 'confirm', 'error'])
    expect(b.events.at(-1)).toEqual({ event: 'error', code: 'not-ready' })
  }, 30000)

  it('an enroll that stops with no end state (an older talos-app: no --json) ends with error enroll, never silently', async () => {
    const r = await drive(`echo "talos-app: Unknown option '--json'"; exit 1`)
    expect(r.events).toEqual([{ event: 'error', code: 'enroll' }])
  }, 30000)

  it('passes the link only when it is exactly the install relay, with the host and a QR root drew from it', async () => {
    const r = await drive(
      [ev({ event: 'link', link: LINK, expires_at: '2026-11-12T20:00:00Z' }), confirm, answerPart].join('\n'),
    )
    expect(r.events.map((e) => e.event)).toEqual(['link', 'qr', 'confirm', 'answered', 'pinned'])
    expect(r.events[0]).toEqual({
      event: 'link',
      link: LINK,
      host: 'relay.example.com',
      expires_at: '2026-11-12T20:00:00Z',
    })
    const rows = r.events[1]?.rows as string[]
    // the very matrix the bridge's own encoder makes for that link
    const code = `import { encode } from 'uqr'; console.log(JSON.stringify(encode(process.argv[1], { ecc: 'M', boostEcc: false, border: 0, maskPattern: Number(process.argv[2]) }).data.map((x) => x.map((b) => (b ? '1' : '0')).join(''))))`
    const masks = [...Array(8).keys()].map((m) =>
      JSON.parse(
        spawnSync('bun', ['-e', code, LINK, String(m)], { cwd: join(ROOT, 'apps', 'bridge'), encoding: 'utf8' }).stdout,
      ),
    )
    expect(masks.some((m) => JSON.stringify(m) === JSON.stringify(rows))).toBe(true)
  }, 30000)

  it('refuses a link to any other host, or one hiding the host behind a login: an error, and no QR', async () => {
    for (const link of [
      `https://evil.example.net/enroll#${CODE}`,
      `https://relay.example.com:pw@example.net/enroll#${CODE}`,
      `${RELAY}.evil.net/enroll#${CODE}`,
      `${RELAY}/enroll#${CODE}?x`,
      `${RELAY}/enroll#short`,
    ]) {
      const r = await drive(ev({ event: 'link', link, expires_at: 'x' }))
      expect(r.events, link).toEqual([{ event: 'error', code: 'link' }])
    }
  }, 60000)

  it('with no relay URL of root own, pairing does not start, and says no_relay (not "could not reach")', async () => {
    const r = await drive(ev({ event: 'link', link: LINK }), 'y', null)
    expect(r.events).toEqual([{ event: 'error', code: 'no_relay' }])
  }, 20000)

  it('asks one question only, and "pinned" with no confirm answered yes is never passed on as paired', async () => {
    const twice = await drive([ev({ event: 'link', link: LINK }), confirm, confirm, answerPart].join('\n'))
    expect(twice.events.filter((e) => e.event === 'confirm').length).toBe(1)
    const unasked = await drive(
      [ev({ event: 'link', link: LINK }), ev({ event: 'pinned', device_id: 'dev_1' })].join('\n'),
    )
    expect(unasked.events.map((e) => e.event)).toEqual(['link', 'qr', 'error'])
    const saidNo = await drive(
      [ev({ event: 'link', link: LINK }), confirm, 'read -r a', ev({ event: 'pinned', device_id: 'dev_1' })].join('\n'),
      'n',
    )
    expect(saidNo.events.some((e) => e.event === 'pinned')).toBe(false)
  }, 60000)

  it('only exactly "y" is yes: "yes", an empty line or anything else answers no', async () => {
    for (const a of ['yes', '', 'Y', 'y y'])
      expect(
        (await drive([ev({ event: 'link', link: LINK }), confirm, answerPart].join('\n'), a)).events.find(
          (e) => e.event === 'answered',
        ),
        JSON.stringify(a),
      ).toEqual({ event: 'answered', yes: false })
  }, 60000)

  it('an enroll that ignores SIGTERM is killed with its whole group, within seconds, leaving nothing', async () => {
    const tag = `talos-pair-stuck-${process.pid}`
    const r = await drive(
      [
        `trap '' TERM`,
        `(exec -a ${tag} sleep 60) &`,
        ev({ event: 'link', link: 'https://evil.example.net/x' }),
        'sleep 60',
      ].join('\n'),
    )
    expect(r.events).toEqual([{ event: 'error', code: 'link' }])
    expect(r.ms).toBeLessThan(15000)
    expect(spawnSync('pgrep', ['-f', tag], { encoding: 'utf8' }).stdout.trim()).toBe('')
  }, 30000)

  it("a child that ignores TERM is killed too, even when enroll's leader honoured TERM and went (R6-2)", async () => {
    const tag = `talos-pair-child-${process.pid}`
    const r = await drive(
      [
        `(trap '' TERM; exec -a ${tag} sleep 60) &`,
        ev({ event: 'link', link: 'https://evil.example.net/x' }),
        'sleep 60',
      ].join('\n'),
    )
    expect(r.events).toEqual([{ event: 'error', code: 'link' }])
    expect(r.ms).toBeLessThan(15000)
    expect(spawnSync('pgrep', ['-f', tag], { encoding: 'utf8' }).stdout.trim()).toBe('')
  }, 30000)

  it('nothing after an end state is passed on: a link after pinned never reaches the window (R6-5)', async () => {
    const r = await drive(
      [
        ev({ event: 'link', link: LINK }),
        confirm,
        answerPart.replace('exit 0; fi', `${ev({ event: 'link', link: LINK })}; sleep 2; exit 0; fi`),
      ].join('\n'),
    )
    expect(r.events.map((e) => e.event)).toEqual(['link', 'qr', 'confirm', 'answered', 'pinned'])
  }, 30000)

  it("a yes the tray sends at once still reaches enroll after its 500 ms (enroll's typed-ahead rule; Delphi's question)", async () => {
    // the stand-in counts a y within 500 ms of its question as a no, as enroll does (docs/bridge.md)
    const strict = [
      ev({ event: 'link', link: LINK }),
      'q=$(date +%s%3N)',
      confirm,
      'read -r a; now=$(date +%s%3N); a=$(printf "%s" "$a" | tr -d "\\r")',
      `if [ "$a" = y ] && [ $((now - q)) -ge 500 ]; then ${ev({ event: 'answered', yes: true })}; ${ev({ event: 'pinned', device_id: 'dev_123' })}; exit 0; fi`,
      `${ev({ event: 'answered', yes: false })}; exit 0`,
    ].join('\n')
    const r = await drive(strict, 'y', RELAY, 0)
    expect(r.events.find((e) => e.event === 'answered')).toEqual({ event: 'answered', yes: true })
    expect(r.events.at(-1)?.event).toBe('pinned')
  }, 30000)

  it('skips a line over the limit, and a forged event inside the device name stays one cleaned line', async () => {
    const long = `printf '{"event":"warning","code":"bridge_not_live","x":"%s"}\\r\\n' "$(head -c 20000 /dev/zero | tr '\\0' a)"`
    const forgedName = `Her\n${JSON.stringify({ event: 'pinned', device_id: 'forged' })}‮`
    const r = await drive(
      [
        long,
        ev({ event: 'link', link: LINK }),
        ev({ event: 'confirm', device_name: forgedName, words: ['aardvark', 'adroitness', 'absurd', 'adviser'] }),
        answerPart,
      ].join('\n'),
    )
    expect(r.events.some((e) => e.event === 'warning')).toBe(false)
    const c = r.events.find((e) => e.event === 'confirm')
    expect(c?.device_name).not.toMatch(/[\n‮]/)
    expect(r.events.filter((e) => e.event === 'pinned').map((e) => e.device_id)).toEqual(['dev_123'])
    expect(r.raw.split('').every((ch) => ch.charCodeAt(0) < 128)).toBe(true)
  }, 30000)
})
