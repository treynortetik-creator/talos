# iPhone checklist

Run on a real iPhone (iOS 26, or the oldest version you want to support, at least iOS 18.4) against a deployed relay.
Automated tests cannot do any of this: WebKit on a computer has no Face ID, no lock screen and no microphone. Write the
date and result next to each line.

1. Open the enroll link in Safari. The page asks to **Add to Home Screen** first; tap **Copy setup link**. The code is not
   used yet.
2. Share, **Add to Home Screen**, open the app, tap **Paste setup link**. Face ID creates the passkey. The app and the Mac
   terminal show the same four words. Answer `y` at the Mac. "New device pinned" appears in the app.
3. Turn on alerts with the button in Settings (never on load). The test notification arrives on the lock screen with no
   message text.
4. Lock the phone and have the agent reply. A push arrives; tapping it opens the right thread. A card push opens that card.
5. The badge number matches the number of things under "Needs you".
6. Hold the microphone for five seconds, slide up to lock, slide left to cancel, then record and send one. The transcript
   appears under the bubble.
7. An agent voice reply plays inline, seeks, plays at 1.5x, through the loudspeaker and through AirPods.
8. Live call: audio comes out of the loudspeaker (not the earpiece), interrupting works, the hand-off chip appears, a
   filler line plays after twenty seconds of waiting, the answer is spoken. Lock the screen during a call: the call ends
   cleanly and the answer arrives as a push.
9. Airplane mode, send a message, switch it off: it is delivered once.
10. Switch the Mac off: the app shows the Mac-offline banner. Open a thread older than seven days: it says the history
    lives on your Mac.
11. Light and dark mode follow the system. The largest Dynamic Type size does not break the layouts.
12. A week later: pushes still arrive (the subscription did not lapse). Note the date here: \_\_\_\_
