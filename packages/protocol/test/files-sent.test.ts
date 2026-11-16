// files.sent / files.sent_list (frames-files-sent.ts): the Files sheet's list of files sent in Talos.
import { describe, expect, it } from 'vitest'
import { FILES_SENT_NAME_MAX, FILES_SENT_PAGE_MAX, parseFrame, sentFileType } from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const fixtures = loadFixtures()
const q = fixtures['files.sent'] as Record<string, unknown>
const filters = q.filters as Record<string, unknown>

describe('files.sent: a strict signed read', () => {
  it('the fixture parses unchanged', () => {
    const r = parseFrame(q)
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(JSON.stringify(r.frame))).toEqual(q)
  })
  it('every filter is required and no other key is taken (no defaults inside a signed frame)', () => {
    for (const k of Object.keys(filters)) {
      const { [k]: _gone, ...rest } = filters
      expect(parseFrame({ ...q, filters: rest }).ok, k).toBe(false)
    }
    expect(parseFrame({ ...q, filters: { ...filters, extra: 1 } }).ok).toBe(false)
  })
  it(`a page is 1-${FILES_SENT_PAGE_MAX} files; a name filter is at most ${FILES_SENT_NAME_MAX} characters`, () => {
    expect(parseFrame({ ...q, limit: 0 }).ok).toBe(false)
    expect(parseFrame({ ...q, limit: FILES_SENT_PAGE_MAX + 1 }).ok).toBe(false)
    expect(parseFrame({ ...q, filters: { ...filters, name: 'x'.repeat(FILES_SENT_NAME_MAX + 1) } }).ok).toBe(false)
    expect(parseFrame({ ...q, filters: { ...filters, name: 'x'.repeat(FILES_SENT_NAME_MAX) } }).ok).toBe(true)
  })
  it('the type is one of the chips', () => {
    for (const type of ['all', 'pages', 'docs', 'audio', 'images'])
      expect(parseFrame({ ...q, filters: { ...filters, type } }).ok, type).toBe(true)
    expect(parseFrame({ ...q, filters: { ...filters, type: 'video' } }).ok).toBe(false)
  })
})

describe('files.sent_list', () => {
  it('the fixture parses', () => {
    expect(parseFrame(fixtures['files.sent_list']).ok).toBe(true)
  })
  it(`carries at most ${FILES_SENT_PAGE_MAX} files`, () => {
    const l = fixtures['files.sent_list'] as { files: unknown[] }
    const one = l.files[0]
    expect(parseFrame({ ...l, files: Array(FILES_SENT_PAGE_MAX + 1).fill(one) }).ok).toBe(false)
  })
})

describe('sentFileType: the chip a file is under', () => {
  const f = (kind: string, mime: string, name: string) => sentFileType({ kind, mime, name })
  it('pages: HTML by kind, MIME type or name', () => {
    expect(f('html', 'text/html', 'report.html')).toBe('pages')
    expect(f('file', 'application/octet-stream', 'report.htm')).toBe('pages')
  })
  it('docs: Markdown, PDF and plain text, by MIME type or name', () => {
    expect(f('file', 'text/markdown', 'notes')).toBe('docs')
    expect(f('file', 'application/octet-stream', 'notes.MD')).toBe('docs')
    expect(f('file', 'application/pdf', 'a.pdf')).toBe('docs')
    expect(f('file', 'text/plain; charset=utf-8', 'a.txt')).toBe('docs')
  })
  it('audio and images', () => {
    expect(f('audio', 'audio/mpeg', 'a.mp3')).toBe('audio')
    expect(f('file', 'audio/ogg', 'a.ogg')).toBe('audio')
    expect(f('image', 'image/png', 'a.png')).toBe('images')
  })
  it('anything else is under All only', () => {
    expect(f('file', 'application/zip', 'a.zip')).toBeNull()
    expect(f('video', 'video/mp4', 'a.mp4')).toBeNull()
  })
})
