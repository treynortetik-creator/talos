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
import { keyRefusal } from '../../src/supervisor/key-guard.ts'
import { liveScreen, type Screen } from '../../src/supervisor/screen.ts'
import { parseCapture } from '../../src/supervisor/tmux-commands.ts'
import {
  type DialogPane,
  declinedTrustText,
  newOfferState,
  type OfferTarget,
  planKeys,
  WorkerDialogs,
} from '../../src/supervisor/worker-dialogs.ts'
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
  seen(): Screen {
    return TRUST
  }
}

type TestPane = DialogPane & { keys: PtyDialogKey[]; clients: number[] | null; seen(): Screen }

async function setup<P extends TestPane = FakePane>(
  pane: P = new FakePane() as unknown as P,
  mcpNames?: () => readonly string[],
) {
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
    ...(mcpNames ? { mcpNames } : {}),
  }
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
    sync: async () => d.sync(target, pane, (await pane.visibleRows()) as string[], pane.seen(), true),
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
    frameId?: string
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
      id: o.frameId ?? '01JBF3V7Q8K2M4N6P8R0S2T4AA',
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
  // L14. Old code: the same dialog on a fresh read kept its offer for ever, whatever its time, so no new card could be made.
  it('the same dialog still on the screen when its offer ran out is offered again under a new id, with a new time', async () => {
    const x = await setup()
    await x.sync()
    const first = x.offer()
    x.advance(WORKER_TIMING.card_lifetime_s - 1)
    await x.sync()
    expect(x.offer().id).toBe(first.id) // time left: the same offer
    x.advance(2)
    await x.sync()
    const again = x.offer()
    expect(again.id).not.toBe(first.id)
    expect(again).toMatchObject({ kind: first.kind, subject: first.subject, options: first.options })
    expect(Date.parse(again.expires_at)).toBeGreaterThan(NOW + WORKER_TIMING.card_lifetime_s * 1000)
  })
  it('a tap signed for the old offer presses nothing once the new one stands, and the new one still answers', async () => {
    const x = await setup()
    await x.sync()
    const first = x.offer()
    x.advance(WORKER_TIMING.card_lifetime_s + 1)
    await x.sync()
    const again = x.offer()
    expect(again.id).not.toBe(first.id)
    const later = new Date(NOW + (WORKER_TIMING.card_lifetime_s + 1) * 1000).toISOString()
    await answerFor(x, { dialog: first, ts: later, at: later })
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual([])
    // refused for its NUMBER: the answer is fresh and the new offer has time left, so it is the id check that says no
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed', reason: 'unverified' })
    expect(x.offer().id).toBe(again.id)
    // the new card answers
    await answerFor(x, { dialog: again, ts: later, at: later, control: 'dc_new' })
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ control_id: 'dc_new', outcome: 'pressed', choice: 1 })
    expect(x.pane.keys).toEqual(['Down', 'Enter'])
  })
  it('a dialog that is gone when its time runs out is not offered again', async () => {
    const x = await setup()
    await x.sync()
    x.advance(WORKER_TIMING.card_lifetime_s + 1)
    await x.d.sync(x.target, x.pane, SCREENS.idle.plain, { kind: 'none' }, true)
    expect(x.target.dialog()).toBeUndefined()
    await x.d.sync(x.target, x.pane, SCREENS.idle.plain, { kind: 'none' }, true)
    expect(x.target.dialog()).toBeUndefined()
  })
  // L14: a verified tap of the owner's that pressed nothing ends the offer (the card has failed), so the next look at the same dialog on a settled
  // screen makes a new id and a new card. Old code left the same id standing for the rest of its time.
  it('a verified tap that pressed nothing ends the offer: the next look makes a new id', async () => {
    const x = await setup()
    await x.sync()
    const first = x.offer()
    x.pane.clients = null // the clients cannot be read: nothing is pressed
    await answerFor(x)
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed' })
    expect(x.pane.keys).toEqual([])
    x.pane.clients = []
    await x.sync()
    expect(x.offer().id).not.toBe(first.id)
    expect(x.offer()).toMatchObject({ kind: first.kind, subject: first.subject, options: first.options })
  })
  it('a tap that does not prove itself never ends the offer', async () => {
    const x = await setup()
    await x.sync()
    const first = x.offer()
    const other = await createExtractableDeviceKeyForTests()
    await answerFor(x, { key: other.privateKey }) // signed by a key that is not the paired device's
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed', reason: 'unverified' })
    await x.sync()
    expect(x.offer().id).toBe(first.id)
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
    expect(x.result()).toMatchObject({ outcome: 'pressed', choice: 0 }) // never repeated for this card
    expect(x.target.offer.enterSentFor).toBeNull() // not answered for good: delivery is unknown
    expect(x.target.offer.declinedTrust).toBe(false)
    // so the exit that follows is a crash, not the owner's stop: nothing to say, and the session is restarted as for any crash
    expect(declinedTrustText(x.target.offer)).toBeNull()
  })
  /** A pane whose Enter is swallowed (the screen never changes) and answered with `reply`. */
  const swallowEnter = (x: X, reply: PtySendResult) => {
    x.pane.sendDialogKey = async (k: PtyDialogKey) => {
      x.pane.keys.push(k)
      return k === 'Enter' ? reply : 'sent'
    }
  }
  const CTL2 = 'dc_01M6V2TGWJCH4P49F79Q2317CE'
  const CTL3 = 'dc_01M6V2TGWJCH4P49F79Q2317CF'
  const FRAME2 = '01JBF3V7Q8K2M4N6P8R0S2T4AB'
  const FRAME3 = '01JBF3V7Q8K2M4N6P8R0S2T4AC'
  it('an Enter that timed out on an unchanged screen is offered again after the 5 s memory, as a new card; the old card then presses nothing', async () => {
    const x = await setup()
    await x.sync()
    const first = x.offer()
    swallowEnter(x, 'unknown')
    await answerFor(x, { choice: 0 })
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual(['Enter'])
    await x.sync()
    expect(x.offer().id).toBe(first.id) // inside the memory: not offered again
    x.advance(4.9)
    await x.sync()
    expect(x.offer().id).toBe(first.id)
    x.advance(0.2)
    await x.sync()
    const again = x.offer()
    expect(again.id).not.toBe(first.id) // past it: a new sighting
    expect(again).toMatchObject({ kind: first.kind, subject: first.subject, options: first.options })
    expect(x.target.offer.disturbed).toBe(false)
    // a tap for the old card: refused, no key
    await answerFor(x, { dialog: first, choice: 0, control: CTL2 })
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed', control_id: CTL2 })
    expect(x.pane.keys).toEqual(['Enter'])
    // a tap for the new card is taken
    await answerFor(x, { choice: 0, control: CTL3 })
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual(['Enter', 'Enter'])
  })
  it('during the memory the old card cannot press either (the screen is treated as changed under it)', async () => {
    const x = await setup()
    await x.sync()
    const first = x.offer()
    swallowEnter(x, 'unknown')
    await answerFor(x, { choice: 0 })
    await x.d.answer(x.target, x.pane)
    // a FRESH signed answer (its own frame id and time), so the replay guard is not what refuses it
    await answerFor(x, {
      dialog: first,
      choice: 0,
      control: CTL2,
      frameId: FRAME2,
      ts: new Date(NOW + 1000).toISOString(),
    })
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed', reason: 'screen_changed', control_id: CTL2 })
    expect(x.pane.keys).toEqual(['Enter'])
  })
  it('a late tap for an Enter of unknown delivery that landed (the dialog is gone) is answered already_answered, nothing pressed, file taken', async () => {
    const x = await setup()
    await x.sync()
    const first = x.offer()
    swallowEnter(x, 'unknown')
    await answerFor(x, { choice: 0 })
    await x.d.answer(x.target, x.pane)
    x.pane.at = 'idle' // it landed: the dialog goes
    await x.d.sync(x.target, x.pane, (await x.pane.visibleRows()) as string[], { kind: 'none' } as Screen, true)
    expect(x.target.dialog()).toBeUndefined()
    await answerFor(x, {
      dialog: first,
      choice: 0,
      control: CTL2,
      frameId: FRAME2,
      ts: new Date(NOW + 1000).toISOString(),
    })
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed', reason: 'already_answered', control_id: CTL2 })
    expect(existsSync(join(x.dir, 'dialog-answer.json'))).toBe(false)
    expect(x.pane.keys).toEqual(['Enter'])
    // another dialog id is left where it is, as for a pressed one
    const other = { ...first, id: 'other-dialog-id-0123456789' }
    await answerFor(x, { dialog: other, choice: 0, control: CTL3, frameId: FRAME3 })
    await x.d.answer(x.target, x.pane)
    expect(existsSync(join(x.dir, 'dialog-answer.json'))).toBe(true)
    expect(x.result()).toMatchObject({ control_id: CTL2 })
  })
  it('a confirmed Enter is the answer for good: no memory, the card’s id is the pressed one, and a tap for it is refused', async () => {
    const x = await setup()
    await x.sync()
    const first = x.offer()
    swallowEnter(x, 'sent')
    await answerFor(x, { choice: 0 })
    await x.d.answer(x.target, x.pane)
    expect(x.target.offer.enterSentFor).toBe(first.id)
    expect(x.target.offer.enterUnsentFor).toBeNull()
    expect(x.target.offer.declinedTrust).toBe(true) // confirmed: the exit that follows is the owner's
    await answerFor(x, {
      dialog: first,
      choice: 0,
      control: CTL2,
      frameId: FRAME2,
      ts: new Date(NOW + 1000).toISOString(),
    })
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed', reason: 'already_answered', control_id: CTL2 })
    expect(x.pane.keys).toEqual(['Enter'])
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
      JSON.stringify({ ...a, at: new Date(NOW + (WORKER_TIMING.card_lifetime_s + 1) * 1000).toISOString() }),
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

// ---- the safety questions: bypass disclaimer, MCP server, a thread's development channel (pane-prompts rows 2 to 4) ----

const IDLE = { plain: SCREENS.idle.plain, coloured: SCREENS.idle.coloured }
const devCap = parseCapture(readFileSync(resolve(FIX, 'real-dev-channels', 'dev-channels-capture.txt'), 'utf8'))
const bypassCap = cap('real-2.1.318', 'bypass-disclaimer')
const mcpCap = cap(CAP, '20-mcp-first')
const CURSOR_ON = '\x1b[38;5;153m'

/** A real capture with its option rows redrawn for a cursor row: plain, and coloured the way Claude Code draws the cursor row. */
function selectFrames(
  base: string[],
  isOption: (row: string) => boolean,
  draw: (label: string, on: boolean) => { plain: string; coloured: string },
  labels: string[],
) {
  const first = base.findIndex(isOption)
  return (cursor: number) => {
    const plain = [...base]
    const coloured = [...base]
    labels.forEach((l, i) => {
      const r = draw(l, i === cursor)
      plain[first + i] = r.plain
      coloured[first + i] = r.coloured
    })
    return { plain, coloured }
  }
}

const BYPASS = ['No, exit', 'Yes, I accept']
const bypassFrame = selectFrames(
  bypassCap,
  (r) => r.includes('No, exit'),
  (l, on) => ({
    plain: on ? `  ❯ ${l}` : `    ${l}`,
    coloured: on ? `  ${CURSOR_ON}❯ ${l}\x1b[39m` : `    ${l}`,
  }),
  BYPASS,
)
const MCP = [
  'Use this MCP server',
  'Use this and all future MCP servers in this project',
  'Continue without using this MCP server',
]
const mcpFrame = selectFrames(
  mcpCap,
  (r) => r === '    Use this MCP server',
  (l, on) => ({
    plain: on ? `  ❯ ${l}` : `    ${l}`,
    coloured: on ? `  ${CURSOR_ON}❯ ${l}\x1b[39m` : `    ${l}`,
  }),
  MCP,
)
const DEV = ['I am using this for local development', 'Exit']
const devFrame = selectFrames(
  devCap,
  (r) => r.includes('1. I am using'),
  (l, on) => {
    const n = DEV.indexOf(l) + 1
    const row = on ? ` ❯ ${n}. ${l}` : `   ${n}. ${l}`
    return { plain: row, coloured: row }
  },
  DEV,
)

/** A select drawn from a real capture: Up and Down move its cursor (wrapping, as the real one does), Enter closes it. */
class SelectPane implements TestPane {
  keys: PtyDialogKey[] = []
  kinds: Array<string | undefined> = []
  clients: number[] | null = []
  gone = false
  constructor(
    private readonly frame: (cursor: number) => { plain: string[]; coloured: string[] },
    private readonly n: number,
    public cursor: number,
  ) {}
  /** Another screen takes its place (the owner's own Enter, a different dialog). */
  replaced: { plain: string[]; coloured: string[] } | null = null
  private now() {
    return this.replaced ?? (this.gone ? IDLE : this.frame(this.cursor))
  }
  async visibleRows() {
    return this.now().plain
  }
  async visibleRowsEscaped() {
    return this.now().coloured
  }
  async clientActivities() {
    return this.clients
  }
  async sendDialogKey(k: PtyDialogKey, kind?: string): Promise<PtySendResult> {
    this.keys.push(k)
    this.kinds.push(kind)
    if (k === 'Enter') this.gone = true
    else this.cursor = (this.cursor + (k === 'Down' ? 1 : this.n - 1)) % this.n
    return 'sent'
  }
  seen(): Screen {
    return this.gone ? { kind: 'none' } : liveScreen(this.now().plain)
  }
}

describe('the bypass-permissions disclaimer on a card', () => {
  it('a real disclaimer is offered: no subject, its two rows, the cursor on "No, exit"', async () => {
    const x = await setup(new SelectPane(bypassFrame, 2, 0))
    await x.sync()
    expect(x.offer()).toMatchObject({ kind: 'bypass', subject: null, options: BYPASS, cursor: 0 })
    expect(x.offer().id).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })
  it('a signed "Yes, I accept": one Down, then one Enter, every key stating the bypass kind', async () => {
    const x = await setup(new SelectPane(bypassFrame, 2, 0))
    await x.sync()
    await answerFor(x, { choice: 1 })
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual(['Down', 'Enter'])
    expect(new Set(x.pane.kinds)).toEqual(new Set(['bypass']))
    expect(x.result()).toMatchObject({ outcome: 'pressed', choice: 1, label: 'Yes, I accept' })
    expect(x.target.offer.declinedExit).toBeNull()
  })
  it('a signed "No, exit": just Enter; the session’s exit that follows is the owner’s answer, said in its own words', async () => {
    const x = await setup(new SelectPane(bypassFrame, 2, 0))
    await x.sync()
    await answerFor(x, { choice: 0 })
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual(['Enter'])
    expect(x.result()).toMatchObject({ outcome: 'pressed', choice: 0, label: 'No, exit' })
    expect(x.target.offer.declinedExit).toBe('bypass')
    expect(declinedTrustText(x.target.offer)).toContain('permission checks off')
    expect(declinedTrustText(x.target.offer)).toBeNull() // said once
  })
  it('an answer an agent could write (a forged signature, a key that is no paired device, no proof at all) presses nothing', async () => {
    const x = await setup(new SelectPane(bypassFrame, 2, 0))
    await x.sync()
    // 1. signed by a device nobody paired
    const other = await createExtractableDeviceKeyForTests()
    await answerFor(x, { key: other.privateKey, deviceId: other.deviceId, choice: 1 })
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed', reason: 'unverified' })
    // 2. the paired device's id with a signature that is not its own
    const a = await answerFor(x, { control: 'dc_2', choice: 1 })
    writeFileSync(
      join(x.dir, 'dialog-answer.json'),
      JSON.stringify({ ...a, proof: { ...a.proof, osig: 'A'.repeat(86) } }),
    )
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ control_id: 'dc_2', outcome: 'nothing_pressed', reason: 'unverified' })
    // 3. a bare answer with no proof: not an answer at all, so no result and no key
    writeFileSync(
      join(x.dir, 'dialog-answer.json'),
      JSON.stringify({
        v: 2,
        dialog_id: x.offer().id,
        choice: 1,
        label: 'Yes, I accept',
        by: 'agent',
        at: new Date(NOW).toISOString(),
        control_id: 'dc_3',
      }),
    )
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual([])
    expect(x.result()?.control_id).toBe('dc_2')
  })
  it('a tap signed for a card whose rows were changed (a third row, another label) presses nothing', async () => {
    const x = await setup(new SelectPane(bypassFrame, 2, 0))
    await x.sync()
    await answerFor(x, { dialog: { ...x.offer(), options: ['No, exit', 'Yes, I accept', 'Always'] }, choice: 1 })
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual([])
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed', reason: 'unverified' })
  })
  it('a different dialog in its place by the time of the tap (the screen changed under the card) presses nothing', async () => {
    const x = await setup(new SelectPane(bypassFrame, 2, 0))
    await x.sync()
    await answerFor(x, { choice: 1 })
    x.pane.replaced = mcpFrame(0)
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual([])
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed' })
  })
  it('a partial or garbled disclaimer gets no card, and one that was carded loses it after two bad looks', async () => {
    const dropped = {
      plain: bypassCap.filter((r) => !r.includes('Yes, I accept')),
      coloured: bypassCap.filter((r) => !r.includes('Yes, I accept')),
    }
    const x = await setup(new SelectPane(() => dropped, 2, 0))
    await x.sync()
    expect(x.target.dialog()).toBeUndefined()
    const y = await setup(new SelectPane(bypassFrame, 2, 0))
    await y.sync()
    expect(y.target.dialog()).toBeDefined()
    y.pane.replaced = { plain: ['half a screen', '❯ No, exi'], coloured: ['half a screen', '❯ No, exi'] }
    await y.d.sync(y.target, y.pane, ['half a screen', '❯ No, exi'], { kind: 'bypass_disclaimer' }, true)
    await y.d.sync(y.target, y.pane, ['half a screen', '❯ No, exi'], { kind: 'bypass_disclaimer' }, true)
    expect(y.target.dialog()).toBeUndefined()
  })
  it('a copy of a signed "Yes, I accept" (the same tap under another control id, or after a restart) presses nothing more: a tap is used once', async () => {
    const x = await setup(new SelectPane(bypassFrame, 2, 0))
    await x.sync()
    const a = await answerFor(x, { choice: 1 })
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual(['Down', 'Enter'])
    // the same dialog is drawn again (the owner pressed Esc and Claude asked again): this is a new sighting, and the old tap is for the old id
    x.pane.gone = false
    x.pane.cursor = 0
    x.target.offer.enterSentFor = null
    writeFileSync(join(x.dir, 'dialog-answer.json'), JSON.stringify({ ...a, control_id: 'dc_copy' }))
    await x.d.answer(x.target, x.pane)
    expect(x.result()).toMatchObject({ control_id: 'dc_copy', outcome: 'nothing_pressed', reason: 'already_answered' })
    expect(x.pane.keys).toEqual(['Down', 'Enter'])
  })
  it('an Enter whose delivery timed out is never remembered as the owner’s "No" (it may not have landed)', async () => {
    const x = await setup(new SelectPane(bypassFrame, 2, 0))
    await x.sync()
    await answerFor(x, { choice: 0 })
    const send = x.pane.sendDialogKey.bind(x.pane)
    x.pane.sendDialogKey = async (k, kind) => ((await send(k, kind)) && k === 'Enter' ? 'unknown' : 'sent')
    await x.d.answer(x.target, x.pane)
    expect(x.target.offer.declinedExit).toBeNull()
  })
})

