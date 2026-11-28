// The "Started." bar (the Schedules notice): on the job's own screen it is lifted above the button bar; everywhere else it is
// where it always was.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Notice } from '../../src/features/schedules/shared.tsx'

afterEach(cleanup)

describe('Notice', () => {
  it('stays at the foot of the screen by default', () => {
    render(<Notice text="Started." onClose={() => {}} />)
    const cls = screen.getByTestId('schedules-notice').className
    expect(cls).toContain('bottom-24')
    expect(cls).not.toContain('safe-area-inset-bottom')
  })
  it('is lifted above the button bar, with the safe area, when asked', () => {
    render(<Notice text="Started." onClose={() => {}} aboveBar />)
    const cls = screen.getByTestId('schedules-notice').className
    expect(cls).toContain('safe-area-inset-bottom')
    expect(cls).not.toContain('bottom-24')
  })
})
