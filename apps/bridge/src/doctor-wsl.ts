// `talos-app doctor` on WSL (docs/windows/README.md): what Talos needs from the Linux distro it runs in. Nothing here runs
// off WSL. The supervisor starts at login as a systemd user unit, which needs systemd as PID 1 and lingering (so the unit
// runs without a login shell open), and the Talos folders must be on the Linux disk: on a Windows drive file modes are not
// enforced (a 0600 file is readable by anything) and every file call crosses to Windows.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isWsl, pathIssue } from './secrets/platform.ts'

type Add = (level: 'ok' | 'warn' | 'FAIL', name: string, detail: string) => void

/** What the checks read, each replaceable in tests. `linger` null: loginctl could not say. */
export type WslProbe = {
  wsl?: boolean
  distro?: string
  pid1?: string
  linger?: 'yes' | 'no' | null
  pathIssue?: (path: string) => 'windows_drive' | null
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
}