describe("a thread's development-channels question on a card", () => {
  it('a real one is offered with its channels as the subject, and "Exit" is the owner’s decline, in its own words', async () => {
    const x = await setup(new SelectPane(devFrame, 2, 0))
    await x.sync()
    expect(x.offer()).toMatchObject({ kind: 'dev_channels', subject: 'server:talos-app', options: DEV, cursor: 0 })
    await answerFor(x, { choice: 1 })
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual(['Down', 'Enter'])
    expect(new Set(x.pane.kinds)).toEqual(new Set(['dev_channels']))
    expect(x.target.offer.declinedExit).toBe('dev_channels')
    expect(declinedTrustText(x.target.offer)).toContain('development channel')
  })
  it('"I am using this for local development" is one Enter and no decline', async () => {
    const x = await setup(new SelectPane(devFrame, 2, 0))
    await x.sync()
    await answerFor(x, { choice: 0 })
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual(['Enter'])
    expect(x.result()).toMatchObject({ outcome: 'pressed', label: 'I am using this for local development' })
    expect(x.target.offer.declinedExit).toBeNull()
  })
  it('the same question with more channels than the card showed (the list changed) presses nothing', async () => {
    const x = await setup(new SelectPane(devFrame, 2, 0))
    await x.sync()
    await answerFor(x, { choice: 0 })
    const more = (c: number) => {
      const f = devFrame(c)
      const swap = (r: string) => r.replace('Channels: server:talos-app', 'Channels: server:talos-app, server:other')
      return { plain: f.plain.map(swap), coloured: f.coloured.map(swap) }
    }
    x.pane.replaced = more(0)
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual([])
    expect(x.result()).toMatchObject({ outcome: 'nothing_pressed' })
  })
})

