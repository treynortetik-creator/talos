// Setup and recovery CLI (audit D47, D54-D56, D59, D62): status --json, doctor/status proving the relay accepts this
// Mac, enroll's live-bridge check, QR and 401 hint, start, logs, and the redacted report. Real CLI against the real
// bridge on FakeRelay; FakeRelay refuses an unknown bridge key with a 401 exactly as the real relay does.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { renderUnicodeCompact } from 'uqr'
import { type CliDeps, runCli } from '../src/cli.ts'
import { formatLogLine } from '../src/cli-main.ts'
import { paths } from '../src/config.ts'
import { redact } from '../src/redact.ts'
import { STATUS_KEYS } from '../src/status-file.ts'
import { type Harness, startHarness, tempHome, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

function cliIO(clock?: { t: number }) {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async () => 'n',
      sleep: async () => {},
      // a clock that runs fast, so enroll's 10 minute wait ends at once
      now: () => {
        if (!clock) return Date.now()
        clock.t += 60_000
        return clock.t
      },
    },
  }
}
const envOf = (home: string, relayUrl?: string) => ({
  TALOS_APP_HOME: home,
  ...(relayUrl ? { TALOS_APP_RELAY_URL: relayUrl } : {}),
})

/** A home whose bridge.key the FakeRelay has never heard of: what a rotated or never-pasted key looks like. */
async function homeWithUnknownKey(relayUrl: string) {
  const home = join(tempHome(), 'app')
  const c = cliIO()
  expect(await runCli(['init', '--relay-url', relayUrl], c.io, { TALOS_APP_HOME: home })).toBe(0)
  return { home, pub: (JSON.parse(readFileSync(paths(home).bridgeKey, 'utf8')) as { public: string }).public }
}

const aliveAll: CliDeps = { alive: () => true }

describe('D47 talos-app status --json', () => {
  test('prints the status.json fields plus relay_reachable, from a real live bridge', async () => {
    h = await startHarness()
    await waitFor(() => existsSync(paths(h?.home ?? '').status), 3000, 'status.json')
    const c = cliIO()
    expect(await runCli(['status', '--json'], c.io, envOf(h.home, h.relay.httpUrl), aliveAll)).toBe(0)
    const j = JSON.parse(c.out.join('\n')) as Record<string, unknown>
    for (const k of STATUS_KEYS) expect(j).toHaveProperty(k)
    expect(j.mode).toBe('live')
    expect(j.pid).toBe(process.pid)
    expect(j.liveness).toBe('live')
    expect(j.relay_reachable).toBe(true)
    expect(j.relay_accepts_key).toBe(true)
    expect((j.relay as { connected: boolean }).connected).toBe(true)
  })

  test('no bridge has run: liveness none, no invented fields, still valid JSON', async () => {
    const home = join(tempHome(), 'app')
    const c = cliIO()
    expect(await runCli(['status', '--json'], c.io, envOf(home))).toBe(0)
    const j = JSON.parse(c.out.join('\n')) as Record<string, unknown>
    expect(j.liveness).toBe('none')
    expect(j.relay_reachable).toBeNull()
    expect(j).not.toHaveProperty('pid')
  })

  test('a dead pid with a fresh file reads dead, not live', async () => {
    h = await startHarness()
    await waitFor(() => existsSync(paths(h?.home ?? '').status), 3000, 'status.json')
    const c = cliIO()
    await runCli(['status', '--json'], c.io, envOf(h.home, h.relay.httpUrl), { alive: () => false })
    expect((JSON.parse(c.out.join('\n')) as { liveness: string }).liveness).toBe('dead')
  })
})

