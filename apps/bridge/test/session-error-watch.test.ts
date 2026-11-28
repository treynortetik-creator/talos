// A thread session whose turn ended on an API error or a refusal is found in its transcript (never on the screen), once, and only when
// the turn really ended there. The fixtures in test/fixtures/transcripts are REAL Claude Code records with every string value replaced
// by a placeholder (keys, kinds and order kept): auth-failed (a signed-out session), usage-limit (a 429 plan limit), retries-recovered
// (seven retries of a 503, then the turn went on). refusal.jsonl is Claude Code 2.1.332's own pair for a refusal, from a stripped sample
// of a real session: a `system` record `model_refusal_no_fallback` and the `assistant` record that carries `error: "invalid_request"`.
// Their ids and times are made up; tests that need "recent" records rewrite the time.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { WorkersFileT } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import {
  classify,
  type Episode,
  episodeKey,
  lastConversationRecord,
  readEnd,
  SessionErrorWatch,
  SINCE_SLACK_MS,
} from '../src/router/session-error-watch.ts'
import { transcriptPath } from '../src/router/worker-context.ts'

const FIX = join(import.meta.dir, 'fixtures', 'transcripts')
const fixture = (name: string): string[] =>
  readFileSync(join(FIX, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
const rowOf = (line: string) => JSON.parse(line) as Record<string, unknown>

const SESSION = '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41'
const CWD = '/home/alex/project'
const tmps: string[] = []
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sew-')))
  tmps.push(d)
  return d
}

type Entry = { state?: string; session_id?: string | null; limit_wait?: unknown }
const fileOf = (e: Entry = {}): WorkersFileT =>
  ({
    v: 1,
    supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
    threads: { trip: { state: 'live', session_id: SESSION, cwd: CWD, tmux: 't-trip', ...e } },
  }) as unknown as WorkersFileT

/** A watch over a temp Claude folder; `put` writes the session's transcript with an old mtime (the quiet window has passed). */
function setup(opts: { sinceMs?: number; quietMs?: number; ended?: boolean; dedicated?: boolean } = {}) {
  const claude = tmp()
  const path = transcriptPath(claude, CWD, SESSION)
  const raised: Episode[] = []
  const seen = new Set<string>()
  const warns: string[] = []
  const watch = new SessionErrorWatch({
    claudeDir: () => claude,
    now: () => Date.now(),
    sinceMs: opts.sinceMs ?? 0,
    ...(opts.quietMs !== undefined ? { quietMs: opts.quietMs } : {}),
    seen: (k) => seen.has(k),
    mark: (k) => void seen.add(k),
    ownerEndedSince: () => opts.ended === true,
    raise: async (e) => void raised.push(e),
    warn: (m) => void warns.push(m),
  })
  const put = (lines: string[], ageMs = 60_000) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${lines.join('\n')}\n`)
    const t = new Date(Date.now() - ageMs)
    utimesSync(path, t, t)
  }
  const dedicated = () => opts.dedicated !== false
  return { claude, path, raised, seen, warns, watch, put, dedicated }
}

/** The real signed-out record, and variants of it with other fields (a record of the same shape, another kind). */
const authError = () => fixture('auth-failed').at(-1) as string
const variant = (base: string, patch: (r: Record<string, unknown>) => void) => {
  const r = rowOf(base)
  patch(r)
  return JSON.stringify(r)
}
const rateLimit = () =>
  variant(fixture('usage-limit')[0] as string, (r) => {
    r.apiError = undefined
    r.quotaLimits = undefined
    r.uuid = '00000000-0000-4000-8000-0000000000aa'
  })
const user = (text = 'hello') =>
  JSON.stringify({
    type: 'user',
    uuid: '00000000-0000-4000-8000-0000000000bb',
    message: { role: 'user', content: text },
  })

describe('what counts as a turn that ended on an error', () => {
  test('a real signed-out record: one episode of kind auth', () => {
    const s = setup()
    s.put(fixture('auth-failed'))
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(1)
    expect(s.raised[0]).toMatchObject({ thread: 'trip', session: SESSION, found: { kind: 'auth' } })
  })

  test('a rate limit that is no plan limit (a 429): kind rate', () => {
    const s = setup()
    s.put([user(), rateLimit()])
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised.map((e) => e.found.kind)).toEqual(['rate'])
  })

  test('the kinds: servers, too big, billing, model not found, reply too long, unknown', () => {
    const base = rateLimit()
    const kind = (patch: (r: Record<string, unknown>) => void) => {
      const c = classify(rowOf(variant(base, patch)))
      return c === 'skip' || c === undefined ? c : `${c.kind}${c.what ? `:${c.what}` : ''}`
    }
    expect(kind((r) => void Object.assign(r, { error: 'server_error' }))).toBe('servers')
    expect(
      kind((r) => void Object.assign(r, { error: 'invalid_request', errorDetails: 'prompt is too long: 250000' })),
    ).toBe('too_big')
    expect(kind((r) => void Object.assign(r, { error: 'invalid_request', apiError: 'pdf_too_large' }))).toBe('too_big')
    expect(kind((r) => void Object.assign(r, { error: 'invalid_request' }))).toBe('other:unknown')
    expect(kind((r) => void Object.assign(r, { error: 'billing_error' }))).toBe('other:billing')
    expect(kind((r) => void Object.assign(r, { error: 'model_not_found' }))).toBe('other:model not found')
    expect(kind((r) => void Object.assign(r, { error: 'max_output_tokens' }))).toBe('other:reply too long')
    expect(kind((r) => void Object.assign(r, { error: 'something_new' }))).toBe('other:unknown')
  })

  test('the record text is never used: an error whose text says "too long" but whose fields say server_error is servers', () => {
    const r = rowOf(variant(rateLimit(), (x) => void Object.assign(x, { error: 'server_error' })))
    ;(r.message as { content: { text: string }[] }).content = [{ text: 'prompt is too long' }]
    expect(classify(r)).toMatchObject({ kind: 'servers' })
  })

  test('REFUSAL: stop_reason refusal with error invalid_request gets the refusal kind and category bio, not too big or other', () => {
    const [sys, asst] = fixture('refusal') as [string, string]
    const row = rowOf(asst)
    expect(row.error).toBe('invalid_request') // the real record carries it: the refusal must be decided FIRST
    expect(classify(row)).toEqual({ kind: 'refusal', refusal: 'biology' })
    // even with details that would read as "too big" if it were an ordinary invalid_request
    expect(
      classify(rowOf(variant(asst, (r) => void Object.assign(r, { errorDetails: 'prompt is too long' })))),
    ).toEqual({
      kind: 'refusal',
      refusal: 'biology',
    })
    const s = setup()
    s.put([user(), sys, asst])
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(1)
    expect(s.raised[0]?.found).toMatchObject({ kind: 'refusal', refusal: 'biology', uuid: rowOf(asst).uuid })
  })

  test('refusal categories: cyber, another named one and none; and the system record alone starts nothing', () => {
    const asst = fixture('refusal')[1] as string
    const cat = (c: unknown) =>
      classify(
        rowOf(
          variant(
            asst,
            (r) =>
              void Object.assign(r.message as Record<string, unknown>, {
                stop_details: { type: 'refusal', category: c },
              }),
          ),
        ),
      )
    expect(cat('cyber')).toEqual({ kind: 'refusal', refusal: 'cybersecurity' })
    expect(cat('frontier_llm')).toEqual({ kind: 'refusal', refusal: 'other' })
    expect(cat(null)).toEqual({ kind: 'refusal', refusal: 'other' })
    const s = setup()
    s.put([user(), fixture('refusal')[0] as string]) // the pair's first half only
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(0)
  })

  test('a refusal pair is ONE episode, keyed by the assistant record, however often it is looked at', () => {
    const s = setup()
    s.put(fixture('refusal'))
    for (let i = 0; i < 3; i++) s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(1)
  })

  test('a usage limit (a plan limit) is skipped and remembered: another path owns it', () => {
    const s = setup()
    s.put(fixture('usage-limit').slice(0, 3)) // the error, then the queue records Claude Code writes after it
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(0)
    expect(s.seen.size).toBe(1)
  })

  test("Claude Code's own wait at a limit (limit_wait set): nothing", () => {
    const s = setup()
    s.put(fixture('auth-failed'))
    s.watch.tick(fileOf({ limit_wait: { at: new Date().toISOString() } }), s.dedicated)
    expect(s.raised).toHaveLength(0)
  })
})

describe('records from a REAL claude 2.1.322 run against a local stub server (no real API)', () => {
  // real-run-*.jsonl: `claude -p` with a temp HOME and config folder, ANTHROPIC_BASE_URL on 127.0.0.1 and a stub that answered 400 (prompt too
  // long) or 529 (overloaded, one retry allowed); strings replaced as in the other fixtures, but the stub's own error text is kept.
  test('a 400 "prompt is too long": kind too big (errorDetails and the status are persisted by 2.1.322)', () => {
    const rows = fixture('real-run-too-big').map(rowOf)
    const err = rows.find((r) => r.isApiErrorMessage === true) as Record<string, unknown>
    expect(err.apiErrorStatus).toBe(400)
    expect(classify(err)).toEqual({ kind: 'too_big' })
    const s = setup()
    s.put(fixture('real-run-too-big'))
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised.map((e) => e.found.kind)).toEqual(['too_big'])
  })

  test('a 529 with one retry: the retry record is ignored, the final record is kind servers, and a last-prompt record after it does not hide it', () => {
    const rows = fixture('real-run-overloaded').map(rowOf)
    expect(rows.some((r) => r.type === 'system' && r.subtype === 'api_error')).toBe(true)
    expect(rows.at(-1)?.type).toBe('last-prompt')
    const s = setup()
    s.put(fixture('real-run-overloaded'))
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised.map((e) => e.found.kind)).toEqual(['servers'])
    // only the retry and what came before it: nothing yet
    const s2 = setup()
    s2.put(fixture('real-run-overloaded').slice(0, 4))
    s2.watch.tick(fileOf(), s2.dedicated)
    expect(s2.raised).toHaveLength(0)
  })
})

describe('what is NOT noticed', () => {
  test('retries that recovered: only system api_error records, then the turn went on', () => {
    const s = setup()
    s.put(fixture('retries-recovered'))
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(0)
  })

  test('retries and then the final error: one episode', () => {
    const s = setup()
    s.put([...fixture('retries-recovered').slice(0, 7), authError()])
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(1)
  })

  test('an error that something followed (the owner typed again, or a normal reply): nothing', () => {
    const s = setup()
    s.put([...fixture('auth-failed'), user('try again')])
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(0)
  })

  test('an error still inside the quiet window: nothing yet; once it has passed: one', () => {
    const s = setup({ quietMs: 8_000 })
    s.put(fixture('auth-failed'), 1_000)
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(0)
    const t = new Date(Date.now() - 20_000)
    utimesSync(s.path, t, t)
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(1)
  })

  test("the owner's Esc, and a turn cut off at a tool call: nothing", () => {
    const esc = user('[Request interrupted by user]')
    const toolUse = JSON.stringify({
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-0000000000cc',
      message: {
        model: 'claude-x',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
      },
    })
    for (const last of [esc, toolUse]) {
      const s = setup()
      s.put([...fixture('auth-failed').slice(0, 2), last])
      s.watch.tick(fileOf(), s.dedicated)
      expect(s.raised).toHaveLength(0)
    }
  })

  test('a refusal a fallback model took over: a system record and no error record: nothing', () => {
    const s = setup()
    const sys = variant(fixture('refusal')[0] as string, (r) => void Object.assign(r, { subtype: 'model_fallback' }))
    s.put([
      user(),
      sys,
      JSON.stringify({
        type: 'assistant',
        uuid: '00000000-0000-4000-8000-0000000000dd',
        message: { model: 'claude-x', stop_reason: 'end_turn', content: [] },
      }),
    ])
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(0)
  })

  test('a sidechain error record, a session that is not dedicated, one that is busy or has no session: nothing', () => {
    const side = variant(authError(), (r) => void Object.assign(r, { isSidechain: true }))
    const a = setup()
    a.put([user(), side])
    a.watch.tick(fileOf(), a.dedicated)
    const b = setup({ dedicated: false })
    b.put(fixture('auth-failed'))
    b.watch.tick(fileOf(), b.dedicated)
    const c = setup()
    c.put(fixture('auth-failed'))
    c.watch.tick(fileOf({ state: 'busy' }), c.dedicated)
    c.watch.tick(fileOf({ state: 'parked' }), c.dedicated)
    c.watch.tick(fileOf({ session_id: null }), c.dedicated)
    expect([a, b, c].map((s) => s.raised.length)).toEqual([0, 0, 0])
  })

  test("an error older than the watch's own slack (the one the router uses) is history: remembered, never announced; a younger one is announced", () => {
    const at = (agoMs: number) => (r: Record<string, unknown>) =>
      void Object.assign(r, { timestamp: new Date(Date.now() - agoMs).toISOString() })
    const old = setup({ sinceMs: Date.now() - SINCE_SLACK_MS })
    old.put(fixture('auth-failed').map((l) => variant(l, at(SINCE_SLACK_MS + 60_000))))
    old.watch.tick(fileOf(), old.dedicated)
    expect(old.raised).toHaveLength(0)
    expect(old.seen.size).toBe(1)
    const young = setup({ sinceMs: Date.now() - SINCE_SLACK_MS })
    young.put(fixture('auth-failed').map((l) => variant(l, at(30 * 60_000))))
    young.watch.tick(fileOf(), young.dedicated)
    expect(young.raised).toHaveLength(1)
  })

  test('an error the owner already moved past (they ended the turn by hand): nothing', () => {
    const s = setup({ ended: true })
    s.put(fixture('auth-failed'))
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(0)
  })
})

describe('once, and across restarts', () => {
  test('the same record is offered once however often it is looked at, and not again by a new watch with the same memory', () => {
    const s = setup()
    s.put(fixture('auth-failed'))
    s.watch.tick(fileOf(), s.dedicated)
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(1)
    const uuid = s.raised[0]?.found.uuid as string
    expect(s.seen.has(episodeKey('trip', uuid))).toBe(true)
    const again: Episode[] = []
    const restarted = new SessionErrorWatch({
      claudeDir: () => s.claude,
      now: () => Date.now(),
      sinceMs: 0,
      seen: (k) => s.seen.has(k),
      mark: (k) => void s.seen.add(k),
      ownerEndedSince: () => false,
      raise: async (e) => void again.push(e),
    })
    restarted.tick(fileOf(), s.dedicated)
    expect(again).toHaveLength(0)
  })

  test('a new error record after the first is a new episode', () => {
    const s = setup()
    s.put(fixture('auth-failed'))
    s.watch.tick(fileOf(), s.dedicated)
    appendFileSync(
      s.path,
      `${user('again')}\n${variant(authError(), (r) => void Object.assign(r, { uuid: '00000000-0000-4000-8000-0000000000ee' }))}\n`,
    )
    const t = new Date(Date.now() - 60_000)
    utimesSync(s.path, t, t)
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(2)
  })

  test('records that are not conversation (queue, prompt, request records) after the error do not hide it', () => {
    const s = setup()
    s.put([
      ...fixture('auth-failed'),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'x' }),
      JSON.stringify({ type: 'api-request', n: 1 }),
    ])
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(1)
  })

  test('a transcript in another project folder is found by its session id', () => {
    const s = setup()
    const other = join(s.claude, 'projects', 'a-long-folder-name', `${SESSION}.jsonl`)
    mkdirSync(dirname(other), { recursive: true })
    writeFileSync(other, `${fixture('auth-failed').join('\n')}\n`)
    const t = new Date(Date.now() - 60_000)
    utimesSync(other, t, t)
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(1)
  })
})

describe('the reader is safe', () => {
  test('a link at the transcript path is not read', () => {
    const s = setup()
    const real = join(tmp(), 'real.jsonl')
    writeFileSync(real, `${fixture('auth-failed').join('\n')}\n`)
    mkdirSync(dirname(s.path), { recursive: true })
    symlinkSync(real, s.path)
    expect(readEnd(s.path, 1024)).toBeUndefined()
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(0)
  })

  const hasMkfifo = Bun.spawnSync(['sh', '-c', 'command -v mkfifo']).exitCode === 0
  // skip: only when this machine has no mkfifo, so no FIFO can be made to test with (the name says so)
  test.skipIf(!hasMkfifo)(
    'a FIFO where the transcript should be is not waited on (SKIPPED here: no mkfifo on this machine)',
    () => {
      const s = setup()
      mkdirSync(dirname(s.path), { recursive: true })
      expect(Bun.spawnSync(['mkfifo', s.path]).exitCode).toBe(0)
      const t0 = Date.now()
      s.watch.tick(fileOf(), s.dedicated)
      expect(Date.now() - t0).toBeLessThan(t(2_000))
      expect(s.raised).toHaveLength(0)
    },
  )

  test('no transcript yet, an empty one and a half-written last line: nothing, and nothing throws', () => {
    const s = setup()
    s.watch.tick(fileOf(), s.dedicated)
    s.put([])
    s.watch.tick(fileOf(), s.dedicated)
    s.put([...fixture('auth-failed').slice(0, 2)])
    appendFileSync(s.path, authError().slice(0, 60)) // cut in the middle of the record
    const t = new Date(Date.now() - 60_000)
    utimesSync(s.path, t, t)
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(0)
  })

  test('only the end of a big file is read, and a line over the read size is skipped, not held', () => {
    const lines = [user(), authError()]
    const s = setup()
    s.put([`{"type":"user","pad":"${'x'.repeat(5 * 1024 * 1024)}"}`, ...lines])
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(1)
    const r = readEnd(s.path, 1024)
    expect(r?.whole).toBe(false)
    expect(r?.lines.every((l) => l.length <= 1024)).toBe(true)
  })

  test('a file cut shorter is read again from its new end', () => {
    const s = setup()
    s.put([
      ...fixture('auth-failed').slice(0, 2),
      user('later'),
      user('a much longer file than the one that follows'),
      user('x'.repeat(2000)),
    ])
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(0)
    s.put(fixture('auth-failed')) // shorter than before
    s.watch.tick(fileOf(), s.dedicated)
    expect(s.raised).toHaveLength(1)
  })

  test('lastConversationRecord skips every other record kind and sidechain records', () => {
    expect(
      lastConversationRecord([
        user('a'),
        '{"type":"attachment"}',
        'not json',
        '{"type":"assistant","isSidechain":true}',
      ]),
    ).toMatchObject({ type: 'user' })
    expect(lastConversationRecord([])).toBeUndefined()
  })
})
