// Main's first start with nobody at the pane (supervisor/first-start.ts), on the real Claude Code 2.1.322 captures
// (apps/desktop/Tests/Fixtures/real-first-start-2.1.322, README). Nothing is built by hand unless the test says SYNTHETIC.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  decideFirstStart,
  type FirstStartContext,
  type FirstStartScreen,
  firstStartScreen,
  firstStartStep,
  keyToward,
  newFirstStart,
} from '../../src/supervisor/first-start.ts'
import { claudeIsReady } from '../../src/supervisor/screen.ts'
import { parseCapture } from '../../src/supervisor/tmux-commands.ts'

const FIX = resolve(import.meta.dir, '../../../desktop/Tests/Fixtures')
const rows = (name: string, dir = 'real-first-start-2.1.322') =>
  parseCapture(readFileSync(resolve(FIX, dir, `${name}.txt`), 'utf8'))

const ctx = (over: Partial<FirstStartContext> = {}): FirstStartContext => ({
  agentDir: '/home/talos/talos-agent',
  talosFolder: true,
  approved: true,
  launchChannels: ['server:talos-app'],
  clients: [],
  sinceSpawnMs: 5_000,
  startKind: 'cold',
  answered: new Set(),
  moves: new Map(),
  ...over,
})

type Listed = Extract<FirstStartScreen, { rows: string[] }>

/** The screen after `key`, for a list whose cursor moves one row (SYNTHETIC: the cursor moved by hand, nothing else changed). */
function moved(s: Listed, key: 'Up' | 'Down'): Listed {
  const h = s.rows.findIndex((r) => r.startsWith('❯'))
  const to = key === 'Down' ? h + 1 : h - 1
  const out = [...s.rows]
  out[h] = `  ${(out[h] as string).slice(1).trim()}`
  out[to] = `❯ ${(out[to] as string).trim()}`
  return { ...s, rows: out } as Listed
}

describe('reading the real first-start screens', () => {
  it('each capture is read as what it is', () => {
    expect(firstStartScreen(rows('theme')).kind).toBe('theme')
    expect(firstStartScreen(rows('security-notes')).kind).toBe('security_notes')
    expect(firstStartScreen(rows('login-method')).kind).toBe('signin')
    expect(firstStartScreen(rows('api-key')).kind).toBe('api_key')
    expect(firstStartScreen(rows('trust'))).toMatchObject({ kind: 'trust', folder: '/home/talos/talos-agent' })
    expect(firstStartScreen(rows('mcp-consent'))).toMatchObject({ kind: 'mcp_consent', servers: ['talos-app'] })
  })
  it('the ready box under the auto-mode notice is no dialog: nothing to answer, and Claude is ready', () => {
    const r = rows('ready-auto-notice')
    expect(firstStartScreen(r).kind).toBe('none')
    expect(claudeIsReady(r)).toBe(true)
  })
  it('the real development-channels warning', () => {
    const s = firstStartScreen(rows('dev-channels-capture', 'real-dev-channels'))
    expect(s).toMatchObject({ kind: 'dev_channels', dev: { channels: ['server:talos-app'] } })
  })
  it('SYNTHETIC: the OAuth screen after the login method (its URL and code are never read, only the prompt)', () => {
    const r = [
      " Browser didn't open? Use the url below to sign in (c to copy)",
      'https://claude.com/cai/oauth/authorize?code=true&state=XXXX',
      " Hold Shift while selecting to use your terminal's native copy",
      ' Paste code here if prompted >',
    ]
    expect(firstStartScreen(r).kind).toBe('signin')
  })
  it('SYNTHETIC: the theme’s cursor on a row other than its seven options is not the picker (Fable)', () => {
    const r = rows('theme').map((x) => x.replace('❯ ✔ Dark mode', '  ✔ Dark mode'))
    const at = r.findIndex((x) => x.includes('Syntax theme'))
    r[at] = `❯ ${(r[at] as string).trim()}`
    expect(firstStartScreen(r).kind).toBe('unknown')
  })
  it('SYNTHETIC: the login method drawn without its cursor is still sign-in, never "starting" (Fable)', () => {
    expect(firstStartScreen(rows('login-method').map((x) => x.replace('❯ 1.', '  1.'))).kind).toBe('signin')
  })
  it('a theme screen that is quoted above a live input box is not the picker', () => {
    const box = rows('ready-auto-notice')
    expect(firstStartScreen([...rows('theme').slice(16, 28), ...box]).kind).toBe('none')
  })
})

