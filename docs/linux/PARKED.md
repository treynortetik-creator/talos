# Linux supervisor: PARKED

Parked 2026-11-18 15:08 by the owner: the Linux build (and Windows) is paused; the focus is the Mac build.
The Linux CI parts keep running. This file says where the Linux supervisor stands and how to pick it up again.

## What it is

The TypeScript supervisor in `apps/bridge/src/supervisor/` (the Mac uses the Swift one in `apps/desktop/Sources/TalosSupervisor`).
It runs Main in a tmux pane (`tmux-host.ts`), adopts a running Main on restart (`main.ts` `attach()`), answers the first-start
prompts it may, runs dedicated thread sessions (`workers.ts`, `workers-file.ts`, `wake-reader.ts`), and writes the status the
tray reads. Tests: `apps/bridge/test/supervisor/*.test.ts` (fake host and clock, real process groups).

## State at park

- On main and green on Linux: lifecycle (`main.test.ts`, its dash-fork flake fixed in 93a43521), first start, usage-limit
  screen, restart on request, own-folder sub-threads.
- Hostile-nightly harness fixes (e61c5d45) and the relay/bridge fixes of 11-17/18 are shared code, not parked.

## Open bugs and unfinished work (none started unless said)

1. **False green on adopt** (found in a WSL run, 2026-11-18). After a supervisor restart while Main sits at Claude's sign-in screen,
   `attach()` sets `phase = 'running'` before the screen is read (`main.ts` ~276), so the tray shows green, then `main=signin`
   a tick later. Fix idea: adopt into `starting` and let `superviseLive` classify the screen (ready → running, sign-in → signin);
   test: adopt a pane at the sign-in screen. Tier 2 + an Opus look. Never press Enter at a sign-in screen.
2. **BSUP-6** (outside review 11-16): `workers.ts` ~510 should persist the pane's live session id before a park.
3. **BSUP-5** writer half (shared): Restart/Fresh/Park controls can be overwritten by a message wake; the fix puts controls in a
   second file read first. The reader is the Mac's Swift `WorkerWakes.swift` and the Linux `wake-reader.ts`: the Linux reader
   half is parked.
4. **Status truth (Linux twin of the Mac's needs_you/stopped_why work)**: plan sent 2026-11-13, never given a go. Gaps:
   needsYou/dialogSince in memory only, stop reasons never written as stopped_why, last_turn_at set at the turn's start, no
   main-restart-check.json, the usage-limit screen read as unknown_selection.
5. **Linux CI lane gating**: add the Linux-only fence/hook test files to `job_linux`, then make `report-ci/linux` gating after
   10 green pushes. Not started.
6. **Hook stack Fable R1 items** (R1-1 python path, R1-2 sealed kit anchor = the approved sealed-kit plan, R1-3 settings
   deny grammar, R1-4 odd-path folders, R1-5 real-Claude run, R1-6 TS/Swift table differences): open.
7. `tmux-host.test.ts:680` load flake (assigned 2026-11-17 to the WSL test machine's session).

## How to resume

1. Start from main, with the toolchain the repo pins (Node, bun, pnpm).
2. Run `cd apps/bridge && bun scripts/test-parallel.ts --jobs 2 test/supervisor` in the clean env to see where it stands.
3. Take the list above in order 1 → 7, each with tests red first; the lead decides the order and the review tier.
4. Get a real WSL run (Ubuntu, dash `/bin/sh`) before calling a supervisor change done.
