// Needs-you prompts, protocol side: the dialog card, the owner's choice on card.resolve, who answered on card.update, and the
// files the Mac and the bridge share (docs/OPTION-C.md "Needs-you prompts").

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bindingFrom,
  Card,
  CardResolveFrame,
  type CardT,
  cardNotice,
  composeDialogCard,
  DIALOG_ALREADY_ANSWERED_TEXT,
  DIALOG_ANSWER_MAX_BYTES,
  DIALOG_CARD_WAIT_MS,
  DIALOG_FILE_MAX_BYTES,
  DIALOG_MAX_OPTIONS,
  DIALOG_TTL_S,
  DIALOG_UNVERIFIED_TEXT,
  DIALOG_WORDING,
  DialogAnswer,
  DialogCardFile,
  DialogCardPayload,
  DialogResult,
  dialogAnswerText,
  dialogBody,
  dialogFallbackLine,
  dialogFileFresh,
  dialogNothingPressedText,
  dialogOf,
  dialogTitle,
  dialogVisibleText,
  NATIVE_APPROVABLE_KINDS,
  NEEDS_YOU_FEATURE,
  newId,
  parseFrame,
  parseWorkersFile,
  payloadHash,
  signOwnerFrame,
  validateCard,
  verifyOwnerFrame,
  WORKER_FILES,
  WorkerDialog,
  type WorkerDialogT,
} from '../src/index.ts'
import { loadFixtures, loadTestKey } from './helpers.ts'
import { VISIBLE_TEXT_CASES } from './support/visible-text-cases.ts'

const NY = join(import.meta.dirname, '..', 'fixtures', 'needs-you')
const fixture = (name: string): string => readFileSync(join(NY, name), 'utf8')

/** Every non-ASCII code point as \\uXXXX (a pair for the astral ones), so the committed table shows what is in it. */
const escaped = (v: unknown): string =>
  `${JSON.stringify(v, null, 2).replace(/[^\x20-\x7e\n]/gu, (c) => {
    const cp = c.codePointAt(0) ?? 0
    const u = (n: number) => `\\u${n.toString(16).padStart(4, '0')}`
    return cp > 0xffff ? u(0xd800 + ((cp - 0x10000) >> 10)) + u(0xdc00 + ((cp - 0x10000) & 0x3ff)) : u(cp)
  })}\n`

// The shared wording and the shared hidden-text table, as the Mac app's tests read them (UPDATE_NEEDS_YOU_FIXTURES=1 writes them again).
if (process.env.UPDATE_NEEDS_YOU_FIXTURES) {
  writeFileSync(join(NY, 'wording.json'), escaped({ v: 1, ...DIALOG_WORDING }))
  writeFileSync(join(NY, 'visible-text.json'), escaped({ v: 1, cases: VISIBLE_TEXT_CASES }))
}

