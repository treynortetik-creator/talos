// In-memory TalosClient seeded from the protocol fixtures. Seam: frozen after WP0 (WP8 may edit).
// Used by WP4 and WP7 (`VITE_FAKE=1`) and by WP6 until the socket client lands. It behaves like a Mac that is online and,
// importantly, as strictly as the spec: the checks WP7's acceptance tests exercise (hash, state, expiry, edit
// rules, config allowlist, config_conflict) really reject, so those tests cannot pass vacuously.

import { listSetupSpecs } from '@talos-app/integrations/catalog'
import {
  AgentConfig,
  type AgentConfigT,
  type AttachmentRefT,
  applyCardEdits,
  applyMergePatch,
  BUG_WEBHOOK_URL_RULE,
  type BugReportBodyT,
  bindingFrom,
  bugWebhookUrlOk,
  Card,
  type CardT,
  checkConfigPatch,
  checkEditAllowed,
  createDeviceKey,
  dedicatedPatchIssue,
  type ErrorCodeT,
  type FrameOf,
  type FrameType,
  HOST_LINUX_FEATURE,
  HOST_MAC_FEATURE,
  HOST_WINDOWS_FEATURE,
  InboxItem,
  type InboxItemT,
  type JwkP256T,
  Message,
  type MessageT,
  newConnectionId,
  newId,
  newUlid,
  ownValue,
  payloadHash,
  RECOVER_SENT_TEXT,
  type RouteRes,
  resolveThreadsPatch,
  SETTINGS_LOCK_FEATURE,
  sessionFieldsIssue,
  shownWebhookHost,
  signOwnerFrame,
  stripDeviceHidden,
  subThreadPatchIssue,
  textTypeOfFile,
  threadPatchIssue,
} from '@talos-app/protocol'
import cardFixture from '@talos-app/protocol/fixtures/frames/card.create.json'
import inboxFixture from '@talos-app/protocol/fixtures/frames/inbox.item.json'
import readyFixture from '@talos-app/protocol/fixtures/frames/ready.json'
import { createStore } from 'zustand/vanilla'
import {
  type CardResolveInput,
  type ClientState,
  initialClientState,
  NoAnswerError,
  NotSentError,
  type SendResult,
  type TalosApi,
  type TalosClient,
  TalosClientError,
  type VoiceAskArgs,
} from './client.ts'
import { createFakeAgentsMd, type FakeAgentsMd, type FakeAgentsMdSeed } from './fakeAgentsMd.ts'
import { checkFields, missingRequired } from './fakeConnectionFields.ts'
import { createFakeFilesSent } from './fakeFilesSent.ts'
import { createFakeMemoryFolders } from './fakeMemoryFolders.ts'
import { createFakeSchedules, type FakeSchedulesClient } from './fakeSchedules.ts'
import { createFakeSession, type FakeAgentsMode, type FakeModMode, type FakeSession } from './fakeSession.ts'
import {
  createFakeFiles,
  createFakeFolders,
  createFakeMemory,
  createFakeSearch,
  createFakeSpeak,
  type FakeFiles,
  type FakeFilesTree,
  type FakeFolders,
  type FakeFolderTree,
} from './fakeV2.ts'
import { HttpError } from './http.ts'
import type {
  AgentsMdClient,
  BugReportClient,
  FilesClient,
  FolderClient,
  MemoryClient,
  SearchClient,
  SpeakClient,
} from './v2Client.ts'

export type FakeClientOptions = {
  /** Milliseconds before the fake agent answers. 0 = next tick. */
  replyDelayMs?: number
  /** Start with the Mac offline (presence.bridge_online=false). */
  macOffline?: boolean
  /** Which computer the fake agent runs on (lib/hostWords.ts): a Mac by default; 'none' plays an older bridge. */
  host?: 'mac' | 'windows' | 'linux' | 'none'
  now?: () => number
  /** CC-C3: the scripted Claude Code session. 'live' (default), 'offline' (mod lapsed) or 'absent' (no mod ever). */
  mod?: FakeModMode
  /** docs/SUBAGENTS.md: the agents snapshot the fake mod sends ('none' by default: a mod without `agents`). */
  agents?: FakeAgentsMode
  /** The folders the fake Mac lists for the folder picker. Default: a small made-up home (`/Users/alex`). */
  folders?: FakeFolderTree
  /** The thread folders the fake Mac's Files pane shows. Default: DEMO_FILES. */
  files?: FakeFilesTree
  /** AGENTS.md of threads that have one on the fake Mac already. */
  agentsMd?: FakeAgentsMdSeed
}

