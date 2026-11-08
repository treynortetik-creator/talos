// The proof an answer file carries and the check the Mac makes before it presses a key (dialog-files.ts lists the steps). The
// fixtures in fixtures/needs-you/ are what the Swift side is built against: real answers signed with the committed test device
// key, and the tampered ones a Mac must refuse. This is the reference check, run against them.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildDialogProof,
  DIALOG_ANSWER_MAX_BYTES,
  DialogAnswer,
  type DialogVerifyEnv,
  type JwkP256T,
  jcs,
  ownerSignedString,
  ownerSigningInput,
  payloadHash,
  sha256Hex,
  verifyDialogAnswer,
  verifyOwnerSignedString,
} from '../src/index.ts'
import { loadTestKey } from './helpers.ts'
import { buildAnswerFixtures, LOGIN, TRIP, TRIP_ID } from './support/needs-you-fixtures.ts'

const DIR = join(import.meta.dirname, '..', 'fixtures', 'needs-you')
const read = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), 'utf8'))
const NOW = Date.parse('2026-11-07T10:00:30.000Z')

if (process.env.UPDATE_NEEDS_YOU_FIXTURES) {
  await (async () => {
    mkdirSync(DIR, { recursive: true })
    const { files, pinned, deviceB } = await buildAnswerFixtures()
    for (const [name, body] of Object.entries(files))
      writeFileSync(join(DIR, name), `${JSON.stringify(body, null, 2)}\n`)
    writeFileSync(join(DIR, 'pinned-devices.json'), `${JSON.stringify(pinned, null, 2)}\n`)
    writeFileSync(join(DIR, 'device-b.json'), `${JSON.stringify(deviceB, null, 2)}\n`)
    const pane = (thread: string, d: typeof TRIP) => ({
      thread,
      dialog_id: d.id,
      dialog_kind: d.kind,
      subject: d.subject,
      options: d.options,
    })
    writeFileSync(join(DIR, 'pane-trip.json'), `${JSON.stringify(pane('trip', TRIP), null, 2)}\n`)
    writeFileSync(join(DIR, 'pane-login.json'), `${JSON.stringify(pane('inbox2', LOGIN), null, 2)}\n`)
  })()
}

const pinned = read('pinned-devices.json') as Record<string, JwkP256T>
type Pane = {
  thread: string
  dialog_id: string
  dialog_kind: 'trust' | 'mcp_consent' | 'login'
  subject: string | null
  options: string[]
}
const tripPane = read('pane-trip.json') as Pane
const loginPane = read('pane-login.json') as Pane
const env = (pane: Pane, over: Partial<DialogVerifyEnv> = {}): DialogVerifyEnv => ({
  pinnedKey: (id) => pinned[id],
  nowMs: NOW,
  thread: pane.thread,
  pane,
  ...over,
})

describe('a good answer', () => {
  it('passes every step and names the signed choice', async () => {
    const v = await verifyDialogAnswer(read('dialog-answer.json'), env(tripPane))
    expect(v).toEqual({ ok: true, choice: 1, label: 'Yes, I trust this folder', device_id: loadTestKey().deviceId })
  })
  it('a login answer opens, with no choice', async () => {
    expect(await verifyDialogAnswer(read('dialog-answer-open.json'), env(loginPane))).toMatchObject({
      ok: true,
      choice: null,
      label: null,
    })
  })
  it('presses from the signed choice, not from the words at the top of the file', async () => {
    const f = read('dialog-answer-display-differs.json') as { choice: number; label: string }
    expect(f).toMatchObject({ choice: 0, label: 'No, exit' })
    expect(await verifyDialogAnswer(f, env(tripPane))).toMatchObject({
      ok: true,
      choice: 1,
      label: 'Yes, I trust this folder',
    })
  })
  it('fits the answer size cap with room to spare', () => {
    expect(Buffer.byteLength(JSON.stringify(read('dialog-answer.json')))).toBeLessThan(DIALOG_ANSWER_MAX_BYTES / 2)
    expect(DialogAnswer.safeParse(read('dialog-answer.json')).success).toBe(true)
  })
  it('checks the screen label and says so when it moved', async () => {
    const ok = await verifyDialogAnswer(
      read('dialog-answer.json'),
      env(tripPane, { screenLabel: (i) => tripPane.options[i] }),
    )
    expect(ok.ok).toBe(true)
    const moved = await verifyDialogAnswer(read('dialog-answer.json'), env(tripPane, { screenLabel: () => 'No, exit' }))
    expect(moved).toMatchObject({ ok: false, step: 5, reason: 'screen_changed' })
  })
  it('presses once per dialog id', async () => {
    expect(await verifyDialogAnswer(read('dialog-answer.json'), env(tripPane, { alreadyPressed: true }))).toMatchObject(
      {
        ok: false,
        step: 5,
        reason: 'already_answered',
      },
    )
  })
})

