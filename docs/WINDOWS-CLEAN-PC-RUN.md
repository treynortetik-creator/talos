# Talos on Windows: the clean-PC run sheet

For the owner's clean test PC: the checks that can only be done there, on a Windows PC that has never had WSL, with a
person at the screen. About 2 hours. Do the steps in order. Each one says what you should see. **If what you see is
different, take a photo of the screen** (a phone photo is fine) and write down the step number, then carry on if you can.

You need:

- the clean PC: Windows 11 Home or Pro, x64, plugged in, online, never had WSL;
- `TalosSetup-<version>.exe`, built for her relay (Titan builds it on request), from the one commit named below;
- your iPhone with the Talos app from TestFlight;
- a Claude account to sign in with (yours, for this test);
- 30 minutes of it set aside for steps 6 to 9, which wait on a restart and a sign-in.

**The commit this run is for (a hard rule, Pantheon, 2026-11-12):** Setup's payload pins ONE commit of main. That
commit comes at or after both Hestia's main-first-start landing (the supervisor's run/main-state, so the tray can say
"not signed in" and offer pairing once Claude runs) and Titan's latest Windows commit. A payload from any other commit
(an older one, or a local one) is not this run. Titan fills in the sha below once the payload is built. Setup shows it on
its last screen (step 10), and its log has it in the step `Talos <version> (<sha>), from Setup`.

- **The build for the day (Pantheon, 2026-11-13):** made that morning from the then-current main, with the relay address
  the owner adds at build time (the address is not passed between machines; the owner supplies it on the day). Before it
  goes to her, Titan runs the same fresh-install table on that commit once, without the address parts (install, the kit
  sealed, "Update the kit" twice, the policy cases, uninstall keeping the distro, the Start menu entry, removal leaving
  nothing), so whatever landed in between is covered. Titan writes that commit's full sha here that morning; step 10's line
  must read `Installed: Talos <version>, commit <that sha>`.
- The last commit run that way: `58eda5ed548afce70d5e94199585ca1cccc8d249` (main, 2026-11-13), Titan's
  `TalosSetup-0.1.0-rc6.exe`, SHA-256 `752459dc19ea09f6a9805fc62c7955e60ab9dd960081de8cdca668b38d7ed82a`, unsigned, no
  relay address: a fresh install, then uninstall with the distro kept, a mistyped name, and the distro removed.

## A. Before Setup

1. **Check that this PC has no WSL.** Open Start, type `cmd`, open Command Prompt, and run `wsl --status`.
   - Expect: a message that WSL is not installed (or that it offers to install it), and the prompt back by itself.
   - Photograph if: it **waits for a key** before returning (that is a question for us), or it says WSL is already
     installed (then this PC is not clean, so stop and tell Pantheon).
2. **Plant a wrong folder in your Windows settings** (the check that the administrator step ignores them). In the same
   Command Prompt run:

   ```text
   setx ProgramData "%USERPROFILE%\not-programdata"
   ```

   - Expect: `SUCCESS: Specified value was saved.` It changes nothing yet. Step 31 removes it.

## B. Setup, on a PC with no WSL

3. **Put Setup in a folder of its own.** Make a new empty folder on the desktop, and copy `TalosSetup-<version>.exe` into
   it. Double-click it there.
4. **SmartScreen.** Expect "Windows protected your PC". Click **More info**, then **Run anyway**.
   - Photograph: this screen once, even when it looks right, for the setup guide's picture.
5. **Setup's first page.** Expect a window titled "Set up Talos on this PC", with "Keep this PC awake while it is plugged
   in" ticked and the line under it. Click **Set up Talos**.
   - Photograph if: no window appears within a minute (this was a real bug once), or the text is cut off.
6. **The one administrator question.** Expect Windows' "Do you want to allow this app to make changes to your device?"
   (it names Windows PowerShell). Click **Yes**.
   - Photograph: the prompt.
   - Expect next: Setup's step text moves on, then a page titled "Restart to carry on".
   - Photograph if: Setup says WSL could not be installed (and note the code it shows).
