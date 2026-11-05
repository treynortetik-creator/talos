# Customizing Talos

Where to change a theme token, a setting, a card kind and an agent tool. Paths are from the repo root. The files in
[`protected-paths.txt`](protected-paths.txt) hold signing, enrollment, device keys, the approval and card ledger paths and
the wrapper for untrusted content; `docs/SECURITY.md` explains why. "Protected" means change only with an owner's review.
Nothing enforces the list yet, so it is on you to check it. The file is one path per line with no comment syntax, so one
exception lives here: `apps/bridge/src/handshake.ts` is listed, but adding a feature flag to its `bridgeFeatures()` list is
an ordinary edit. Anything else in that file needs the owner. Start with [`AGENTS.md`](../AGENTS.md) for the rules every change follows.

## A theme token (colour, font, radius, spacing)

- Edit `apps/web/src/theme/tokens.css`. Components use `var(--...)` only.
- Colours have three blocks: `:root[data-brand="talos"][data-theme="light"]`, the `prefers-color-scheme: dark` block, and
  `[data-theme="dark"]`. Change a colour in the dark pair together, and check both themes at phone width.
- tokens.css is not the only place that holds the brand colour. The brand black `#141110` is also in `apps/web/index.html`
  (the `theme-color` meta tag), in the fallback in `apps/web/src/lib/theme.ts` (`applyTheme`), and in
  `apps/mobile/capacitor.config.ts` (`backgroundColor`), `apps/web/public/manifest.webmanifest`, `apps/mobile/www/offline.html`
  and `apps/web/src/ui/threadIcons.ts`; `apps/mobile/test/package-e.test.ts` pins it too. `apps/web/test/tokens.test.ts` locks the four brand primitives, so
  a palette change fails it until you update the test on purpose.
- A new brand is a new `[data-brand="..."]` block plus its own assets folder (the header comment of `tokens.css` says so),
  chosen at build time with `VITE_BRAND`. Do the three places above for it too.
- Theme and text-size choice (light, dark, system) live in `apps/web/src/lib/theme.ts`; the picker is in
  `apps/web/src/features/settings/sections.tsx`.
- The stock theme (talos, paper, hearth) is the `theme` setting in the owner's config, so every device follows it. The picker
  is `ThemePicker.tsx`, the sync is `ThemeSync.tsx`, and the stock files are `packages/protocol/themes`. Owner bubbles, the
  phone top band and the frieze warning read the `--figure-*` tokens (text, surfaces, line, status colours, focus ring, wave)
  and `--frieze-warn`, which every stock theme sets. `?theme=default`, or "Reset theme" on the sign-in screen, always gets back to talos.
  The agent can propose a whole custom theme (skill `talos-theme`): `config_propose` path `theme`, checked by the same
  `validateTheme`, shown on a preview card (`ThemePreview.tsx`), written to `theme` only when the owner taps Apply.
  `talos-app theme reset` on the Mac removes it. `theme.json` in the agent folder is only a draft.

## A setting

- The shape of the owner's settings file: `AgentConfig` in `packages/protocol/src/config.ts`. Add the field there first, with a
  default, so old files still parse.
- The one table: `SETTINGS_TABLE` in `packages/protocol/src/settings-table.ts`. Each setting has a row with who may change it
  (`phone`: `'leaf'`, `'section'` or `false`; `agent`: true or false; both false means the Mac only), whether a phone change
  needs step-up (`stepup`: `'config:session'` or `'config:work'`), and its `default`. A setting added to `AgentConfig` with no
  row fails `pnpm typecheck`.
- The lists follow the table and are not edited: `CONFIG_PATCH_ALLOWLIST` and `CONFIG_SESSION_STEPUP_FIELDS` in `frames.ts`,
  `AGENT_CONFIG_ALLOWLIST` and `AGENT_CONFIG_REFUSED` in `config-propose.ts`, the walk in `checkConfigPatch`
  (`patches.ts`), and the "phone may only turn it off" rule in `apps/bridge/src/config-file.ts`. The bridge refuses any field
  in a `config.patch` that has no phone row.
