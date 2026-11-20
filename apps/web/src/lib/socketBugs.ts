// The socket BugReportClient: `context` is one signed `bug.context` read (answered by `bug.context_result`); `send` signs the whole
// report with this device's key and posts it to POST /api/bug-reports, where the relay checks the signature against the key
// the Mac pinned. Nothing here is sent until the owner pressed Send; `destination` only asks the relay where a report would go.

import type { DeviceKey } from '@talos-app/protocol'
import {
  type BugReportBodyT,
  BugReportDestination,
  type BugReportDestinationT,
  b64urlEncode,
  newUlid,
  signOwnerFrame,
} from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import type { BugContext, BugReportClient } from './v2Client.ts'

export type SocketBugsDeps = {
  ask(frame: Record<string, unknown>): Promise<Record<string, unknown>>
  ensureKey(): Promise<DeviceKey>
  signedTs(): string
  fetchImpl?: typeof fetch
}

/** Standard base64 of bytes, in pieces so a 5 MB picture does not overflow the argument list. */
export function base64Of(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

export function toBugContext(f: Record<string, unknown>): BugContext {
  return {
    bridgeVersion: str(f.bridge_version, 40),
    claudeCode: typeof f.claude_code === 'string' ? f.claude_code.slice(0, 40) : null,
    recentErrors: Array.isArray(f.recent_errors) ? f.recent_errors.map((e) => str(e, 400)).slice(0, 50) : [],
    logs: str(f.logs, 60 * 1024),
  }
}

export function createSocketBugs(d: SocketBugsDeps): BugReportClient {
  return {
    async context(lines) {
      return toBugContext(await d.ask({ type: 'bug.context', request_id: newUlid(), lines }))
    },
    async send(report, picture) {
      const key = await d.ensureKey()
      const frame = await signOwnerFrame(
        {
          v: 1,
          type: 'bug.report',
          device_id: key.deviceId,
          id: newUlid(),
          ts: d.signedTs(),
          nonce: b64urlEncode(crypto.getRandomValues(new Uint8Array(18))),
          report: report satisfies BugReportBodyT,
          image_type: picture.type,
          image_b64: base64Of(picture.bytes),
        },
        key.privateKey,
      )
      let res: Response
      try {
        res = await (d.fetchImpl ?? ((...a) => fetch(...a)))('/api/bug-reports', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Talos-CSRF': '1' },
          body: JSON.stringify(frame),
        })
      } catch {
        throw new TalosClientError('internal', "You're offline.")
      }
      if (res.status === 429) throw new TalosClientError('rate_limited')
      if (!res.ok) throw new TalosClientError('internal', `Talos refused the report (${res.status}).`)
      return { id: frame.id }
    },
    async destination(): Promise<BugReportDestinationT> {
      const res = await (d.fetchImpl ?? ((...a) => fetch(...a)))('/api/bug-reports/destination', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new TalosClientError('internal', `Talos did not say where reports go (${res.status}).`)
      // an answer of any other shape is not believed: the line then says only what is sure
      const parsed = BugReportDestination.safeParse(await res.json())
      if (!parsed.success) throw new TalosClientError('internal', 'Talos did not say where reports go.')
      return parsed.data
    },
  }
}
