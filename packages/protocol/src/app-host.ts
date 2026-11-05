// MCP Apps: what a view may say to the host (the PWA) and what the host says back. Hand-written zod for the methods
// Talos supports (the SDK's AppBridge is not used: it pulls MCP SDK v2 into the PWA). Pure parsing, no DOM.
// A view is third-party code: every parse here treats input as hostile and never throws.
import { z } from 'zod'
import { APP_MESSAGE_TEXT_MAX, APP_TOOL_INPUT_MAX, jcsAtMost } from './apps.ts'
import { HttpsUrl } from './ids.ts'

export const UI_PROTOCOL_VERSION = '2026-01-26'
/** Largest postMessage payload the host will look at (JSON.stringify length). */
export const APP_MESSAGE_MAX_CHARS = 256 * 1024

/** What a view sees when a call fails. Talos-built strings only; a server's raw error text never goes in here. */
export const AppErrorCode = z.enum([
  'view_unknown',
  'view_closed',
  'not_in_catalog',
  'cross_server',
  'not_app_visible',
  'app_only_unsupported',
  'too_large',
  'rate_limited',
  'too_many_pending',
  'needs_gesture',
  'needs_confirm',
  'mac_offline',
  'agent_declined',
  'owner_killed',
  'card_expired',
  'tool_failed',
  'timeout',
  'sig_invalid',
  'approval_changed',
  'direct_unavailable',
  'direct_auth',
])
export type AppErrorCodeT = z.infer<typeof AppErrorCode>

/** JSON-RPC error codes the host answers with. */
export const RPC_ERR = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  /** Talos failures (`data.talos` carries the AppErrorCode). */
  SERVER: -32000,
  /** A request arrived before `ui/initialize` finished. */
  NOT_INITIALIZED: -32002,
} as const

// ---- method params ------------------------------------------------------------------------------------------------

const Obj = z.record(z.string(), z.unknown())

export const UiInitializeParams = z.object({
  protocolVersion: z.string().max(40).optional(),
  appInfo: z
    .object({ name: z.string().max(120), version: z.string().max(60) })
    .partial()
    .optional(),
  appCapabilities: z.object({ availableDisplayModes: z.array(z.string().max(20)).max(8).optional() }).optional(),
})

export const ToolsCallParams = z.object({
  name: z.string().min(1).max(128),
  arguments: Obj.refine(jcsAtMost(APP_TOOL_INPUT_MAX), 'arguments too large').optional(),
  _meta: z
    .object({ progressToken: z.union([z.string().max(200), z.number()]).optional() })
    .loose()
    .optional(),
})

const TextBlock = z.object({ type: z.literal('text'), text: z.string() })
const AnyBlock = z.object({ type: z.string().max(40) }).loose()
export const UiMessageParams = z.object({
  role: z.string().max(20).optional(),
  content: z.union([AnyBlock, z.array(AnyBlock).max(20)]),
})

/**
 * Text of a `ui/message`: one block (stable text) or an array (SDK); text blocks only, joined by newline, at most 4,000
 * characters. A non-text block, an empty result or a longer one is refused (`undefined`), never trimmed to fit.
 */
export function uiMessageText(params: z.infer<typeof UiMessageParams>): string | undefined {
  const blocks = Array.isArray(params.content) ? params.content : [params.content]
  const parts: string[] = []
  for (const b of blocks) {
    const t = TextBlock.safeParse(b)
    if (!t.success) return undefined
    parts.push(t.data.text)
  }
  const text = parts.join('\n')
  if (text.length === 0 || text.length > APP_MESSAGE_TEXT_MAX) return undefined
  return text
}

export const UiOpenLinkParams = z.object({ url: HttpsUrl })
export const UiDisplayModeParams = z.object({ mode: z.enum(['inline', 'fullscreen', 'pip']) })
export const UiSizeChangedParams = z.object({
  width: z.number().finite().nonnegative().optional(),
  height: z.number().finite().nonnegative().optional(),
})
export const NotificationsMessageParams = z.object({
  level: z.string().max(20).optional(),
  logger: z.string().max(100).optional(),
  data: z.unknown().optional(),
})

