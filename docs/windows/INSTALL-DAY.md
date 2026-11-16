# Install day: Talos Setup on a Windows PC, page by page

One sheet for whoever sits with the Windows user while Talos Setup runs on their PC. It lists every page in order with
the words on it, what to click, and what it looks like when that step has gone wrong. When something goes wrong, the
section at the end says which files to send.

The page words below come from real runs of the same Setup (`TalosSetup-<version>.exe`) on a test PC. A step that did not
appear in those runs is marked "not seen in a test run".

Before you start: have the PC plugged in and on the internet. Turn off any VPN while Setup runs: on a test PC a VPN made
WSL's name lookups fail ([IF-WSL-FAILS.md](IF-WSL-FAILS.md)).

## 1. Download and open the file

- **Edge may hold the download.** It can say the file "isn't commonly downloaded". Choose **...**, then **Keep**, then
  **Show more**, then **Keep anyway**. Not seen in a test run; the wording depends on the browser.
- **Double-click the file.** The file is not signed yet, so Windows shows a blue box: **"Windows protected your PC"**.
  Click **More info**, then **Run anyway**. This is the step most likely to stop someone on their own.
- **Gone wrong:** nothing opens at all, or the file disappears. Antivirus software may have taken it: look in its
  quarantine, or download it again.

## 2. "Set up Talos on this PC"

- Words: "Talos runs Claude on this PC so you can use it from your iPhone. Setup takes about 15 minutes and needs the
  internet. If this PC has never run WSL (the part of Windows Talos runs in), Windows asks once to allow changes, then
  needs one restart."
- A tick box, on by default: **"Keep this PC awake while it is plugged in"**. Leave it on: Talos answers the phone only
  while the PC is awake.
- Click **Set up Talos**.
- **Gone wrong:** a box saying "Talos Setup is already open" means a Setup window is already open, maybe behind others.
  Finish or close that one first. "Talos Setup could not unpack itself: ..." means the download is damaged or the disk is
  full: download it again.

## 3. "Setting up Talos" (first part)

- Words: "This takes about 15 minutes and needs the internet. You can use the PC meanwhile; keep it plugged in and
  awake.
  If Windows asks whether to allow changes to your PC, choose Yes: that is the one step that installs WSL, the part of
  Windows Talos runs in."
- The line under it shows the step in words, starting with "Getting ready", then "Checking what this PC already has".
- On a PC that never had WSL: **"WSL is not on this PC. Installing it needs one "Yes" for administrator rights, then one
  restart."**
- **The Windows prompt: "Do you want to allow this app to make changes to your device?"** (Windows PowerShell). Click
  **Yes**. On a standard (non-admin) account, Windows asks for an administrator's password here instead. Not seen in a test
  run: the test PC was set to approve without asking.
- **Gone wrong:** "WSL was not installed: Windows did not get the administrator "Yes". Open Talos Setup again when you
  are
  ready. Nothing was changed." means No was clicked or the prompt timed out: open Setup again. "Virtualization is turned off
  on this PC, so Talos cannot run yet": see [IF-WSL-FAILS.md](IF-WSL-FAILS.md), section 1.

## 4. "Restart to carry on"

- Words: "Windows needs one restart to finish turning on WSL. Save anything you have open, then restart. When you sign
  in
  again, Talos Setup opens by itself and carries on."
- Buttons: **Restart now** (restarts in 5 seconds) and **Later**.
- Sign in again as the **same Windows user**. Setup opens by itself within a few seconds of signing in and goes straight
  on
  with "Setting up Talos": there's nothing to click.
- **Gone wrong:** Setup does not reopen after signing in. Open the same `TalosSetup` file again: it carries on from
  where
  it stopped. Signing in as a different Windows user also skips it.

## 5. "Setting up Talos" (the long part, about 15 minutes)

The step line moves through, in this order: "Checking what this PC already has", "Making a space for Talos on this PC (a
few minutes)", "Preparing that space", "Restarting it", "Checking Talos is kept apart from your files", "Copying Talos in",
"Getting Claude ready", "Installing Talos (the longest step)", "Finishing the install", "Starting Talos", "Adding the
Talos icon by the clock", "Making Talos start when you sign in to Windows". "Installing Talos" is the longest; several
minutes on one step is normal.

- **Gone wrong:** the page **"Talos could not be set up"** with one line saying what failed, sometimes help lines under
  it, and "What happened is in ... setup.log". Read out that first line and look it up in
  [IF-WSL-FAILS.md](IF-WSL-FAILS.md). **Open the log** opens the log. Opening Setup again carries on from where it stopped.
- A step line that does not move for more than 20 minutes counts as gone wrong too: send the files below.

## 6. "Talos is set up" and the key

- Words: "Talos now runs on this PC, and starts by itself when you sign in to Windows. Its icon is by the clock (you may
  need the ^ arrow to see it)." Then: "Before your iPhone can pair, this PC's relay key (below) goes to whoever runs your
  relay. Then sign in to Claude and pair, both from that icon."
- Under it: a line starting **`BRIDGE_PUBKEY=`** and the button **Copy the key**. Click it and send the copied line to
  whoever runs the relay. The phone cannot pair until the relay has this PC's own key; a key from any other PC does not
  work.
- Then **Close**.
- **Gone wrong:** no key line on the page. The tray can copy it later: right-click the Talos icon, **Check Talos...**,
  and its key button. If it says "This PC's key changed after Setup showed it", send the files below.

## 7. Sign in to Claude

- Find the Talos icon by the clock (the **^** arrow may hide it). Right-click it, then **Sign in to Claude...**.
- **Open the sign-in page** opens the browser. Sign in with the user's own Claude account, copy the code the page shows,
  paste it into the small Talos window and click **Sign in**.
- **Gone wrong:** "Not signed in: ..." with a reason. Close it and choose **Sign in to Claude again...**. The icon stays
  amber until the sign-in has worked.

## 8. Pair a phone

- **Pair a phone...** is greyed until the icon is green. Once it is, click it. A QR code shows: scan it with the Talos
  app on
  the iPhone, then check that the four words on the PC match the phone's, and confirm.
- "Paired. Your iPhone can now reach Talos." means it is done. Send a first message from the phone.
- **Gone wrong**, each in the window's own words:
  - "The relay turned this PC's key away. Whoever runs your relay needs this PC's key first.": step 6's key is not set on
    the relay yet, or the wrong one is.
  - "Talos is still connecting, so nothing was shown and no phone was paired...": the relay does not have the key yet, or
    Talos just started. Wait a minute and try again; if it stays, it's the key.
  - "Talos could not reach your relay. Check the internet connection, then start again."
  - "The link expired (10 minutes). Start again when your phone is ready."

## The files to send when something goes wrong

All in the Windows user's own folder, `%LOCALAPPDATA%\Talos` (paste that into the File Explorer address bar; the tray's
**Open the log folder** opens the same folder):

- `setup.log`: everything Setup did, with times. The most useful one.
- `setup-status.txt`: the steps, any failure line and the key, exactly as Setup's window showed them.
- `keepalive-talos.log`: the tray's own log of keeping Talos running.

They hold no password or sign-in token. Zip the three and send them, with the first line of the red page read out.
