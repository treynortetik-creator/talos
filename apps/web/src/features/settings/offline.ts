// One rule for every control that changes the Mac's config: say why it can't work right now, in the same words everywhere.
// This device not connected comes first: while it (re)connects nothing current is known about the Mac, so it is never
// called "Mac is offline".
import { useShownConnection, useShownMacOnline } from '../../lib/linkShown.ts'

/** Why a change to the Mac's config can't be made now: 'link' (this device is not connected), 'mac' (the Mac is offline). */
export type WriteBlock = 'link' | 'mac' | null

export function useWriteBlock(): WriteBlock {
  // as the screen shows them (lib/linkShown.ts): a short drop does not flip every control to read-only and back
  const link = useShownConnection() === 'online'
  const mac = useShownMacOnline()
  return !link ? 'link' : !mac ? 'mac' : null
}

/** What a control says, or the settings screen says once for a section, while this device is not connected. */
export const NOT_CONNECTED_LINE = 'Connecting… Settings can be changed once you’re connected.'
