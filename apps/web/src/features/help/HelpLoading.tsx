// Shown while the Help page's code loads (it is a separate chunk, so the rest of the app never waits for it).
export function HelpLoading() {
  return (
    <main className="grid h-dvh place-items-center overflow-clip bg-bg p-6 text-text">
      <p role="status" data-testid="help-loading" className="m-0 text-text-2">
        Loading Help…
      </p>
    </main>
  )
}
