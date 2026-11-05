// A push's Approve button arms one card (IOS-SPEC 6.4). The arm lives in memory only: the native shell sets it from
// `onNativePushAction`, so no URL, and therefore no link in agent text, can start an approval prompt. It is spent once, here
// at the store: when CardView acts on it, or when the card turns out to be gone, and it lapses after two minutes. It only ever
// ASKS a live card to start its normal primary flow (see CardView: Face ID first for a high-risk card); it approves nothing.
import { useSyncExternalStore } from 'react'

export const ARM_TTL_MS = 120_000

let armed: { id: string; at: number } | null = null
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

/** Arm card `id` (the native shell calls this for an Approve tap). Replaces any earlier arm. */
export function armCard(id: string, now: number = Date.now()): void {
  armed = { id, at: now }
  emit()
}

/** Spend the arm if it is for `id`. Safe to call more than once. */
export function spendArm(id: string): void {
  if (armed?.id !== id) return
  armed = null
  emit()
}

function snapshot(): string | null {
  if (armed && Date.now() - armed.at > ARM_TTL_MS) armed = null
  return armed?.id ?? null
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** The card id currently armed, or null. */
export const useArmedCard = (): string | null => useSyncExternalStore(subscribe, snapshot, () => null)

/** Tests only. */
export function resetArmForTests(): void {
  armed = null
  emit()
}
