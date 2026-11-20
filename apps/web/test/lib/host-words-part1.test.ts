// The first-week screens in the agent's computer's own words (lib/hostWords.ts): a Mac reads every sentence exactly as it
// did, byte for byte; a Windows PC, a Linux box or a computer not known yet never reads "Mac".
import type { Host, WorkerStatusItemT } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { collapseLine } from '../../src/features/cards/logic.ts'
import { uploadFailureNote } from '../../src/features/composer/uploadError.ts'
import { bannerFor, healthNotes, healthRows, macMessage } from '../../src/features/health/rows.ts'
import { WORKER_ERROR_TEXT, workerErrorText, workerLine } from '../../src/features/thread-sessions/store.ts'
import { sessionWords } from '../../src/features/thread-sessions/words.ts'
import { TalosClientError } from '../../src/lib/client.ts'
import { hostSteps, PAIR_WAYS, placeWords } from '../../src/lib/hostWords.ts'
import { HttpError } from '../../src/lib/http.ts'
import { statusOf } from '../health/status.ts'

const OTHERS: Array<Host | null> = ['windows', 'linux', null]
const MAC_WORD = /\bMac\b/

describe('placeWords', () => {
  it('a Mac keeps the very same text', () => {
    for (const t of ['Your Mac is offline.', 'Answer it at the Mac.', 'in a terminal on a Mac', 'Mac offline'])
      expect(placeWords(t, 'mac')).toBe(t)
  })
  it('elsewhere only the place words change, and "Mac app" is never touched', () => {
    expect(placeWords('Your Mac is offline.', 'linux')).toBe('Your computer is offline.')
    expect(placeWords('The Mac is offline.', 'windows')).toBe('Your PC is offline.') // the PC is the PC, as its tray says
    expect(placeWords('Mac offline', 'windows')).toBe('PC offline')
    expect(placeWords("Search is off: this Mac's SQLite has no FTS5", null)).toBe(
      "Search is off: this computer's SQLite has no FTS5",
    )
    expect(placeWords('Waiting for the Mac…', null)).toBe('Waiting for your computer…')
    expect(placeWords('Mac offline', 'linux')).toBe('Computer offline')
    expect(placeWords('Update the Mac app', 'linux')).toBe('Update the Mac app')
    expect(placeWords("Talos's Mac is offline. Try again when it is back.", 'windows')).toBe(
      "Talos's PC is offline. Try again when it is back.",
    )
    expect(placeWords("Zoë's Mac is offline.", 'linux')).toBe("Zoë's computer is offline.")
  })
})

describe("hostSteps: commands and controls in each host's words", () => {
  it("a Mac's sentences are the app's sentences as they were, byte for byte", () => {
    const m = hostSteps('mac')
    expect(m.keyFix).toBe(
      'On the Mac, run talos-app doctor. It prints the key line your server needs: paste it into your server settings and deploy again. The setup guide has the steps.',
    )
    expect(m.superseded).toBe(
      'Talos on the older computer reconnects on its own within a minute or two. If it does not, restart your agent on your Mac. If you did not start Talos on a second computer, run talos-app rotate on the Mac.',
    )
    expect(m.asleep('7 days')).toBe(
      'Wake the Mac and check that Claude is still running in its terminal. Your messages wait on the server for up to 7 days.',
    )
    expect(m.modQuiet).toBe('Check that Claude is still running on your Mac with the Talos mod loaded.')
    expect(m.loginProof).toBe(
      "This device couldn't prove its key. Run talos-app enroll on your Mac to set it up again.",
    )
    expect(m.answerThere).toBe(
      'It stopped at a question only the Mac can answer. Open Talos Terminal on the Mac, pick this thread under Thread sessions, and answer it there. Then press Restart here to start it again',
    )
    expect(m.lookThere).toBe(
      "It stopped for a reason this version doesn't know. Open Talos Terminal on the Mac to see what happened",
    )
    expect(m.rotate).toBe(
      'If you did not start Talos on a second computer on purpose, run talos-app rotate on your Mac.',
    )
    expect(m.dialogHere).toBe("This prompt can't be shown here. Answer it at the Mac.")
    expect(m.dialogExpired).toBe('Expired. Nobody answered in time; your agent is still waiting at the Mac.')
  })
  it('no other host reads "Mac" in any of them', () => {
    for (const h of OTHERS) {
      const s = hostSteps(h)
      for (const [k, v] of Object.entries(s)) {
        // an unknown host's pairing names every platform's way (a first pairing can't know which); nothing else says Mac
        const text = (typeof v === 'function' ? v('7 days') : v).replace(PAIR_WAYS, '')
        expect(text, `${h} ${k}`).not.toMatch(MAC_WORD)
      }
    }
  })
  it('Windows names the tray, never a terminal command', () => {
    const w = hostSteps('windows')
    for (const v of Object.values(w)) expect(typeof v === 'function' ? v('1 day') : v).not.toMatch(/talos-app /)
    expect(w.keyFix).toBe(
      "On the PC, click the Talos icon by the clock, choose Check Talos..., then Copy the relay key, and set it as BRIDGE_PUBKEY in your server's settings.",
    )
  })
})

