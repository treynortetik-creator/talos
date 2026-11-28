// 0.16: one screen-reader announcer. Timers are fake; the regions are real DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANNOUNCER_ID, announce, cancelAnnouncement, resetAnnouncerForTests } from '../../src/lib/announce.ts'
import { ANNOUNCE, answered, needsYou, SOURCE, stopped, threadsNeedYou } from '../../src/lib/announceText.ts'

const spoken = (mode: 'polite' | 'assertive' = 'polite') =>
  Array.from(document.querySelectorAll(`[aria-live="${mode}"]`), (r) => r.textContent?.trim()).filter(Boolean)
const regionTexts = (mode: 'polite' | 'assertive' = 'polite') =>
  Array.from(document.querySelectorAll(`[aria-live="${mode}"]`), (r) => r.textContent)

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  resetAnnouncerForTests()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('announce', () => {
  it('speaks nothing until focus has settled, then speaks the waiting messages together', () => {
    const box = document.createElement('textarea')
    document.body.append(box)
    announce('Sent', 'a')
    announce('Copied', 'b')
    vi.advanceTimersByTime(200)
    box.focus() // focus moved: the wait starts again
    vi.advanceTimersByTime(200)
    expect(spoken()).toEqual([])
    vi.advanceTimersByTime(50)
    expect(spoken()).toEqual(['Sent. Copied'])
  })

  it('speaks the same message twice in a row, through the other region, once the repeat guard has passed', () => {
    announce('Copied')
    vi.advanceTimersByTime(250)
    const first = regionTexts()
    vi.advanceTimersByTime(1500)
    announce('Copied')
    vi.advanceTimersByTime(250)
    const second = regionTexts()
    expect(first).not.toEqual(second)
    expect(first.filter(Boolean)).toEqual(['Copied'])
    expect(second.filter(Boolean)).toEqual(['Copied'])
  })

  it('does not take the same words again within a second of speaking them', () => {
    announce('Copied')
    vi.advanceTimersByTime(250)
    const before = regionTexts()
    announce('Copied')
    vi.advanceTimersByTime(250)
    // not written again: the same region still holds it and the other one stays empty
    expect(regionTexts()).toEqual(before)
  })

  it('replaces a waiting message from the same source', () => {
    announce('Stopped Talos', 'stop')
    announce('Message sent again', 'stop')
    vi.advanceTimersByTime(250)
    expect(spoken()).toEqual(['Message sent again'])
  })

  it('collapses adjacent duplicates and speaks only the newest three of a burst', () => {
    announce('one')
    announce('one')
    announce('two')
    announce('three')
    announce('four')
    vi.advanceTimersByTime(250)
    expect(spoken()).toEqual(['two. three. four'])
  })

  it('clears what it said after 7 seconds', () => {
    announce('Sent')
    vi.advanceTimersByTime(250)
    expect(spoken()).toEqual(['Sent'])
    vi.advanceTimersByTime(7000)
    expect(spoken()).toEqual([])
  })

  it('cancelAnnouncement drops a waiting message and clears a spoken one', () => {
    announce('Marked done. Undo is available', 'u')
    cancelAnnouncement('u')
    vi.advanceTimersByTime(250)
    expect(spoken()).toEqual([])
    announce('Marked done. Undo is available', 'u')
    vi.advanceTimersByTime(250)
    expect(spoken()).toEqual(['Marked done. Undo is available'])
    cancelAnnouncement('u')
    expect(spoken()).toEqual([])
  })

  it('speaks an assertive message at once, in the assertive regions only', () => {
    announce("Couldn't copy", 'c', 'assertive')
    expect(spoken('assertive')).toEqual(["Couldn't copy"])
    expect(spoken('polite')).toEqual([])
    vi.advanceTimersByTime(250)
    expect(spoken('polite')).toEqual([])
    vi.advanceTimersByTime(7000)
    expect(spoken('assertive')).toEqual([])
  })

  it('keeps a polite message out of the assertive regions and does not merge the two', () => {
    announce('Sent')
    announce("Couldn't copy", undefined, 'assertive')
    vi.advanceTimersByTime(250)
    expect(spoken('polite')).toEqual(['Sent'])
    expect(spoken('assertive')).toEqual(["Couldn't copy"])
  })

  it('makes exactly one container with four regions, however many times it is called', () => {
    for (let i = 0; i < 50; i++) announce(`message ${i}`, `s${i % 5}`, i % 7 === 0 ? 'assertive' : 'polite')
    expect(document.querySelectorAll(`#${ANNOUNCER_ID}`)).toHaveLength(1)
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(4)
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(2)
    expect(document.querySelectorAll('[aria-live="assertive"]')).toHaveLength(2)
    expect(document.querySelectorAll('[role="status"], [role="alert"], [role="log"]')).toHaveLength(0)
  })

  it('does nothing where there is no document', () => {
    vi.stubGlobal('document', undefined)
    expect(() => announce('Sent')).not.toThrow()
    vi.unstubAllGlobals()
  })
})

describe('the words', () => {
  it('are pinned', () => {
    expect(ANNOUNCE).toEqual({
      copied: 'Copied',
      copyFailed: "Couldn't copy",
      sent: 'Sent',
      savedOffline: "Saved. It sends when you're back online.",
      savedUnapproved: 'Saved. It sends once this device is approved.',
      revisionSent: 'Revision sent',
      messageSentAgain: 'Message sent again',
      markedDone: 'Marked done. Undo is available',
      snoozed: 'Snoozed. Undo is available',
    })
    expect(answered('Approve')).toBe('Answered: Approve')
    expect(stopped('Talos', true)).toBe('Stopped Talos. Undo is available')
    expect(stopped('Talos', false)).toBe('Stopped Talos')
    expect(needsYou('Errands')).toBe('Errands needs you')
    expect(threadsNeedYou(3)).toBe('3 threads need you')
  })

  it('give each kind of event its own source', () => {
    const sources = [
      SOURCE.copy,
      SOURCE.sent,
      SOURCE.stop,
      SOURCE.undo,
      SOURCE.inboxUndo,
      SOURCE.needsYou,
      SOURCE.card('c1'),
    ]
    expect(new Set(sources).size).toBe(sources.length)
  })
})
