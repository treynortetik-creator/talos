// Wires the memory browser into the bridge (docs/V2-FEATURES.md V5): one call from bridge.ts. Off until `talos-app memory
// init`; the service is still installed (and `memory/1` advertised) so the app can say "turn it on at your Mac".
import type { BridgeContext } from '../context.ts'
import { MemoryBrowser } from './service.ts'

export function installMemory(ctx: BridgeContext, opts: { watch?: boolean } = {}): () => void {
  const svc = new MemoryBrowser({
    home: ctx.env.home,
    clock: ctx.clock,
    log: ctx.log,
    switchOn: () => ctx.config.config.memory_browser,
    watch: opts.watch ?? process.env.TALOS_APP_MEMORY_WATCH !== '0',
  })
  if (!svc.available) return () => {}
  ctx.memory = svc
  return () => svc.stop()
}
