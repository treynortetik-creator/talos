#!/usr/bin/env bun
// The capture step (docs/SCHEDULES.md S9, WP-S1, N4): `bun run capture:schedules [--check]`.
//
// It runs the REAL bridge (live, in process, on an injected clock) against the REAL vendored Chronos CLI
// (third_party/chronos, v0.5.0) in a temp HOME, with testkit's FakeRelay and FakeApp as the far ends and a scripted
// stand-in for the Claude session, drives the flow of S9 and writes every frame that crosses the bridge socket, plus every
// channel notification and agent tool call, as JSON in packages/testkit/fixtures/captured/ with ids, timestamps,
// signatures and the machine name normalized (and every card hash recomputed, so a captured card still verifies).
//
// WP-S2 and WP-S3 merge only against these files. `--check` re-runs the capture and fails if the output differs from what
// is committed, so a bridge change that alters traffic has to re-record the fixtures in the same PR.
//
// Along the way it asserts, for every `card.create` the bridge sent, that it equals composeScheduleCard() of the same inputs
// (S9 N4), with the inputs read straight from the Chronos CLI rather than from the bridge.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bindingFrom,
  type CardT,
  ChronosDetail,
  composeScheduleCard,
  jcs,
  newUlid,
  parseFrame,
  payloadHash,
  ScheduleCardPayload,
  type ScheduleChangeT,
  scheduleFromChronos,
} from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import type { Notification } from '../src/notify.ts'
import { type ChronosBox, draft, REPO } from '../test/schedules/chronos-box.ts'
import { type SchedHarness, sleep, startSched } from '../test/schedules/harness.ts'

export const CAPTURE_DIR = join(REPO, 'packages', 'testkit', 'fixtures', 'captured')
const HERE = dirname(fileURLToPath(import.meta.url))
void HERE

/** Monday 2026-10-05, 07:00 in America/New_York. */
const T0 = '2026-10-05T11:00:00Z'

// ---- recording --------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>
type Step = {
  step: number
  label: string
  /** Owner frames as the bridge received them (signed; `relay` stamps removed). */
  received_by_bridge: Json[]
  /** Frames the bridge sent toward the relay (and so the app). */
  sent_by_bridge: Json[]
  /** `notifications/claude/channel` the bridge sent the agent. */
  channel_notifications: Array<{ content: string; meta: Record<string, string> }>
  /** Agent tool calls made during the step. */
  agent_tool_calls: Array<{ name: string; args: Json; result: string; is_error: boolean }>
}
type Scenario = { scenario: string; title: string; steps: Step[] }

/** Frame types that belong to a Schedules capture; ack/error only when they answer one of those frames. */
const FAMILY = new Set([
  'schedules.list',
  'schedules.snapshot',
  'schedule.get',
  'schedule.detail',
  'schedule.patch',
  'schedule.run_now',
  'schedule.control',
  'schedule.status',
  'card.create',
  'card.update',
  'card.resolve',
])

class Recorder {
  readonly steps: Step[] = []
  /** Failed self-checks (N4), reported when the flow ends. */
  readonly problems: string[] = []
  private relayAt = 0
  private noteAt = 0
  private toolsLog: Step['agent_tool_calls'] = []
  private refs = new Set<string>()
  /** Chronos's clock for this scenario; the bridge's timers follow the injected clock, Chronos follows this. */
  now = T0

  constructor(
    readonly h: SchedHarness,
    readonly scenario: string,
    readonly title: string,
  ) {
    this.relayAt = h.relay.frames.length
    // Notes from BEFORE the recorder existed count too: startSched waits for the loops to arm, and a job already due at
    // arming (13's missed-job) is offered during that wait. The relay cursor stays put: the arming frames are not the capture's.
    this.noteAt = 0
  }

  /** Runs one stimulus, waits for quiescence, records everything that crossed the bridge since. */
  async step(label: string, fn: () => Promise<unknown>, opts: { restamp?: boolean } = {}) {
    this.toolsLog = []
    await fn()
    await this.settle()
    this.cut(label, opts.restamp ?? false)
  }

  /** Setup that is not part of the capture (the cursors move past it). */
  async quiet(fn: () => Promise<unknown>) {
    this.toolsLog = []
    await fn()
    await this.settle()
    this.relayAt = this.h.relay.frames.length
    this.noteAt = this.h.notes.length
    this.toolsLog = []
  }

  /** The agent's tool call, recorded. */
  async tool(name: string, args: Json) {
    const r = await this.h.bridge.callTool(name, args)
    this.toolsLog.push({ name, args, result: r.content[0]?.text ?? '', is_error: Boolean(r.isError) })
    return r
  }

  /** Moves the bridge's timers by `ms` (in steps the relay's heartbeat tolerates) with Chronos pinned at `chronosNow`. */
  async advance(ms: number, chronosNow: string) {
    this.now = chronosNow
    await this.h.advance(ms, { catchUp: false }) // the capture pins Chronos per step: no extra tick
  }

