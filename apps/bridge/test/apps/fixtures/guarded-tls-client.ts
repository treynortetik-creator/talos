// Child process for guarded-fetch-tls.test.ts. Runs the shared guarded fetch under the runtime the bridge ships on, against a
// real TLS server whose certificate the parent made trusted through NODE_EXTRA_CA_CERTS (no code seam: the fetch is untouched).
// Prints one JSON object on stdout.
import { createGuardedFetch } from '@talos-app/protocol/guarded-fetch'

const host = process.env.TLS_HOST as string
const port = process.env.TLS_PORT as string
const mode = process.env.TLS_MODE as string
const asked: string[] = []
// the name resolves to loopback in this test; the guarded fetch must connect to that address and verify the certificate for the NAME
const f = createGuardedFetch({
  resolve: async (h) => {
    asked.push(h)
    return ['127.0.0.1']
  },
  allowLoopback: true,
  timeoutMs: 20_000,
})
const base = `https://${host}:${port}`

async function main() {
  if (mode === 'single') {
    try {
      const r = await f(`${base}/hello`)
      return { ok: true, status: r.status, body: await r.text() }
    } catch (e) {
      return { ok: false, name: (e as Error).name, message: String((e as Error).message) }
    }
  }
  const get = await f(`${base}/hello`)
  const post = await f(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: 'a b&c' }),
  })
  const redir = await f(`${base}/redir`, { redirect: 'manual' })
  const next = await f(new URL(redir.headers.get('location') as string, `${base}/redir`))
  const stream = await f(`${base}/stream`)
  const reader = (stream.body as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  const first = dec.decode((await reader.read()).value)
  await (await f(`${base}/release`)).text() // only now may the server finish the stream
  let rest = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    rest += dec.decode(value)
  }
  return {
    ok: true,
    get: { status: get.status, body: await get.text() },
    post: { status: post.status, body: await post.text() },
    redir: {
      status: redir.status,
      location: redir.headers.get('location'),
      nextStatus: next.status,
      nextBody: await next.text(),
    },
    stream: { first, rest },
    asked,
  }
}
console.log(JSON.stringify(await main()))
