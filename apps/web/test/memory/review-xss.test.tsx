// @vitest-environment jsdom
/* biome-ignore-all lint/suspicious/noExplicitAny: frames are untyped JSON */
// Adversarial review of WP-V5 (PR #44): hostile notes, as frames the REAL bridge memory service produced over a synthetic
// folder (apps/bridge/scripts/review-capture-memory-xss.ts -> captured/memory/review-xss.json), rendered by the real
// MemoryScreen + NoteView + socket adapter. No element with an event handler, no <img>/<svg>, may come out of a note.
// FAILS ON PR HEAD: renderNote() rewrites DOMPurify's OUTPUT with a regex; a title attribute holding `>` ends the
// regex's `<a ...>` match early, and the rest of the attribute (an <img onerror>) is re-emitted as live markup.
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryScreen } from '../../src/features/memory/index.tsx'
import { renderNote } from '../../src/features/memory/logic.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createSocketMemory } from '../../src/lib/socketMemory.ts'
import { macFrom, scenario } from './captured.ts'

afterEach(cleanup)
const steps = scenario('review-xss.json')
const frameFor = (path: string) => steps.find((s) => s.frame?.path === path)?.frame as Record<string, any>

function mount(path: string) {
  const client = createFakeClient()
  ;(client as { memory: unknown }).memory = createSocketMemory({ ask: macFrom(steps).ask as never })
  render(
    <ClientProvider client={client}>
      <MemoryRouter initialEntries={[`/memory?r=notes&n=${encodeURIComponent(path)}`]}>
        <MemoryScreen />
      </MemoryRouter>
    </ClientProvider>,
  )
}

const ACTIVE = 'img, svg, script, iframe, object, embed, [onerror], [onload], [onclick], [style]'

describe('hostile notes render inert', () => {
  for (const path of ['title-img.md', 'title-svg.md', 'mixed.md', 'front.md']) {
    it(`${path}: no live element or handler in the note body`, async () => {
      mount(path)
      const body = await screen.findByTestId('memory-body')
      expect(body.querySelectorAll(ACTIVE).length).toBe(0)
      expect(body.innerHTML).not.toMatch(/<(img|svg|script)\b/i)
    })
  }

  it('renderNote itself never emits markup a sanitizer would have removed', () => {
    const f = frameFor('title-img.md')
    const html = renderNote(String(f.text), f.links ?? [])
    expect(html).not.toMatch(/<img\b/i)
    expect(html).not.toMatch(/onerror=/i)
  })
})