describe('an MCP server question on a card', () => {
  const wrapped = (c: number) => {
    const f = mcpFrame(c)
    const swap = (rs: string[]) =>
      rs.flatMap((r) =>
        r.includes('New MCP server found')
          ? ['  New MCP server found in this project: a-very-long-na', '  me-that-wrapped']
          : [r],
      )
    return { plain: swap(f.plain), coloured: swap(f.coloured) }
  }
  it('a server named on its row is offered with its name; "Continue without" is the deny and presses its row', async () => {
    const x = await setup(new SelectPane(mcpFrame, 3, 2))
    await x.sync()
    expect(x.offer()).toMatchObject({ kind: 'mcp_consent', subject: 'harmless', options: MCP, cursor: 2 })
    await answerFor(x, { choice: 2 })
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual(['Enter'])
    expect(x.result()).toMatchObject({ outcome: 'pressed', label: 'Continue without using this MCP server' })
    expect(new Set(x.pane.kinds)).toEqual(new Set(['mcp_consent']))
  })
  it('"Use this MCP server": two Ups from the denying row, then Enter, each arrow read back', async () => {
    const x = await setup(new SelectPane(mcpFrame, 3, 2))
    await x.sync()
    await answerFor(x, { choice: 0 })
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual(['Up', 'Up', 'Enter'])
    expect(x.result()).toMatchObject({ outcome: 'pressed', choice: 0, label: 'Use this MCP server' })
  })
  it('a name wrapped over two rows is a card only when .mcp.json defines exactly that name', async () => {
    const none = await setup(new SelectPane(wrapped, 3, 2))
    await none.sync()
    expect(none.target.dialog()).toBeUndefined() // no names: the line is the way, never a half name
    const wrong = await setup(new SelectPane(wrapped, 3, 2), () => ['something-else'])
    await wrong.sync()
    expect(wrong.target.dialog()).toBeUndefined()
    const right = await setup(new SelectPane(wrapped, 3, 2), () => ['a-very-long-name-that-wrapped', 'other'])
    await right.sync()
    expect(right.offer()).toMatchObject({ kind: 'mcp_consent', subject: 'a-very-long-name-that-wrapped' })
    // and the tap presses on the same reading
    await answerFor(right, { choice: 2 })
    await right.d.answer(right.target, right.pane)
    expect(right.result()).toMatchObject({ outcome: 'pressed' })
  })
  it('a tap for a card whose server was another one presses nothing', async () => {
    const x = await setup(new SelectPane(mcpFrame, 3, 2))
    await x.sync()
    await answerFor(x, { choice: 0 })
    const f = (c: number) => {
      const g = mcpFrame(c)
      const swap = (r: string) => r.replace('project: harmless', 'project: evil')
      return { plain: g.plain.map(swap), coloured: g.coloured.map(swap) }
    }
    x.pane.replaced = f(2)
    await x.d.answer(x.target, x.pane)
    expect(x.pane.keys).toEqual([])
  })
})