describe('every tampered answer is refused at its step, and nothing is pressed', () => {
  const cases: Array<[string, Pane, number, string]> = [
    ['dialog-answer-missing-proof.json', tripPane, 0, 'unverified'],
    ['dialog-answer-wrong-device.json', tripPane, 1, 'unverified'],
    ['dialog-answer-bad-signature.json', tripPane, 2, 'unverified'],
    ['dialog-answer-wrong-choice.json', tripPane, 2, 'unverified'],
    ['dialog-answer-old-ts.json', tripPane, 3, 'unverified'],
    ['dialog-answer-kill.json', tripPane, 3, 'unverified'],
    ['dialog-answer-edited.json', tripPane, 3, 'unverified'],
    ['dialog-answer-signed-device-differs.json', tripPane, 3, 'unverified'],
    ['dialog-answer-changed-binding.json', tripPane, 4, 'unverified'],
    ['dialog-answer-changed-binding-title.json', tripPane, 4, 'unverified'],
    ['dialog-answer-wrong-card-thread.json', tripPane, 4, 'unverified'],
    ['dialog-answer-wrong-payload-thread.json', tripPane, 4, 'unverified'],
    ['dialog-answer-other-card-id.json', tripPane, 4, 'unverified'],
    ['dialog-answer-subject-differs.json', tripPane, 4, 'unverified'],
    ['dialog-answer-wrong-thread.json', tripPane, 4, 'unverified'],
    ['dialog-answer-other-dialog.json', tripPane, 4, 'unverified'],
    // a good answer for one thread's dialog, given to another worker's pane
    ['dialog-answer.json', loginPane, 0, 'unverified'],
  ]
  it.each(cases)('%s', async (name, pane, step, reason) => {
    const v = await verifyDialogAnswer(read(name), env(pane))
    expect(v, name).toMatchObject({ ok: false, step, reason })
  })

  it('refuses a good answer if the Mac has no pin for the device, or a different key under that id', async () => {
    expect(
      await verifyDialogAnswer(read('dialog-answer.json'), env(tripPane, { pinnedKey: () => undefined })),
    ).toMatchObject({ ok: false, step: 1 })
    const b = read('device-b.json') as { publicJwk: JwkP256T }
    expect(
      await verifyDialogAnswer(read('dialog-answer.json'), env(tripPane, { pinnedKey: () => b.publicJwk })),
    ).toMatchObject({ ok: false, step: 1 })
  })

  it('refuses when the Mac saw something other than the card says (subject, options, order, kind, thread, id)', async () => {
    const good = read('dialog-answer.json')
    const mine: Array<Partial<Pane>> = [
      { subject: '/home/alex/notes' },
      { subject: null },
      { options: ['Yes, I trust this folder', 'No, exit'] },
      { options: ['No, exit'] },
      { options: ['No, exit', 'Yes, I trust this folder', 'Extra'] },
      { dialog_kind: 'mcp_consent' },
    ]
    for (const over of mine) {
      const v = await verifyDialogAnswer(good, env({ ...tripPane, ...over }))
      expect(v, JSON.stringify(over)).toMatchObject({ ok: false, step: 4 })
    }
    expect(await verifyDialogAnswer(good, env({ ...tripPane, thread: 'garden' }))).toMatchObject({ ok: false, step: 4 })
    expect(await verifyDialogAnswer(good, env({ ...tripPane, dialog_id: 'Aq5Lm8ZtRx3Cv9PkNa2HdB' }))).toMatchObject({
      ok: false,
      step: 0,
    })
  })

  it('judges the tap time on the Mac clock: 15 minutes back, 2 minutes ahead', async () => {
    const f = read('dialog-answer.json')
    const tap = Date.parse('2026-11-07T10:00:09.000Z')
    expect((await verifyDialogAnswer(f, env(tripPane, { nowMs: tap + 15 * 60_000 }))).ok).toBe(true)
    expect((await verifyDialogAnswer(f, env(tripPane, { nowMs: tap + 15 * 60_000 + 1 }))).ok).toBe(false)
    expect((await verifyDialogAnswer(f, env(tripPane, { nowMs: tap - 2 * 60_000 }))).ok).toBe(true)
    expect((await verifyDialogAnswer(f, env(tripPane, { nowMs: tap - 2 * 60_000 - 1 }))).ok).toBe(false)
  })
})