const NOW = Date.parse('2026-11-07T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

const trust = (over: Partial<WorkerDialogT> = {}): WorkerDialogT => ({
  id: 'k3Xv9QpT2mLw8ZrNa5HdBe',
  kind: 'trust',
  subject: '~/Documents/x',
  options: ['No, exit', 'Yes, I trust this folder'],
  cursor: 1,
  seen_at: iso(NOW),
  expires_at: iso(NOW + DIALOG_TTL_S * 1000),
  ...over,
})
const mcp = (): WorkerDialogT =>
  trust({
    id: 'Zt7Rm2QxW9cKpL4vNaH8dB',
    kind: 'mcp_consent',
    subject: 'github',
    options: [
      'Use this and all future MCP servers in this project',
      'Use this MCP server',
      'Continue without using this MCP server',
    ],
  })
const login = (): WorkerDialogT =>
  trust({ id: 'Hc4Pq9ZtLm2Xw7RvNa5KdB', kind: 'login', subject: null, options: [], cursor: null })

const compose = (d: WorkerDialogT, now = NOW) =>
  composeDialogCard({ card_id: newId('c'), dialog: d, thread_id: 'work', thread_name: 'Work', now }) as CardT

describe('the dialog card', () => {
  it('is a bridge-minted, bridge-handled kind a notification cannot approve', async () => {
    const { CARD_KIND_TABLE } = await import('../src/index.ts')
    expect(CARD_KIND_TABLE.dialog).toMatchObject({ minter: 'bridge', bridgeHandled: true, nativeApprovable: false })
    expect(NEEDS_YOU_FEATURE).toBe('needs-you/1')
    expect(NATIVE_APPROVABLE_KINDS).not.toContain('dialog')
    // a notification shows it but never offers Approve: the owner sees the buttons in the app first
    expect(cardNotice(compose(trust())).complete).toBe(false)
    expect(cardNotice(compose(login())).complete).toBe(false)
  })

  it.each([
    ['trust', trust(), 'Trust this folder?'],
    ['mcp_consent', mcp(), 'Allow this MCP server?'],
    ['login', login(), 'Work needs you to sign in'],
  ])('%s: a whole, valid card that mirrors the dialog', (_k, d, title) => {
    const card = compose(d)
    expect(Card.safeParse(card).success).toBe(true)
    expect(validateCard(card)).toEqual([])
    expect(card.kind).toBe('dialog')
    expect(card.title).toBe(title)
    expect(card.payload_hash).toBe(payloadHash(bindingFrom(card)))
    const p = dialogOf(card)
    expect(p).toMatchObject({ dialog_id: d.id, thread: 'work', dialog_kind: d.kind, subject: d.subject })
    // every option, in screen order, none dropped or edited
    expect(p?.options).toEqual(d.options)
  })

  it('keeps all three MCP options, including the "all future servers" one', () => {
    expect(dialogOf(compose(mcp()))?.options).toHaveLength(3)
  })

  it('binds the options: changing one changes payload_hash', () => {
    const a = compose(trust(), NOW)
    const b = composeDialogCard({
      card_id: a.id,
      dialog: trust({ options: ['No, exit', 'Yes, I trust this folder!'] }),
      thread_id: 'work',
      thread_name: 'Work',
      now: NOW,
    }) as CardT
    expect(a.payload_hash).not.toBe(b.payload_hash)
  })

  it('says the words of the design', () => {
    expect(dialogBody('trust', 'Work')).toBe(
      "Work's session wants to work in this folder. Claude will be able to read, change and run files in it, and in folders inside it.",
    )
    expect(dialogBody('mcp_consent', 'Work')).toBe(
      "Work's session wants to turn on this server's tools for its folder.",
    )
    expect(dialogBody('login', 'Work')).toBe("Work's session needs you to sign in to Claude on the Mac.")
    expect(dialogNothingPressedText('Work')).toBe(
      "Work's screen showed something different when Talos went to answer, so it left it alone. A new card comes if it still needs you.",
    )
  })

  it('has a one-line summary with nothing from the screen in it', () => {
    const c = compose(trust({ subject: '~/secret-folder' }))
    expect(c.summary).toBe("Work's session is waiting for you.")
    expect(JSON.stringify(c.summary)).not.toContain('secret')
  })

  it('login has one button, "Open on the Mac", and no options', () => {
    const c = compose(login())
    expect(c.primary_label).toBe('Open on the Mac')
    expect(dialogOf(c)?.options).toEqual([])
  })

  it('a subject the Mac could not read is null, not a guess', () => {
    expect(dialogOf(compose(trust({ subject: null })))?.subject).toBeNull()
  })

  it('never outlives 15 minutes from now, whatever the file says', () => {
    const c = compose(trust({ expires_at: iso(NOW + 24 * 3600_000) }))
    expect(Date.parse(c.expires_at)).toBe(NOW + DIALOG_TTL_S * 1000)
  })

  it('uses the dialog expiry when it is sooner', () => {
    const c = compose(trust({ expires_at: iso(NOW + 60_000) }))
    expect(Date.parse(c.expires_at)).toBe(NOW + 60_000)
  })

  it('is not a card at all once the dialog is past its time', () => {
    expect(
      composeDialogCard({
        card_id: newId('c'),
        dialog: trust({ expires_at: iso(NOW) }),
        thread_id: 'w',
        thread_name: 'W',
        now: NOW,
      }),
    ).toBeNull()
  })

  it('keeps hidden characters in the payload as read, and shows them in every sentence the bridge writes', () => {
    const subject = '~/proj‮gpj.txt​'
    const c = compose(trust({ subject, options: ['No, exit', 'Yes‮, I trust this folder'] }))
    expect(dialogOf(c)?.subject).toBe(subject)
    expect(dialogAnswerText('trust', subject, 'Yes‮, I trust this folder')).toBe('Trusted ~/proj⟦U+202E⟧gpj.txt⟦U+200B⟧')
    expect(dialogAnswerText('mcp_consent', 'x', 'Use this‮ MCP server')).toBe('Use this⟦U+202E⟧ MCP server')
  })

  it('uses the plain option label when there is no natural past tense', () => {
    expect(dialogAnswerText('trust', '~/x', 'No, exit')).toBe('No, exit')
    expect(dialogAnswerText('mcp_consent', 'github', 'Use this MCP server')).toBe('Use this MCP server')
  })

  it('reads a thread name with hidden characters visibly in the body', () => {
    expect(dialogBody('login', 'Wo‮rk')).toBe("Wo⟦U+202E⟧rk's session needs you to sign in to Claude on the Mac.")
  })

  it('has the Mac thread line as its expiry fallback', () => {
    expect(dialogFallbackLine('trust', 'Work')).toBe(
      "Work's session is waiting on a 'trust this folder' prompt; open Terminals → Work on the Mac to answer.",
    )
    expect(dialogFallbackLine('mcp_consent', 'Work')).toContain("'approve a project MCP server'")
    expect(dialogFallbackLine('login', 'Work')).toContain("'sign in'")
  })
})

describe('text from the screen is shown one way, and a label cannot fake the marker', () => {
  it('marks every hidden character as ⟦U+XXXX⟧, newlines included', () => {
    expect(dialogVisibleText('a\u202eb\u200bc\nd')).toBe('a⟦U+202E⟧b⟦U+200B⟧c⟦U+000A⟧d')
    expect(dialogVisibleText('plain text')).toBe('plain text')
  })
  it('marks the bracket characters themselves, so printing a marker shows the brackets', () => {
    expect(dialogVisibleText('⟦U+202E⟧')).toBe('⟦U+27E6⟧U+202E⟦U+27E7⟧')
    // what a person reads is never the same as for a real hidden character
    expect(dialogVisibleText('⟦U+202E⟧')).not.toBe(dialogVisibleText('\u202e'))
  })
  it('the sentences the bridge writes use it', () => {
    expect(dialogAnswerText('mcp_consent', null, 'Use ⟦U+200B⟧ it')).toBe('Use ⟦U+27E6⟧U+200B⟦U+27E7⟧ it')
  })
  it('has the words for the cases where the Mac pressed nothing', () => {
    expect(DIALOG_UNVERIFIED_TEXT).toBe('Answer on the Mac')
    expect(DIALOG_ALREADY_ANSWERED_TEXT).toBe('Already answered at the Mac first.')
  })
})

describe('caps', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    dialog_id: 'k3Xv9QpT2mLw8ZrNa5HdBe',
    thread: 'work',
    dialog_kind: 'trust',
    subject: '~/x',
    options: ['No, exit', 'Yes'],
    expires_at: iso(NOW),
    ...over,
  })

  it('takes at most six options', () => {
    expect(
      DialogCardPayload.safeParse(payload({ options: Array.from({ length: DIALOG_MAX_OPTIONS }, (_, i) => `o${i}`) }))
        .success,
    ).toBe(true)
    expect(
      DialogCardPayload.safeParse(
        payload({ options: Array.from({ length: DIALOG_MAX_OPTIONS + 1 }, (_, i) => `o${i}`) }),
      ).success,
    ).toBe(false)
  })

  it('caps a label and a subject', () => {
    expect(DialogCardPayload.safeParse(payload({ options: ['x'.repeat(121)] })).success).toBe(false)
    expect(DialogCardPayload.safeParse(payload({ options: [''] })).success).toBe(false)
    expect(DialogCardPayload.safeParse(payload({ subject: 'x'.repeat(501) })).success).toBe(false)
    expect(DialogCardPayload.safeParse(payload({ subject: '' })).success).toBe(false)
  })

  it('wants options on trust and MCP, and none on login', () => {
    expect(DialogCardPayload.safeParse(payload({ options: [] })).success).toBe(false)
    expect(DialogCardPayload.safeParse(payload({ dialog_kind: 'login', options: ['Open'] })).success).toBe(false)
    expect(DialogCardPayload.safeParse(payload({ dialog_kind: 'login', subject: null, options: [] })).success).toBe(
      true,
    )
  })

  it('knows only the three kinds and refuses an extra key', () => {
    expect(DialogCardPayload.safeParse(payload({ dialog_kind: 'bypass' })).success).toBe(false)
    expect(DialogCardPayload.safeParse(payload({ extra: 1 })).success).toBe(false)
  })

  it('composes nothing for a dialog over a cap', () => {
    const over = trust({ options: Array.from({ length: 7 }, (_, i) => `o${i}`) })
    expect(
      composeDialogCard({ card_id: newId('c'), dialog: over, thread_id: 'w', thread_name: 'W', now: NOW }),
    ).toBeNull()
  })
})

