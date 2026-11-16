# Windows support: a plan

_Status: **approved, option 3 (hybrid), being built** (owner, 2026-11-11; decisions in section 8). Written 2026-11-11 on Titan
(Windows 11 Home build 26300, WSL 2.7.11, Ubuntu 24.04). Claims marked **measured** were checked on that machine; **read** means
read from the code at `645dcd68`; **inference** is not checked._

The roadmap says "Linux first, then Windows". Linux has its supervisor (`apps/bridge/src/supervisor`, about 11,000 lines: tmux
host, workers, sub-threads, dialogs, login environment, permission hook). This plan compares three ways to bring Talos to a
Windows PC and recommends one.

## 1. The answer in 6 lines

- **Recommend option 3, the hybrid:** Talos runs inside its own WSL2 distro, unchanged Linux code; a small native Windows piece
  keeps that distro running, shows status, and opens a session in a terminal. About **10-14 builder days**.
- **Option 1 (WSL only)** is the same minus the Windows piece (**6-9 days**), but WSL stops an idle distro within minutes, so
  without that piece Talos goes offline when the owner closes the last window. Measured on Titan's CI runner.
- **Option 2 (native Windows)** is a second supervisor (no tmux: ConPTY), a second safe-open (NTFS reparse points, alternate
  streams, 8.3 names), a Python-free permission hook and a Windows app: **27-44 days**, and a weaker fence than WSL gives.
- **The owner's Windows files** stay reachable through `/mnt/c`, but slowly: writing 2,000 small files took **7.3 s there against
  70 ms** on the distro's own disk (measured). Projects should live in the distro; Windows folders are mounted only by choice.
- **The fence is better in WSL than native:** a Talos distro with interop off and only chosen Windows folders mounted keeps the
  agent away from the rest of the PC. Natively the agent runs as the owner's Windows user, as on the Mac today.
- **Four owner questions** at the end: which folders, who installs WSL (it needs admin once), tray app now or later, and Home vs Pro.

## 2. What Talos needs from the machine (read)