7. **Check where the administrator step worked.** In File Explorer, open `C:\ProgramData` (type it in the address bar).
   - Expect: a folder named `Talos-setup-` followed by letters and numbers.
   - Expect: **no** folder `not-programdata` in your user folder with a `Talos-setup-` folder inside it.
   - Photograph: both locations.
8. **Restart.** Click **Restart now** on Setup's page. Sign in again after the restart.
9. **Setup carries on by itself.** Expect: within a minute of signing in, Setup's window opens again with no click, says
   it is setting up Talos, and goes through its steps (10 to 20 minutes, needs the internet).
   - Photograph if: nothing opens within 3 minutes, or it shows the first page again instead of carrying on.
10. **Setup finishes.** Expect "Talos is set up", a line starting `BRIDGE_PUBKEY=` under the text, and **Copy the key**
    and **Close** buttons. The last line of the text reads `Installed: Talos <version>, commit <40 characters>`.
    Setup writes "Installed" only when the distro's own checkout is that commit, read after the install. On this
    FRESH install, that is what proves the payload. Over an existing install it could say "Setup was for ... but this PC
    runs commit ..." instead.
    - Check that commit against the one named at the top of this sheet. **If it differs, or the line starts "Setup was
      for", stop and tell Pantheon:** this is not the commit this run is for.
    - Photograph: this page, with the commit line readable.
    - Click **Copy the key**, paste it into a message to Pantheon, and Pantheon sets it on her relay. Then click
      **Close**.
11. **One Setup at a time** (quick check, any time Setup is open): double-click Setup.exe a second time while its window
    is open.
    - Expect: "Talos Setup is already open. Finish or close that window first."

## C. The tray

12. **Find the icon.** Expect a coloured dot by the clock (click the ^ arrow if it is hidden). Within a minute it should
    be amber ("not signed in to Claude") or green.
    - Photograph: the menu (right-click the dot).
