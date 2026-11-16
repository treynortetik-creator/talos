// `talos-app doctor` on WSL (docs/windows/README.md): what Talos needs from the Linux distro it runs in. Nothing here runs
// off WSL. The supervisor starts at login as a systemd user unit, which needs systemd as PID 1 and lingering (so the unit
// runs without a login shell open), and the Talos folders must be on the Linux disk: on a Windows drive file modes are not
// enforced (a 0600 file is readable by anything) and every file call crosses to Windows.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isWsl, pathIssue } from './secrets/platform.ts'

type Add = (level: 'ok' | 'warn' | 'FAIL', name: string, detail: string) => void

/** What the checks read, each replaceable in tests. `linger` null: loginctl could not say. */
export type WslProbe = {
  wsl?: boolean
  distro?: string
  pid1?: string
  linger?: 'yes' | 'no' | null
  pathIssue?: (path: string) => 'windows_drive' | null
  /** One real lookup of a name, as the system resolver does it (getent: glibc, /etc/resolv.conf). */
  lookup?: (host: string) => { ok: boolean; ms: number }
  /** /etc/resolv.conf as it reads now ('' when unreadable). */
  resolvConf?: string
  /** This is Talos's own Windows distro (/opt/talos-wsl/talos-wsl.sh is there), which sets its DNS at each start. */
  talosDistro?: boolean
  /** That installed script already writes the public fallbacks (it names DNS_PUBLIC). */
  installedHasFallback?: boolean
}

/** The names Claude Code needs: the sign-in's code exchange, the API, the sign-in page. */
export const ANTHROPIC_NAMES = ['platform.claude.com', 'api.anthropic.com', 'claude.ai'] as const
/** Slower than this counts: a resolver that times out once (2 s) and then answers is still a warning. */
const DNS_SLOW_MS = 1500
/** The installed distro script that writes the public fallbacks (only install.ps1 replaces it; a kit update does not). */
const TALOS_WSL_SH = '/opt/talos-wsl/talos-wsl.sh'

type Lookup = { host: string; ok: boolean; ms: number }
/** All the names at once, each timed in its own getent (glibc, /etc/resolv.conf), so a dead network costs one wait. */
function realLookups(hosts: readonly string[]): Lookup[] {
  const script =
    'for h; do ( s=$(date +%s%N); if getent ahostsv4 "$h" >/dev/null; then r=0; else r=1; fi; ' +
    'echo "$h $r $(( ($(date +%s%N) - s) / 1000000 ))" ) & done; wait'
  let out = ''
  try {
    out = spawnSync('sh', ['-c', script, 'sh', ...hosts], { encoding: 'utf8', timeout: 14000 }).stdout ?? ''
  } catch {}
  const got = new Map<string, Lookup>()
  for (const line of out.split('\n')) {
    const [host, r, ms] = line.trim().split(' ')
    if (host && hosts.includes(host)) got.set(host, { host, ok: r === '0', ms: Number(ms) || 0 })
  }
  // a name with no line did not answer within the whole wait
  return hosts.map((host) => got.get(host) ?? { host, ok: false, ms: 14000 })
}

function installedHasFallback(): boolean {
  try {
    return readFileSync(TALOS_WSL_SH, 'utf8').includes('DNS_PUBLIC=')
  } catch {
    return false
  }
}

function readResolvConf(): string {
  try {
    return readFileSync('/etc/resolv.conf', 'utf8')
  } catch {
    return ''
  }
}