  async settle() {
    let last = -1
    for (let i = 0; i < 100; i++) {
      await this.h.bridge.ctx.schedules?.idle()
      await sleep(250)
      const n = this.h.relay.frames.length + this.h.notes.length
      if (n === last) return
      last = n
    }
  }

  private cut(label: string, restamp: boolean) {
    const frames = this.h.relay.frames.slice(this.relayAt)
    this.relayAt = this.h.relay.frames.length
    const notes = this.h.notes.slice(this.noteAt)
    this.noteAt = this.h.notes.length
    const received: Json[] = []
    const sent: Json[] = []
    for (const r of frames) {
      const raw = r.raw as Json
      const type = String(raw.type)
      if (r.direction === 'to_bridge' && (FAMILY.has(type) || type === 'schedule.run_now')) {
        received.push(raw)
        if (typeof raw.id === 'string') this.refs.add(raw.id)
      } else if (r.direction === 'from_bridge') {
        const ref = typeof raw.ref === 'string' ? raw.ref : undefined
        if (FAMILY.has(type) || ((type === 'ack' || type === 'error') && ref && this.refs.has(ref))) sent.push(raw)
        else if (type === 'reply' && (raw.message as Json | undefined)?.author === 'system') sent.push(raw)
      }
    }
    const step: Step = {
      step: this.steps.length + 1,
      label,
      received_by_bridge: received,
      sent_by_bridge: sent,
      channel_notifications: notes.map((n: Notification) => ({ content: n.content, meta: n.meta })),
      agent_tool_calls: this.toolsLog,
    }
    if (restamp) (step as Step & { restamp?: string }).restamp = new Date(this.h.clock.now()).toISOString()
    this.steps.push(step)
  }

  result(): Scenario {
    return { scenario: this.scenario, title: this.title, steps: this.steps }
  }
}

// ---- normalization ---------------------------------------------------------------------------------------------

const ID_RE = /\b(?:(?:m|c|r|e|md|v)_)?[0-9A-HJKMNP-TV-Z]{26}\b/g

class Normalizer {
  private ids = new Map<string, string>()
  private revs = new Map<string, string>()
  private n = 0
  constructor(private readonly cardHash: Map<string, string>) {}

  private id(tok: string): string {
    let v = this.ids.get(tok)
    if (!v) {
      const prefix = /^[a-z]+_/.exec(tok)?.[0] ?? ''
      v = `${prefix}${String(++this.n).padStart(26, '0')}`
      this.ids.set(tok, v)
    }
    return v
  }

  /** Object-level rules, then token-level ids. */
  value(x: unknown, key = ''): unknown {
    if (Array.isArray(x)) return x.map((v) => this.value(v, key))
    if (x && typeof x === 'object') {
      const o = x as Json
      const out: Json = {}
      for (const [k, v] of Object.entries(o)) {
        if (k === 'osig' || k === 'sig') out[k] = 'A'.repeat(86)
        else if (k === 'device_id') out[k] = 'd_aaaaaaaaaaaaaaaaaaaa'
        else if (k === 'host_label') out[k] = 'Example Mac'
        else if (k === 'state_rev' && typeof v === 'string') out[k] = this.rev(v)
        else if (k === 'relay')
          continue // the relay's own stamp (seq, received_at): not part of the bridge's traffic
        else out[k] = this.value(v, k)
      }
      return out
    }
    if (typeof x === 'string') return this.str(x, key)
    return x
  }

  private rev(v: string): string {
    let r = this.revs.get(v)
    if (!r) {
      r = `sha256:${String(this.revs.size + 1).padStart(64, '0')}`
      this.revs.set(v, r)
    }
    return r
  }

  private str(s: string, _key: string): string {
    return s.replace(ID_RE, (t) => this.id(t)).replace(/\bd_[a-z2-7]{20}\b/g, 'd_aaaaaaaaaaaaaaaaaaaa')
  }

  /** Card hashes depend on the (renamed) ids: recompute them so the captured card still verifies. */
  fixCards(root: Json) {
    const walk = (x: unknown) => {
      if (Array.isArray(x)) return x.forEach(walk)
      if (!x || typeof x !== 'object') return
      const o = x as Json
      if (o.type === 'card.create' && o.card && typeof o.card === 'object') {
        const card = o.card as CardT
        card.payload_hash = payloadHash(bindingFrom(card))
        this.cardHash.set(card.id, card.payload_hash)
      }
      for (const v of Object.values(o)) walk(v)
    }
    walk(root)
    const patch = (x: unknown) => {
      if (Array.isArray(x)) return x.forEach(patch)
      if (!x || typeof x !== 'object') return
      const o = x as Json
      if (o.type === 'card.resolve' && typeof o.card_id === 'string' && this.cardHash.has(o.card_id))
        o.payload_hash = this.cardHash.get(o.card_id)
      // the resolution a card.update carries names the hash that was approved
      if (o.type === 'card.update' && typeof o.card_id === 'string' && this.cardHash.has(o.card_id) && o.resolution)
        (o.resolution as Json).payload_hash = this.cardHash.get(o.card_id)
      for (const v of Object.values(o)) patch(v)
    }
    patch(root)
  }
}