describe('card.resolve carries the chosen option', () => {
  const fx = loadFixtures()
  const base = fx['card.resolve'] as Record<string, unknown>

  it('still parses, and still verifies, without `choice` (every older app)', async () => {
    expect(parseFrame(base).ok).toBe(true)
    expect(CardResolveFrame.safeParse(base).success).toBe(true)
    const key = loadTestKey()
    expect(await verifyOwnerFrame(base, key.publicJwk)).toBe(true)
  })

  it('takes an index 0 to 5, signed with the rest of the frame', async () => {
    const key = loadTestKey()
    const { importDevicePrivateKey } = await import('../src/index.ts')
    const priv = await importDevicePrivateKey(key.privateJwk)
    const { osig: _o, ...rest } = base
    const signed = await signOwnerFrame({ ...rest, choice: 1 }, priv)
    expect(parseFrame(signed).ok).toBe(true)
    expect(await verifyOwnerFrame(signed, key.publicJwk)).toBe(true)
    // the index is under the signature: changing it breaks the check
    expect(await verifyOwnerFrame({ ...signed, choice: 0 }, key.publicJwk)).toBe(false)
  })

  it.each([-1, 6, 1.5, '1', null])('refuses choice %s', (choice) => {
    expect(parseFrame({ ...base, choice }).ok).toBe(false)
  })

  it('is still strict: an unknown key is refused', () => {
    expect(parseFrame({ ...base, choice: 0, extra: true }).ok).toBe(false)
  })
})

