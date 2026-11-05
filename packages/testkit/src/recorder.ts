import type { Frame, FrameType } from '@talos-app/protocol'
import { waitScale } from './frame-utils.ts'

export type RecordedFrame<D extends string = string> = {
  n: number
  direction: D
  frame: Frame
  /** The object exactly as JSON.parse'd from the wire (use this for signature checks). */
  raw: Record<string, unknown>
  text: string
}

export type ExpectOptions = {
  timeoutMs?: number
  direction?: string
  since?: number
  /** The wait is itself the assertion ("no such frame within N ms"): do not scale the budget. */
  exact?: boolean
}

/** Records frames and lets tests await one (`expectFrame`), whether it already arrived or arrives later. */
export class Recorder<D extends string = string> {
  readonly frames: RecordedFrame<D>[] = []
  private waiters: Array<{ match: (r: RecordedFrame<D>) => boolean; resolve: (r: RecordedFrame<D>) => void }> = []

  record(direction: D, raw: Record<string, unknown>, text: string): RecordedFrame<D> {
    const r: RecordedFrame<D> = { n: this.frames.length, direction, frame: raw as unknown as Frame, raw, text }
    this.frames.push(r)
    for (const w of [...this.waiters]) {
      if (w.match(r)) {
        this.waiters = this.waiters.filter((x) => x !== w)
        w.resolve(r)
      }
    }
    return r
  }

  of<T extends FrameType>(type: T, direction?: D): Array<Extract<Frame, { type: T }>> {
    return this.frames
      .filter((r) => r.frame.type === type && (direction === undefined || r.direction === direction))
      .map((r) => r.frame as Extract<Frame, { type: T }>)
  }

  expectFrame<T extends FrameType>(
    type: T,
    predicate: (f: Extract<Frame, { type: T }>, r: RecordedFrame<D>) => boolean = () => true,
    opts: ExpectOptions & { direction?: D } = {},
  ): Promise<Extract<Frame, { type: T }>> {
    const match = (r: RecordedFrame<D>) =>
      r.frame.type === type &&
      (opts.direction === undefined || r.direction === opts.direction) &&
      r.n >= (opts.since ?? 0) &&
      predicate(r.frame as Extract<Frame, { type: T }>, r)
    const existing = this.frames.find(match)
    if (existing) return Promise.resolve(existing.frame as Extract<Frame, { type: T }>)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.waiters = this.waiters.filter((w) => w !== waiter)
          const errors = this.frames
            .filter((r) => r.frame.type === 'error')
            .map((r) => {
              const e = r.frame as unknown as { code?: string; message?: string }
              return `${e.code ?? '?'}: ${e.message ?? ''}`.slice(0, 160)
            })
          reject(
            new Error(
              `timed out waiting for ${type} frame (${this.frames.length} frames seen: ${this.summary()}${errors.length ? `; error frames: ${errors.join(' | ')}` : ''})`,
            ),
          )
        },
        (opts.timeoutMs ?? 3000) * (opts.exact ? 1 : waitScale()),
      )
      const waiter = {
        match,
        resolve: (r: RecordedFrame<D>) => {
          clearTimeout(timer)
          resolve(r.frame as Extract<Frame, { type: T }>)
        },
      }
      this.waiters.push(waiter)
    })
  }

  /** Resolves after `ms` if NO matching frame arrives (and none already did). For "must not happen" assertions. */
  async expectNoFrame<T extends FrameType>(
    type: T,
    predicate: (f: Extract<Frame, { type: T }>) => boolean = () => true,
    ms = 200,
    opts: { direction?: D; since?: number } = {},
  ): Promise<void> {
    const hit = (r: RecordedFrame<D>) =>
      r.frame.type === type &&
      (opts.direction === undefined || r.direction === opts.direction) &&
      r.n >= (opts.since ?? 0) &&
      predicate(r.frame as Extract<Frame, { type: T }>)
    if (this.frames.some(hit)) throw new Error(`unexpected ${type} frame was recorded`)
    await new Promise((r) => setTimeout(r, ms))
    if (this.frames.some(hit)) throw new Error(`unexpected ${type} frame arrived`)
  }

  get length() {
    return this.frames.length
  }

  summary(): string {
    return this.frames.map((r) => `${r.direction}:${r.frame.type}`).join(', ')
  }
}
