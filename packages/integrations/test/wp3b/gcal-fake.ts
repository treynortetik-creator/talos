// A just-enough fake of Apps Script's Calendar globals so the REAL rendered script runs in a Node vm.
import { createHash, createHmac, randomUUID } from 'node:crypto'
import vm from 'node:vm'

export type FakeEvent = {
  id: string
  title: string
  start: number
  end: number
  location?: string
  status?: string
  creator?: string
}
export type Posted = { url: string; body: string; headers: Record<string, string> }

const signed = (b: Uint8Array | Buffer): number[] => [...b].map((x) => (x > 127 ? x - 256 : x))
const unsigned = (a: number[] | Uint8Array): Buffer => Buffer.from([...a].map((x) => x & 255))

export function makeCalendarGas(args: {
  script: string
  events: () => FakeEvent[]
  props?: Record<string, string>
  /** Throw from setProperty when a value is longer than this (the real cap is 9 KB). */
  maxProp?: number
  /** The status the hook endpoint answers with (default 200). */
  hookStatus?: () => number
}) {
  const props = new Map(Object.entries(args.props ?? {}))
  const posted: Posted[] = []
  const ev = (e: FakeEvent) => ({
    getId: () => e.id,
    getTitle: () => e.title,
    getStartTime: () => new Date(e.start),
    getEndTime: () => new Date(e.end),
    getLocation: () => e.location ?? '',
    getMyStatus: () => e.status ?? 'YES',
    getCreators: () => (e.creator ? [e.creator] : []),
  })
  const ctx: Record<string, unknown> = {
    console: { log() {}, warn() {}, error() {} },
    CalendarApp: { getDefaultCalendar: () => ({ getEvents: () => args.events().map(ev) }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => props.get(k) ?? null,
        setProperty: (k: string, v: string) => {
          if (args.maxProp !== undefined && v.length > args.maxProp) throw new Error('Argument too large')
          props.set(k, v)
        },
        deleteAllProperties: () => props.clear(),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger() {},
      newTrigger: () => ({
        forUserCalendar: () => ({ onEventUpdated: () => ({ create() {} }) }),
        timeBased: () => ({ everyMinutes: () => ({ create() {} }) }),
      }),
    },
    Session: { getActiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    Utilities: {
      MacAlgorithm: { HMAC_SHA_256: 'HMAC_SHA_256' },
      DigestAlgorithm: { MD5: 'MD5' },
      getUuid: () => randomUUID(),
      computeDigest: (_alg: string, s: string) => signed(createHash('md5').update(s).digest()),
      base64Decode: (s: string) => signed(Buffer.from(s, 'base64')),
      base64Encode: (b: number[] | string) => (typeof b === 'string' ? Buffer.from(b) : unsigned(b)).toString('base64'),
      newBlob: (s: string) => ({ getBytes: () => signed(Buffer.from(s, 'utf8')) }),
      computeHmacSignature: (_alg: string, data: number[], key: number[]) =>
        signed(createHmac('sha256', unsigned(key)).update(unsigned(data)).digest()),
    },
    UrlFetchApp: {
      fetch(url: string, opts: { payload: number[] | string; headers?: Record<string, string> }) {
        const payload = typeof opts.payload === 'string' ? Buffer.from(opts.payload) : unsigned(opts.payload)
        if (url.endsWith('/claim')) return { getResponseCode: () => 200, getContentText: () => '{"secret":"whsec_x"}' }
        posted.push({ url, body: payload.toString('utf8'), headers: opts.headers ?? {} })
        return { getResponseCode: () => args.hookStatus?.() ?? 200, getContentText: () => '' }
      },
    },
  }
  vm.createContext(ctx)
  vm.runInContext(args.script, ctx)
  return { props, posted, run: (code: string) => vm.runInContext(code, ctx) as unknown }
}
