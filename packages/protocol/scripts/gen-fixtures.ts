// Regenerates packages/protocol/fixtures/frames/*.json (one valid example per frame type).
// Run: pnpm --filter @talos-app/protocol gen:fixtures
// Owner frames are signed with the committed TEST key in fixtures/test-device-key.json (never a real device key).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bindingFrom,
  type CardT,
  ChronosDetail,
  ChronosValidateOk,
  createExtractableDeviceKeyForTests,
  deviceIdFromJwk,
  FRAME_TYPES,
  importDevicePrivateKey,
  parseChronosSnapshot,
  parseFrame,
  payloadHash,
  RECOVER_SENT_TEXT,
  scheduleFromChronos,
  signOwnerFrame,
  withLegacyMirror,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const keyPath = join(root, 'fixtures', 'test-device-key.json')
mkdirSync(join(root, 'fixtures', 'frames'), { recursive: true })

if (!existsSync(keyPath)) {
  const k = await createExtractableDeviceKeyForTests()
  writeFileSync(
    keyPath,
    `${JSON.stringify({ _comment: 'TEST KEY ONLY. Signs the committed fixtures. Not a real device key.', deviceId: k.deviceId, publicJwk: k.publicJwk, privateJwk: k.privateJwk }, null, 2)}\n`,
  )
}
const keyFile = JSON.parse(readFileSync(keyPath, 'utf8'))
const privateKey = await importDevicePrivateKey(keyFile.privateJwk)
const deviceId: string = keyFile.deviceId
if ((await deviceIdFromJwk(keyFile.publicJwk)) !== deviceId) throw new Error('test key file is inconsistent')

const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ulid = (n: number) => `01JBF3V7Q8K2M4N6P8R0S2T4${A[(n >> 5) & 31]}${A[n & 31]}`
const TS = '2026-10-28T15:32:10.120Z'
const LATER = '2026-10-29T15:32:10.120Z'
const msgId = (n: number) => `m_${ulid(n)}`
const cardId = (n: number) => `c_${ulid(n)}`
const evId = (n: number) => `e_${ulid(n)}`
const mdId = (n: number) => `md_${ulid(n)}`
const vid = `v_${ulid(70)}`
const SIG = 'A'.repeat(86)
const HASH = `sha256:${'5f1c'.repeat(16)}`
const SHA = 'ab'.repeat(32)
const conn = 'cn_8fK2aBcDeFgHiJkLmNoPqR'
const config = JSON.parse(readFileSync(join(root, '..', '..', 'examples', 'config.default.json'), 'utf8'))
const thread = config.threads[0]
const presence = { bridge_online: true, last_seen: TS, queue_depth: 0 }
const attachment = {
  media_id: mdId(1),
  kind: 'image',
  role: 'attachment',
  mime: 'image/png',
  name: 'floorplan.png',
  size: 245760,
  sha256: SHA,
}
const agentMessage = {
  id: msgId(2),
  thread_id: 'general',
  author: 'agent',
  kind: 'text',
  text: 'Done. Three sections, 212 words. Card below if you want it posted.',
  format: 'markdown',
  attachments: [],
  via: 'app',
  created_at: TS,
}
const card: CardT = {
  id: cardId(3),
  thread_id: 'general',
  kind: 'publish',
  title: 'Post v0.3 release notes',
  destination: [{ label: 'To', value: 'GitHub release v0.3 (example-org/example-repo)' }],
  body: "## What's new\nFaster reconnects.",
  body_format: 'markdown',
  fields: [],
  attachments: [],
  warning: "Public. Can't be unpublished quietly.",
  primary_label: 'Publish',
  kill_label: 'Kill release notes',
  allow_edit: true,
  allow_revise: true,
  risk: 'high',
  origin: 'chat',
  payload_hash: HASH,
  state: 'pending',
  created_at: TS,
  expires_at: LATER,
}
card.payload_hash = payloadHash(bindingFrom(card))
const event = {
  id: evId(4),
  source: 'github',
  connection: conn,
  kind: 'github.review_requested',
  title: 'Review requested: Fix reconnect backoff (#41)',
  summary: 'octocat requested your review on example-org/example-repo#41',
  url: 'https://github.com/example-org/example-repo/pull/41',
  actor: { name: 'octocat' },
  ts: TS,
  thread: 'inbox',
  work: false,
  priority: 'high',
  dedup_key: 'github:72d3162e-cc78-11e3-81ab-4c9367dc0958',
}
const inboxItem = (() => {
  const { dedup_key: _d, raw_ref: _r, ...rest } = event as Record<string, unknown>
  return { ...rest, state: 'new' }
})()