13. **The menu.** Right-click the dot. Expect, from the top:
    - the status lines ("Talos: ...", "Cut off from Windows: yes", "Keep-alive: holding the distro", "Keeping this PC
      awake: yes (plugged in)");
    - "Sign in to Claude...", "Pair a phone (Sign in to Claude first)" greyed out, "Open the log folder", "Quit".
    - Photograph if: any line says NO, red or not known after 2 minutes.
14. **Sign in to Claude** (the first real sign-in). Click **Sign in to Claude...**. Expect a window that says it is
    getting a sign-in link, then **Open the sign-in page**.
    - Click it, sign in with the Claude account in your browser, and copy the code the page shows.
    - Paste it into the box and click **Sign in**.
    - Expect: "You are signed in", and the dot green within a minute or two.
    - Photograph: the window at each stage. If it shows an error, photograph that too.
    - **First seen on this run.** Titan's runs never had a token, so the step from signed in to green has not run on
      Windows before. Talos restarts Claude once with the new sign-in, then answers its first questions by itself.
    - **If the dot is not green 3 minutes after "You are signed in":** photograph the menu with its status line. Then, in
      Command Prompt, run the line below and photograph what it prints. It is Talos's own log of the first start, and it
      holds no token.

      ```text
      wsl -d talos -u talos --exec tail -n 30 /home/talos/.config/talos/app/supervisor.log
      ```

      What it should show, in order: `oauth_token_changed` (one restart), `first_start_key` lines for `trust`,
      `mcp_consent`, maybe `security_notes`, and `dev_channels`, then `running`. Where it stops is what to tell Pantheon.
15. **"Approve this change" must NOT be there.** Right-click the dot. On a new install, Setup approves how Talos starts
    Claude by itself, so the menu has no **Approve this change...**, and the status does not say it is waiting for an
    approval.
    - **If it is there, that is the failure this run is looking for.** Photograph the menu, open it, photograph the
      window, click **Not now** (never **Approve** here), and report it.
16. **Pair your iPhone.** The menu item is grey until the dot is green: "Pair a phone (Sign in to Claude first)" before
    step 14, "Pair a phone (once the dot is green)" while Talos is starting. Once the dot is green it reads **Pair a
    phone...**; click it. Expect a link and a QR code.
    - **First seen on this run.** The item has never been enabled on Windows before, and no phone has paired with a
      Windows PC: Titan's runs had no sign-in and no real relay. If any part below goes wrong, photograph the window as it
      is and the menu, and note the time.
    - If the window instead says "Talos is still connecting, so nothing was shown and no phone was paired", nothing was
      half-paired: a green dot means Claude is up, and Talos's connection to the relay can take a little longer. Close
      it, wait a minute, and try again. Photograph it if it still says so after 3 minutes of a green dot.
    - In the Talos app, scan it (or open the link).
    - Expect on the PC: four words and "Do these four words match your phone?", with the phone's name under them. The
      Yes button only works after a moment. Compare with the phone, then click **Yes, they match**.
    - Expect: "Paired. Your iPhone can now reach Talos." The phone shows Talos connected.
    - Photograph: the four words on both screens, and the end state.
    - If one of the words has an accent (about 2 phones in 256 get "Yucatán"), check that the PC shows the accent as on
      the phone, not a box or a `?`. Photograph it either way.
    - If the window says the relay turned this PC's key away: step 10's key has not reached the relay yet. Send it
      again, wait for the relay to be updated, then try again.
17. **Use it from the phone.** Send one message from the phone and check a reply comes back.
    17a. **See the approve window once, on purpose.** This changes one launch flag the way an update would.
    - In Command Prompt, run this. It adds `--verbose` to how Talos starts Claude:

      ```text
      wsl -d talos -u talos --exec python3 -c "import json,os;f=os.path.expanduser('~/.config/talos/app/supervisor.json');d=json.load(open(f));d['args'].append('--verbose');t=f+'.tmp';json.dump(d,open(t,'w'));os.replace(t,f)"
      ```

      (It writes a new file and then swaps it in, so the old one is never half written.)

    - Within a minute, expect the dot to turn amber, saying it is waiting for you to approve how it starts, and the menu
      to have **Approve this change...**. Click it.
    - Expect, at the top: "How Talos starts Claude has changed", and what approving means. Below it:
      `ADDED argument: "--verbose"`, then `Program: "..."`, `Agent folder: "..."`, and `Arguments (5), one a line:` with
      each argument quoted on its own line, then `Environment (0):`.
    - Photograph the window, then click **Approve this change**. Expect "Approved", and the dot green again within a
      minute.
    - Photograph if: the window shows anything unexpected, or the button is greyed out with this change.
    - **Put it back** (so `--verbose` does not stay approved for good). Run:

      ```text
      wsl -d talos -u talos --exec python3 -c "import json,os;f=os.path.expanduser('~/.config/talos/app/supervisor.json');d=json.load(open(f));d['args']=[a for a in d['args'] if a!='--verbose'];t=f+'.tmp';json.dump(d,open(t,'w'));os.replace(t,f)"
      ```

    - Expect the dot amber and **Approve this change...** again, now with `REMOVED argument: "--verbose"` at the top.
      Approve it. Expect the dot green again.

    17b. **Restart, then restore.** With the dot green, open the menu, then click **Restart Talos...**.
    - Expect: "Talos is starting. The dot turns green in a minute or so." Then the dot is green again.
    - Then click **Restore last good setup...**. Expect one of two answers. "Nothing to restore: the setup already matches
      the last one that started cleanly." means nothing was changed. "Done: the agent's tool list (.mcp.json) and Claude
      Code settings from the last clean start are back, and Talos is starting again." means they were put back. After
      either, the dot is green again within a minute or two.
    - **First seen on this run.** Titan's restore runs had no clean start, so nothing was ever saved there. They could
      only answer "Nothing to restore yet".
    - **If it says "Nothing to restore yet: a good setup is saved only after Talos has started cleanly once"** after a
      green dot, that is the failure to report. So is anything else, or a dot that stays amber. Photograph the window
      and the menu.

## D. Her own Ubuntu, beside Talos (the promise that Talos does not break her other WSL distros)

18. **Install a normal Ubuntu.** In Command Prompt: `wsl --install Ubuntu-24.04`, and make a user when it asks.
19. **Windows programs work in it.** Inside that Ubuntu, run `cmd.exe /c ver`.
    - Expect: a line like `Microsoft Windows [Version 10.0....]`.
20. **Restart Talos's distro** (that is what removes WSL's Windows-program entry). In Command Prompt, run
    `wsl --terminate talos`, then wait 2 minutes.
