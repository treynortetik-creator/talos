// FakeRelay's HTTP side: the bridge-signed routes (/bridge/post, /bridge/media/:id, /bridge/rotate, ...), checked with
// the real signature scheme, and the app's /api/media and GET /media/:id.
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  type BridgeKeyPair,
  b64urlDecode,
  bridgeKeyId,
  type Frame,
  newId,
  parseBridgeAuthHeader,
  parseFrameText,
  routes,
  sha256Hex,
  verifyBridgeHttp,
  verifyRotation,
} from '@talos-app/protocol'
import { cardProblem } from './fake-relay-cards.ts'
import { type FakeRelayOptions, type HttpRecord, type RelayDirection, safeJson } from './fake-relay-shared.ts'
import { mkFrame, now } from './frame-utils.ts'
import type { Recorder } from './recorder.ts'

type Send = (status: number, payload?: unknown, headers?: Record<string, string>) => void

/** What the HTTP routes need from the relay that owns them. */
export type RelayHttpHost = {
  opts: FakeRelayOptions
  bridgeKey(): BridgeKeyPair
  rec: Recorder<RelayDirection>
  /** True for a durable frame id the relay already stored: it is acked again and never checked or applied twice. */
  alreadyStored(frame: Frame): boolean
  /** A frame the Mac posted: stamp, remember and fan it out like a socket frame. Fills `seq` when it was stored. */
  acceptBridgePost(frame: Frame, raw: Record<string, unknown>, ack: { seq?: number }): void
}

export class RelayHttp {
  readonly records: HttpRecord[] = []
  readonly media = new Map<string, { bytes: Buffer; sha256: string; mime: string; name?: string }>()
  private seenNonces = new Set<string>()

  constructor(private readonly host: RelayHttpHost) {}

