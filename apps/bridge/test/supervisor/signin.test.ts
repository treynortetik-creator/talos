// The sign-in flow the supervisor owns (Linux and WSL): `claude auth login` on a pty of its own, its link read off the screen, the
// owner's code fed to it through one gate, a wrong code answered with an error and a fresh link, and the sessions resumed once Claude
// says it is signed in. Everything here runs a REAL child on a REAL pty: a small stand-in `claude` script that is as strict as the
// CLI about the code (it reads one line, and takes it only if it is the one it issued) and that keeps its own signed-in state.

import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bunLoginPty,
  claudeAuthStatus,
  parseSignInScreen,
  SignInDriver,
  SignInFlow,
  validCode,
} from '../../src/supervisor/signin.ts'
import { signInDriverFor } from '../../src/supervisor/signin-wiring.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const GOOD = 'GoodCode1234567890abcdefGHIJKLMNOPQRSTUVWXYZ0123456789-_#state'

/** A stand-in `claude`: `auth login` prints a link and waits for one line; `auth status --json` reads the state file. */
function fakeClaude(): { claude: string; dir: string; signedIn: () => boolean; signOutForTest: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'talos-signin-test-'))
  dirs.push(dir)
  const claude = join(dir, 'claude')
  writeFileSync(
    claude,
    `#!/bin/sh
STATE="${dir}/in"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -f "$STATE" ]; then echo '{"loggedIn":true}'; exit 0; fi
  echo '{"loggedIn":false}'; exit 1
fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  echo "Opening browser to sign in..."
  echo "If the browser did not open, visit: https://claude.ai/oauth/authorize?code=true&state=abc123"
  printf "Paste code here if prompted > "
  read code
  if [ "$code" = "${GOOD}" ]; then touch "$STATE"; echo "Login successful."; exit 0; fi
  echo "Invalid code. Please try again."; exit 1
fi
exit 2
`,
  )
  chmodSync(claude, 0o755)
  return {
    claude,
    dir,
    signedIn: () => existsSync(join(dir, 'in')),
    signOutForTest: () => rmSync(join(dir, 'in'), { force: true }),
  }
}

function flowFor(f: ReturnType<typeof fakeClaude>, resumed: string[] = []) {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.dir }
  return new SignInFlow({
    spawn: () => bunLoginPty(f.claude, env),
    status: () => claudeAuthStatus(f.claude, env),
    onSignedIn: () => {
      resumed.push('resumed')
    },
    pollMs: 25,
    returnDelayMs: 60,
    limitMs: 20_000,
  })
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(20)
  }
}

describe('the sign-in screen', () => {
  it('reads the link and the code prompt, and nothing off another host', () => {
    const s = parseSignInScreen([
      'visit: https://claude.ai/oauth/authorize?code=true&state=abc',
      'Paste code here if prompted >',
    ])
    expect(s.url).toBe('https://claude.ai/oauth/authorize?code=true&state=abc')
    expect(s.wantsCode).toBe(true)
    for (const bad of [
      'https://evil.example/claude.ai',
      'http://claude.ai/x',
      `https://someone:secret${'@'}claude.ai/x`,
      'https://claude.ai:8443/x',
      'https://claude.ai.evil.com/x',
    ])
      expect(parseSignInScreen([bad]).url).toBeNull()
  })
})

describe('the code gate', () => {
  it('takes one line of printable characters and nothing that could press another key', () => {
    expect(validCode(GOOD)).toBe(true)
    for (const bad of ['', '   ', 'a\rb', 'a\nb', 'abc\x1b[A', 'x'.repeat(2000), 'two words', 'a\x03b'])
      expect(validCode(bad)).toBe(false)
  })
})

