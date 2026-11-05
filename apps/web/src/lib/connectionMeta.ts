// Connection details the UI shows that `ClientState` (a frozen seam) does not carry: retry countdown, session loss,
// queued (not yet acked) owner messages and frames held until the Mac pins this device.
import { createContext, createElement, type ReactNode, useContext } from 'react'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'

export type ConnectionMeta = {
  /** Epoch ms of the next reconnect attempt, or null. */
  retryAt: number | null
  /** The relay closed with 4401 or a request got 401: send the owner to /login. */
  authFailed: boolean
  /** Why the relay ended the session (`expired`, `revoked`, `logged_out`, ...), or null when it did not say. Only `expired` keeps unsent messages. */
  authReason: string | null
  /** Owner messages in the outbox (sent or not) whose ack has not arrived. Clock icon in the timeline. */
  queuedIds: string[]
  /** Owner messages that did not go through. `retry`: tap to resend the same bytes; `final`: cannot be sent. */
  failed: Record<string, 'retry' | 'final'>
  /** Navigator reports no network. */
  networkOffline: boolean
  /** A relay close code that explains the last drop (4409, 4429...). */
  lastCloseCode: number | null
}

export const initialMeta = (): ConnectionMeta => ({
  retryAt: null,
  authFailed: false,
  authReason: null,
  queuedIds: [],
  failed: {},
  networkOffline: false,
  lastCloseCode: null,
})

export function createMetaStore(): StoreApi<ConnectionMeta> {
  return createStore<ConnectionMeta>(() => initialMeta())
}

const MetaContext = createContext<StoreApi<ConnectionMeta> | null>(null)
const fallback = createMetaStore()

export function MetaProvider({ store, children }: { store: StoreApi<ConnectionMeta>; children?: ReactNode }) {
  return createElement(MetaContext.Provider, { value: store }, children)
}

export function useConnectionMeta<T>(selector: (m: ConnectionMeta) => T): T {
  return useStore(useContext(MetaContext) ?? fallback, selector)
}