/** Restamped steps (the bridge's timers fired during them) get one `ts` everywhere, so their order of arrival cannot matter. */
function restamp(s: Scenario) {
  for (const st of s.steps as Array<Step & { restamp?: string }>) {
    if (!st.restamp) continue
    const stamp = st.restamp
    const fix = (x: unknown) => {
      if (Array.isArray(x)) return x.forEach(fix)
      if (!x || typeof x !== 'object') return
      const o = x as Json
      if (typeof o.ts === 'string') o.ts = stamp
      for (const v of Object.values(o)) fix(v)
    }
    fix(st.sent_by_bridge)
    fix(st.channel_notifications)
    // text that names the moment the bridge noticed something ("... changed outside the app at <time>") moves with the race too
    for (const n of st.channel_notifications)
      n.content = n.content.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, stamp)
    delete st.restamp
  }
}

// ---- the card equation (N4) -------------------------------------------------------------------------------------

/** For one captured card.create: compose it again from Chronos's own answers and compare. */
function checkCardEquation(box: ChronosBox, h: SchedHarness, card: CardT, now: string): string | null {
  const parsed = ScheduleCardPayload.safeParse(card.payload)
  if (!parsed.success) return `card ${card.id}: payload does not parse`
  const p = parsed.data
  const change: ScheduleChangeT = p.change
  let base = null as Parameters<typeof composeScheduleCard>[3]['base']
  let approved = null as Parameters<typeof composeScheduleCard>[2]
  if (change.op !== 'create') {
    const raw = box.api(['detail', change.id], undefined, now)
    const d = ChronosDetail.parse(raw)
    const side = existsSync(join(h.home, 'schedules-meta.json'))
      ? (JSON.parse(readFileSync(join(h.home, 'schedules-meta.json'), 'utf8')) as {
          jobs?: Record<string, { thread_id: string | null }>
        })
      : {}
    const schedule = scheduleFromChronos(d.schedule, {
      thread_id: (side.jobs?.[change.id]?.thread_id ?? null) as never,
      offerAgeS: null,
    })
    base = { schedule, prompt: d.prompt, guard: d.guard }
    if (change.op === 'adopt') {
      const a = box.api<{ prompt: string; guard: string | null } | null>(['approved', change.id], undefined, now)
      approved = a ? { prompt: a.prompt, guard: a.guard } : null
    }
  }
  const cfg = h.bridge.ctx.config
  const again = composeScheduleCard(change, p.preview, approved, {
    cardId: card.id,
    threadId: card.thread_id,
    now: card.created_at,
    origin: card.origin,
    proposedBy: p.proposed_by,
    agentName: cfg.config.agent.name,
    expectedEtag: p.expected_etag,
    clientRef: p.client_ref,
    threadName: (t) => (t ? (cfg.thread(t)?.name ?? t) : (cfg.thread(cfg.config.default_thread)?.name ?? 'Default')),
    base,
    ...(card.summary ? { reason: card.summary } : {}),
    ...(card.supersedes ? { supersedes: card.supersedes } : {}),
  })
  return jcs(again) === jcs(card)
    ? null
    : `card ${card.id} (${change.op}) differs from composeScheduleCard() of the same inputs`
}

// ---- the flows --------------------------------------------------------------------------------------------------

/** headless.blocked the way Chronos's launch watchdog writes it (chronos_runlog.write_block). */
function writeBlock(box: ChronosBox, source: string, tcc: boolean) {
  writeFileSync(
    join(box.homeDir(), 'headless.blocked'),
    JSON.stringify({
      reason: 'launch_stalled',
      since: '2026-10-05T07:00:00-04:00',
      id: null,
      ds: null,
      run_id: null,
      source,
      tcc_suspected: tcc,
    }),
  )
}

const NEW_JOB = {
  id: 'nightly-sync',
  name: 'Nightly Sync',
  description: 'Sync the notes folder.',
  when: { type: 'weekdays', time: '22:00' },
  catchup_min: 120,
  enabled: true,
  runner: 'session',
  permissions: 'full',
  allowed_tools: [] as string[],
  model: null,
  notify: 'failure',
  thread_id: 'inbox',
  prompt: 'Sync the notes folder and post a one-line summary.\n',
}

type Flow = {
  name: string
  title: string
  start: Parameters<typeof startSched>[0]
  run: (r: Recorder, h: SchedHarness) => Promise<void>
}