describe('card.update says who answered', () => {
  const fx = loadFixtures()
  it('accepts resolution.by and carries it through', () => {
    const f = fx['card.update'] as { resolution: Record<string, unknown> }
    const r = parseFrame({ ...f, resolution: { ...f.resolution, by: "Alex's iPhone" } })
    expect(r.ok).toBe(true)
    if (r.ok && r.frame.type === 'card.update') expect(r.frame.resolution?.by).toBe("Alex's iPhone")
  })
  it('reads an older update (no `by`) and a bad `by` as no device', () => {
    const f = fx['card.update'] as { resolution: Record<string, unknown> }
    for (const by of [undefined, 7, 'x'.repeat(61)]) {
      const r = parseFrame({ ...f, resolution: { ...f.resolution, ...(by === undefined ? {} : { by }) } })
      expect(r.ok).toBe(true)
      if (r.ok && r.frame.type === 'card.update') expect(r.frame.resolution?.by).toBeUndefined()
    }
  })
})

describe('workers.json carries the dialog', () => {
  const file = (dialog?: unknown) =>
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: iso(NOW), workers_supported: true },
      threads: {
        work: {
          state: 'live',
          tmux: 't-work',
          cwd: '/home/alex/work',
          ...(dialog === undefined ? {} : { dialog }),
        },
      },
    })

  it('reads a dialog, and an entry without one', () => {
    expect(parseWorkersFile(file(trust()))?.threads.work?.dialog).toMatchObject({
      id: 'k3Xv9QpT2mLw8ZrNa5HdBe',
      kind: 'trust',
    })
    expect(parseWorkersFile(file())?.threads.work?.dialog).toBeUndefined()
  })

  it('reads a dialog that does not fit as none, and keeps the whole file', () => {
    for (const bad of [
      { ...trust(), options: Array.from({ length: 7 }, (_, i) => `o${i}`) },
      { ...trust(), kind: 'bypass' },
      { ...trust(), id: 'has space' },
      { ...trust(), expires_at: 'soon' },
      { ...trust(), kind: 'login' },
      'junk',
    ]) {
      const parsed = parseWorkersFile(file(bad))
      expect(parsed).not.toBeNull()
      expect(parsed?.threads.work?.dialog).toBeUndefined()
      expect(parsed?.threads.work?.state).toBe('live')
    }
  })

  it('WorkerDialog wants a cursor in range or null', () => {
    expect(WorkerDialog.safeParse({ ...trust(), cursor: null }).success).toBe(true)
    expect(WorkerDialog.safeParse({ ...trust(), cursor: 6 }).success).toBe(false)
  })
})