describe('the pieces, as the Mac rebuilds them', () => {
  const good = read('dialog-answer.json') as {
    proof: { signed: string; osig: string; device_id: string; binding: string }
  }
  const key = loadTestKey()

  it('the signature is over "talos-owner/v1\\n" + device_id + "\\n" + sha256Hex(proof.signed)', async () => {
    const input = `talos-owner/v1\n${good.proof.device_id}\n${sha256Hex(good.proof.signed)}`
    expect(ownerSigningInput(JSON.parse(good.proof.signed) as Record<string, unknown>)).toBe(input)
    expect(await verifyOwnerSignedString(good.proof.signed, good.proof.osig, good.proof.device_id, key.publicJwk)).toBe(
      true,
    )
    expect(
      await verifyOwnerSignedString(`${good.proof.signed} `, good.proof.osig, good.proof.device_id, key.publicJwk),
    ).toBe(false)
  })
  it('proof.signed is the canonical text of the frame without osig, relay and stepup_token', () => {
    const frame = {
      ...(JSON.parse(good.proof.signed) as Record<string, unknown>),
      osig: good.proof.osig,
      relay: { seq: 1, received_at: 'x' },
      stepup_token: 't',
    }
    expect(ownerSignedString(frame)).toBe(good.proof.signed)
    expect(good.proof.signed).toBe(jcs(JSON.parse(good.proof.signed)))
  })
  it('payload_hash is "sha256:" + sha256Hex(proof.binding), and the binding names the dialog whole', () => {
    const signed = JSON.parse(good.proof.signed) as { payload_hash: string; card_id: string; choice: number }
    expect(`sha256:${sha256Hex(good.proof.binding)}`).toBe(signed.payload_hash)
    const binding = JSON.parse(good.proof.binding) as Record<string, unknown> & { payload: Record<string, unknown> }
    expect(payloadHash(binding)).toBe(signed.payload_hash)
    expect(binding).toMatchObject({ kind: 'dialog', thread_id: 'trip', id: signed.card_id })
    expect(binding.payload).toMatchObject({
      dialog_id: TRIP_ID,
      thread: 'trip',
      dialog_kind: 'trust',
      subject: '/home/alex/trip',
      options: ['No, exit', 'Yes, I trust this folder'],
    })
  })
  it('buildDialogProof takes the raw frame and the card binding, and nothing without a signature', () => {
    expect(buildDialogProof({ type: 'card.resolve' }, {})).toBeNull()
    const p = buildDialogProof(
      { type: 'card.resolve', device_id: 'd_aaaaaaaaaaaaaaaaaaaa', osig: 'x'.repeat(86), relay: { seq: 1 } },
      {},
    )
    expect(p?.signed).not.toContain('relay')
  })
})
