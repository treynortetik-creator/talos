// One interface, two ways to redeploy the relay (docs/deploy-railway.md): `requestRedeploy` asks, `appResult` reads what the app said.
//   via "token": a relay connected with `talos-app relay connect`. The bridge calls Railway itself with the pasted token (railway.ts).
//   via "app":   a relay the Mac app set up. The bridge never sees a Railway token: it writes a request file, the app redeploys and
//                writes a result file. Either way the relay's own /healthz is what says it moved.
import type { RelayConnectFileT, RelayRedeployErrorCodeT, SecretStore } from '@talos-app/protocol'
import { type AppResult, RAILWAY_ACCOUNT, RAILWAY_SERVICE, railwayStore, readResult, writeRequest } from './files.ts'
import { plainLine, Railway, RailwayError, type RailwayOptions } from './railway.ts'

/** A failure has the full line for the terminal (`text`) and a short plain reason for a thread row (`short`, no trailing full stop). */
export type Outcome =
  | { ok: true; id?: string }
  | { ok: false; code: RelayRedeployErrorCodeT; text: string; short: string }

export type RedeployDeps = {
  home: string
  now: () => number
  secrets: () => Promise<SecretStore>
  railway?: RailwayOptions
}

/** The plain fix for each code the app's result carries (the owner reads it in the thread and in the terminal). */
export const FIXES: Record<RelayRedeployErrorCodeT, string> = {
  not_signed_in: 'sign in to Railway again in the Talos app',
  no_card: 'add a payment card in Railway',
  railway_down: "Railway isn't answering; it will try again",
  not_found: "the relay service wasn't found; set it up again in the Talos app",
  other: "Railway didn't take the request",
}

/** The words for a failure the app reported: always the fixed line for its code, never the app's free text. */
export const appFailureText = (code: RelayRedeployErrorCodeT): string => FIXES[code]

/** The app's own short text, for `relay status` only: a thread row or a command's output never carries it (it is not ours). */
export const appDetail = (detail: string | undefined): string | undefined =>
  detail ? plainLine(detail).slice(0, 120) || undefined : undefined

const TOKEN_MISSING =
  "the Railway token is not in this computer's key store any more. Run talos-app relay connect again (in a terminal)."
const TOKEN_FIXES: Record<RelayRedeployErrorCodeT, string> = {
  ...FIXES,
  not_signed_in: 'Railway refused the saved token; make a new one and run talos-app relay connect',
  not_found: "Railway can't find the relay service any more",
}
const cut = (s: string): string => s.replace(/[.\s]+$/, '').slice(0, 160)

/** Asks for the relay to be redeployed onto `release`. Never throws: a failure is the outcome. */
export async function requestRedeploy(c: RelayConnectFileT, release: string, d: RedeployDeps): Promise<Outcome> {
  if (c.via === 'app') {
    try {
      return { ok: true, id: writeRequest(d.home, release, d.now()) }
    } catch (e) {
      const text = `the request for the Talos app could not be written (${(e as Error).message})`
      return { ok: false, code: 'other', text, short: cut(text) }
    }
  }
  let token: string | undefined
  try {
    token = await railwayStore(await d.secrets(), d.home).get(RAILWAY_SERVICE, RAILWAY_ACCOUNT)
  } catch (e) {
    const text = `the key store could not be read (${(e as Error).message})`
    return { ok: false, code: 'other', text, short: cut(text) }
  }
  if (!token)
    return {
      ok: false,
      code: 'not_signed_in',
      text: TOKEN_MISSING,
      short: 'the Railway token is missing; run talos-app relay connect again',
    }
  try {
    await new Railway({ kind: c.kind ?? 'project', token }, d.railway).redeploy(c.service_id, c.environment_id)
    return { ok: true }
  } catch (e) {
    if (e instanceof RailwayError)
      return {
        ok: false,
        code: e.code,
        text: e.message,
        short: e.code === 'other' ? cut(e.message) : TOKEN_FIXES[e.code],
      }
    return {
      ok: false,
      code: 'other',
      text: "Railway didn't take the request",
      short: "Railway didn't take the request",
    }
  }
}

/** via "app": what the app has said about this request so far. A token connection has no such answer. */
export const appResult = (c: RelayConnectFileT, home: string, id: string | undefined, release: string): AppResult =>
  c.via === 'app' && id ? readResult(home, id, release) : { state: 'none' }
