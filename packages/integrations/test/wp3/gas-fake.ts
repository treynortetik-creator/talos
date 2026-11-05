// A just-enough fake of Google Apps Script's globals, so the REAL rendered script text can run in a Node vm.
import { createHmac, randomUUID } from 'node:crypto'
import vm from 'node:vm'

export type FakeMessage = { id: string; date: Date; from: string; to?: string; subject: string; body: string }
export type FakeThread = { id: string; labels?: string[]; messages: FakeMessage[] }
export type Fetched = { url: string; payload: Uint8Array; headers: Record<string, string>; body: string }

const signed = (b: Uint8Array | Buffer): number[] => [...b].map((x) => (x > 127 ? x - 256 : x))
const unsigned = (a: number[] | Uint8Array): Buffer => Buffer.from([...a].map((x) => x & 255))

export function makeGas(args: {
  script: string
  main?: FakeThread[]
  forwarded?: FakeThread[]
  props?: Record<string, string>
  /** HTTP status for the n-th (0-based) POST to the hook URL. Default 200. */
  status?: (n: number) => number
}) {
  const props = new Map(Object.entries(args.props ?? {}))
  const fetched: Fetched[] = []
  const searches: Array<{ query: string; start: number; max: number }> = []
  let posts = 0
  const message = (m: FakeMessage) => ({
    getId: () => m.id,
    getDate: () => m.date,
    isInTrash: () => false,
    isDraft: () => false,
    getPlainBody: () => m.body,
    getFrom: () => m.from,
    getTo: () => m.to ?? 'owner@example.com',
    getSubject: () => m.subject,
    isUnread: () => true,
    isStarred: () => false,
  })
  const thread = (t: FakeThread) => ({
    getId: () => t.id,
    getLabels: () => (t.labels ?? []).map((name) => ({ getName: () => name })),
    getMessages: () => t.messages.map(message),
  })
  const ctx: Record<string, unknown> = {
    console: { log() {}, warn() {}, error() {} },
    GmailApp: {
      search(query: string, start: number, max: number) {
        searches.push({ query, start, max })
        const src = query.startsWith('label:') ? (args.forwarded ?? []) : (args.main ?? [])
        return src.slice(start, start + max).map(thread)
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => props.get(k) ?? null,
        setProperty: (k: string, v: string) => void props.set(k, v),
        deleteAllProperties: () => props.clear(),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger() {},
      newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }),
    },
    Session: { getActiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Utilities: {
      MacAlgorithm: { HMAC_SHA_256: 'HMAC_SHA_256' },
      getUuid: () => randomUUID(),
      base64Decode: (s: string) => signed(Buffer.from(s, 'base64')),
      base64Encode: (b: number[] | string) => (typeof b === 'string' ? Buffer.from(b) : unsigned(b)).toString('base64'),
      newBlob: (s: string) => ({ getBytes: () => signed(Buffer.from(s, 'utf8')) }),
      computeHmacSignature: (_alg: string, data: number[], key: number[]) =>
        signed(createHmac('sha256', unsigned(key)).update(unsigned(data)).digest()),
    },
    UrlFetchApp: {
      fetch(url: string, opts: { payload: number[] | string; headers?: Record<string, string> }) {
        const payload = typeof opts.payload === 'string' ? Buffer.from(opts.payload) : unsigned(opts.payload)
        fetched.push({ url, payload, headers: opts.headers ?? {}, body: payload.toString('utf8') })
        if (url.endsWith('/claim')) return { getResponseCode: () => 200, getContentText: () => '{"secret":"whsec_x"}' }
        const code = args.status ? args.status(posts) : 200
        posts++
        return { getResponseCode: () => code, getContentText: () => '' }
      },
    },
  }
  vm.createContext(ctx)
  vm.runInContext(args.script, ctx)
  return {
    props,
    fetched,
    searches,
    run: (code: string) => vm.runInContext(code, ctx) as unknown,
    tick: () => vm.runInContext('tick()', ctx),
  }
}

export function thread(i: number, over: Partial<FakeMessage> = {}, labels: string[] = []): FakeThread {
  return {
    id: `t${i}`,
    labels,
    messages: [
      {
        id: `m${i}`,
        date: new Date(Date.now() - i * 1000),
        from: 'Sam Sender <sam@example.com>',
        subject: `Subject ${i}`,
        body: `Body ${i}`,
        ...over,
      },
    ],
  }
}