const env = (type: string, n: number) => ({ v: 1, type, id: ulid(n), ts: TS })
const owner = { device_id: deviceId }

const unsigned: Record<string, Record<string, unknown>> = {
  challenge: {
    ...env('challenge', 10),
    nonce: 'A'.repeat(43),
    server_time: 1793203930,
    relay_host: 'relay.example.com',
    protocol: 1,
  },
  'hello.bridge': {
    ...env('hello', 11),
    role: 'bridge',
    key_id: '0123456789abcdef',
    sig: SIG,
    client: { name: 'talos-app-bridge', version: '0.0.0' },
    agent_config_rev: 0,
  },
  'hello.app': {
    ...env('hello', 12),
    role: 'app',
    device_id: deviceId,
    last_seq: 0,
    visible: true,
    client: { version: '0.0.0', standalone: true, platform: 'ios' },
  },
  ready: {
    ...env('ready', 13),
    session_id: 'sess_example',
    policy: { max_frame_bytes: 262144, ping_ms: 25000 },
    server_seq: 4182,
    presence,
    agent_config: withLegacyMirror(config),
    threads: config.threads,
    open_cards: [card],
    unread: { general: 2 },
    statuses: [{ thread_id: 'general', state: 'idle', since: TS }],
  },
  ping: { ...env('ping', 14), nonce: 'n1' },
  pong: { ...env('pong', 15), nonce: 'n1' },
  ack: { ...env('ack', 16), ref: ulid(20), seq: 4182, stage: 'consumed' },
  'replay.request': { ...env('replay.request', 17), ids: [ulid(20), ulid(21)] },
  error: { ...env('error', 18), ref: ulid(20), code: 'sig_invalid', message: 'signature check failed' },
  'message.stored': {
    ...env('message.stored', 22),
    client_msg_id: msgId(23),
    message: {
      id: msgId(23),
      thread_id: 'general',
      seq: 4182,
      author: 'owner',
      kind: 'text',
      text: 'Draft the release notes for v0.3',
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: TS,
    },
  },
  transcript: {
    ...env('transcript', 24),
    message_id: msgId(25),
    text: 'hello from a voice note',
    engine: 'fake-stt',
    status: 'done',
  },
  reply: { ...env('reply', 26), message: agentMessage, speak: 'Done. Three sections.' },
  receipt: { ...env('receipt', 27), message_id: msgId(23), state: 'delivered' },
  status: { ...env('status', 28), thread_id: 'general', state: 'working', label: 'Drafting', since: TS },
  presence: { ...env('presence', 29), ...presence },
  'card.create': { ...env('card.create', 30), card },
  'card.update': {
    ...env('card.update', 31),
    card_id: card.id,
    state: 'resolved',
    resolution: { action: 'primary', at: TS, edited: false, payload_hash: card.payload_hash },
  },
  'hook.event': { ...env('hook.event', 32), delivery: 'live', event },
  'hook.digest': {
    ...env('hook.digest', 33),
    window: { start: '2026-10-28T05:00:00.000Z', end: TS },
    threads: [{ thread_id: 'inbox', counts: { github: 1 } }],
    events: [event],
  },
  'inbox.item': { ...env('inbox.item', 34), item: inboxItem },
  'inbox.update': { ...env('inbox.update', 35), event_id: event.id, state: 'done' },
  'thread.upsert': { ...env('thread.upsert', 36), thread },
  'thread.archive': { ...env('thread.archive', 37), thread_id: 'general' },
  'thread.read': { ...env('thread.read', 38), thread_id: 'general', up_to_seq: 4182 },
  'thread.unread': { ...env('thread.unread', 38), thread_id: 'general', up_to_seq: 4181, count: 1 },
  'config.sync': { ...env('config.sync', 39), config: withLegacyMirror(config), rev: 0 },
  'catchup.batch': { ...env('catchup.batch', 40), from_seq: 1, to_seq: 1, frames: [{ type: 'reply' }], more: false },
  'catchup.reset': { ...env('catchup.reset', 41), min_seq: 100 },
  'catchup.request': { ...env('catchup.request', 42), since_seq: 4000 },
  'catchup.summary': {
    ...env('catchup.summary', 43),
    since_seq: 4000,
    threads: [{ thread_id: 'general', unread: 2, last_ts: TS, needs_you: true }],
    open_cards: 1,
    overnight: { counts: { github: 3 } },
  },
  'history.request': {
    ...env('history.request', 44),
    request_id: 'req_1',
    thread_id: 'general',
    before_seq: 4000,
    limit: 50,
  },
  'history.page': {
    ...env('history.page', 45),
    request_id: 'req_1',
    thread_id: 'general',
    messages: [agentMessage],
    has_more: false,
  },
  'media.fetch': { ...env('media.fetch', 46), media_id: mdId(1) },
  'media.ready': { ...env('media.ready', 47), media_id: mdId(1) },
  visibility: { ...env('visibility', 48), state: 'hidden' },
  'voice.state': { ...env('voice.state', 49), voice_session_id: vid, state: 'live' },
  'voice.progress': {
    ...env('voice.progress', 50),
    voice_delegation_id: 'vd_example',
    text: 'Looking that up',
    say: false,
  },
  'voice.ended': {
    ...env('voice.ended', 51),
    voice_session_id: vid,
    thread_id: 'general',
    duration_s: 360,
    transcript: [{ who: 'owner', text: 'What is on today?', at: TS }],
  },
  'device.enrolled': {
    ...env('device.enrolled', 52),
    device: { id: deviceId, name: 'iPhone (Home Screen)', pubkey_jwk: keyFile.publicJwk },
    binding: 'B'.repeat(43),
    code_id: '0123456789abcdef',
    credential_id: 'cred_example',
  },
  'device.pinned': { ...env('device.pinned', 53), device_id: deviceId, ok: true },
  'device.revoked': { ...env('device.revoked', 54), device_id: deviceId },
}

