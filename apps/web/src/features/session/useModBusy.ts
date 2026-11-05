import { useStore } from 'zustand'
import { useSessionController } from './store.ts'

/** True while the live mod says a turn is running (CC-C3: thread status uses the mod's `busy`). */
export function useModBusy(): boolean {
  const ctl = useSessionController()
  return useStore(ctl.store, (s) => s.modOnline && s.state?.busy === true)
}
