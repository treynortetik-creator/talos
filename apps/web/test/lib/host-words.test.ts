// The app's words for the agent's computer (src/lib/hostWords.ts): from the bridge's host feature, "your computer" otherwise.
import { hostOf } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { hostWords } from '../../src/lib/hostWords.ts'

describe('hostWords', () => {
  it('Mac, Windows, and unknown', () => {
    expect(hostWords(hostOf(['search/1', 'host/mac'])).computer).toBe('your Mac')
    const win = hostWords(hostOf(['host/windows']))
    expect(win.computer).toBe('your PC')
    expect(win.restart).toBe('Talos needs a restart on your PC: click the Talos icon by the clock, then Restart Talos.')
    expect(win.offline).toBe('Your PC is off or asleep. Talos answers again when it is on.')
    for (const f of [undefined, [], ['search/1'], ['host/linux']]) {
      const w = hostWords(hostOf(f))
      expect(w.computer).toBe('your computer')
      expect(`${w.offline} ${w.restart}`).not.toMatch(/Mac|PC\b|Windows/)
    }
  })
})
