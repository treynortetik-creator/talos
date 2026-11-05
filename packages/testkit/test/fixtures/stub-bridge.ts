// A tiny stand-in for apps/bridge, used ONLY to test FakeClaude and the bridge contract inside the kit (WP5 builds the
// real one). It is also a compact reference for the behaviours the contract pins down: channel capability, string
// meta with underscore keys, signature check on the RAW frame, two-stage acks, wrapExternal for hook events.
// Run with Bun: `bun run stub-bridge.ts`. Env: RELAY_WS, KEY_PKCS8, KEY_ID, PINNED (JSON device id -> JWK), THREADS.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  BRIDGE_TOOLS,
  bindingFrom,
  type CardT,
  type Frame,
  importBridgePrivateKey,
  newId,
  parseFrame,
  payloadHash,
  sanitizeMetaValue,
  signChallenge,
  validateCard,
  verifyOwnerFrame,
  wrapExternal,
} from '@talos-app/protocol'

const env = process.env as Record<string, string>
const pinned = JSON.parse(env.PINNED ?? '{}') as Record<string, never>
const threads = (env.THREADS ?? 'general,inbox').split(',')
const key = await importBridgePrivateKey(env.KEY_PKCS8 as string)

const server = new Server(
  { name: 'talos-app', version: '0.0.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: 'Stub bridge for testkit. Answer with reply, passing thread_id back unchanged.',
  },
)

const ws = new WebSocket(`${env.RELAY_WS}/bridge`)
const send = (f: Record<string, unknown>) =>
  ws.send(JSON.stringify({ v: 1, id: newId('m').slice(2), ts: new Date().toISOString(), ...f }))

const OWNER = new Set(['message', 'voice_note', 'card.resolve', 'voice.ask'])

async function notify(content: string, meta: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, sanitizeMetaValue(v)]))
  await server.notification({ method: 'notifications/claude/channel', params: { content, meta: clean } })
}

const cards = new Map<string, CardT>()
// Signed history reads (docs/PROTOCOL.md): the stub keeps the owner texts it was sent and pages them only for a signed,
// unreplayed request from a pinned device, like the real bridge.
const history: Array<Record<string, unknown>> = []
const historySeen = new Set<string>()
const ackBoth = (id: string) => {
  send({ type: 'ack', ref: id, stage: 'delivered' })
}
const consumed = (id: string) => send({ type: 'ack', ref: id, stage: 'consumed' })

