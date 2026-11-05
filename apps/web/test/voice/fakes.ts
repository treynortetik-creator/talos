import type { CallDeps, DataChannelLike, PeerLike } from '../../src/features/voice/types.ts'

type Listener = (ev: { data?: unknown }) => void

export class FakeDataChannel implements DataChannelLike {
  readyState = 'open'
  readonly sent: Array<Record<string, unknown>> = []
  private listeners = new Map<string, Listener[]>()
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 'closed'
  }
  addEventListener(type: 'open' | 'close' | 'message', l: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l])
  }
  /** Delivers a server event as the data channel would. */
  emit(event: Record<string, unknown>) {
    for (const l of this.listeners.get('message') ?? []) l({ data: JSON.stringify(event) })
  }
  drop() {
    this.readyState = 'closed'
    for (const l of this.listeners.get('close') ?? []) l({})
  }
  of(type: string) {
    return this.sent.filter((e) => e.type === type)
  }
}

export class FakeTrack {
  private on = true
  /** Every value ever assigned to `enabled`, in order. */
  readonly sets: boolean[] = []
  get enabled() {
    return this.on
  }
  set enabled(v: boolean) {
    this.sets.push(v)
    this.on = v
  }
  stopped = false
  stop() {
    this.stopped = true
  }
}

export class FakePeer implements PeerLike {
  iceGatheringState = 'complete'
  localDescription: { sdp: string } | null = null
  readonly log: string[] = []
  dc = new FakeDataChannel()
  remote: string | null = null
  closed = false
  private onTrack: ((ev: { streams: readonly MediaStream[] }) => void) | null = null
  /** `enabled` of each track at the moment it was handed to the peer (after that, audio can flow). */
  readonly enabledAtAdd: boolean[] = []
  addTrack(track?: { enabled: boolean }) {
    if (track) this.enabledAtAdd.push(track.enabled)
    this.log.push('addTrack')
  }
  createDataChannel(label: string) {
    this.log.push(`createDataChannel:${label}`)
    return this.dc
  }
  async createOffer() {
    this.log.push('createOffer')
    return { type: 'offer' as const, sdp: 'v=0\r\no=- offer\r\n' }
  }
  async setLocalDescription(d: { sdp?: string }) {
    this.log.push('setLocalDescription')
    this.localDescription = { sdp: d.sdp ?? '' }
  }
  async setRemoteDescription(d: { sdp: string }) {
    this.log.push('setRemoteDescription')
    this.remote = d.sdp
  }
  addEventListener(type: string, l: never) {
    if (type === 'track') this.onTrack = l
  }
  close() {
    this.closed = true
  }
  /** The same fake reused for the next call in a test: a fresh channel, open again. */
  reopen() {
    this.closed = false
    this.dc = new FakeDataChannel()
    this.log.length = 0
    this.onTrack = null
  }
  /** Simulates the remote audio arriving. */
  ontrack() {
    this.onTrack?.({ streams: [{} as MediaStream] })
  }
}

/** After any call has ended, for any reason: no microphone track live, no peer open, no wake lock held. */
export function expectNothingLeftOpen(f: {
  tracks: FakeTrack[]
  peers: FakePeer[]
  wake: { taken: number; released: number }
}) {
  for (const [i, t] of f.tracks.entries()) if (!t.stopped) throw new Error(`microphone track ${i} is still live`)
  for (const [i, p] of f.peers.entries()) if (!p.closed) throw new Error(`peer ${i} is still open`)
  if (f.wake.taken !== f.wake.released) throw new Error('a screen wake lock is still held')
}

export type FetchCall = { url: string; init: RequestInit }

const streamOf = (track: FakeTrack) =>
  ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream

export function fakeDeps(over: Partial<CallDeps> & { fetchResponses?: Array<Response | Error> } = {}) {
  const track = new FakeTrack()
  const tracks: FakeTrack[] = [] // every microphone actually handed out
  const peers: FakePeer[] = []
  const peer = new FakePeer()
  const wake = { taken: 0, released: 0 }
  const audios: Array<{ removed: boolean }> = []
  let micCalls = 0
  const calls: FetchCall[] = []
  const audio = { srcObject: null as MediaStream | null, played: 0, rejectPlay: false, removed: false }
  const responses = over.fetchResponses ?? []
  let now = 1_000_000
  const hiddenListeners = new Set<() => void>()
  const visibleListeners = new Set<() => void>()
  let hidden = false
  const stall = { on: false }
  const deps: CallDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const next = responses.shift()
      if (next instanceof Error) throw next
      if (next) return next
      if (url.endsWith('/close')) return new Response(null, { status: 204 })
      const signal = init?.signal
      if (next === undefined && signal && responses.length === 0 && stall.on && !url.endsWith('/close')) {
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }
      return Response.json({
        voice_session_id: 'v_01JBF3V7Q8K2M4N6P8R0S2T426',
        sdp_answer: 'v=0\r\na=answer\r\n',
        max_minutes: 30,
      })
    }) as typeof fetch,
    // The first microphone is `track`; a second request in the same test gets a fresh, registered one.
    getUserMedia: async () => {
      const t = micCalls++ === 0 ? track : new FakeTrack()
      tracks.push(t)
      return streamOf(t)
    },
    createPeer: () => {
      // One call at a time reuses `peer` (so `f.peer` keeps meaning "the call"); an overlapping start gets its own.
      const reuse = !peers.includes(peer) || peer.closed
      if (reuse && peers.includes(peer)) peer.reopen()
      const p = reuse ? peer : new FakePeer()
      if (!peers.includes(p)) peers.push(p)
      return p
    },
    createAudio: () => ({
      get srcObject() {
        return audio.srcObject
      },
      set srcObject(v) {
        audio.srcObject = v
      },
      async play() {
        audio.played++
        if (audio.rejectPlay) throw new Error('NotAllowedError')
      },
      remove() {
        audio.removed = true
      },
    }),
    media: {
      setPlayAndRecord: () => void 0,
      keepAwake: async () => {
        wake.taken++
        let done = false
        return () => {
          if (!done) wake.released++
          done = true
        }
      },
      meter: () => () => void 0,
    },
    now: () => now,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as number),
    lifecycle: {
      isHidden: () => hidden,
      onHidden(l) {
        hiddenListeners.add(l)
        return () => void hiddenListeners.delete(l)
      },
      onVisible(l) {
        visibleListeners.add(l)
        return () => void visibleListeners.delete(l)
      },
    },
    ...over,
  }
  return {
    deps,
    track,
    peer,
    calls,
    audio,
    advance: (ms: number) => {
      now += ms
    },
    hide: () => {
      hidden = true
      for (const l of [...hiddenListeners]) l()
    },
    show: () => {
      hidden = false
      for (const l of [...visibleListeners]) l()
    },
    /** Every microphone this test handed out, every peer, and the wake lock count. */
    tracks,
    peers,
    wake,
    audios,
    /** From now on the session POST never answers by itself; only the controller's own timeout ends it. */
    stallPost: () => {
      stall.on = true
    },
    /** A stream the test hands out itself (a gated microphone request), registered so the helper sees it. */
    mint: () => {
      const t = new FakeTrack()
      tracks.push(t)
      return { track: t, stream: streamOf(t) }
    },
    openSessions: () => calls.filter((c) => c.url.endsWith('/api/voice/session')).length,
  }
}
