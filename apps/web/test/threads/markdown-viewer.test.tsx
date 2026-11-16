// @vitest-environment jsdom
// The Markdown file viewer: a .md attachment renders in the app through the one markdown renderer. Real components, real media gate
// (fetch stubbed). Covers render, outline, source toggle, copy, the sibling-image rule, sanitization and the >1 MB chunked path.
import { type AttachmentRefT, newId } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentView } from '../../src/features/threads/Attachments.tsx'
import { MarkdownFileCard } from '../../src/features/threads/MarkdownFileCard.tsx'
import { isMarkdownAtt, LARGE_BYTES, splitDoc } from '../../src/features/threads/markdownDoc.ts'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'
import { renderMarkdown, resolveSiblingImage } from '../../src/lib/markdown.ts'
import { setPlatform, webPlatform } from '../../src/lib/platform.ts'

const mk = (name: string, kind: AttachmentRefT['kind'], mime: string, size = 100): AttachmentRefT => ({
  media_id: newId('md'),
  kind,
  role: 'attachment',
  mime,
  name,
  size,
  sha256: 'a'.repeat(64),
})
const doc = mk('notes.md', 'file', 'text/markdown')
const pic = mk('chart.png', 'image', 'image/png')
const client = { onFrame: () => () => {}, fetchMedia: () => {} } as unknown as TalosClient

let body = ''
beforeEach(() => {
  body = ''
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_u: string, init?: RequestInit) =>
      init?.method === 'HEAD' ? new Response(null, { status: 200 }) : new Response(body, { status: 200 }),
    ),
  )
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0))
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setPlatform(webPlatform)
})

async function show(text: string, siblings: AttachmentRefT[] = [], att = doc) {
  body = text
  const r = render(
    <ClientProvider client={client}>
      <MarkdownFileCard att={att} siblings={siblings} />
    </ClientProvider>,
  )
  await act(async () => {
    await new Promise((res) => setTimeout(res, 20))
  })
  return r
}

describe('which attachments open in the viewer', () => {
  it('a .md or .markdown file or a text/markdown mime, never an html page or a plain file', () => {
    expect(isMarkdownAtt(doc)).toBe(true)
    expect(isMarkdownAtt(mk('README.MD', 'file', 'application/octet-stream'))).toBe(true)
    expect(isMarkdownAtt(mk('x', 'file', 'text/markdown; charset=utf-8'))).toBe(true)
    expect(isMarkdownAtt(mk('a.markdown', 'file', 'text/plain'))).toBe(true)
    expect(isMarkdownAtt(mk('a.txt', 'file', 'text/plain'))).toBe(false)
    expect(isMarkdownAtt(mk('a.md', 'html', 'text/html'))).toBe(false)
  })
  it('the timeline attachment view shows the card, not the file chip, and keeps Share / Download under it', async () => {
    body = '# Hi'
    render(
      <ClientProvider client={client}>
        <AttachmentView att={doc} message={{ attachments: [doc, pic] } as never} onOpenImage={() => {}} />
      </ClientProvider>,
    )
    await act(async () => {
      await new Promise((res) => setTimeout(res, 20))
    })
    expect(screen.getByTestId('md-card')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Hi' })).toBeTruthy()
    expect(screen.getAllByTestId('attachment-share').length).toBeGreaterThan(0)
  })
})

describe('render', () => {
  it('headings, a table and a code block with a Copy button', async () => {
    await show('# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1\n```\n')
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy()
    expect(document.querySelector('table td')?.textContent).toBe('1')
    expect(document.querySelector('pre code')?.textContent).toContain('const x = 1')
    expect(document.querySelector('[data-copy-code]')).toBeTruthy()
  })
  it('a table takes keyboard focus, so one too wide for the screen can be scrolled with the arrow keys', async () => {
    await show('| a | b |\n|---|---|\n| 1 | 2 |\n')
    expect(document.querySelector('table')?.getAttribute('tabindex')).toBe('0')
  })
  it('Copy puts the code (without the button label) on the clipboard', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await show('```\nnpm test\n```\n')
    await act(async () => {
      fireEvent.click(document.querySelector('[data-copy-code]') as Element)
    })
    expect(writeText).toHaveBeenCalledWith('npm test\n')
  })
  it('a link leaves the app through platform.openExternal', async () => {
    const openExternal = vi.fn(() => true)
    setPlatform({ ...webPlatform, openExternal })
    await show('[site](https://example.com/x)')
    fireEvent.click(screen.getByRole('link', { name: 'site' }))
    expect(openExternal).toHaveBeenCalledWith('https://example.com/x')
  })
})

