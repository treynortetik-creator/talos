# Windows: parked

_Parked 2026-11-18 by the owner ("we're burning a lot of resources"). Parked, not abandoned. Written on Titan, the Windows test
PC. **Ran** means it was run on Titan that day; **read** means read from the code._

## Where it stands

- **Builds** (all unsigned, all for the same relay; the relay URL stays out of this repo). The exes are kept on Titan in
  `%USERPROFILE%\Talos\beta<n>`:

  | Build | Commit     | SHA-256 of the exe                                                 | Notes                                                                     |
  | ----- | ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
  | beta2 | `9cc62a23` | `6949420fa4072da2575968a4c4a8b3134a71f0b832c57f68683a252d63d3e04c` | before the sign-in log fixes                                              |
  | beta3 | `ea0482c3` | `e39df0d5a251747085a77405efedc66613314f43d257226d76cb0353485ce2b8` | the tray logs which sign-in failure it was; its tray dies on a held log   |
  | beta4 | `94d969d8` | `aa6925eb5a52b3930f11fc3558ecdcbe8ed5271db44891043e94c41d30e7e3a3` | the tray survives a held log and errors in its handlers; **on Titan now** |

- **Titan's install** is beta4, updated over beta3, so it keeps beta3's bridge key. The relay has that key. Claude has
  never signed in there. The tray is amber, "not signed in".
- **What works** (ran): Setup on a clean install and as an update; the distro cut off from Windows; the launch approved by
  root; the tray, its keep-alive and its status; the relay accepting the PC's key; the first start up to Claude's
  sign-in screen. Pairing refuses, as it should, until Claude runs.
- **What has never worked on Windows:** a real Claude sign-in. Because of that, the green dot, pairing a phone and a reply
  have not been seen on Windows either.

## To resume, in order

1. **Fix the sign-in (the cause is known).** The owner's two real sign-ins ended with the tray log line
   `sign-in: error (no_answer)`: "The code was sent, but there was no answer from Claude in 90 seconds".
   - _Cause (ran):_ `apps/windows/distro/signin.py` writes the pasted code and its Enter (`\r`) to Claude Code's pty in **one
     write**. Claude Code 2.1.322 takes a long burst of input as a paste and swallows the Enter inside it, so the code is
     never submitted, and signin.py waits out its 90 s.
   - _Repro on Titan:_ the real `claude setup-token` in a pty, with made-up codes (never a real sign-in). It answers
     "not accepted", as a made-up code should, only when the Enter arrives on its own:

     | Code length | Code and Enter in one write | Code, then Enter 0.6 s later |
     | ----------- | --------------------------- | ---------------------------- |
     | 37          | answered                    | answered                     |
     | 64          | no answer in 45 s           | answered in 2.3 s            |
     | 89          | no answer in 45 s           | answered in 6.2 s            |

     A real OAuth code is longer than 64 characters, so every real sign-in on Windows has failed this way.
   - _Fix:_ write the code, wait about 0.5 s, then write `\r`, with a test whose stand-in claude drops an Enter that arrives
     inside a long paste. Re-run the made-up-code check against the real Claude Code. The Mac app's sign-in
     (`ClaudeLoginSession.swift`) wrote code and Enter in one write too; Delphi is fixing that side.
   - _The version matters:_ the repro above is Claude Code **2.1.322**, the version pinned in the distro. On a Mac,
     Delphi found that **2.1.327** answered a made-up 89-character code both in one write and split, so newer Claude
     Code may not swallow the Enter. Run the made-up-code check again after updating Claude Code in the distro (the
     paste-test: one write against split, at 37, 64 and 89 characters). The split write stays the fix either way: it is
     safe on every version.
   - Then build beta5 and install it on Titan as an update (the key stays, so the relay needs nothing), and the owner
     signs in.

2. **The false green after a supervisor restart** (Hestia's part, the supervisor). Right after an update restarted the
   supervisor, the tray showed green "running" for about 25 s although Claude was not signed in. The new supervisor took
   over a Main still at the sign-in screen and wrote `main=running` before it saw that screen (`supervisor.log`:
   `supervisor_start`, then `needs_you stuck`, then a restart, then `main=signin`). A person waiting for green would be
   misled. A fresh install is not affected.

3. **The owner's dry run on Titan:** sign in, then wait for green, then pair a phone, then send one message and check a
   reply comes back. Then tag `win-0.1.0-beta<n>` on its commit and hand over the exe and its SHA-256.

## Smaller follow-ups (from the reviews, none blocking)

- signin.py: SIGTERM after `signed_in` exits 1 (the tray ignores the exit code); a cleanup failure after `fail()` can
  still print a second error; a short write of the `signed_in` line still exits 0.
- tray.ps1: the sign-in and pair windows' own ticks rely only on the global guard. If `Show-SignIn` or `Show-Pair` fails
  after its process starts, the `wsl` process is left running. `Set-TrayText` and `Set-TrayIcon` compare with `-ne`
  (not case-sensitive).

## A lesson for whoever watches a run

Never watch the tray's own log (`%LOCALAPPDATA%\Talos\keepalive-<distro>.log`) with `tail -F`, or with anything else that
keeps the file open. On beta3, a held log killed the tray the moment the owner clicked Sign in. beta4 survives it, but a
watch must still never hold a file the product writes. Watch from inside the distro (`supervisor.log`, the credentials
file) instead, and stop a watch's child processes by pid when the watch ends.
