# Setting up Talos on a Windows PC

About 15 minutes, with the PC plugged in and online. You need your own Claude plan, and your iPhone with the Talos app
from TestFlight.

## 1. Open Talos Setup

Put `TalosSetup-<version>.exe` in a folder of its own (a new, empty folder is best, not a Downloads folder full of other
files), then double-click it.

Windows may say **"Windows protected your PC"**. That happens because Talos Setup is not signed with a paid certificate.
It is not a warning that something is wrong with it. To carry on:

1. Click **More info**.
2. Click **Run anyway**.

<!-- picture: SmartScreen's "Windows protected your PC", with "More info" and then "Run anyway" marked. Taken on the
     owner's clean test PC during his test run (a real screenshot, not a drawing). -->

## 2. Set up

Leave **"Keep this PC awake while it is plugged in"** ticked: Talos answers your phone only while the PC is awake.
Closing the lid or choosing Sleep still stops it until the PC wakes.

Click **Set up Talos**. If Windows asks **"Do you want to allow this app to make changes to your device?"**, click
**Yes**. That is the one step that installs WSL, the part of Windows that Talos runs in. If Setup then asks for a
restart, save your work and click **Restart now**. Talos Setup opens by itself after you sign in again, and carries on.

If Setup says the PC's virtualization setting is off, follow the steps it shows, then open Talos Setup again.

## 3. The relay key (for the owner)

The last page shows a line that starts with `BRIDGE_PUBKEY=`. Send this key to whoever runs the relay. It is also saved
in `%LOCALAPPDATA%\Talos\relay-key.txt`. It is a public key, so it is safe to send.

## 4. Sign in and pair

Talos's icon sits by the clock (click the **^** arrow if you don't see it). From it, sign in to Claude with your own
account, then pair your iPhone.