/** A real lookup of each Anthropic name, and the fix in one line when one fails or is slow. */
function dnsCheck(add: Add, distro: string, probe: WslProbe): void {
  // a test that runs the doctor on a WSL machine without saying how to look names up gets no row, not network lookups
  if (!probe.lookup && process.env.NODE_ENV === 'test') return
  const lookup = probe.lookup
  const results = lookup ? ANTHROPIC_NAMES.map((host) => ({ host, ...lookup(host) })) : realLookups(ANTHROPIC_NAMES)
  const bad = results.filter((r) => !r.ok || r.ms > DNS_SLOW_MS)
  const slowest = Math.max(...results.map((r) => r.ms))
  if (bad.length === 0) {
    add('ok', 'WSL DNS', `${ANTHROPIC_NAMES.join(', ')} answer (slowest ${slowest} ms)`)
    return
  }
  const what = bad.map((r) => (r.ok ? `${r.host} took ${r.ms} ms` : `${r.host} did not resolve`)).join('; ')
  const talos = probe.talosDistro ?? existsSync(TALOS_WSL_SH)
  const fallback = /^\s*nameserver\s+(1\.1\.1\.1|8\.8\.8\.8)\s*$/m.test(probe.resolvConf ?? readResolvConf())
  const name = distro || '<distro>'
  const fix = !talos
    ? 'Fix: add "nameserver 1.1.1.1" to /etc/resolv.conf (and [network] generateResolvConf=false to /etc/wsl.conf), or pause the VPN.'
    : fallback
      ? 'Fix: this PC cannot reach any DNS server; check its internet connection, or pause a VPN, then run talos-app doctor again.'
      : !(probe.installedHasFallback ?? installedHasFallback())
        ? // a kit update does not replace the distro script: restarting would bring back the same DNS (Opus review on d516bae0)
          'Fix: run Talos Setup again on this PC; it brings the fallback DNS (1.1.1.1, 8.8.8.8) that the distro sets at each start.'
        : `Fix: in Windows run wsl --terminate ${name}; Talos starts it again with fallback DNS (1.1.1.1, 8.8.8.8).`
  // all three failing stops the sign-in and the relay; a slow or single failure is a warning
  add(bad.every((r) => !r.ok) && bad.length === results.length ? 'FAIL' : 'warn', 'WSL DNS', `${what}. ${fix}`)
}

function readPid1(): string {
  try {
    return readFileSync('/proc/1/comm', 'utf8').trim()
  } catch {
    return ''
  }
}

function readLinger(): 'yes' | 'no' | null {
  const user = process.env.USER || process.env.LOGNAME
  if (!user) return null
  try {
    const r = spawnSync('loginctl', ['show-user', user, '--property=Linger', '--value'], {
      encoding: 'utf8',
      timeout: 3000,
    })
    const v = r.status === 0 ? r.stdout.trim() : ''
    return v === 'yes' || v === 'no' ? v : null
  } catch {
    return null
  }
}

/** The WSL rows, or none off WSL. `places` are the folders that must be on the Linux disk. */
export function wslDoctorChecks(add: Add, places: { name: string; path: string }[], probe: WslProbe = {}): void {
  if (!(probe.wsl ?? isWsl())) return
  const distro = probe.distro ?? process.env.WSL_DISTRO_NAME ?? ''
  if (distro)
    add('ok', 'WSL distro', `${distro}; Windows starts it as wsl -d ${distro} (the default distro may be another one)`)
  else add('warn', 'WSL distro', 'WSL_DISTRO_NAME is not set, so the distro to start at login is not known')
  const pid1 = probe.pid1 ?? readPid1()
  if (pid1 === 'systemd') add('ok', 'WSL systemd', 'running')
  else
    add(
      'warn',
      'WSL systemd',
      `PID 1 is ${pid1 || 'unknown'}, not systemd, so Talos cannot start at login. Add [boot] systemd=true to /etc/wsl.conf, then run wsl --shutdown in Windows.`,
    )
  const linger = probe.linger !== undefined ? probe.linger : pid1 === 'systemd' ? readLinger() : null
  if (linger === 'yes') add('ok', 'WSL linger', 'on: user services run without a login shell')
  else if (linger === 'no')
    add('warn', 'WSL linger', 'off: Talos stops when the last WSL window closes. Run: loginctl enable-linger "$USER"')
  else if (pid1 === 'systemd') add('warn', 'WSL linger', 'loginctl could not say whether lingering is on')
  const issue = probe.pathIssue ?? ((p: string) => pathIssue(p))
  for (const { name, path } of places) {
    if (issue(path) === 'windows_drive')
      add(
        'FAIL',
        `${name} location`,
        `${path} is on a Windows drive: file modes are not enforced there, so its secrets are readable by any program, and it is slow. Keep it on the Linux disk, under ~.`,
      )
    else add('ok', `${name} location`, `${path} (on the Linux disk)`)
  }
  dnsCheck(add, distro, probe)
}