const signedSrc: Record<string, Record<string, unknown>> = {
  message: {
    ...env('message', 60),
    thread_id: 'general',
    client_msg_id: msgId(61),
    text: 'Draft the release notes for v0.3',
    attachments: [],
    ...owner,
  },
  voice_note: {
    ...env('voice_note', 62),
    thread_id: 'general',
    client_msg_id: msgId(63),
    attachment: { ...attachment, kind: 'voice_note', mime: 'audio/mp4', name: 'voice.m4a', duration_ms: 4200 },
    ...owner,
  },
  'card.resolve': {
    ...env('card.resolve', 64),
    card_id: card.id,
    action: 'primary',
    payload_hash: card.payload_hash,
    ...owner,
  },
  'config.patch': {
    ...env('config.patch', 65),
    base_rev: 0,
    patch: { quiet_window: { start: '22:00', end: '06:00' } },
    ...owner,
  },
  'voice.ask': {
    ...env('voice.ask', 66),
    voice_session_id: vid,
    delegation_id: 'vd_example',
    thread_id: 'general',
    question: 'What is on my plate today?',
    transcript_tail: [{ who: 'owner', text: 'What is on my plate today?' }],
    ...owner,
  },
}

// ---- schedules: generated from the vendored Chronos goldens ONLY (docs/SCHEDULES.md S9, WP-S0) ----------------------
const goldenDir = join(root, '..', 'testkit', 'fixtures', 'chronos-0.3')
const golden = (name: string): unknown => JSON.parse(readFileSync(join(goldenDir, `${name}.json`), 'utf8'))
const parsedSnap = parseChronosSnapshot(golden('snapshot-three-jobs'))
if (!parsedSnap.ok || parsedSnap.unreadable.length)
  throw new Error('snapshot-three-jobs golden did not parse row by row')
