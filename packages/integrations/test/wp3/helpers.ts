import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { signStandard } from '../../src/standard-webhooks.ts'
import type { NormalizeConnection, RawDelivery, VerifyRequest } from '../../src/types.ts'

export const NOW = Date.parse('2026-10-28T15:00:00.000Z')
export const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
export const OTHER_SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`

export function fixture(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../src/${path}`, import.meta.url)), 'utf8')
}

export const enc = (s: string) => new TextEncoder().encode(s)

export function conn(over: Partial<NormalizeConnection> = {}): NormalizeConnection {
  return { id: 'cn_aaaaaaaaaaaaaaaaaaaaaa', integration: 'generic', thread: 'inbox', work: false, extra: {}, ...over }
}

export function raw(body: string, headers: Record<string, string> = {}, at = NOW): RawDelivery {
  return { headers, rawBody: enc(body), receivedAt: at }
}

export function signedReq(
  body: string,
  secret = SECRET,
  over: { id?: string; tsS?: number; now?: number } = {},
): VerifyRequest {
  const now = over.now ?? NOW
  return {
    headers: signStandard({
      secret,
      id: over.id ?? 'msg_test_1',
      timestampS: over.tsS ?? Math.floor(now / 1000),
      body,
    }),
    rawBody: enc(body),
    url: 'https://relay.example.com/hook/generic/cn_aaaaaaaaaaaaaaaaaaaaaa',
    now,
  }
}

/** Replaces random ids so normalizer output can be snapshotted. */
export function stable<T extends { id: string; connection: string }>(
  events: T[],
): Array<Omit<T, 'id'> & { id: string }> {
  return events.map((e) => ({ ...e, id: '<event id>' }))
}