/** Methods a view may send, with whether each is a request (has an id) or a notification. */
export const VIEW_METHODS = {
  'ui/initialize': { kind: 'request', params: UiInitializeParams },
  'ui/notifications/initialized': { kind: 'notification', params: Obj.optional() },
  ping: { kind: 'request', params: Obj.optional() },
  'tools/call': { kind: 'request', params: ToolsCallParams },
  'ui/message': { kind: 'request', params: UiMessageParams },
  'ui/open-link': { kind: 'request', params: UiOpenLinkParams },
  'ui/request-display-mode': { kind: 'request', params: UiDisplayModeParams },
  'ui/notifications/size-changed': { kind: 'notification', params: UiSizeChangedParams },
  'ui/notifications/request-teardown': { kind: 'notification', params: Obj.optional() },
  'notifications/message': { kind: 'notification', params: NotificationsMessageParams },
} as const
export type ViewMethod = keyof typeof VIEW_METHODS

export type ViewMessageResult =
  | { ok: true; kind: 'request'; id: string | number; method: ViewMethod; params: unknown }
  | { ok: true; kind: 'notification'; method: ViewMethod; params: unknown }
  /** `id` is set when the view asked a question and is owed an error reply. */
  | { ok: false; id?: string | number; code: number; message: string; drop?: boolean }

function jsonSize(v: unknown): number | undefined {
  try {
    return JSON.stringify(v)?.length
  } catch {
    return undefined
  }
}

/**
 * Parse one `message` event payload from a view. Never throws.
 * - not a plain JSON-RPC 2.0 object, or over 256 KiB, or unmeasurable: dropped (`drop`), no reply.
 * - unknown method: -32601 (with the request id, if it had one). Bad params: -32602.
 * - a request method sent as a notification (no id), or the reverse: dropped.
 */
export function parseViewMessage(data: unknown): ViewMessageResult {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, code: RPC_ERR.INVALID_PARAMS, message: 'not an object', drop: true }
  }
  const size = jsonSize(data)
  if (size === undefined || size > APP_MESSAGE_MAX_CHARS) {
    return { ok: false, code: RPC_ERR.INVALID_PARAMS, message: 'too large', drop: true }
  }
  const o = data as Record<string, unknown>
  if (o.jsonrpc !== '2.0' || typeof o.method !== 'string') {
    return { ok: false, code: RPC_ERR.INVALID_PARAMS, message: 'not a JSON-RPC 2.0 call', drop: true }
  }
  const hasId = Object.hasOwn(o, 'id')
  const id = o.id
  if (hasId && typeof id !== 'string' && typeof id !== 'number') {
    return { ok: false, code: RPC_ERR.INVALID_PARAMS, message: 'bad id', drop: true }
  }
  if (!Object.hasOwn(VIEW_METHODS, o.method)) {
    return hasId
      ? { ok: false, id: id as string | number, code: RPC_ERR.METHOD_NOT_FOUND, message: 'method not found' }
      : { ok: false, code: RPC_ERR.METHOD_NOT_FOUND, message: 'method not found', drop: true }
  }
  const method = o.method as ViewMethod
  const def = VIEW_METHODS[method]
  if ((def.kind === 'request') !== hasId) {
    return { ok: false, code: RPC_ERR.INVALID_PARAMS, message: 'request/notification mismatch', drop: true }
  }
  const parsed = (def.params as z.ZodType).safeParse(o.params)
  if (!parsed.success) {
    return hasId
      ? { ok: false, id: id as string | number, code: RPC_ERR.INVALID_PARAMS, message: 'invalid params' }
      : { ok: false, code: RPC_ERR.INVALID_PARAMS, message: 'invalid params', drop: true }
  }
  return hasId
    ? { ok: true, kind: 'request', id: id as string | number, method, params: parsed.data }
    : { ok: true, kind: 'notification', method, params: parsed.data }
}

// ---- ui/initialize result -----------------------------------------------------------------------------------------

/** The host's answer (M2.4). Loose: the web app adds style variables; the test parses it with the SDK's own schema. */
export const UiInitializeResult = z
  .object({
    protocolVersion: z.literal(UI_PROTOCOL_VERSION),
    hostInfo: z.object({ name: z.literal('talos-app'), version: z.string().max(60) }),
    hostCapabilities: z
      .object({
        openLinks: Obj,
        serverTools: Obj,
        logging: Obj,
        message: Obj.optional(),
        sandbox: z.object({ permissions: Obj, csp: Obj }).loose(),
      })
      .loose(),
    hostContext: Obj,
  })
  .loose()