const patchStep = async (r: Recorder, change: Json, thread = 'general') => {
  const f = await r.h.app.patchSchedule(change, thread)
  await r.h.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in' }).catch(() => {})
  // N4, while the card is still the current revision of the job: it equals composeScheduleCard() of the same inputs
  const cc = await r.h.app
    .expectFrame('card.create', (c) => (c.card.payload as { client_ref?: string } | undefined)?.client_ref === f.id, {
      direction: 'in',
    })
    .catch(() => undefined)
  if (cc) {
    const parsed = parseFrame(cc as never, { direction: 'bridge_to_relay' })
    if (!parsed.ok) r.problems.push('card.create does not parse')
    const bad = checkCardEquation(r.h.box, r.h, cc.card, r.now)
    if (bad) r.problems.push(bad)
  }
  return f
}
const approve = async (r: Recorder, cardId: string) => {
  const c = (await r.h.app.expectFrame('card.create', (x) => x.card.id === cardId, { direction: 'in' })).card
  const token = r.h.relay.mintStepup(`card:${cardId}`)
  await r.h.app.resolveCard(c, 'primary', c.payload_hash, { stepup_token: token })
  await r.h.app.expectFrame(
    'card.update',
    (u) => u.card_id === cardId && (u.state === 'done' || u.state === 'failed'),
    {
      direction: 'in',
      timeoutMs: 15_000,
    },
  )
}
const lastCard = (r: Recorder) => {
  const cards = r.h.relay.frames.filter((x) => x.direction === 'from_bridge' && x.frame.type === 'card.create')
  const last = cards[cards.length - 1]
  if (!last) throw new Error('no card.create yet')
  return (last.frame as { card: CardT }).card
}

