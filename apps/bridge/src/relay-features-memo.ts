// The relay's last `ready.features`, kept across bridge restarts (relay-client.ts reads it before its first hello).
//
// Why: the hello's features list follows what the relay takes (packages/protocol/src/features-cap.ts), and a hello that
// leaves out something the relay takes is sent again on a new socket. That second dial costs the apps the bridge for a
// moment: presence goes offline and back, and whatever an app asked on the first socket (a schedules list, an app view's
// request) is never answered. With no file the client assumes the relay takes the whole list (every relay since 5367f571
// does). The file matters when a relay said otherwise: after a 4401 it holds the empty list, so the next start sends the
// 20 any relay takes at once instead of being refused first.
//
// The file is the relay's word only, tied to the relay URL it came from. A list that does not parse, or one from another
// relay, is no list (the wide first hello, with its one fallback). A file that cannot be written is logged and costs at
// most one extra dial at the next start.
import { FeatureList } from '@talos-app/protocol'
import { readJsonFile, removeFile, writeJsonAtomic } from './fsutil.ts'
import type { Logger } from './log.ts'

export type RelayFeaturesMemo = {
  /** The list a `ready` from this relay last carried ([] after a 4401: the safe list), or null when there is none to trust. */
  load(): readonly string[] | null
  /** Remembers `features` for this relay; null forgets it. Never throws. */
  save(features: readonly string[] | null): void
}

export function relayFeaturesMemo(path: string, relayUrl: string, log: Logger): RelayFeaturesMemo {
  return {
    load() {
      const raw = readJsonFile<{ relay?: unknown; features?: unknown }>(path)
      if (!raw || typeof raw !== 'object' || raw.relay !== relayUrl) return null
      const parsed = FeatureList.safeParse(raw.features)
      return parsed.success ? parsed.data : null
    },
    save(features) {
      try {
        if (features === null) removeFile(path)
        else writeJsonAtomic(path, { relay: relayUrl, features: [...features] })
      } catch (e) {
        log.warn('relay features not remembered: the next start dials twice', { error: (e as Error).message })
      }
    },
  }
}
