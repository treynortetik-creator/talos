// Builds the fixtures in fixtures/needs-you/ (run `UPDATE_NEEDS_YOU_FIXTURES=1 npx vitest run packages/protocol/test/dialog-proof.test.ts`
// to write them again). The signatures are made with the committed TEST device key, so they are real, but they are
// random per run: the fixtures are committed and the tests read them, they do not rebuild them.
import {
  b64urlEncode,
  bindingFrom,
  buildDialogProof,
  type CardT,
  composeDialogCard,
  createExtractableDeviceKeyForTests,
  importDevicePrivateKey,
  jcs,
  ownerSignedString,
  ownerSigningInputFor,
  payloadHash,
  signOwnerFrame,
  utf8,
  type WorkerDialogT,
} from '../../src/index.ts'
import { loadTestKey } from '../helpers.ts'

export const FIXED_NOW = Date.parse('2026-11-07T10:00:00.000Z')
export const TAP_TS = '2026-11-07T10:00:09.000Z'
/** Ids the Mac makes: 128 bits of base64url. */
export const TRIP_ID = 'k3Xv9QpT2mLw8ZrNa5HdBe'
export const GARDEN_ID = 'Zt7Rm2QxW9cKpL4vNaH8dB'
export const LOGIN_ID = 'Hc4Pq9ZtLm2Xw7RvNa5KdB'
export const OTHER_ID = 'Wq5Lm8ZtRx3Cv9PkNa2HdB'

export const dialogOn = (
  id: string,
  kind: WorkerDialogT['kind'],
  subject: string | null,
  options: string[],
): WorkerDialogT => ({
  id,
  kind,
  subject,
  options,
  cursor: kind === 'login' ? null : 1,
  seen_at: new Date(FIXED_NOW).toISOString(),
  expires_at: new Date(FIXED_NOW + 900_000).toISOString(),
})
export const TRIP = dialogOn(TRIP_ID, 'trust', '/home/alex/trip', ['No, exit', 'Yes, I trust this folder'])
export const LOGIN = dialogOn(LOGIN_ID, 'login', null, [])

const card = (cardId: string, thread: string, name: string, d: WorkerDialogT): CardT =>
  composeDialogCard({ card_id: cardId, dialog: d, thread_id: thread, thread_name: name, now: FIXED_NOW }) as CardT

async function signedAnswer(opts: {
  /** The card id the signed frame names (default: the card's own). */
  frameCardId?: string
  c: CardT
  choice?: number
  action?: string
  ts?: string
  deviceId: string
  key: CryptoKey
  extra?: Record<string, unknown>
  display?: { choice?: number; label: string }
}) {
  const raw = await signOwnerFrame(
    {
      v: 1,
      id: '01JBF3V7Q8K2M4N6P8R0S2T4AA',
      ts: opts.ts ?? TAP_TS,
      type: 'card.resolve',
      card_id: opts.frameCardId ?? opts.c.id,
      action: opts.action ?? 'primary',
      payload_hash: opts.c.payload_hash,
      ...(opts.choice === undefined ? {} : { choice: opts.choice }),
      ...(opts.extra ?? {}),
      device_id: opts.deviceId,
    },
    opts.key,
  )
  const proof = buildDialogProof(raw, bindingFrom(opts.c))
  const d = opts.display
  return {
    v: 2,
    dialog_id: (opts.c.payload as { dialog_id: string }).dialog_id,
    ...(d
      ? d.choice === undefined
        ? { action: 'open' }
        : { choice: d.choice }
      : opts.choice === undefined
        ? { action: 'open' }
        : { choice: opts.choice }),
    label:
      d?.label ??
      (opts.choice === undefined
        ? 'Open on the Mac'
        : ((opts.c.payload as { options: string[] }).options[opts.choice] ?? '')),
    by: "Alex's iPhone",
    at: TAP_TS,
    control_id: 'dc_01M6V2TGWJCH4P49F79Q2317CD',
    proof,
  }
}

/** A card changed after it was composed, with its hash made again (so only the checks on its content can catch it). */
function rebound(c: CardT, change: (c: CardT) => void): CardT {
  const next = structuredClone(c)
  change(next)
  next.payload_hash = payloadHash(bindingFrom(next))
  return next
}

/** The frame says it is from device `claimed`, but the signature (and the proof) are the real signer's. */
async function claimedOtherDevice(c: CardT, signerId: string, key: CryptoKey, claimed: string) {
  const frame = {
    v: 1,
    id: '01JBF3V7Q8K2M4N6P8R0S2T4AA',
    ts: TAP_TS,
    type: 'card.resolve',
    card_id: c.id,
    action: 'primary',
    payload_hash: c.payload_hash,
    choice: 1,
    device_id: claimed,
  }
  const signed = ownerSignedString(frame)
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(ownerSigningInputFor(signerId, signed))),
  )
  return {
    v: 2,
    dialog_id: TRIP_ID,
    choice: 1,
    label: 'Yes, I trust this folder',
    by: "Alex's iPhone",
    at: TAP_TS,
    control_id: 'dc_01M6V2TGWJCH4P49F79Q2317CD',
    proof: { signed, osig: b64urlEncode(sig), device_id: signerId, binding: jcs(bindingFrom(c)) },
  }
}