const FLOWS: Flow[] = [
  {
    name: '01-list-empty',
    title: 'schedules.list with no jobs: ack{ref} (no seq), then an empty snapshot',
    start: {},
    run: async (r, h) => {
      await r.step('app asks for the list', async () => {
        const f = await h.app.listSchedules()
        await h.app.expectFrame(
          'schedules.snapshot',
          (s) => s.request_id === (f as unknown as { request_id: string }).request_id,
          {
            direction: 'in',
          },
        )
      })
    },
  },
  {
    name: '02-list-three-jobs',
    title: 'schedules.list with three jobs: a session job, a headless job and a one-shot',
    start: {
      jobs: [
        draft(),
        draft({
          id: 'weekly-wrap',
          name: 'Weekly Wrap',
          runner: 'headless',
          when: { type: 'days', days: ['fri'], time: '16:00' },
        }),
        draft({ id: 'one-time', name: 'One Time', when: { type: 'once', at: '2026-10-09T10:00' } }),
      ],
    },
    run: async (r, h) => {
      await r.step('app asks for the list', async () => {
        const f = await h.app.listSchedules()
        await h.app.expectFrame(
          'schedules.snapshot',
          (s) => s.request_id === (f as unknown as { request_id: string }).request_id,
          {
            direction: 'in',
          },
        )
      })
    },
  },
  {
    name: '03-get-detail-with-report',
    title: 'schedule.get: a detail with a finished run and its report; an unknown id',
    start: { now: '2026-10-05T11:29:00Z', jobs: [draft()] },
    run: async (r, h) => {
      let runId = ''
      await r.quiet(async () => {
        await r.advance(90_000, '2026-10-05T11:30:30Z')
        const n = await waitNote(h, 'schedule_run')
        runId = n.meta.run_id as string
        await h.agent.start(runId)
        await h.agent.done(runId, true, 'Posted the digest (3 items).', 'Item one\nItem two\nItem three\n')
      })
      await r.step('app asks for the detail and the run report', async () => {
        const f = await h.app.getSchedule('daily-digest', runId)
        await h.app.expectFrame(
          'schedule.detail',
          (d) => d.request_id === (f as unknown as { request_id: string }).request_id,
          {
            direction: 'in',
          },
        )
      })
      await r.step('app asks for a job that does not exist', async () => {
        const f = await h.app.getSchedule('no-such-job')
        await h.app.expectFrame('error', (e) => e.ref === f.id, { direction: 'in' })
      })
    },
  },
  {
    name: '04-patch-create',
    title: 'schedule.patch create: a card; PRIMARY writes it (card.update, schedule.status, the agent is told)',
    start: {},
    run: async (r) => {
      await r.step('app proposes a new job', async () => {
        await patchStep(r, { op: 'create', draft: NEW_JOB })
      })
      await r.step('owner approves the card', async () => approve(r, lastCard(r).id))
    },
  },
  {
    name: '05-patch-update',
    title: 'schedule.patch update (a rename is low risk; a prompt change is high); PRIMARY writes the change',
    start: { jobs: [draft()] },
    run: async (r, h) => {
      const etag = () =>
        h.box.api<{ schedules: Array<{ etag: string }> }>(['snapshot'], undefined, r.now).schedules[0]?.etag as string
      await r.advance(2_100, T0)
      await r.step('app renames the job', async () => {
        await patchStep(r, { op: 'update', id: 'daily-digest', base_etag: etag(), set: { name: 'Morning Digest' } })
      })
      await r.step('owner approves the rename', async () => approve(r, lastCard(r).id))
      await r.advance(2_100, T0)
      await r.step('app rewrites the prompt', async () => {
        await patchStep(r, {
          op: 'update',
          id: 'daily-digest',
          base_etag: etag(),
          set: { prompt: 'Summarise yesterday in one short paragraph and post it.\n' },
        })
      })
      await r.step('owner approves the new prompt', async () => approve(r, lastCard(r).id))
    },
  },
  {
    name: '06-patch-delete',
    title: 'schedule.patch delete: a card; PRIMARY removes the job',
    start: { jobs: [draft()] },
    run: async (r, h) => {
      const etag = h.box.api<{ schedules: Array<{ etag: string }> }>(['snapshot'], undefined, r.now).schedules[0]
        ?.etag as string
      await r.step('app proposes deleting the job', async () => {
        await patchStep(r, { op: 'delete', id: 'daily-digest', base_etag: etag })
      })
      await r.step('owner approves the delete', async () => approve(r, lastCard(r).id))
    },
  },
  {
    name: '07-run-now',
    title: 'schedule.run_now: a session job (default), a headless job in the session (where:session)',
    start: {
      jobs: [
        draft(),
        draft({
          id: 'weekly-wrap',
          name: 'Weekly Wrap',
          runner: 'headless',
          when: { type: 'days', days: ['fri'], time: '16:00' },
        }),
      ],
    },
    run: async (r, h) => {
      await r.step('Run now on a session job: ack, then the job is offered to the session', async () => {
        const f = await h.app.runScheduleNow('daily-digest')
        await h.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in' })
        const n = await waitNote(h, 'schedule_run', 'daily-digest')
        await r.tool('schedule_run_start', { run_id: n.meta.run_id as string })
        await r.tool('schedule_run_done', { run_id: n.meta.run_id as string, ok: true, summary: 'Done by hand.' })
      })
      await r.step('Run now with where:session on a background job: offered to the session', async () => {
        const f = await h.app.runScheduleNow('weekly-wrap', { where: 'session' })
        await h.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in' })
        const n = await waitNote(h, 'schedule_run', 'weekly-wrap')
        await r.tool('schedule_run_start', { run_id: n.meta.run_id as string })
        await r.tool('schedule_run_done', { run_id: n.meta.run_id as string, ok: true, summary: 'Done by hand.' })
      })
    },
  },
  {
    name: '08-control',
    title: 'schedule.control: pause, resume, pause_all, resume_all, disable, retry_headless',
    start: { jobs: [draft()] },
    run: async (r, h) => {
      for (const [action, id] of [
        ['pause', 'daily-digest'],
        ['resume', 'daily-digest'],
        ['pause_all', null],
        ['resume_all', null],
        ['retry_headless', null],
        ['disable', 'daily-digest'],
      ] as const) {
        await r.step(`control ${action}`, async () => {
          const f = await h.app.controlSchedule(action, id)
          await h.app
            .expectFrame((action === 'retry_headless' ? 'ack' : 'ack') as 'ack', (a) => a.ref === f.id, {
              direction: 'in',
              timeoutMs: 20_000,
            })
            .catch(() => {})
        })
      }
    },
  },
  {
    name: '09-session-run',
    title: 'A due session job: schedule_run notification, schedule_run_start, schedule_run_done, schedule.status',
    start: { now: '2026-10-05T11:29:00Z', jobs: [draft()] },
    run: async (r, h) => {
      let runId = ''
      await r.step(
        'the clock reaches 07:30 and the bridge offers the job',
        async () => {
          await r.advance(90_000, '2026-10-05T11:30:30Z')
          runId = (await waitNote(h, 'schedule_run')).meta.run_id as string
        },
        { restamp: true },
      )
      await r.step('the agent claims the run', async () => {
        await r.tool('schedule_run_start', { run_id: runId })
      })
      await r.step('the agent finishes it', async () => {
        await r.tool('schedule_run_done', {
          run_id: runId,
          ok: true,
          summary: 'Posted the digest (3 items).',
          report: 'Item one\nItem two\nItem three\n',
        })
      })
    },
  },
  {
    name: '10-hold-and-adopt',
    title: 'A hand-edited prompt.md: held snapshot, schedule_held notification, an Adopt card on request',
    start: { now: '2026-10-05T11:29:00Z', jobs: [draft()] },
    run: async (r, h) => {
      await r.step(
        'the prompt is edited outside the app and the bridge notices',
        async () => {
          h.box.editPromptOutside('daily-digest', 'Summarise yesterday, then email everyone about it.\n')
          await r.advance(90_000, '2026-10-05T11:30:30Z')
        },
        { restamp: true },
      )
      await r.advance(2_100, '2026-10-05T11:30:40Z')
      await r.step('app asks for the list: the job is on hold', async () => {
        const f = await h.app.listSchedules()
        await h.app.expectFrame(
          'schedules.snapshot',
          (s) => s.request_id === (f as unknown as { request_id: string }).request_id,
          {
            direction: 'in',
          },
        )
      })
      const hash = h.box.api<{ schedules: Array<{ content_hash: string }> }>(['snapshot'], undefined, r.now)
        .schedules[0]?.content_hash
      await r.step('app asks to review the outside change (Adopt)', async () => {
        await patchStep(r, { op: 'adopt', id: 'daily-digest', content_hash: hash })
      })
      await r.step('owner approves it as it is on disk', async () => approve(r, lastCard(r).id))
    },
  },
  {
    name: '11-errors',
    title: 'Every error the bridge can answer a schedule frame with',
    start: {
      jobs: [
        draft(),
        draft({
          id: 'read-only-job',
          name: 'Read Only',
          runner: 'headless',
          permissions: 'restricted',
          allowed_tools: ['Read'],
        }),
        draft({ id: 'held-job', name: 'Held Job' }),
        draft({ id: 'running-job', name: 'Running Job', when: { type: 'daily', time: '23:00' } }),
      ],
    },
    run: async (r, h) => {
      const err = async (label: string, send: () => Promise<{ id: string }>) =>
        r.step(label, async () => {
          const f = await send()
          await h.app.expectFrame('error', (e) => e.ref === f.id, { direction: 'in' }).catch(() => {})
        })
      await r.quiet(async () => {
        h.box.editPromptOutside('held-job', 'Changed behind the scheduler.\n')
        await r.advance(90_000, T0)
      })
      await r.quiet(async () => {
        // a job that is running right now (claimed by a session), for already_running
        h.box.api(
          ['claim', 'running-job'],
          {
            run_id: `r_${newUlid()}`,
            ds: '2026-10-05',
            fire_at: null,
            manual: true,
            again: false,
            runner: 'session',
            bridge_instance: 'bi_other',
          },
          T0,
        )
        await r.advance(2_100, T0)
      })
      await err('schedule_invalid with fields: a read-only job cannot run in the session', () =>
        h.app.patchSchedule(
          { op: 'create', draft: { ...NEW_JOB, permissions: 'restricted', runner: 'session' } },
          'general',
        ),
      )
      await err('schedule_conflict: the id already exists', () =>
        h.app.patchSchedule({ op: 'create', draft: { ...NEW_JOB, id: 'daily-digest' } }, 'general'),
      )
      await err('schedule_conflict: a stale etag', () =>
        h.app.patchSchedule(
          { op: 'update', id: 'daily-digest', base_etag: `sha256:${'a'.repeat(64)}`, set: { name: 'x' } },
          'general',
        ),
      )
      await err('schedule_not_found', () => h.app.getSchedule('no-such-job'))
      await err('held: Run now on a job whose files changed outside the app', () => h.app.runScheduleNow('held-job'))
      await err('schedule_read_only: where:session on a restricted job', () =>
        h.app.runScheduleNow('read-only-job', { where: 'session' }),
      )
      await err('stale: a Run now older than 2 minutes', () =>
        h.app.sendSchedule('schedule.run_now', {
          schedule_id: 'daily-digest',
          again: false,
          where: 'default',
          ts: new Date(h.clock.now() - 3 * 60_000).toISOString(),
          keep_ts: true,
        }),
      )
      await err('already_running: the job is running right now', () => h.app.runScheduleNow('running-job'))
      await err('headless_blocked: background runs are off', async () => {
        writeBlock(h.box, 'watchdog', false)
        return h.app.runScheduleNow('read-only-job')
      })
      await r.step('rate_limited: Run now twice in a row', async () => {
        const a = await h.app.runScheduleNow('daily-digest')
        await h.app.expectFrame('ack', (x) => x.ref === a.id, { direction: 'in' })
        const b = await h.app.runScheduleNow('daily-digest')
        await h.app.expectFrame('error', (e) => e.ref === b.id, { direction: 'in' })
      })
      await r.step('sig_invalid: a list with a wrong signature', async () => {
        const f = h.app.send({
          ...mkFrame('schedules.list'),
          ts: new Date(h.clock.now()).toISOString(),
          request_id: newUlid(),
          device_id: h.app.device.deviceId,
          osig: 'A'.repeat(86),
        })
        await h.app.expectFrame('error', (e) => e.ref === f.id, { direction: 'in' }).catch(() => {})
      })
    },
  },
  {
    name: '12-relay-without-schedules',
    title: 'A relay that does not list schedules/1 yet (deploy order, S1.5): the bridge mints no card',
    start: { relay: { relayFeatures: [] } },
    run: async (r, h) => {
      await r.step('app proposes a job', async () => {
        const f = await h.app.patchSchedule({ op: 'create', draft: NEW_JOB }, 'general')
        await h.app.expectFrame('error', (e) => e.ref === f.id, { direction: 'in' })
      })
    },
  },
  {
    name: '13-states-and-health',
    title: 'A job through offered, agent_busy, no_session, running, failed and missed; the job_failed alert',
    start: {
      now: '2026-10-05T11:29:00Z',
      jobs: [
        draft(),
        draft({ id: 'missed-job', name: 'Missed Job', when: { type: 'daily', time: '07:20' }, catchup_min: 15 }),
      ],
    },
    run: async (r, h) => {
      const list = async () => {
        const f = await h.app.listSchedules()
        await h.app.expectFrame(
          'schedules.snapshot',
          (x) => x.request_id === (f as unknown as { request_id: string }).request_id,
          {
            direction: 'in',
          },
        )
      }
      let runId = ''
      await r.step(
        'the clock reaches 07:30: both due jobs are offered',
        async () => {
          await r.advance(90_000, '2026-10-05T11:30:30Z')
          runId = (await waitNote(h, 'schedule_run', 'daily-digest')).meta.run_id as string
        },
        { restamp: true },
      )
      await r.quiet(async () => r.advance(2_100, '2026-10-05T11:30:32Z'))
      await r.step('list: waiting, offered a moment ago', list)
      await r.quiet(async () => r.advance(130_000, '2026-10-05T11:33:10Z'))
      await r.step('list: waiting, the agent has not started it (agent_busy)', list)
      await r.quiet(async () => r.advance(2_100, '2026-10-05T11:40:00Z'))
      await r.step('list: waiting with no session heard from for minutes (no_session); the other job is missed', list)
      await r.step('the agent claims the run', async () => {
        await r.tool('schedule_run_start', { run_id: runId })
      })
      await r.quiet(async () => r.advance(2_100, '2026-10-05T11:40:05Z'))
      await r.step('list: running', list)
      await r.step('the agent reports a failure: a system row and a job_failed alert', async () => {
        await r.tool('schedule_run_done', { run_id: runId, ok: false, summary: 'The API said no.' })
      })
      await r.quiet(async () => r.advance(2_100, '2026-10-05T11:40:08Z'))
      await r.step('list: failed', list)
    },
  },
  {
    name: '14-registry-not-managed',
    title:
      'Chronos still arms its own session timers (session_runner hook): listed read-only, session_runner_conflict, nothing edits',
    start: { jobs: [draft()], sessionRunner: 'hook', approvalRequired: false },
    run: async (r, h) => {
      await r.step('app asks for the list', async () => {
        const f = await h.app.listSchedules()
        await h.app.expectFrame(
          'schedules.snapshot',
          (x) => x.request_id === (f as unknown as { request_id: string }).request_id,
          {
            direction: 'in',
          },
        )
      })
      await r.step('app tries to pause a job', async () => {
        const f = await h.app.controlSchedule('pause', 'daily-digest')
        await h.app.expectFrame('error', (e) => e.ref === f.id, { direction: 'in' })
      })
      await r.step('app proposes a new job', async () => {
        const f = await h.app.patchSchedule({ op: 'create', draft: NEW_JOB }, 'general')
        await h.app.expectFrame('error', (e) => e.ref === f.id, { direction: 'in' })
      })
    },
  },
  {
    name: '15-background-stalled',
    title:
      'A background run stalled and Chronos blocked headless runs: tcc_suspected, launch_stalled, headless_blocked, a stalled day',
    start: { jobs: [draft({ id: 'bg-job', name: 'Background', runner: 'headless' })] },
    run: async (r, h) => {
      await r.quiet(async () => {
        writeBlock(h.box, 'watchdog', true)
        writeFileSync(join(h.box.stateDir(), 'stalled-bg-job-2026-10-05'), '')
        await r.advance(2_100, T0)
      })
      await r.step('app asks for the list', async () => {
        const f = await h.app.listSchedules()
        await h.app.expectFrame(
          'schedules.snapshot',
          (x) => x.request_id === (f as unknown as { request_id: string }).request_id,
          {
            direction: 'in',
          },
        )
      })
    },
  },
  {
    name: '16-apply-conflict',
    title: 'The job changed after the card was drawn: PRIMARY fails the card and writes nothing',
    start: { jobs: [draft()] },
    run: async (r, h) => {
      const etag = h.box.api<{ schedules: Array<{ etag: string }> }>(['snapshot'], undefined, r.now).schedules[0]
        ?.etag as string
      await r.step('app renames the job', async () => {
        await patchStep(r, { op: 'update', id: 'daily-digest', base_etag: etag, set: { name: 'Morning Digest' } })
      })
      await r.quiet(async () => {
        h.box.change({ op: 'update', id: 'daily-digest', base_etag: etag, set: { catchup_min: 90 } }, r.now)
      })
      await r.step('owner approves the stale card', async () => approve(r, lastCard(r).id))
    },
  },
]