describe('the files between the Mac and the bridge', () => {
  const at = iso(NOW)
  const proof = {
    signed: '{"type":"card.resolve"}',
    osig: 'A'.repeat(86),
    device_id: 'd_rjxnk4xufxem5xago5zd',
    binding: '{"kind":"dialog"}',
  }
  const answer = {
    v: 2,
    dialog_id: 'k3Xv9QpT2mLw8ZrNa5HdBe',
    choice: 1,
    label: 'Yes, I trust this folder',
    by: "Alex's iPhone",
    at,
    control_id: 'dc_1',
    proof,
  }

  it('names them', () => {
    expect(WORKER_FILES).toMatchObject({
      dialogCard: 'dialog-card.json',
      dialogAnswer: 'dialog-answer.json',
      dialogResult: 'dialog-result.json',
    })
    expect(DIALOG_CARD_WAIT_MS).toBe(15_000)
  })

  it('answer: strict, and exactly one of choice and open', () => {
    expect(DialogAnswer.safeParse(answer).success).toBe(true)
    const { choice: _c, ...noChoice } = answer
    expect(DialogAnswer.safeParse({ ...noChoice, action: 'open' }).success).toBe(true)
    expect(DialogAnswer.safeParse(noChoice).success).toBe(false)
    expect(DialogAnswer.safeParse({ ...answer, action: 'open' }).success).toBe(false)
    expect(DialogAnswer.safeParse({ ...answer, extra: 1 }).success).toBe(false)
    expect(DialogAnswer.safeParse({ ...answer, control_id: 'has space' }).success).toBe(false)
    expect(DialogAnswer.safeParse({ ...answer, control_id: 'x'.repeat(65) }).success).toBe(false)
    expect(DialogAnswer.safeParse({ ...answer, choice: 6 }).success).toBe(false)
    expect(DialogAnswer.safeParse({ ...answer, by: '' }).success).toBe(false)
  })

  it('answer: version 2 with a proof, nothing less', () => {
    expect(DialogAnswer.safeParse({ ...answer, v: 1 }).success).toBe(false)
    const { proof: _p, ...none } = answer
    expect(DialogAnswer.safeParse(none).success).toBe(false)
    expect(DialogAnswer.safeParse({ ...answer, proof: { ...proof, extra: 1 } }).success).toBe(false)
    expect(DialogAnswer.safeParse({ ...answer, proof: { ...proof, osig: 'short' } }).success).toBe(false)
    expect(DialogAnswer.safeParse({ ...answer, proof: { ...proof, device_id: 'nope' } }).success).toBe(false)
  })

  it('ids are at least 22 characters of base64url (128 bits from the Mac)', () => {
    for (const id of ['dlg_1', 'a'.repeat(21), 'has space padded to twenty-two', 'x'.repeat(65)])
      expect(DialogAnswer.safeParse({ ...answer, dialog_id: id }).success, id).toBe(false)
    expect(DialogAnswer.safeParse({ ...answer, dialog_id: 'a'.repeat(22) }).success).toBe(true)
    expect(DialogAnswer.safeParse({ ...answer, dialog_id: 'f'.repeat(32) }).success).toBe(true)
  })

  it('result: strict, one of three outcomes, from the card or the Mac popup', () => {
    const r = {
      v: 1,
      dialog_id: 'k3Xv9QpT2mLw8ZrNa5HdBe',
      control_id: 'dc_1',
      source: 'card',
      outcome: 'pressed',
      choice: 1,
      label: 'Yes',
      at,
    }
    expect(DialogResult.safeParse(r).success).toBe(true)
    expect(
      DialogResult.safeParse({
        ...r,
        outcome: 'nothing_pressed',
        choice: undefined,
        label: undefined,
        reason: 'unverified',
      }).success,
    ).toBe(true)
    expect(
      DialogResult.safeParse({ ...r, outcome: 'nothing_pressed', choice: undefined, label: undefined }).success,
    ).toBe(true)
    expect(DialogResult.safeParse({ ...r, outcome: 'opened', choice: undefined, label: undefined }).success).toBe(true)
    expect(DialogResult.safeParse({ ...r, outcome: 'maybe' }).success).toBe(false)
    expect(DialogResult.safeParse({ ...r, extra: 1 }).success).toBe(false)
    expect(DialogResult.safeParse({ ...r, reason: 'unverified' }).success).toBe(false) // only nothing_pressed has a reason
    expect(DialogResult.safeParse({ ...r, reason: 'because', outcome: 'nothing_pressed' }).success).toBe(false)
    expect(DialogResult.safeParse({ ...r, label: undefined }).success).toBe(false) // a press names the option
    const { control_id: _c, ...noId } = r
    expect(DialogResult.safeParse(noId).success).toBe(false) // a card result names its answer
    // the popup: no control_id, and it is a press or an open, never "nothing pressed"
    expect(DialogResult.safeParse({ ...noId, source: 'mac' }).success).toBe(true)
    expect(
      DialogResult.safeParse({
        ...noId,
        source: 'mac',
        outcome: 'nothing_pressed',
        choice: undefined,
        label: undefined,
      }).success,
    ).toBe(false)
  })

  it('card file: names the card and the state, waiting by default', () => {
    const f = DialogCardFile.parse({ v: 1, dialog_id: 'k3Xv9QpT2mLw8ZrNa5HdBe', card_id: `c_${'0'.repeat(26)}`, at })
    expect(f.status).toBe('waiting')
    expect(DialogCardFile.safeParse({ v: 1, dialog_id: 'k3Xv9QpT2mLw8ZrNa5HdBe', card_id: 'nope', at }).success).toBe(
      false,
    )
  })

  it('fresh means within 5 minutes back and 60 seconds ahead', () => {
    expect(dialogFileFresh(iso(NOW - 299_000), NOW)).toBe(true)
    expect(dialogFileFresh(iso(NOW - 301_000), NOW)).toBe(false)
    expect(dialogFileFresh(iso(NOW + 59_000), NOW)).toBe(true)
    expect(dialogFileFresh(iso(NOW + 61_000), NOW)).toBe(false)
    expect(dialogFileFresh('nope', NOW)).toBe(false)
  })
})

