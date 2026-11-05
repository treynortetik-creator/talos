// `tool_result_media` / `app.response.result_media`: a tool result too big for a frame travels as JSON media (<= 8 MiB).
// Fetched from the relay with the owner's session; media older than the relay buffer is rehydrated from the Mac once.
import { APP_TOOL_RESULT_MEDIA_MAX, McpCallToolResult, type McpCallToolResultT } from '@talos-app/protocol'
import type { TalosClient } from '../../lib/client.ts'
import type { SocketClient } from '../../lib/socketClient.ts'
import { mediaUrl } from '../threads/media.ts'
import { RESULT_FETCH_TIMEOUT_MS } from './limits.ts'

export async function fetchResultMedia(
  client: TalosClient,
  media: { media_id: string },
  fetchFn: typeof fetch = fetch,
  timeoutMs = RESULT_FETCH_TIMEOUT_MS,
): Promise<McpCallToolResultT> {
  const deadline = AbortSignal.timeout(timeoutMs)
  const get = async () => {
    const res = await fetchFn(mediaUrl(media.media_id), { signal: deadline, credentials: 'same-origin' })
    if (!res.ok) return res.status
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > APP_TOOL_RESULT_MEDIA_MAX) throw new Error('result too large')
    const text = await res.text()
    if (text.length > APP_TOOL_RESULT_MEDIA_MAX) throw new Error('result too large')
    const parsed = McpCallToolResult.safeParse(JSON.parse(text))
    if (!parsed.success) throw new Error('result is not a tool result')
    return parsed.data
  }
  const first = await get()
  if (typeof first !== 'number') return first
  // Gone from the relay: ask the Mac for it again and try once more when it lands.
  if (!('fetchMedia' in client)) throw new Error(`result unavailable (${first})`)
  const ready = new Promise<void>((resolve, reject) => {
    const off = client.onFrame('media.ready', (f) => {
      if (f.media_id !== media.media_id) return
      off()
      resolve()
    })
    deadline.addEventListener('abort', () => {
      off()
      reject(new Error('timed out'))
    })
  })
  ;(client as SocketClient).fetchMedia(media.media_id)
  await ready
  const second = await get()
  if (typeof second === 'number') throw new Error(`result unavailable (${second})`)
  return second
}
