// Copy has no live text of its own (a button's label changes and nothing more), so every Copy says so through the announcer.
import { announce } from './announce.ts'
import { ANNOUNCE, SOURCE } from './announceText.ts'

export function announceCopy(ok: boolean): void {
  announce(ok ? ANNOUNCE.copied : ANNOUNCE.copyFailed, SOURCE.copy, ok ? 'polite' : 'assertive')
}
