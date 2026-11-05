// Test page for the Playwright specs in ../call.spec.ts. Not part of the app bundle. It mounts WP4's real components
// against the in-memory client, with a real (fake-device) microphone and a scripted peer connection and data channel,
// and a stand-in for the shell's composer so "the button is hidden once there is text" can be checked.

import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../src/theme/tokens.css'
import './harness.css'
import { CallErrorLine } from '../../../src/features/voice/CallErrorLine.tsx'
import { CallController } from '../../../src/features/voice/callController.ts'
import { CallBar, LiveCallButton, setCallController, useIsOnCall } from '../../../src/features/voice/index.tsx'
import { browserDeps } from '../../../src/features/voice/media.ts'
import type { DataChannelLike, PeerLike } from '../../../src/features/voice/types.ts'
import { ClientProvider } from '../../../src/lib/client.ts'
import { createFakeClient } from '../../../src/lib/fakeClient.ts'

class HarnessChannel implements DataChannelLike {
  readyState = 'open'
  sent: Array<Record<string, unknown>> = []
  private listeners: Array<(ev: { data?: unknown }) => void> = []
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 'closed'
  }
  addEventListener(type: string, l: (ev: { data?: unknown }) => void) {
    if (type === 'message') this.listeners.push(l)
  }
  emit(event: Record<string, unknown>) {
    for (const l of this.listeners) l({ data: JSON.stringify(event) })
  }
}

const channel = new HarnessChannel()
let localStream: MediaStream | null = null

let local: { sdp: string } | null = null
const peer: PeerLike = {
  iceGatheringState: 'complete',
  get localDescription() {
    return local
  },
  addTrack() {},
  createDataChannel: () => channel,
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\no=- harness\r\n' }
  },
  async setLocalDescription(d) {
    local = { sdp: d.sdp ?? '' }
  },
  async setRemoteDescription() {},
  addEventListener() {},
  close() {},
}

const base = browserDeps()
const client = createFakeClient({ replyDelayMs: 600 })
const controller = new CallController({
  ...base,
  getUserMedia: async () => {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    return localStream
  },
  createPeer: () => peer,
})
setCallController(controller)

declare global {
  interface Window {
    __voice: {
      emit(event: Record<string, unknown>): void
      sent(): Array<Record<string, unknown>>
      trackEnabled(): boolean | null
      trackState(): string | null
      emitReply(delegationId: string, text: string): void
    }
  }
}
window.__voice = {
  emit: (e) => channel.emit(e),
  sent: () => channel.sent,
  trackEnabled: () => localStream?.getAudioTracks()[0]?.enabled ?? null,
  trackState: () => localStream?.getAudioTracks()[0]?.readyState ?? null,
  emitReply: (delegationId, text) =>
    client.emit('reply', {
      voice_delegation_id: delegationId,
      message: {
        id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4ZZ',
        thread_id: 'general',
        author: 'agent',
        kind: 'text',
        text,
        format: 'plain',
        attachments: [],
        via: 'voice',
        created_at: '2026-10-28T15:00:00.000Z',
      },
    }),
}

function Composer() {
  const [text, setText] = useState('')
  const onCall = useIsOnCall()
  return (
    <main style={{ padding: 16, background: 'var(--bg)', color: 'var(--text)', minHeight: '100dvh' }}>
      <h1 style={{ margin: 0 }}>General</h1>
      {onCall ? (
        <CallBar threadId="general" onEnd={() => {}} />
      ) : (
        <>
          <CallErrorLine threadId="general" />
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <textarea aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} />
            {text === '' && <LiveCallButton threadId="general" />}
          </div>
        </>
      )}
    </main>
  )
}

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <ClientProvider client={client}>
      <Composer />
    </ClientProvider>,
  )
