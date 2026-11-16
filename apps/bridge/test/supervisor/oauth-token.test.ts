// The tray's sign-in token for Main (supervisor/oauth-token.ts): the file it is read from, and Claude Code's refusal of it on
// screen (the real 2.1.322 capture apps/desktop/Tests/Fixtures/real-first-start-2.1.322/token-refused-401.txt).
import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  notLoggedIn,
  OAUTH_TOKEN_ENV,
  OAUTH_TOKEN_FILE,
  OAUTH_TOKEN_FILE_ENV,
  readOAuthToken,
  TokenRestart,
  tokenRefused,
  tokenStamp,
  withOAuthToken,
} from '../../src/supervisor/oauth-token.ts'
import { parseCapture } from '../../src/supervisor/tmux-commands.ts'

const dirs: string[] = []
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-token-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const ME = process.getuid?.() ?? 0
const TOKEN = `sk-ant-oat01-${'A'.repeat(40)}` // a made-up token of the right shape
const put = (home: string, text: string, mode = 0o600) => {
  writeFileSync(join(home, OAUTH_TOKEN_FILE), text)
  chmodSync(join(home, OAUTH_TOKEN_FILE), mode)
}

describe('the token file', () => {
  it('one line, 0600, this user’s: the token, and the env gets it', () => {
    const h = tmp()
    put(h, `${TOKEN}\n`)
    const r = readOAuthToken(h, ME)
    expect(r).toMatchObject({ token: TOKEN })
    // the launch reads the file itself: the env names it, never carries the token (and a token from elsewhere is dropped)
    expect(withOAuthToken({ PATH: '/bin', [OAUTH_TOKEN_ENV]: 'from-a-profile' }, r, h)).toEqual({
      PATH: '/bin',
      [OAUTH_TOKEN_FILE_ENV]: join(h, OAUTH_TOKEN_FILE),
    })
  })
  it('no file: nothing added (Claude Code then shows its own sign-in)', () => {
    const r = readOAuthToken(tmp(), ME)
    expect(r).toEqual({ none: true })
    // nothing a profile planted survives: neither a token nor a file name of its own
    expect(
      withOAuthToken({ PATH: '/bin', [OAUTH_TOKEN_FILE_ENV]: '/tmp/mine', [OAUTH_TOKEN_ENV]: 'x' }, r, '/h'),
    ).toEqual({
      PATH: '/bin',
    })
  })
  it('refused, saying why and never the token: others can read it, a link, a folder, too big, two lines, another user’s', () => {
    const cases: Array<[string, (h: string) => void, number?]> = [
      ['readable by others', (h) => put(h, TOKEN, 0o644)],
      [
        'cannot be opened',
        (h) => {
          const real = tmp()
          put(real, TOKEN)
          symlinkSync(join(real, OAUTH_TOKEN_FILE), join(h, OAUTH_TOKEN_FILE))
        },
      ],
      ['not a plain file', (h) => mkdirSync(join(h, OAUTH_TOKEN_FILE))],
      ['larger than 4 KB', (h) => put(h, 'A'.repeat(5000))],
      ['not one line of a token', (h) => put(h, `${TOKEN}\nsecond line\n`)],
      ['not one line of a token', (h) => put(h, 'short')],
      ['not this user', (h) => put(h, TOKEN), ME + 1],
    ]
    for (const [why, make, uid] of cases) {
      const h = tmp()
      make(h)
      const r = readOAuthToken(h, uid ?? ME)
      expect(r, why).toMatchObject({ refused: expect.stringContaining(why) })
      expect(JSON.stringify(r), why).not.toContain(TOKEN)
      expect(withOAuthToken({}, r, h), why).toEqual({})
    }
  })
  it('the stamp changes when the tray writes a new token (temp file + rename), and says nothing of the token', () => {
    const h = tmp()
    const none = tokenStamp(readOAuthToken(h, ME))
    put(h, TOKEN)
    const a = tokenStamp(readOAuthToken(h, ME))
    writeFileSync(join(h, 'tmp'), `sk-ant-oat01-${'B'.repeat(40)}`)
    chmodSync(join(h, 'tmp'), 0o600)
    renameSync(join(h, 'tmp'), join(h, OAUTH_TOKEN_FILE))
    const b = tokenStamp(readOAuthToken(h, ME))
    expect(new Set([none, a, b]).size).toBe(3)
    expect(a).not.toContain('AAAA')
  })
})

describe('Claude Code refusing the token', () => {
  const capture = parseCapture(
    readFileSync(
      new URL('../../../desktop/Tests/Fixtures/real-first-start-2.1.322/token-refused-401.txt', import.meta.url),
      'utf8',
    ),
  )
  it('the real capture: the last answer is the 401', () => {
    expect(tokenRefused(capture)).toBe(true)
  })
  it('a later answer clears it; other errors and a quote of it are not a refusal', () => {
    expect(tokenRefused([...capture.slice(0, 14), '● Hello! How can I help?'])).toBe(false)
    expect(tokenRefused(['● API Error: 500 Internal server error'])).toBe(false)
    expect(tokenRefused(['● The log said: Please run /login · API Error: 401'])).toBe(false)
    expect(tokenRefused(['  Please run /login · API Error: 401 (in a tool result)'])).toBe(false)
    // a model's own answer starting with the error's words is not Claude Code's row (Fable)
    expect(tokenRefused(['● API Error: 401 {"type":"error"}'])).toBe(false)
  })
})