describe('what is answered, and how', () => {
  it('the theme: Enter on the default, once', () => {
    const s = firstStartScreen(rows('theme'))
    expect(decideFirstStart(s, ctx())).toEqual({ key: 'Enter', kind: 'theme' })
    expect(decideFirstStart(s, ctx({ answered: new Set(['theme']) }))).toMatchObject({ wait: 'theme' })
  })
  it('the security notes (shown with a token set): Enter, once; not while anyone is attached', () => {
    const s = firstStartScreen(rows('security-notes'))
    expect(decideFirstStart(s, ctx())).toEqual({ key: 'Enter', kind: 'security_notes' })
    expect(decideFirstStart(s, ctx({ answered: new Set(['security_notes']) }))).toMatchObject({
      wait: 'security_notes',
    })
    expect(decideFirstStart(s, ctx({ clients: [1] }))).toMatchObject({ wait: 'security_notes' })
  })
  it('SYNTHETIC: notes that ask something, offer a choice, or speak of terms or permissions wait for the owner', () => {
    const notes = rows('security-notes')
    const at = notes.findIndex((r) => r.includes('Press Enter to continue'))
    const add = (line: string) => [...notes.slice(0, at), line, ...notes.slice(at)]
    for (const line of [
      ' 3. Do you agree to share usage data?',
      ' 3. By continuing you accept the Terms of Service',
      ' 3. Claude will ask for permission before edits',
      ' ❯ 1. Yes',
    ])
      expect(firstStartScreen(add(line)).kind, line).toBe('unknown')
    expect(firstStartScreen(notes)).toMatchObject({
      kind: 'security_notes',
      text: expect.arrayContaining(['Security notes:']),
    })
  })
  it('SYNTHETIC: the notes title quoted above other text is not the notes screen', () => {
    expect(firstStartScreen([' Security notes:', ' 1. Claude can make mistakes.', ' something else']).kind).toBe('none')
  })
  it('trust: Down to "Yes, I trust this folder", then Enter there; never Enter on "No, exit"', () => {
    const s = firstStartScreen(rows('trust')) as Listed
    expect(decideFirstStart(s, ctx())).toEqual({ key: 'Down', kind: 'trust' })
    expect(decideFirstStart(moved(s, 'Down'), ctx({ moves: new Map([['trust', 1]]) }))).toEqual({
      key: 'Enter',
      kind: 'trust',
    })
  })
  it('trust: not without the root approval, the .talos-version mark, or for another folder', () => {
    const s = firstStartScreen(rows('trust'))
    expect(decideFirstStart(s, ctx({ approved: false }))).toMatchObject({ wait: 'trust' })
    expect(decideFirstStart(s, ctx({ talosFolder: false }))).toMatchObject({ wait: 'trust' })
    expect(decideFirstStart(s, ctx({ agentDir: '/home/talos/other' }))).toMatchObject({ wait: 'trust' })
  })
  it('MCP consent: Up twice to "Use this MCP server", then Enter; only for exactly talos-app', () => {
    const s = firstStartScreen(rows('mcp-consent')) as Listed
    expect(decideFirstStart(s, ctx())).toEqual({ key: 'Up', kind: 'mcp_consent' })
    const once = moved(s, 'Up')
    expect(decideFirstStart(once, ctx())).toEqual({ key: 'Up', kind: 'mcp_consent' })
    expect(decideFirstStart(moved(once, 'Up'), ctx())).toEqual({ key: 'Enter', kind: 'mcp_consent' })
    expect(decideFirstStart({ ...s, servers: ['talos-app2'] } as FirstStartScreen, ctx())).toMatchObject({
      wait: 'mcp_consent',
    })
    expect(decideFirstStart({ ...s, servers: null } as FirstStartScreen, ctx())).toMatchObject({ wait: 'mcp_consent' })
    expect(decideFirstStart(s, ctx({ approved: false }))).toMatchObject({ wait: 'mcp_consent' })
  })
  it('the arrows are bounded: a cursor that never arrives is reported, not chased', () => {
    const s = firstStartScreen(rows('mcp-consent'))
    expect(decideFirstStart(s, ctx({ moves: new Map([['mcp_consent', 4]]) }))).toMatchObject({ wait: 'mcp_consent' })
  })
  it('the development-channels warning: Enter only under the guard, with the approval', () => {
    const s = firstStartScreen(rows('dev-channels-capture', 'real-dev-channels'))
    expect(decideFirstStart(s, ctx())).toEqual({ key: 'Enter', kind: 'dev_channels' })
    expect(decideFirstStart(s, ctx({ approved: false }))).toMatchObject({ wait: 'dev_channels' })
    expect(decideFirstStart(s, ctx({ launchChannels: ['server:talos-app', 'server:x'] }))).toMatchObject({
      wait: 'dev_channels',
    })
    expect(decideFirstStart(s, ctx({ sinceSpawnMs: 61_000 }))).toMatchObject({ wait: 'dev_channels' })
    expect(decideFirstStart(s, ctx({ answered: new Set(['dev_channels']) }))).toMatchObject({ wait: 'dev_channels' })
  })
  it('nothing is answered while anyone is attached, or when the clients cannot be read', () => {
    for (const name of ['theme', 'trust', 'mcp-consent']) {
      const s = firstStartScreen(rows(name))
      expect(decideFirstStart(s, ctx({ clients: [Date.now()] })), name).toHaveProperty('wait')
      expect(decideFirstStart(s, ctx({ clients: null })), name).toHaveProperty('wait')
    }
  })
  it('sign-in and the API-key question are never answered', () => {
    expect(decideFirstStart(firstStartScreen(rows('login-method')), ctx())).toEqual({ signin: true })
    expect(decideFirstStart(firstStartScreen(rows('api-key')), ctx())).toMatchObject({ wait: 'api_key' })
  })
  it('keyToward: no cursor, two cursors, or no such row is no key', () => {
    expect(keyToward(['  a', '  b'], 'b')).toBeNull()
    expect(keyToward(['❯ a', '❯ b'], 'b')).toBeNull()
    expect(keyToward(['❯ a', '  b'], 'c')).toBeNull()
    expect(keyToward(['❯ a', '  b', '  b'], 'b')).toBeNull()
  })
})

