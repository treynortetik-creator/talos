// A WebSocket the test scripts by hand, for what the testkit relay cannot be told to say (a `ready` with counts and read
// marks, an answer held back until a later frame is on the wire). It answers `hello` with a `ready` built from `script`
// and records every frame the client sends; the test pushes anything else with `push`. The client under test is the real
// one, and every frame pushed here goes through the real protocol parser on its way in.
import { mkFrame } from '@talos-app/testkit'

export type ReadyScript = Record<string, unknown>

export function scriptedSockets(first: ReadyScript = {}) {
  const rig = {
    script: first,
    sockets: [] as ScriptedSocket[],
    /** Frames of one type the client sent, over every socket, oldest first. */
    sent: (type: string) => rig.sockets.flatMap((s) => s.sent.filter((f) => f.type === type)),
    /** Sends a relay frame to the client on the newest socket. */
    push: (frame: Record<string, unknown>) => rig.sockets.at(-1)?.onmessage?.({ data: JSON.stringify(frame) }),
    /** Drops the newest socket as a lost connection (close code 1006). */
    drop: () => rig.sockets.at(-1)?.close(),
    Impl: null as unknown as typeof WebSocket,
  }
  class ScriptedSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readyState = 0
    sent: Array<Record<string, unknown>> = []
    onopen: (() => void) | null = null
    onmessage: ((ev: { data: string }) => void) | null = null
    onclose: ((ev: { code: number; reason: string }) => void) | null = null
    onerror: (() => void) | null = null
    constructor() {
      rig.sockets.push(this)
      queueMicrotask(() => {
        if (this.readyState !== 0) return
        this.readyState = 1
        this.onopen?.()
      })
    }
    send(data: string) {
      const f = JSON.parse(data) as Record<string, unknown>
      this.sent.push(f)
      if (f.type !== 'hello') return
      this.onmessage?.({
        data: JSON.stringify(
          mkFrame('ready', {
            session_id: 'sess_scripted',
            policy: { max_frame_bytes: 262144, ping_ms: 25000 },
            server_seq: 9,
            presence: { bridge_online: true, last_seen: null, queue_depth: 0 },
            threads: [],
            open_cards: [],
            statuses: [],
            ...rig.script,
          }),
        ),
      })
    }
    close() {
      if (this.readyState === 3) return
      this.readyState = 3
      this.onclose?.({ code: 1006, reason: '' })
    }
  }
  rig.Impl = ScriptedSocket as unknown as typeof WebSocket
  return rig
}