/** Seeds: a config, two threads, one pending high-risk card, one inbox item, one agent message. */
export function seedState(): ClientState {
  const config = AgentConfig.parse(readyFixture.agent_config)
  const card = Card.parse((cardFixture as { card: unknown }).card)
  const item = InboxItem.parse((inboxFixture as { item: unknown }).item)
  const hello: MessageT = Message.parse({
    id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4AA',
    thread_id: 'general',
    seq: 1,
    author: 'agent',
    kind: 'text',
    text: 'Hi. I am a fake agent. Say something and I will echo it.',
    created_at: '2026-10-28T15:00:00.000Z',
  })
  return {
    ...initialClientState(),
    connection: 'online',
    devicePinned: true,
    deviceId: 'd_k3j2h4g5f6d7s2a7q2w3',
    presence: {
      bridge_online: true,
      last_seen: '2026-10-28T15:00:00.000Z',
      queue_depth: 0,
      features: [
        HOST_MAC_FEATURE, // fake mode plays a Mac (lib/hostWords.ts)
        SETTINGS_LOCK_FEATURE, // the fake bridge reads Lock Talos settings
        'schedules/1',
        'schedules/2',
        'heartbeat/1',
        'session/1',
        'driving/1',
        'search/1',
        'memory/1',
        'memory-graph/1',
        'threads/2',
        'speak/1',
        'folders/1',
        'files/1',
        'agents-md/1',
        'files-put/1',
        'files-sent/1',
        'memory-roots/1',
        'run/1',
      ],
      features_at: '2026-10-28T15:00:00.000Z',
    },
    relayFeatures: ['schedules/1', 'schedules/2', 'heartbeat/1', 'health/1', 'share/1'],
    config,
    threads: config.threads,
    messages: { general: [hello] },
    unread: { general: 1 },
    cards: [card],
    inbox: [item],
    lastSeq: 1,
  }
}

/** The made-up thread folder the fake client's Files pane shows (VITE_FAKE=1 and the web tests). Generic made-up files only. */
export const DEMO_FILES: FakeFilesTree = {
  root: '/Users/alex/talos-agent',
  roots: { work: '/Users/alex/Projects/atlas', daily: '/Users/alex/Projects/atlas/daily' },
  files: {
    'README.md':
      '# Atlas\n\nA small made-up project for the demo.\n\n## Run it\n\n```sh\npnpm install\npnpm dev\n```\n\n- Plans live in `docs/`\n- The app is in `apps/web`\n',
    'CHANGELOG.md': '# Changelog\n\n## 0.3.0\n\n- Stacked panes beside the chat\n- A Files pane\n',
    'package.json':
      '{\n  "name": "atlas",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest"\n  }\n}\n',
    'docs/plan.md': '# Plan\n\n1. Panes\n2. Files\n3. Pages\n',
    'docs/notes.txt': 'Plain notes.\nSecond line.\n',
    'apps/web/src/main.ts':
      "import { start } from './app'\n\nconst root = document.getElementById('root')\nif (root) start(root)\n",
    'apps/web/src/app.ts': "export function start(el: HTMLElement) {\n  el.textContent = 'Hello'\n}\n",
    'scripts/build.sh': '#!/bin/sh\nset -e\npnpm build\n',
    'assets/logo.png': { image: true },
    'assets/font.woff2': { binary: true },
    '.env': 'TOKEN=not-shown',
    '.git/config': '[core]',
    'node_modules/x/index.js': 'module.exports = 1',
  },
}

/** The made-up Mac the fake client lists folders from (VITE_FAKE=1 and the web tests). */
export const DEMO_FOLDERS: FakeFolderTree = {
  home: '/Users/alex',
  agentDir: '/Users/alex/talos-agent',
  tree: {
    '/Users/alex': ['Documents', 'Projects', 'talos-agent', '.config'],
    '/Users/alex/Documents': ['Taxes', 'Travel'],
    '/Users/alex/Projects': ['alpha', 'beta', '.git'],
    '/Users/alex/Projects/alpha': ['src', 'docs'],
    '/Users/alex/Projects/beta': [],
    '/Users/alex/Projects/alpha/src': [],
    '/Users/alex/Projects/alpha/docs': [],
    '/Users/alex/Documents/Taxes': [],
    '/Users/alex/Documents/Travel': [],
    '/Users/alex/talos-agent': ['notes'],
  },
}