describe('the flow, against a real child on a real pty', () => {
  it('raises the link, takes the code through the gate, and resumes the sessions once signed in', async () => {
    const f = fakeClaude()
    const resumed: string[] = []
    const flow = flowFor(f, resumed)
    expect(flow.start()).toBe(true)
    expect(flow.start()).toBe(false) // one sign-in at a time
    await until(() => flow.state.phase === 'waiting' && flow.state.wantsCode)
    const st = flow.state
    if (st.phase !== 'waiting') throw new Error('not waiting')
    expect(st.url).toBe('https://claude.ai/oauth/authorize?code=true&state=abc123')
    expect(st.error).toBeNull()
    expect((await flow.submitCode(GOOD)).ok).toBe(true)
    await until(() => flow.state.phase === 'signed_in')
    expect(f.signedIn()).toBe(true)
    expect(resumed).toEqual(['resumed']) // once
  })

  it('a wrong code shows an error, offers a fresh link, and the right code then works', async () => {
    const f = fakeClaude()
    const resumed: string[] = []
    const flow = flowFor(f, resumed)
    flow.start()
    await until(() => flow.state.phase === 'waiting' && flow.state.wantsCode)
    expect((await flow.submitCode('WrongCodeWrongCode123')).ok).toBe(true) // typed; the CLI refuses it
    await until(() => flow.state.phase === 'waiting' && flow.state.error !== null && flow.state.wantsCode)
    const st = flow.state
    if (st.phase !== 'waiting') throw new Error('not waiting')
    expect(st.error).toBe('wrong_code')
    expect(st.attempt).toBe(2)
    expect(f.signedIn()).toBe(false)
    expect(resumed).toEqual([]) // nothing resumed on a wrong code
    expect((await flow.submitCode(GOOD)).ok).toBe(true)
    await until(() => flow.state.phase === 'signed_in')
    expect(resumed).toEqual(['resumed'])
  })

  it('refuses a code when no sign-in is waiting for one, and types nothing', async () => {
    const f = fakeClaude()
    const flow = flowFor(f)
    expect(await flow.submitCode(GOOD)).toEqual({ ok: false, reason: 'not_waiting' }) // idle
    flow.start()
    await until(() => flow.state.phase === 'waiting' && flow.state.wantsCode)
    expect(await flow.submitCode('a\rb')).toEqual({ ok: false, reason: 'bad_code' })
    expect(await flow.submitCode('')).toEqual({ ok: false, reason: 'bad_code' })
    flow.cancel()
    await flow.settled()
    expect(await flow.submitCode(GOOD)).toEqual({ ok: false, reason: 'not_waiting' }) // a second caller after the end
    expect(f.signedIn()).toBe(false)
  })

  it('cancel ends the child and nothing stale stays', async () => {
    const f = fakeClaude()
    const flow = flowFor(f)
    flow.start()
    await until(() => flow.state.phase === 'waiting')
    const pid = flow.pid
    expect(pid).not.toBeNull()
    flow.cancel()
    await flow.settled()
    expect(flow.state.phase).toBe('idle')
    expect(flow.pid).toBeNull()
    let alive = true
    try {
      process.kill(pid as number, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  })

  it('a claude that is not there fails visibly, never reads as idle', async () => {
    const f = fakeClaude()
    const flow = new SignInFlow({
      spawn: () => {
        throw new Error('spawn failed')
      },
      status: () => claudeAuthStatus(f.claude, {}),
      onSignedIn: () => {},
      pollMs: 25,
      returnDelayMs: 10,
      limitMs: 2000,
    })
    flow.start()
    await flow.settled()
    expect(flow.state).toEqual({ phase: 'failed', why: 'could_not_start' })
  })
})

describe('the driver: who needs the sign-in, and who resumes after it', () => {
  function driverFor(
    f: ReturnType<typeof fakeClaude>,
    opts: { main: boolean; threads: string[]; owner?: boolean; off?: boolean; clock?: { t: number } },
  ) {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.dir }
    const calls: string[] = []
    const d = new SignInDriver({
      spawn: () => bunLoginPty(f.claude, env),
      status: () => claudeAuthStatus(f.claude, env),
      signedOut: () => opts.main,
      signedOutThreads: () => opts.threads,
      ownerStopped: () => opts.owner === true,
      restartMain: async () => {
        calls.push('main')
      },
      restartThread: async (id) => {
        calls.push(`thread:${id}`)
      },
      audit: (e) => calls.push(`audit:${e}`),
      tell: (w) => calls.push(`tell:${w}`),
      startLogins: opts.off !== true,
      now: () => opts.clock?.t ?? Date.now(),
      pollMs: 25,
      returnDelayMs: 40,
      limitMs: 20_000,
    })
    return { d, calls }
  }

  it('starts the sign-in for a signed-out Main, shows the link, and restarts Main and the waiting threads once signed in', async () => {
    const f = fakeClaude()
    const { d, calls } = driverFor(f, { main: true, threads: ['t1', 't2'] })
    expect(d.link()).toBeNull()
    await d.tick()
    await until(() => d.link() !== null)
    expect(d.link()).toBe('https://claude.ai/oauth/authorize?code=true&state=abc123')
    await d.tick() // a second tick starts no second login
    expect((await d.submitCode(GOOD)).ok).toBe(true)
    await until(() => calls.includes('main'))
    await d.settled()
    expect(calls.filter((c) => !c.startsWith('audit'))).toEqual(['main', 'thread:t1', 'thread:t2'])
    expect(d.link()).toBeNull() // nothing stale after success
  })

  it('does nothing when nobody is signed out, or after the owner stopped Main', async () => {
    const f = fakeClaude()
    const a = driverFor(f, { main: false, threads: [] })
    await a.d.tick()
    expect(a.d.link()).toBeNull()
    expect(a.d.running()).toBe(false)
    const b = driverFor(f, { main: true, threads: [], owner: true })
    await b.d.tick()
    expect(b.d.running()).toBe(false)
  })

  it('a thread signed out while Main is fine is resumed too, and Main is not restarted', async () => {
    const f = fakeClaude()
    const { d, calls } = driverFor(f, { main: false, threads: ['t9'] })
    await d.tick()
    await until(() => d.link() !== null)
    await d.submitCode(GOOD)
    await until(() => calls.includes('thread:t9'))
    expect(calls).not.toContain('main')
  })

  it('a dependency that throws is audited, never lost and never thrown at the supervisor loop', async () => {
    const f = fakeClaude()
    const calls: string[] = []
    const d = new SignInDriver({
      spawn: () => bunLoginPty(f.claude, {}),
      status: async () => 'unknown',
      signedOut: () => {
        throw new Error('boom')
      },
      signedOutThreads: () => [],
      ownerStopped: () => false,
      restartMain: async () => {},
      restartThread: async () => {},
      audit: (e, fields) => calls.push(`${e}:${fields?.error ?? ''}`),
      tell: () => {},
      startLogins: true,
    })
    await d.tick()
    expect(calls).toEqual(['signin_tick_failed:boom'])
  })

  it('spawns no login while nothing can feed it a code (the phone code field is not built): the line is all the owner gets', async () => {
    const f = fakeClaude()
    const spawned: string[] = []
    const d = new SignInDriver({
      spawn: () => {
        spawned.push('spawn')
        throw new Error('must not spawn')
      },
      status: async () => 'out',
      signedOut: () => true,
      signedOutThreads: () => ['t1'],
      ownerStopped: () => false,
      restartMain: async () => {},
      restartThread: async () => {},
      audit: () => {},
      tell: () => {},
      startLogins: false,
    })
    await d.tick()
    await d.tick()
    expect(spawned).toEqual([])
    expect(d.running()).toBe(false)
    expect(d.link()).toBeNull()
    expect(f.signedIn()).toBe(false)
  })

  it('still signed out after the one restart: no second restart, one line to the owner, and a clean spell re-arms it', async () => {
    const f = fakeClaude()
    const opts = { main: true, threads: [] as string[], clock: { t: Date.now() } }
    const { d, calls } = driverFor(f, opts)
    await d.tick()
    await until(() => d.link() !== null)
    await d.submitCode(GOOD)
    await until(() => calls.includes('main'))
    await d.settled()
    // Main still shows signed out after the restart (a refused token, say): nothing starts again
    opts.clock.t += 3 * 60_000 // past the grace the restart gets
    await d.tick()
    await d.tick()
    expect(calls.filter((c) => c === 'main')).toEqual(['main'])
    expect(calls.filter((c) => c.startsWith('tell:'))).toEqual(['tell:still_signed_out'])
    expect(d.running()).toBe(false)
    // Main is fine for a tick, then signed out again: a new sign-in is allowed
    opts.main = false
    await d.tick()
    opts.main = true
    f.signOutForTest()
    await d.tick()
    await until(() => d.link() !== null)
    // that sign-in is waiting for a code: end it, or its fake claude stays on the pty
    d.cancel()
    await d.settled()
  })
})

describe("the status check runs in Main's own environment", () => {
  it('claude auth status sees the variables the sign-in was given (the tray token file Main gets)', async () => {
    const f = fakeClaude()
    // the stand-in records one variable of its environment when asked for status
    writeFileSync(
      f.claude,
      `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo "$TALOS_TEST_MARK" > "${f.dir}/status-env"; echo '{"loggedIn":false}'; exit 1; fi
exit 2
`,
    )
    const d = signInDriverFor({
      env: () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.dir, TALOS_TEST_MARK: 'main-env' }),
      claude: () => f.claude,
      main: {
        signedOut: () => true,
        status: () => ({ phase: 'running' }) as never,
        stop: async () => {},
        start: async () => {},
      },
      stoppedFlag: join(f.dir, 'stopped'),
      threads: () => [],
      workers: { entry: () => undefined, restart: async () => {} },
      audit: () => {},
      startLogins: true,
    })
    await d.tick()
    await until(() => existsSync(join(f.dir, 'status-env')))
    d.cancel()
    await d.settled()
    expect(readFileSync(join(f.dir, 'status-env'), 'utf8').trim()).toBe('main-env')
  })
})
