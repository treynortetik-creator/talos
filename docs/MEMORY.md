# Memory (Nyx)

Nyx is the memory service. In the app it is the Nyx screen (`/memory`): you type the https address of your Nyx, press
Connect, and Nyx's own sign-in opens in a new tab; after that the screen shows "Connected to <host>" and an Open Nyx link.
Talos keeps only the address (`memory.nyx_url`, an owner setting the agent cannot change) and holds no Nyx credentials.
"Connected" means the address is saved: Talos cannot see whether you are signed in at Nyx. Viewing your notes (the page tree
and the 3D graph) happens in Nyx, not in Talos: the app no longer has a notes browser of its own.

The rest of this page is the Mac's side: the notes folders it shares, which the agent's notes lookup and its "Notes that may
matter" pointers read. Off until you set it up at the Mac.

## Turn it on

```
talos-app memory init [--agent-dir <dir>]   # pick folders (y/N each), then subfolders to exclude; writes memory.json
talos-app memory set-root <name> <path>     # share one folder: creates memory.json with only it, or adds/updates that root
talos-app memory show                       # what is shared: notes per folder, the first 20 paths, hidden folders
talos-app memory on | off                   # both switches at once
talos-app memory reindex                    # rebuild the search index
```

The sharing is on only when `memory.json` has `enabled: true` AND the app switch (`config.memory_browser`) is on. The
phone can only turn it off; turning it on is done at the Mac (`memory on`). `memory.json` lives in `$TALOS_APP_HOME`
(0600) and the search index in `memory-index.sqlite` beside it. Nothing is ever written under the agent folder.

```json
{
  "version": 1,
  "enabled": true,
  "agent_dir": "/abs/path/to/agent",
  "roots": [
    { "id": "notes", "label": "Notes", "path": "notes", "include": ["**/*.md", "**/*.txt"], "exclude": ["drafts/**"] }
  ],
  "max_file_kb": 512
}
```

`agent_dir` may not be `/`, your home folder or the Talos app folder. Each root's real path must stay inside it.

## What is never shown

Config cannot override this. Every path segment, case-insensitive: dotfiles and dot-folders, `node_modules`,
`__pycache__`, `venv`, `*.pem`, `*.key`, `*.p12`, `*.keychain*`, `id_rsa*`, `id_ed25519*`, `*.kdbx`, `*.env`,
`credentials*`, `*.sqlite*`, `*.db`, `.mcp.json`, `settings*.json`, files over 5 MB, binary files, and any folder that
contains a `.talos-private` file (with everything under it). Symlinks show only if their real path stays inside the root.
A file is judged on what is actually opened, not the name asked for: it is opened without following a final symlink, must
be a regular file with one name (hard-linked notes are hidden), under the size cap, and its real path must still be the same
file inside the root. The deny, include and exclude rules run on both the requested path and the real path, folded for the
Mac's case- and Unicode-insensitive file system. A `.talos-private` anywhere from `agent_dir` down hides what is below it.
`max_file_kb` caps how much of a note is read, and a note that is not valid UTF-8 is treated as not text.
Anything out of scope answers `memory_not_found`, so hidden notes cannot be told from missing ones. Links to hidden notes
resolve to nothing, the same as a missing note.

## How it works

- The Mac still answers signed reads on their own queue (the app does not send them now): `memory.tree`, `memory.read`, `memory.search` (60/min per socket).
- Listings page by size (`next_cursor`); a note comes in chunks of whole characters (`next_offset`); links ride on the first
  chunk. Every frame stays under the relay's cap with room to spare.
- Fresh: a scan at start, `fs.watch` (2 s debounce), a 5-minute poll, and a rebuild when `memory.json` changes. Every read
  and every page checks the rules again at that moment.
- A compromised relay would see the notes you open, in transit, just as it sees chat. The relay never stores memory frames.