describe('Claude Code signed out at its input box (onboarding done, no credentials)', () => {
  const fixture = (name: string) =>
    parseCapture(
      readFileSync(
        new URL(`../../../desktop/Tests/Fixtures/real-first-start-2.1.322/${name}.txt`, import.meta.url),
        'utf8',
      ),
    )
  it('the real capture: "Not logged in · Run /login" just above the box', () => {
    expect(notLoggedIn(fixture('not-logged-in'))).toBe(true)
  })
  it('the ready box, a quote of the words in a reply, and the 401 capture are not it', () => {
    expect(notLoggedIn(fixture('ready-auto-notice'))).toBe(false)
    expect(notLoggedIn(fixture('token-refused-401'))).toBe(false)
    const quoted = [...fixture('ready-auto-notice')]
    const at = quoted.findIndex((r) => r.startsWith('▎ https://'))
    quoted.splice(at, 0, '● It said: Not logged in · Run /login')
    expect(notLoggedIn(quoted)).toBe(false)
  })
  it('the status row only as Claude Code draws it: right-aligned, with the box at the bottom (Fable)', () => {
    const r = fixture('not-logged-in')
    // the same words at the start of a row (a quote, a reply) are not the status row
    expect(
      notLoggedIn(r.map((x) => (x.trim().endsWith('Not logged in · Run /login') ? 'Not logged in · Run /login' : x))),
    ).toBe(false)
    // a box with a page of text under it is a quoted one, not the live box at the bottom
    expect(notLoggedIn([...r, 'one', 'two', 'three', 'four', 'five'])).toBe(false)
  })
})

describe('a new token restarts a signed-out Main: once per token, never while someone is attached (TokenRestart)', () => {
  function world(o: { eligible?: boolean } = {}) {
    const w = {
      id: 'a' as string | null,
      eligible: o.eligible ?? true,
      clients: [] as number[] | null,
      phase: 'running',
      stoppedFlag: false,
      calls: [] as string[],
    }
    const r = new TokenRestart({
      identity: () => w.id,
      eligible: () => w.eligible,
      clients: async () => w.clients,
      phase: () => w.phase,
      stopped: () => w.stoppedFlag,
      stop: async () => {
        w.calls.push('stop')
        w.phase = 'stopped'
      },
      start: async () => {
        w.calls.push('start')
        w.phase = 'starting'
      },
      audit: () => {},
    })
    return { w, r }
  }
  const ticks = async (r: TokenRestart, n: number) => {
    for (let i = 0; i < n; i++) await r.tick()
  }
  it('a new token while signed out: stop, then start, once; the same token again (refused again) never loops', async () => {
    const { w, r } = world()
    await ticks(r, 2)
    expect(w.calls).toEqual([]) // the token Main runs with is not new
    w.id = 'b'
    await ticks(r, 6)
    expect(w.calls).toEqual(['stop', 'start'])
  })
  it('no token, or the file gone or unreadable: nothing starts', async () => {
    const { w, r } = world()
    w.id = null
    await ticks(r, 3)
    expect(w.calls).toEqual([])
  })
  it('someone attached, or the clients cannot be read: it waits, and goes once they leave', async () => {
    const { w, r } = world()
    w.id = 'b'
    w.clients = [Date.now()]
    await ticks(r, 3)
    w.clients = null
    await r.tick()
    expect(w.calls).toEqual([])
    w.clients = []
    await ticks(r, 2)
    expect(w.calls).toEqual(['stop', 'start'])
  })
  it('a token that arrived while Main was not signed out is still tried when it signs out later (Fable)', async () => {
    const { w, r } = world({ eligible: false })
    w.id = 'b'
    await ticks(r, 3)
    expect(w.calls).toEqual([])
    w.eligible = true
    await ticks(r, 2)
    expect(w.calls).toEqual(['stop', 'start'])
  })
  it('the owner stops Main during the restart: never started by the token, and no restart left armed for later (Fable)', async () => {
    const { w, r } = world()
    w.id = 'b'
    await r.tick() // stop issued
    w.stoppedFlag = true // the owner's own stop lands meanwhile
    await ticks(r, 2)
    expect(w.calls).toEqual(['stop'])
    // much later the owner starts Main, which then stops on its own (a crash loop's give-up): nothing starts it again
    w.stoppedFlag = false
    w.phase = 'running'
    await r.tick()
    w.phase = 'stopped'
    await ticks(r, 3)
    expect(w.calls).toEqual(['stop'])
  })
})
