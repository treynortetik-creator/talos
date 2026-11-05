// Optional ntfy topic (docs/V2-FEATURES.md V2.3 rule 6): a phone push that does not depend on Web Push. Only health
// templates go here, and only the same fixed template text the Web Push carries. The topic URL is a capability, so it is
// never logged, never returned by any route, and a failure logs the error name only.
import type { Logger } from '../services.ts'

export interface NtfySink {
  /** `text` is a fixed template string; `title` is the agent name. */
  send(text: string, title: string): Promise<boolean>
}

export const NTFY_TIMEOUT_MS = 5_000

export function createNtfySink(o: {
  url: string
  token?: string | undefined
  fetch?: typeof fetch
  log: Logger
}): NtfySink {
  const doFetch = o.fetch ?? fetch
  const once = async (text: string, title: string) => {
    const res = await doFetch(o.url, {
      method: 'POST',
      body: text,
      headers: {
        Title: title,
        Tags: 'warning',
        ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
      },
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
      redirect: 'error',
    })
    // drain so the connection can be reused; the body is never read into a log
    await res.arrayBuffer().catch(() => undefined)
    if (!res.ok) throw new Error(`ntfy answered ${res.status}`)
  }
  return {
    async send(text, title) {
      try {
        await once(text, title)
        return true
      } catch {
        try {
          await once(text, title)
          return true
        } catch (e) {
          o.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'ntfy alert failed')
          return false
        }
      }
    },
  }
}
