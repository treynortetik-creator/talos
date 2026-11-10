// The folder picker's wire shape (src/folders.ts, `fs.list` and `fs.listing` in frames.ts) and its Mac-shell messages
// (`pick_folder`, `folder_picked` in native.ts).
import { describe, expect, it } from 'vitest'
import {
  FOLDER_LIST_MAX,
  FOLDER_RECENT_MAX,
  FOLDER_WORDING,
  FOLDERS_FEATURE,
  frameSchemas,
  OWNER_FRAME_TYPES,
  parentPath,
  tildePath,
  V2_READ_OWNER_FRAME_TYPES,
  V2_READ_RESPONSE_FOR,
} from '../src/index.ts'
import { NATIVE_TO_WEB, NativeToWeb, WEB_TO_NATIVE, WebToNative } from '../src/native.ts'

const env = { v: 1, id: '01HZZZZZZZZZZZZZZZZZZZZZZZ', ts: '2026-11-08T10:00:00.000Z' }
const req = '01HZZZZZZZZZZZZZZZZZZZZZZA'
const owner = { device_id: 'd_aaaaaaaaaaaaaaaaaaaa', osig: 'A'.repeat(86) }

describe('fs.list and fs.listing', () => {
  it('fs.list is a signed owner read answered by fs.listing', () => {
    expect(FOLDERS_FEATURE).toBe('folders/1')
    expect(V2_READ_OWNER_FRAME_TYPES).toContain('fs.list')
    expect(OWNER_FRAME_TYPES).toContain('fs.list')
    expect(V2_READ_RESPONSE_FOR['fs.list']).toBe('fs.listing')
  })

  it('takes a path or null, and a hidden flag; nothing else; the signature is required', () => {
    const s = frameSchemas['fs.list']
    const ok = { ...env, type: 'fs.list', request_id: req, path: '/Users/alex/Projects', hidden: false, ...owner }
    expect(s.safeParse(ok).success).toBe(true)
    expect(s.safeParse({ ...ok, path: null }).success).toBe(true)
    expect(s.safeParse({ ...ok, extra: 1 }).success).toBe(false)
    expect(s.safeParse({ ...ok, hidden: 'yes' }).success).toBe(false)
    expect(s.safeParse({ ...ok, path: 'x'.repeat(600) }).success).toBe(false)
    const { osig: _o, ...unsigned } = ok
    expect(s.safeParse(unsigned).success).toBe(false)
  })

  it('an answer carries names only: an entry with any other field is refused, and the list is capped', () => {
    const s = frameSchemas['fs.listing']
    const ok = {
      ...env,
      type: 'fs.listing',
      request_id: req,
      home: '/Users/alex',
      path: '/Users/alex',
      parent: null,
      entries: [{ name: 'Projects' }],
      more: 0,
    }
    expect(s.safeParse(ok).success).toBe(true)
    expect(s.safeParse({ ...ok, agent_dir: '/Users/alex/agent' }).success).toBe(true)
    expect(s.safeParse({ ...ok, entries: [{ name: 'Projects', size: 4 }] }).success).toBe(false)
    expect(s.safeParse({ ...ok, entries: [{ name: '' }] }).success).toBe(false)
    expect(
      s.safeParse({ ...ok, entries: Array.from({ length: FOLDER_LIST_MAX + 1 }, (_, i) => ({ name: `d${i}` })) })
        .success,
    ).toBe(false)
  })
})

describe('words for paths', () => {
  it('tildePath shows a path under home as ~/…, and leaves others whole', () => {
    expect(tildePath('/Users/alex', '/Users/alex')).toBe('~')
    expect(tildePath('/Users/alex/Projects/alpha', '/Users/alex')).toBe('~/Projects/alpha')
    expect(tildePath('/Users/alex/Projects', '/Users/alex/')).toBe('~/Projects')
    expect(tildePath('/srv/alexa/Projects', '/srv/alex')).toBe('/srv/alexa/Projects')
    expect(tildePath('/tmp/x', '/Users/alex')).toBe('/tmp/x')
  })
  it('parentPath goes up one level and stops at the root', () => {
    expect(parentPath('/Users/alex/Projects')).toBe('/Users/alex')
    expect(parentPath('/Users')).toBe('/')
    expect(parentPath('/')).toBeNull()
  })
  it('the recent list is five long', () => {
    expect(FOLDER_RECENT_MAX).toBe(5)
  })
})

describe('Mac shell: pick_folder and folder_picked', () => {
  const ask = { type: 'pick_folder', req: 'r12' }
  it('web -> native: a request id and nothing else', () => {
    expect(WEB_TO_NATIVE.pick_folder).toBeDefined()
    expect(WebToNative.safeParse(ask).success).toBe(true)
    expect(WebToNative.safeParse({ ...ask, start: '/Users/alex' }).success).toBe(true)
    expect(WebToNative.safeParse({ ...ask, start: 'relative' }).success).toBe(false)
    expect(WebToNative.safeParse({ ...ask, extra: 1 }).success).toBe(false)
    expect(WebToNative.safeParse({ type: 'pick_folder' }).success).toBe(false)
  })
  it('native -> web: the chosen absolute path, or null when the owner cancelled', () => {
    expect(NATIVE_TO_WEB.folder_picked).toBeDefined()
    expect(NativeToWeb.safeParse({ type: 'folder_picked', req: 'r12', path: '/Users/alex/Projects' }).success).toBe(
      true,
    )
    expect(NativeToWeb.safeParse({ type: 'folder_picked', req: 'r12', path: null }).success).toBe(true)
    expect(NativeToWeb.safeParse({ type: 'folder_picked', req: 'r12', path: 'Projects' }).success).toBe(false)
    expect(NativeToWeb.safeParse({ type: 'folder_picked', req: 'r12', path: '/a\u0000b' }).success).toBe(false)
    expect(NativeToWeb.safeParse({ type: 'folder_picked', req: 'r12' }).success).toBe(false)
    expect(NativeToWeb.safeParse({ type: 'folder_picked', req: 'r12', path: null, extra: 1 }).success).toBe(false)
  })
  it('native -> web: a "why" says it was not the owner cancelling (not now, or a name that cannot be used)', () => {
    for (const why of ['not_now', 'bad_name'])
      expect(NativeToWeb.safeParse({ type: 'folder_picked', req: 'r12', path: null, why }).success, why).toBe(true)
    expect(NativeToWeb.safeParse({ type: 'folder_picked', req: 'r12', path: null, why: 'because' }).success).toBe(false)
  })
  it('the refusal words are plain and the slow and no-access ones are not the refusal', () => {
    expect(FOLDER_WORDING.noAccess).toMatch(/macOS hasn't given Talos access to this folder/)
    expect(FOLDER_WORDING.slow).toMatch(/slow to open/)
  })
})
