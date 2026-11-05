import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type AppCspT, encodeAppCspHeader, newId, sha256Hex } from '@talos-app/protocol'
import type { TestRelay } from '../core/harness.ts'
import { bridgeFetch } from '../core/helpers.ts'

export const SESSION = { 'X-Test-Session': 'none', Origin: 'https://relay.example.com', 'X-Talos-CSRF': '1' }
export const text = (s: string) => new TextEncoder().encode(s)
export const H256 = `sha256-${'A'.repeat(43)}=`

export const goodCsp = (): AppCspT => ({
  connect_domains: ['https://api.example.com'],
  resource_domains: ['https://cdn.example.com'],
  frame_domains: [],
  base_uri_domains: [],
  script_hashes: [H256],
  script_urls: ['https://cdn.example.com/lib/app.js'],
  style_urls: ['https://cdn.example.com/app.css'],
})

export const PAGE = text('<!doctype html><html><body><script>1</script></body></html>')

export const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(fileURLToPath(import.meta.resolve(`@talos-app/protocol/fixtures/frames/${name}.json`)), 'utf8'),
  )

export const b64url = (s: string) => Buffer.from(s).toString('base64url')

/** PUT /bridge/media/:id as the bridge. `csp` is the header VALUE as sent (use encodeAppCspHeader for a good one). */
export function putPage(
  relay: TestRelay,
  id: string,
  opts: { body?: Uint8Array; csp?: string | null; mime?: string } = {},
) {
  const body = opts.body ?? PAGE
  return bridgeFetch(relay, 'PUT', `/bridge/media/${id}`, body, {
    'content-type': opts.mime ?? 'text/html',
    'x-talos-sha256': sha256Hex(body),
    ...(opts.csp === null || opts.csp === undefined ? {} : { 'x-talos-app-csp': opts.csp }),
  })
}

export const getApp = (relay: TestRelay, id: string, headers: Record<string, string> = SESSION) =>
  fetch(`${relay.httpBase}/media/${id}/app`, { headers })

export const newMediaId = () => newId('md')
export const goodHeader = (csp: AppCspT = goodCsp()) => encodeAppCspHeader(csp)
