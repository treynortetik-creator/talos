// Signed bridge HTTP API (spec 3.8, 5.4). Every call carries `Authorization: TalosBridge ...` over the exact body bytes.
// The live bridge uses it as a fallback when the socket is down; headless processes and the CLI use nothing else.
import {
  type Frame,
  type PeerCreatedT,
  PeerLinkState,
  type PeerLinkStateT,
  type PeerRow,
  RELAY_DESCRIPTOR_PATH,
  RelayDescriptorRead,
  type RelayDescriptorReadT,
  signBridgeHttp,
} from '@talos-app/protocol'
import type { z } from 'zod'
import { assertSecureRelayUrl } from './config.ts'
import type { KeyMaterial } from './keys.ts'

export type PeerRowT = z.infer<typeof PeerRow>
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** The reason a relay error body carries (`{message}` or `{error}`), one clean line of at most 200 characters. */
async function relayReason(res: Response): Promise<string | undefined> {
  try {
    const b = (await res.json()) as { message?: unknown; error?: unknown }
    const t = typeof b.message === 'string' ? b.message : typeof b.error === 'string' ? b.error : ''
    // terminal control characters out of relay text, then one trimmed line
    const clean = Array.from(t, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
      .join('')
      .trim()
      .slice(0, 200)
    return clean || undefined
  } catch {
    return undefined
  }
}

export class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The relay's own reason (`message`, else `error`), cleaned and cut; shown to the owner by the CLI. */
    readonly detail?: string,
    /** The relay's `Date` header as epoch ms, when it sent one: lets a 401 be told apart from a clock that is off. */
    readonly serverDate?: number,
  ) {
    super(message)
  }
}

/** The response's Date header as epoch ms; undefined when absent or unreadable. */
export function responseDate(res: Response): number | undefined {
  const t = Date.parse(res.headers.get('date') ?? '')
  return Number.isFinite(t) ? t : undefined
}

export class RelayHttp {
  constructor(
    private readonly baseUrl: string,
    private readonly getKey: () => KeyMaterial,
    private readonly fetchFn: FetchFn = (i, init) => fetch(i, init),
    private readonly timeoutMs = 15_000,
  ) {}

