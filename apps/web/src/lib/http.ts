// Same-origin JSON helper. Every non-GET carries `X-Talos-CSRF: 1` (spec 5.4); the session cookie rides along.
import { TalosClientError } from './client.ts'

export class HttpError extends Error {
  readonly status: number
  /** The parsed JSON error body, when there was one (`{ error, ... }`). */
  readonly body: unknown
  constructor(status: number, message?: string, body?: unknown) {
    super(message ?? `HTTP ${status}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

/** Why the relay ended a session, from the body of its 401 (`{ error: 'unauthorized', reason }`); null when it did not say. */
export function endReasonOf(body: unknown): string | null {
  const r = body && typeof body === 'object' ? (body as { reason?: unknown }).reason : undefined
  return typeof r === 'string' && r.length > 0 ? r : null
}

export type FetchLike = typeof fetch

export function createHttp(fetchImpl: FetchLike = (...a) => fetch(...a), base = '') {
  async function request(method: string, path: string, body?: unknown, extra?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (method !== 'GET') headers['X-Talos-CSRF'] = '1'
    const init: RequestInit = { method, credentials: 'same-origin', headers, ...extra }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetchImpl(`${base}${path}`, init)
    if (!res.ok) {
      if (res.status === 429) throw new TalosClientError('rate_limited', 'Too many tries. Wait a minute.')
      const errBody = await res.json().catch(() => undefined)
      throw new HttpError(res.status, undefined, errBody)
    }
    return res
  }
  return {
    request,
    async json<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await request(method, path, body)
      if (res.status === 204) return undefined as T
      return (await res.json()) as T
    },
    get: async <T = unknown>(path: string) => (await request('GET', path)).json() as Promise<T>,
  }
}

export type Http = ReturnType<typeof createHttp>
