// The owner's phone, played by the driver: a device key, a session cookie and a socket to the sandbox's relay.
//
// Enrolment is the real one, end to end, with no test back door: `talos-app enroll` on the Mac side makes the one-time
// code; the phone trades it for a session the way a native shell does (the setup-code sign-in, which needs no passkey),
// binds its device key to the code, and the four words are confirmed at the `talos-app enroll` prompt on a terminal, as
// the owner would. Only then does the Mac pin the key, and only a pinned key's signature reaches the agent.
import {
  bindingMac,
  createExtractableDeviceKeyForTests,
  type DeviceKey,
  deriveEnrollAuth,
  deriveEnrollBind,
  fingerprintWords,
  importDevicePrivateKey,
  importDevicePublicKey,
} from '@talos-app/protocol'
import { FakeApp } from '@talos-app/testkit'
import { Cli } from '../harness/stack.ts'
import {
  cleanEnv,
  files,
  type PhoneRecord,
  readJson,
  SandboxError,
  type SandboxRecord,
  waitUntil,
  writeJson,
} from './state.ts'

const COOKIE = '__Host-talos_s'

const apiHeaders = (rec: SandboxRecord, cookie?: string): Record<string, string> => ({
  Origin: rec.relay.origin,
  'X-Talos-CSRF': '1',
  'Content-Type': 'application/json',
  ...(cookie ? { Cookie: cookie } : {}),
})