const chronosSnap = { ...parsedSnap.head, schedules: parsedSnap.jobs }
const chronosDetail = ChronosDetail.parse(golden('detail'))
const validated = ChronosValidateOk.parse(golden('validate-create'))
const toSchedule = (j: (typeof chronosSnap.schedules)[number]) =>
  scheduleFromChronos(j, { thread_id: null, offerAgeS: null, sessionBeatAgeS: chronosSnap.session_beat_age_s })
// The golden install still has Chronos's own session timers on (session_runner "hook"), so the health a bridge derives
// for it is session_runner_conflict (S3.7, S7.2).
const health = {
  state: 'stuck',
  adapter: { id: 'chronos', version: chronosSnap.chronos, api: chronosSnap.api },
  tz: chronosSnap.tz,
  host_label: 'Example Mac',
  session_runner: chronosSnap.session_runner,
  paused_all: chronosSnap.paused_all,
  headless: 'unknown',
  tick_age_s: chronosSnap.tick_age_s,
  issues: [
    {
      code: 'session_runner_conflict',
      severity: 'error',
      text: "Chronos's own session timers are still on, so Talos won't run jobs (to avoid running them twice).",
      fix: 'At the Mac run `talos-app schedules adopt`, then restart your session.',
      schedule_id: null,
      since: chronosSnap.as_of,
    },
  ],
  checked_at: chronosSnap.as_of,
}
unsigned['schedules.snapshot'] = {
  ...env('schedules.snapshot', 81),
  request_id: ulid(80),
  snapshot: {
    protocol: 1,
    health,
    schedules: chronosSnap.schedules.map(toSchedule),
    unreadable: [],
    as_of: chronosSnap.as_of,
  },
}
unsigned['schedule.detail'] = {
  ...env('schedule.detail', 83),
  request_id: ulid(82),
  detail: { ...chronosDetail, schedule: toSchedule(chronosDetail.schedule) },
  report: null,
}
unsigned['schedule.status'] = {
  ...env('schedule.status', 84),
  health,
  changed: chronosSnap.schedules.map((j) => ({ id: j.id, etag: j.etag, state_rev: j.state_rev })),
  removed: [],
  alert: null,
}
const draftFromGolden = validated.normalized.op === 'create' ? validated.normalized.draft : null
if (!draftFromGolden) throw new Error('validate-create golden is not a create')
signedSrc['schedules.list'] = { ...env('schedules.list', 85), request_id: ulid(80), ...owner }
signedSrc['schedule.get'] = {
  ...env('schedule.get', 86),
  request_id: ulid(82),
  schedule_id: chronosDetail.schedule.id,
  report_run_id: null,
  ...owner,
}
signedSrc['schedule.patch'] = {
  ...env('schedule.patch', 87),
  change: { op: 'create', draft: { ...draftFromGolden, thread_id: null } },
  thread_id: 'general',
  ...owner,
}
signedSrc['schedule.run_now'] = {
  ...env('schedule.run_now', 88),
  schedule_id: chronosDetail.schedule.id,
  again: false,
  where: 'default',
  ...owner,
}
signedSrc['schedule.control'] = {
  ...env('schedule.control', 89),
  action: 'pause',
  schedule_id: chronosDetail.schedule.id,
  ...owner,
}