async function waitNote(h: SchedHarness, kind: string, id?: string, ms = 20_000): Promise<Notification> {
  const t0 = Date.now()
  for (;;) {
    const n = h.notes.find((x) => x.meta.kind === kind && (!id || x.meta.schedule_id === id))
    if (n) return n
    if (Date.now() - t0 > ms) throw new Error(`no ${kind} notification${id ? ` for ${id}` : ''}`)
    await sleep(50)
  }
}

// ---- the run ---------------------------------------------------------------------------------------------------

/**
 * The captures are what S2 and S3 are gated on, so every status in them must be one a healthy-or-honestly-unhealthy install
 * really produces. No unreadable-registry or adapter-timeout issue (those mean a bug or a hang, not a scenario), and a
 * scheduler_stuck alert only where the scenario IS a stuck scheduler (the unmanaged registry).
 */
function unrealStatuses(name: string, s: Scenario): string[] {
  const bad: string[] = []
  const walk = (x: unknown, where: string) => {
    if (Array.isArray(x)) {
      for (const v of x) walk(v, where)
      return
    }
    if (!x || typeof x !== 'object') return
    const o = x as Json
    if (Array.isArray(o.issues))
      for (const i of o.issues as Array<{ code?: string }>)
        if (i.code === 'registry_unreadable' || i.code === 'adapter_timeout')
          bad.push(`${name}: ${where}: bogus health issue ${i.code}`)
    const alert = o.alert as { kind?: string } | null | undefined
    if (alert?.kind === 'scheduler_stuck' && !name.startsWith('14-'))
      bad.push(`${name}: ${where}: bogus scheduler_stuck alert`)
    for (const v of Object.values(o)) walk(v, where)
  }
  for (const st of s.steps) walk(st.sent_by_bridge, `step ${st.step}`)
  return bad
}

