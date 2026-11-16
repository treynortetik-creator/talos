# Talos on Windows (WSL 2)

Talos runs on Windows inside WSL 2, in an Ubuntu distro, exactly as it runs on Linux: the bridge, tmux, Claude Code and the
Linux supervisor all live there. Windows only starts the distro at login and keeps it running. There is no native Windows
build; the tests do not run on native Windows either.

The two files here are drafts. Nothing in Talos installs them, and each changes the owner's machine, so they are applied only
with the owner's OK.

| File                                           | What it does                                                                                                   | Where it goes                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [`wslconfig.example`](wslconfig.example)       | caps WSL's memory and cores, so a game keeps its memory                                                        | `%UserProfile%\.wslconfig`, then `wsl --shutdown`         |
| [`talos-logon-task.ps1`](talos-logon-task.ps1) | a per-user task that starts Talos at logon (`wsl -d Ubuntu`, the supervisor's systemd user unit, a keep-alive) | run once in PowerShell, no admin; `-Remove` takes it away |

When Talos Setup fails on the WSL step on someone's PC, [IF-WSL-FAILS.md](IF-WSL-FAILS.md) goes through each red line Setup
shows, what it means, and the fix, for whoever helps them on a call.

For the day someone installs Talos on a Windows PC, [INSTALL-DAY.md](INSTALL-DAY.md) lists every Setup page in order, with what
to click, what each step looks like when it has gone wrong, and which files to send.

## Setting up the distro

1. Install Ubuntu and use it by name: `wsl -d Ubuntu`. Do not change the default distro to reach it; on a machine with Docker
   Desktop the default may be `docker-desktop`, which has no bash.
2. Turn on systemd: `/etc/wsl.conf` holds `[boot]` `systemd=true` (Ubuntu's default). Then `wsl --shutdown` in Windows.
3. Turn on lingering, so the supervisor keeps running when no WSL window is open: `loginctl enable-linger "$USER"`.
4. Clone and install inside the Linux home (`~/Talos/talos-app`), never under `/mnt/c`: on a Windows drive file modes are not
   enforced, so Talos refuses to keep its secrets or config there, and every file call is slow.
5. Run `talos-app doctor`. On WSL it adds rows for the distro, systemd, lingering, and where the Talos folders live.

## What is different on WSL

- **Process start times.** WSL's `ps` prints a start time that can jump by seconds for one running process. Talos reads it
  from `/proc` instead (`apps/bridge/src/proc-identity.ts`), so a running process is never taken for a new one.
- **Secrets.** There is no desktop keyring in a headless distro, so app sign-ins are kept in files only the owner can read,
  in the Talos settings folder on the Linux disk.
- **Notifications** reach the owner through the phone and the web app. A Windows toast through `powershell.exe` may come later.
- **Keeping the machine awake** is a Windows matter: nothing inside WSL can stop Windows from sleeping.
- **Temp files.** If `/tmp` is small, point `TMPDIR` at a folder on the Linux disk for test runs.
