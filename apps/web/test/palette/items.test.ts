// buildItems on its own: commands only for a query that starts with /, blocked ones carry the reason, and Search messages is last.
import type { InventoryCommandT } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { buildItems, type ItemInput } from '../../src/features/palette/items.ts'
import { DEFAULT_KEYMAP } from '../../src/lib/keymap.ts'

const cmd = (name: string, over: Partial<InventoryCommandT> = {}) =>
  ({ name, description: `${name} command`, source: 'user', route: 'message', ...over }) as InventoryCommandT

const base = (query: string): ItemInput => ({
  mode: 'palette',
  query,
  keymap: DEFAULT_KEYMAP,
  macApp: false,
  mac: true,
  showKeys: true,
  threads: [{ id: 'general', name: 'General' }],
  cards: [],
  currentThreadId: 'general',
  commands: [
    { cmd: cmd('deploy', { at_mac_only: true }), disabled: true, reason: 'At the Mac only' },
    { cmd: cmd('release-notes'), disabled: false, reason: '' },
  ],
  hasSession: false,
  hasSidebar: true,
})

describe('buildItems and slash commands', () => {
  it('a plain word never lists a command, even when commands are handed in', () => {
    for (const q of ['deploy', 'release', 'notes', 'e'])
      expect(buildItems(base(q)).filter((i) => i.run.type === 'slash')).toEqual([])
  })
  it('a query starting with / lists them: blocked ones say why and are marked disabled', () => {
    const items = buildItems(base('/'))
    const slash = items.filter((i) => i.run.type === 'slash')
    expect(slash.map((i) => i.label)).toEqual(['/deploy', '/release-notes'])
    expect(slash[0]).toMatchObject({ disabled: true, hint: 'At the Mac only' })
    expect(slash[1]?.disabled).toBeUndefined()
  })
  it('Search messages is the last item either way', () => {
    expect(buildItems(base('deploy')).at(-1)?.id).toBe('searchMessages')
    expect(buildItems(base('/dep')).at(-1)?.id).toBe('searchMessages')
  })
  it('no command is listed off a thread (there is nothing to send it to)', () => {
    expect(buildItems({ ...base('/'), currentThreadId: null }).some((i) => i.run.type === 'slash')).toBe(false)
  })
  it('the shortcuts item is not offered where the shortcuts are not shown (a phone)', () => {
    expect(buildItems(base('')).some((i) => i.id === 'shortcuts')).toBe(true)
    expect(buildItems({ ...base(''), showKeys: false }).some((i) => i.id === 'shortcuts')).toBe(false)
  })
})
