// What the frame handlers (socket-frames-*.ts) reach in createSocketClient. Built once there; a variable that
// createSocketClient reassigns is read through a function, so a handler sees its value when the frame arrives.
import type { CardT, DeviceKey, Frame, FrameOf, MessageT } from '@talos-app/protocol'
import type { StoreApi } from 'zustand/vanilla'
import type { ClientState, TalosClientError } from './client.ts'
import type { OutboxEntry } from './socketClient.ts'
import type { createUnknownNotes } from './unknownFrames.ts'

export type FrameContext = {
  store: StoreApi<ClientState>
  set: (fn: (s: ClientState) => Partial<ClientState>) => void
  now: () => number
  lostIds: Set<string>
  patchMessage: (id: string, fn: (m: MessageT) => MessageT) => void
  upsertMessage: (m: MessageT) => void
  upsertCard: (card: CardT) => void
  withSeq: (m: MessageT, frame: { relay?: { seq: number } }) => MessageT
  bumpSeq: (frame: { relay?: { seq: number } }) => void
  bumpUnread: (threadId: string) => void
  findMessage: (id: string) => MessageT | undefined
  clearFailed: (clientMsgId: string) => void
  markFailed: (clientMsgId: string, kind: 'retry' | 'final') => void
  addSystemRow: (text: string, id: string, threadId?: string) => void
  emit: (type: string, frame: Record<string, unknown>) => void
  settleConfig: (id: string, err?: TalosClientError) => boolean
  configWaiters: Map<
    string,
    {
      baseRev: number
      resolve: () => void
      reject: (e: TalosClientError) => void
      timer: ReturnType<typeof setTimeout>
    }
  >
  mediaFetchIds: Map<string, string>
  pending: Map<
    string,
    { resolve: (seq: number | undefined) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >
  historyGen: Map<string, number>
  historyAsked: Map<string, string>
  contextRequests: Set<string>
  latestRequests: Set<string>
  historyWaiters: Map<string, (p: FrameOf<'history.page'>) => void>
  historyErrors: Map<string, (e: TalosClientError) => void>
  inboxSettled: (frameId: string, keep?: boolean) => boolean
  onAcked: (frameId: string) => Promise<void>
  dropFromOutbox: (frameId: string) => Promise<void>
  flushOutbox: () => Promise<void>
  dispatch: (frame: Frame, isCatchup?: boolean) => void
  send: (fields: Record<string, unknown>) => void
  isRecord: (v: unknown) => v is Record<string, unknown>
  applyStoredOwnerFrame: (raw: Record<string, unknown>) => void
  noteUnknown: ReturnType<typeof createUnknownNotes>
  getKey: () => DeviceKey | null
  getOutbox: () => OutboxEntry[]
  getResetGen: () => number
  bumpResetGen: () => void
}
