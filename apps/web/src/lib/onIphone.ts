// True on an iPhone or iPad: the iPhone app, or Safari there. Settings asks before signing this iPhone out, because only a new
// setup link from the Mac brings it back (U10).

import { capacitorPlatform } from './native.ts'
import { getPlatform } from './platform.ts'

export function onIphone(): boolean {
  try {
    return capacitorPlatform() === 'ios' || getPlatform().isIos()
  } catch {
    return false
  }
}
