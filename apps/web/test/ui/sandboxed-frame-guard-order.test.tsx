// @vitest-environment jsdom
// The focus guard has to know which box the owner is in before a fast page can take focus, so SandboxedFrame installs it in a
// layout effect (before paint, before every passive effect). A component placed BEFORE the frame has its passive effect run
// first in tree order: if the install were a passive effect too, the install would come second.
import { render } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'

const order: string[] = []
vi.mock('../../src/ui/frameFocusGuard.ts', () => ({
  installFrameFocusGuard: () => {
    order.push('install guard')
    return () => {}
  },
}))

const { SandboxedFrame } = await import('../../src/ui/SandboxedFrame.tsx')

function Earlier() {
  useEffect(() => {
    order.push('passive effect of an earlier sibling')
  }, [])
  return null
}

describe('SandboxedFrame', () => {
  it('installs the focus guard before any passive effect runs', () => {
    render(
      <>
        <Earlier />
        <SandboxedFrame title="t" src="about:blank" />
      </>,
    )
    expect(order).toEqual(['install guard', 'passive effect of an earlier sibling'])
  })
})
