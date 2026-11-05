// Adapters to storage that belongs to the core module (WP1). WP4 owns neither the message table nor the thread table,
// so it reads history and writes call messages through these two ports. History comes from the core hub; call messages fan
// out to the apps as durable `reply` frames (they are never sent to the bridge: `voice.ended` carries the wrapped record).
import { type MessageT, newUlid } from '@talos-app/protocol'
import { findRuntime } from '../core/runtime.ts'
import type { RelayServices } from '../services.ts'

export interface VoiceHistory {
  /** The thread's most recent messages, any order. */
  recent(threadId: string, limit: number): Promise<MessageT[]> | MessageT[]
}

export interface VoiceMessageSink {
  /** Stores and fans out the call's messages (`call_record`, `voice_turn`). */
  append(messages: MessageT[]): Promise<void>
}

export type VoicePorts = { history: VoiceHistory; sink: VoiceMessageSink }

export function defaultPorts(services: RelayServices): VoicePorts {
  // Services built by `createRelayServices` carry the core runtime: seed calls from the real thread history. The unit-test
  // fakes have none, so they get an empty history.
  const hub = findRuntime(services)?.hub
  return {
    history: { recent: (threadId, limit) => hub?.recentMessages(threadId, limit) ?? [] },
    sink: {
      async append(messages) {
        for (const message of messages) {
          await services.bus.toApps(
            {
              v: 1,
              type: 'reply',
              id: newUlid(),
              ts: new Date(services.clock.now()).toISOString(),
              message,
              silent: true,
            },
            { durable: true },
          )
        }
      },
    },
  }
}

let override: Partial<VoicePorts> | null = null

export function setVoicePorts(ports: Partial<VoicePorts> | null): void {
  override = ports
}

export function resolvePorts(services: RelayServices): VoicePorts {
  return { ...defaultPorts(services), ...(override ?? {}) }
}