// ---- Claude Code session (docs/CLAUDE-CODE.md C2.5, C4.6) ---------------------------------------------------------
const sessionState = {
  session_id: 'sess_cc_example',
  source: 'mod',
  capabilities: ['stop', 'compact', 'command', 'clear', 'model', 'effort', 'inventory'],
  version: '2.1.312',
  model: { id: 'claude-opus-5-5', display: 'Opus 5.5' },
  effort: 'high',
  permission_mode: 'default',
  busy: true,
  turn_id: 'turn_example_1',
  context: { tokens: 182000, window: 1000000, percent: 18.2 },
  cost_usd: 1.42,
  rate_limits: [{ kind: 'five_hour', percent: 31, resets_at: LATER }],
  surfaces: ['cli', 'talos'],
  at: TS,
}
const sessionInventory = {
  commands: [
    { name: 'context', description: 'Show context usage', source: 'builtin', route: 'control' },
    { name: 'compact', description: 'Compact the conversation', source: 'builtin', route: 'control' },
    { name: 'model', description: 'Switch model', source: 'builtin', route: 'control' },
    { name: 'permissions', description: 'Manage permissions', source: 'builtin', route: 'local_only' },
    { name: 'release-notes', description: 'Draft release notes', source: 'user', route: 'message' },
  ],
  models: [
    { value: 'default', label: 'Default' },
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  mcp_servers: [{ name: 'talos-app', tools: 12, status: 'connected' }],
  plugins: [{ name: 'talos-app-mod', enabled: true }],
  at: TS,
}
const sessionList = [
  {
    id: 'bg_example_1',
    kind: 'background',
    title: 'Run the test suite',
    status: 'working',
    thread_id: 'general',
    output: 'available',
    updated_at: TS,
  },
  {
    id: 'cloud_example_1',
    kind: 'cloud',
    title: 'Nightly refactor',
    status: 'done',
    thread_id: 'general',
    url: 'https://claude.ai/code/session_example',
    output: 'not_available',
    updated_at: TS,
  },
]
;(unsigned.ready as Record<string, unknown>).session_state = sessionState
;(unsigned.ready as Record<string, unknown>).session_inventory = sessionInventory
;(unsigned.ready as Record<string, unknown>).session_list = sessionList
unsigned['session.state'] = { ...env('session.state', 90), state: sessionState }
unsigned['session.inventory'] = { ...env('session.inventory', 91), inventory: sessionInventory }
unsigned['session.control.result'] = {
  ...env('session.control.result', 92),
  control_id: ulid(93),
  ok: true,
  text: 'Stopped.',
  at: TS,
}
unsigned['session.list'] = { ...env('session.list', 94), sessions: sessionList, at: TS }
// docs/SUBAGENTS.md: one running Explore with the tee's summary, one idle teammate, one background shell, one completed
const EARLIER = '2026-10-28T15:30:00.000Z'
const sessionAgents = {
  session_id: 'sess_cc_example',
  source: 'mod+tee',
  can_stop: true,
  rows: [
    {
      id: 'a00f4f30ac1399f7f',
      kind: 'subagent',
      type: 'Explore',
      title: 'research mods API',
      status: 'running',
      activity: 'Running memory and search vitest suites',
      activity_source: 'summary',
      model: 'claude-sonnet-5-5',
      tokens: 12300,
      started_at: '2026-10-28T15:29:56.000Z',
      background: true,
      stoppable: true,
      recent: [
        { at: '2026-10-28T15:31:40.000Z', text: 'Read register.ts' },
        { at: '2026-10-28T15:32:02.000Z', text: 'Run vitest suites' },
      ],
    },
    {
      id: 'tm_reviewer_1',
      kind: 'teammate',
      type: 'general-purpose',
      name: 'reviewer',
      title: 'Review the protocol diff',
      status: 'idle',
      activity: 'Search "AgentsSnapshot"',
      activity_source: 'tool',
      parent_id: 'a00f4f30ac1399f7f',
      tokens: 4100,
      started_at: EARLIER,
      background: true,
      stoppable: true,
      recent: [],
    },
    {
      id: 'b7c2e91d',
      kind: 'shell',
      type: 'shell',
      title: 'Run the dev server',
      status: 'running',
      started_at: EARLIER,
      background: true,
      stoppable: true,
      recent: [],
    },
    {
      id: 'a51d0c7e2f9b4a113',
      kind: 'subagent',
      type: 'general-purpose',
      title: 'Draft release notes',
      status: 'completed',
      model: 'claude-haiku-5-5',
      tokens: 8800,
      started_at: '2026-10-28T15:20:00.000Z',
      ended_at: '2026-10-28T15:27:31.000Z',
      background: false,
      stoppable: false,
      recent: [{ at: '2026-10-28T15:27:20.000Z', text: 'Write release-notes.md' }],
    },
  ],
  at: TS,
}
;(unsigned.ready as Record<string, unknown>).session_agents = sessionAgents
unsigned['session.agents'] = { ...env('session.agents', 98), agents: sessionAgents }
signedSrc['session.control'] = {
  ...env('session.control', 95),
  control_id: ulid(93),
  thread_id: 'general',
  action: 'stop',
  turn_id: 'turn_example_1',
  ...owner,
}
signedSrc['session.spawn'] = {
  ...env('session.spawn', 96),
  spawn_id: ulid(97),
  thread_id: 'general',
  kind: 'background',
  prompt: 'Run the test suite and report the failures here.',
  ...owner,
}

// ---- Option C: per-thread sessions (docs/OPTION-C.md 9.1) ------------------------------------------------------------
signedSrc['thread.session.control'] = {
  ...env('thread.session.control', 120),
  control_id: ulid(121),
  thread_id: 'trip',
  action: 'park',
  ...owner,
}
// Phone recovery: restart the agent, or put back the last good setup
signedSrc['agent.recover'] = {
  ...env('agent.recover', 130),
  control_id: ulid(131),
  action: 'restart',
  ...owner,
}
unsigned['agent.recover.result'] = {
  ...env('agent.recover.result', 132),
  control_id: ulid(131),
  ok: true,
  text: RECOVER_SENT_TEXT,
  at: TS,
}
unsigned['workers.status'] = {
  ...env('workers.status', 122),
  status: {
    supported: true,
    supervisor_online: true,
    threads: [
      { thread_id: 'trip', state: 'live', model: 'inherit', cwd: '/Users/example/Projects/trip', last_turn_at: TS },
      { thread_id: 'garden', state: 'parked', model: 'sonnet', parked_at: TS },
    ],
    governor: { state: 'ok' },
    at: TS,
  },
}

// ---- v2 features (docs/V2-FEATURES.md V1.3) --------------------------------------------------------------------------
const NOTE_SHA = 'cd'.repeat(32)
unsigned['health.beat'] = {
  ...env('health.beat', 100),
  beat: {
    bridge: { version: '0.4.1', started_at: TS },
    mod: { state: 'alive', last_seen: TS, expected: true },
    tts: true,
    stt: true,
    sqlite: { fts5: true },
    search: { state: 'ready', docs: 5000 },
    memory: { state: 'ready', files: 42, truncated: false },
  },
}
signedSrc['search.query'] = {
  ...env('search.query', 101),
  request_id: ulid(102),
  q: 'release notes',
  filters: { thread_ids: [], from: 'any', has_file: null, after: null, before: null },
  sort: 'relevance',
  cursor: null,
  limit: 20,
  ...owner,
}
unsigned['search.results'] = {
  ...env('search.results', 103),
  request_id: ulid(102),
  hits: [
    {
      message_id: msgId(60),
      thread_id: 'general',
      seq: 4182,
      author: 'owner',
      kind: 'text',
      via: 'app',
      created_at: TS,
      match_in: 'text',
      snippet: 'Draft the release notes for v0.3',
      marks: [
        [10, 17],
        [18, 23],
      ],
    },
  ],
  next_cursor: null,
  total_estimate: 1,
  took_ms: 12,
  index: 'ready',
}
signedSrc['memory.tree'] = {
  ...env('memory.tree', 104),
  request_id: ulid(105),
  root_id: 'notes',
  path: 'projects',
  cursor: null,
  ...owner,
}
unsigned['memory.listing'] = {
  ...env('memory.listing', 106),
  request_id: ulid(105),
  root_id: 'notes',
  path: 'projects',
  entries: [
    { name: 'decisions', path: 'projects/decisions', type: 'dir' },
    {
      name: 'overview.md',
      path: 'projects/overview.md',
      type: 'file',
      size: 2048,
      mtime: TS,
      title: 'Overview',
      previewable: true,
    },
  ],
  next_cursor: null,
}
signedSrc['memory.read'] = {
  ...env('memory.read', 107),
  request_id: ulid(108),
  root_id: 'notes',
  path: 'projects/overview.md',
  offset: 0,
  ...owner,
}
unsigned['memory.file'] = {
  ...env('memory.file', 109),
  request_id: ulid(108),
  root_id: 'notes',
  path: 'projects/overview.md',
  mime: 'text/markdown',
  text: '# Overview\n\nSee [[Launch checklist]].\n',
  offset: 0,
  next_offset: null,
  size: 38,
  mtime: TS,
  sha256: NOTE_SHA,
  links: [{ text: 'Launch checklist', root_id: 'notes', path: 'projects/launch-checklist.md' }],
}
signedSrc['memory.search'] = {
  ...env('memory.search', 110),
  request_id: ulid(111),
  q: 'launch',
  root_ids: [],
  cursor: null,
  limit: 20,
  ...owner,
}
unsigned['memory.results'] = {
  ...env('memory.results', 112),
  request_id: ulid(111),
  hits: [
    {
      root_id: 'notes',
      path: 'projects/launch-checklist.md',
      title: 'Launch checklist',
      snippet: 'Launch checklist for the example project',
      marks: [[0, 6]],
      mtime: TS,
    },
  ],
  next_cursor: null,
  index: 'ready',
}
unsigned['share.item'] = {
  ...env('share.item', 113),
  relay: { seq: 4190, received_at: TS },
  share_id: ulid(114),
  token_id: `sh_${ulid(115)}`,
  token_label: 'iPhone',
  message: {
    id: msgId(116),
    thread_id: 'inbox',
    seq: 4190,
    author: 'owner',
    kind: 'text',
    text: 'Read this later',
    format: 'plain',
    attachments: [],
    via: 'share',
    created_at: TS,
    share_content: { url: 'https://example.com/article', title: 'An example article' },
  },
}

unsigned['problem.item'] = {
  ...env('problem.item', 117),
  relay: { seq: 4191, received_at: TS },
  problem: {
    id: ulid(118),
    source: 'web',
    kind: 'auto',
    fingerprint: '0123456789abcdef0123456789abcdef',
    at: TS,
    name: 'TypeError',
    message: 'x is not a function',
    frames: [{ fn: 'render', file: 'assets/index.js', line: 10, col: 4 }],
    versions: { app: '1.2.3', protocol: '1' },
    device: 'browser',
    routes: ['thread'],
    truncated: false,
  },
}

// ---- MCP apps ---------------------------------------------------------------------------------------------------
const viewId = `av_${ulid(120)}`
const reqId = `ar_${ulid(121)}`
const appCsp = {
  connect_domains: ['https://api.example.com'],
  resource_domains: [],
  frame_domains: [],
  base_uri_domains: [],
  script_hashes: [`sha256-${'A'.repeat(43)}=`],
  script_urls: [],
  style_urls: [],
}
const appView = {
  view_id: viewId,
  thread_id: 'general',
  label: 'Notes',
  server: 'probe-notes',
  tool: 'show_note',
  resource_uri: 'ui://probe/note.html',
  approval_key: SHA,
  page: { ...attachment, media_id: mdId(122), kind: 'html', mime: 'text/html', name: 'note.html' },
  csp: appCsp,
  tool_input: { id: 'n1' },
  tool_result: { content: [{ type: 'text', text: 'Buy milk' }], structuredContent: { id: 'n1', body: 'Buy milk' } },
  calls_until: LATER,
  shown_at: TS,
}
unsigned['reply.app_view'] = {
  ...env('reply', 123),
  message: {
    id: msgId(124),
    thread_id: 'general',
    author: 'app',
    kind: 'app',
    text: 'Here is your note.',
    format: 'markdown',
    attachments: [],
    via: 'app',
    created_at: TS,
    app: appView,
  },
  silent: true,
}
unsigned['reply.app_echo'] = {
  ...env('reply', 125),
  message: {
    id: msgId(126),
    thread_id: 'general',
    author: 'app',
    kind: 'text',
    text: 'Notes sent to Claude: remind me tomorrow',
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: TS,
    app_view_id: viewId,
  },
  silent: true,
}
signedSrc['app.request'] = {
  ...env('app.request', 127),
  thread_id: 'general',
  view_id: viewId,
  request_id: reqId,
  method: 'tools/call',
  tool_name: 'read_note',
  arguments: { id: 'n1' },
  user_gesture: true,
  ...owner,
}
signedSrc['app.request.ui_message'] = {
  ...env('app.request', 128),
  thread_id: 'general',
  view_id: viewId,
  request_id: `ar_${ulid(129)}`,
  method: 'ui/message',
  text: 'remind me tomorrow',
  user_gesture: true,
  ...owner,
}
unsigned['app.response'] = {
  ...env('app.response', 130),
  view_id: viewId,
  request_id: reqId,
  state: 'done',
  result: { content: [{ type: 'text', text: 'Buy milk' }] },
}
unsigned['app.update'] = {
  ...env('app.update', 131),
  view_id: viewId,
  thread_id: 'general',
  state: 'superseded',
  reason: 'Replaced by a newer view',
}
signedSrc['speak.request'] = {
  ...env('speak.request', 132),
  request_id: ulid(133),
  message_id: msgId(2),
  thread_id: 'general',
  fresh: true,
  ...owner,
}
unsigned['speak.result'] = {
  ...env('speak.result', 134),
  request_id: ulid(133),
  state: 'ready',
  media: {
    media_id: mdId(135),
    kind: 'audio',
    role: 'voice_reply',
    mime: 'audio/mp4',
    name: 'read-aloud.m4a',
    size: 48213,
    sha256: SHA,
  },
  chars: 66,
  total_chars: 66,
  truncated: false,
}

// A phone's Reply, signed by the phone's action key (not a device-key owner frame), as the relay hands it to the Mac. The bytes
// come from fixtures/push-rich/vectors.json so they stay the ones the Swift tests check (gen-push-rich-vectors.ts makes that file).
const richVectors = JSON.parse(readFileSync(join(root, 'fixtures', 'push-rich', 'vectors.json'), 'utf8'))
unsigned['native.act'] = { ...richVectors.act.wire, relay: { seq: 4190, received_at: '2026-11-01T18:01:00.200Z' } }

const out: Record<string, Record<string, unknown>> = { ...unsigned }
for (const [k, v] of Object.entries(signedSrc)) out[k] = await signOwnerFrame(v, privateKey)

// ECDSA signatures are randomized: keep an existing file whose content differs only in `osig`, so a regeneration that
// changes nothing leaves the committed fixtures byte-identical.
const sameButSig = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const { osig: _a, ...x } = a
  const { osig: _b, ...y } = b
  return JSON.stringify(x) === JSON.stringify(y)
}
for (const [name, frame] of Object.entries(out)) {
  const res = parseFrame(frame)
  if (!res.ok) throw new Error(`fixture ${name} does not parse: ${res.message}`)
  const file = join(root, 'fixtures', 'frames', `${name}.json`)
  if (existsSync(file) && sameButSig(JSON.parse(readFileSync(file, 'utf8')), frame)) continue
  writeFileSync(file, `${JSON.stringify(frame, null, 2)}\n`)
}
const covered = new Set(Object.keys(out).map((n) => (n.split('.')[0] === 'hello' ? 'hello' : n)))
for (const t of FRAME_TYPES) if (!covered.has(t)) throw new Error(`no fixture for frame type ${t}`)
console.log(`wrote ${Object.keys(out).length} fixtures`)