21. **Check Ubuntu again.** In Ubuntu: `cmd.exe /c ver`.
    - Expect: the same Windows version line. Talos gives the entry back within about 30 s of starting again.
    - Photograph if: `Exec format error`.

## E. The rest

22. **Sleep notice** (laptops): close the lid for 3 minutes on battery, then open it.
    - Expect: a "This PC was asleep" notification, and "Asleep: Talos was offline from ... to ..." in the menu.
23. **Quit and start again.** Menu, **Quit**, then **Yes**. Expect the dot to go away. Sign out of Windows and back in.
    Expect the dot back.
24. **Cancel a Setup run.** Run Setup again, click **Set up Talos**, and close the window halfway through. Click **Yes** to
    stop.
    - Expect: it stops, and running Setup again carries on normally. (Optional; skip if short of time.)
25. **The virtualization message** (optional, only if the PC's setup screen is easy to reach): turn virtualization off
    in the firmware and run Setup.
    - Expect: a page explaining how to turn it back on.
    - Turn it back on afterwards.

## F. Uninstall, and what must be left

26. **Uninstall.** Run it: open `%LOCALAPPDATA%\Talos\bin`, right-click `uninstall.ps1`, choose **Run with
    PowerShell**. (A no-terminal uninstall comes later.)
    - Expect: lines saying the logon task was removed, the talos distro was stopped, and "your other WSL distros can
      still run Windows programs".
    - Photograph if: it says it could not check that.
    - Expect too: its last line (before the window closes) says what is still on the PC: "Still on this PC: the Talos disk, N GB, in ... To remove it
      later: Start menu, Remove Talos and its data." `%LOCALAPPDATA%\Talos` then holds only `wsl` (the kept distro's disk:
      the agent and its memory) and `bin` with just `uninstall.ps1` and `TalosWin.ps1`. No logs, no `setup-status.txt`.
      If a window was open in `bin`, it says "still in use"; close that window and check again a minute later.
27. **The tray is gone.** Expect: no dot by the clock.
28. **Her Ubuntu still runs Windows programs.** In Ubuntu: `cmd.exe /c ver`.
    - Expect: the Windows version line.
    - **This is the one we most need to know.** Photograph if it says `Exec format error`, then run `wsl --shutdown` in
      Command Prompt, open Ubuntu again, and run `cmd.exe /c ver` once more (it should work after that). Photograph that
      too.
29. **Nothing of Talos left running.** Command Prompt: `wsl --list --running`.
    - Expect: no `talos`.
30. **The power setting is unchanged.** Settings, System, Power: the sleep times are what they were before Setup. Talos
    never changes them; it only asks Windows to stay awake while the tray runs.
31. **Remove the planted setting from step 2.** Command Prompt:

    ```text
    reg delete HKCU\Environment /v ProgramData /f
    ```

    - Expect: `The operation completed successfully.` Sign out and back in.
