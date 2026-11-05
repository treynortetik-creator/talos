// The label on a button that asks for the passkey. "Face ID" is true only on an iPhone or iPad; a Mac, a Windows PC or an
// Android phone unlocks the same passkey with Touch ID, Windows Hello, a PIN or a security key, so it says what it asks
// for: confirm it's you (audit M10).

import { capacitorPlatform } from './native.ts'
import { getPlatform } from './platform.ts'

export function onIphone(): boolean {
  try {
    return capacitorPlatform() === 'ios' || getPlatform().isIos()
  } catch {
    return false
  }
}

export function confirmLabel(): string {
  return onIphone() ? 'Confirm with Face ID' : "Confirm it's you"
}
