// The fake Mac's agent folder for Settings -> Memory folders: a few neutral folders, a pick held in memory, and the same
// refusals as the real Mac (a name that is not listed, an offline Mac).
import { MEMORY_ROOTS_WORDING } from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import type { MemoryFolders, MemoryFoldersClient } from './v2Client.ts'

export const FAKE_MEMORY_FOLDERS = [
  { name: 'journal', notes: 12 },
  { name: 'notes', notes: 48 },
  { name: 'projects', notes: 7 },
]

export function createFakeMemoryFolders(d: { macOnline: () => boolean }): MemoryFoldersClient & { chosen: string[] } {
  const state = { chosen: [] as string[] }
  const answer = (extra: Partial<MemoryFolders> = {}): MemoryFolders => ({
    folders: FAKE_MEMORY_FOLDERS,
    chosen: [...state.chosen],
    enabled: state.chosen.length > 0,
    saved: false,
    ...extra,
  })
  const online = () => {
    if (!d.macOnline()) throw new TalosClientError('mac_offline', 'Your Mac is away.')
  }
  return {
    get chosen() {
      return state.chosen
    },
    async list() {
      online()
      return answer()
    },
    async set(names) {
      online()
      if (names.some((n) => !FAKE_MEMORY_FOLDERS.some((f) => f.name === n)))
        return answer({ error: MEMORY_ROOTS_WORDING.unknown })
      state.chosen = [...new Set(names)]
      return answer({ saved: true })
    },
  }
}
