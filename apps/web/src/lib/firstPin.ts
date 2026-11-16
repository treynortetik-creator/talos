// The bridge's device.pinned `first` (the agent's first device, on an agent never set up), handed from the socket client
// to whoever listens: features/agent-config/firstRun.ts registers at load and keeps it in sessionStorage, because the
// client that hears the pin (the enroll page's) is replaced by a new one right after sign-in.
let listener: (() => void) | null = null

export function onFirstPin(fn: (() => void) | null): void {
  listener = fn
}
export function firstPinned(): void {
  listener?.()
}