| Need                                                                       | Where                                                        | Linux today                                                                                                | Native Windows                                                                                                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A pane per session that can be typed into, read back and attached to       | `supervisor/tmux-host.ts` (behind `PtyHost`)                 | tmux 3.4                                                                                                   | no tmux; ConPTY (`CreatePseudoConsole`, build 17763+) via a native module such as node-pty; no "attach from another terminal"                                                                 |
| One process group per session, to stop and to prove whose process is whose | `proc-identity.ts`, `supervisor/takeover.ts`, `lifecycle.ts` | `/proc/<pid>/stat` start time and pgid                                                                     | Job Objects; process creation time via a native call; no pgid, no POSIX signals (Ctrl events instead)                                                                                         |
| The owner's login environment for a session (PATH and the rest)            | `supervisor/login-env.ts`                                    | `bash -l -i -c 'env -0'`                                                                                   | no login shell: the user and machine environment from the registry, plus what the installer recorded                                                                                          |
| The permission hook (phone approvals)                                      | `supervisor/worker-hook.ts`                                  | `python3`, resolved from outside the thread folder                                                         | `python3` is the **Microsoft Store stub** on a stock PC even with Python installed (measured: it resolves to `WindowsApps\python3.exe`; real Python answers as `python`/`py`)                 |
| Opening a file without following links                                     | `safe-open.ts`                                               | `O_NOFOLLOW` + realpath                                                                                    | **throws today** (`no safe open on win32`), so Files pane, media and captures fail; needs reparse-point checks, alternate data streams (`file:stream`), 8.3 short names, `\\?\` and UNC forms |
| Case folding of paths                                                      | `worker-spec.ts` (sub-thread inside parent)                  | ext4 is case-sensitive (measured)                                                                          | NTFS folds case by default (measured: `a.txt` finds `A.txt`); the Mac's case-folding checks apply                                                                                             |
| Secrets at rest                                                            | `secrets/`                                                   | file store; already refuses a secret on a Windows-mounted path under WSL (`isWsl`, `WSL_WINDOWS_FS_TYPES`) | DPAPI or Credential Manager                                                                                                                                                                   |
| The hub socket                                                             | `hub/client.ts`                                              | `hub.sock`                                                                                                 | AF_UNIX works on build 17063+ (inference for Bun) or a named pipe                                                                                                                             |
| Claude Code                                                                |                                                              | installed in the distro (2.1.39 found in the dev distro: stale, measured)                                  | native `claude.exe` 2.1.283 installed (measured); its Bash tool needs Git for Windows' bash (present here)                                                                                    |

## 3. Option 1: Talos inside WSL2

**How it works.** A dedicated distro (`talos`), Ubuntu 24.04, with the Linux install inside it exactly as on a Linux box:
bridge, supervisor (tmux), Claude Code for Linux, the kit. The bridge dials out to the relay as on any machine.

**Works today (measured or read).** tmux 3.4, Python 3.12, systemd user services with linger, rootless Docker: all running in
Titan's `talos-ci` distro. The supervisor test suites pass there. The secret store already refuses Windows-mounted paths.

**Missing.**
- **Staying up.** WSL stops a distro once no Windows process holds it, systemd services and linger included. Titan's runner went
  offline within minutes of the last `wsl` window closing, and came back only with a held `wsl -d … sleep infinity`. A logon
  task (or the option 3 app) must hold it. Without it, Talos is offline whenever the owner is not in a terminal.
- **The owner's Windows folders.** `/mnt/c` is 9P (`v9fs`, measured): writes and deletes about 100 times slower than the
  distro's ext4, reads about 4 times. Fine for reading documents; slow for a session building a project. Projects belong in the
  distro, and `\\wsl$\talos\home\…` shows them in Explorer.
- **Windows-side fence decisions.** Interop on (the default) lets any Linux process start `cmd.exe` as the Windows user;
  automount on exposes the whole of `C:`. A Talos distro turns both off (as `talos-ci` does) and mounts only the folders the owner
  picks (`/etc/fstab` drvfs entries, each `uid`/`gid` of the Talos user, `metadata`). The folder fence then treats those mounts
  as case-insensitive (drvfs folds case unless the folder's case flag is set).
- **Install for a non-developer.** `wsl --install` needs an administrator and a restart, once. After that, everything is the
  Linux installer inside the distro.
- **Signing in to Claude Code** inside WSL opens the browser through WSL interop. With interop off, it prints a URL to open by
  hand. A one-time step in the installer.

**Security model.** The agent runs as a Linux user in its own distro. It sees its home, the mounted folders and the network.
With interop and automount off it cannot run Windows programs or read the rest of `C:`. WSL2 runs every distro in one VM with
one network, so a port the owner's own distro listens on is reachable (as `docs/CI-MACHINES.md` notes for Titan). It is
stronger than the Mac's model, where the agent runs as the owner's user.

**Install path (non-developer).** Run one PowerShell script (signed, from the release page). It checks WSL and, if missing,
asks for an administrator to run `wsl --install` and restart. Then it creates the `talos` distro from a pinned Ubuntu image and
writes its `wsl.conf`. It asks which Windows folders to share, runs the Linux installer inside, prints the Claude Code sign-in
link, and adds the logon task that keeps the distro up.

**Effort: 6-9 builder days.** Bootstrap script and distro image 2-3; logon keep-alive 1; folder mounts and their fence rules
(case folding on drvfs, refusing interop paths) 1-2; Claude Code sign-in flow 0.5-1; WSL tests on Titan's runner 1; docs 1.

## 4. Option 2: native Windows

**How it works.** Bridge, supervisor and Claude Code run as Windows processes under the owner's account.

**Works today.** Claude Code for Windows (2.1.283, measured), Node and Bun for Windows (measured), the relay link (plain HTTPS
and WebSocket), the web app.

**Missing (each a real build).**
- A **ConPTY host** behind `PtyHost`: start, type, read the screen, detect dialogs and prompts. tmux gives "attach from another
  terminal" for free (`talos-app supervise attach <thread>`). ConPTY does not. The owner would see a session only through a
  Talos window.
- **Process control** with Job Objects and Ctrl events in place of process groups and signals, and a new pane proof (today it is
  the pgid and the `/proc` start time).
- A **safe-open for NTFS**: reparse points (symlinks, junctions, mount points) refused at open, alternate data streams refused,
  8.3 short names resolved before the fence compares paths, `\\?\`, UNC and drive-relative forms normalised, and case folding
  everywhere. Security-critical, and it needs its own review.
- A **permission hook without `python3`**: the Store stub makes `python3` a trap on a stock PC. Porting the hook to Bun would
  also remove the Python dependency on Linux and the Mac.
- **Secrets** in DPAPI or Credential Manager.
- **Login environment** from the registry, not a login shell.
- A **Windows app** (tray, status, the terminal pane) like the Mac app, plus an installer (MSI or winget). Code signing needs a
  certificate (a yearly cost) or SmartScreen warns.
- **CI on Windows**: a native runner, which Titan cannot isolate the way `talos-ci` does (it would run as a Windows user beside
  the owner's).

**Security model.** The agent runs as the owner's Windows user, as on the Mac: the owner's whole profile, the credential store
for that user and every program. The only fence is Talos's own path checks, which NTFS makes harder (above).

**Install path.** An MSI or `winget install`, a sign-in, done. The best first-run experience of the three, and the most code.

**Effort: 27-44 builder days.** ConPTY host 5-8; process control and pane proof 2-3; NTFS safe-open 3-4 plus a security
review; Bun permission hook 2-3; DPAPI secrets 1-2; login environment 1; Windows app 8-15; installer and signing 3-5; Windows CI
2-3.

## 5. Option 3: the hybrid (recommended)

**How it works.** Option 1's distro runs Talos, unchanged. A small native piece adds what WSL lacks on its own:
- **keeps the distro running** while the owner is signed in (it holds a `wsl` process and restarts it if WSL shuts down);
- **status** in the notification area: bridge up, relay reachable, sessions running, from `talos-app status --json` over `wsl`;
- **"Open session"**: a terminal that runs `wsl -d talos -- talos-app supervise attach <thread>` (Windows Terminal when
  installed: it is not on this Home build's PATH, measured; else `wsl.exe` in a console);
- **"Show files"**: Explorer on `\\wsl$\talos\home\<user>` or the thread's folder;
- **notifications** stay on the phone (the relay's push); the tray only mirrors status.

It is the WSL option with the Mac app's smallest jobs. It can start as a logon task plus a Start-menu shortcut (option 1) and
grow into the tray app without changing Talos itself.

**Effort: 10-14 builder days.** Option 1 (6-9) plus the tray piece (4-5: a small .NET or Tauri app, no Talos logic in it).

## 6. Recommendation

Build **option 3 in two steps**. First option 1 with the logon keep-alive, then the tray piece. It reuses the whole Linux
supervisor. Titan already runs and tests it under WSL. Its fence beats native Windows, and the slow `/mnt/c` is avoided by
keeping projects in the distro. Leave native Windows (option 2) until owners ask for it, except the **Bun permission hook**:
it pays off everywhere (no Python dependency) and is the one piece option 2 would need first.

Order: (1) bootstrap script and distro, logon keep-alive, folder mounts; (2) WSL fence tests on Titan's runner; (3) docs and a
first install on a clean Windows VM; (4) the tray piece; later, the Bun hook.

## 7. Questions for the owner (at most four)

1. **Which Windows folders should a Talos distro see?** None (projects live in the distro), your Documents, or a list you pick
   at install. Each one is slower and less fenced than the distro's own disk.
2. **Who installs WSL?** `wsl --install` needs an administrator and a restart, once. Is it fine for the installer to ask for
   that, or should Talos require WSL already present?
3. **Tray app in the first release, or a logon task and Start-menu shortcut first?** The tray adds about 4-5 days.
4. **Windows Home or Pro?** WSL2 runs on both (Titan is Home). If owners may run Pro or Enterprise with a managed WSL policy
   (some organisations turn WSL off), option 2 becomes the only route there.

## 8. Owner decisions (2026-11-11) and the build

**Decisions.**

1. **Windows folders: none by default.** The owner adds one per thread when a thread needs it.
2. **The installer may ask for an administrator once**, for `wsl --install`.
3. **The tray ships in the first release**, with keep-alive and status only; anything fancier later.
4. **Home and Pro are both supported.** Managed-WSL policy is tested before any organisation rolls it out.

**Step 1: the distro, the bootstrap, the keep-alive** (`apps/windows/`).

- `install.ps1` (Windows PowerShell 5.1, no admin except the one WSL install): checks the Windows build and WSL; with no WSL,
  asks once to run `wsl --install --no-distribution` as administrator and to restart, then to run it again. It creates the
  distro with `wsl --install Ubuntu-24.04 --name talos --location <LocalAppData>\Talos\wsl --version 2 --no-launch`
  (Microsoft's own image: nothing downloaded or checked by hand) and marks it as Talos's, brings this clone in as a git
  bundle (no credential in the distro), runs the setup inside, and registers the keep-alive. Running it again changes
  nothing that is already right.
- The setup inside the distro is bash (`apps/windows/distro/`), so it is tested on Linux: `wsl.conf` (systemd on, interop
  and automount off, `mountFsTab` on for the folders the owner adds, default user `talos`), the `talos` user, packages (git,
  curl, tmux, python3, build-essential), Node, pnpm, bun and Claude Code under the user (pinned versions, SHA-256s written in
  the script), `install.sh --yes --no-app`, linger and the `talos-supervisor` user unit.
- The keep-alive: a per-user logon task (no admin) that runs a hidden loop holding `wsl -d talos` open and starting it again if
  WSL stops it.
- `add-folder.ps1 <Windows folder> [-ReadOnly]`: one Windows folder into the distro, read-write unless `-ReadOnly`, through
  an `/etc/fstab` drvfs line at `/mnt/win/<name>`, owned by `talos`. It refuses system folders (Windows, Program Files,
  ProgramData, AppData, the profile root itself), key folders, Talos's own files, and any path with a link in it, and
  prints the path to give the thread as its folder.
- `uninstall.ps1`: the logon task always; the distro and its files only when asked, and only a distro with Talos's marker.

**Fable's round 1 on 3714c08b, and what changed** (R1-9, the macOS `sed`, landed first in 2ac36e1f):

- **R1-1, Talos's own Windows files.** The logon task ran `keepalive.ps1` from the clone, so a clone shared into the distro
  let the agent change what Windows runs at logon. The task and the owner's scripts now run from copies in
  `%LOCALAPPDATA%\Talos\bin`, with only the owner and SYSTEM on its ACL, and the distro refuses a share that is, holds or
  sits inside the clone or `%LOCALAPPDATA%\Talos` (`protect-add`).
- **R1-2, the files root runs.** They went through `/var/tmp`, where the `talos` user can write first. Each is now handed to a
  root shell as a base64 argument with its SHA-256; root decodes, checks and installs it root-owned. Only the git bundle,
  which is the `talos` user's own input, still goes through `/var/tmp`.
- **R1-3, isolation beyond interop and drives.** WSLg (`/mnt/wslg`, the X11 socket) is unmounted and `/mnt/wsl`, which every
  distro shares, gets a private tmpfs, both by a boot unit in this distro only (`talos-isolate.service`); the owner's other
  distros keep WSLg. The isolation check covers both. `install.ps1` refuses `networkingMode=mirrored` in `.wslconfig`, which
  shares the PC's localhost with every distro.
- **R1-4, folder checks Windows can get round.** add-folder resolves the folder with `GetFinalPathNameByHandle` and refuses a
  link or junction in any part of the path, not only the last. The distro side refuses 8.3 names, names ending in a dot or
  space, doubled separators, `Windows.old`, `Documents and Settings`, `All Users`, and AppData and key folders
  (`.ssh`, `.aws`, `.gnupg`, `.azure`, `.kube`, `.docker`, `.config`) anywhere in the path.
- **R1-5, secrets in output.** The origin URL loses any `user:token@`; failures name the step, not the command line; a dry run
  prints a command's name only; an unknown option is not echoed.
- **R1-6, downloads.** Every download has a SHA-256 written in `setup-user.sh` (a checksum list from the same server vouched
  for nothing), pnpm is its standalone binary (no `npm install -g`), and Claude Code is a pinned release binary (no
  `curl | bash`). `scripts/windows-distro.test.ts` checks the pins and that pnpm's matches `package.json`.
- **R1-7, someone else's distro.** A distro named `talos` that Talos did not make (no `/etc/talos-wsl/marker`) is refused by
  install, add-folder and uninstall, never changed, stopped or deleted. `root-setup` also refuses a uid 1000 that is not
  `talos`, or a `talos` in `sudo`, `admin`, `wheel` or `root`.
- **R1-8, a share that does not mount.** It is mounted first and written to fstab only once it is up; a stray quote from a
  Windows argument is dropped.
- **R1-10, Windows tests.** `apps/windows/tests/TalosWin.Tests.ps1` (Pester 3.4, the one Windows ships) covers the root
  payload and its hash, the URL login, and add-folder's link and junction refusals. It runs on Titan by hand:
  `powershell -ExecutionPolicy Bypass -Command "Invoke-Pester apps\windows\tests"`; Linux CI cannot run it.
- **R1-11 to R1-15.** `wsl.exe` by its full path; `--version 2` and x64 only (the pins are linux-x64); git checked before
  anything is created; the keep-alive retries at most 30 s apart.
- **R1-12, git hooks: a risk the owner accepts by choosing read-write.** A repository shared read-write lets the thread write
  `.git\hooks`, and a hook runs on Windows, as the owner, the next time the owner runs git in that folder. Talos cannot
  refuse it without refusing every repository. add-folder.ps1 and install.ps1 say so; `-ReadOnly` closes it for a repository
  the owner also works in from Windows.

**Fable's round 2 on 3c4d3509, and what changed** (R1-1, R1-2 and R1-4 to R1-11 verified fixed; R1-3 still open):

- **R2-1, an unmount reaches other distros through its parent.** isolate-mounts now makes every WSLg mount private, parents
  first, before it unmounts any, and stops (unmounting nothing) if one cannot be made private.
- **R2-2, isolation only at install.** At boot the unit now runs after what WSL itself sets up (tmpfiles recreates
  `/tmp/.X11-unix`, and WSL's generated `wslg.service` binds WSLg there again), and ends by checking `isolation` against
  `/proc/mounts` as it then is, so it fails if anything is left. talos's user manager, which runs the supervisor, gets a
  root-owned drop-in: it `Requires=` and comes `After=` the unit, and checks `isolation` again as root (`ExecStartPre=+`)
  before it starts, so a failed or undone isolation starts no agent, and the journal says why. The gate sits on the user
  manager, not in the supervisor's own unit: a user unit cannot depend on a system unit, and the supervisor's unit lives in
  talos's home, where the agent could change it.
- **R2-3, the mode of a folder shared again.** Sharing it again in the other mode unmounts it (not lazily: a folder in use
  is refused, never left writable behind a read-only mount point), mounts it in the new mode and rewrites its fstab line.
  If the new mount fails, the old one goes back.
- **R2-4, proof of the private `/mnt/wsl`.** Only `/proc/mounts` counts: the mount on top at `/mnt/wsl` must be the
  `talos-private` tmpfs. A file in it proves nothing, and the round 1 mark file is gone.
- **R2-5, a share that predates protection.** `protect-add` also takes out any share that is, holds or sits inside the
  protected folder, so an install over an older one leaves no share of the clone.
- **R2-6.** Claude Code's own install step is given the pinned version.
- **R2-7.** After the copy, every file in `%LOCALAPPDATA%\Talos\bin` is reset to inherit the folder's ACL only (`/reset /T`),
  and the install fails if any file keeps an entry of its own.
- **R2-8.** Pester runs root's side of the handover for real, in a WSL distro as root under `/tmp` (`TALOS_PESTER_DISTRO`,
  default `Ubuntu`): a matching hash installs root-owned 755; a wrong hash, or other bytes under the right one, installs
  nothing and leaves a file already there as it was. Taking the hash check out turns them red.
- **R2-9, mirrored networking set later.** `isolation` asks WSL (`wslinfo --networking-mode`, which works with interop off)
  and refuses `mirrored` or an answer it cannot read, so the boot unit and the user manager's check catch it, not only
  install.
- **Found live on this rerun.** Ubuntu 24.04's own image already runs systemd, so the first root-setup, before the restart,
  started the unit while C: was still mounted, and its new check failed. root-setup now only enables the unit then; it
  starts, and linger goes on, once `isolation` passes, which is after the restart. The interop entry alone is not that
  test: apt restarting `systemd-binfmt` drops WSL's entry while C: is still mounted. The interop check also matches any
  `WSLInterop*` entry (`WSLInterop-late` is the name WSL uses under systemd on some versions).
- **Checked live** (a throwaway distro, removed after):
  - from scratch: the install ends with the supervisor up
  - with something mounted at `/mnt/c`, talos's user manager refused to start, saying why, and the supervisor went down
    with it; with it unmounted, both came back
  - after a restart: the gate passed and the supervisor came up
  - a share switched read-write to read-only and back, with fstab to match; with a file held open, the switch was refused
    and the share stayed read-write
  - protecting a folder took out its existing share
  - every file in `bin` inherits only the folder's ACL
  - a new distro starts afterwards

**Fable's round 3 on 953a5d13, and what changed** (R2-1 to R2-9 verified fixed):

- **R3-1, a remove that could not unmount.** `folder-remove` now refuses a share it cannot unmount, keeps its fstab line and
  says so; one not mounted at all (its folder deleted on Windows) is still removed. `protect-add` over a share in use drops
  its line, says it stays mounted until the distro restarts, and exits 3; install.ps1 restarts the distro next, and until
  then `isolation` refuses while any mounted share is, holds or sits inside a protected folder.
- **R3-2, beyond the supervisor's user manager.** cron and atd are masked. A login as talos (`wsl -d <distro>`) runs a
  root-owned profile check and is refused, saying why, while isolation is broken; root's still works. The keep-alive holds
  the distro through `talos-wsl.sh hold`, which ends at once, saying why, when isolation is broken. (A command Windows
  starts gets no login shell: see R4-1.)
- **R3-3, other distros' localhost.** WSL 2 runs every distro in one network namespace, so a service on 127.0.0.1 in the
  owner's other distros is reachable from the Talos distro, and the other way round (measured: an HTTP server bound to
  127.0.0.1 in Ubuntu answered `curl` run as talos, HTTP 200). `isolation` no longer claims more: it says the distro is cut
  off from Windows, and that localhost is still shared with the other distros. An nftables rule is not added yet. In a
  shared namespace a rule matches by uid, and talos is uid 1000, which is also the owner's own user in a default Ubuntu
  distro, so a rule for talos would hit the owner. The follow-up: give talos a uid of its own, then drop loopback
  connections from it to any port but its own (open test items, below).
- **R3-4, mixed modes.** A share that holds, or sits inside, one already shared in the other mode is refused, naming it.
- **R3-6.** A failed mode change says what happened: "could not unmount" (in use), or, if the old mode does not mount again
  either, that it is not mounted now and comes back in the old mode at the next restart.
- **R3-7.** The keep-alive logs a refused hold with the reason and shows a Windows notification, once until it holds again.
- **R3-8.** Claude Code's auto-updater is off (in the login environment and in its settings): an update would replace the
  checked binary. A newer version comes with a new pin and setup-user.sh run again; a pinned version differing from the
  installed one is reinstalled.
- **R3-9.** Linger is retried for 5 s after the restart, and the linger file itself is the proof; without it the install fails.
- **R3-10.** install.ps1 checks the `bin` folder's own ACL: protected from inheritance, and no one on it but the owner and
  SYSTEM.
- **Found on this round's live runs, fixed here:**
  - talos-wsl.sh grew past one Windows command line as a base64 argument; the handover is now gzipped (13 KB), with the
    SHA-256 still of the bytes themselves.
  - An ordinary share next to the protected list made `isolation` exit 1 with no word (a `set -e` status); it refused
    every login. So did running it as talos from a folder talos cannot read (`find` could not get back to it).
  - "Distro start" for the wsl.conf check is the distro's own PID 1, not `/proc/uptime`, which is WSL's shared VM's.
  - WSL registers its binfmt entry for .exe files when the distro starts even with interop off, sometimes after the boot unit
    has run. With interop off nothing serves it: a Windows .exe in a share, run directly or through `/init` with
    `WSL_INTEROP` set, failed every time. So the entry is no sign either way, and the check that stopped Talos over it was
    wrong. Interop is now what the root-owned wsl.conf says, as applied at the distro's start (a wsl.conf changed since the
    start counts as "may be on"). (Round 3 also took the entry out at boot; that was wrong, see R4-2.)
  - WSL's own per-session interop sockets (`/run/WSL/*_interop`) are there and world-writable; nothing answers on them with
    interop off (the `/init` runs above used them).
- **Reviewer's live checks, run on Titan:** (1) after isolate-mounts in the Talos distro, Ubuntu still had its own
  `/mnt/wslg`, `/tmp/.X11-unix` and `/mnt/wsl`; (2) as talos, a Windows .exe in a share failed, run directly and through
  `/init`; no `WSL_INTEROP` in talos's environment (the sockets above exist); (3) `apt upgrade` (76 packages) and a
  `systemd-binfmt` restart did not bring interop back; (4) after six `wsl -d` sessions, isolation still passed and the only
  `/run/user` mounts were logind's own (`/run/user/0`, `/run/user/1000`), no WSLg bind.

**Fable's round 4 on 691284c5, and what changed** (R3-1 and R3-5 to R3-10 verified fixed):

- **R4-2, the interop entry is the whole VM's.** WSL keeps ONE binfmt entry for .exe files for every distro, so round 3's
  taking it out at each boot of the Talos distro broke `code .`, `explorer.exe` and every .exe in the owner's other distros
  until something registered it again. That is also why it "came back". Nothing in the Talos distro touches it now; interop
  is judged by wsl.conf alone. (Checked on Titan after the fact: the owner's Ubuntu had the entry back and ran .exe files.)
- **R4-1, what Windows starts.** `wsl -d <distro> -- <cmd>` and `--exec` get no login shell, so the login check never sees
  them. They are the owner's own (the agent cannot run wsl.exe: interop is off), but the ones Talos hands the owner are
  gated: the sign-in install.ps1 prints is `wsl -d <distro> --exec /opt/talos-wsl/talos-wsl.sh run -- claude`, `run` checks
  isolation first, and `/usr/local/bin/claude` (root's, first on the PATH such a command gets) runs the user's own Claude
  Code only through `run`. The text that said nothing runs as talos outside the gated user manager is corrected.
- **R4-3.** A share changing mode is checked against overlapping shares in the other mode first, as a new share is.
- **R4-4.** File times are read with GNU or BSD `stat`, so the tests run on a Mac too.
- **R4-5.** A test sources the login check into a shell, as /etc/profile.d does, and sees it refuse and let in.
- **R4-6.** wsl.conf is read as WSL reads it: the last `enabled` in `[interop]` wins, comments and spaces aside, and only a
  literal `false` is off; `1`, `0`, `yes`, `no` or a typo count as on.
- **R4-8.** `hold` checks isolation every 60 s while it holds, and ends, saying why, when it breaks; the keep-alive then
  logs it and notifies.
- **R4-7, a clock step.** "wsl.conf is older than this start" compares wall-clock times (the kernel's boot time plus PID 1's
  start, against the file's mtime), so a large step of the clock between the boot and the check can make it pass or refuse
  wrongly. The distro restarts, and WSL syncs the clock, often enough for that to be rare.

**Fable's round 5 on 6ba94215: nits only; Windows step 1 is closed for security.** The six lows:

- **R5-1.** The wsl.conf reader cuts only a `#` comment and trims spaces only around the key and the value: `en abled`,
  `fal se` or a `;` in the value are not `false`.
- **R5-2, a command Windows starts.** `wsl -d <distro> -- bash` (or any command) is the owner's own choice and is not
  gated; only what Talos hands the owner goes through `run`. Measured: for `wsl -d <distro> -- <cmd>`, with stdin a pipe
  or redirected, bash does not read `~/.bashrc` (Ubuntu's bash reads it for `bash -c` only when stdin is a socket, as ssh
  gives it), so nothing in talos's own `.bashrc` runs for such a command.
- **R5-3.** A test runs the claude wrapper itself, isolated and not; root-setup writes it with `put_unit` (as root) and
  sets it 755.
- **R5-4.** The R4-7 note above, and a comment where the check is.
- **R5-5.** The keep-alive no longer notifies twice for one refusal: a hold that lasted and was then refused does not reset
  the "already told" mark.
- **R5-6.** `refused` exits 1 on purpose, not through the status of its pipeline.

**Live checklist for a change to apps/windows** (R3-5; the tests use stand-ins for mount, umount and wslinfo, so these run on
a real PC, a throwaway distro, `-Distro talos-e2e`, removed after):

1. Install from scratch: it ends with "Talos is set up" and the supervisor running; `isolation` passes.
2. Restart the distro (`wsl --terminate`): the isolation unit is active, talos's user manager and the supervisor come up.
3. Another distro (Ubuntu), running while the Talos distro boots, still has its own `/mnt/wsl`, `/mnt/wslg` and
   `/tmp/.X11-unix`, and still runs a Windows .exe (`cmd.exe /c ver`); a brand-new distro starts.
4. Break isolation (`mount -t tmpfs x /mnt/c` as root): restarting `user@1000` fails and says why, a `wsl -d` login as
   talos is refused, `hold` exits 1, and the keep-alive logs it and notifies; unmount and all come back.
5. A share: read-write, then `-ReadOnly`, then back; with a file held open in it, the mode change and `-Remove` are refused.
6. A Windows .exe in a share does not run as talos, directly or through `/init`.
7. Run the install again over the same distro: nothing breaks, and an older share of the clone is taken out.
8. `uninstall.ps1` removes the task and stops the distro; `wsl --unregister` it, and empty `%LOCALAPPDATA%\Talos`.

**What the live runs on Titan found** (a throwaway distro, removed after; each is handled in the code and, where it can be,
tested in `scripts/windows-distro.test.ts`):

- Once systemd runs, a file Windows writes to `\\wsl.localhost\<distro>\tmp` is not seen inside, so files are handed over in
  `/var/tmp/talos-install`.
- Windows PowerShell 5.1 drops the double quotes inside arguments to `wsl.exe`, so nothing quoted is passed: checks run as
  subcommands of `talos-wsl.sh` (`isolation`) through `wsl --exec`, which also keeps backslashes and spaces in folder paths.
- With `ErrorActionPreference Stop`, a redirected native stderr line ends a 5.1 script; reading `wsl.exe` output never throws.
- An empty `/mnt/c` folder is not a mount: the isolation check reads `/proc/mounts`.
- The Linux `install.sh` needs Claude Code in the distro: `setup-user.sh` installs it with Anthropic's installer; signing in
  is the owner's once (`wsl -d talos -- claude`; interop is off, so it prints a link).
- The supervisor needs `supervisor.json` (`agent_dir`, and the Mac's `desktop.json` flags); without it it restarts every few
  seconds while systemd says "active". `setup-user.sh` writes it once and requires 10 s with no new restart.
- A shared folder deleted on the Windows side broke the next start, the systemd user session for `talos` (the supervisor's)
  included. Every share is `nofail`.
- `awk -v` turned the escaped spaces of a stored share back into spaces, so sharing a folder with spaces twice made a second
  mount; compared through `ENVIRON` now.
- The keep-alive held the distro for 3 minutes with nothing else attached, and had it running again 20 s after a forced stop.
- (Round 1 rerun.) `/mnt/wsl` and the WSLg mounts are in a shared peer group that reaches WSL's own VM. A tmpfs mounted
  straight onto `/mnt/wsl` propagated there, and from the next start on no distro on the PC could start
  (`Wsl/Service/CreateInstance/E_UNEXPECTED`) until `wsl --shutdown`. Each mount is now made private in the Talos distro
  first (`--make-rprivate`), then unmounted or covered. Checked live: three restarts, then a new distro, all start.
- (Round 1 rerun.) WSL points `/etc/resolv.conf` at `/mnt/wsl/resolv.conf`, so the private `/mnt/wsl` carries WSL's
  `nameserver` and `search` lines over; without them the distro had no DNS.
- **DNS fallbacks (2026-11-16).** WSL's own resolver can stop answering while Windows stays online: the tunnel
  (10.255.255.254) on 11-14, and on 11-16 the NAT gateway (named alone with `dnsTunneling=false`) timed out on every name
  it had not cached, so the owner's first sign-in failed (Claude Code's code exchange: `EAI_AGAIN platform.claude.com`).
  From the distro, 1.1.1.1 and 8.8.8.8 answered in 12-64 ms. The distro's resolv.conf is now WSL's own nameservers, then
  the gateway, then 1.1.1.1 and 8.8.8.8, cut at glibc's three, `options timeout:2 attempts:2`. Nothing changes while
  WSL's resolver answers within 2 s.
  - What it costs, plainly: when WSL's resolver is slow or down, or answers SERVFAIL, the name goes unencrypted to Cloudflare
    or Google, past a VPN's DNS, a Pi-hole or a parental filter. An NXDOMAIN answer is final, so a name the owner's network
    says does not exist goes nowhere else. A split-horizon internal name can resolve to its public address in that case.
  - `talos-app doctor` looks up platform.claude.com, api.anthropic.com and claude.ai for real and gives the fix in one line
    (restart the distro, run Setup again when the installed `talos-wsl.sh` predates this, or the network or a VPN).
- **A name that does not exist takes 10-20 s to fail in WSL** (measured 2026-11-13 on Titan, Ubuntu and `talos-ci` alike:
  WSL's resolver 10.255.255.254 with the LAN's `search ht.home`; `getent hosts push.example.com` 20 s, Node's
  `dns.lookup` 10 s, then ENOTFOUND; `localhost` and real names answer in milliseconds). A Mac answers the same lookup in
  milliseconds. So a test must never look up a made-up name and then wait a fixed short time for what follows: it waits for
  the event itself, up to the code's own deadline (e2e BUG F, `bughunt-core-relay.spec.ts`, failed every WSL run on a
  1.5 s wait for a push to `push.example.com`). The same holds for anything on a Windows owner's PC that sends to a host
  that does not resolve.
- **Known WSL behaviour: a distro with interop off takes interop away from every other distro** (seen 2026-11-12 on Titan:
  WSL 2.7.11.0, kernel 6.18.33.2-microsoft-standard-WSL2, Windows 11 Home build 26300).
  - What happens: WSL's binfmt entry for Windows programs (`WSLInterop`) is one entry for the whole VM. When a distro whose
    wsl.conf turns interop off starts, WSL itself removes it. Every other distro then fails each `.exe` with "Exec format
    error" until `wsl --shutdown` or a re-register. That includes the owner's Ubuntu (`gh.exe`, `cmd.exe`, `code`).
  - Proof that WSL does it, not Talos: no Talos or CI script writes there (the R4-2 guard). A `talos-ci` restart with
    systemd-binfmt masked still removed the entry.
  - Which distros trigger it: Talos's own distro, `talos-ci` (on every keep-alive restart), and any throwaway test distro.
    It probably began around 10:20Z, from the tray's live test distros.
  - The fix: at each boot, `isolate-mounts` (`give_back_interop`, run by the boot unit as root) registers the entry again,
    but only when it is missing, with the exact line WSL's own systemd-binfmt drop-in uses (`:WSLInterop:M::MZ::/init:P`).
    `talos-ci` does the same with `wsl-interop-restore.service` (docs/CI-MACHINES.md).
  - The only binfmt write in the script is to `register`, and nothing writes the `-1` that removes an entry (the R4-2 test
    checks both).
  - It gives the cut-off distro nothing back. Checked live, with the entry present: a real `whoami.exe` piped into
    `talos-ci` failed both as its user and as root (exit 1, no output, after 10 s). WSL's `/init` found no interop server
    there (`UtilAcceptVsock: accept4 failed 110`). The same file ran in Ubuntu.
  - Only root can trigger it: `/proc/sys/fs/binfmt_misc/register` is `--w------- root`, and `talosci`'s write was refused.
    The talos user cannot write it either. The boot unit runs as root.
  - Her PC has no other distros, so it was never hit there. Any PC with the owner's own distros beside Talos would have
    been.

**Open test items before any organisation rollout** (not run yet; Titan already had WSL and has no managed policy):

1. **A machine with no WSL at all**, ideally a clean Windows 11 VM, Home and Pro: the one administrator prompt, the restart,
   the second run, and what the owner sees at each step.
2. **A managed-WSL policy** (Intune or Group Policy: WSL disabled, or limited to approved distros, or with custom kernel or
   networking settings): what `install.ps1` says when the policy blocks it, and whether an allowed setup still isolates.
3. **An ARM64 PC**: refused today; supporting it means linux-arm64 pins.
4. **The other distros' localhost (R3-3 follow-up)**: talos on a uid of its own (not 1000), then an nftables rule in the
   shared namespace that drops loopback connections from that uid to any port it does not own; test that the owner's own
   distros keep their localhost, and that Talos's own connections still work.

**Step 2: the tray** (`apps/windows/tray.ps1`, keep-alive and status only; the owner's decision 3, after step 1 closed).

- A Windows PowerShell 5.1 script with the notification-area icon Windows Forms provides: no build toolchain, nothing to
  sign beyond the script. It runs from `%LOCALAPPDATA%\Talos\bin` like the other scripts (only the owner and SYSTEM can
  change it), as the same logon task the hidden keep-alive had; `install.ps1` registers the tray by default and
  `-NoTray` keeps the hidden `keepalive.ps1`. The task's name does not change, so a second install switches between them
  and `uninstall.ps1` removes either.
- It is the keep-alive: it holds the distro through `talos-wsl.sh hold` (so only while the distro is cut off from
  Windows), starts it again when WSL lets go, at most 30 s apart, and shares `keepalive.ps1`'s single-instance lock and
  log, so the two never both run. A refused hold is logged with its reason and shown once as a notification, until the
  distro holds again.
- Every 30 s it asks the distro, `talos-wsl.sh status` as root: one line, `supervisor=<systemd's word> isolated=<yes|no>`,
  in which only systemd's own state words pass (anything else is `unknown`). The dot is green for a running supervisor,
  amber while it starts or while the distro does not answer within 8 s, and red when it is stopped or failed, or the
  distro is not cut off from Windows. The menu says the same in words (Talos, cut off from Windows, the keep-alive), then
  "Open the log folder" and "Quit". Quit asks first and says what it means: Talos stops once Windows lets the distro go;
  it starts again at the next sign-in.
- Not in it (decision 3: "anything fancier later"): starting a session, sharing a folder, settings. Those stay in the
  scripts and the app.
- Each change of what it shows is also a line in the keep-alive log (`tray: green, Talos running (supervisor=active
  isolated=yes)`), so what the tray said, and when, has an answer.
- The one holding the lock ends any `hold` a stopped tray or keep-alive left behind (its wsl.exe outlives its
  PowerShell), or that leftover would keep the distro held after Quit (found live: two holds after a task restart).
- Checked live on Titan (a throwaway distro, removed after): installed as the logon task, green with the supervisor up;
  with something mounted at `/mnt/c`, red 27 s later (`isolated=no`), and the hold ended and was refused with the reason in
  the log (and the notification); with the distro clean again, green. A stopped task's leftover hold was ended at the next
  start. Uninstall left no tray and no hold.
- **Open live check, for the owner:** Quit and the menu are not click-tested (no screen here): right-click the dot, read
  the three lines, "Open the log folder", then Quit and its question; after Yes the dot goes and Talos stops within a
  minute or so.

**The no-terminal install** (the owner, 2026-11-12: his wife installs and runs Talos on her own Windows PC, mostly from an
iPhone, with no terminal and no help). What is built, item by item:

- **Setup.exe** (`scripts/windows-setup/build.ps1 -Version <v> [-Ref origin/main] [-RelayUrl <her relay>]`). It is
  **unsigned**: the owner ruled out paid signing, and the free routes do not fit today. SignPath Foundation wants an
  OSI-licensed project it can check in public; the repo is private. The Microsoft Store takes an MSIX only from an app that
  needs no administrator, and an MSI or EXE only when it is signed with a certificate the Store trusts. The setup guide
  shows SmartScreen's "More info", then "Run anyway". Nothing in Setup turns SmartScreen off or changes a security setting.
  - IExpress, which is built into Windows, packs three files. `setup-ui.ps1` is Setup's window. `talos-setup.zip` holds
    `apps/windows` and the git bundle of one commit, both from that commit (`git archive`, never the working tree), plus
    `payload.json`. The third file is Microsoft's WSL installer.
  - `payload.json` holds the version, the commit, the bundle's SHA-256, the relay URL and the origin with no login. The
    relay URL is a build input only and never appears in the repo.
  - The IExpress stub runs as the user (`asInvoker`). The only administrator prompt is WSL's own.
- **Payload mode** (`install.ps1`, `Get-TalosPayload` in TalosWin.ps1): with `payload.json` beside it, install.ps1 needs no
  git and no clone. Every field must be what build.ps1 writes, or it refuses. The bundle's SHA-256 is checked by build.ps1,
  and again by install.ps1 just before the bundle goes into the distro, after any restart. Without `payload.json`, it runs
  from a clone as before.
- **`-Silent`** (implies `-Yes`) never prompts. **`-ResumeWith`** is what Windows runs after a restart: Setup's window, not
  this script in a console.
- **Setup's window** (`setup-ui.ps1`, Windows Forms in PowerShell 5.1):
  - It unpacks into `%LOCALAPPDATA%\Talos\setup`, with only her and SYSTEM on the folder.
  - The first page says what happens, offers the stay-awake checkbox, and has "Set up Talos".
  - While it runs, it shows each `==` step in words.
  - A restart is a page of its own with "Restart now" and "Later". The last page says where the tray icon is and what
    comes next. A failure is shown in her words, with "Open the log".
  - Every line goes to `%LOCALAPPDATA%\Talos\setup.log`. install.ps1 prints no secret (R1-5).
- **A PC with no WSL** (item 2; TalosWin.ps1 `Get-TalosWslReadiness`):
  - **Ready**: WSL is installed and a hypervisor runs.
  - **Virtualization off**: no hypervisor, and the firmware flag is off. She gets plain words: the setup key, the setting's
    names, "open Talos Setup again". WSL's own virtualization errors at distro creation map to the same words.
  - **Restart pending**: Windows is already waiting for one. She gets a restart, then Setup resumes.
  - **Missing**: the one administrator step runs elevated, which is her one "Yes" (how it takes nothing from her own folders
    is under round 1 on f3575ba1, below). It installs the pinned msi and turns on Virtual Machine Platform. Then one
    restart, and an HKCU RunOnce entry reopens Setup.
  - The pin is WSL 2.7.11 (`wsl.2.7.11.0.x64.msi`, SHA-256 `a611ddac…614a0f9d`), the version every Windows step was tested
    on. WSL 3.x needs one live run of the checklist before the pin moves.
- **Stay awake on AC** (a checkbox, on by default): no power setting is changed. While the tray runs on AC power, it asks
  Windows not to sleep for idleness (`SetThreadExecutionState`, what a media player does). On battery, or with the box
  unticked, it stops asking. So uninstall has nothing to put back: it removes the choice (`settings.json`), Setup's copy
  and any pending resume.
  - A closed lid or Sleep still sleeps the PC. The tray notices a wake (a 2 s timer that ticked minutes late), shows
    "Asleep: Talos was offline from X to Y", and notifies once.
- **Her relay's key**: Setup saves the `BRIDGE_PUBKEY=` line the install prints to `%LOCALAPPDATA%\Talos\relay-key.txt`, and
  shows it on the last page with "Copy the key". The setup guide tells the owner, in one line, to send this key to whoever
  runs the relay. Nothing does it automatically.
- **Next** (in this order, each in the tray):
  - sign in to Claude through a root-owned helper in the distro (Pantheon's token rules: the token never touches Windows)
  - "waiting for the relay to accept this PC", with a retry
  - pairing on `talos-app enroll --json` in a pty inside the distro
  - plain-words red states, "Restart Talos" and "Save a report" (redacted)
  - an uninstall with no prompt typed
- **Open live checks, for the owner's clean test PC**: all of Setup, start to finish.
  - SmartScreen's "Run anyway".
  - A PC with no WSL: the one "Yes", the restart, and Setup carrying on by itself.
  - Virtualization off, if the PC's firmware lets him try it.
  - The first real sign-in.
  - Pairing her iPhone over TestFlight.

**Fable's round 1 on edb035b3 (the tray), and what changed.** Nothing let the agent run code on Windows; every finding was
about the status being wrong or hidden.

- R1-1 (high): `status` asked talos's own user manager first, with no time limit, and only then checked isolation. The
  agent can stall its user manager, so a broken isolation showed as amber "not answering", never red. Now:
  - isolation comes first, root's check only, on a line of its own, printed at once (`isolated=<yes|no>`);
  - then `supervisor=<word> main=<state>`, with the user manager asked under `timeout 3` and Main's file read under
    `timeout 2`, so a stalled answer is `unknown`;
  - the tray's reader keeps whatever came before its 8 s ran out;
  - red for `isolated=no` whatever else is missing (`Get-TalosTrayView`).
- R1-2 (high): on `isolated=no` the tray said "Talos does not run" without looking, and nothing stopped the agent. Now root
  stops it whenever a status poll or the hold finds isolation broken (`stop_agent`): talos's whole user manager
  (`systemctl stop --no-block user@<uid>`) and talos's logins (`loginctl terminate-user`). The tray says what is true,
  "stopping Talos" while systemd still has the supervisor up, then "Talos is stopped".
- R1-3 (medium): the status poll ran on the UI thread and could freeze the menu and Quit for 8 s. It now runs in a runspace
  of its own; the UI reads the finished result every 2 s.
- R1-4 (medium): a second tray or keep-alive that found the lock taken exited 0 silently, so install's stop-then-start
  could leave neither. Both now wait up to 10 s for the lock and take over one whose holder died. If it is still held, they
  log it and exit 1, so the logon task's restart tries again.
- R1-5 (low): a hold that failed to start showed as "holding" and was retried every 2 s. It is now logged and backed off
  like a hold that ended.
- R1-6 (low): the tests now cover:
  - the colours (Pester): `isolated=no` is red, and no answer, an unreadable answer or one with no `isolated` line is never
    green;
  - the stray-hold match (Pester): it is exact now (`Test-TalosHoldCommandLine`: the program, then exactly the hold's
    arguments);
  - a hanging `runuser` (windows-distro.test.ts): `status` answers within the tray's 8 s, isolation first.

**Fable's round 1 on f3575ba1 (Setup), and what changed.**

- R1-1 (high): the elevated step ran `enable-wsl.ps1` from her own folder, dot-sourced the pin from there too, and hashed
  the msi by path before handing msiexec that same path. Anything running as her could swap any of them before her
  "Yes". Now:
  - `enable-wsl.ps1` is gone. The step is one script held in install.ps1's memory (`$TalosEnableWslScript`) and passed as
    `-EncodedCommand`, with the pin in its own text. Once elevated, no file is read and nothing is dot-sourced.
  - It refuses with exit 2 unless it is elevated.
  - It makes a new `%ProgramData%\Talos-setup-<guid>` with its ACL set as it is created: Administrators and SYSTEM full,
    Users read, nothing inherited.
  - It copies the msi in, hashing the very bytes it writes; a copy that does not match the pin is deleted and refused.
  - msiexec installs THAT copy; dism follows. Both run by full path, and the log stays in that folder.
- R1-2 (high): `signin.py` took a link or a token as soon as its pattern matched in the bytes read so far, so a token split
  across two pty reads was stored cut short and reported as signed in. Now:
  - A link counts only once whitespace follows it.
  - A token counts only alone on a line that has ended, or once Claude Code's output ends.
  - The token's whole shape is checked before it is written (`sk-ant-oat<nn>-` and at least 80 characters).
  - windows-distro.test.ts runs the real signin.py against a stand-in claude that writes in pieces: split link and token,
    a token that ends the output, a token cut short (never stored), and the failures.
- R1-3 (high): Setup took the relay key, the steps and the failure text from any line install.ps1's output carried, the
  talos-owned toolchain's included, so the agent could make Setup show and save its own key. Now:
  - Setup's window reads only `%LOCALAPPDATA%\Talos\setup-status.txt`, which only install.ps1 writes (`-StatusFile`, lines
    `<kind><TAB><text>`). The distro cannot write a Windows file: interop and automount are off.
  - All other output goes to the log only.
  - The key comes from root: `talos-wsl.sh relay-key` reads `bridge.key` as talos. The key the first install saw is kept
    by root in `/etc/talos/relay-pubkey` (root-owned, 0644, in a root-owned 0755 folder), and that is the one shown.
  - A reinstall never replaces the kept key. If `bridge.key` no longer matches it, Setup says so plainly.
  - `bridge.key` itself is talos's (0600, and the bridge runs as talos), so the agent can read and replace it; the kept key
    is what makes that visible.
- R1-4 (medium): the virtualization help and the reason the distro was not made never reached the window. They are now
  `detail` and `failed` lines, and the window shows them. Pester tests what the window would show
  (`Get-TalosSetupView`), not the strings.
- R1-5 (medium): Setup is now one at a time (`Local\TalosSetup`); a second one says so and leaves. Cancel stops
  install.ps1's whole process tree (its wsl.exe calls too). Then, if the Talos distro is running and is one Talos made, it
  gives the interop entry back and stops it. A stopped distro is never started just to check it.
- R1-6 (medium): IExpress starts Windows PowerShell by its full path, and the guide says to run Setup from a folder of its
  own.
- R1-7 (low): the bundle's SHA-256 is described as what it is: a corruption check, since payload.json sits beside it. The
  trust is in the Setup.exe she downloaded.
- R1-8 (low): sign-in failures are fixed plain sentences (a code not accepted, a code expired, anything else). None of
  Claude Code's own text is passed on.
- Still open, for the owner's clean-PC run: whether `wsl.exe --status` on a PC with no WSL waits for a key, and WSL's own
  binfmt line (does it carry the F flag?). On Titan the entry was re-registered with WSL's systemd drop-in's line, so
  WSL's first registration could not be read here.
- Checked live on Titan, with a throwaway distro installed from Setup's payload with these scripts:
  - the status file held only install.ps1's own lines, among them `relay-key` from root;
  - `/etc/talos` was root 0755 and `relay-pubkey` root 0644;
  - with `bridge.key` swapped by talos, `relay-key` still printed the install's key, followed by `changed`;
  - talos could not write in `/etc/talos`;
  - `Get-TalosSetupView` on that real file gave the done page with the key;
  - uninstall left nothing, and Ubuntu's interop entry was still there.

**Fable's round 2 on 3bd474e0 and c9a60023 (the tray's round 1, and the launch approval), and what changed.** R1-1 to
R1-6 on the tray were confirmed fixed. The new findings are all on the launch approval:

- R2-1 (blocker): every install took launch-check's fingerprint and passed it straight to launch-approve. So a re-run of
  Setup approved whatever supervisor.json said, the agent's own rewrite included, with nothing shown to anyone. Now
  install.ps1 ran only `launch-approve-first`, which approved when there was no approval file at all. Round 3 found that
  is not enough (R3-2, below): `approve-install` replaced it.
- R2-3 (serious): root's defaults differed from the supervisor's. The fix is one strict rule on both sides, with no
  defaults (Hestia's `approvableLaunch`, d3eaec7b):
  - agent_dir and claude_path are absolute strings; args is present and a list of strings; env is absent ({}) or an
    object of strings;
  - every string is valid text;
  - claude_path equals its own real path (root checks it as talos: `runuser -u talos -- realpath -e`; setup-user.sh
    writes the pinned version's real path).
  - Anything else is not approvable, before any hash. Hestia's shared vectors mark each case `approvable` (on her branch,
    d3eaec7b); the copy here marks the cases it has, and her file replaces it when it lands.
- R2-2 (serious, a design limit):
  - Agreed with Hestia: session.id and auto_confirm_restart stay out of the hash. The supervisor rewrites session.id on
    every new session (cold start, /clear, /resume), so hashing it would void the approval each time, and a no-terminal
    install would then wait at dev_channels. auto_confirm_restart=false already means no answers.
  - What could not be made root-owned, and why:
    - the Claude Code binary: `claude install` and its updates write under ~/.local/share/claude. A pinned update is a
      new real path, so it is approved again in the tray.
    - the checkout (~/talos-app) and the plugin folder in it: pnpm, bun and the kit's updates run as talos. A root copy
      of the plugin would need root on every kit update, or Main runs an old mod.
    - the supervisor's unit: systemd's user manager prefers ~/.config/systemd/user over /etc/systemd/user, so a
      root-owned copy would buy nothing; talos can always shadow it. Only running the supervisor as a system unit (as
      talos) would close that, and that is a bigger change.
  - **The limit, plainly:** the approval catches a changed launch config (the program's path, the folder, the flags,
    the environment). It is not a wall against an agent that can rewrite its own files: the agent runs as talos, and
    talos owns the program those paths name, the plugin and the supervisor's unit.
- R2-4 (serious): a fresh install could end unapproved, with no way in the tray to approve it. The tray got "Approve this
  change". How a fresh install ends approved is round 3's R3-2.
- R2-5 (serious): the tests only matched source text. windows-distro.test.ts now runs check, approve, approve-install and
  relay-key for real, in a test root (TALOS_LAUNCH_TEST_ROOT; never set by the tray, which runs this as root with root's
  own environment). Covered:
  - the first approval only once;
  - approve storing its own fingerprint;
  - a claude_path that is a link;
  - an approval file that is a link, empty, not JSON, not an object, over 4 KB, or group-writable;
  - a FIFO at supervisor.json;
  - a group-writable /etc/talos;
  - relay-key kept and `changed`.
  - Not covered: an approval owned by someone else, since a test cannot chown without root.
- R2-6 (minor): a non-object, a lone surrogate and a FIFO now end in a plain "not approvable" or no answer, never a
  traceback or a hang. `first` means no approval file at all.
- R2-7 (minor): the tray's status poll reads line by line, so an `isolated=` line written before a stall survives the 8 s
  kill.

**Fable's round 2 on ebad65d5 (Setup), and what changed.** R1-1 to R1-8 were confirmed fixed as scoped.

- R2-1 (blocker): setup-ui.ps1 dot-sources TalosWin.ps1 from its own folder, but Setup.exe did not carry it, so a first
  double-click died before any window. Now one list, `$TalosSetupPackFiles` in TalosWin.ps1 (setup-ui.ps1, TalosWin.ps1,
  talos-setup.zip), is what build.ps1 packs. A Pester test starts setup-ui.ps1 `-CheckOnly` from exactly those files (exit
  0), and again without TalosWin.ps1 (it fails), so the test is real.
- R2-2 (serious): the elevated script took %ProgramData% and %SystemRoot% from her environment, which an elevated process
  inherits from HKCU\Environment, and it autoloaded cmdlets through her PSModulePath. Now:
  - its first line pins PSModulePath to Windows' own modules folder;
  - its folders come from `[Environment]::GetFolderPath('CommonApplicationData')` and `[Environment]::SystemDirectory`;
  - it calls only .NET, with no cmdlet at all (a Pester test parses it: only its own `Say` and `Run`);
  - its new folder's owner is set to Administrators at creation.
  - Not checked live, since Titan's session is not elevated: whether HKCU\Environment really reaches the elevated process
    (it is documented to). Either way, nothing in the script reads the environment any more.
  - **The limit, plainly:** before her "Yes", anything running as her can rewrite the files that build the command
    (setup-ui.ps1, install.ps1, TalosWin.ps1 in her own folders). The UAC prompt shows Windows PowerShell, not what it
    will run. Only a signed elevated program would close that, and Talos is not signed (the owner's decision). What this
    closes is everything after the "Yes": the script, the pin and the msi copy it installs can no longer be swapped.
- R2-3 (serious): on a standard account the "Yes" is another administrator's, and the elevated step running as that
  account could not read the msi (the folder was hers and SYSTEM's only). Administrators may now read Setup's folder.
- R2-4 (minor): a FIFO at bridge.key now reads as no key (a 5 s limit, caught), and install.ps1 says plainly when no relay
  key could be read, instead of a silent "set up".
- R2-5 (minor): PowerShell also ends a single-quoted string at the typographic quotes U+2018 to U+201B, so all of them in
  the msi's path are doubled. A Pester test parses the result for each one.
- Also looked at, as asked:
  - setup-ui.ps1 no longer waits without limit for install.ps1's output once it has ended (3 s and 1 s);
  - the body is a read-only text box that scrolls, so a long failure never clips;
  - the -EncodedCommand is about 8.6K characters, well under the 32K a Windows command line holds. It ran unelevated here
    (exit 2, as it should); through runas only on the clean PC.
- **WSL's interop entry, timed live on Titan (2026-11-12):**
  - The removal comes at an interop-off distro's START, about 0.6 s in, before the first command in it returns. A plain
    stop removes nothing.
  - talos-ci's restore unit has it back about 0.5 s later. Talos's own boot unit does the same.
  - While Talos runs, every status poll (30 s) and hold check (60 s) also gives it back, so another interop-off distro's
    start costs the owner's distros at most about 30 s.
  - One uninstall in a live run still left it gone, and that could not be pinned down here. If Windows programs stop
    working in another distro after Talos is removed, `wsl --shutdown` brings them back.

**Fable's check 3 on a44344c2 (the launch approval), and what changed.** Setup's round 2 was confirmed fixed; Setup waits
only on the clean PC.

- R3-1 (true at this commit): **nothing on main enforces the approval yet.** The supervisor's side (Hestia's
  `launch-approval.ts`) is on her branch main-first-start. Until it lands, a launch is not checked against
  /etc/talos/launch-approved at all. The lines above that said otherwise are corrected, and the vectors test reads
  `approvable` from the fixture only.
- R3-2 (blocker): `approve-first` still approved whatever supervisor.json said whenever no approval file existed, and "no
  file" does not prove the agent has not run: a fresh install's first approval used to fail, after which the agent could
  write its own launch. Now:
  - `approve-install` approves only a launch root works out itself from root-only inputs (`install_defaults`: talos's home,
    and the Claude Code version pinned in root's own /opt/talos-wsl/setup-user.sh, which must be root's and not writable by
    others);
  - only in the install run that creates the distro, before setup-user.sh writes supervisor.json and starts the
    supervisor;
  - and only while there is no approval yet AND talos has no supervisor.json yet (so the supervisor, and the agent, have
    never run).
  - setup-user.sh writes exactly that launch, claude_path being the pinned version's real path. A match is approved;
    anything else waits for the tray. Any later run, a distro from before approvals, or a run stopped half way approves
    nothing.
  - Agreed with Hestia, who dropped her own setup-user.sh change: this commit owns it.
- R3-3 (serious): the approve window printed values the agent controls, raw and uncapped. Now root works out the lines the
  window shows (`launch.py display`), in ASCII only:
  - added and removed arguments first, then the whole launch, one argument a line, each quoted (`"--a b"` is not `"--a"`
    `"b"`, and an empty one shows as `""`);
  - every control, format (bidi, zero-width) or separator character written out (`\u202e`, `\n`);
  - no Approve when a value has such a character, a value is over 400 characters, or the whole is over 6000; the window
    then says it cannot be approved here.
  - The tray shows root's lines as they are.
- R3-4 (Hestia's): session.id and previous_ids reach Claude's argv, so both sides refuse any value but a lowercase UUID
  (still not hashed).
- R3-5 (serious): whether the tray offered "Approve this change" came from talos's own run/main-state. Now it comes from
  root: `status` ends in `launch=<approved|pending|unapprovable|none>` (`launch.py state`), and the item shows only for
  `pending`. The window says what approving means: from now on Claude in Talos starts with exactly these settings,
  without asking again.
- R3-6 (minor): status gives WSL's interop entry back only while the distro is cut off from Windows.
- **WSL's interop entry, the cause found (live on Titan):** WSL writes its systemd-binfmt override only in a distro with
  interop on. In Talos's distro, and in talos-ci, the stock unit runs `systemd-binfmt --unregister` at shutdown, which
  clears every binfmt entry in the VM, WSL's included. That is what an uninstall's `wsl --terminate` did. Now:
  - root-setup writes a drop-in (`/etc/systemd/system/systemd-binfmt.service.d/talos.conf`) with an empty `ExecStop=`, so
    nothing is unregistered at shutdown. Its start gives the entry back instead (`give-back-interop`). talos-ci has the
    same drop-in (docs/CI-MACHINES.md).
  - uninstall.ps1 ends by checking the entry and giving it back if it is gone (`Restore-TalosWslInterop`), through WSL's
    own system distro (`wsl --system`). That runs in the same VM, touches none of the owner's distros and starts none.
    Checked live: it put back a removed entry, run as an ordinary user, and Ubuntu's cmd.exe ran again. `wsl --shutdown`
    is now the fallback uninstall names only if that check fails.

**Fable's check 4 on f1699c11 (the launch approval), and what changed.** R3-1, R3-2, R3-5 and R3-6 were confirmed fixed.

- R4-1 (serious): the agent could forge the approve window. claude_path pointed through a link to folders whose names held
  a newline and a forged check document; `realpath` printed it, launch.py wrote it to stderr, the tray merged stderr into
  stdout and trusted the last line starting with `{`. Three layers now:
  - **Nothing talos controls is printed raw.** launch.py's messages are fixed sentences: the path is no longer named, and
    `die` writes one escaped ASCII line whatever it is given. Its JSON is ASCII, one line.
  - **The Windows side reads root's stdout only**, never stderr, and exactly one JSON document: two lines starting with
    `{` are no answer at all. That covers the tray's `Invoke-TalosRoot`, and install.ps1's `WslStdout` for relay-key and
    approve-install.
  - **approve refuses** a launch whose own display (worked out again from what it just read) is not safe to show, whatever
    the window that asked was shown.
- Every other place talos-controlled text reaches what Windows parses, checked:
  - status: each line is root's own, and talos's answers (systemctl, main-state, launch state) pass only as fixed words.
    The tray reads stdout only.
  - relay-key: the key passes only as 43 base64url characters; `changed` and the messages are fixed.
  - signin.py: only JSON it builds, with fixed messages. Its stdout carries nothing of Claude Code's (that is in its pty).
    The link it passes is now printable ASCII only, with no quote or angle bracket (a U+202E link is refused), and the tray
    checks the same.
  - pair.py: only events it rebuilds, written as ASCII JSON. The phone's name is cleaned by Unicode category (control,
    format, separator, private, unassigned); words, ids and links are checked with fullmatch. The window shows none of
    enroll's own text, only fixed sentences and the error's code.
  - Setup's window: install.ps1's own status file only.
- My own pass as talos, now tests in windows-distro.test.ts:
  - Fable's forged folder names. check, approve and state print no forged document on stdout or stderr, and state says
    `unapprovable`.
  - A forged JSON line inside an argument and inside an env key: one ASCII line out, and display_ok false.
  - approve with the right fingerprint for a launch that cannot be shown in full: refused.
  - A session id with a trailing newline: refused.
  - A device name with a newline and a forged event: cleaned to one line.
  - A sign-in link with U+202E, a quote, or a look-alike domain: refused.
- R4-2: the run sheet's step 15 says the item must NOT be there on a new install. If it is, he photographs it, clicks Not
  now and reports. A new step (17a) changes one flag on purpose, with the exact command, so he sees the real window once and
  knows what it should say.
- R4-3: "Pair a phone" lands in the same commit, so the run sheet's steps 13, 16 and 17 can be run.
- R4-4: session ids, and pair.py's words, ids and links, are checked with fullmatch (`$` also matched before a trailing
  newline). Hestia adds the vector to the shared fixture.
- R4-5: setup-user.sh writes supervisor.json with `launch.py install-defaults`, the very function `approve-install`
  approves. A test checks they are equal, and that setup-user.sh has no launch flags of its own.
- R4-6: a first approval is not called a change. The tray says why Talos waits: settings it cannot approve, not set up
  yet, or it could not check.

**Fable's check 5 on 5fc143ef: the launch approval passed** (R4-1 to R4-6 fixed; the reviewer walked every wsl.exe channel
and found no line the agent can win). It waits only on the clean PC.

**Fable's round 1 on "Pair a phone" (5fc143ef), and what changed.**

- R5-1 (serious): any https link was accepted, and the QR code was drawn by talos's own bun and uqr, so the agent could
  show a good-looking link beside its own QR code. Now:
  - root keeps the install's relay URL (`talos-wsl.sh relay-set`, which install.ps1 runs from Setup's payload or
    -RelayUrl, in `/etc/talos/relay`), and never reads it from talos's bridge config;
  - pair.py passes a link only when it is exactly `<that URL>/enroll#<26 Crockford base32 characters>`; anything else ends
    with `error link` and no QR code (another host, a login hiding the host, anything after the code);
  - the QR code is drawn by root, inside pair.py, from the checked link (QR Model 2, byte mode, level M, versions 1 to
    10). It is checked against the bridge's own uqr: all 88 matrices for versions 1 to 10 and all 8 masks are identical, and
    a test checks the live link's code against uqr;
  - the window shows "Relay: <host>" on a line of its own.
- R5-2 (serious), **the limit, plainly**: the four words and "pinned" are the bridge's, and the bridge runs as talos. The
  window guards against a network or relay-side attacker with an honest bridge, not against the agent itself. The run
  sheet says so, and that the words matching on both screens is the real check. Within that limit:
  - pair.py and the window both refuse to call anything "Paired" unless a `confirm` came first and the person answered
    yes;
  - a second `confirm` is never asked again.
- R5-3 (serious): enroll runs in a pty and a session of its own. Ending it is TERM to its whole group, then KILL after 3 s,
  with every wait bounded. pair.py watches stdin all along, so the window closing ends the pairing (an open question is
  answered no). signin.py ends Claude Code's session the same way, and the tray stops whole process trees (taskkill /T).
- R5-4 (serious), new tests:
  - windows-distro.test.ts, Linux-only:
    - a foreign host, a login-hidden host, a suffix after the code, and a short code are each refused;
    - the QR code is uqr's;
    - one question only;
    - `pinned` with no yes is refused;
    - only an exact `y` is yes;
    - an enroll that ignores SIGTERM is killed with its group, leaving nothing;
    - a line over the limit is skipped;
    - a forged event inside the device name stays one cleaned line;
    - with no relay of root's own, pairing does not start.
  - Pester: the 1.5 s arming, answer-once, closing answers no, and "Paired" only after yes. These are pure functions the
    window uses.
- R5-5 (minor): the TALOS_PAIR_* and TALOS_SIGNIN_* test names are ignored when running as root.
- R5-6 (minor): run sheet step 17a writes through a temp file and a rename, and puts `--verbose` back afterwards, with a
  second approval.
- Also: the device-name label shows `&` as itself (UseMnemonic off).
- Not checked here: a real phone pairing (run sheet step 16).

**Fable's round 2 on "Pair a phone" (fb7a8206), and what changed.** The link check, the relay file, relay-set's
validation and the QR encoder (read against ISO 18004) held.

- R6-1 (blocker): install.ps1 ran `relay-set` before launch.py was in the distro. launch.py is put in place first now, and
  a test checks every root verb comes after its file. Found by review, not by my own run: from now on, every Windows push
  that touches install.ps1 or a root verb names a fresh-install run as evidence (Pantheon, 2026-11-12).
- R6-2: ending enroll KILLs its whole group for as long as any member is left, whatever the leader did.
- R6-3: one relay URL rule for Setup's payload, -RelayUrl, relay-set and pair.py (Test-TalosRelayUrl, kept equal by a
  test). A URL it refuses fails at the start; a relay-set refusal stops the install.
- R6-4, R6-5: no variable shadowing in the window; every end state ends the pairing, and nothing after it is shown.
- enroll's 500 ms typed-ahead rule (Delphi's question): pair.py holds a `y` until 600 ms after the question. A stand-in
  that enforces the rule proves it.
- New root verbs for the tray: `restart` (the user manager, then the supervisor as talos) and `restore` (`talos-app
  restore-last-good --yes --newest-start` as talos, then restart). Only while cut off from Windows, no input, fixed words
  out.

**Fable's review of restart and restore (9612c7d7), and what changed (bbdcdd36).** Fable passed both verbs, with
follow-ups.

- R7-1: `restart` and `restore` refuse with `not-approved` unless root's own launch state says approved. After a
  restore, the tray says what came back: .mcp.json and Claude Code's settings.
- R7-2, R7-4: closing the window stops its whole process tree. restore has one group time limit over the whole pipeline
  and runs talos-app under `env -i` with HOME, USER, LOGNAME and PATH only.
- R7-3: one relay URL normalisation on every side: trailing slashes are dropped, and the scheme and host are lowercased.
  Then the one rule decides.
- R7-5: pair.py reaps enroll's leader only after its group is empty, so the group's number cannot be reused under KILL.
- Pantheon on bbdcdd36: the TALOS_WSL_* test names in talos-wsl.sh are dropped when it runs as root, as are
  TALOS_LAUNCH_TEST_ROOT in launch.py and R5-5's names in pair.py and signin.py. A test checks that every name the
  script reads is on its list.

**Fable's review of restart and restore (9612c7d7), and what changed (bbdcdd36).** Fable passed both verbs, with
follow-ups.

- R7-1: `restart` and `restore` refuse with `not-approved` unless root's own launch state says approved. After a
  restore, the tray says what came back: .mcp.json and Claude Code's settings.
- R7-2, R7-4: closing the window stops its whole process tree. restore has one group time limit over the whole pipeline
  and runs talos-app under `env -i` with HOME, USER, LOGNAME and PATH only.
- R7-3: one relay URL normalisation on every side: trailing slashes are dropped, and the scheme and host are lowercased.
  Then the one rule decides.
- R7-5: pair.py reaps enroll's leader only after its group is empty, so the group's number cannot be reused under KILL.
- Pantheon on bbdcdd36: the TALOS_WSL_* test names in talos-wsl.sh are dropped when it runs as root, as are
  TALOS_LAUNCH_TEST_ROOT in launch.py and R5-5's names in pair.py and signin.py. A test checks that every name the
  script reads is on its list.
- Pairing only with a live bridge (Pantheon, 2026-11-12, after Cyclops asked): "Pair a phone..." is greyed until the
  dot is green, saying "Sign in to Claude first" while Main waits on a sign-in. pair.py ends enroll at its
  `bridge_not_live` warning with `error not-ready`, before any link or QR. That is stricter than docs/bridge.md ("show
  the text and go on"), because a phone that enrolled with no bridge would be left half-enrolled.
- The tray's dot is green only for main=running (Pantheon, 2026-11-12). main=unknown, which is what a supervisor that
  writes no run/main-state gives, is amber: "Talos is up; Claude's state isn't known yet". So is main=starting, and so is
  main=stopped. Until Hestia's main-first-start is on main, the dot is never green on Windows, and pairing is never
  offered. That is the order.
- **Hard rule for the owner's clean-PC run (Pantheon, 2026-11-12).** Setup's payload pins ONE main commit, at or after
  both Hestia's main-first-start landing and Titan's latest Windows commit. The run sheet names it with its sha, and
  Setup shows it in full on its last screen (and on a failure): `Installed: Talos <version>, commit <sha>`, from a
  `release` status line install.ps1 writes. Before "ready", Titan rebuilds the payload on that commit and runs a fresh
  install end to end with that commit's own talos-app. That run includes restore.
  Why: Titan's test payload had pinned 508d3080, a local wip commit with no `enroll --json`, so every earlier fresh
  install there ran an old talos-app. The root-helper checks still held, because those scripts were copied from the
  branch. The talos-app side, restore included, did not.


**Step 3: Main's first start with nobody at the pane** (the Linux side; the tray's root side is Titan's). A fresh Claude Code
shows screens before its input box, and a Windows install has no terminal to answer them in. The supervisor answers only
the ones that are Talos's own (`apps/bridge/src/supervisor/first-start.ts`, on real 2.1.322 captures in
`apps/desktop/Tests/Fixtures/real-first-start-2.1.322`):

| Screen                                             | What the supervisor does                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Theme picker                                       | Enter on the default                                                                                                                                                                                                                                                                                                                                                       |
| Security notes (shown when a token is set)         | Enter, only on the exact screen: the `Security notes:` heading, `Press Enter to continue…` as the last row, no cursor, nothing with `?` or about terms, permissions, accepting, agreeing or consent. Anything else waits for the owner. Its text goes to `run/first-start-notes` for Setup and the owner (a notice meant for a person is never hidden, only not waited on) |
| Folder trust                                       | "Yes, I trust this folder" only for supervisor.json's `agent_dir`, shown exactly on screen and holding `.talos-version`                                                                                                                                                                                                                                                    |
| MCP consent                                        | "Use this MCP server" only when the one new server is exactly `talos-app`                                                                                                                                                                                                                                                                                                  |
| Development-channels warning                       | Enter only under the auto-confirm guard (`decideAutoConfirm`: exactly `server:talos-app` on screen and in argv, within 60 s of the spawn)                                                                                                                                                                                                                                  |
| Login method, OAuth URL, a refused token           | never: `main=signin`                                                                                                                                                                                                                                                                                                                                                       |
| API-key question, bypass warning, anything unknown | never: `main=waiting:<kind>`                                                                                                                                                                                                                                                                                                                                               |
- **Rules for every answer.** Nothing is pressed while anyone is attached to the pane, or when tmux cannot say. Each kind gets
  one Enter per start, at most 4 arrow keys, and one key a tick, so the screen is read again before the next key. Every key
  is audited (`first_start_key`), and so is every wait (`first_start_waiting`, once per kind).
- **The approval.** Trust, MCP consent and the warning are answered only when root approved this launch:
  `/etc/talos/launch-approved` (root:root 0644, in a root-owned 0755 folder; its ownership is the seal) names the fingerprint
  of supervisor.json as written (`launch-approval.ts`, the Mac's length-prefixed SHA-256; vectors in
  `packages/protocol/fixtures/launch-fingerprint.json`, the tray's `launch.py` held to the same file; env keys in UTF-8 byte
  order). It is read once per start. Both sides hold supervisor.json to one strict schema, with no defaults: `agent_dir` and
  `claude_path` absolute, `claude_path` its own real path (setup writes the pinned version's, not `~/.local/bin/claude`'s
  link), `args` a list of strings that must be there, `env` an object of strings or absent. Anything else is never
  approvable, and the file must still match the settings the start used. The session id and `auto_confirm_restart` are not
  in the fingerprint: the supervisor rewrites the id at every new session (the Mac leaves the resume id out too). A missing,
  empty or malformed approval file, a link, or one not root's is "not approved". The owner's `auto_confirm_restart: false` turns every answer but the theme and the notes off.
- **The token.** The tray writes `$TALOS_APP_HOME/claude-oauth-token` (0600, one line). The supervisor reads it at every start
  (never through a link, at most 4 KB, this user's) and gives it to Main and the thread sessions as `CLAUDE_CODE_OAUTH_TOKEN`.
  It is never logged; reports already redact it (`redact`). With a token set, Claude Code shows no login at all. A refused
  token shows only as the 401 answer row (`● Please run /login · API Error: 401 …`), which reads as `main=signin`, never a
  restart loop. A new token while Main is signed out, or stopped by a failed start, starts it again.
- **The state.** `$TALOS_APP_HOME/run/main-state`: one line (`main=running|starting|stopped|signin|waiting:<kind>`), with a
  200-character cleaned, redacted excerpt of the screen on a second line for `waiting:unknown`.
- **Keys and screens.** A key goes only to a screen read the same twice in a row, and never to the screen the last key went
  to (a redraw that lags never takes a second arrow; a screen that stays put after a key is reported waiting after 5 ticks).
  Who is attached is read again right before each key, so an owner who just attached gets the screen untouched. The security notes get their
  Enter only once their text is saved.
- **Main's environment and the token (Fable on d3eaec7b, Pantheon's call).** Main takes from the login shell only a fixed
  list of names (`MAIN_LOGIN_ENV`: PATH, HOME, USER, LOGNAME, SHELL, LANG, LANGUAGE, LC_*, TZ, TMPDIR, XDG_RUNTIME_DIR,
  XDG_CACHE_HOME, DBUS_SESSION_BUS_ADDRESS, SSH_AUTH_SOCK), so `~/.profile` cannot add ANTHROPIC_BASE_URL or anything else
  to a launch that is auto-confirmed. Whatever else Main needs goes in supervisor.json's `env`, which the approval covers. The
  token is never written into the tmux launch file: the supervisor names the token's file, and the launch script reads it
  into CLAUDE_CODE_OAUTH_TOKEN as the pane starts (a plain file, never a link).
- **Recorded limits, with owners.**
  - PATH still comes from the login shell, which talos writes. It decides which tools Main's own commands find, not which
    program is launched: claude is launched by its approved absolute path. HOME, SHELL and TMPDIR from the login shell are
    the same class (Claude Code's config folder, the shell its Bash tool runs).
  - The list closes the profile route only: `~/.claude/settings.json`'s `env` is the same user's to write and reaches Claude
    Code just as well (ANTHROPIC_BASE_URL included). That goes with the root-owned binary work too.
  - supervisor.json's `env` may not name CLAUDE_CODE_OAUTH_TOKEN or TALOS_APP_OAUTH_TOKEN_FILE: the settings are refused, so
    the token only ever comes from the tray's file.
  - After an owner signs in at the pane with `/login`, a 401 answer row still on screen keeps `main=signin` until Claude
    Code's next answer replaces it. A new token from the tray then restarts Main once (the same token is never tried twice).
  - A refused token is read from the screen: Claude Code's `● Please run /login · API Error: 401` row, when it is Main's latest
    answer and its input box is up, at any time (an expiry mid-session is reported, never silent). A model reply that writes
    those exact words reads the same. That costs an amber tray until the next answer; Main is restarted only on a new token
    from the tray (once per token, never while someone is attached).
  - Two consequences of that, known and accepted (Fable round 3): a new token the tray wrote and has not yet been used can be
    spent by one later forged 401 row, on one quiet restart of a Main that was working; and `first_start_signin` is written
    once per start, so a real refusal after a forged one shows in main-state (and the tray) but not again in the log.
  - Unverified: a really revoked token. `main=signin` for a refused token rests on the one 401 row captured with a fake token
    and a local stand-in (`● Please run /login · API Error: 401 …`). No real sign-in is made on a build machine, so a real
    revoked token's row has not been seen. If it draws differently, Main reads `running`. It is on the clean-PC run sheet as
    a later optional step (Titan).
  - The token sits in `/proc/<pid>/environ` of Main and each thread session, readable by the same user. That is accepted.
  - The thread session's permission hook never gets it: the hook's command runs under `env -i` with a fixed list
    (`HOOK_PASS_ENV` in worker-spec.ts), which does not name it, and worker-hook.test.ts checks that nothing beyond that list
    reaches the hook. Main's own kit hooks and any tool a session runs do inherit it (the same-user limit above).
  - The fingerprint names the program, folder, flags and `env`, not their contents. The `claude` file, the `--plugin-dir`
    folder and the agent folder's `.mcp.json` are talos's to write, and MCP consent checks only the name `talos-app`. Plan:
    root owns the claude binary and the plugin folder, in `/opt` through a root verb, as part of the sealed-kit tier 1 work
    (Titan's root side, Hestia's supervisor side). The `.mcp.json` talos-app command is pinned in the same piece.
  - `auto_confirm_restart` is not hashed: the agent can turn the owner's `false` back on, though only an approved launch is
    ever answered.
- **The kit a thread session's hook runs, kept by root (Fable R1-2, tier 1).** On a Talos distro (root's marker
  `/etc/talos-wsl/marker`, written at every install; never `/etc/talos` alone, which is made only when a launch is first
  approved and which a plain Linux owner may make too; a `/etc/talos-wsl` that is there without root's marker, or is not
  root's, is refused, never read as "no Talos distro"), the supervisor takes the permission hook only from
  `/opt/talos-app/kit` (`current` -> `releases/<version>`), every path root's and every folder from it up to `/` root's,
  and checks the release's content digest against `/etc/talos/kit-release` (root:root 0644, at most 4 KB,
  `{"v":1,"version","content_sha256"}`): root's own record, never the copy's. No record, a mismatch, anything not root's or a
  link: the thread session's start is refused, "open Talos in the tray and choose Update the kit". There is no fallback to the
  talos user's own kit there (`apps/bridge/src/supervisor/rooted-kit.ts`). The session runs root's file where it is, by its
  real path under `releases/<version>`; no copy is made in the Talos home, and the start's last check (validateSpec) refuses a
  settings file whose permission hook is anything else. A box without the marker is unchanged (it copies, as before). Root's side
  (built, `apps/windows/distro/kit.py`): `talos-wsl.sh kit-update` copies the release talos built, works the digest out itself
  over root's copy and writes the record; it is reachable only from the Windows side (`wsl.exe -u root` from the tray's
  "Update the kit" or from Setup), which holds because interop is off in the distro: no sudo or polkit rule, unit, socket or
  watched path names it, and it refuses with SUDO_USER, SUDO_UID, PKEXEC_UID or DOAS_USER set (`scripts/kit-update.test.ts`).
  "Interop off" is `talos-wsl.sh isolation` (wsl.conf's, applied at this start), checked when it starts and again right before
  it puts a release in place and before the record: NOT the absence of the `WSLInterop` binfmt entry, which is one entry for
  the whole VM that this distro registers again at boot for the owner's other distros (WSL serves no Windows program here
  whatever it says). It reads talos's release folder by folder with O_NOFOLLOW from `~/.local/share/talos/kit/current`
  (relative, `releases/<version>`, as plugin-release.py writes it), takes plain files and folders by content only, and refuses
  the whole update for a link, FIFO, socket or device, a file that is not talos's own or has a second name (a hard link),
  more than 20,000 files and folders, 64 MB or 40 levels, or a name that is not UTF-8. The order: drop any staging folder a
  stopped run left, copy into `releases/.staging-<random>`, digest, rename into place, seal, check the digest again, the
  marketplace manifest, the record, then `current` (an atomic rename), then the policy, then the pruning, which runs only
  when the version changed, and not at all when there are more than 10,000 worker folders to read (a release is never pruned
  on a partial list). A hard link to a kit file anywhere in talos's home (a backup made with `cp -al`) blocks the update
  (`kit-bad-release`) until it is gone: root cannot tell such a file from one talos could not read. A version already installed with other content is refused (`kit-version-taken`), never
  overwritten; the same content left unsealed by a stopped run is sealed again. A policy file Talos did not write, or any
  drop-in, or a drop-in folder that is not root's own, is refused before anything is copied (`kit-policy-foreign`), never
  changed; a policy an earlier Talos wrote (kit.py `PREVIOUS_POLICIES`, by SHA-256: the first A' bytes, `837baefd…`) is
  replaced with today's, so a policy change never strands an installed PC. Its stdout is one fixed word for the tray. Setup
  runs it after setup-user.sh builds the kit (`--no-start`) and before the supervisor's first start (`--only-start`); a
  refusal stops Setup with the tray's words. What the policy kit-update writes does NOT touch: Main's approved launch passes
  `--plugin-dir ~/talos-app/plugins/talos-app-mod`, a folder the talos user writes, and `--plugin-dir` loads past
  strictKnownMarketplaces (measured, 2.1.322 and 2.1.323; Claude Code's `disableSideloadFlags` closes it, but every worker
  starts with `--mcp-config`, which it also refuses). Proposal for later, not built: root owns that folder (copied in by
  kit-update like the kit), or the flag goes and talos-app-mod becomes a second plugin of root's marketplace. Modes, all root:root: `/opt/talos-app`, `/opt/talos-app/kit` and
  `kit/releases` 0755 (and every folder up to `/` not group- or other-writable); inside `releases/<version>` every folder 0555
  and every file 0444 or 0555. The supervisor refuses any write bit on the release folder, its talos-kit and hooks folders and
  the hook and its helper, the owner's included (root writes regardless), and the digest's "x" flag is "can the reader execute
  it", so nothing in between. A release holds no `__pycache__` and no `.pyc` anywhere: the hook runs in place and Python would
  prefer a cached helper the digest leaves out, so kit-update drops them on copy and the supervisor refuses a release with any. Both sides are held to
  `packages/protocol/fixtures/kit-content-sha.json` (names by code point, as Python sorts them).
- **What a rooted session's settings may hold.** The start's last check (validateSpec) rebuilds the hook's whole command from
  root's file and the supervisor's own values and compares it exactly: one PermissionRequest entry with that one command, and no
  other hook event at all. The top-level keys are exactly the ones the supervisor writes (enabledPlugins, env, pluginConfigs,
  effortLevel, disableClaudeAiConnectors, deniedMcpServers, hooks, permissions, disableSkillShellExecution = true, and the
  status line, compared whole with the usage recorder's command). Permissions only narrow (deny, ask, the mode the supervisor
  set from Main's, auto mode off); allow or more folders are refused. The guards file (`talos-app install-guards`) is the talos
  user's: its PreToolUse hook can answer "allow", and its defaultMode also sets Main's ceiling. On a Talos distro a guards
  file that is there at all refuses the start, naming the file; it is never dropped quietly (the owner opted into it) and
  never read. Setup does not install guards there. The
  hook is told it is rooted (`TALOS_APP_HOOK_ROOTED=1`, in the command) and then reads no folder-check cache from the talos home.
- **An update while sessions run.** A running session's settings name `releases/<version>/` directly. kit-update never removes
  a release that any `$TALOS_HOME/workers/*/settings.json` names; it reads those files only as a list of release names to keep,
  so a forged name can only keep a folder, never remove or add one. Beyond that it keeps current and previous. If root's hook
  file is gone all the same, the prompt is denied with words ("Talos's kit was updated while this thread's session was running
  ... restart the thread's session"), never left at a terminal the Windows user does not have (`HOOK_CLEAN_LINE_ROOTED`; the
  home copy still exits quietly, as on the Mac). Restarting thread sessions when the kit changes is not done yet.
- **Root's Claude Code policy (A', built).** kit-update also writes `/etc/claude-code/managed-settings.json` (root:root 0644,
  in a root 0755 folder), exactly the bytes of `packages/protocol/fixtures/managed-settings.json`:
  `{"strictKnownMarketplaces":[{"source":"directory","path":"/opt/talos-app/kit"}],"extraKnownMarketplaces":{"talos-local":{"source":{"source":"directory","path":"/opt/talos-app/kit"}}}}` and a newline: the allowlist, and talos-local itself declared, so Claude Code rewrites the talos user's own record of it
  at every start. Claude Code then loads no
  marketplace but root's kit, by that path as written, in every session the talos user starts, Main's included. Neither the
  talos user's settings nor its flags override it (Titan measured 2.1.322 and 2.1.323: a home marketplace, a link to root's kit
  and a second marketplace are all blocked; the two @builtin instruction plugins still take their option). Claude Code takes
  managed settings first-wins, though: a server-managed policy (an org account that delivers managed settings) or an MDM
  profile takes the file's place, so a talos user signed in to such an account defeats it while the byte-exact file check
  still passes. The canary in B is what would detect that, and it is not built. On a Talos distro,
  `kit/scripts/plugin-settings.py` therefore names talos-local's path as exactly `/opt/talos-app/kit`, and the supervisor
  refuses a thread start unless the policy file is root's, not writable by others, holds exactly those bytes, and stands
  alone. Any entry in `/etc/claude-code/managed-settings.d/` refuses the start, because a drop-in's list is joined to the file's
  and can let another marketplace load (`rooted-kit.ts managedProblem`). The allowlisted marketplace's own manifest,
  `/opt/talos-app/kit/.claude-plugin/marketplace.json`, decides which plugin it serves. So kit-update writes it from fixed bytes
  (`packages/protocol/fixtures/kit-marketplace.json`, what `plugin-release.py` lays out: no per-release field), root:root 0444
  in a 0755 folder, never copying the talos user's file, and the start check compares it the same way (`marketplaceProblem`).
  Measured: Claude Code records a marketplace's `source` and its `installLocation` apart
  (`~/.claude/plugins/known_marketplaces.json`, the talos user's file), and with the allowlist alone a talos-local whose source
  is root's kit and whose location is a home folder loaded the home plugin (its hook ran, 2.1.322 and 2.1.323). Declaring
  talos-local in the managed file makes Claude Code rewrite that entry at start, and only root's kit loads. A plugin's
  `installPath`, cache copies and plugins/marketplaces copies were ignored either way (Titan, Fable R1-1).
  So the forged entry is rewritten at start and root's kit loads. A rewrite raced between Claude Code's correction and its load:
  no race observed in 400 headless starts (200 per CLI version) and 100 interactive (50 per version) with the record being
  rewritten continuously by two writers (the home plugin's hook ran 0 times; root's kit 200 of 200 headless and 50 of 50
  interactive on each version). Measured and stated: `--plugin-dir` pointing at a home folder still
  loads that plugin under A', and Main's own launch passes one. `disableSideloadFlags` would close it, but thread sessions
  need `--mcp-config`, so it stays open until B.
  How a kit update flows on a Talos distro: Setup's `install.sh` (and any later `talos update`, which nothing on Windows runs
  today) builds the release in the talos user's vendor, points the agent folder's `hooks/` and `scripts/` at it and writes
  settings. On a Talos distro (`kit/scripts/_rooted.py`, the same marker rule as the supervisor's) settings name root's kit, and
  `release-check.py start` checks that entry rather than the home vendor's manifest. Every update's `reconcile` moves an older
  home entry to root's kit. Then "Update the kit" (root, from the tray) copies that release into `/opt/talos-app/kit` and seals
  it. Until it runs, Main's plugin (root's `current`) and the agent folder's hook scripts (the home release) can be different
  versions. The plugin registers no hooks, only skills and agents, so that skew is in skills, not in what guards a session.
  A rollback on a Talos distro to a release built before this change would fail that old release's own start check, which
  still wants the home vendor's marketplace. Nothing on Windows runs talos-update today, so it is logged, not fixed.
  What A' leaves open: hooks in the talos user's own
  `~/.claude/settings.json` (not a plugin) still load into every session, thread sessions included (`--setting-sources=user`),
  and a PreToolUse hook there can answer "allow". So can Main's agent-folder hooks. Only B closes that.
- **B, planned, not built: every Talos hook from root's policy.** `allowManagedHooksOnly: true` in the managed file blocks every
  hook not written in it, `--settings` hooks included (Titan's probe). So B moves every Talos hook into the managed file (or a
  drop-in kit-update writes): Main's kit hooks and the thread sessions' permission relay. Each command is a root-owned
  dispatcher under `/opt/talos-app/kit`. A hook command is then the same for every session, so the per-thread values come from
  a session map the supervisor writes (`$TALOS_HOME/workers/<id>/session.json`: thread, folder, nonce), looked up by the
  session_id in the hook's own input. That map is the talos user's, the same stated limit as the bridge's pid file and socket.
  Main has no entry in it. Before B: Titan measures that a managed PermissionRequest hook fires and its answer is honoured,
  whether allowManagedHooksOnly also blocks the status line (if it does, the usage recorder moves in too), and a managed
  SessionStart canary the supervisor checks, which shows when a server-managed org policy has taken the file's place. Setup
  must then say plainly: on a Windows install, the owner's own agent-folder hooks stop running.
- **Known and accepted (rooted too).** Root's hook still exits quietly, leaving the prompt at the terminal, on its kill switch,
  on a folder-check refusal, and when the bridge is not live. And `bridge.pid` and `run/hub.sock` are the talos user's:
  whoever listens there is who answers. That is the limit stated next.
- **What tier 1 does and does not stop.** It stops the kit, and so the hook a thread session runs, being changed behind the
  supervisor's back by anything running as the talos user: a session's own edits, a script it runs, a plugin. It does NOT stop
  a process running as the talos user with arbitrary code execution from doing everything else that user can: rewriting a
  worker's settings file before a start, the supervisor's own code and checkout, the Claude Code binary and plugins in its home,
  or Main's hooks and settings. Root's kit only means that the hook, once started, is the one root sealed. Holding the line
  against arbitrary code as the talos user needs separate users for the supervisor and the sessions (roadmap: agent isolation).
- **Checked live on Hestia** (the real `talos-app supervise` and Claude Code 2.1.322, a scratch home, a private tmux server,
  a local stand-in API, no root approval): with no token, the theme was answered and then `main=signin`, with nothing
  pressed on the login screen. With a token file, the theme and the security notes were answered, then
  `main=waiting:trust` ("the launch is not root-approved"). The token was in Main's environment and in neither the log nor
  the state. **Not yet checked live:** the approved path (it needs a root-owned `/etc/talos`), and the tray end to end on Windows.

**Fable on the pairing change (0770142f): PASS, and what changed.**

- R1-2: Setup's last screen says "Installed: Talos <v>, commit <sha>" only when the distro's checkout IS that commit.
  install.ps1 reads it after setup-user.sh (`git rev-parse --verify HEAD` as talos, a full sha only) and writes it as
  a `checked-out` status line. A re-install over a newer ~/talos-app says "Setup was for ..., but this PC runs commit
  ...", and so does a checkout that could not be read. A failure screen never says "Installed", only "Setup was for
  ...". The line proves the payload on a FRESH install, which is what the run sheet's step 10 is.
- R1-1: main=running means Claude's input box is up, not that the bridge is on the relay. So not-ready now says "Talos
  is still connecting, so nothing was shown and no phone was paired", then sign in first if the dot is amber, or try
  again in a minute if it is green.
- R1-3: tests for the window closing (stdin ends: no end event, enroll ended) and for bridge_not_live after a link or a
  confirm (not-ready at once, nothing pinned).
- R1-4: answers to enroll's pty go through to_enroll, which never throws, so the end event always follows. Root's own
  15-minute limit is reported as `expired`, not as `error enroll`.
- One version rule and one commit rule, both case-sensitive, for payload.json and Setup's screen alike.
- The four words: pair.py passes a confirm only if its words are on the PGP list, even/odd/even/odd as fingerprint.ts
  picks them (Pantheon and Cyclops, 2026-11-12). It carries its own copy of the list, and a test holds that copy equal to
  packages/protocol/src/pgp-words.ts. So a hostile bridge can put no free text in the window, but it still chooses WHICH
  list words appear (R5-2's limit above holds). Yucatán (odd 255) passes.
