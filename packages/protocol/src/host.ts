// What kind of computer the bridge runs on, as a bridge feature (hello.client.features, echoed in presence.features): the
// app picks its wording from it ("your Mac", "your PC"), and says "your computer" when none is listed (an older bridge,
// or a device not yet pinned, which gets no presence features).
export const HOST_MAC_FEATURE = 'host/mac'
/** Windows: the bridge runs in Talos's own WSL distro, behind the Talos icon by the clock. */
export const HOST_WINDOWS_FEATURE = 'host/windows'
export const HOST_LINUX_FEATURE = 'host/linux'

export type Host = 'mac' | 'windows' | 'linux'

export function hostOf(features: readonly string[] | undefined): Host | null {
  if (!features) return null
  if (features.includes(HOST_WINDOWS_FEATURE)) return 'windows'
  if (features.includes(HOST_MAC_FEATURE)) return 'mac'
  if (features.includes(HOST_LINUX_FEATURE)) return 'linux'
  return null
}
