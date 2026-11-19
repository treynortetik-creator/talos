// A worker's dialog offered as a card and answered by a tap (P3d3, part 4b-ii; the Mac's WorkerDialogOffer.swift and
// WorkerDialogAnswer.swift), on a fake pane that shows the Mac's real 2.1.319 trust captures and moves its cursor on the keys,
// with real owner signatures from a test device key. Forged, stale, tampered and replayed answers press nothing.

import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  bindingFrom,
  buildDialogProof,
  type CardT,
  composeDialogCard,
  createExtractableDeviceKeyForTests,
  DIALOG_CARD_WAIT_MS,
  type PtyDialogKey,
  type PtySendResult,
  signOwnerFrame,
  WORKER_TIMING,
  type WorkerDialogT,
} from '@talos-app/protocol'
import { ensureDir } from '../../src/fsutil.ts'
import { readDialog } from '../../src/supervisor/dialog-reader.ts'
import { parseCapture } from '../../src/supervisor/tmux-commands.ts'
import { newOfferState, type OfferTarget, planKeys, WorkerDialogs } from '../../src/supervisor/worker-dialogs.ts'
import { workerDir } from '../../src/worker/files.ts'

const FIX = resolve(import.meta.dir, '../../../desktop/Tests/Fixtures')
const CAP = 'real-2.1.319/needs-you-capture'
const cap = (dir: string, name: string) => parseCapture(readFileSync(resolve(FIX, dir, `${name}.txt`), 'utf8'))
const SCREENS = {
  top: { plain: cap(CAP, '01-trust-first'), coloured: cap(CAP, '01-trust-first.ansi') },
  yes: { plain: cap(CAP, '02-trust-down'), coloured: cap(CAP, '02-trust-down.ansi') },
  idle: { plain: cap('real-2.1.318', 'empty-input'), coloured: cap('real-2.1.318', 'empty-input') },
  login: { plain: cap('real-2.1.318', 'login-not-logged-in'), coloured: cap('real-2.1.318', 'login-not-logged-in') },
  // the trust dialog with its folder row gone: a subject that cannot be read
  nopath: {
    plain: cap(CAP, '01-trust-first').filter((r) => !r.includes('tcap-ny-proj')),
    coloured: cap(CAP, '01-trust-first.ansi').filter((r) => !r.includes('tcap-ny-proj')),
  },
}
const TRUST = { kind: 'trust' as const }
const NOW = Date.parse('2026-11-10T12:00:00.000Z')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** The trust dialog that moves its cursor on Up and Down (it wraps, as the real Select does) and is gone after Enter. */
class FakePane {
  at: keyof typeof SCREENS = 'top'
  keys: PtyDialogKey[] = []
  clients: number[] | null = []
  async visibleRows() {
    return SCREENS[this.at].plain
  }
  async visibleRowsEscaped() {
    return SCREENS[this.at].coloured
  }
  async clientActivities() {
    return this.clients
  }
  async sendDialogKey(k: PtyDialogKey, _kind?: string): Promise<PtySendResult> {
    this.keys.push(k)
    if (k === 'Enter') this.at = 'idle'
    else if (this.at === 'top' || this.at === 'yes') this.at = this.at === 'top' ? 'yes' : 'top'
    return 'sent'
  }
}

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'talos-dialogs-'))
  dirs.push(home)
  ensureDir(workerDir(home, 'trip'))
  const device = await createExtractableDeviceKeyForTests()
  let t = 100
  let wall = NOW
  const audit: string[] = []
  const d = new WorkerDialogs({
    home,
    now: () => t,
    wallMs: () => wall,
    audit: (e) => audit.push(e),
    pinnedKey: (id) => (id === device.deviceId ? device.publicJwk : undefined),
    sleep: async () => {},
  })
  let dialog: WorkerDialogT | undefined
  const target: OfferTarget = {
    id: 'trip',
    offer: newOfferState(),
    dialog: () => dialog,
    setDialog: (x) => {
      dialog = x
    },
  }
  const pane = new FakePane()
  const dir = workerDir(home, 'trip')
  return {
    home,
    dir,
    d,
    target,
    pane,
    device,
    audit,
    offer: () => dialog as WorkerDialogT,
    advance: (s: number) => {
      t += s
      wall += s * 1000
    },
    /** The look the manager makes each tick, on a screen that has held still. */
    sync: () => d.sync(target, pane, SCREENS[pane.at].plain, TRUST, true),
    result: () =>
      existsSync(join(dir, 'dialog-result.json'))
        ? (JSON.parse(readFileSync(join(dir, 'dialog-result.json'), 'utf8')) as Record<string, unknown>)
        : null,
  }
}