  async request(
    method: string,
    pathWithQuery: string,
    body?: Uint8Array | string,
    headers: Record<string, string> = {},
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Response> {
    assertSecureRelayUrl(this.baseUrl)
    const key = this.getKey()
    const auth = await signBridgeHttp({
      privateKey: key.privateKey,
      keyId: key.keyId,
      method,
      pathWithQuery,
      ...(body !== undefined ? { body } : {}),
    })
    const init: RequestInit = {
      method,
      headers: { authorization: auth, ...headers },
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
    }
    if (body !== undefined) init.body = body as BodyInit
    return this.fetchFn(`${this.baseUrl}${pathWithQuery}`, init)
  }

  private async json<T>(method: string, path: string, payload: unknown): Promise<T> {
    const res = await this.request(method, path, JSON.stringify(payload), { 'content-type': 'application/json' })
    if (!res.ok)
      throw new RelayHttpError(
        res.status,
        `${method} ${path.split('?')[0]} -> ${res.status}`,
        await relayReason(res),
        responseDate(res),
      )
    return (await res.json()) as T
  }

  /**
   * GET /.well-known/talos-relay, UNSIGNED (no Authorization header: the descriptor is public, and a signed request would only
   * hand the relay a proof it does not need). `absent` is a relay with no descriptor (404, an old relay). Anything else that
   * is not a good descriptor (network, timeout, 5xx, bad JSON or shape) is tried once more, then `unavailable`: the caller
   * says so rather than quietly leaving the key fingerprint out. Never throws.
   */
  async descriptor(): Promise<
    { kind: 'found'; descriptor: RelayDescriptorReadT } | { kind: 'absent' } | { kind: 'unavailable' }
  > {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        assertSecureRelayUrl(this.baseUrl)
        const res = await this.fetchFn(`${this.baseUrl}${RELAY_DESCRIPTOR_PATH}`, {
          method: 'GET',
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (res.status === 404) return { kind: 'absent' }
        if (res.status === 200) {
          const d = RelayDescriptorRead.safeParse(await res.json())
          if (d.success) return { kind: 'found', descriptor: d.data }
        }
      } catch {
        // falls through to the retry
      }
    }
    return { kind: 'unavailable' }
  }

  /** POST /bridge/post: one durable frame (`reply`, `card.create`, `thread.upsert`, `inbox.update`). */
  async post(frame: BridgeToRelayFrame): Promise<{ ack: { ref: string; seq?: number } }> {
    return this.json('POST', '/bridge/post', frame)
  }

  /** POST /bridge/share/tokens (P1 `share shortcut`): a fresh share token; the secret is in the answer, once. */
  async createShareToken(a: {
    label: string
    device_id: string
    scopes: Array<'text' | 'files'>
  }): Promise<{ token: { id: string; label: string }; secret: string }> {
    return this.json('POST', '/bridge/share/tokens', a)
  }

  /** DELETE /bridge/share/tokens/:id (P1 `share revoke`): true when revoked (also when it already was), false for 404. */
  async revokeShareToken(id: string): Promise<boolean> {
    const res = await this.request('DELETE', `/bridge/share/tokens/${encodeURIComponent(id)}`)
    if (res.status === 404) return false
    if (!res.ok)
      throw new RelayHttpError(res.status, `DELETE /bridge/share/tokens -> ${res.status}`, await relayReason(res))
    return true
  }

  /** POST /bridge/peers: a new inbox for a linked agent; the secret is in the answer, once. */
  createPeer(a: { name: string; daily_cap?: number }) {
    return this.json<PeerCreatedT>('POST', '/bridge/peers', a)
  }

  async listPeers(): Promise<PeerRowT[]> {
    const res = await this.request('GET', '/bridge/peers')
    if (!res.ok) throw new RelayHttpError(res.status, `GET /bridge/peers -> ${res.status}`, await relayReason(res))
    return (await res.json()) as PeerRowT[]
  }

  /** DELETE /bridge/peers/:name: revokes at once; 200 whether or not it existed. */
  async deletePeer(name: string): Promise<void> {
    const res = await this.request('DELETE', `/bridge/peers/${encodeURIComponent(name)}`)
    if (!res.ok) throw new RelayHttpError(res.status, `DELETE /bridge/peers -> ${res.status}`, await relayReason(res))
  }

  /** POST /bridge/peers/:name/link: a one-paste link code for that inbox (it replaces the open one). */
  mintPeerLink(name: string) {
    return this.json<{ code: string }>('POST', `/bridge/peers/${encodeURIComponent(name)}/link`, {})
  }

  /** GET /bridge/peers/:name/link: the newest code's state; the first read after a redeem carries the other side's url and secret, once. */
  async getPeerLink(name: string): Promise<PeerLinkStateT> {
    const res = await this.request('GET', `/bridge/peers/${encodeURIComponent(name)}/link`)
    if (!res.ok) throw new RelayHttpError(res.status, `GET /bridge/peers/link -> ${res.status}`, await relayReason(res))
    return PeerLinkState.parse(await res.json())
  }

  rotatePeer(name: string) {
    return this.json<{ secret: string }>('POST', `/bridge/peers/${encodeURIComponent(name)}/rotate`, {})
  }

  async putMedia(
    mediaId: string,
    bytes: Uint8Array,
    sha256: string,
    mime: string,
    name: string,
    /** MCP apps: `X-Talos-App-Csp` for an approved app page (MCP-APPS-SPEC M3.5). */
    extraHeaders: Record<string, string> = {},
  ): Promise<void> {
    // F8: the progress of an upload body cannot be observed, so the deadline grows with the size: 15 s + 2 s per MB.
    const timeoutMs = this.timeoutMs + Math.ceil(bytes.length / 1_000_000) * 2000
    const res = await this.request(
      'PUT',
      `/bridge/media/${mediaId}`,
      bytes,
      { 'content-type': mime, 'x-talos-sha256': sha256, 'x-talos-name': encodeURIComponent(name), ...extraHeaders },
      { timeoutMs },
    )
    if (!res.ok) throw new RelayHttpError(res.status, `media upload failed: ${res.status}`)
  }

  /**
   * F4/F8: streams the body with a running byte cap (`maxBytes` = the signed size) and aborts the moment it is passed,
   * and uses an idle timeout (no bytes for `timeoutMs`) instead of a total one, so slow links finish a 50 MB file.
   */
  async getMedia(mediaId: string, maxBytes: number): Promise<Uint8Array> {
    const ctl = new AbortController()
    let idle: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => ctl.abort(), this.timeoutMs)
    }
    arm()
    try {
      const res = await this.request('GET', `/bridge/media/${mediaId}`, undefined, {}, { signal: ctl.signal })
      if (!res.ok) throw new RelayHttpError(res.status, `media download failed: ${res.status}`)
      const tooBig = () => new RelayHttpError(413, `media ${mediaId} is larger than its signed size (${maxBytes})`)
      const declared = Number(res.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > maxBytes) {
        void res.body?.cancel().catch(() => {})
        throw tooBig()
      }
      if (!res.body) return new Uint8Array(0)
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm()
        total += value.length
        if (total > maxBytes) {
          void reader.cancel().catch(() => {})
          ctl.abort()
          throw tooBig()
        }
        chunks.push(value)
      }
      const out = new Uint8Array(total)
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.length
      }
      return out
    } finally {
      if (idle) clearTimeout(idle)
    }
  }

  async getRaw(eventId: string): Promise<Uint8Array> {
    const res = await this.request('GET', `/bridge/raw/${eventId}`)
    if (!res.ok) throw new RelayHttpError(res.status, `raw payload fetch failed: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async getDigest(sinceIso?: string): Promise<unknown> {
    const q = sinceIso ? `?since=${encodeURIComponent(sinceIso)}` : ''
    const res = await this.request('GET', `/bridge/digest${q}`)
    if (!res.ok)
      throw new RelayHttpError(res.status, `digest fetch failed: ${res.status}`, undefined, responseDate(res))
    return res.json()
  }

  enroll(body: { code_id: string; code_auth_hash: string; expires_at: string; label?: string }) {
    return this.json<{ ok: true }>('POST', '/bridge/enroll', body)
  }

  rotate(body: { new_pubkey: string; sig_new: string; ts: number }) {
    return this.json<{ ok: true; key_id: string }>('POST', '/bridge/rotate', body)
  }

  /** POST /bridge/bug-reports/:id/requeue (`errors requeue-bug-report`): the relay queues one stored own-device bug report to this Mac again. */
  requeueBugReport(reportId: string) {
    return this.json<{ ok: true; id: string; already_queued?: boolean }>(
      'POST',
      `/bridge/bug-reports/${encodeURIComponent(reportId)}/requeue`,
      {},
    )
  }

  revokeDevice(deviceId: string) {
    // `shared_passkey` is absent from a relay older than the field: absent means unknown, not false.
    return this.json<{ ok: true; shared_passkey?: boolean }>('POST', `/bridge/devices/${deviceId}/revoke`, {})
  }

  async healthz(): Promise<{ ok: boolean; version?: string }> {
    const res = await this.fetchFn(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(this.timeoutMs) })
    if (!res.ok) throw new RelayHttpError(res.status, `healthz -> ${res.status}`)
    return (await res.json()) as { ok: boolean; version?: string }
  }
}

/** The four frame types POST /bridge/post accepts. */
export type BridgeToRelayFrame = Extract<Frame, { type: 'reply' | 'card.create' | 'thread.upsert' | 'inbox.update' }>
export const HTTP_POSTABLE = new Set(['reply', 'card.create', 'thread.upsert', 'inbox.update'])
