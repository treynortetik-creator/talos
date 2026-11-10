// In-memory TalosClient seeded from the protocol fixtures. Seam: frozen after WP0 (WP8 may edit).
// Used by WP4 and WP7 (`VITE_FAKE=1`) and by WP6 until the socket client lands. It behaves like a Mac that is online and,
// importantly, as strictly as the spec: the checks WP7's acceptance tests exercise (hash, step-up, state, expiry, edit
// rules, config allowlist, config_conflict) really reject, so those tests cannot pass vacuously.

import { listSetupSpecs } from '@talos-app/integrations/catalog'
import {
  AgentConfig,
  type AgentConfigT,
  type AttachmentRefT,
  applyCardEdits,
  applyMergePatch,
  bindingFrom,
  Card,
  type CardT,
  checkConfigPatch,
  checkEditAllowed,
  createDeviceKey,
  dedicatedPatchIssue,
  type ErrorCodeT,
  type FrameOf,
  type FrameType,
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
  sessionFieldsIssue,
  signOwnerFrame,
  textTypeOfFile,
  threadPatchIssue,
  trustOn,
} from '@talos-app/protocol'
import cardFixture from '@talos-app/protocol/fixtures/frames/card.create.json'
import inboxFixture from '@talos-app/protocol/fixtures/frames/inbox.item.json'
import readyFixture from '@talos-app/protocol/fixtures/frames/ready.json'
import { createStore } from 'zustand/vanilla'
import {
  type CardResolveInput,
  type ClientState,
  initialClientState,
  type SendResult,
  type TalosApi,
  type TalosClient,
  TalosClientError,
  type VoiceAskArgs,
} from './client.ts'
import { createFakeSchedules, type FakeSchedulesClient } from './fakeSchedules.ts'
import { createFakeSession, type FakeAgentsMode, type FakeModMode, type FakeSession } from './fakeSession.ts'
import {
  createFakeFolders,
  createFakeMemory,
  createFakeSearch,
  createFakeSpeak,
  type FakeFolders,
  type FakeFolderTree,
} from './fakeV2.ts'
import { PasskeyUnavailableError, passkeyBlock } from './passkeyGate.ts'
import type { FolderClient, MemoryClient, SearchClient, SpeakClient } from './v2Client.ts'

export type FakeClientOptions = {
  /** Milliseconds before the fake agent answers. 0 = next tick. */
  replyDelayMs?: number
  /** Start with the Mac offline (presence.bridge_online=false). */
  macOffline?: boolean
  now?: () => number
  /** CC-C3: the scripted Claude Code session. 'live' (default), 'offline' (mod lapsed) or 'absent' (no mod ever). */
  mod?: FakeModMode
  /** docs/SUBAGENTS.md: the agents snapshot the fake mod sends ('none' by default: a mod without `agents`). */
  agents?: FakeAgentsMode
  /** The folders the fake Mac lists for the folder picker. Default: a small made-up home (`/Users/alex`). */
  folders?: FakeFolderTree
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
        'schedules/1',
        'schedules/2',
        'heartbeat/1',
        'session/1',
        'driving/1',
        'search/1',
        'memory/1',
        'threads/2',
        'speak/1',
        'folders/1',
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
  /** The next `patchConfig` rejects with this code (simulate `config_conflict` and friends), then behaves again. */
  failNextPatchWith(code: ErrorCodeT, message?: string): void
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
  const stepups = new Map<string, string>()
  const listeners = new Map<string, Set<(f: never) => void>>()
  let seq = state.lastSeq
  let failNext: { code: ErrorCodeT; message?: string } | null = null
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

  const consumeStepup = (token: string | undefined, purpose: string) => {
    if (!token) throw new TalosClientError('stepup_required', `step-up ${purpose} required`)
    if (stepups.get(token) !== purpose)
      throw new TalosClientError('stepup_invalid', 'step-up token is invalid for this purpose')
    stepups.delete(token)
  }

  // ---- HTTP API (in memory) ------------------------------------------------------------------------------------
  type Conn = RouteRes<'connectionGet'>
  const conns = new Map<string, Conn>()
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
        }
        conns.set(id, conn)
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
      async credentials(id) {
        findConn(id)
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
    fakeFolders,
    speak: createFakeSpeak({
      messages: () => store.getState().messages,
      macOnline: () => store.getState().presence.bridge_online,
    }),
    async publicJwk() {
      return (await keyPromise).publicJwk
    },
    failNextPatchWith(code, message) {
      failNext = { code, ...(message ? { message } : {}) }
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
      if (card.risk === 'high' && input.action === 'primary') consumeStepup(input.stepupToken, `card:${card.id}`)
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
    async patchConfig(patch, popts) {
      const cfg = store.getState().config
      if (!cfg) throw new TalosClientError('config_conflict')
      if (failNext) {
        const { code, message } = failNext
        failNext = null
        throw new TalosClientError(code, message)
      }
      const check = checkConfigPatch(patch)
      if (!check.ok)
        throw new TalosClientError(
          'config_field_forbidden',
          `field ${check.path || '(patch)'} cannot be changed from the app`,
        )
      // like the relay: trust mode (the synced config) drops these two passkey steps, except turning trust mode ON, which
      // always asks
      if (check.touchesWorkEnabled && !trustOn(cfg)) consumeStepup(popts?.stepupToken, 'config:work')
      if (check.stepupPurpose === 'config:session' && (check.turnsOnTrust || !trustOn(cfg)))
        consumeStepup(popts?.stepupToken, 'config:session')
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
      await owner({
        type: 'config.patch',
        base_rev: cfg.rev,
        patch,
        ...(popts?.stepupToken ? { stepup_token: popts.stepupToken } : {}),
      })
      // like the bridge: trust mode on is `true`, off is no key at all
      const { trust_mode: tm, ...rest } = parsed.data
      const next: AgentConfigT = tm === true ? { ...rest, trust_mode: true } : rest
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
    async stepup(purpose) {
      // The fake refuses what the real client refuses: a shell with no passkey cannot step up (WP-I6).
      const blocked = await passkeyBlock()
      if (blocked) throw new PasskeyUnavailableError(blocked)
      const token = `st_fake_${newUlid()}`
      stepups.set(token, purpose)
      return token
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
