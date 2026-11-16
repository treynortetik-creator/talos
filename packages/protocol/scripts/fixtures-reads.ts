// The signed reads' fixtures (read aloud, the folder picker, the Files pane, the bug reporter's Mac context): one part of
// gen-fixtures.ts, kept apart so that file stays under the size budget. The helpers are gen-fixtures.ts's own, passed in.
type Frame = Record<string, unknown>
export type FixtureHelpers = {
  env: (type: string, n: number) => Frame
  ulid: (n: number) => string
  msgId: (n: number) => string
  mdId: (n: number) => string
  owner: Frame
  SHA: string
}

export function readFixtures({ env, ulid, msgId, mdId, owner, SHA }: FixtureHelpers): {
  unsigned: Record<string, Frame>
  signed: Record<string, Frame>
} {
  const unsigned: Record<string, Frame> = {}
  const signed: Record<string, Frame> = {}
  signed['speak.request'] = {
    ...env('speak.request', 132),
    request_id: ulid(133),
    message_id: msgId(2),
    thread_id: 'general',
    fresh: true,
    ...owner,
  }
  unsigned['speak.result'] = {
    ...env('speak.result', 134),
    request_id: ulid(133),
    state: 'ready',
    media: {
      media_id: mdId(135),
      kind: 'audio',
      role: 'voice_reply',
      mime: 'audio/mp4',
      name: 'read-aloud.m4a',
      size: 48213,
      sha256: SHA,
    },
    chars: 66,
    total_chars: 66,
    truncated: false,
  }

  signed['fs.list'] = {
    ...env('fs.list', 136),
    request_id: ulid(137),
    path: '/Users/alex/Projects',
    hidden: false,
    ...owner,
  }
  unsigned['fs.listing'] = {
    ...env('fs.listing', 138),
    request_id: ulid(137),
    home: '/Users/alex',
    agent_dir: '/Users/alex/talos-agent',
    path: '/Users/alex/Projects',
    parent: '/Users/alex',
    entries: [{ name: 'alpha' }, { name: 'beta' }],
    more: 0,
  }
  signed['files.list'] = {
    ...env('files.list', 150),
    request_id: ulid(151),
    thread_id: 'general',
    path: 'docs',
    ...owner,
  }
  unsigned['files.listing'] = {
    ...env('files.listing', 152),
    request_id: ulid(151),
    thread_id: 'general',
    root: '/Users/alex/talos-agent',
    path: 'docs',
    entries: [
      { name: 'drafts', kind: 'dir' },
      { name: 'plan.md', kind: 'file', size: 120 },
    ],
    more: 0,
  }
  signed['files.read'] = {
    ...env('files.read', 153),
    request_id: ulid(154),
    thread_id: 'general',
    path: 'docs/plan.md',
    offset: 0,
    ...owner,
  }
  unsigned['files.file'] = {
    ...env('files.file', 155),
    request_id: ulid(154),
    thread_id: 'general',
    path: 'docs/plan.md',
    kind: 'text',
    size: 15,
    mtime: '2026-11-10T09:00:00.000Z',
    text: '# Plan\n\n1. Files\n',
    offset: 0,
    next_offset: null,
    truncated: false,
  }

  signed['bug.context'] = {
    ...env('bug.context', 140),
    request_id: ulid(141),
    lines: 200,
    ...owner,
  }
  unsigned['bug.context_result'] = {
    ...env('bug.context_result', 142),
    request_id: ulid(141),
    bridge_version: '0.4.2',
    claude_code: '2.1.312',
    recent_errors: ['web: TypeError: x is not a function'],
    logs: '2026-11-10T04:00:00.000Z info     bridge up',
  }

  // the thread's AGENTS.md in its settings: a read, a save against the sha the editor loaded, the file as the Mac has it
  signed['agents_md.read'] = {
    ...env('agents_md.read', 160),
    request_id: ulid(161),
    thread_id: 'general',
    ...owner,
  }
  signed['agents_md.write'] = {
    ...env('agents_md.write', 162),
    request_id: ulid(163),
    thread_id: 'general',
    text: '# Trip\n\nKeep the packing list in packing.md.\n',
    base_sha: 'a'.repeat(64),
    ...owner,
  }
  unsigned['agents_md.file'] = {
    ...env('agents_md.file', 164),
    request_id: ulid(163),
    thread_id: 'general',
    exists: true,
    sha: 'b'.repeat(64),
    text: '# Trip\n\nKeep the packing list in packing.md.\n',
    saved: true,
  }
  // an upload into a thread's folder: the file went up the media path, then the Mac is asked to put it in a folder
  signed['files.put'] = {
    ...env('files.put', 165),
    request_id: ulid(166),
    thread_id: 'general',
    dir: 'docs',
    name: 'plan.md',
    media: {
      media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T4AB',
      name: 'plan.md',
      mime: 'text/markdown',
      size: 7,
      sha256: 'c'.repeat(64),
      kind: 'file',
      role: 'attachment',
    },
    ...owner,
  }
  unsigned['files.put_result'] = {
    ...env('files.put_result', 167),
    request_id: ulid(166),
    thread_id: 'general',
    dir: 'docs',
    name: 'plan (2).md',
    size: 7,
  }
  // the Files sheet: the files sent in Talos, newest first; a name filter holding % and _ is matched as text
  signed['files.sent'] = {
    ...env('files.sent', 168),
    request_id: ulid(169),
    filters: { type: 'docs', name: '50%_plan', thread_ids: [], from: 'any', after: null, before: null },
    cursor: null,
    limit: 50,
    ...owner,
  }
  // Settings -> Memory folders: the agent folder's own folders by name, and the owner's pick
  signed['memory.folders'] = { ...env('memory.folders', 230), request_id: ulid(231), ...owner }
  signed['memory.roots_set'] = { ...env('memory.roots_set', 232), request_id: ulid(233), names: ['notes'], ...owner }
  unsigned['memory.folders_result'] = {
    ...env('memory.folders_result', 234),
    request_id: ulid(233),
    folders: [
      { name: 'journal', notes: 1 },
      { name: 'notes', notes: 2 },
    ],
    chosen: ['notes'],
    enabled: true,
    saved: true,
  }
  // Memory -> Graph: notes as indexes, links as pairs of them
  signed['memory.graph'] = { ...env('memory.graph', 240), request_id: ulid(241), ...owner }
  unsigned['memory.graph_result'] = {
    ...env('memory.graph_result', 242),
    request_id: ulid(241),
    roots: [{ id: 'notes', label: 'Notes' }],
    nodes: [
      { r: 0, p: 'alpha.md', t: 'Alpha' },
      { r: 0, p: 'beta.md', t: 'Beta' },
    ],
    edges: [[0, 1]],
    total_nodes: 2,
    truncated: false,
  }
  unsigned['files.sent_list'] = {
    ...env('files.sent_list', 170),
    request_id: ulid(169),
    files: [
      {
        message_id: msgId(2),
        thread_id: 'general',
        author: 'agent',
        created_at: '2026-01-01T00:00:00.000Z',
        index: 0,
        file: {
          media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T4AC',
          kind: 'file',
          role: 'attachment',
          mime: 'text/markdown',
          name: '50%_plan.md',
          size: 7,
          sha256: SHA,
        },
        removed: false,
      },
    ],
    next_cursor: null,
    days: 90,
  }
  return { unsigned, signed }
}
