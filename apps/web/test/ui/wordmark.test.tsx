// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import file from '../../../../assets/brand/wordmark/wordmark.svg?raw'
import { Sidebar } from '../../src/features/threads/Nav.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { Wordmark } from '../../src/ui/Wordmark.tsx'
import { WORDMARK_PATH } from '../../src/ui/wordmark-path.ts'
import { setup } from '../cards/helpers.tsx'

afterEach(cleanup)

describe('Wordmark', () => {
  it('Talos: one accessible image, drawn as the committed vector (assets/brand/wordmark/wordmark.svg)', () => {
    render(<Wordmark name="Talos" />)
    const img = screen.getByRole('img', { name: 'Talos' })
    const svg = img.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe(/viewBox="([^"]+)"/.exec(file)?.[1])
    expect(svg?.querySelector('path')?.getAttribute('d')).toBe(/ d="([^"]+)"/.exec(file)?.[1])
    expect(svg?.querySelector('path')?.getAttribute('fill')).toBe('currentColor') // a theme still colours it
    expect(img.textContent).toBe('') // no text: no font to fall back
  })

  it('the drawing is TΛLOS: five letters on the baseline, the Λ from cap height to baseline, wide end down, 0.06 em gaps', () => {
    // parsed here, not by the generator: a wrong flip that was regenerated would still fail this
    const subpaths: { x: number; y: number }[][] = []
    let cur = { x: 0, y: 0 }
    for (const [, cmd, args] of WORDMARK_PATH.matchAll(/([MLHVQCZ])([^MLHVQCZ]*)/g)) {
      const n = (args as string)
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number)
      if (cmd === 'M') subpaths.push([])
      const pts = subpaths.at(-1) as { x: number; y: number }[]
      const step = (p: { x: number; y: number }) => {
        cur = p
        pts.push(p)
      }
      if (cmd === 'H') for (const x of n) step({ x, y: cur.y })
      else if (cmd === 'V') for (const y of n) step({ x: cur.x, y })
      else for (let i = 0; i + 1 < n.length; i += 2) step({ x: n[i] as number, y: n[i + 1] as number })
    }
    const box = (pts: { x: number; y: number }[]) => ({
      x0: Math.min(...pts.map((p) => p.x)),
      x1: Math.max(...pts.map((p) => p.x)),
      y0: Math.min(...pts.map((p) => p.y)),
      y1: Math.max(...pts.map((p) => p.y)),
      pts,
    })
    // glyphs: subpaths whose x ranges overlap (an O's counter sits inside the O)
    const glyphs: ReturnType<typeof box>[] = []
    for (const b of subpaths.map(box).sort((a, b) => a.x0 - b.x0)) {
      const last = glyphs.at(-1)
      if (last && b.x0 <= last.x1) glyphs[glyphs.length - 1] = box([...last.pts, ...b.pts])
      else glyphs.push(b)
    }
    expect(glyphs).toHaveLength(5)
    const [t, lambda, l] = glyphs as [ReturnType<typeof box>, ReturnType<typeof box>, ReturnType<typeof box>]
    const baseline = l.y1 // L has no overshoot: its foot is the baseline
    expect(t.y1).toBe(baseline)
    for (const g of glyphs.slice(3)) expect(g.y1 - baseline).toBeLessThanOrEqual(20) // O and S overshoot a little
    expect(lambda.y1).toBe(baseline) // the Λ stands on the baseline...
    expect(lambda.y0).toBe(l.y0) // ...and its point is at cap height, the top of the L
    const spanAt = (y: number) => {
      const xs = lambda.pts.filter((p) => Math.abs(p.y - y) < 40).map((p) => p.x)
      return Math.max(...xs) - Math.min(...xs)
    }
    expect(spanAt(baseline)).toBeGreaterThan(spanAt(lambda.y0) * 4) // wide end down: a Λ, not a V
    for (let i = 1; i < 5; i++) {
      const gap = (glyphs[i] as ReturnType<typeof box>).x0 - (glyphs[i - 1] as ReturnType<typeof box>).x1
      expect(Math.abs(gap - 60)).toBeLessThan(3) // 0.06 em of the font's 1000 units (control points can poke out a little)
    }
  })

  it('a custom name is plain text, no image role', () => {
    render(<Wordmark name="Athena" className="x" />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Athena')).toBeTruthy()
  })
})

describe('Sidebar brand', () => {
  it('shows the Talos wordmark', () => {
    render(
      <ClientProvider client={setup()}>
        <MemoryRouter>
          <Sidebar />
        </MemoryRouter>
      </ClientProvider>,
    )
    expect(screen.getByRole('img', { name: 'Talos' })).toBeTruthy()
  })
})
