/* biome-ignore-all lint/suspicious/noExplicitAny: frames are untyped JSON */
// WP-V5 web (docs/V2-FEATURES.md V5.3): the real MemoryScreen, the real socket MemoryClient adapter and the real frames the
// bridge's memory service produced (captured over a synthetic notes folder). No Mac, no relay.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryScreen } from '../../src/features/memory/index.tsx'
import { linkPlan, renderNote, splitFrontmatter } from '../../src/features/memory/logic.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createSocketMemory } from '../../src/lib/socketMemory.ts'
import { macFrom, scenario } from './captured.ts'

afterEach(cleanup)

const bigNote = scenario('05-big-note-chunks.json')
const all = [
  ...scenario('01-roots-and-top.json'),
  ...scenario('02-note-links-frontmatter.json'),
  ...scenario('03-search.json'),
  ...scenario('04-listing-pages.json'),
  ...bigNote,
  ...scenario('06-refusals.json'),
]

/**
 * The captured big note as its two real chunk frames (same path, offsets, next_offset, sha256), with each chunk's text
 * cut to the lines either side of the seam. The full 185 KB costs jsdom's DOMPurify about 3 s a render on a loaded
 * machine, twice per test, which blew the 5 s budget; the seam is what "the chunks join up" is about. The full-size note
 * still runs in the browser e2e (memory.spec.ts).
 */
const SEAM_CHARS = 2_000
const seam = bigNote.map((s, i): typeof s => {
  const f = s.frame as Record<string, any>
  const text = String(f.text)
  const cut =
    i === 0
      ? text.slice(text.indexOf('\n', text.length - SEAM_CHARS) + 1) // a whole-line start, so no frontmatter guess
      : text.slice(0, SEAM_CHARS)
  return { ...s, frame: { ...f, text: cut } }
})

function Where() {
  const l = useLocation()
  return <p data-testid="where">{l.pathname + l.search}</p>
}

function mount(route = '/memory', opts: { fake?: ReturnType<typeof createFakeClient>; steps?: typeof all } = {}) {
  const client = opts.fake ?? createFakeClient()
  const mac = macFrom(opts.steps ?? all)
  ;(client as { memory: unknown }).memory = createSocketMemory({ ask: mac.ask as never })
  render(
    <ClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <MemoryScreen />
        <Where />
      </MemoryRouter>
    </ClientProvider>,
  )
  return { client, mac }
}

describe('socket MemoryClient adapter', () => {
  it('sends the frames the protocol defines and maps the answers', async () => {
    const mac = macFrom(all)
    const m = createSocketMemory({ ask: mac.ask as never })
    const roots = await m.tree(null, '', null)
    expect(roots.roots?.[0]?.id).toBe('notes')
    const top = await m.tree('notes', '', null)
    expect(top.entries.map((e) => e.name)).toContain('Overview.md')
    const note = await m.read('notes', 'Overview.md', 0)
    expect(note.nextOffset).toBeNull()
    expect(note.links?.find((l) => l.text === 'Secret plan')).toEqual({
      text: 'Secret plan',
      root_id: null,
      path: null,
    })
    expect(mac.asked.map((f) => f.type)).toEqual(['memory.tree', 'memory.tree', 'memory.read'])
    expect(mac.asked.every((f) => typeof f.request_id === 'string')).toBe(true)
  })
})

describe('logic', () => {
  it('frontmatter rows and body', () => {
    const r = splitFrontmatter('---\ntitle: A\ntags: [x, y]\n---\nbody')
    expect(r.rows).toEqual([
      ['title', 'A'],
      ['tags', '[x, y]'],
    ])
    expect(r.body).toBe('body')
    expect(splitFrontmatter('no front').rows).toEqual([])
  })
  it('a <script> in a note is text, never an element; null links are grey, resolved ones carry no path in the HTML', () => {
    const html = renderNote('hello <script>alert(1)</script> [[A]] [[B]]', [
      { text: 'A', root_id: 'notes', path: 'a.md' },
      { text: 'B', root_id: null, path: null },
    ])
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('data-mem-link="0"')
    expect(html).toContain('data-testid="memory-link-null"')
    expect(html).not.toContain('a.md')
    expect(renderNote('[[Unlisted]]', [])).toContain('[[Unlisted]]')
  })
})