describe('health', () => {
  const offline = statusOf({
    bridge: { online: false, last_seen: '2026-10-29T19:00:00.000Z', down_since: '2026-10-29T19:00:00.000Z' },
  })
  it("a Mac's rows and notes are as they were (the default, and said outright)", () => {
    for (const host of [undefined, 'mac' as const]) {
      const rows = healthRows(offline, { scheduler: undefined, ...(host ? { host } : {}) })
      expect(rows.find((r) => r.id === 'bridge')?.label).toBe('Talos on your Mac')
    }
    const noVoice = statusOf({ beat: { tts: false, sqlite: { fts5: false } } } as never)
    expect(healthNotes(noVoice, 'mac')).toEqual([
      'Voice replies need a TTS command on your Mac',
      "Search is off: this Mac's SQLite has no FTS5",
    ])
  })
  it('elsewhere the bridge row is Talos on your computer, and no row, note or banner says Mac', () => {
    const noVoice = statusOf({ beat: { tts: false, sqlite: { fts5: false } } } as never)
    for (const host of OTHERS) {
      const rows = healthRows(offline, { scheduler: undefined, host })
      expect(rows.find((r) => r.id === 'bridge')?.label).toBe(
        host === 'windows' ? 'Talos on your PC' : 'Talos on your computer',
      )
      for (const r of rows) expect(`${r.label} ${r.detail}`).not.toMatch(MAC_WORD)
      for (const n of healthNotes(noVoice, host)) expect(n).not.toMatch(MAC_WORD)
      for (const kind of ['dropped', 'asleep', 'key_refused', 'mod_quiet', 'superseded'] as const) {
        const m = macMessage(kind, { host, nowMs: Date.parse('2026-10-29T20:00:00Z'), lastSeen: null })
        expect(`${m.cause} ${m.next}`, `${host} ${kind}`).not.toMatch(MAC_WORD)
      }
    }
    expect(healthNotes(noVoice, 'windows')[0]).toBe("Spoken replies aren't set up on a Windows PC yet.")
  })
  it("a Mac's banner wording is unchanged, and Windows gets Titan's key fix", () => {
    const refused = statusOf({
      bridge: { online: false, last_seen: null, down_since: null, auth_refused_at: '2026-10-29T19:00:00.000Z' },
    } as never)
    expect(bannerFor(refused, false)?.next).toBe(hostSteps('mac').keyFix)
    expect(bannerFor(refused, false, undefined, 'mac')?.text).toBe(
      "Your Mac is offline: the server turned away its key, so it can't connect.",
    )
    expect(bannerFor(refused, false, undefined, 'windows')).toMatchObject({
      text: "Your PC is offline: the server turned away its key, so it can't connect.",
      next: "On the PC, click the Talos icon by the clock, choose Check Talos..., then Copy the relay key, and set it as BRIDGE_PUBKEY in your server's settings.",
    })
  })
})

describe('thread sessions', () => {
  const item = (o: Partial<WorkerStatusItemT>) => ({ thread_id: 't1', state: 'failed', ...o }) as WorkerStatusItemT
  it("a Mac's reasons are the very same strings", () => {
    expect(workerErrorText('needs_mac', 'mac')).toBe(WORKER_ERROR_TEXT.needs_mac)
    expect(workerLine(item({ error: 'needs_mac' }))).toBe(WORKER_ERROR_TEXT.needs_mac)
    const w = sessionWords({ item: item({ error: 'needs_mac' }), now: 0, supervisorOnline: true })
    expect(w.short).toBe('Failed · needs the Mac')
  })
  it('Linux says attach, Windows says it cannot be opened yet, and neither says Mac', () => {
    expect(workerErrorText('needs_mac', 'linux')).toMatch(/talos-app supervise attach/)
    expect(workerErrorText('needs_mac', 'windows')).toMatch(/can't be opened yet/)
    for (const host of OTHERS)
      for (const error of ['needs_mac', 'unknown', 'crash_loop'] as const) {
        expect(workerLine(item({ error }), host)).not.toMatch(MAC_WORD)
        const live = sessionWords({ item: item({ error }), now: 0, supervisorOnline: true, host })
        const away = sessionWords({ item: item({ error }), now: 0, supervisorOnline: false, host })
        for (const w of [live, away]) expect(`${w.short} ${w.long}`).not.toMatch(MAC_WORD)
      }
    const needs = sessionWords({
      item: item({ state: 'busy', needs_you: { kind: 'login', since: '2026-10-29T19:00:00.000Z' } } as never),
      now: Date.parse('2026-10-29T20:00:00Z'),
      supervisorOnline: true,
      host: 'linux',
    })
    expect(needs.short).toBe('Needs you at your computer · login')
    const pc = sessionWords({
      item: item({ state: 'busy', needs_you: { kind: 'login', since: '2026-10-29T19:00:00.000Z' } } as never),
      now: Date.parse('2026-10-29T20:00:00Z'),
      supervisorOnline: true,
      host: 'windows',
    })
    expect(pc.short).toBe('Needs you · login') // the PC has no window to answer it in yet
    expect(pc.long).toMatch(/can't be opened yet/)
  })
})

describe('cards and uploads', () => {
  const resolvedDialog = { kind: 'dialog', state: 'resolved', created_at: '2026-10-29T19:00:00.000Z' } as never
  it("a Mac's lines are as they were", () => {
    expect(collapseLine(resolvedDialog, { agent: 'Talos', nowMs: 0 })).toBe('… Pressing the key on your Mac')
    expect(uploadFailureNote(new TalosClientError('device_not_pinned', 'device_not_pinned'), 'mac')).toMatch(
      /approved on the Mac yet/,
    )
  })
  it('elsewhere they name the computer', () => {
    for (const host of OTHERS) {
      const n = host === 'windows' ? 'PC' : 'computer'
      expect(collapseLine(resolvedDialog, { agent: 'Talos', nowMs: 0, host })).toBe(`… Pressing the key on your ${n}`)
      const pin = uploadFailureNote(new TalosClientError('device_not_pinned', 'device_not_pinned'), host)
      expect(pin).toMatch(new RegExp(`approved on your ${n} yet`))
      expect(uploadFailureNote(new HttpError(507), host)).toMatch(new RegExp(`your ${n} is out of disk space`))
    }
  })
})