describe('the fixtures the Mac side is built against', () => {
  it('workers.json with a dialog on each of the three kinds parses whole', () => {
    const w = parseWorkersFile(fixture('workers-with-dialog.json'))
    expect(w?.threads.trip?.dialog).toMatchObject({ kind: 'trust', subject: '/home/alex/trip', cursor: 1 })
    expect(w?.threads.garden?.dialog?.options).toHaveLength(3)
    expect(w?.threads.inbox2?.dialog).toMatchObject({ kind: 'login', subject: null, options: [], cursor: null })
    for (const t of Object.values(w?.threads ?? {}))
      expect(Date.parse(t.dialog?.expires_at ?? '') - Date.parse(t.dialog?.seen_at ?? '')).toBe(DIALOG_TTL_S * 1000)
  })
  it.each([
    ['dialog-card.json', DialogCardFile],
    ['dialog-card-answered.json', DialogCardFile],
    ['dialog-answer.json', DialogAnswer],
    ['dialog-answer-open.json', DialogAnswer],
    ['dialog-result.json', DialogResult],
    ['dialog-result-nothing-pressed.json', DialogResult],
    ['dialog-result-unverified.json', DialogResult],
    ['dialog-result-already-answered.json', DialogResult],
    ['dialog-result-opened.json', DialogResult],
    ['dialog-result-mac-popup.json', DialogResult],
  ])('%s parses', (name, schema) => {
    expect(schema.safeParse(JSON.parse(fixture(name))).success, name).toBe(true)
  })
  it('every fixture is small enough to be read', () => {
    for (const n of ['workers-with-dialog.json', 'dialog-answer.json', 'dialog-result.json'])
      expect(Buffer.byteLength(fixture(n))).toBeLessThanOrEqual(
        n.startsWith('workers') ? 64 * 1024 : n.includes('answer') ? DIALOG_ANSWER_MAX_BYTES : DIALOG_FILE_MAX_BYTES,
      )
  })
})

