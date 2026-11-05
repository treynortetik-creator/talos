import { createStore, type StoreApi, useStore } from 'zustand'
import type { TalkMode } from './prefs.ts'

export type CallPhase = 'idle' | 'connecting' | 'live' | 'ending'

export type Handoff = {
  delegationId: string
  /** The exact text the app signed. */
  question: string
  state: 'working' | 'done' | 'failed'
  answer?: string
}

export type Caption = { who: 'owner' | 'agent'; text: string }

export type CallState = {
  phase: CallPhase
  threadId: string | null
  voiceSessionId: string | null
  muted: boolean
  mode: TalkMode
  /** Hold-to-talk: the button is down right now. */
  talking: boolean
  /** play() was rejected: show "Tap to hear". */
  needsTapToHear: boolean
  error: string | null
  captions: Caption[]
  handoffs: Handoff[]
  startedAt: number | null
}

export const initialCallState = (mode: TalkMode = 'hands_free'): CallState => ({
  phase: 'idle',
  threadId: null,
  voiceSessionId: null,
  muted: false,
  mode,
  talking: false,
  needsTapToHear: false,
  error: null,
  captions: [],
  handoffs: [],
  startedAt: null,
})

export type CallStore = StoreApi<CallState>

export function createCallStore(mode: TalkMode = 'hands_free'): CallStore {
  return createStore<CallState>(() => initialCallState(mode))
}

export function useCallStore<T>(store: CallStore, selector: (s: CallState) => T): T {
  return useStore(store, selector)
}