/** Every answer fixture, by file name, with what a correct Mac does with it. */
export async function buildAnswerFixtures() {
  const a = loadTestKey()
  const keyA = await importDevicePrivateKey(a.privateJwk)
  const b = await createExtractableDeviceKeyForTests()
  const tripCard = card('c_01JBF3V7Q8K2M4N6P8R0S2T403', 'trip', 'Trip', TRIP)
  const base = { c: tripCard, choice: 1, deviceId: a.deviceId, key: keyA }
  const good = await signedAnswer(base)
  const files: Record<string, unknown> = {}
  files['dialog-answer.json'] = good
  files['dialog-answer-open.json'] = await signedAnswer({
    c: card('c_01JBF3V7Q8K2M4N6P8R0S2T404', 'inbox2', 'Inbox', LOGIN),
    deviceId: a.deviceId,
    key: keyA,
  })
  // the top-level words are for display: the signed choice decides
  files['dialog-answer-display-differs.json'] = await signedAnswer({
    ...base,
    display: { choice: 0, label: 'No, exit' },
  })
  // step 2: the signed text was changed (choice 1 -> 0) and the signature is the old one
  const wrong = structuredClone(good) as { proof: { signed: string } }
  wrong.proof.signed = wrong.proof.signed.replace('"choice":1', '"choice":0')
  files['dialog-answer-wrong-choice.json'] = wrong
  // step 4: the binding was changed after signing
  const changed = structuredClone(good) as { proof: { binding: string } }
  changed.proof.binding = changed.proof.binding.replace('/home/alex/trip', '/home/alex/notes')
  files['dialog-answer-changed-binding.json'] = changed
  // step 4: the owner really did sign this card, whose folder reads harmlessly: it is not the dialog this Mac saw
  files['dialog-answer-subject-differs.json'] = await signedAnswer({
    ...base,
    c: card(
      'c_01JBF3V7Q8K2M4N6P8R0S2T405',
      'trip',
      'Trip',
      dialogOn(TRIP_ID, 'trust', '/home/alex/notes', TRIP.options),
    ),
  })
  // step 4: a real card for another thread's dialog (same options), used on this worker
  files['dialog-answer-wrong-thread.json'] = await signedAnswer({
    ...base,
    c: card('c_01JBF3V7Q8K2M4N6P8R0S2T406', 'garden', 'Garden', dialogOn(TRIP_ID, 'trust', TRIP.subject, TRIP.options)),
  })
  // step 4: only the card's wording changed: the hash no longer matches, though every fact the Mac compares is the same
  const retitled = structuredClone(good) as { proof: { binding: string } }
  retitled.proof.binding = retitled.proof.binding.replace('Trust this folder?', 'Open the pod bay doors?')
  files['dialog-answer-changed-binding-title.json'] = retitled
  // step 4: really signed cards whose thread is wrong in exactly one place
  files['dialog-answer-wrong-card-thread.json'] = await signedAnswer({
    ...base,
    c: rebound(tripCard, (c) => {
      c.thread_id = 'garden'
    }),
  })
  files['dialog-answer-wrong-payload-thread.json'] = await signedAnswer({
    ...base,
    c: rebound(tripCard, (c) => {
      ;(c.payload as { thread: string }).thread = 'garden'
    }),
  })
  // step 4: the frame names another card than the binding is
  files['dialog-answer-other-card-id.json'] = await signedAnswer({
    ...base,
    frameCardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T499',
  })
  // step 3: the owner's device signed a frame that says it is from another device
  files['dialog-answer-signed-device-differs.json'] = await claimedOtherDevice(tripCard, a.deviceId, keyA, b.deviceId)
  // step 4: a real card for another dialog id
  // (its top-level words name the dialog on the pane; the signed card is for another one)
  files['dialog-answer-other-dialog.json'] = {
    ...(await signedAnswer({
      ...base,
      c: card('c_01JBF3V7Q8K2M4N6P8R0S2T407', 'trip', 'Trip', dialogOn(OTHER_ID, 'trust', TRIP.subject, TRIP.options)),
    })),
    dialog_id: TRIP_ID,
  }
  // step 1: a valid signature by a device this Mac has not pinned
  files['dialog-answer-wrong-device.json'] = await signedAnswer({ ...base, deviceId: b.deviceId, key: b.privateKey })
  // step 3: an old tap (an hour before the Mac's clock)
  files['dialog-answer-old-ts.json'] = await signedAnswer({ ...base, ts: '2026-11-07T08:55:00.000Z' })
  // step 3: a kill, and an edit: not an answer
  files['dialog-answer-kill.json'] = await signedAnswer({ ...base, action: 'kill' })
  files['dialog-answer-edited.json'] = await signedAnswer({ ...base, extra: { edited: { fields: [] } } })
  // step 0: no proof at all (an answer as the first version wrote it)
  const { proof: _p, ...noProof } = good as Record<string, unknown>
  files['dialog-answer-missing-proof.json'] = noProof
  const badSig = structuredClone(good) as { proof: { osig: string } }
  // a character in the middle: the last one carries only two significant bits, so changing it can leave the same 64 bytes
  const o = badSig.proof.osig
  badSig.proof.osig = `${o.slice(0, 40)}${o[40] === 'A' ? 'B' : 'A'}${o.slice(41)}`
  files['dialog-answer-bad-signature.json'] = badSig
  return {
    files,
    pinned: { [a.deviceId]: a.publicJwk },
    deviceB: { deviceId: b.deviceId, publicJwk: b.publicJwk },
  }
}