- Rules the table enforces, so a row never says something the lists ignore (types where they can, `settingsTableProblems`
  and `packages/protocol/test/settings-table.test.ts` for the rest):
  - One row per setting: a row for a setting that is not in `AgentConfig` fails `pnpm typecheck`, as does a missing one.
  - If any row of a section is `phone: 'section'`, every row of that section must be. The whole section is open to the
    phone, so a `phone: false` or `'leaf'` row beside it would not lock anything.
  - `stepup: 'config:session'` and `phoneOffOnly` go on top-level rows only; `stepup: 'config:work'` goes on dotted
    `section.child` rows with `phone: 'leaf'` only. Anywhere else they are never read, and the phone path stays open.
  - To lock one setting in a section the phone has open as a whole, first give every row of that section `'leaf'`, then set
    `phone: false` on the one.
- Phone: `'leaf'` opens that one setting; `'section'` opens the whole top-level section it sits in (`agent`, `owner`,
  `notifications`, `voice_notes`), whatever key a patch names inside it. Set `phoneOffOnly` for a setting the phone may only
  turn off. Changing who may change a setting changes behavior, so update
  `packages/protocol/test/settings-access-pinned.test.ts` and `apps/bridge/test/config-access-pinned.test.ts` on purpose.
- Agent: `agent: true` lets the agent propose it with `config_propose` and a card. It also needs a value rule and a label in
  `config-propose.ts` (`AGENT_CONFIG_VALUE`, `AGENT_CONFIG_LABEL`) and a reader in `CONFIG_READER` (what `readConfigPath` uses); all three are
  records keyed by the agent rows, so `pnpm typecheck` fails until you add them. Keep `refusedByName` on a setting the agent should be told is the owner's to change.
- A rename in Settings (agent name, owner name, timezone, quiet hours) reaches the agent at its next session start: the kit's session-start hook reads `config.json` and prints an identity block, so `CLAUDE.md` is not rewritten.
- `trust_mode` stays Mac only (`talos-app trust on|off`).
- The screen: `apps/web/src/features/settings/SettingsScreen.tsx` and `sections.tsx`. The voice picker is in
  `apps/web/src/features/voice/index.tsx`.
- Bridge side: `apps/bridge/src/config-file.ts` reads and writes the file. Before each write it saves the file as it was to
  `$TALOS_APP_HOME/config-history/` (0600 files, 0700 folder) and keeps the newest 20 (`config-history.ts`); a failed save is logged and never blocks the write.

## A card kind

- The one table: `CARD_KIND_MINTER` in `packages/protocol/src/models.ts`. Add the kind there, marked `'agent'` (the agent's
  `card` tool may create it) or `'bridge'` (only the live bridge mints it). `AGENT_CARD_KINDS`, `BRIDGE_ONLY_CARD_KINDS`,
  the `Card.kind` enum and the agent tool's schema (`apps/bridge/src/tools/card.ts`) are all derived from it, so there is no
  second list to edit.
- Rendering: `KIND_LABEL` in `apps/web/src/features/cards/logic.ts` and `KIND_ICON` in
  `apps/web/src/features/cards/CardView.tsx` are typed against the table, so `pnpm typecheck` fails until you add the kind to both. `pnpm build` does not check this.
  `DONE_VERB` and `FAIL_VERB` in `logic.ts` are the wording for a finished or failed card; add the kind to them too.
- Destination: `packages/protocol/src/card-edits.ts` (`validateCard`) refuses a card with no destination
  (`destination_required`). Only `decision`, `generic` and `permission` are exempt; a new kind needs a destination.
- Risk: the ledger (`apps/bridge/src/cards-ledger.ts`) stores the card; the agent tool in `apps/bridge/src/tools/card.ts`
  sets its risk through `mintRisk`. In trust mode every kind except `purchase` is minted low risk (`riskForTrust` in
  `packages/protocol/src/config.ts` tests only `'purchase'`). A new kind that moves money therefore loses its passkey step
  unless that function changes. `permission/ask-rules.ts` is about which tool calls reach the phone, not card risk.
