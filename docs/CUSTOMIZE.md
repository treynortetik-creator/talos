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
- The one table: `CARD_KIND_TABLE` in `packages/protocol/src/models.ts`. A kind is one entry with every fact the rules
  need: who mints it (`'agent'` or `'bridge'`), its label and glyph, its icon key, whether the body is editable, whether it
  may have no destination, whether a notification may approve it, whether trust mode still needs the passkey, and whether
  the bridge handles the decision itself. Leave a field out and `pnpm typecheck` fails. `AGENT_CARD_KINDS`,
  `BRIDGE_ONLY_CARD_KINDS`, the `Card.kind` enum, the agent tool's schema (`apps/bridge/src/tools/card.ts`),
  `isBodyEditable`, `validateCard`, `riskForTrust`, `NATIVE_APPROVABLE_KINDS` and the ledger's handled set all read it.
- Rendering: `KIND_LABEL` (`apps/web/src/features/cards/logic.ts`) and `KIND_ICON` (`CardView.tsx`) are read from the table.
  A new icon key needs a drawing in `ICON_BY_KEY` in `CardView.tsx`, or `pnpm typecheck` fails (`pnpm build` does not check this).
  `DONE_VERB` and `FAIL_VERB` in `logic.ts` are the wording for a finished or failed card; add the kind to them too.
- Destination, risk and notification approval are table fields (`destinationOptional`, `highRiskUnderTrust`,
  `nativeApprovable`). `validateCard` (`packages/protocol/src/card-edits.ts`) refuses a card with no destination unless the
  kind is optional. A new kind that moves money must set `highRiskUnderTrust` or it loses its passkey step in trust mode.
  `permission/ask-rules.ts` is about which tool calls reach the phone, not card risk.
- Tests that pin the kinds on purpose and must be updated with the change: `packages/protocol/test/card-kinds-pinned.test.ts`,
  `apps/web/test/cards/kind-labels-pinned.test.ts`, `apps/web/test/cards/kind-table.test.ts`, `packages/protocol/test/card-kind-table.test.ts` and the "agent card kinds" case
  in `packages/protocol/test/cc-permission.test.ts`.
- Rollout: update the relay and the app before the agent uses a new kind. An old relay refuses the card (the agent is told to update it), and an
  app from before the "needs an update" note drops it with no error, so the owner never sees it.

## An agent tool

One table, `TOOL_RECORDS` in `apps/bridge/src/tools/table.ts`, holds one record per tool. Everything else follows it.

- The record (`ToolRecord`, `apps/bridge/src/tools/define.ts`) holds the tool whole: `name`, `description`, `inputSchema` and
  `handler` (what the MCP server lists and runs), `instructions` (the words the agent is told about it, or `null`), `told`
  (which sessions are told them: `main`, `worker`, or neither for `null`), and its membership: `group` (`core` is the 12 tools of spec 4.4 and
  is pinned at 12 by `apps/bridge/test/agent-tool-lists.test.ts`, so a new tool takes another group), `headless` (scheduled `claude -p`
  jobs get it; leave it false unless it is safe unattended), `worker` (a thread's own session gets it) and `locked` (a worker
  may only use it on its own thread). A record missing any field fails typecheck.
- A tool that posts into a thread (`thread: 'post'`) must be `locked: true` when workers get it. The type refuses anything
  else. `thread: 'read'` skips the lock, so only the tools in `READ_THREAD_TOOLS` (today `read_thread`) may carry it: the bridge
  refuses to start on any other (`tableProblems`) and a test fails. `apps/bridge/test/agent-tool-table.test.ts` also checks the
  record against the tool's schema.
- To add a tool: write its record in a file in `apps/bridge/src/tools` and add it to the array in `table.ts`. That is the whole
  change: it is listed, run, given to headless jobs and workers by its flags, and its words reach the agent (after the text that
  `apps/bridge/src/instructions.ts` places by name) with no edit to any other file. A duplicate name, or words told to a session
  that has none, is reported by name when the bridge starts (`server.ts` calls `toolTableProblems` right after the logger
  exists, writes the message to `bridge.log` and stderr, and exits 1).
- Derived from the records, so not edited by hand: `BRIDGE_TOOLS`, `SCHEDULE_BRIDGE_TOOLS`, `CONFIG_BRIDGE_TOOLS`,
  `ATTACHMENT_BRIDGE_TOOLS`, `MOD_BRIDGE_TOOLS`, `APP_BRIDGE_TOOLS`, `HEADLESS_BRIDGE_TOOLS`, `WORKER_BRIDGE_TOOLS` and
  `WORKER_THREAD_LOCKED_TOOLS` (all in `table.ts`); the bridge's `TOOLS`, `ALL_TOOLS` and `WORKER_TOOLS`; and the list used with
  `TALOS_APP_SCHEDULER=off` (every group but `schedule`; a new group that needs the scheduler goes in `NEEDS_SCHEDULER`
  in `tools/index.ts`). A new group goes in `AGENT_TOOL_GROUPS` (`define.ts`) and the main session lists it by itself; only `apps` and
  `worker` are kept out (`NOT_MAIN`).
- What the agent is told: the words of the tools that `instructions.ts` names (`toolInstructions('<name>')`, read from the record)
  sit where that file puts them, among the words that belong to no tool. A tool it does not name is told after them, in table order.
  `apps/bridge/test/tool-lists.test.ts` and its fixtures, and `apps/bridge/test/tool-table-snapshot.test.ts` with the fixture
  captured before the table moved (`golden/tool-table-before.json`), pin the exact text, so a changed word fails there.
- Counts still edited by hand: `apps/bridge/test/schedules/tools.test.ts` adds up the lists of five named groups and
  compares the sum with what the main session lists, so a tool in a new group fails it until that group is added to the sum.
  `apps/bridge/test/tools.test.ts` holds no count of tools. The testkit's bridge contract names the 12 spec tools itself
  (`packages/testkit/src/contract/spec-tools.ts`).

- The Talos mod loads only when Claude Code starts with `--plugin-dir <repo>/plugins/talos-app-mod`; `./install.sh` writes that into `<agent folder>/start-talos.sh` (no managed marketplace).
