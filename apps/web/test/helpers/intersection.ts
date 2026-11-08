// jsdom has no IntersectionObserver, and the permission card's Allow stays off until one reports the call box and the Allow button
// fully visible (it fails closed). `installAlwaysVisible()` is for the tests that are not about that gate: every target reports
// "fully visible". It is installed per test file (never globally: other screens read the observer's absence). A test about the gate
// uses `installIntersection()`, whose observers report only what the test tells them.
export function installAlwaysVisible() {
  const g = globalThis as unknown as { IntersectionObserver: unknown }
  const original = g.IntersectionObserver
  class AlwaysVisible {
    constructor(private cb: IntersectionObserverCallback) {}
    observe(target: Element) {
      queueMicrotask(() =>
        this.cb(
          [{ target, isIntersecting: true, intersectionRatio: 1 } as unknown as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        ),
      )
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  g.IntersectionObserver = AlwaysVisible
  return () => {
    g.IntersectionObserver = original
  }
}

// A controllable IntersectionObserver for the tests about the Allow gate: records every observer the card creates (its root,
// threshold and rootMargin) and lets the test say which target is fully visible. Restores the always-visible default after.
type Opts = { root?: Element | null; rootMargin?: string; threshold?: number | number[] }
export type FakeIO = { opts: Opts; targets: Element[]; live: boolean; report(target: Element, visible: boolean): void }

export function installIntersection() {
  const g = globalThis as unknown as { IntersectionObserver: unknown }
  const original = g.IntersectionObserver
  const all: FakeIO[] = []
  class Fake {
    opts: Opts
    targets: Element[] = []
    live = true
    constructor(
      private cb: IntersectionObserverCallback,
      opts: Opts = {},
    ) {
      this.opts = opts
      all.push(this as unknown as FakeIO)
    }
    observe(t: Element) {
      this.targets.push(t)
    }
    unobserve() {}
    disconnect() {
      this.live = false
    }
    takeRecords() {
      return []
    }
    report(target: Element, visible: boolean) {
      this.cb(
        [
          {
            target,
            isIntersecting: visible,
            intersectionRatio: visible ? 1 : 0.4,
          } as unknown as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      )
    }
  }
  g.IntersectionObserver = Fake
  return {
    all,
    live: () => all.filter((o) => o.live),
    restore: () => {
      g.IntersectionObserver = original
    },
  }
}