describe('one wording on every surface', () => {
  const table = DIALOG_WORDING
  const kinds = ['trust', 'mcp_consent', 'login'] as const

  it('is the committed table the Mac popup is tested against', () => {
    expect(JSON.parse(fixture('wording.json'))).toEqual({ v: 1, ...table })
  })

  it('has the phone notice for Main waiting at the Mac, which needs no bridge to show', () => {
    expect((table as { phone?: { devChannelsWaiting?: string } }).phone?.devChannelsWaiting).toBe(
      'Main is waiting at your Mac: answer the Talos popup there.',
    )
  })

  it('names the thread with {thread}, says "sign in" and never "log in"', () => {
    expect(table.title.login).toBe('{thread} needs you to sign in')
    expect(table.title.trust).toBe('Trust this folder?')
    expect(table.title.mcp_consent).toBe('Allow this MCP server?')
    expect(JSON.stringify(table)).not.toMatch(/log in/i)
    for (const k of kinds) expect(table.sentence[k].length).toBeGreaterThan(20)
    expect(table.footer.popup).toBe('Also on your phone. Answer either one.')
  })

  it.each(kinds)('%s: the card says exactly what the table says', (k) => {
    const d = k === 'trust' ? trust() : k === 'mcp_consent' ? mcp() : login()
    const c = compose(d)
    expect(c.title).toBe(table.title[k].replaceAll('{thread}', 'Work'))
    expect(c.body).toBe(table.sentence[k].replaceAll('{thread}', 'Work'))
  })

  it('a login title with the longest thread name, hidden characters shown, still fits a card title', () => {
    const c = composeDialogCard({
      card_id: newId('c'),
      dialog: login(),
      thread_id: 'work',
      thread_name: 'W'.repeat(80),
      now: NOW,
    }) as CardT
    expect(Card.safeParse(c).success).toBe(true)
    expect(c.title).toBe(`${'W'.repeat(60)}\u2026 needs you to sign in`)
    expect(dialogTitle('login', '\u200b'.repeat(80)).length).toBeLessThanOrEqual(120)
  })
})

describe('the shared table of hidden-character cases', () => {
  it('is the committed table the Mac port is tested against', () => {
    expect(JSON.parse(fixture('visible-text.json'))).toEqual({ v: 1, cases: VISIBLE_TEXT_CASES })
  })

  it.each(VISIBLE_TEXT_CASES.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    expect(dialogVisibleText(c.input)).toBe(c.expected)
  })
})

// ---- Main's development-channels dialog (the `dev_channels` kind) ----
const devDialog = (over: Partial<WorkerDialogT> = {}): WorkerDialogT =>
  trust({
    id: 'Dv5Qm8ZtRx3Cw9PkNa2HdB',
    kind: 'dev_channels',
    subject: 'server:talos-app',
    options: ['I am using this for local development', 'Exit'],
    cursor: 0,
    ...over,
  })

