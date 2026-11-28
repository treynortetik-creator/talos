// A byte ring with an absolute stream offset: `head` is how many bytes have ever been pushed, `start` is the oldest one still held.
// In memory only. A watched pane's ring is shared by every viewer of that pane (service.ts).
export class Ring {
  private buf: Uint8Array
  private total = 0

  constructor(readonly capacity: number) {
    this.buf = new Uint8Array(capacity)
  }

  /** Bytes pushed so far, ever: the next byte's offset. */
  get head(): number {
    return this.total
  }
  /** The offset of the oldest byte still held. */
  get start(): number {
    return Math.max(0, this.total - this.capacity)
  }

  push(data: Uint8Array): void {
    // more than the ring holds: only the tail can matter
    const d = data.length > this.capacity ? data.subarray(data.length - this.capacity) : data
    const first = (this.total + (data.length - d.length)) % this.capacity
    const room = this.capacity - first
    if (d.length <= room) this.buf.set(d, first)
    else {
      this.buf.set(d.subarray(0, room), first)
      this.buf.set(d.subarray(room), 0)
    }
    this.total += data.length
  }

  /** Up to `max` bytes from offset `from`, which must be inside [start, head]. A copy. */
  slice(from: number, max: number): Uint8Array {
    if (from < this.start || from > this.total) throw new RangeError('offset is not in the ring')
    const n = Math.min(max, this.total - from)
    const out = new Uint8Array(n)
    const at = from % this.capacity
    const first = Math.min(n, this.capacity - at)
    out.set(this.buf.subarray(at, at + first), 0)
    if (first < n) out.set(this.buf.subarray(0, n - first), first)
    return out
  }
}