describe('a refused key (Fable R4-5, R5-3)', () => {
  it('the count is per screen: a changed screen starts it again; three on one screen, then the start waits, said once', async () => {
    const audit: string[] = []
    let sends = 0
    const d = {
      host: {
        clientActivities: async () => [] as number[],
        sendDialogKey: async () => {
          sends++
          return 'refused' as const
        },
      },
      audit: (e: string) => {
        audit.push(e)
      },
    }
    const f = newFirstStart(
      { approved: () => true, talosFolder: () => true },
      { autoConfirmRestart: true } as never,
      [],
    )
    const l = { agentDir: '/home/talos/talos-agent', kind: 'cold' }
    const a = rows('theme')
    const b = [...a, '']
    expect(firstStartScreen(b).kind).toBe('theme')
    const step = (r: string[]) => firstStartStep(d, l, f, r, 5)
    await step(a) // read once: not stable yet
    await step(a)
    await step(a)
    expect(sends).toBe(2)
    await step(b) // a changed screen: read once
    await step(b)
    await step(b)
    expect(sends).toBe(4) // the count started again: two on b, no wait yet
    expect(audit.filter((e) => e === 'first_start_waiting')).toHaveLength(0)
    await step(b)
    expect(sends).toBe(5)
    expect(audit.filter((e) => e === 'first_start_waiting')).toHaveLength(1)
    expect(f.extras).toEqual({ waiting: 'theme' })
    await step(b)
    await step(b)
    expect(sends).toBe(5)
    expect(audit.filter((e) => e === 'first_start_waiting')).toHaveLength(1)
  })
})