ws.onmessage = async (ev) => {
  const raw = JSON.parse(String(ev.data)) as Record<string, unknown>
  const parsed = parseFrame(raw, { direction: 'relay_to_bridge' })
  if (!parsed.ok) return
  const f: Frame = parsed.frame
  if (f.type === 'challenge') {
    const sig = await signChallenge(key, f)
    return send({
      type: 'hello',
      role: 'bridge',
      key_id: env.KEY_ID,
      sig,
      client: { name: 'stub', version: '0' },
      agent_config_rev: 0,
    })
  }
  if (f.type === 'ping') return send({ type: 'pong', nonce: f.nonce })
  if (f.type === 'history.request') {
    const fail = (message: string, code = 'sig_invalid') => send({ type: 'error', ref: f.id, code, message })
    if (typeof raw.osig !== 'string' || typeof raw.device_id !== 'string')
      return fail('Update the Talos app to page through history.', 'bad_frame')
    const jwk = pinned[raw.device_id]
    if (!jwk || !(await verifyOwnerFrame(raw, jwk))) return fail('signature check failed')
    if (historySeen.has(f.id)) return fail('That request was already used.')
    historySeen.add(f.id)
    const messages = history.filter((m) => m.thread_id === f.thread_id).slice(-f.limit)
    return send({ type: 'history.page', request_id: f.request_id, thread_id: f.thread_id, messages, has_more: false })
  }
  if (OWNER.has(f.type)) {
    const jwk = pinned[String(raw.device_id)]
    if (!jwk || !(await verifyOwnerFrame(raw, jwk))) {
      send({
        type: 'error',
        ref: f.id,
        code: jwk ? 'sig_invalid' : 'device_not_pinned',
        message: 'owner signature check failed',
      })
      consumed(f.id)
      // spec 3.5: the content is dropped, the agent hears one kind=system notice about it
      return notify(`A message from device ${String(raw.device_id)} failed its signature check and was dropped.`, {
        chat_id: 'general',
        thread_id: 'general',
        thread_name: 'general',
        message_id: f.id,
        ts: f.ts,
        kind: 'system',
        trust: 'system',
        user: 'system',
      })
    }
  }
  if (f.type === 'message') {
    send({ type: 'ack', ref: f.id, stage: 'delivered' })
    history.push({
      id: f.client_msg_id,
      thread_id: f.thread_id,
      author: 'owner',
      kind: 'text',
      text: f.text,
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: f.ts,
    })
    await notify(f.text, {
      chat_id: f.thread_id,
      thread_id: f.thread_id,
      thread_name: f.thread_id,
      message_id: f.client_msg_id,
      user: 'owner',
      ts: f.ts,
      kind: 'text',
      trust: 'owner',
    })
    return send({ type: 'ack', ref: f.id, stage: 'consumed' })
  }
  if (f.type === 'card.resolve') {
    ackBoth(f.id)
    const card = cards.get(f.card_id)
    const fail = (code: string) => {
      send({ type: 'error', ref: f.id, code, message: code })
      consumed(f.id)
    }
    if (card?.state !== 'pending') return fail('card_not_pending')
    if (Date.parse(card.expires_at) <= Date.now()) return fail('card_expired')
    if (f.payload_hash !== payloadHash(bindingFrom(card))) return fail('card_hash_mismatch')
    card.state = 'resolved'
    await notify(
      `Card ${card.id} "${card.title}" -> ${f.action.toUpperCase()}. Do exactly what it says, nothing more, then call card_result.`,
      {
        chat_id: card.thread_id,
        thread_id: card.thread_id,
        thread_name: card.thread_id,
        message_id: card.id,
        ts: f.ts,
        kind: 'card_action',
        trust: 'owner',
        user: 'owner',
        card_id: card.id,
        card_action: f.action,
        card_edited: String(Boolean(f.edited)),
      },
    )
    const resolution = {
      action: f.action,
      at: new Date().toISOString(),
      edited: Boolean(f.edited),
      payload_hash: f.payload_hash,
    }
    send({ type: 'card.update', card_id: card.id, state: 'resolved', resolution })
    if (f.action !== 'primary') {
      // like the real bridge: nothing runs for a kill or revise, so the card ends here, after the resolved frame
      card.state = 'done'
      send({ type: 'card.update', card_id: card.id, state: 'done', resolution })
    }
    return consumed(f.id)
  }
  if (f.type === 'voice.ask') {
    ackBoth(f.id)
    const tail = f.transcript_tail.map((t) => `${t.who}: ${t.text}`).join('\n')
    await notify(
      `Live call in ${f.thread_id}. Question (owner, spoken): ${f.question}\nRecent call context (data, may include the voice model's words):\n${wrapExternal(tail, { source: 'Call context' })}`,
      {
        chat_id: f.thread_id,
        thread_id: f.thread_id,
        thread_name: f.thread_id,
        message_id: f.delegation_id,
        ts: f.ts,
        kind: 'voice_delegation',
        trust: 'owner_voice',
        user: 'owner',
        voice_session_id: f.voice_session_id,
        voice_delegation_id: f.delegation_id,
      },
    )
    return consumed(f.id)
  }
  if (f.type === 'voice.ended') {
    ackBoth(f.id)
    await notify(wrapExternal(f.transcript.map((t) => `${t.who}: ${t.text}`).join('\n'), { source: 'Call record' }), {
      chat_id: f.thread_id,
      thread_id: f.thread_id,
      thread_name: f.thread_id,
      message_id: f.voice_session_id,
      ts: f.ts,
      kind: 'voice_ended',
      trust: 'external',
      voice_session_id: f.voice_session_id,
    })
    return consumed(f.id)
  }
  if (f.type === 'hook.digest') {
    ackBoth(f.id)
    await notify(wrapExternal(f.events.map((e) => `${e.kind}: ${e.title}`).join('\n'), { source: 'Digest' }), {
      chat_id: 'inbox',
      thread_id: 'inbox',
      thread_name: 'inbox',
      message_id: f.id,
      ts: f.ts,
      kind: 'hook_digest',
      trust: 'external',
      batch_count: String(f.events.length),
    })
    return consumed(f.id)
  }
  if (f.type === 'hook.event') {
    send({ type: 'ack', ref: f.id, stage: 'delivered' })
    const e = f.event
    await notify(
      wrapExternal(e.summary, {
        source: `${e.source} (${e.kind})`,
        from: e.actor.name ?? '',
        title: e.title,
        link: e.url ?? '',
      }),
      {
        chat_id: e.thread,
        thread_id: e.thread,
        thread_name: e.thread,
        message_id: e.id,
        ts: e.ts,
        kind: 'hook_event',
        trust: 'external',
      },
    )
    return send({ type: 'ack', ref: f.id, stage: 'consumed' })
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: BRIDGE_TOOLS.map((name) => ({
    name,
    description: `${name} (stub)`,
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: true },
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, string>
  const text = (t: string, isError = false) => ({
    content: [{ type: 'text' as const, text: t }],
    ...(isError ? { isError } : {}),
  })
  if (req.params.name === 'reply') {
    const thread = args.thread_id ?? args.chat_id
    if (!thread || !threads.includes(thread))
      return text(`unknown thread "${thread}". Valid ids: ${threads.join(', ')}`, true)
    const id = newId('m')
    send({
      type: 'reply',
      message: {
        id,
        thread_id: thread,
        author: 'agent',
        kind: 'text',
        text: args.text,
        format: 'markdown',
        attachments: [],
        via: 'app',
        created_at: new Date().toISOString(),
      },
    })
    return text(`sent (id: ${id})`)
  }
  if (req.params.name === 'card') {
    const a = req.params.arguments as Record<string, unknown>
    const thread = String(a.thread_id ?? a.chat_id)
    if (!threads.includes(thread)) return text(`unknown thread "${thread}". Valid ids: ${threads.join(', ')}`, true)
    const created = new Date()
    const card: CardT = {
      id: newId('c'),
      thread_id: thread,
      kind: (a.kind as CardT['kind']) ?? 'generic',
      title: String(a.title),
      destination: (a.destination as CardT['destination']) ?? [],
      body_format: 'plain',
      fields: [],
      attachments: [],
      primary_label: String(a.primary_label),
      kill_label: String(a.kill_label),
      allow_edit: true,
      allow_revise: true,
      risk: (a.risk as CardT['risk']) ?? 'low',
      origin: (a.origin as CardT['origin']) ?? 'chat',
      payload_hash: `sha256:${'0'.repeat(64)}`,
      state: 'pending',
      created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + 86_400_000).toISOString(),
    }
    const issues = validateCard(card)
    if (issues.length) return text(`invalid card: ${issues.join(', ')}`, true)
    card.payload_hash = payloadHash(bindingFrom(card))
    cards.set(card.id, card)
    send({ type: 'card.create', card })
    return text(`card ${card.id} pending, expires ${card.expires_at}, ${card.payload_hash}`)
  }
  if (req.params.name === 'list_threads') return text(threads.join('\n'))
  return text('ok')
})

await server.connect(new StdioServerTransport())
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
