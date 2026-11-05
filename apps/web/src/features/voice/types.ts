// The slice of the WebRTC and device APIs the call controller needs. Real browser objects satisfy these; tests pass fakes.

export interface DataChannelLike {
  readonly readyState: string
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'close' | 'message', listener: (ev: { data?: unknown }) => void): void
}

export interface PeerLike {
  readonly iceGatheringState: string
  readonly localDescription: { sdp: string } | null
  addTrack(track: MediaStreamTrack, stream: MediaStream): unknown
  createDataChannel(label: string): DataChannelLike
  createOffer(): Promise<{ type: 'offer'; sdp?: string }>
  setLocalDescription(desc: { type: 'offer'; sdp?: string }): Promise<void>
  setRemoteDescription(desc: { type: 'answer'; sdp: string }): Promise<void>
  addEventListener(type: 'icegatheringstatechange', listener: () => void): void
  addEventListener(type: 'track', listener: (ev: { streams: readonly MediaStream[] }) => void): void
  close(): void
}

export interface AudioOut {
  srcObject: MediaStream | null
  play(): Promise<void>
  remove(): void
}

export interface VoiceMedia {
  /** `navigator.audioSession.type = 'play-and-record'` where it exists. */
  setPlayAndRecord(): void
  /** Screen Wake Lock; resolves a release function (a no-op where unsupported). */
  keepAwake(): Promise<() => void>
  /** Input level 0..1 for a stream, ~30 Hz. Returns a stop function. */
  meter(stream: MediaStream, onLevel: (level: number) => void): () => void
}

export type CallDeps = {
  fetch: typeof fetch
  getUserMedia(): Promise<MediaStream>
  createPeer(): PeerLike
  createAudio(): AudioOut
  media: VoiceMedia
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  /** Visibility/pagehide source. */
  lifecycle: {
    isHidden(): boolean
    onHidden(listener: () => void): () => void
    /** The page is shown again (the tab is foregrounded, or restored from the back/forward cache). */
    onVisible(listener: () => void): () => void
  }
}