export type FakeClient = TalosClient & {
  /** Every owner frame the client signed, in order (raw objects, as they would go on the wire). */
  readonly sent: Array<Record<string, unknown>>
  /** Public half of the fake device key, for verifying `sent` in tests. */
  publicJwk(): Promise<JwkP256T>
  /**
   * The next `patchConfig` rejects with this code (simulate `config_conflict` and friends), then behaves again. `how`: as the
   * real client refuses a change that never left the phone ('not_sent') or one whose answer the dropped socket lost ('no_answer').
   */
  failNextPatchWith(code: ErrorCodeT, message?: string, how?: 'not_sent' | 'no_answer'): void
  /** This device's link to the relay, as the real client reports it (the Mac's presence is setMacOnline). */
  setConnection(state: ClientState['connection']): void
  /** The next `sendAppRequest` rejects with this code (a relay `error{ref}`), then behaves again. */
  failNextAppRequestWith(code: ErrorCodeT): void
  /** The Mac's answer to the next `agent.recover` is a failure with this text. */
  failNextRecoverWith(text: string): void
  /** Pushes a frame to `onFrame` listeners as if the relay sent it (does not touch the store). */
  emit<T extends FrameType>(type: T, fields: Omit<FrameOf<T>, 'v' | 'type' | 'id' | 'ts'>): void
  setMacOnline(online: boolean): void
  readonly schedules: FakeSchedulesClient
  readonly search: SearchClient
  readonly memory: MemoryClient
  readonly speak: SpeakClient
  readonly folders: FolderClient
  readonly files: FilesClient
  readonly agentsMd: AgentsMdClient
  /** The fake Mac's AGENTS.md files, for tests. */
  readonly fakeAgentsMd: FakeAgentsMd
  /** The fake Mac's thread folders for the Files pane: fail the next call, add a file, see the calls. */
  readonly fakeFiles: FakeFiles
  /** The bug reporter: answers `context` from a made-up Mac and keeps what `send` was given, for tests to read. */
  readonly bugs: BugReportClient
  readonly bugReports: Array<{ report: BugReportBodyT; picture: { type: string; bytes: Uint8Array } }>
  /** The fake Mac's folders: fail the next listing, change a folder's contents. */
  readonly fakeFolders: FakeFolders
  /** CC-C3: scripted Claude Code session (state, inventory, control answers). */
  readonly session: FakeSession
}

