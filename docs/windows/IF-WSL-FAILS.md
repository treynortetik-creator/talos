# If the WSL step fails on the Windows user's PC

This page is for whoever helps the Windows user over a phone call or a screen share. When a step fails, Talos Setup's window
shows one red line, sometimes with a few lines of help under it. Ask them to read that red line out, then find it below. Each
entry gives what they see, what it means, and the fix.

## Ask these two first

- **"Is a VPN on?"** That's NordVPN, a work VPN, or anything with "VPN" in its name by the clock. Ask them to turn it off
  while Setup runs. On a test PC, a VPN's own DNS servers made every name lookup wait about 7 s and made WSL's lookups fail.
- **"Did you restart when Setup asked?"** Setup carries on by itself after a restart and a sign-in. Closing the window
  instead of restarting looks like "it stopped".

## 1. "Virtualization is turned off on this PC, so Talos cannot run yet. Nothing was changed."

The same failure can also appear later, at the distro step: "Virtualization is turned off on this PC, so the Talos distro
was not created." That's Windows error 0x80370102.

**What it means:** the PC's firmware has its virtualization setting off, and WSL can't start without it. The help under the
red line says the same in plain words.

**The fix:**

1. Restart the PC and open its setup screen as it starts. The key is often F2, F10, F12, Esc or Delete, and the first screen
   usually says which.
2. Turn on the setting called Virtualization, Intel VT-x, Intel Virtualization Technology, SVM or AMD-V.
3. Save and exit.
4. When Windows is back, open Talos Setup again.

The PC maker's support page has the exact keys: search the PC's model and "enable virtualization". A work PC locked by IT
needs IT.

**Check it took:** Task Manager → Performance → CPU shows "Virtualization: Enabled".

## 2. "WSL was not installed: Windows did not get the administrator "Yes". Open Talos Setup again when you are ready. Nothing was changed."

**What it means:** Windows asked for administrator rights once, to install WSL, and didn't get them. They pressed No, the
prompt timed out, or their Windows account isn't an administrator. In that last case the prompt asks for an administrator's
password.

**The fix:** open Setup again and press Yes. If their account isn't an administrator, someone who is types their password at
that prompt, once. Only the WSL install needs it; nothing after it does.

## 3. WSL or Ubuntu could not be installed

They see one of these:

- "WSL could not be installed (code N). The details are in C:\ProgramData\Talos-setup-…\setup-wsl.log."
- "creating the talos distro failed (wsl exit N)". This step downloads Ubuntu from Microsoft, so it needs the internet.
- "WSL X.Y is too old (2.4 or later names a distro). Run: wsl --update"

**The fix, in this order:**

1. **Online, VPN off.** Check they're connected and the VPN is off, then open Setup again. Most download failures are this.
2. **Windows Update.** Settings → Windows Update → install everything waiting → restart → open Setup again. An old Windows,
   or an update waiting for a restart, breaks both the WSL install and `wsl --update`.
3. **"Too old".** Open Terminal (or PowerShell), run `wsl --update`, then open Setup again.
4. **Still failing.** Write down the code in the red line, and copy setup-wsl.log if the line names it. Send both to whoever
   set Talos up. Don't try further fixes by guesswork on their PC.

## After the install: "This PC is online, but Talos's Linux part can't look up your server's address"

This is the tray's Check Talos, any time after Setup.

**What it means:** WSL's own name lookup stopped while Windows' still works. Talos's Linux part can't find the server, so the
phone link is down.

**The fix:**

1. Ask about the VPN first.
2. Then restart the PC. On the test PC, `wsl --shutdown` alone did not fix it.

The Talos distro also asks WSL's network gateway as a second name server, so this should be rare. If it stays after a
restart, tell whoever set Talos up. The fix that worked on the test PC is a WSL setting (`dnsTunneling=false` in the user's
`.wslconfig`); it changes all of their WSL, so it's for the person who set Talos up to make, not the user.
