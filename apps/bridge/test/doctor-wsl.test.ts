// `talos-app doctor` on WSL (src/doctor-wsl.ts): the distro, systemd, lingering and where the Talos folders live.
import { describe, expect, test } from 'bun:test'
import { type WslProbe, wslDoctorChecks } from '../src/doctor-wsl.ts'

type Row = { level: string; name: string; detail: string }
function rows(probe: WslProbe, places = [{ name: 'Talos home', path: '/home/alex/.config/talos/app' }]): Row[] {
  const out: Row[] = []
  wslDoctorChecks((level, name, detail) => out.push({ level, name, detail }), places, probe)
  return out
}
const fast = () => ({ ok: true, ms: 12 })
const good: WslProbe = {
  wsl: true,
  distro: 'Ubuntu',
  pid1: 'systemd',
  linger: 'yes',
  pathIssue: () => null,
  lookup: fast,
  resolvConf: 'nameserver 10.255.255.254\nnameserver 1.1.1.1\n',
  talosDistro: true,
  installedHasFallback: true,
}

describe('doctor on WSL', () => {
  test('off WSL there are no rows at all', () => {
    expect(rows({ ...good, wsl: false })).toEqual([])
  })

  test('a ready distro: every row ok, and the distro named the way Windows must start it', () => {
    const r = rows(good)
    expect(r.map((x) => x.level)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
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

  // The owner's first Windows sign-in (2026-11-16) failed on a resolver that timed out on every name it had not cached.
  describe('WSL DNS: a real lookup of the names Claude Code needs, and the fix in one line', () => {
    const dns = (probe: WslProbe) => rows({ ...good, ...probe }).find((x) => x.name === 'WSL DNS')

    test('all three answer: ok, with the slowest time', () => {
      const r = dns({ lookup: (h) => ({ ok: true, ms: h === 'claude.ai' ? 140 : 9 }) })
      expect(r?.level).toBe('ok')
      expect(r?.detail).toBe('platform.claude.com, api.anthropic.com, claude.ai answer (slowest 140 ms)')
    })

    test('the names asked are the sign-in exchange, the API and the sign-in page', () => {
      const asked: string[] = []
      dns({ lookup: (h) => (asked.push(h), { ok: true, ms: 1 }) })
      expect(asked).toEqual(['platform.claude.com', 'api.anthropic.com', 'claude.ai'])
    })

    test("Talos's distro without the fallback yet: one restart of the distro is the fix", () => {
      const r = dns({
        lookup: (h) => (h === 'platform.claude.com' ? { ok: false, ms: 6000 } : { ok: true, ms: 5 }),
        resolvConf: 'nameserver 172.21.32.1\n',
        distro: 'talos',
      })
      expect(r?.level).toBe('warn')
      expect(r?.detail).toBe(
        'platform.claude.com did not resolve. Fix: in Windows run wsl --terminate talos; Talos starts it again with fallback DNS (1.1.1.1, 8.8.8.8).',
      )
    })

    test("Talos's distro whose installed script predates the fallback: Setup again, never a restart that changes nothing", () => {
      const r = dns({
        lookup: () => ({ ok: false, ms: 6000 }),
        resolvConf: 'nameserver 172.21.32.1\n',
        installedHasFallback: false,
      })
      expect(r?.level).toBe('FAIL')
      expect(r?.detail).toContain('run Talos Setup again')
      expect(r?.detail).not.toContain('wsl --terminate')
    })

    test('a test that runs the doctor on WSL without a lookup gets no DNS row (no network lookups in tests)', () => {
      expect(rows({ ...good, lookup: undefined }).some((x) => x.name === 'WSL DNS')).toBe(false)
    })

    test("Talos's distro with the fallback, and nothing answers: FAIL, and the network is named", () => {
      const r = dns({ lookup: () => ({ ok: false, ms: 6000 }) })
      expect(r?.level).toBe('FAIL')
      expect(r?.detail).toContain('cannot reach any DNS server')
      expect(r?.detail.split('Fix:').length).toBe(2)
    })

    test('slow counts: a name that took 1.6 s is a warning, with its time', () => {
      const r = dns({
        lookup: (h) => ({ ok: true, ms: h === 'claude.ai' ? 1600 : 5 }),
        resolvConf: 'nameserver 172.21.32.1\n',
      })
      expect(r?.level).toBe('warn')
      expect(r?.detail).toMatch(/^claude\.ai took 1600 ms\. Fix: in Windows run wsl --terminate Ubuntu;/)
    })

    test('another WSL distro (not Talos’s): the resolv.conf line to add', () => {
      const r = dns({
        lookup: () => ({ ok: false, ms: 10 }),
        talosDistro: false,
        resolvConf: 'nameserver 10.255.255.254\n',
      })
      expect(r?.level).toBe('FAIL')
      expect(r?.detail).toContain('add "nameserver 1.1.1.1" to /etc/resolv.conf')
    })
  })
})