export function createFakeClient(opts: FakeClientOptions = {}): FakeClient {
  let lastWorkers: unknown
  const now = opts.now ?? Date.now
  const state = seedState()
  if (opts.macOffline) state.presence = { ...state.presence, bridge_online: false }
  if (opts.host && opts.host !== 'mac') {
    const other = { windows: HOST_WINDOWS_FEATURE, linux: HOST_LINUX_FEATURE, none: null }[opts.host]
    const rest = (state.presence.features ?? []).filter((f) => f !== HOST_MAC_FEATURE)
    state.presence = { ...state.presence, features: other ? [other, ...rest] : rest }
  }
  const store = createStore<ClientState>(() => state)
  // Like the real client: a send is 'sent' while the socket to the relay is up, whether or not the Mac is online, and
  // 'queued' only when the socket is down.
  const sendState = (): SendResult['state'] => {
    if (!store.getState().devicePinned) return 'held_unpinned'
    return store.getState().connection === 'online' ? 'sent' : 'queued'
  }
  const sent: Array<Record<string, unknown>> = []
  const keyPromise = createDeviceKey()
  const fakeFolders = createFakeFolders(
    { macOnline: () => store.getState().presence.bridge_online },
    opts.folders ?? DEMO_FOLDERS,
  )
  const fakeFiles = createFakeFiles(
    { macOnline: () => store.getState().presence.bridge_online },
    opts.files ?? DEMO_FILES,
  )
  // the Files sheet's list of files sent in Talos (fakeFilesSent.ts), beside the folder reads
  fakeFiles.sent = createFakeFilesSent({
    macOnline: () => store.getState().presence.bridge_online,
    knownThread: (id) => store.getState().threads.some((t) => t.id === id),
  }).sent
  const fakeAgentsMd = createFakeAgentsMd(
    {
      macOnline: () => store.getState().presence.bridge_online,
      ownFolder: (id) => {
        const t = store.getState().config?.threads.find((x) => x.id === id)
        return t?.session === 'dedicated' && typeof t.session_opts?.cwd === 'string'
      },
    },
    opts.agentsMd,
  )
  const bugReports: Array<{ report: BugReportBodyT; picture: { type: string; bytes: Uint8Array } }> = []
  const bugs: BugReportClient = {
    async context() {
      if (!store.getState().presence.bridge_online) throw new TalosClientError('mac_offline', 'Your Mac is away.')
      return {
        bridgeVersion: '0.4.2',
        claudeCode: '2.1.312',
        recentErrors: ['web: TypeError: x is not a function', 'relay: Error: socket closed (x2)'],
        logs: '2026-11-10T04:00:00.000Z info     bridge up\n2026-11-10T04:00:01.000Z warn     relay slow',
      }
    },
    async send(report, picture) {
      bugReports.push({ report, picture })
      return { id: newUlid() }
    },
    // like the relay: the webhook's host when the fake Mac has an address (the fake relay always has the secret), else nowhere
    async destination() {
      return fakeWebhookUrl
        ? { to: 'webhook', host: shownWebhookHost(new URL(fakeWebhookUrl).hostname) }
        : { to: 'relay' }
    },
  }
  const listeners = new Map<string, Set<(f: never) => void>>()
  let seq = state.lastSeq
  let failNext: { code: ErrorCodeT; message?: string; how?: 'not_sent' | 'no_answer' } | null = null
  /** The bug webhook address as the fake Mac keeps it; the app is only shown its host (stripDeviceHidden). */
  let fakeWebhookUrl: string | undefined
  let failNextApp: ErrorCodeT | null = null
  let failNextRecover: string | null = null

  const iso = () => new Date(now()).toISOString()
  const set = (fn: (s: ClientState) => Partial<ClientState>) => store.setState((s) => ({ ...s, ...fn(s) }))
  const append = (m: MessageT) =>
    set((s) => ({
      messages: { ...s.messages, [m.thread_id]: [...(ownValue(s.messages, m.thread_id) ?? []), m] },
      lastSeq: m.seq ?? s.lastSeq,
    }))
  const emit = (type: string, fields: Record<string, unknown>) => {
    const frame = { v: 1, type, id: newUlid(), ts: iso(), ...fields }
    for (const l of listeners.get(type) ?? []) l(frame as never)
  }

  const owner = async (frame: Record<string, unknown>) => {
    const key = await keyPromise
    const signed = await signOwnerFrame(
      { v: 1, id: newUlid(), ts: iso(), ...frame, device_id: key.deviceId },
      key.privateKey,
    )
    sent.push(signed)
    return signed
  }

  // ---- HTTP API (in memory) ------------------------------------------------------------------------------------
  type Conn = RouteRes<'connectionGet'>
  const conns = new Map<string, Conn>()
  /** What each connection holds besides its row (plain settings and secret field names), as the relay keeps them. */
  const held = new Map<string, Set<string>>()
  const specFor = async (integration: string) => (await api.catalog()).find((s) => s.id === integration)
  const deliveries = new Map<string, RouteRes<'connectionDeliveries'>>()
  const findConn = (id: string): Conn => {
    const c = conns.get(id)
    if (!c) throw new TalosClientError('bad_frame', `no connection ${id}`)
    return c
  }
  const api: TalosApi = {
    async catalog() {
      return listSetupSpecs()
    },
    connections: {
      async list() {
        return [...conns.values()]
      },
      async create(body) {
        const checked = checkFields(await specFor(body.integration), body.fields ?? {}, true)
        if (!checked.ok) throw new HttpError(400, checked.error, { error: checked.error })
        const id = newConnectionId()
        const conn: Conn = {
          id,
          integration: body.integration,
          name: body.name,
          thread: body.thread ?? 'inbox',
          status: 'active',
          filters: body.filters ?? {},
          created_at: iso(),
          last_event_at: null,
          kept_24h: 0,
          received_24h: 0,
          ...(body.integration === 'slack' ? { identity: checked.extra.identity === 'bot' ? 'bot' : 'owner' } : {}),
        }
        conns.set(id, conn)
        held.set(id, new Set([...Object.keys(checked.extra), ...Object.keys(checked.secrets)]))
        deliveries.set(id, [])
        return {
          ...conn,
          hook_url: `https://relay.example.com/hook/${body.integration}/${id}`,
          secret: `whsec_${newUlid().toLowerCase()}`,
        }
      },
      async get(id) {
        return findConn(id)
      },
      async patch(id, body) {
        const next = { ...findConn(id), ...body } as Conn
        conns.set(id, next)
        return next
      },
      async delete(id) {
        findConn(id)
        conns.delete(id)
        held.delete(id)
        deliveries.delete(id)
      },
      async rotate(id) {
        findConn(id)
        return { secret: `whsec_${newUlid().toLowerCase()}` }
      },
      async test(id) {
        findConn(id)
        return { ok: true, detail: 'Fake connection: nothing to test.' }
      },
      async credentials(id, fields) {
        const c = findConn(id)
        const spec = await specFor(c.integration)
        const checked = checkFields(spec, fields, false)
        if (!checked.ok) return { ok: false, detail: checked.error }
        const have = new Set([...(held.get(id) ?? []), ...Object.keys(checked.extra), ...Object.keys(checked.secrets)])
        const missing = missingRequired(spec, have)
        if (missing) return { ok: false, detail: `${missing} is missing` }
        held.set(id, have)
        return { ok: true }
      },
      async deliveries(id) {
        findConn(id)
        return deliveries.get(id) ?? []
      },
    },
    async inbox(tab) {
      const s = store.getState()
      const isPriority = (i: InboxItemT) => i.priority !== 'low'
      const items = s.inbox.filter((i) => (tab === 'priority' ? isPriority(i) : !isPriority(i)))
      return {
        items,
        counts: { priority: s.inbox.filter(isPriority).length, other: s.inbox.filter((i) => !isPriority(i)).length },
        ...(s.inboxTruncated ? { truncated: true } : {}),
      }
    },
  }

  // ---- client --------------------------------------------------------------------------------------------------
  const schedules = createFakeSchedules({
    sign: owner,
    getSlice: () => store.getState().schedules,
    setSlice: (next) => set((s) => ({ schedules: { ...s.schedules, ...next } })),
    macOnline: () => store.getState().presence.bridge_online,
    addCard: (card) => {
      set((s) => ({ cards: [...s.cards, card] }))
      emit('card.create', { card })
    },
    emit,
    agentName: () => store.getState().config?.agent.name ?? 'Talos',
    now: iso,
  })

  // CC-C3: the fake Claude Code session. It answers session.control through the real checkSessionControl.
  const session = createFakeSession({
    now,
    emit,
    ...(opts.mod ? { initial: opts.mod } : {}),
    ...(opts.agents ? { agents: opts.agents } : {}),
    allowedModels: () => store.getState().config?.session_models ?? ['default', 'opus', 'sonnet', 'haiku'],
  })

  const client: FakeClient = {
    store,
    session,
    async sendOwnerFrame(frame) {
      const signed = await owner(frame)
      if (frame.type === 'session.control') session.handle(signed as Record<string, unknown>)
      if (frame.type === 'undo.request')
        // the demo has no folder to put back: it says so, as a Mac with nothing to undo would
        queueMicrotask(() =>
          emit('undo.request.result', {
            control_id: frame.control_id,
            ok: false,
            text: 'Nothing to undo: the files already match.',
            at: iso(),
          }),
        )
      if (frame.type === 'agent.recover') {
        const failed = failNextRecover
        failNextRecover = null
        const text = failed ?? RECOVER_SENT_TEXT
        queueMicrotask(() =>
          emit('agent.recover.result', { control_id: frame.control_id, ok: failed === null, text, at: iso() }),
        )
      }
    },
    async sendAppRequest(frame) {
      const code = failNextApp
      if (code) {
        failNextApp = null
        throw new TalosClientError(code, 'The relay refused the request.')
      }
      await owner(frame)
    },
    failNextAppRequestWith(code) {
      failNextApp = code
    },
    failNextRecoverWith(text) {
      failNextRecover = text
    },
    sent,
    api,
    schedules,
    search: createFakeSearch({
      messages: () => store.getState().messages,
      macOnline: () => store.getState().presence.bridge_online,
    }),
    memory: createFakeMemory({ macOnline: () => store.getState().presence.bridge_online }),
    folders: fakeFolders,
    files: fakeFiles,
    fakeFiles,
    agentsMd: fakeAgentsMd,
    fakeAgentsMd,
    memoryFolders: createFakeMemoryFolders({ macOnline: () => store.getState().presence.bridge_online }),
    bugs,
    bugReports,
    fakeFolders,
    speak: createFakeSpeak({
      messages: () => store.getState().messages,
      macOnline: () => store.getState().presence.bridge_online,
    }),
    async publicJwk() {
      return (await keyPromise).publicJwk
    },
    failNextPatchWith(code, message, how) {
      failNext = { code, ...(message ? { message } : {}), ...(how ? { how } : {}) }
    },
    setConnection(state) {
      set(() => ({ connection: state }))
    },
    emit(type, fields) {
      if (type === 'workers.status') lastWorkers = (fields as unknown as { status: unknown }).status
      // `app.update` is the one frame the real client also keeps in the store (it is durable and replayed).
      if (type === 'app.update') {
        const f = fields as unknown as { view_id: string; state: 'superseded' | 'closed' | 'revoked'; reason?: string }
        set((s) => ({
          appStates: { ...s.appStates, [f.view_id]: { state: f.state, ...(f.reason ? { reason: f.reason } : {}) } },
        }))
      }
      emit(type, fields as Record<string, unknown>)
    },
    setMacOnline(online) {
      set((s) => ({ presence: { ...s.presence, bridge_online: online, last_seen: iso() } }))
    },
    onFrame(type, listener) {
      const set_ = listeners.get(type) ?? new Set()
      set_.add(listener as never)
      listeners.set(type, set_)
      // CC-C3: like the relay's `ready`, hand a new `ready` listener the last session state and inventory.
      if (type === 'ready') {
        session.startHeartbeat()
        queueMicrotask(() =>
          (listener as (f: unknown) => void)({
            v: 1,
            type: 'ready',
            id: newUlid(),
            ts: iso(),
            ...session.readyFields(),
            ...(lastWorkers ? { workers_status: lastWorkers } : {}), // kept for `ready`, like the relay does
          }),
        )
      }
      return () => void set_.delete(listener as never)
    },
    async sendMessage({ threadId, text, attachments = [], replyTo, intent, runBlock }): Promise<SendResult> {
      const clientMsgId = newId('m')
      await owner({
        type: 'message',
        thread_id: threadId,
        client_msg_id: clientMsgId,
        text,
        attachments,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(intent ? { intent } : {}),
        ...(runBlock ? { run_block: runBlock } : {}),
      })
      append({
        id: clientMsgId,
        thread_id: threadId,
        seq: ++seq,
        author: 'owner',
        kind: 'text',
        text,
        format: 'plain',
        attachments,
        via: 'app',
        created_at: iso(),
        receipt: 'sent',
      })
      if (store.getState().presence.bridge_online) {
        setTimeout(() => {
          const reply: MessageT = {
            id: newId('m'),
            thread_id: threadId,
            seq: ++seq,
            author: 'agent',
            kind: 'text',
            text: `echo: ${text}`,
            // a fenced block echoes back as markdown, so specs can get a real code block into the timeline
            format: text.includes('```') ? 'markdown' : 'plain',
            attachments: [],
            via: 'app',
            created_at: iso(),
          }
          append(reply)
          emit('reply', { message: reply })
        }, opts.replyDelayMs ?? 0)
      }
      return { clientMsgId, state: sendState() }
    },
    async sendVoiceNote({ threadId, attachment }): Promise<SendResult> {
      const clientMsgId = newId('m')
      await owner({ type: 'voice_note', thread_id: threadId, client_msg_id: clientMsgId, attachment })
      append({
        id: clientMsgId,
        thread_id: threadId,
        seq: ++seq,
        author: 'owner',
        kind: 'voice_note',
        format: 'plain',
        attachments: [attachment],
        transcript: { text: '', engine: 'fake', status: 'pending' },
        via: 'app',
        created_at: iso(),
      })
      return { clientMsgId, state: 'sent' }
    },
    async sendVoiceAsk(args: VoiceAskArgs): Promise<SendResult> {
      await owner({
        type: 'voice.ask',
        voice_session_id: args.voiceSessionId,
        delegation_id: args.delegationId,
        thread_id: args.threadId,
        question: args.question,
        transcript_tail: args.transcriptTail,
      })
      emit('voice.state', { voice_session_id: args.voiceSessionId, state: 'delegating' })
      setTimeout(() => {
        const reply: MessageT = {
          id: newId('m'),
          thread_id: args.threadId,
          seq: ++seq,
          author: 'agent',
          kind: 'text',
          text: `echo: ${args.question}`,
          format: 'plain',
          attachments: [],
          via: 'voice',
          created_at: iso(),
        }
        append(reply)
        emit('reply', { message: reply, speak: `echo: ${args.question}`, voice_delegation_id: args.delegationId })
        emit('voice.state', { voice_session_id: args.voiceSessionId, state: 'live' })
      }, opts.replyDelayMs ?? 0)
      return { clientMsgId: args.delegationId, state: sendState() }
    },
    async resolveCard(cardId: string, input: CardResolveInput) {
      // The real client's sendAndWait refuses before anything else when the socket is down or the device is not pinned.
      if (store.getState().connection !== 'online') throw new TalosClientError('internal', "You're offline.")
      if (!store.getState().devicePinned)
        throw new TalosClientError('device_not_pinned', 'Waiting for your Mac to confirm this device.')
      const card = store.getState().cards.find((c) => c.id === cardId)
      if (card?.state !== 'pending') throw new TalosClientError('card_not_pending')
      if (Date.parse(card.expires_at) <= now()) throw new TalosClientError('card_expired')
      const binding = bindingFrom(card)
      if (input.payloadHash !== payloadHash(binding))
        throw new TalosClientError('card_hash_mismatch', 'the hash does not match what the card renders')
      if (input.edited) {
        const check = checkEditAllowed(binding, input.edited)
        if (!check.ok) throw new TalosClientError(check.code, check.reason)
        const expected = payloadHash(applyCardEdits(binding, input.edited))
        if (input.editedHash !== expected)
          throw new TalosClientError('card_hash_mismatch', 'edited_hash does not match the edits')
      }
      await owner({
        type: 'card.resolve',
        card_id: cardId,
        action: input.action,
        payload_hash: input.payloadHash,
        ...(input.edited ? { edited: input.edited } : {}),
        ...(input.editedHash ? { edited_hash: input.editedHash } : {}),
        ...(input.note ? { note: input.note } : {}),
        ...(input.choice !== undefined ? { choice: input.choice } : {}),
        ...(input.always ? { always: true } : {}),
      })
      const at = iso()
      // Like the real Mac: a killed or revised card is finished at once (nothing runs, so no result follows); only an
      // approved one stays `resolved` for the agent to report on. Fake mode skips that wait and finishes it.
      const done = input.action === 'primary'
      const next: CardT = {
        ...card,
        state: 'done',
        resolution: {
          action: input.action,
          at,
          edited: Boolean(input.edited),
          payload_hash: input.payloadHash,
          ...(input.note ? { note: input.note } : {}),
        },
        ...(done ? { result: { ok: true, text: 'Done', at } } : {}),
      }
      set((s) => ({ cards: s.cards.map((c) => (c.id === cardId ? next : c)) }))
      emit('card.update', {
        card_id: cardId,
        state: next.state,
        resolution: next.resolution,
        ...(next.result ? { result: next.result } : {}),
      })
    },
    async patchConfig(patch) {
      const shown = store.getState().config
      if (!shown) throw new TalosClientError('config_conflict')
      // the Mac's config: what the app was shown, with the webhook address the relay kept back
      const { bug_webhook_host: _host, ...rest0 } = shown
      const cfg: AgentConfigT = fakeWebhookUrl ? { ...rest0, bug_webhook_url: fakeWebhookUrl } : rest0
      if (failNext) {
        const { code, message, how } = failNext
        failNext = null
        if (how === 'not_sent') throw new NotSentError(code, message)
        if (how === 'no_answer') throw new NoAnswerError(code, message)
        throw new TalosClientError(code, message)
      }
      const check = checkConfigPatch(patch)
      if (!check.ok)
        throw new TalosClientError(
          'config_field_forbidden',
          `field ${check.path || '(patch)'} cannot be changed from the app`,
        )
      // like the relay: a webhook address it would never call is refused before it is saved
      const hook = (patch as { bug_webhook_url?: unknown }).bug_webhook_url
      if (typeof hook === 'string' && !bugWebhookUrlOk(hook))
        throw new TalosClientError('config_field_forbidden', BUG_WEBHOOK_URL_RULE)
      // the bridge's per-thread patch semantics and patch-time rules (apps/bridge/src/config-file.ts)
      const effective = Array.isArray(patch.threads)
        ? { ...patch, threads: resolveThreadsPatch(cfg.threads, patch.threads) }
        : patch
      const merged = applyMergePatch(cfg, effective) as Record<string, unknown>
      // the bridge refuses junk it would WRITE, in words (config-file.ts: sessionFieldsIssue, then dedicatedPatchIssue)
      const fields = sessionFieldsIssue(merged)
      if (fields) throw new TalosClientError('thread_session_refused', fields)
      const parsed = AgentConfig.safeParse({ ...merged, rev: cfg.rev + 1 })
      if (!parsed.success) throw new TalosClientError('bad_frame', 'the patch produces an invalid config')
      const issue = threadPatchIssue(parsed.data)
      if (issue) throw new TalosClientError('bad_frame', issue)
      const sessionIssue = dedicatedPatchIssue(cfg, parsed.data)
      if (sessionIssue) throw new TalosClientError('thread_session_refused', sessionIssue)
      // the fake Mac app always supports sub-threads (workers.json subthreads_supported)
      const subIssue = subThreadPatchIssue(cfg, parsed.data, { macSupports: true, ownFolder: true })
      if (subIssue) throw new TalosClientError('bad_frame', subIssue)
      await owner({
        type: 'config.patch',
        base_rev: cfg.rev,
        patch,
      })
      // like the bridge: trust mode on is `true`, off is no key at all
      const { trust_mode: tm, ...rest } = parsed.data
      const saved: AgentConfigT = tm === true ? { ...rest, trust_mode: true } : rest
      // what the relay keeps from devices it keeps from the fake app too: the webhook address comes back as its host only
      fakeWebhookUrl = saved.bug_webhook_url
      const next = stripDeviceHidden(saved)
      set(() => ({ config: next, threads: next.threads }))
    },
    async updateInbox(eventId, patch) {
      set((s) => ({
        inbox: s.inbox.map(
          (i): InboxItemT =>
            i.id === eventId
              ? {
                  ...i,
                  ...(patch.state ? { state: patch.state } : {}),
                  ...(patch.snoozeUntil ? { snooze_until: patch.snoozeUntil } : {}),
                }
              : i,
        ),
      }))
    },
    markThreadUnread(threadId) {
      set((s) => ({ unread: { ...s.unread, [threadId]: Math.max(1, ownValue(s.unread, threadId) ?? 0) } }))
      return true
    },
    markThreadRead(threadId, upToSeq) {
      set((s) => ({
        unread: { ...s.unread, [threadId]: 0 },
        ...(s.readUpto
          ? { readUpto: { ...s.readUpto, [threadId]: Math.max(ownValue(s.readUpto, threadId) ?? 0, upToSeq) } }
          : {}),
      }))
      return true
    },
    async loadHistory() {
      return {
        hasMore: false,
        ...(store.getState().presence.bridge_online ? {} : { unavailable: 'mac_offline' as const }),
      }
    },
    async uploadMedia(blob, meta): Promise<AttachmentRefT> {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      return {
        media_id: newId('md'),
        kind: blob.type.startsWith('audio/') ? 'voice_note' : blob.type.startsWith('image/') ? 'image' : 'file',
        role: 'attachment',
        mime: blob.type || textTypeOfFile(meta.name, '') || 'application/octet-stream',
        name: meta.name,
        size: bytes.length,
        sha256: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''),
        ...(meta.durationMs ? { duration_ms: meta.durationMs } : {}),
        ...(meta.waveform ? { waveform: meta.waveform } : {}),
      }
    },
    async signOwnerFrame(frame) {
      const key = await keyPromise
      return signOwnerFrame({ ...frame, device_id: key.deviceId }, key.privateKey)
    },
    reconnect() {},
    close() {
      session.dispose()
    },
  }
  return client
}
