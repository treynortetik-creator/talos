// The mod's side of the bridge link (docs/CLAUDE-CODE.md C2.3). One timer, `$.clock.every(2000)`, never an event hook
// (`$.command.run` rejects inside a hook the turn is waiting on, and a hook that waits on the bridge would stall the
// turn). Each tick: connect if not connected (hello, retried with backoff while the bridge's MCP server comes up),
// then one `talos_mod_sync` carrying whatever changed. The bridge answers at once; there is no long poll.
//
// The key is the bridge's 0600 file, read with `$.fs`. It never travels: hello sends HMAC(key, "hello\n" + ts) and each
// sync sends HMAC(key, "sync\n" + seq + "\n" + canonical body) in `mod_key`, so a plugin whose `mcp.call` hook sees the
// arguments sees data and a MAC, not the key, and can neither forge nor replay a call (the mod's own hooks are skipped for
// its own calls, so a hook of the mod cannot add a secret afterwards; that is why it is a MAC). The key lives in one
// private field here: not in `$.state`, `$.store`, a status line, a log line, an event or a tool result.
import { type AgentsCollector, agentsDigest } from './agents.ts'
import type { Capability } from './capabilities.ts'
import type { EngineLike, McpResultLike } from './engine.ts'
import type { EventQueue, QueuedEvent, SessionFlags, TimeSource } from './events.ts'
import { canonicalJson, hmacB64url } from './hash.ts'
import { bridgeServerOf, buildInventory } from './inventory.ts'
import { buildState } from './state.ts'

export const SYNC_EVERY_MS = 2000
export const INVENTORY_EVERY_MS = 30_000
/**
 * An unchanged agents snapshot still goes again this often (review R2): if the bridge dropped one (it did not parse
 * there), the bridge's copy is not stuck on an older one for good. The bridge re-emits only on a change.
 */
export const AGENTS_REFRESH_MS = 30_000
/** Reported only to a bridge whose hello listed `agents` (review R1): a bridge from before A0 refuses a state naming them. */
const AGENTS_CAPS: ReadonlySet<Capability> = new Set<Capability>(['agents', 'agent_stop'])
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000] as const
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/

export type Control = { control_id?: unknown; [k: string]: unknown }
export type ControlResult = { control_id: string; ok: boolean; code?: string; text: string }
/**
 * WP-C3's executor (controls.ts). It returns the results it knows at once (refusals) and reports slow ones later through
 * `BridgeLink.reportResult`, so a command waiting on the Mac never blocks the 2 s tick. Without one every control is
 * answered "cannot do that" so the phone never hangs.
 */
export type ControlHandler = (controls: Control[]) => Promise<ControlResult[]>

export type LinkStatus = 'idle' | 'connecting' | 'connected' | 'backoff'