type X = Awaited<ReturnType<typeof setup>>

/** The answer file the bridge writes for a tap: the owner's signed `card.resolve` frame and the card's binding. */
async function answerFor(
  x: X,
  o: {
    choice?: number
    dialog?: WorkerDialogT
    key?: CryptoKey
    deviceId?: string
    ts?: string
    at?: string
    control?: string
    card?: (c: CardT) => void
  } = {},
) {
  const dialog = o.dialog ?? x.offer()
  const card = composeDialogCard({
    card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T403',
    dialog,
    thread_id: 'trip',
    thread_name: 'Trip',
    now: NOW,
  }) as CardT
  o.card?.(card)
  const choice = o.choice ?? 1
  const raw = await signOwnerFrame(
    {
      v: 1,
      id: '01JBF3V7Q8K2M4N6P8R0S2T4AA',
      ts: o.ts ?? new Date(NOW).toISOString(),
      type: 'card.resolve',
      card_id: card.id,
      action: 'primary',
      payload_hash: card.payload_hash,
      choice,
      device_id: o.deviceId ?? x.device.deviceId,
    },
    o.key ?? x.device.privateKey,
  )
  const answer = {
    v: 2,
    dialog_id: dialog.id,
    choice,
    label: dialog.options[choice] ?? 'x',
    by: 'Test phone',
    at: o.at ?? new Date(NOW).toISOString(),
    control_id: o.control ?? 'dc_01M6V2TGWJCH4P49F79Q2317CD',
    proof: buildDialogProof(raw, bindingFrom(card)),
  }
  writeFileSync(join(x.dir, 'dialog-answer.json'), JSON.stringify(answer))
  return answer
}