export type CaptureResult = {
  files: Record<string, string>
  counts: Record<string, { steps: number; frames: number; notifications: number; tool_calls: number }>
}

export async function capture(only?: string): Promise<CaptureResult> {
  const files: Record<string, string> = {}
  const counts: CaptureResult['counts'] = {}
  const problems: string[] = []
  let chronosVersion = ''
  for (const flow of FLOWS) {
    if (only && !flow.name.startsWith(only)) continue
    let recorder: Recorder | undefined
    const holder: { r?: Recorder } = {}
    const h = await startSched({
      ...flow.start,
      scheduleWatch: false,
      chronosNow: () => holder.r?.now ?? flow.start?.now ?? T0,
    })
    try {
      recorder = new Recorder(h, flow.name, flow.title)
      recorder.now = flow.start?.now ?? T0
      holder.r = recorder
      chronosVersion = h.box.cli(['--version']).out.trim()
      await flow.run(recorder, h)
      for (const p of recorder.problems) problems.push(`${flow.name}: ${p}`)
      const scenario = recorder.result()
      problems.push(...unrealStatuses(flow.name, scenario))
      const norm = new Normalizer(new Map())
      const out = norm.value(scenario) as Scenario
      norm.fixCards(out as unknown as Json)
      restamp(out)
      files[`${flow.name}.json`] = `${JSON.stringify(out, null, 2)}\n`
      counts[flow.name] = {
        steps: out.steps.length,
        frames: out.steps.reduce((n, s) => n + s.received_by_bridge.length + s.sent_by_bridge.length, 0),
        notifications: out.steps.reduce((n, s) => n + s.channel_notifications.length, 0),
        tool_calls: out.steps.reduce((n, s) => n + s.agent_tool_calls.length, 0),
      }
    } finally {
      await h.stop()
      h.box.dispose()
    }
  }
  if (problems.length) throw new Error(`capture failed its own checks:\n- ${problems.join('\n- ')}`)
  const index = {
    about:
      'Captured by `bun run capture:schedules` (apps/bridge/scripts/capture-schedules.ts): the REAL bridge against the REAL vendored Chronos CLI. Ids, timestamps, signatures and the machine name are normalized; card hashes are recomputed. Do not edit by hand: re-run the capture.',
    chronos: chronosVersion,
    scheduler_tz: 'America/New_York',
    scheduler_clock_start: T0,
    bridge_hello_features: ['schedules/1'],
    scenarios: Object.entries(counts).map(([name, c]) => ({ file: `${name}.json`, ...c })),
  }
  files['index.json'] = `${JSON.stringify(index, null, 2)}\n`
  return { files, counts }
}