32. **Remove Talos and its data, from the Start menu** (the last step: it deletes the agent and its memory for good; do the
    optional revoked sign-in below first if you are doing it). Start menu, **Remove Talos and its data**. A window asks you
    to type `talos`; type it and press Enter.
    - Expect: "deleted the talos distro", "removed ...\Talos", "removed the Start menu entry", then "Press Enter to close".
    - Then check: `%LOCALAPPDATA%\Talos` is gone, the Start menu entry is gone, and `wsl --list` has no `talos`.
    - Photograph if: anything of Talos is still there, or the window closes before you can read it.

## Optional, after everything else: a revoked sign-in

Do this only after step 31 (it signs this PC out of Claude). It shows us something no build machine can: Claude Code's
answer to a real revoked token.

- On the Claude account page in your browser, revoke this PC's sign-in (the token Talos made in step 14).
- Expect, within a minute or two: the tray's dot amber, saying Talos is not signed in to Claude, and **Sign in to Claude...**
  in the menu.
- Photograph: the tray menu, and what Main's pane shows (in the Talos app on your phone, open Main).
- Photograph if: the dot stays green for more than 5 minutes after revoking.

## Only a real run proves these (Titan's runs cannot)

Titan's fresh installs (rc3, 2026-11-13) run Setup's own path without its window, on a PC that already has WSL, with no
Claude sign-in. So three things are seen only here. Each is already a step above; this is exactly what to look for.

- **WSL's installer from Setup's window** (steps 6 to 8: the prompt, then the restart). Expect: the only administrator prompt is WSL's own, and Setup
  says a restart is needed. Photograph if: a second administrator prompt, or an error page instead.
- **Setup resumes by itself after the restart** (step 9). Expect: after you sign back in to Windows, Setup's window comes
  back on its own and carries on to "Installed: Talos ..." with no click from you to restart it. Photograph if: it does not
  come back within 2 minutes, or it starts again from the beginning.
- **A thread session runs root's hook, and the hook fires** (after step 14's sign-in and step 16's pairing). In the app,
  make a new thread and give it its own session (the thread's settings), then send it a message.
  - Expect, in Command Prompt:
    `wsl -d talos -u root -- sh -c "grep -ho '/opt/talos-app/kit/releases/[^ \"]*permission-relay.py' /home/talos/.config/talos/app/workers/*/settings.json"`
    prints one line under `/opt/talos-app/kit/releases/`, never `/home/talos`.
  - Then ask that thread to do something that needs your OK (for example: "create a file called hello.txt in your
    folder"). Expect: an approval card on the phone (that is the hook firing), and after you approve, the file is made.
  - Photograph if: the grep prints nothing or a `/home/talos` path, the thread says it could not start ("open Talos in the
    tray and choose Update the kit"), or no card comes within a minute.
- **A thread's session opened from the tray, signed in** (right after the hook check above, on that thread while it
  waits on a question in its session). Click the Talos icon by the clock, choose "Open a thread's session...", and pick the
  thread by its name.
  - Expect: a window titled "Talos — <the thread's name>. To leave, close this window: the thread keeps running.", showing
    the thread's question. Answer it there with the keys it shows; the thread goes on, and its next message reaches the
    phone. Then close the window with its X: the thread keeps running (send it another message; it answers).
  - Photograph: the menu with the thread list open, and the window.
  - Photograph if: the window shows tmux errors instead of the question, closes at once, or the thread stops when the
    window is closed.

## What this window can and cannot tell you (pairing)

"Pair a phone" checks that the link and the QR code point at your relay, and Talos itself draws the code. The four words
and "Paired" come from Talos's own bridge, though, which runs with the agent's rights. The window protects against someone
on the network or at the relay; it is not proof against the agent itself. The words on the phone matching the words on the
PC is the real check: look at both.

## G. Send back

32. Send Pantheon:
    - the photos with their step numbers;
    - the copied key from step 10, if not sent already;
    - Setup's log, `%LOCALAPPDATA%\Talos\setup.log`, if Setup failed anywhere;
    - the administrator step's log, `C:\ProgramData\Talos-setup-...\setup-wsl.log`.
