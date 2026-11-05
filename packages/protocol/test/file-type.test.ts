import { describe, expect, it } from 'vitest'
import { FORM_SENDABLE_TYPES, fileTypeAllowed, storedMime, textTypeOfFile } from '../src/index.ts'

describe('file types for uploads', () => {
  it('names the text type from the browser type or, when it is empty, the file name', () => {
    expect(textTypeOfFile('a.txt', 'text/plain; charset=utf-8')).toBe('text/plain')
    expect(textTypeOfFile('A.VTT', '')).toBe('text/vtt')
    expect(textTypeOfFile('a.srt', 'application/octet-stream')).toBe('application/x-subrip')
    expect(textTypeOfFile('a.md', '')).toBe('text/markdown')
  })
  it('names nothing for files that are not plain text, even when the name says so', () => {
    expect(textTypeOfFile('a.pdf', 'application/pdf')).toBeNull()
    expect(textTypeOfFile('a.txt', 'image/png')).toBeNull()
    expect(textTypeOfFile('a.bin', '')).toBeNull()
  })
  it('the allowlist has the media and text types and not HTML, SVG or scripts', () => {
    for (const t of ['text/plain', 'text/vtt', 'application/pdf', 'image/png', 'audio/webm', 'video/mp4'])
      expect(fileTypeAllowed(t), t).toBe(true)
    for (const t of [
      'text/html',
      'image/svg+xml',
      'text/xml',
      'application/xml',
      'application/x-sh',
      'text/javascript',
      '',
    ])
      expect(fileTypeAllowed(t), t).toBe(false)
  })
  it('keeps a declared text type only over text bytes', () => {
    expect(storedMime('text/vtt', 'text/plain')).toBe('text/vtt')
    expect(storedMime('text/vtt', 'text/html')).toBe('text/html')
    expect(storedMime('text/plain', 'application/octet-stream')).toBe('application/octet-stream')
    expect(storedMime(null, 'text/plain')).toBe('text/plain')
  })
  it('form-sendable types match what the relay refuses', () => {
    expect(FORM_SENDABLE_TYPES.test('text/plain;charset=UTF-8')).toBe(true)
    expect(FORM_SENDABLE_TYPES.test('application/octet-stream')).toBe(false)
  })
})