describe('D55 doctor and status prove the relay accepts this Mac', () => {
  test('a relay that refuses the key: FAIL with the fix (the BRIDGE_PUBKEY line), exit 1, status says NO', async () => {
    h = await startHarness({ startBridge: false })
    const bad = await homeWithUnknownKey(h.relay.httpUrl)
    const c = cliIO()
    const code = await runCli(['doctor', '--agent-dir', bad.home], c.io, envOf(bad.home, h.relay.httpUrl))
    const text = c.out.join('\n')
    expect(code).toBe(1)
    expect(text).toMatch(/FAIL\s+relay accepts this Mac: The relay turned away this Mac's key/)
    expect(text).toContain(`BRIDGE_PUBKEY=${bad.pub}`)
    expect(text).toContain('Deploy')
    expect(text).toMatch(/ok\s+relay \/healthz/) // reachable is not accepted: both lines, different verdicts
    const s = cliIO()
    await runCli(['status'], s.io, envOf(bad.home, h.relay.httpUrl))
    expect(s.out.join('\n')).toMatch(/relay accepts this Mac: NO\. The relay turned away this Mac's key/)
    const j = cliIO()
    await runCli(['status', '--json'], j.io, envOf(bad.home, h.relay.httpUrl))
    expect((JSON.parse(j.out.join('\n')) as { relay_accepts_key: boolean }).relay_accepts_key).toBe(false)
  })

  test('the right key: ok, plus the live bridge state read from status.json', async () => {
    h = await startHarness()
    await waitFor(() => existsSync(paths(h?.home ?? '').status), 3000, 'status.json')
    const c = cliIO()
    await runCli(['doctor', '--agent-dir', h.home], c.io, envOf(h.home, h.relay.httpUrl), aliveAll)
    const text = c.out.join('\n')
    expect(text).toMatch(/ok\s+relay accepts this Mac/)
    expect(text).toMatch(/ok\s+live bridge \(status\.json\): live \(pid \d+\), connected to the relay/)
  })

  test('no live bridge: doctor warns and says how to start one', async () => {
    h = await startHarness({ startBridge: false })
    const c = cliIO()
    await runCli(['doctor', '--agent-dir', h.home], c.io, envOf(h.home, h.relay.httpUrl))
    expect(c.out.join('\n')).toMatch(/warn\s+live bridge \(status\.json\): no status\.json.*talos-app start/)
  })

  test('a dead bridge file: warns "not running" even though the stamp is fresh', async () => {
    h = await startHarness()
    await waitFor(() => existsSync(paths(h?.home ?? '').status), 3000, 'status.json')
    const c = cliIO()
    await runCli(['doctor', '--agent-dir', h.home], c.io, envOf(h.home, h.relay.httpUrl), { alive: () => false })
    expect(c.out.join('\n')).toMatch(/warn\s+live bridge \(status\.json\): the bridge is not running/)
  })
})

describe('D56 and D59 talos-app enroll', () => {
  test('warns up front, before the link, when no live bridge is running', async () => {
    h = await startHarness({ startBridge: false })
    const c = cliIO({ t: Date.now() })
    expect(await runCli(['enroll'], c.io, envOf(h.home, h.relay.httpUrl))).toBe(0)
    const warn = c.out.findIndex((l) => l.startsWith('Warning: no status.json'))
    const link = c.out.findIndex((l) => /\/enroll#/.test(l))
    expect(warn).toBeGreaterThanOrEqual(0)
    expect(link).toBeGreaterThan(warn)
    expect(c.out.join('\n')).toContain('Nobody can pin the new device until a live bridge is running')
  })

  test('no warning with a live bridge; a QR code of exactly the printed link follows it; --no-qr leaves it out', async () => {
    h = await startHarness()
    await waitFor(() => existsSync(paths(h?.home ?? '').status), 3000, 'status.json')
    const c = cliIO({ t: Date.now() - 60_000 })
    await runCli(['enroll'], c.io, envOf(h.home, h.relay.httpUrl), aliveAll)
    expect(c.out.some((l) => l.startsWith('Warning'))).toBe(false)
    const link = c.out.find((l) => /^http\S+\/enroll#\S+$/.test(l)) as string
    expect(link).toBeTruthy()
    const at = c.out.indexOf(link)
    const qr = renderUnicodeCompact(link, { border: 1 }).split('\n')
    expect(c.out.slice(at + 2, at + 2 + qr.length)).toEqual(qr)
    expect(qr.length).toBeGreaterThan(10)
    const n = cliIO({ t: Date.now() - 60_000 })
    await runCli(['enroll', '--no-qr'], n.io, envOf(h.home, h.relay.httpUrl), aliveAll)
    expect(n.out.some((l) => /[▀▄█]/.test(l))).toBe(false)
  })

  test('a relay that refuses the key: the bare 401 becomes the fix, and no spent code is left behind', async () => {
    h = await startHarness({ startBridge: false })
    const bad = await homeWithUnknownKey(h.relay.httpUrl)
    const c = cliIO({ t: Date.now() })
    expect(await runCli(['enroll'], c.io, envOf(bad.home, h.relay.httpUrl))).toBe(1)
    const err = c.err.join('\n')
    expect(err).toContain("turned away this Mac's key")
    expect(err).toContain(`BRIDGE_PUBKEY=${bad.pub}`)
    expect(err).not.toContain('relay said 401')
    expect(readdirSync(paths(bad.home).enrollPending)).toEqual([])
  })
})

describe('D54 talos-app start', () => {
  const agent = () => {
    const dir = tempHome('talos-agent-')
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { 'talos-app': { command: 'bun', args: ['run', '--cwd', '/x', '--silent', 'start'], env: {} } },
      }),
    )
    return dir
  }

  test('runs claude in the agent folder with the bridge env, the owner flags first and the channel flag last', async () => {
    const dir = agent()
    const calls: Array<{ cmd: string[]; cwd: string; env: Record<string, string> }> = []
    const c = cliIO()
    const code = await runCli(
      ['start', '--agent-dir', dir, '--', '--model', 'opus', '--continue'],
      c.io,
      envOf(tempHome()),
      {
        which: (n) => (n === 'claude' ? '/opt/bin/claude' : null),
        spawn: async (cmd, o) => {
          calls.push({ cmd, ...o })
          return 7
        },
      },
    )
    expect(code).toBe(7) // the child's exit code is ours
    expect(calls).toHaveLength(1)
    expect(calls[0]?.cmd).toEqual([
      '/opt/bin/claude',
      '--model',
      'opus',
      '--continue',
      '--dangerously-load-development-channels',
      'server:talos-app',
    ])
    expect(calls[0]?.cwd).toBe(dir)
    expect(calls[0]?.env).toEqual({ TALOS_APP_BRIDGE: '1', MCP_PROTOCOL_NEGOTIATION: 'legacy' })
  })

  test('once install-guards has run, start carries the guards settings; a --settings of the owner is kept and warned about', async () => {
    const dir = agent()
    const home = tempHome()
    const settings = join(home, 'guards', 'settings.json')
    mkdirSync(join(home, 'guards'), { recursive: true })
    writeFileSync(settings, '{}')
    const run = async (flags: string[]) => {
      const calls: string[][] = []
      const c = cliIO()
      await runCli(['start', '--agent-dir', dir, '--', ...flags], c.io, envOf(home), {
        which: () => '/opt/bin/claude',
        spawn: async (cmd) => {
          calls.push(cmd)
          return 0
        },
      })
      return { cmd: calls[0] as string[], err: c.err.join('\n') }
    }
    const plain = await run(['--model', 'opus'])
    expect(plain.cmd.slice(-2)).toEqual(['--settings', settings])
    expect(plain.err).toBe('')
    const own = await run(['--settings', '/mine.json'])
    expect(own.cmd.filter((a) => a === '--settings')).toHaveLength(1)
    expect(own.err).toContain('NOT active')
    rmSync(settings)
    expect((await run([])).cmd).not.toContain('--settings')
  })

  test('a real child process gets the env and the cwd (a fake claude on PATH)', async () => {
    const dir = agent()
    const bin = tempHome('talos-bin-')
    const outFile = join(bin, 'seen.txt')
    const fake = join(bin, 'claude')
    writeFileSync(
      fake,
      `#!/bin/sh\necho "$TALOS_APP_BRIDGE|$MCP_PROTOCOL_NEGOTIATION|$PWD|$*" > '${outFile}'\nexit 3\n`,
    )
    chmodSync(fake, 0o755)
    const c = cliIO()
    const code = await runCli(['start', '--agent-dir', dir, '--', '--x'], c.io, envOf(tempHome()), {
      which: () => fake,
    })
    expect(code).toBe(3)
    const seen = readFileSync(outFile, 'utf8').trim().split('|')
    expect(seen[0]).toBe('1')
    expect(seen[1]).toBe('legacy')
    expect(statSync(seen[2] as string).ino).toBe(statSync(dir).ino) // macOS /var is a symlink: compare the folders
    expect(seen[3]).toBe('--x --dangerously-load-development-channels server:talos-app')
  })

  test('no .mcp.json entry: says to run install.sh and starts nothing', async () => {
    const dir = tempHome('talos-agent-')
    const c = cliIO()
    let spawned = false
    const code = await runCli(['start', '--agent-dir', dir], c.io, envOf(tempHome()), {
      which: () => '/x/claude',
      spawn: async () => {
        spawned = true
        return 0
      },
    })
    expect(code).toBe(1)
    expect(spawned).toBe(false)
    expect(c.err.join('\n')).toContain('install.sh')
  })

  test('claude not installed: a plain message, nothing spawned; --dry-run only prints', async () => {
    const dir = agent()
    const c = cliIO()
    let spawned = false
    const deps: CliDeps = {
      which: () => null,
      spawn: async () => {
        spawned = true
        return 0
      },
    }
    expect(await runCli(['start', '--agent-dir', dir], c.io, envOf(tempHome()), deps)).toBe(1)
    expect(c.err.join('\n')).toContain('`claude` is not on your PATH')
    const d = cliIO()
    expect(await runCli(['start', '--agent-dir', dir, '--dry-run'], d.io, envOf(tempHome()), deps)).toBe(0)
    expect(d.out.join('\n')).toContain('TALOS_APP_BRIDGE=1 MCP_PROTOCOL_NEGOTIATION=legacy claude')
    expect(spawned).toBe(false)
  })
})

describe('D62 talos-app logs', () => {
  const seed = (home: string) => {
    mkdirSync(home, { recursive: true })
    const lines = [
      { level: 'info', time: Date.parse('2026-11-01T10:00:00Z'), msg: 'one' },
      { level: 'warn', time: Date.parse('2026-11-01T10:00:01Z'), msg: 'superseded', code: 4409 },
      { level: 'error', time: Date.parse('2026-11-01T10:00:02Z'), msg: 'three' },
    ]
    writeFileSync(paths(home).log, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  }

  test('prints the last N lines, readable', async () => {
    const home = tempHome()
    seed(home)
    const c = cliIO()
    expect(await runCli(['logs', '-n', '2'], c.io, envOf(home))).toBe(0)
    expect(c.out).toEqual([
      '2026-11-01T10:00:01.000Z warn     superseded {"code":4409}',
      '2026-11-01T10:00:02.000Z error    three',
    ])
  })

  test('no log yet: says where it will be and how to start the bridge, exit 1', async () => {
    const c = cliIO()
    expect(await runCli(['logs'], c.io, envOf(tempHome()))).toBe(1)
    expect(c.err.join('\n')).toMatch(/no log yet.*talos-app start/)
  })

  test('a bad -n is refused', async () => {
    const home = tempHome()
    seed(home)
    const c = cliIO()
    expect(await runCli(['logs', '-n', 'lots'], c.io, envOf(home))).toBe(1)
    expect(c.err.join('\n')).toContain('whole number')
  })

  test('--follow shows lines appended later, and starts over when the log is rotated', async () => {
    const home = tempHome()
    seed(home)
    const c = cliIO()
    let ticks = 0
    const io = {
      ...c.io,
      sleep: async () => {
        ticks++
        if (ticks === 1)
          appendFileSync(paths(home).log, `${JSON.stringify({ level: 'info', time: 1, msg: 'later' })}\n`)
        if (ticks === 2)
          writeFileSync(paths(home).log, `${JSON.stringify({ level: 'info', time: 2, msg: 'after rotate' })}\n`)
      },
    }
    await runCli(['logs', '-n', '1', '-f'], io, envOf(home), { followUntil: () => ticks >= 3 })
    const text = c.out.join('\n')
    expect(text).toContain('later')
    expect(text).toContain('after rotate')
  })

  test('formatLogLine passes a non-JSON line through', () => {
    expect(formatLogLine('plain text')).toBe('plain text')
  })
})

describe('D62 talos-app report is redacted', () => {
  test('bundles doctor, status --json and the log, with no key, token, setup code or home folder in it', async () => {
    h = await startHarness()
    await waitFor(() => existsSync(paths(h?.home ?? '').status), 3000, 'status.json')
    const key = JSON.parse(readFileSync(paths(h.home).bridgeKey, 'utf8')) as { public: string; pkcs8: string }
    const code = 'Zq9XkLm3Vb7Rt2Yw8Hn4Jc6Pd5Fs1Ga0'
    writeFileSync(
      paths(h.home).log,
      [
        { level: 'warn', time: 1, msg: `open ${h.relay.httpUrl}/enroll#${code}` },
        {
          level: 'error',
          time: 2,
          msg: 'call failed',
          authorization: 'TalosBridge abc.def.ghi',
          token: 'tok_1234567890',
        },
        { level: 'info', time: 3, msg: 'plain line stays', pkcs8: key.pkcs8 },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    )
    const c = cliIO()
    const outFile = join(tempHome(), 'report.txt')
    expect(
      await runCli(['report', '--agent-dir', h.home, '--out', outFile], c.io, envOf(h.home, h.relay.httpUrl), aliveAll),
    ).toBe(0)
    const text = readFileSync(outFile, 'utf8')
    expect((statSync(outFile).mode & 0o777).toString(8)).toBe('600')
    for (const must of [
      '== doctor ==',
      '== status --json ==',
      '== bridge.log',
      'relay accepts this Mac',
      '"relay_reachable": true',
      'plain line stays',
      'talos-app report: talos-app',
    ])
      expect(text).toContain(must)
    for (const secret of [
      key.public,
      key.pkcs8,
      code,
      'abc.def.ghi',
      'tok_1234567890',
      process.env.HOME ?? '/nope/nope',
    ])
      expect(text).not.toContain(secret)
    expect(text).toContain('BRIDGE_PUBKEY=[redacted]')
    expect(text).toContain('$TALOS_APP_HOME')
  })

  test('without --out it prints to the terminal, with the reminder to read it', async () => {
    const home = tempHome()
    const c = cliIO()
    expect(await runCli(['report'], c.io, envOf(home))).toBe(0)
    expect(c.out.join('\n')).toContain('== doctor ==')
    expect(c.out.at(-1)).toContain('Read it once before you share it')
  })

  test('redact(): keys, bearer headers, setup links and bot tokens; paths and ULIDs survive', () => {
    const t =
      'Bearer abcdef.ghijkl TalosBridge sig123 /enroll#SECRETCODE 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1 BRIDGE_PUBKEY=hh8WMlnJs0gmvgOLLlJuCQIYnLdASbQ8CEBVAHc7_QM /home/alex/Documents/talos-app/apps/bridge/src/cli.ts 01JXKQ3E5R9T7Z2YV4B6C8D0FG'
    const r = redact(t)
    for (const gone of [
      'abcdef.ghijkl',
      'sig123',
      'SECRETCODE',
      'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1',
      'hh8WMlnJs0gmvgOLLlJuCQIYnLdASbQ8CEBVAHc7_QM',
    ])
      expect(r).not.toContain(gone)
    expect(r).toContain('/home/alex/Documents/talos-app/apps/bridge/src/cli.ts')
    expect(r).toContain('01JXKQ3E5R9T7Z2YV4B6C8D0FG')
  })
})