const textOf = (r: McpResultLike | undefined): string =>
  (Array.isArray(r?.content) ? r.content : [])
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('')

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export class BridgeLink {
  private connected = false
  private key: string | undefined
  private seq = 0
  private server: string | undefined
  private running = false
  private nextAttemptAt = 0
  private failures = 0
  private sentStateJson: string | undefined
  private sentInventoryDigest: string | undefined
  private lastInventoryAt = Number.NEGATIVE_INFINITY
  private results: ControlResult[] = []
  /** The bridge said at hello that it takes `agents` (its MAC covers the member; an older bridge's would not). */
  private bridgeAgents = false
  private sentAgentsDigest: string | undefined
  private sentAgentsAt = Number.NEGATIVE_INFINITY
  status: LinkStatus = 'idle'

  constructor(
    private readonly $: EngineLike,
    private readonly flags: SessionFlags,
    private readonly events: EventQueue,
    private readonly caps: { capabilities: Capability[]; version: string },
    private readonly time: TimeSource,
    private readonly handleControls?: ControlHandler,
    /** Runs at the top of every tick, connected or not (WP-C3: a compact that was waiting for the turn to end). */
    private readonly onTick?: () => Promise<void>,
    /** docs/SUBAGENTS.md: the agents collector; absent without `$.agent.list`. */
    private readonly agents?: AgentsCollector,
  ) {}

  /** A result that arrives after the controls call returned; sent with the next sync. One result per control_id. */
  reportResult(r: ControlResult): void {
    if (!this.results.some((x) => x.control_id === r.control_id)) this.results.push(r)
  }

  /** Starts the one timer and ticks once now. The caller keeps no handle: a reload starts the module over. */
  start(): void {
    this.$.clock.every(SYNC_EVERY_MS, () => void this.tick())
    void this.tick()
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      this.time.set(await this.$.clock.now())
      try {
        await this.onTick?.() // never throws out of the tick: the sync below must still go
      } catch {
        // a failed deferred action is not a link failure
      }
      if (!this.connected) {
        if (this.time.now() < this.nextAttemptAt) {
          this.status = 'backoff'
          return
        }
        await this.connect()
        if (!this.connected) return
      }
      await this.syncOnce()
    } catch {
      this.fail()
    } finally {
      this.running = false
    }
  }

  private fail(): void {
    this.status = 'backoff'
    const step = Math.min(this.failures, BACKOFF_MS.length - 1)
    this.failures++
    this.nextAttemptAt = this.time.now() + (BACKOFF_MS[step] ?? 30_000)
  }

  private forgetKey(): void {
    this.connected = false
    this.key = undefined
    this.sentStateJson = undefined
    this.sentInventoryDigest = undefined
    this.lastInventoryAt = Number.NEGATIVE_INFINITY
    this.sentAgentsDigest = undefined // a new hello gets the agents snapshot again in full
    this.sentAgentsAt = Number.NEGATIVE_INFINITY
    this.bridgeAgents = false
  }

  private async connect(): Promise<void> {
    this.status = 'connecting'
    const tools = await this.$.tool.list()
    this.server = bridgeServerOf(Array.isArray(tools) ? tools : [])
    if (!this.server) return this.fail() // the bridge's MCP server is not connected yet
    const key = await this.$.secret.read()
    if (!KEY_SHAPE.test(key)) return this.fail()
    const ts = Math.floor(this.time.now())
    const proof = await hmacB64url(key, `hello\n${ts}`) // evidence of the file, not the file
    const res = await this.$.mcp.call(this.server, 'talos_mod_hello', { ts, proof })
    if (!res || res.isError) return this.fail() // "a mod is already connected": the old one's 30 s must run out
    const answer = parseJson(textOf(res))
    if (answer?.ok !== true) return this.fail()
    // An older bridge MACs only the members it knows: sending it `agents` would fail every sync as unauthorized.
    this.bridgeAgents = Array.isArray(answer.features) && answer.features.includes('agents')
    const next = await this.$.secret.read() // hello rotated the key
    if (!KEY_SHAPE.test(next)) return this.fail()
    this.key = next
    this.seq = 0
    this.connected = true
    this.failures = 0
    this.status = 'connected'
  }

  private async syncOnce(): Promise<void> {
    if (!this.connected || !this.server || !this.key) return
    const now = this.time.now()
    const args: Record<string, unknown> = {}

    const caps = this.bridgeAgents ? this.caps.capabilities : this.caps.capabilities.filter((c) => !AGENTS_CAPS.has(c))
    const state = await buildState(this.$, this.flags, caps, this.caps.version)
    let stateJson: string | undefined
    if (state) {
      const { at: _at, ...rest } = state
      stateJson = JSON.stringify(rest)
      if (stateJson !== this.sentStateJson) args.state = state
    }

    let agentsDigestNow: string | undefined
    if (this.agents && this.bridgeAgents && state) {
      try {
        const snap = await this.agents.snapshot(state.session_id, now)
        const d = agentsDigest(snap)
        if (snap && (d !== this.sentAgentsDigest || now - this.sentAgentsAt >= AGENTS_REFRESH_MS)) {
          args.agents = snap
          agentsDigestNow = d
        }
      } catch {
        // the panel is best-effort: a collector failure never costs the sync
      }
    }

    let inventoryDigest: string | undefined
    if (now - this.lastInventoryAt >= INVENTORY_EVERY_MS) {
      const built = await buildInventory(this.$)
      this.lastInventoryAt = now
      if (built && built.digest !== this.sentInventoryDigest) {
        args.inventory = built.inventory
        inventoryDigest = built.digest
      }
    }

    const events: QueuedEvent[] = this.events.drain()
    if (events.length > 0) args.events = events
    const results = this.results.splice(0, 50) // the schema's cap per sync; the rest go next time
    if (results.length > 0) args.results = results

    let res: McpResultLike | undefined
    try {
      const seq = ++this.seq
      const signed = { ...args, seq, mod_key: await hmacB64url(this.key, `sync\n${seq}\n${canonicalJson(args)}`) }
      res = await this.$.mcp.call(this.server, 'talos_mod_sync', signed)
    } catch (e) {
      this.requeue(events, results, 'inventory' in args)
      this.flags.noteRefusal(e instanceof Error ? e.message : e)
      throw e
    }
    const text = textOf(res)
    if (!res || res.isError) {
      this.requeue(events, results, 'inventory' in args)
      if (text.includes('unauthorized')) {
        this.forgetKey() // the bridge restarted or the mod reloaded: say hello again on the next tick, no backoff
        this.status = 'idle'
        return
      }
      return this.fail()
    }
    this.failures = 0
    this.status = 'connected'
    if ('state' in args) this.sentStateJson = stateJson
    if (inventoryDigest !== undefined) this.sentInventoryDigest = inventoryDigest
    if (agentsDigestNow !== undefined) {
      this.sentAgentsDigest = agentsDigestNow
      this.sentAgentsAt = now
    }
    const controls = parseJson(text)?.controls
    if (Array.isArray(controls) && controls.length > 0) await this.takeControls(controls as Control[])
  }

  private requeue(events: QueuedEvent[], results: ControlResult[], inventoryLost: boolean): void {
    if (inventoryLost) this.lastInventoryAt = Number.NEGATIVE_INFINITY // build and send it again next time
    this.events.requeue(events)
    this.results.unshift(...results)
  }

  private async takeControls(controls: Control[]): Promise<void> {
    if (this.handleControls) {
      try {
        for (const r of await this.handleControls(controls)) this.reportResult(r)
      } catch {
        // the handler answers per control and should not throw; if it does, no control goes unanswered
        for (const c of controls)
          if (typeof c.control_id === 'string')
            this.reportResult({
              control_id: c.control_id,
              ok: false,
              code: 'internal',
              text: 'The mod could not run that.',
            })
      }
      return
    }
    for (const c of controls) {
      if (typeof c.control_id !== 'string') continue
      this.results.push({
        control_id: c.control_id,
        ok: false,
        code: 'capability_missing',
        text: 'This Talos mod cannot do that.',
      })
    }
  }
}