describe('the dev_channels dialog card', () => {
  it('is a whole, valid card with the exact screen buttons under the table heading', () => {
    const card = compose(devDialog())
    expect(Card.safeParse(card).success).toBe(true)
    expect(validateCard(card)).toEqual([])
    expect(card.title).toBe("Allow Talos's development channel?")
    expect(card.body).toBe("Main session's start needs this to talk to the Talos app.")
    expect(dialogOf(card)).toMatchObject({
      dialog_kind: 'dev_channels',
      subject: 'server:talos-app',
      options: ['I am using this for local development', 'Exit'],
    })
    expect(card.title).toBe(DIALOG_WORDING.title.dev_channels)
    expect(card.body).toBe(DIALOG_WORDING.sentence.dev_channels)
  })

  it('names any channel Talos did not add, plainly', () => {
    const card = compose(devDialog({ subject: 'server:talos-app, server:other-thing' }))
    expect(card.body).toContain("Also loads server:other-thing, which Talos didn't add.")
    expect(card.body).not.toContain('Also loads server:talos-app')
    expect(compose(devDialog({ subject: null })).body).toBe(DIALOG_WORDING.sentence.dev_channels)
  })

  it('launchChanged adds one plain line, with what changed at the level the fingerprint knows', () => {
    const plain = compose(devDialog({ launch_changed: [] })).body
    expect(plain).toContain("Main's start command isn't confirmed on this Mac yet.")
    const card = compose(devDialog({ launch_changed: ['program', 'env'] }))
    expect(card.body).toContain("Main's start command changed since you last confirmed it. Changed: program, env.")
    expect(dialogOf(card)?.launch_changed).toEqual(['program', 'env'])
    // bound: the line is covered by payload_hash
    expect(card.payload_hash).not.toBe(compose(devDialog()).payload_hash)
  })

  it('a launch_changed list holds only the fingerprint pieces, never a value', () => {
    expect(WorkerDialog.safeParse(devDialog({ launch_changed: ['flags'] })).success).toBe(true)
    expect(WorkerDialog.safeParse({ ...devDialog(), launch_changed: ['--token=abc'] }).success).toBe(false)
  })

  it('has options (it is not a login)', () => {
    expect(WorkerDialog.safeParse(devDialog({ options: [] })).success).toBe(false)
  })

  it('the Mac fallback line says "sign in", never "log in"', () => {
    expect(dialogFallbackLine('login', 'Work')).toContain("'sign in'")
    expect(dialogFallbackLine('dev_channels', 'Work')).toContain("'allow the development channel'")
  })

  it('answers with the label as the screen showed it', () => {
    expect(dialogAnswerText('dev_channels', 'server:talos-app', 'Exit')).toBe('Exit')
  })
})

describe('workers.json carries Main’s dialog', () => {
  const base = {
    v: 1,
    supervisor: { pid: 1, heartbeat_at: iso(NOW), workers_supported: true, main_pane_pid: 2 },
    threads: {},
  }
  it('the committed fixture parses, and its card names the extra channel and the changed pieces', () => {
    const f = parseWorkersFile(fixture('workers-with-main-dialog.json'))
    const d = f?.supervisor.main_dialog
    expect(d?.launch_changed).toEqual(['program', 'env'])
    const body = compose(d as WorkerDialogT).body
    expect(body).toContain("Also loads server:other-thing, which Talos didn't add.")
    expect(body).toContain('Changed: program, env.')
  })
  it('reads supervisor.main_dialog', () => {
    const f = parseWorkersFile(
      JSON.stringify({ ...base, supervisor: { ...base.supervisor, main_dialog: devDialog() } }),
    )
    expect(f?.supervisor.main_dialog?.kind).toBe('dev_channels')
  })
  it('a main_dialog that does not fit reads as none, not as a broken file', () => {
    const f = parseWorkersFile(JSON.stringify({ ...base, supervisor: { ...base.supervisor, main_dialog: { id: 1 } } }))
    expect(f).not.toBeNull()
    expect(f?.supervisor.main_dialog).toBeUndefined()
  })
})

describe("Main's own answer file", () => {
  it('has a name of its own, apart from a worker on the default thread', () => {
    expect(WORKER_FILES.mainDialogAnswer).toBe('main-dialog-answer.json')
    expect(WORKER_FILES.mainDialogAnswer).not.toBe(WORKER_FILES.dialogAnswer)
  })
})