/** Compares the capture with the committed files. Returns the names that differ (missing, changed or stale). */
export function diffAgainstDisk(files: Record<string, string>, dir = CAPTURE_DIR): string[] {
  const diff: string[] = []
  for (const [name, text] of Object.entries(files)) {
    const p = join(dir, name)
    if (!existsSync(p)) diff.push(`${name} (missing)`)
    else if (readFileSync(p, 'utf8') !== text) diff.push(`${name} (differs)`)
  }
  if (existsSync(dir))
    for (const name of readdirSync(dir)) if (name.endsWith('.json') && !(name in files)) diff.push(`${name} (stale)`)
  return diff
}

export function writeCapture(files: Record<string, string>, dir = CAPTURE_DIR) {
  mkdirSync(dir, { recursive: true })
  if (existsSync(dir)) for (const name of readdirSync(dir)) if (name.endsWith('.json')) rmSync(join(dir, name))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name)
    return i >= 0 ? process.argv[i + 1] : undefined
  }
  const check = process.argv.includes('--check')
  const outDir = arg('--out') // for debugging a difference: write somewhere else
  const { files, counts } = await capture(arg('--only'))
  if (check) {
    const diff = diffAgainstDisk(files)
    if (diff.length) {
      console.error(`capture:schedules --check: the committed captures are out of date:\n- ${diff.join('\n- ')}`)
      console.error('Re-run `bun run capture:schedules` and commit packages/testkit/fixtures/captured/.')
      process.exit(1)
    }
    console.log(`capture:schedules --check: ${Object.keys(files).length} files match.`)
  } else {
    writeCapture(files, outDir ?? CAPTURE_DIR)
    for (const [name, c] of Object.entries(counts))
      console.log(
        `${name}.json: ${c.steps} steps, ${c.frames} frames, ${c.notifications} notifications, ${c.tool_calls} tool calls`,
      )
    console.log(`wrote ${Object.keys(files).length} files to ${resolve(outDir ?? CAPTURE_DIR)}`)
  }
  process.exit(0)
}
