// "Copy diagnostics" and "Report a problem" read the same facts about this install, from here: the versions, the kind of
// device and the content-free Health status. Both ends rely on `diagnosticsText` being content-free by construction.
import { PROTOCOL_VERSION } from '@talos-app/protocol'
import { getMacNotifyPermission } from '../../lib/native/notifyPermission.ts'
import { appVersion, deviceKind } from '../problems/environment.ts'
import { type DiagnosticsInput, diagnosticsText, macAppVersion } from './diagnostics.ts'
import type { HealthRow } from './rows.ts'

export type GatherInput = {
  rows: HealthRow[]
  at: string | null
  relay: string | null
  notes: string[]
}

const WHERE = { mac_app: 'Mac app', iphone_app: 'iPhone app', browser: 'Browser' } as const

/** The structured input `diagnosticsText` renders. Reads the page's own version, shell and notification state. */
export function gatherDiagnostics(g: GatherInput): DiagnosticsInput {
  const kind = deviceKind()
  return {
    app: appVersion(),
    protocol: PROTOCOL_VERSION,
    where: WHERE[kind === 'mac_app' ? 'mac_app' : kind === 'iphone_app' ? 'iphone_app' : 'browser'],
    rows: g.rows,
    at: g.at,
    macApp: macAppVersion(globalThis.navigator?.userAgent),
    relay: g.relay,
    macNotify: getMacNotifyPermission(),
    notes: g.notes,
  }
}

export function gatherDiagnosticsText(g: GatherInput): string {
  return diagnosticsText(gatherDiagnostics(g))
}
