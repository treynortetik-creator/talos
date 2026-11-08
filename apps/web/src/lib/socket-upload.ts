// Media upload: size and digest checks, and the POST to the relay.
import { type AttachmentRefT, FORM_SENDABLE_TYPES, routes, textTypeOfFile } from '@talos-app/protocol'
import { TalosClientError, type UploadMeta } from './client.ts'
import { endReasonOf, HttpError } from './http.ts'
import { MAX_UPLOAD_BYTES } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'

/** POST with upload progress (fetch has none). Resolves a Response so the caller handles it like a fetch. */
function xhrUpload(
  url: string,
  headers: Record<string, string>,
  body: Uint8Array,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('POST', url)
    x.withCredentials = true
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v)
    x.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total))
    }
    x.onload = () => {
      onProgress(1)
      resolve(new Response(x.responseText, { status: x.status, headers: { 'Content-Type': 'application/json' } }))
    }
    x.onerror = () => reject(new TypeError('Network error'))
    x.onabort = () => reject(new TalosClientError('internal', 'Cancelled'))
    signal?.addEventListener('abort', () => x.abort(), { once: true })
    x.send(body as unknown as XMLHttpRequestBodyInit)
  })
}

export function createSocketUpload(c: SocketCtx) {
  const { setMeta } = c

  // ---- media -----------------------------------------------------------------------------------------------------
  async function uploadMediaNow(blob: Blob, m: UploadMeta): Promise<AttachmentRefT> {
    const began = c.epoch
    if (blob.size > MAX_UPLOAD_BYTES) throw new TalosClientError('too_large', 'Too big to send (max 50 MB).')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const sha = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
    // A text file cannot go up as text/plain: the relay refuses the types an HTML form can send. It goes as octet-stream
    // with its real type in a header, which the relay checks against its own list and stores.
    const textType = textTypeOfFile(m.name, blob.type)
    const headers: Record<string, string> = {
      'Content-Type':
        textType || FORM_SENDABLE_TYPES.test(blob.type)
          ? 'application/octet-stream'
          : blob.type || 'application/octet-stream',
      'X-Talos-Name': encodeURIComponent(m.name),
      'X-Talos-Sha256': sha,
      'X-Talos-CSRF': '1',
    }
    if (textType) headers['X-Talos-File-Type'] = textType
    if (m.durationMs) headers['X-Talos-Duration-Ms'] = String(Math.round(m.durationMs))
    if (m.signal?.aborted) throw new TalosClientError('internal', 'Cancelled')
    const res =
      m.onProgress && !c.opts.fetchImpl && typeof XMLHttpRequest !== 'undefined'
        ? await xhrUpload('/api/media', headers, bytes, m.onProgress, m.signal)
        : await (c.opts.fetchImpl ?? ((...a) => fetch(...a)))('/api/media', {
            method: 'POST',
            credentials: 'same-origin',
            headers,
            body: bytes,
            ...(m.signal ? { signal: m.signal } : {}),
          })
    if (!res.ok) {
      // Keep the server's reason (`{ error | message }`) so the composer can say why, e.g. a full disk.
      const body = await res.json().catch(() => undefined)
      // A 401 that answers after close() belongs to the session that ended: it must not sign out the next one.
      if (res.status === 401 && c.epoch === began && !c.closed)
        setMeta({ authFailed: true, authReason: endReasonOf(body) })
      throw new HttpError(res.status, undefined, body)
    }
    const ref = routes.mediaUpload.res.parse(await res.json())
    return { ...ref, ...(m.waveform ? { waveform: m.waveform } : {}) }
  }

  c.uploadMediaNow = uploadMediaNow
}
