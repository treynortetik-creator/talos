// A system row in a thread, posted with only bridge.env and the bridge key: the supervisor's phone line when Main is down.
// It never reads config.json, because the line it carries may be that config.json is damaged (Main then crash-loops and its
// bridge, the usual way to the phone, is down). Deliberately no CLI command: the app draws a system row as a Talos notice,
// so an agent that could post one could pass its own text off as the app's.
import { newId, ThreadId } from '@talos-app/protocol'
import { assertSecureRelayUrl, loadEnv, paths } from './config.ts'
import { replyFrame } from './frames-out.ts'
import { loadBridgeKey } from './keys.ts'
import { RelayHttp } from './relay-http.ts'

/** Posts `text` as a system row in `thread` (headless, the relay is the one record: no history row). Throws on failure. */
export async function postSystemRow(
  processEnv: Record<string, string | undefined>,
  thread: string,
  text: string,
  fetchFn?: typeof fetch,
): Promise<string> {
  if (!ThreadId.safeParse(thread).success) throw new Error(`not a thread id: ${thread}`)
  if (!text) throw new Error('no text')
  const env = loadEnv(processEnv)
  if (!env.relayUrl) throw new Error('TALOS_APP_RELAY_URL is not set')
  assertSecureRelayUrl(env.relayUrl)
  const key = await loadBridgeKey(paths(env.home))
  const now = Date.now()
  const message = {
    id: newId('m'),
    thread_id: thread,
    author: 'system' as const,
    kind: 'text' as const,
    text,
    format: 'plain' as const,
    attachments: [],
    via: 'headless' as const,
    created_at: new Date(now).toISOString(),
  }
  await new RelayHttp(env.relayUrl, () => key, fetchFn).post(replyFrame(now, message))
  return message.id
}
