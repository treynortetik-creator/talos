// A ready-to-use `RelayServices` for unit tests of any relay module (WP1-WP4 share it, so nobody builds a fourth fake bus):
//  - in-memory SQLite with the real migration runner applied (`migrations/<module>/*.sql`),
//  - a recording `Bus` you can inject app and bridge frames into and read what a module sent,
//  - a recording push sink, a fake clock, the production AES-256-GCM `crypto`, an in-memory media store, a recording logger.
import { createHash } from 'node:crypto'
import type { AgentConfigT, AttachmentRefT, Frame, FrameOf, FrameType, PushIntent } from '@talos-app/protocol'
import { newId, parseFrame } from '@talos-app/protocol'
import { type FakeClock, fakeClock, loadExampleConfig } from '@talos-app/testkit'
import Database from 'better-sqlite3'
import { createCryptoService } from '../../src/core/crypto.ts'
import { loadEnv, type RelayEnv } from '../../src/env.ts'
import { type MigrateOptions, migrate } from '../../src/migrate.ts'
import type { AppFrameContext, BridgeFrameContext, Bus, Logger, RelayServices } from '../../src/services.ts'

export type SentFrame = { frame: Record<string, unknown>; opts?: object }
export type LogLine = { level: 'debug' | 'info' | 'warn' | 'error'; obj: object | string; msg?: string }

export class RecordingBus implements Bus {
  readonly toAppsLog: SentFrame[] = []
  readonly toBridgeLog: SentFrame[] = []
  private online = false
  private appHandlers = new Map<string, Array<(f: never, c: AppFrameContext) => void | Promise<void>>>()
  private bridgeHandlers = new Map<string, Array<(f: never, c: BridgeFrameContext) => void | Promise<void>>>()

  private onceKeys = new Set<string>()
  async toApps(frame: Record<string, unknown>, opts?: { durable?: boolean; onlyDeviceId?: string; once?: string }) {
    if (opts?.durable && opts.once) {
      if (this.onceKeys.has(opts.once)) return
      this.onceKeys.add(opts.once)
    }
    this.toAppsLog.push({ frame, ...(opts ? { opts } : {}) })
  }
  async toBridge(frame: Record<string, unknown>, opts: { durable: boolean; ttl_s?: number; resume?: boolean }) {
    this.toBridgeLog.push({ frame, opts })
    return { queued: !this.online }
  }
  onAppFrame<T extends FrameType>(type: T, handler: (frame: FrameOf<T>, ctx: AppFrameContext) => void | Promise<void>) {
    this.appHandlers.set(type, [...(this.appHandlers.get(type) ?? []), handler as never])
  }
  onBridgeFrame<T extends FrameType>(
    type: T,
    handler: (frame: FrameOf<T>, ctx: BridgeFrameContext) => void | Promise<void>,
  ) {
    this.bridgeHandlers.set(type, [...(this.bridgeHandlers.get(type) ?? []), handler as never])
  }
  bridgeOnline() {
    return this.online
  }
  revalidations = 0
  revalidateApps() {
    this.revalidations++
  }
  setBridgeOnline(v: boolean) {
    this.online = v
  }

  /** Parses `raw` (must be valid for the direction) and runs the handlers a module registered for its type. */
  async injectAppFrame(
    raw: Record<string, unknown>,
    ctx: Partial<AppFrameContext> = {},
  ): Promise<Record<string, unknown>[]> {
    const parsed = parseFrame(raw, { direction: 'app_to_relay' })
    if (!parsed.ok) throw new Error(`injectAppFrame: ${parsed.message}`)
    const replies: Record<string, unknown>[] = []
    const full: AppFrameContext = { socketId: 's1', deviceId: null, raw, reply: (f) => void replies.push(f), ...ctx }
    for (const h of this.appHandlers.get(parsed.frame.type) ?? []) await h(parsed.frame as never, full)
    return replies
  }
  async injectBridgeFrame(
    raw: Record<string, unknown>,
    ctx: Partial<BridgeFrameContext> = {},
  ): Promise<Record<string, unknown>[]> {
    const parsed = parseFrame(raw, { direction: 'bridge_to_relay' })
    if (!parsed.ok) throw new Error(`injectBridgeFrame: ${parsed.message}`)
    const replies: Record<string, unknown>[] = []
    const full: BridgeFrameContext = { keyId: '0000000000000000', raw, reply: (f) => void replies.push(f), ...ctx }
    for (const h of this.bridgeHandlers.get(parsed.frame.type) ?? []) await h(parsed.frame as never, full)
    return replies
  }
  handlersFor(type: string) {
    return { app: this.appHandlers.get(type)?.length ?? 0, bridge: this.bridgeHandlers.get(type)?.length ?? 0 }
  }
}

export type FakeServices = {
  services: RelayServices
  db: Database.Database
  bus: RecordingBus
  clock: FakeClock
  push: { intents: PushIntent[] }
  media: Map<string, { bytes: Uint8Array; mime: string; name: string; sha256: string }>
  logs: LogLine[]
  setAgentConfig(c: AgentConfigT | null): void
}

export const TEST_DATA_KEY = Buffer.alloc(32, 9).toString('base64')

export function testEnv(over: Record<string, string> = {}): RelayEnv {
  return loadEnv({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'https://relay.example.com',
    RP_ID: 'relay.example.com',
    DATA_KEY: TEST_DATA_KEY,
    LOG_LEVEL: 'silent',
    ...over,
  })
}

export function createFakeServices(
  opts: { env?: Record<string, string>; migrate?: boolean | MigrateOptions } = {},
): FakeServices {
  const db = new Database(':memory:')
  if (opts.migrate !== false) migrate(db, typeof opts.migrate === 'object' ? opts.migrate : {})
  const env = testEnv(opts.env)
  const clock = fakeClock()
  const bus = new RecordingBus()
  const logs: LogLine[] = []
  const log: Logger = {
    debug: (obj, msg) => void logs.push({ level: 'debug', obj, ...(msg ? { msg } : {}) }),
    info: (obj, msg) => void logs.push({ level: 'info', obj, ...(msg ? { msg } : {}) }),
    warn: (obj, msg) => void logs.push({ level: 'warn', obj, ...(msg ? { msg } : {}) }),
    error: (obj, msg) => void logs.push({ level: 'error', obj, ...(msg ? { msg } : {}) }),
    child: () => log,
  }
  const media = new Map<string, { bytes: Uint8Array; mime: string; name: string; sha256: string }>()
  const push = { intents: [] as PushIntent[] }
  let config: AgentConfigT | null = loadExampleConfig('default')
  const services: RelayServices = {
    db,
    bus,
    push: { notify: async (i) => void push.intents.push(i) },
    media: {
      put: async ({ bytes, mime, name, durationMs }) => {
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const media_id = newId('md')
        media.set(media_id, { bytes, mime, name, sha256 })
        const ref: AttachmentRefT = {
          media_id,
          kind: 'file',
          role: 'attachment',
          mime,
          name,
          size: bytes.length,
          sha256,
          ...(durationMs ? { duration_ms: durationMs } : {}),
        }
        return ref
      },
      get: async (id) => media.get(id) ?? null,
      remove: async (id) => void media.delete(id),
    },
    crypto: createCryptoService(env.DATA_KEY), // the production implementation, so tests share its refusals
    agentConfig: () => config,
    clock,
    log,
    env,
  }
  return {
    services,
    db,
    bus,
    clock,
    push,
    media,
    logs,
    setAgentConfig: (c) => {
      config = c
    },
  }
}

export type { Frame }