describe('the key gate for the safety questions (every key states its kind; the live screen must be exactly that)', () => {
  const colour = (r: string[]) => r.map((x) => x.replace(/❯ (.*)$/, `${CURSOR_ON}❯ $1\x1b[39m`))
  it('a bypass key goes only onto the real bypass disclaimer, whichever row the cursor is on', () => {
    for (const c of [0, 1]) expect(keyRefusal(bypassFrame(c).coloured, { type: 'dialog', kind: 'bypass' })).toBeNull()
    for (const [name, rows] of [
      ['trust', colour(SCREENS.top.plain)],
      ['mcp', mcpFrame(2).coloured],
      ['dev', colour(devCap)],
      ['an idle box', SCREENS.idle.coloured],
      ['a row missing', colour(bypassCap.filter((r) => !r.includes('Yes, I accept')))],
      ['unread', null],
    ] as const)
      expect(keyRefusal(rows, { type: 'dialog', kind: 'bypass' })?.why, name).toMatch(/^(not_bypass|unreadable)$/)
  })
  it('and the other kinds’ keys are refused on the disclaimer (a card for MCP cannot press on a bypass screen)', () => {
    for (const kind of ['trust', 'mcp_consent', 'dev_channels'] as const)
      expect(keyRefusal(bypassFrame(0).coloured, { type: 'dialog', kind })?.why, kind).toBe(`not_${kind}`)
  })
  it('a dev_channels key goes only onto the real question, and the usage-limit menu takes none of them', () => {
    expect(keyRefusal(colour(devCap), { type: 'dialog', kind: 'dev_channels' })).toBeNull()
    expect(keyRefusal(bypassFrame(0).coloured, { type: 'dialog', kind: 'dev_channels' })?.why).toBe('not_dev_channels')
    const usage = cap('synthetic', 'usage-limit-cursor3')
    for (const kind of ['bypass', 'mcp_consent', 'dev_channels'] as const)
      expect(keyRefusal(usage, { type: 'dialog', kind })?.why, kind).toBe('usage_limit')
  })
})
