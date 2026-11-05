// What a problem report may say about where it happened: versions and the kind of device, from the same sources
// "Copy diagnostics" uses. Nothing here can hold a message, a name or an address.
import { PROTOCOL_VERSION, type ProblemT } from '@talos-app/protocol'
import { detectShell } from '../../lib/native/detect.ts'
import { isNativeShell } from '../../lib/native.ts'
import { iosAppVersion, macAppVersion } from '../health/diagnostics.ts'

export type DeviceKind = ProblemT['device']

export function deviceKind(): DeviceKind {
  if (detectShell() === 'desktop') return 'mac_app'
  if (isNativeShell()) return 'iphone_app'
  return 'browser'
}

export const appVersion = (): string => import.meta.env.VITE_APP_VERSION ?? '0.0.0'

/** `{ app, protocol, shell? }`: the shell version is the Mac app's or the iPhone app's own, when this page runs in one. */
export function versionsNow(relay?: string | null): ProblemT['versions'] {
  const ua = globalThis.navigator?.userAgent
  const shell = macAppVersion(ua) ?? iosAppVersion(ua)
  return {
    app: appVersion().slice(0, 40),
    protocol: String(PROTOCOL_VERSION),
    ...(shell ? { shell: shell.slice(0, 40) } : {}),
    ...(relay ? { relay: relay.slice(0, 40) } : {}),
  }
}
