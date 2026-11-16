// Work that must run one at a time per key, while other keys go on. A job on several keys waits for all of them, and every
// later job on any of those keys waits for it.

export class KeyedChain {
  private tails = new Map<string, Promise<void>>()

  /** True while work on `key` is queued or running. */
  busy(key: string): boolean {
    return this.tails.has(key)
  }

  /** Every key with work queued or running right now. */
  busyKeys(): string[] {
    return [...this.tails.keys()]
  }

  /** Runs `fn` after everything already queued on any of `keys`. Its error is the caller's to catch: this never rejects. */
  run(keys: readonly string[], fn: () => Promise<unknown>): Promise<void> {
    const before = keys.map((k) => this.tails.get(k)).filter((p): p is Promise<void> => p !== undefined)
    const job: Promise<void> = Promise.all(before)
      .then(fn)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        for (const k of keys) if (this.tails.get(k) === job) this.tails.delete(k)
      })
    for (const k of keys) this.tails.set(k, job)
    return job
  }

  /** Resolves once every key is idle, including work queued while it waited. */
  async idle(): Promise<void> {
    while (this.tails.size) await Promise.all(this.tails.values())
  }
}
