// @vitest-environment jsdom
// <Mascot>: the right clip per state, the right container per engine, the still under reduced motion, one clip at a time.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Mascot, mascotSource, mascotStill } from '../src/ui/Mascot.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const reduced = (on: boolean) =>
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('reduce'), media: q }) as MediaQueryList)

describe('Mascot', () => {
  it('maps states to clips: HEVC .mov on Apple WebKit, VP9 .webm elsewhere', () => {
    expect(mascotSource('working', true)).toEqual({ src: '/brand/mascot/talos-working.mov', type: 'video/quicktime' })
    expect(mascotSource('working', false)).toEqual({ src: '/brand/mascot/talos-working.webm', type: 'video/webm' })
    expect(mascotSource('speaking', false).src).toBe('/brand/mascot/talos-talking.webm')
    expect(mascotSource('pleased', false).src).toBe('/brand/mascot/talos-idle.webm')
    expect(mascotStill('worried')).toBe('/brand/mascot/talos-worried.png')
  })

  it('reduced motion always shows the still, never a video', () => {
    reduced(true)
    const { container } = render(<Mascot state="working" size={120} />)
    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/brand/mascot/talos-working.png')
    expect(screen.getByRole('img', { name: 'Talos is working' })).toBeTruthy()
  })

  it('only the largest mascot on the page plays; the rest show their still', () => {
    reduced(false)
    const { container } = render(
      <>
        <Mascot state="working" size={36} decorative />
        <Mascot state="pleased" size={120} decorative />
      </>,
    )
    const videos = container.querySelectorAll('video')
    expect(videos).toHaveLength(1)
    expect(videos[0]?.closest('.mascot')?.getAttribute('data-clip')).toBe('idle')
    expect(videos[0]?.getAttribute('poster')).toBe('/brand/mascot/talos-idle.png')
  })

  it('animate={false} never plays', () => {
    reduced(false)
    const { container } = render(<Mascot state="worried" size={28} animate={false} decorative />)
    expect(container.querySelector('video')).toBeNull()
  })
})
