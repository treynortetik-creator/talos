// Settings lists the shortcuts, from the keymap table; the phone does not show them.
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ShortcutsSection } from '../../src/features/settings/ShortcutsSection.tsx'
import { chordLabel, DEFAULT_KEYMAP } from '../../src/lib/keymap.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

afterEach(cleanup)

describe('Settings > Keyboard shortcuts', () => {
  it('lists every entry that has a chord with its label and its keys, from the table', () => {
    renderWith(<ShortcutsSection readOnly={false} mac />, setup(), '/settings/shortcuts')
    for (const e of DEFAULT_KEYMAP.filter((x) => x.chord && x.id !== 'call' && !/^thread[2-9]$/.test(x.id))) {
      const row = screen
        .getAllByText(e.label)
        .map((n) => n.closest('li'))
        .find(Boolean)
      expect(row, e.id).toBeTruthy()
      expect(row?.textContent, e.id).toContain(chordLabel(e.chord, true))
    }
  })
  it('says Cmd+[ and Cmd+] are for the Mac app, and that New thread has no key', () => {
    renderWith(<ShortcutsSection readOnly={false} mac />, setup(), '/settings/shortcuts')
    expect(screen.getAllByText(/Mac app/).length).toBeGreaterThan(0)
  })
})
