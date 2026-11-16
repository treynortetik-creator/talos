// `talos-app doctor` on WSL (src/doctor-wsl.ts): the distro, systemd, lingering and where the Talos folders live.
import { describe, expect, test } from 'bun:test'
import { type WslProbe, wslDoctorChecks } from '../src/doctor-wsl.ts'

type Row = { level: string; name: string; detail: string }
function rows(probe: WslProbe, places = [{ name: 'Talos home', path: '/home/alex/.config/talos/app' }]): Row[] {
  const out: Row[] = []
  wslDoctorChecks((level, name, detail) => out.push({ level, name, detail }), places, probe)
  return out
}
const good: WslProbe = { wsl: true, distro: 'Ubuntu', pid1: 'systemd', linger: 'yes', pathIssue: () => null }

describe('doctor on WSL', () => {
  test('off WSL there are no rows at all', () => {
    expect(rows({ ...good, wsl: false })).toEqual([])
  })

  test('a ready distro: every row ok, and the distro named the way Windows must start it', () => {
    const r = rows(good)
    expect(r.map((x) => x.level)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(r[0]?.detail).toContain('wsl -d Ubuntu')
  })

  test('no systemd: a warning that says how to turn it on, and no linger row it cannot answer', () => {
    const r = rows({ ...good, pid1: 'init', linger: undefined })
    const sd = r.find((x) => x.name === 'WSL systemd')
    expect(sd?.level).toBe('warn')
    expect(sd?.detail).toContain('systemd=true')
    expect(r.some((x) => x.name === 'WSL linger')).toBe(false)
  })

  test('lingering off: a warning with the command', () => {
    const r = rows({ ...good, linger: 'no' }).find((x) => x.name === 'WSL linger')
    expect(r?.level).toBe('warn')
    expect(r?.detail).toContain('loginctl enable-linger')
  })

  test('a Talos folder on a Windows drive fails, one on the Linux disk does not', () => {
    const r = rows({ ...good, pathIssue: (p) => (p.startsWith('/mnt/') ? 'windows_drive' : null) }, [
      { name: 'Talos home', path: '/home/alex/.config/talos/app' },
      { name: 'agent folder', path: '/mnt/c/Users/alex/agent' },
    ])
    expect(r.find((x) => x.name === 'Talos home location')?.level).toBe('ok')
    const agent = r.find((x) => x.name === 'agent folder location')
    expect(agent?.level).toBe('FAIL')
    expect(agent?.detail).toContain('/mnt/c/Users/alex/agent')
  })

  test('on this machine it answers without throwing, whatever it is', () => {
    expect(() => rows({})).not.toThrow()
  })
})