describe('outline (contents)', () => {
  const long = '# One\n\ntext\n\n## Two\n\ntext\n\n### Three\n\ntext\n'
  it('is offered from three headings, lists them, and a click jumps to the heading', async () => {
    await show(long)
    fireEvent.click(screen.getByRole('button', { name: 'Contents' }))
    const nav = screen.getByRole('navigation', { name: 'Contents of notes.md' })
    expect(
      within(nav)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['One', 'Two', 'Three'])
    fireEvent.click(within(nav).getByRole('button', { name: 'Three' }))
    await act(async () => {})
    const h3 = screen.getByRole('heading', { name: 'Three' })
    expect(h3.id).not.toBe('')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    expect(document.activeElement).toBe(h3)
  })
  it('a short note has no Contents button', async () => {
    await show('# One\n\ntext\n')
    expect(screen.queryByRole('button', { name: 'Contents' })).toBeNull()
  })
})

describe('source toggle', () => {
  it('Source shows the raw text and Rendered goes back; the state is on the buttons', async () => {
    await show('# Title\n\n**bold**')
    const src = screen.getByRole('button', { name: 'Source' })
    expect(src.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(src)
    expect(screen.getByTestId('md-source').textContent).toBe('# Title\n\n**bold**')
    expect(screen.queryByRole('heading', { name: 'Title' })).toBeNull()
    expect(src.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Rendered' }))
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy()
  })
})

describe('relative images resolve only from the same attachment set', () => {
  it('a bare name (or ./name) of an image attachment of the message shows that attachment', async () => {
    await show('![a chart](chart.png) ![b](./chart.png)', [doc, pic])
    const imgs = Array.from(document.querySelectorAll('img'))
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual([`/media/${pic.media_id}?c=2`, `/media/${pic.media_id}?c=2`])
    expect(imgs[0]?.getAttribute('alt')).toBe('a chart')
  })
  it('everything else stays a link chip with no img: other names, paths, parents, schemes, remote and absolute', async () => {
    await show(
      [
        '![1](other.png)',
        '![2](../chart.png)',
        '![3](sub/chart.png)',
        '![4](/etc/passwd)',
        '![5](file:///etc/passwd)',
        '![6](https://evil.example/x.png)',
        '![7](data:image/png;base64,AAAA)',
        '![8](chart.png?x=1)',
        '![9](%2e%2e%2fchart.png)',
      ].join('\n\n'),
      [doc, pic],
    )
    expect(document.querySelectorAll('img').length).toBe(0)
    expect(document.querySelectorAll('.md-image-chip').length).toBeGreaterThan(0)
  })
  it('only images count: a sibling that is not an image is never an img', async () => {
    const other = mk('data.csv', 'file', 'text/csv')
    await show('![x](data.csv)', [doc, other])
    expect(document.querySelectorAll('img').length).toBe(0)
  })
  it('resolveSiblingImage is an exact-name lookup', () => {
    const m = new Map([['a.png', '/media/x?c=2']])
    expect(resolveSiblingImage(m, 'a.png')).toBe('/media/x?c=2')
    expect(resolveSiblingImage(m, 'A.png')).toBeUndefined()
    expect(resolveSiblingImage(m, 'constructor')).toBeUndefined()
    expect(resolveSiblingImage(m, '%')).toBeUndefined()
  })
  it('the default renderer (messages) never draws an img, even with a sibling-looking name', () => {
    expect(renderMarkdown('![x](chart.png)')).not.toContain('<img')
  })
})

describe('sanitization: nothing in a .md executes', () => {
  it('a <script>, an onerror and a javascript: link do nothing', async () => {
    const g = globalThis as unknown as { __pwned?: number }
    g.__pwned = 0
    await show(
      [
        '<script>globalThis.__pwned = 1</script>',
        '<img src=x onerror="globalThis.__pwned = 2">',
        '<a href="javascript:globalThis.__pwned=3">raw</a>',
        '[click](javascript:globalThis.__pwned=4)',
        '![x](javascript:globalThis.__pwned=5)',
        '<iframe src="https://evil.example"></iframe>',
        '<svg onload="globalThis.__pwned=6"></svg>',
      ].join('\n\n'),
      [doc, pic],
    )
    await act(async () => {
      await new Promise((res) => setTimeout(res, 20))
    })
    const region = screen.getByTestId('md-region')
    expect(region.querySelector('script, iframe, svg, img, [onerror], [onload]')).toBeNull()
    expect(region.querySelector('a[href^="javascript:" i]')).toBeNull()
    // the markdown link with a javascript: target is not a link at all: it stays as the text it was
    expect(screen.queryByRole('link', { name: 'click' })).toBeNull()
    for (const a of Array.from(region.querySelectorAll('a'))) fireEvent.click(a)
    fireEvent.click(region)
    expect(g.__pwned).toBe(0)
    // the raw text stays readable as text, not as markup
    expect(region.textContent).toContain('globalThis.__pwned = 1')
  })
})

describe('large files (> 1 MB): chunked, drawn on demand', () => {
  const para = `${'word '.repeat(100)}\n\n`
  const big = () => {
    let s = '# Start\n\n'
    for (let i = 0; i < 2600; i++) s += i % 400 === 0 ? `## Part ${i}\n\n${para}` : para
    return `${s}# End\n\n\`\`\`\nthe last block\n\`\`\`\n`
  }
  it('splitDoc: one chunk under the limit, many above, never inside a code fence, heading list is complete', () => {
    expect(splitDoc('# a\n\ntext').chunks.length).toBe(1)
    const text = big()
    expect(text.length).toBeGreaterThan(LARGE_BYTES)
    const { chunks, headings } = splitDoc(text)
    expect(chunks.length).toBeGreaterThan(5)
    expect(chunks.map((c) => c.text).join('\n')).toBe(text)
    expect(headings.map((h) => h.text)).toContain('End')
    const fenced = `${'x\n\n'.repeat(10)}\`\`\`\n${'code line\n\n'.repeat(40_000)}\`\`\`\n\nafter\n`
    for (const c of splitDoc(fenced, 1000).chunks) expect((c.text.match(/^```/gm) ?? []).length % 2).toBe(0)
  })
  it('draws only the first part, says so, and Show more / Show all draw the rest', async () => {
    const text = big()
    await show(text)
    const { chunks } = splitDoc(text)
    expect(screen.getByTestId('md-large-note').textContent).toContain(String(chunks.length))
    expect(document.querySelectorAll('[data-chunk]').length).toBe(1)
    expect(screen.queryByText('the last block')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }))
    expect(document.querySelectorAll('[data-chunk]').length).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(document.querySelectorAll('[data-chunk]').length).toBe(chunks.length)
    expect(screen.queryByTestId('md-more')).toBeNull()
  })
  it('a Contents jump to a heading in an undrawn part draws that part and lands on the heading', async () => {
    await show(big())
    fireEvent.click(screen.getByRole('button', { name: 'Contents' }))
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'End' }))
    await act(async () => {})
    const h = screen.getByRole('heading', { name: 'End' })
    expect(document.activeElement).toBe(h)
  })
  it('the 30 MB case: the split is a single cheap pass and one part is drawn', () => {
    const huge = 'line of text here\n\n'.repeat(1_700_000)
    const t0 = performance.now()
    const { chunks } = splitDoc(huge)
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(chunks.length).toBeGreaterThan(100)
  })
})
