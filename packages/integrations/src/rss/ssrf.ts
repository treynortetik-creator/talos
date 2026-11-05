// The RSS poller's SSRF guard. The address rules live in @talos-app/protocol (one list for every caller); this file only
// names them the way the poller always has, and pins the feed fetch to the checked connection.
import { findBlockedAddress, isBlockedAddress } from '@talos-app/protocol'
import { createGuardedFetch } from '@talos-app/protocol/guarded-fetch'

const PRIVATE = 'feed address points at a private host'

/** True when the address is not a public unicast address. Same function every other caller of the web-address check uses. */
export const isPrivateAddress = isBlockedAddress

export function assertPublicAddress(addr: string): void {
  if (isBlockedAddress(addr)) throw new Error(PRIVATE)
}

/** Refuses when any of the resolved addresses is blocked, or when the name resolved to nothing. */
export function assertPublicAddresses(addrs: readonly string[]): void {
  if (addrs.length === 0 || findBlockedAddress(addrs) !== undefined) throw new Error(PRIVATE)
}

/**
 * The production fetch for feeds: opens the socket itself with a lookup that validates every resolved address at connect
 * time, so a hostname that rebinds to a private address between check and connect is refused.
 * Redirects are NOT followed (the caller re-validates each hop).
 */
export const guardedFetch: typeof fetch = createGuardedFetch({ message: PRIVATE }) as typeof fetch
