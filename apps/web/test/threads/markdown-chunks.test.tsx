// 0.18 in the real component: a short reply is drawn exactly as before; a long one is drawn in pieces inside the one prose box.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown } from '../../src/features/threads/Markdown.tsx'
import type { RunContext } from '../../src/features/threads/RunButton.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { LARGE_MARKDOWN_CHUNK_MAX_CHARS } from '../../src/lib/markdownChunks.ts'

afterEach(cleanup)

const para = (n: number) => `Paragraph ${n}: ${'word '.repeat(60).trim()}.`
const paras = (count: number, from = 0) => Array.from({ length: count }, (_, i) => para(from + i)).join('\n\n')
const code = (n: number) => `\`\`\`sh\necho ${n}\n\`\`\``

describe('Markdown in pieces', () => {
  it('draws a short reply as one prose box with no piece wrappers', () => {
    const { container } = render(<Markdown text={`# Hi\n\n${code(1)}`} />)
    expect(container.querySelectorAll('.prose-talos')).toHaveLength(1)
    expect(container.querySelectorAll('[data-md-chunk]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-copy-code]')).toHaveLength(1)
  })

  it('draws a long reply as pieces inside the one prose box, each code block with one Copy button', () => {
    const text = `${paras(30)}\n\n${code(1)}\n\n${paras(30, 40)}\n\n${code(2)}\n\n${paras(30, 80)}\n\n${code(3)}`
    const { container } = render(<Markdown text={text} />)
    expect(container.querySelectorAll('.prose-talos')).toHaveLength(1)
    const pieces = container.querySelectorAll('.prose-talos > [data-md-chunk]')
    expect(pieces.length).toBeGreaterThan(2)
    expect(container.querySelectorAll('pre')).toHaveLength(3)
    expect(container.querySelectorAll('[data-copy-code]')).toHaveLength(3)
    expect(container.textContent).toContain('Paragraph 0:')
    expect(container.textContent).toContain('Paragraph 109:')
  })

  it('gives every runnable shell block its Run slot, one for one with the parsed blocks', () => {
    const run: RunContext = { threadId: 'general', messageId: 'm1' }
    const text = `${paras(30)}\n\n${code(1)}\n\n${paras(30, 40)}\n\n${code(2)}`
    const { container } = render(
      <ClientProvider client={createFakeClient()}>
        <Markdown text={text} run={run} />
      </ClientProvider>,
    )
    expect(container.querySelectorAll('.run-block')).toHaveLength(2)
  })

  it('keeps the nodes of earlier pieces (and their Copy buttons) when the text grows', () => {
    const base = `${code(1)}\n\n${paras(40)}\n\n${code(2)}\n\n${paras(10, 60)}`
    const { container, rerender } = render(<Markdown text={base} />)
    const firstPre = container.querySelector('pre')
    const firstButton = container.querySelector('[data-copy-code]')
    expect(firstPre).not.toBeNull()
    rerender(<Markdown text={`${base}\n\n${paras(3, 100)}`} />)
    expect(container.querySelector('pre')).toBe(firstPre)
    expect(container.querySelector('[data-copy-code]')).toBe(firstButton)
    expect(container.textContent).toContain('Paragraph 102:')
  })

  it('shows one piece too large to parse as its text, not as parsed markup', () => {
    // One paragraph with no blank line cannot be cut, so it is one piece past the limit. Parsed, its **bold** would become a
    // <strong>; shown as source it stays the literal asterisks. (Inside a fence it would not be parsed either way.)
    const big = `${'**bold** '.repeat(10)}${'y'.repeat(LARGE_MARKDOWN_CHUNK_MAX_CHARS)}`
    const text = `${paras(5)}\n\n${big}\n\n${paras(5, 9)}`
    const { container } = render(<Markdown text={text} />)
    expect(container.textContent).toContain('**bold**')
    expect(container.querySelector('strong')).toBeNull()
    expect(container.textContent).toContain('Paragraph 9:')
  })
})