describe('MemoryScreen', () => {
  it('one root opens at once; folders and notes list; a note shows frontmatter, grey and live links, and no script element', async () => {
    const user = userEvent.setup()
    mount()
    expect(await screen.findByTestId('memory-entry-Overview.md')).toBeTruthy()
    await user.click(screen.getByTestId('memory-entry-Overview.md'))
    const note = await screen.findByTestId('memory-note')
    // the header is the path line only: no display-cased file name above it
    expect(within(note).queryByRole('heading', { level: 2 })).toBeNull()
    expect(within(note).getByTestId('memory-note-path').textContent).toContain('Overview.md')
    expect(within(note).getByTestId('memory-frontmatter').textContent).toContain('status')
    expect(within(note).getByTestId('memory-frontmatter').textContent).toContain('draft')
    const body = screen.getByTestId('memory-body')
    expect(body.querySelector('script')).toBeNull()
    expect(body.textContent).toContain('<script>alert(1)</script>')
    expect(body.querySelectorAll('[data-testid="memory-link-null"]').length).toBe(2) // Secret plan, Missing note
    expect(body.textContent).toContain('[[Not a link]]') // inside a fence: left alone
    await user.click(within(body).getByText('Launch checklist'))
    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('Launch+checklist.md'))
  })

  it('.html is shown as source', async () => {
    mount('/memory?r=notes&n=page.html')
    const body = await screen.findByTestId('memory-body')
    expect(body.tagName).toBe('PRE')
    expect(body.textContent).toContain('<h1>Source</h1>')
    expect(body.querySelector('h1')).toBeNull()
  })

  it('a long listing loads the next page', async () => {
    const user = userEvent.setup()
    const dir = 'd'.repeat(144)
    mount(`/memory?r=notes&p=${dir}`)
    await screen.findByTestId('memory-list')
    // Counted with a selector, not getAllByRole: role queries over 500 rows in jsdom cost seconds per waitFor poll.
    const rows = () => screen.getByTestId('memory-list').querySelectorAll(':scope > li').length
    expect(rows()).toBe(339) // the captured first page
    await user.click(await screen.findByTestId('memory-load-more-list'))
    await waitFor(() => expect(rows()).toBe(339 + 161)) // and the second, appended
  })

  it('a long note loads its next chunk and the chunks join up', async () => {
    const user = userEvent.setup()
    mount('/memory?r=notes&n=big/Big note.md', { steps: [...all.filter((s) => !bigNote.includes(s)), ...seam] })
    await screen.findByTestId('memory-note')
    const [one, two] = seam.map((s) => String(s.frame?.text))
    const links = seam[0]?.frame?.links ?? []
    const path = String(seam[0]?.frame?.path)
    // what the screen does: one plan from the whole text so far, `complete` only once the last chunk is in
    const html = (text: string, complete: boolean) =>
      renderNote(splitFrontmatter(text).body, links, linkPlan(text, links, path, complete))
    expect(screen.getByTestId('memory-body').innerHTML).toBe(html(one as string, false))
    await user.click(await screen.findByTestId('memory-load-more'))
    await waitFor(() => expect(screen.queryByTestId('memory-load-more')).toBeNull())
    // exactly chunk one then chunk two: nothing lost, doubled or reordered at the seam
    expect(screen.getByTestId('memory-body').innerHTML).toBe(html(`${one}${two}`, true))
  })

  it('search shows hits through HitRow and a hit opens its note', async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByTestId('memory-search')
    await user.type(screen.getByTestId('memory-search'), 'quarterly release')
    const hit = await screen.findByTestId('hit-row', undefined, { timeout: 3000 })
    expect(hit.textContent).toContain('projects/example/plan.md')
    await user.click(hit)
    // (the capture holds no read of this note; the click is what is under test)
    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('n=projects%2Fexample%2Fplan.md'))
  })

  it('Ask sends a signed message with refs for the note, in the chosen thread', async () => {
    const user = userEvent.setup()
    const { client } = mount('/memory?r=notes&n=Overview.md')
    await screen.findByTestId('memory-note')
    await user.click(screen.getByTestId('memory-ask'))
    await user.click(await screen.findByTestId('memory-ask-send'))
    await waitFor(() => expect((client as any).sent.some((f: any) => f.type === 'message' && f.refs)).toBe(true))
    const f = (client as any).sent.find((x: any) => x.type === 'message')
    expect(f.refs).toEqual([
      { kind: 'memory', root_id: 'notes', path: 'Overview.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ])
    expect(f.attachments).toEqual([])
    expect(f.osig).toBeTruthy()
  })

  it('off, hidden and offline states say what to do', async () => {
    const off = createFakeClient()
    ;(off as { memory: unknown }).memory = createSocketMemory({
      ask: (async () => {
        const { TalosClientError } = await import('../../src/lib/client.ts')
        throw new TalosClientError('memory_off', 'off')
      }) as never,
    })
    render(
      <ClientProvider client={off}>
        <MemoryRouter initialEntries={['/memory']}>
          <MemoryScreen />
        </MemoryRouter>
      </ClientProvider>,
    )
    expect((await screen.findByTestId('memory-off')).textContent).toContain(
      'Turn it on at your Mac: talos-app memory on',
    )
    cleanup()
    mount('/memory?r=notes&n=private/Secret plan.md')
    expect((await screen.findByTestId('memory-error')).textContent).toContain("isn't shared")
  })

  it('with the Mac offline and the feature last-known: "Needs your Mac"', async () => {
    const client = createFakeClient({ macOffline: true })
    mount('/memory', { fake: client })
    expect(await screen.findByTestId('memory-needs-mac')).toBeTruthy()
  })
})