  async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const pathWithQuery = (req.url ?? '/') as string
    const record = (status: number) =>
      this.records.push({ method: req.method ?? 'GET', path: pathWithQuery, headers: req.headers, body, status })
    const send: Send = (status, payload, headers = {}) => {
      record(status)
      if (payload === undefined) return void res.writeHead(status, headers).end()
      if (Buffer.isBuffer(payload)) return void res.writeHead(status, headers).end(payload)
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(payload))
    }

    if (path === '/healthz') return send(200, { ok: true, version: 'fake' })

    if (path.startsWith('/bridge/')) {
      if (this.host.opts.bridgeAuth !== 'off') {
        const key = this.host.bridgeKey()
        const v = await verifyBridgeHttp({
          header: String(req.headers.authorization ?? ''),
          method: req.method ?? 'GET',
          pathWithQuery,
          body,
          nowS: Math.floor(Date.now() / 1000),
          keys: [{ keyId: key.keyId, publicKeyB64: key.publicKeyB64 }],
        })
        if (!v.ok || this.seenNonces.has(v.nonce)) return send(401, { error: 'unauthorized' })
        this.seenNonces.add(v.nonce)
      } else if (!parseBridgeAuthHeader(String(req.headers.authorization ?? ''))) {
        return send(401, { error: 'unauthorized' })
      }
      return this.bridgeRoutes(req, path, url, body, send)
    }
    return this.appRoutes(req, path, body, send)
  }

  private appRoutes(req: IncomingMessage, path: string, body: Buffer, send: Send) {
    if (req.method === 'POST' && path === '/api/media') {
      const sha = sha256Hex(body)
      const claimed = req.headers['x-talos-sha256']
      if (claimed && claimed !== sha) return send(400, { error: 'sha256 mismatch' })
      const id = newId('md')
      const mime = String(req.headers['content-type'] ?? 'application/octet-stream')
      this.media.set(id, { bytes: body, sha256: sha, mime })
      const dur = req.headers['x-talos-duration-ms']
      return send(200, {
        media_id: id,
        kind: mime.startsWith('audio/') ? 'voice_note' : mime.startsWith('image/') ? 'image' : 'file',
        role: 'attachment',
        mime,
        name: String(req.headers['x-talos-name'] ?? 'upload'),
        size: body.length,
        sha256: sha,
        ...(dur ? { duration_ms: Number(dur) } : {}),
      })
    }
    const mediaGet = /^\/media\/(md_[0-9A-HJKMNP-TV-Z]{26})$/.exec(path)
    // HEAD like the real relay (Hono answers it from the GET route): the app probes with it before showing a file
    if ((req.method === 'GET' || req.method === 'HEAD') && mediaGet) {
      const m = this.media.get(mediaGet[1] as string)
      if (!m) return send(404)
      // same shape as the real relay: a non-inline file is an attachment under its own name
      const disposition: Record<string, string> = m.name
        ? {
            'content-disposition': `attachment; filename="${m.name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(m.name)}`,
          }
        : {}
      return send(200, m.bytes, { 'content-type': m.mime, 'accept-ranges': 'bytes', ...disposition })
    }
    return send(404, { error: 'not found' })
  }

  private async bridgeRoutes(req: IncomingMessage, path: string, url: URL, body: Buffer, send: Send) {
    const method = req.method ?? 'GET'
    if (method === 'POST' && path === '/bridge/post') {
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(body.toString('utf8'))
      } catch {
        return send(400, { error: 'bad_frame' })
      }
      // Only reply, card.create, thread.upsert and inbox.update are accepted here (spec 3.8).
      if (!routes.bridgePost.req.safeParse(raw).success) return send(400, { error: 'bad_frame' })
      const parsed = parseFrameText(JSON.stringify(raw), { authenticated: true, direction: 'bridge_to_relay' })
      if (!parsed.ok) return send(400, { error: parsed.code })
      this.host.rec.record('from_bridge', raw, JSON.stringify(raw))
      if (
        parsed.frame.type === 'card.create' &&
        !this.host.alreadyStored(parsed.frame) &&
        cardProblem(parsed.frame.card)
      )
        return send(400, { error: 'bad_frame' })
      const holder: { seq?: number } = {}
      this.host.acceptBridgePost(parsed.frame, raw, holder)
      return send(200, { ack: { ref: raw.id, ...(holder.seq ? { seq: holder.seq } : {}) } })
    }
    const mediaId = /^\/bridge\/media\/(md_[0-9A-HJKMNP-TV-Z]{26})$/.exec(path)
    if (mediaId && method === 'PUT') {
      const sha = sha256Hex(body)
      if (req.headers['x-talos-sha256'] && req.headers['x-talos-sha256'] !== sha)
        return send(400, { error: 'sha256 mismatch' })
      this.media.set(mediaId[1] as string, {
        bytes: body,
        sha256: sha,
        mime: String(req.headers['content-type'] ?? 'application/octet-stream'),
        // the real relay stores this as the row name; without it every bridge upload downloads as "upload"
        name: decodeURIComponent(String(req.headers['x-talos-name'] ?? 'upload')),
      })
      return send(200, { ok: true, media_id: mediaId[1] })
    }
    if (mediaId && method === 'GET') {
      const m = this.media.get(mediaId[1] as string)
      return m ? send(200, m.bytes, { 'content-type': m.mime }) : send(404)
    }
    if (method === 'GET' && path === '/bridge/digest') {
      const since = url.searchParams.get('since') ?? now()
      return send(200, mkFrame('hook.digest', { window: { start: since, end: now() }, threads: [], events: [] }))
    }
    if (method === 'POST' && path === '/bridge/enroll') {
      return routes.bridgeEnroll.req.safeParse(safeJson(body)).success
        ? send(200, { ok: true })
        : send(400, { error: 'bad_request' })
    }
    if (method === 'POST' && path === '/bridge/rotate') {
      const parsed = routes.bridgeRotate.req.safeParse(safeJson(body))
      if (!parsed.success) return send(400, { error: 'bad_request' })
      const { new_pubkey, ts, sig_new } = parsed.data
      // Like the real relay: the clock window, and the NEW key must sign its own announcement.
      if (Math.abs(Math.floor(Date.now() / 1000) - ts) > 120) return send(401, { error: 'unauthorized' })
      if (!(await verifyRotation(new_pubkey, ts, sig_new))) return send(401, { error: 'unauthorized' })
      return send(200, { ok: true, key_id: bridgeKeyId(b64urlDecode(new_pubkey)) })
    }
    if (method === 'POST' && /^\/bridge\/devices\/d_[a-z2-7]{20}\/revoke$/.test(path))
      return send(200, {
        ok: true,
        ...(this.host.opts.revokeSharedPasskey === undefined
          ? {}
          : { shared_passkey: this.host.opts.revokeSharedPasskey }),
      })
    return send(404, { error: 'not found' })
  }
}
