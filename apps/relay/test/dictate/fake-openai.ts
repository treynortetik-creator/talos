// A fake OpenAI transcription endpoint on a free local port. It records what the relay sent (never printed) and answers
// as scripted. Nothing here talks to the real service.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Seen = {
  auth: string | undefined
  contentType: string | undefined
  bytes: number
  model: string
  file: string
}
export type Behaviour =
  | { kind: 'text'; text: string }
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'hang' }
  /** Holds the answer until `release()` is called: a slow OpenAI that does answer in the end. */
  | { kind: 'held'; text: string }
  /** Sends the headers and part of the body, then goes quiet. */
  | { kind: 'stall_body' }
  | { kind: 'drop' }

export type FakeOpenAI = {
  baseUrl: string
  seen: Seen[]
  behaviour: Behaviour
  /** Resolves when the next request has fully arrived. */
  nextRequest(): Promise<void>
  /** Answers every request held by the `held` behaviour. */
  release(): void
  /** How many calls the relay cut off before they were answered. */
  cutOff: number
  /** Resolves when the `stall_body` answer's first bytes have left the fake. */
  nextStalled(): Promise<void>
  /** Resolves when the next call is cut off by the relay. */
  nextCutOff(): Promise<void>
  stop(): Promise<void>
}

export async function startFakeOpenAI(): Promise<FakeOpenAI> {
  const seen: Seen[] = []
  let waiters: Array<() => void> = []
  let cutWaiters: Array<() => void> = []
  let stallWaiters: Array<() => void> = []
  const held: Array<() => void> = []
  const open = new Set<import('node:net').Socket>()
  const fake: FakeOpenAI = {
    baseUrl: '',
    seen,
    behaviour: { kind: 'text', text: 'hello from the fake' },
    nextRequest: () => new Promise((resolve) => waiters.push(resolve)),
    release: () => {
      for (const f of held.splice(0)) f()
    },
    cutOff: 0,
    nextStalled: () => new Promise((resolve) => stallWaiters.push(resolve)),
    nextCutOff: () => new Promise((resolve) => cutWaiters.push(resolve)),
    stop: () => {
      for (const s of open) s.destroy()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
  const server: Server = createServer((req, res) => {
    res.on('close', () => {
      if (res.writableEnded) return
      fake.cutOff++
      const w = cutWaiters
      cutWaiters = []
      for (const f of w) f()
    })
    const chunks: Buffer[] = []
    req.on('data', (d: Buffer) => chunks.push(d))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1')
      seen.push({
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        bytes: body.length,
        model: /name="model"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? '',
        file: /name="file"; filename="([^"]*)"/.exec(body)?.[1] ?? '',
      })
      const w = waiters
      waiters = []
      for (const f of w) f()
      const b = fake.behaviour
      if (b.kind === 'hang') return
      if (b.kind === 'held') {
        held.push(() => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ text: b.text }))
        })
        return
      }
      if (b.kind === 'stall_body') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{"text":"par', () => {
          const w = stallWaiters
          stallWaiters = []
          for (const f of w) f()
        })
        return
      }
      if (b.kind === 'drop') return void req.socket.destroy()
      if (b.kind === 'status') {
        res.writeHead(b.status, { 'content-type': 'application/json' })
        return void res.end(b.body ?? '{"error":{"message":"nope"}}')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: b.text }))
    })
  })
  server.on('connection', (s) => {
    open.add(s)
    s.on('close', () => open.delete(s))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  return fake
}