describe('the offer', () => {
  it('a trust dialog read exactly is offered: a fresh 128-bit id, its folder, options and cursor, and card_lifetime_s', async () => {
    const x = await setup()
    await x.sync()
    const o = x.offer()
    expect(o).toMatchObject({
      kind: 'trust',
      subject: '/private/tmp/tcap-ny-proj.7TmVie',
      options: ['No, exit', 'Yes, I trust this folder'],
      cursor: 0,
    })
    expect(o.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(Date.parse(o.expires_at) - Date.parse(o.seen_at)).toBe(WORKER_TIMING.card_lifetime_s * 1000)
    // the cursor moves: the same offer, its cursor updated
    x.pane.at = 'yes'
    await x.sync()
    expect(x.offer().id).toBe(o.id)
    expect(x.offer().cursor).toBe(1)
  })
  it('a dialog whose subject cannot be read is never offered: a card could be answered onto a lookalike', async () => {
    const d = readDialog(SCREENS.nopath.plain, SCREENS.nopath.coloured)
    expect(d?.kind).toBe('trust')
    expect(d?.subject).toBeNull()
    const x = await setup()
    x.pane.at = 'nopath'
    await x.sync()
    expect(x.target.dialog()).toBeUndefined()
  })
  it('login is never offered (a line only)', async () => {
    const x = await setup()
    x.pane.at = 'login'
    await x.d.sync(x.target, x.pane, SCREENS.login.plain, { kind: 'login_expired' }, true)
    expect(x.target.dialog()).toBeUndefined()
  })
  it('a settled screen with no dialog ends it; two looks that cannot read it end it', async () => {
    const x = await setup()
    await x.sync()
    await x.d.sync(x.target, x.pane, SCREENS.idle.plain, { kind: 'none' }, true)
    expect(x.target.dialog()).toBeUndefined()
    await x.sync()
    await x.d.sync(x.target, x.pane, ['not', 'a dialog'], TRUST, true)
    expect(x.target.dialog()).toBeDefined()
    await x.d.sync(x.target, x.pane, ['not', 'a dialog'], TRUST, true)
    expect(x.target.dialog()).toBeUndefined()
  })
  it('the thread’s line waits DIALOG_CARD_WAIT_MS for the card, and for as long as the card file names this dialog', async () => {
    const x = await setup()
    await x.sync()
    expect(x.d.lineWaits(x.target)).toBe(true)
    x.advance(DIALOG_CARD_WAIT_MS / 1000)
    expect(x.d.lineWaits(x.target)).toBe(false)
    writeFileSync(
      join(x.dir, 'dialog-card.json'),
      JSON.stringify({
        v: 1,
        dialog_id: x.offer().id,
        card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T403',
        status: 'waiting',
        at: new Date(NOW).toISOString(),
      }),
    )
    expect(x.d.lineWaits(x.target)).toBe(true)
  })
})

describe('the answer', () => {
  it('a signed Yes: one Down, confirmed by a fresh read, then one Enter; the result (0600) says pressed, the files are gone', async () => {
    const x = await setup()
    await x.sync()
    await answerFor(x)
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual(['Down', 'Enter'])
    expect(x.result()).toMatchObject({
      v: 1,
      source: 'card',
      outcome: 'pressed',
      choice: 1,
      label: 'Yes, I trust this folder',
      control_id: 'dc_01M6V2TGWJCH4P49F79Q2317CD',
    })
    expect(statSync(join(x.dir, 'dialog-result.json')).mode & 0o777).toBe(0o600)
    expect(existsSync(join(x.dir, 'dialog-answer.json'))).toBe(false)
    expect(existsSync(join(x.dir, 'dialog-answer.json.taken'))).toBe(false)
    expect(JSON.parse(readFileSync(join(x.dir, 'dialog-proofs-used.json'), 'utf8')).used).toHaveLength(1)
  })
  it('a signed "No, exit" on the folder-trust question is pressed and remembered as the owner’s answer; a Yes is not a decline', async () => {
    const no = await setup()
    await no.sync()
    await answerFor(no, { choice: 0 })
    await no.d.answer(no.target, no.pane)
    expect(no.pane.keys).toEqual(['Enter'])
    expect(no.result()).toMatchObject({ outcome: 'pressed', choice: 0, label: 'No, exit' })
    expect(no.target.offer.declinedTrust).toBe(true)
    const yes = await setup()
    await yes.sync()
    await answerFor(yes)
    await yes.d.answer(yes.target, yes.pane)
    expect(yes.target.offer.declinedTrust).toBe(false)
  })
  it('an Enter on "No, exit" that timed out (it may or may not have landed) is pressed, never remembered as a decline', async () => {
    const x = await setup()
    await x.sync()
    await answerFor(x, { choice: 0 })
    const send = x.pane.sendDialogKey.bind(x.pane)
    x.pane.sendDialogKey = async (k: PtyDialogKey, kind?: string) =>
      (await send(k, kind)) && k === 'Enter' ? 'unknown' : 'sent'
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ outcome: 'pressed', choice: 0 }) // counted, never repeated
    expect(x.target.offer.enterSentFor).not.toBeNull()
    expect(x.target.offer.declinedTrust).toBe(false)
  })
  it('a key the guard refused is no press: nothing pressed, never reported as pressed (Fable R3-5)', async () => {
    const x = await setup()
    await x.sync()
    await answerFor(x)
    // the moves go; the Enter onto the choice is refused (a menu Talos does not know came up)
    const send = x.pane.sendDialogKey.bind(x.pane)
    x.pane.sendDialogKey = async (k: PtyDialogKey, kind?: string) => (k === 'Enter' ? 'refused' : send(k, kind))
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual(['Down'])
    expect(x.result()?.outcome).not.toBe('pressed')
  })
  it('a dialog key states its kind (the guard checks the screen is that one)', async () => {
    const x = await setup()
    await x.sync()
    await answerFor(x)
    const kinds: Array<string | undefined> = []
    const send = x.pane.sendDialogKey.bind(x.pane)
    x.pane.sendDialogKey = async (k: PtyDialogKey, kind?: string) => {
      kinds.push(kind)
      return send(k)
    }
    await x.d.answer(x.target, x.pane)
    expect(kinds.length).toBeGreaterThan(0)
    expect(new Set(kinds)).toEqual(new Set(['trust']))
  })
  it('the choice already under the cursor: just Enter', async () => {
    const x = await setup()
    await x.sync()
    await answerFor(x, { choice: 0 })
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual(['Enter'])
  })
  it('a forged answer (a key that is not a paired device) presses nothing: unverified', async () => {
    const x = await setup()
    await x.sync()
    const other = await createExtractableDeviceKeyForTests()
    await answerFor(x, { key: other.privateKey, deviceId: other.deviceId })
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual([])
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed', reason: 'unverified' })
  })
  it('a signature by the paired device over another device’s claim, or a card that is not the dialog on the pane, presses nothing', async () => {
    const x = await setup()
    await x.sync()
    const other = await createExtractableDeviceKeyForTests()
    await answerFor(x, { deviceId: other.deviceId })
    await x.d.answer(x.target, x.pane)
    await answerFor(x, {
      control: 'dc_2',
      dialog: { ...x.offer(), options: ['No, exit', 'Yes, I trust this folder', 'Something else'] },
    })
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual([])
    expect(x.result()).toMatchObject({ control_id: 'dc_2', outcome: 'nothing_pressed', reason: 'unverified' })
  })
  it('a stale answer (by its own time) or a stale tap (by the signed time) presses nothing', async () => {
    const x = await setup()
    await x.sync()
    await answerFor(x, { at: new Date(NOW - 6 * 60_000).toISOString() })
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed', reason: 'unverified' })
    await answerFor(x, { control: 'dc_2', ts: new Date(NOW - 16 * 60_000).toISOString() })
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ control_id: 'dc_2', outcome: 'nothing_pressed', reason: 'unverified' })
    expect(x.pane.keys).toEqual([])
  })
  it('a card past its lifetime presses nothing', async () => {
    const x = await setup()
    await x.sync()
    const a = await answerFor(x)
    x.advance(WORKER_TIMING.card_lifetime_s + 1)
    writeFileSync(
      join(x.dir, 'dialog-answer.json'),
      JSON.stringify({ ...a, at: new Date(NOW + 901_000).toISOString() }),
    )
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual([])
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed', reason: 'screen_changed' })
  })
  it('a replayed tap presses nothing: the same control id is not answered again, a copy under another one is already_answered', async () => {
    const x = await setup()
    await x.sync()
    x.pane.clients = null // the first try is blocked by the guard: nothing pressed, but the tap is used
    const a = await answerFor(x)
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed', reason: 'screen_changed' })
    x.pane.clients = []
    const before = readFileSync(join(x.dir, 'dialog-result.json'), 'utf8')
    writeFileSync(join(x.dir, 'dialog-answer.json'), JSON.stringify(a))
    await x.d.answer(x.target, x.pane)
    expect(readFileSync(join(x.dir, 'dialog-result.json'), 'utf8')).toBe(before)
    writeFileSync(join(x.dir, 'dialog-answer.json'), JSON.stringify({ ...a, control_id: 'dc_copy' }))
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ control_id: 'dc_copy', outcome: 'nothing_pressed', reason: 'already_answered' })
    // a supervisor started since remembers the used tap from its file
    const y = new WorkerDialogs({
      home: x.home,
      now: () => 0,
      wallMs: () => NOW,
      audit: () => {},
      pinnedKey: (id) => (id === x.device.deviceId ? x.device.publicJwk : undefined),
      sleep: async () => {},
    })
    const t2: OfferTarget = { ...x.target, offer: { ...newOfferState(), sinceAwake: 0 } }
    writeFileSync(join(x.dir, 'dialog-answer.json'), JSON.stringify({ ...a, control_id: 'dc_after' }))
    await y.answer(t2, x.pane)
    expect(x.result()).toMatchObject({ control_id: 'dc_after', reason: 'already_answered' })
    expect(x.pane.keys).toEqual([])
  })
  it('an attached client that typed within dialog_client_quiet_s blocks every key', async () => {
    const x = await setup()
    await x.sync()
    x.pane.clients = [NOW - 5_000]
    await answerFor(x)
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual([])
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed', reason: 'screen_changed' })
  })
  it('an arrow that does not show stops the answer before any Enter', async () => {
    const x = await setup()
    await x.sync()
    x.pane.sendDialogKey = async (k) => {
      x.pane.keys.push(k)
      return 'sent' // the screen never moves
    }
    await answerFor(x)
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual(['Down'])
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed' })
  })
  it('an answer read back from workers.json before this supervisor saw the dialog presses nothing', async () => {
    const x = await setup()
    await x.sync()
    x.target.offer.sinceAwake = null
    await answerFor(x)
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual([])
    expect(existsSync(join(x.dir, 'dialog-answer.json'))).toBe(true)
  })
  it('a record read back after a restart is a new sighting: the old id, and a tap signed for it, apply to nothing', async () => {
    const x = await setup()
    await x.sync()
    const old = x.offer()
    const stale = await answerFor(x) // signed for the dialog the card showed before the restart
    // the supervisor restarts: the entry's dialog is still in workers.json, the offer state is new, the screen reads the same
    // (it may be the same dialog, or one that replaced it while nobody was looking)
    x.target.offer = newOfferState()
    await x.sync()
    const fresh = x.offer()
    expect(fresh.id).not.toBe(old.id)
    expect(fresh).toMatchObject({ kind: old.kind, subject: old.subject, options: old.options })
    expect(x.target.offer.sinceAwake).not.toBeNull()
    writeFileSync(join(x.dir, 'dialog-answer.json'), JSON.stringify(stale))
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual([])
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed', reason: 'unverified' })
    // a tap for what is offered now does press
    await answerFor(x, { dialog: fresh, control: 'dc_01M6V2TGWJCH4P49F79Q2317CE' })
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ control_id: 'dc_01M6V2TGWJCH4P49F79Q2317CE', outcome: 'pressed' })
  })
  it('a late answer for a dialog already pressed and gone: already_answered', async () => {
    const x = await setup()
    await x.sync()
    const a = await answerFor(x)
    await x.d.answer(x.target, x.pane)
    await x.d.sync(x.target, x.pane, SCREENS.idle.plain, { kind: 'none' }, true)
    expect(x.target.dialog()).toBeUndefined()
    writeFileSync(join(x.dir, 'dialog-answer.json'), JSON.stringify({ ...a, control_id: 'dc_late' }))
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ control_id: 'dc_late', outcome: 'nothing_pressed', reason: 'already_answered' })
    expect(x.pane.keys).toEqual(['Down', 'Enter'])
  })
})

describe('planKeys', () => {
  const offered: WorkerDialogT = {
    id: 'k3Xv9QpT2mLw8ZrNa5HdBe',
    kind: 'mcp_consent',
    subject: null,
    options: ['a', 'b', 'c'],
    cursor: 2,
    seen_at: '2026-11-10T12:00:00.000Z',
    expires_at: '2026-11-10T12:15:00.000Z',
  }
  it('from the current cursor; nothing for another dialog or a choice out of range', () => {
    const fresh = { kind: 'mcp_consent' as const, subject: null, options: ['a', 'b', 'c'], cursor: 2 }
    expect(planKeys(offered, fresh, 0)).toEqual(['Up', 'Up', 'Enter'])
    expect(planKeys(offered, { ...fresh, cursor: 0 }, 1)).toEqual(['Down', 'Enter'])
    expect(planKeys(offered, { ...fresh, options: ['a', 'b'] }, 0)).toBeNull()
    expect(planKeys(offered, fresh, 3)).toBeNull()
    expect(planKeys(offered, null, 0)).toBeNull()
  })
})