- Tests that pin the kinds on purpose and must be updated with the change: `packages/protocol/test/card-kinds-pinned.test.ts`,
  `apps/web/test/cards/kind-labels-pinned.test.ts`, `apps/web/test/cards/kind-table.test.ts` and the "agent card kinds" case
  in `packages/protocol/test/cc-permission.test.ts`.
- Rollout: update the relay and the app before the agent uses a new kind. An old relay refuses the card (the agent is told to update it), and an
  app from before the "needs an update" note drops it with no error, so the owner never sees it.

## An agent tool

One table, `AGENT_TOOLS` in `packages/protocol/src/channel-meta.ts`, has a row per tool. Everything else follows it.

- The row: `group` (`core` is the 12 tools of spec 4.4 and is pinned at 12 by `packages/protocol/test/channel-meta.test.ts`, so
  a new tool takes another group), `headless` (scheduled `claude -p` jobs get it; leave it false unless it is safe
  unattended), `worker` (a thread's own session gets it) and `locked` (a worker may only use it on its own thread). The row holds
  facts only: the web client bundles the table.
- A tool that posts into a thread (`thread: 'post'`) must be `locked: true` when workers get it. The row's type refuses
  anything else. `thread: 'read'` skips the lock, so only the tools in `READ_THREAD_TOOLS` (today `read_thread`) may carry it:
  the type and a test refuse any other. And `apps/bridge/test/agent-tool-table.test.ts` checks the row against the tool's schema.
- The tool itself: one file per group in `apps/bridge/src/tools`. Add the tool to `IMPLEMENTATIONS` in
  `apps/bridge/src/tools/index.ts`. A tool without a row, or a row without a tool, fails typecheck. Only a tool whose
  own `name` does not match its row (a wrong name) gets past the types and fails the bridge's start (not on import):
  `server.ts` checks right after the logger exists, writes the message naming the tool to `bridge.log` and stderr, and
  exits 1. `apps/bridge/test/agent-tool-table.test.ts` checks that too.
- Derived from the table, so not edited by hand: `BRIDGE_TOOLS`, `SCHEDULE_BRIDGE_TOOLS`, `CONFIG_BRIDGE_TOOLS`,
  `ATTACHMENT_BRIDGE_TOOLS`, `MOD_BRIDGE_TOOLS`, `APP_BRIDGE_TOOLS`, `HEADLESS_BRIDGE_TOOLS`, `WORKER_BRIDGE_TOOLS` and
  `WORKER_THREAD_LOCKED_TOOLS`; the bridge's `TOOLS`, `ALL_TOOLS` and `WORKER_TOOLS`; and the list used with
  `TALOS_APP_SCHEDULER=off` (every group but `schedule`; a new group that needs the scheduler goes in `NEEDS_SCHEDULER`
  in `tools/index.ts`). A new group goes in `AGENT_TOOL_GROUPS` and the main session lists it by itself; only `apps` and
  `worker` are kept out (`NOT_MAIN`).
- What the agent is told: each tool has a key in `apps/bridge/src/tools/instructions.ts` (its sentences, or `null`; a tool
  without a key fails typecheck), placed into `INSTRUCTIONS` (and the worker text) in `apps/bridge/src/instructions.ts` with
  `toolInstructions('<name>')`; the words that belong to no tool stay in that file.
  `apps/bridge/test/tool-lists.test.ts` and its fixtures pin the exact text, so a changed word fails there.
- Counts still edited by hand: `apps/bridge/test/schedules/tools.test.ts` adds up the lists of five named groups and
  compares the sum with what the main session lists, so a tool in a new group fails it until that group is added to the sum.
  `apps/bridge/test/tools.test.ts` holds no count of tools. `core` stays pinned at 12 in
  `packages/protocol/test/channel-meta.test.ts`.

- The Talos mod loads only when Claude Code starts with `--plugin-dir <repo>/plugins/talos-app-mod`; `./install.sh` writes that into `<agent folder>/start-talos.sh` (no managed marketplace).