async function post(rec: SandboxRecord, path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${rec.relay.origin}${path}`, {
    method: 'POST',
    headers: apiHeaders(rec, cookie),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
}

export async function me(
  rec: SandboxRecord,
  cookie: string,
): Promise<{ device_pinned?: boolean; bridge_online?: boolean }> {
  const r = await fetch(`${rec.relay.origin}/api/me`, {
    headers: { Cookie: cookie, Origin: rec.relay.origin },
    signal: AbortSignal.timeout(5000),
  })
  if (!r.ok) throw new SandboxError('relay_refused', `GET /api/me answered ${r.status}`)
  return (await r.json()) as { device_pinned?: boolean; bridge_online?: boolean }
}

/** Enrols a new device and writes phone.json. The Mac side must be up: the four words only reach a live bridge. */
export async function enrollPhone(rec: SandboxRecord, label = 'sandbox-phone'): Promise<PhoneRecord> {
  const cli = new Cli(rec.home, ['enroll', '--label', label, '--no-qr'], cleanEnv())
  try {
    const [link] = await cli.waitFor(/https?:\/\/\S+\/enroll#\S+/, 30_000)
    const code = (link as string).split('#')[1] as string
    const codeAuth = deriveEnrollAuth(code)

    const session = await post(rec, '/api/auth/enroll/session', { code_auth: codeAuth })
    const cookie = new RegExp(`${COOKIE}=([^;]+)`).exec(session.headers.get('set-cookie') ?? '')?.[1]
    if (!session.ok || !cookie)
      throw new SandboxError(
        'enroll_failed',
        `the setup-code sign-in answered ${session.status}: ${await session.text()}`,
      )
    const cookieHeader = `${COOKIE}=${cookie}`

    const key = await createExtractableDeviceKeyForTests()
    const verify = await post(
      rec,
      '/api/auth/device/verify',
      {
        device: { id: key.deviceId, name: label, pubkey_jwk: key.publicJwk },
        binding: bindingMac(deriveEnrollBind(code), key.deviceId, key.publicJwk),
        code_auth: codeAuth,
      },
      cookieHeader,
    )
    if (verify.status !== 202)
      throw new SandboxError('enroll_failed', `device/verify answered ${verify.status}: ${await verify.text()}`)

    // The Mac shows the four words of the key it was sent; they must be this key's before anyone says yes.
    const [, shown] = await cli.waitFor(/\[([^\s\]]+ [^\s\]]+ [^\s\]]+ [^\s\]]+)\]\? \[y\/N\]/, 30_000)
    const mine = fingerprintWords(key.deviceId).join(' ')
    if (shown !== mine) {
      cli.write('N\n')
      throw new SandboxError('enroll_failed', `the Mac showed [${shown}] for a device whose words are [${mine}]`)
    }
    // an answer under 500 ms after the question is typed ahead, a no (apps/bridge/src/enroll-cli.ts): answer as a person would
    await new Promise((r) => setTimeout(r, 600))
    cli.write('y\n')
    await cli.done(30_000)
    await waitUntil(
      async () => (await me(rec, cookieHeader)).device_pinned === true,
      'the Mac to pin the phone',
      30_000,
      250,
    )

    const phone: PhoneRecord = {
      device_id: key.deviceId,
      private_jwk: key.privateJwk,
      public_jwk: key.publicJwk,
      cookie: cookieHeader,
      last_seq: 0,
    }
    writeJson(files(rec.root).phone, phone)
    return phone
  } catch (e) {
    if (e instanceof SandboxError) throw e
    throw new SandboxError('enroll_failed', `${(e as Error).message}`)
  } finally {
    cli.kill()
  }
}

export function loadPhone(rec: SandboxRecord): PhoneRecord {
  const phone = readJson<PhoneRecord>(files(rec.root).phone)
  if (!phone) throw new SandboxError('no_phone', `sandbox ${rec.id} has no enrolled phone (phone.json is missing)`)
  return phone
}

export type Phone = {
  app: FakeApp
  record: PhoneRecord
  ready: Record<string, unknown>
  /** Set when the relay (or the network) closed the socket under the phone: the close code and reason. */
  closed: { code: number; reason: string } | null
  close: () => Promise<void>
}

/**
 * Why the phone's socket did not open, as a code a test can act on. The relay answering the upgrade with a status is not
 * the relay being down: a 429 is it slowing the phone down, any other status a refusal; only no answer at all is
 * `relay_unreachable`.
 */
export function connectFailure(e: unknown): {
  code: 'relay_rate_limited' | 'relay_refused' | 'relay_unreachable'
  detail: string
} {
  const msg = (e as Error)?.message || String(e)
  const status = Number(/Unexpected server response: (\d{3})/.exec(msg)?.[1])
  if (status === 429)
    return { code: 'relay_rate_limited', detail: 'the relay answered 429 (too many requests): wait, then try again' }
  if (status >= 400) return { code: 'relay_refused', detail: `the relay answered ${status} to the socket upgrade` }
  const code = (e as NodeJS.ErrnoException)?.code
  return {
    code: 'relay_unreachable',
    detail: `${code ?? msg} (is the relay down? see status; drive <id> online starts it again)`,
  }
}

/** Opens the phone's socket. `lastSeq` 0 asks for nothing older; the stored value catches up from the last visit. */
export async function connectPhone(rec: SandboxRecord, opts: { fromSeq?: number } = {}): Promise<Phone> {
  const record = loadPhone(rec)
  const deviceKey: DeviceKey = {
    privateKey: await importDevicePrivateKey(record.private_jwk),
    publicKey: await importDevicePublicKey(record.public_jwk),
    publicJwk: record.public_jwk,
    deviceId: record.device_id,
  }
  const app = new FakeApp({
    relayWs: rec.relay.origin.replace(/^http/, 'ws'),
    deviceKey,
    headers: { Cookie: record.cookie, Origin: rec.relay.origin },
    lastSeq: opts.fromSeq ?? record.last_seq,
    platform: 'sandbox',
  })
  let ready: Record<string, unknown>
  try {
    ready = (await app.connect()) as unknown as Record<string, unknown>
  } catch (e) {
    await app.close().catch(() => {})
    const f = connectFailure(e)
    throw new SandboxError(f.code, `the phone could not connect to ${rec.relay.origin}: ${f.detail}`)
  }
  const phone: Phone = {
    app,
    record,
    ready,
    closed: null,
    close: async () => {
      // what this visit saw is where the next one catches up from: but a backlog page that said `more` and was not
      // followed caps it at that page's end, or a live frame's seq would skip the pages never read
      const pages = app.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === 'catchup.batch')
      const last = pages.at(-1)?.raw
      const cap = last?.more === true && typeof last.to_seq === 'number' ? last.to_seq : Number.POSITIVE_INFINITY
      const seq = Math.max(record.last_seq, Math.min(app.lastSeq, cap))
      if (seq !== record.last_seq) writeJson(files(rec.root).phone, { ...record, last_seq: seq })
      await app.close().catch(() => {})
    },
  }
  app.ws?.on('close', (code, reason) => {
    phone.closed = { code, reason: reason.toString() }
  })
  return phone
}
