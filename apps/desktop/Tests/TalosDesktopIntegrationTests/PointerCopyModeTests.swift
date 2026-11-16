import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// The pointer and copy mode. A pane the owner scrolled back is in tmux's copy mode, and every key sent to it then goes to the mode,
/// not to Claude: letters are mode commands, Enter leaves the mode (and was counted as the line delivered), Backspace moves the mode's
/// cursor (and was counted as a round of clearing). So while `#{pane_in_mode}` is 1 the pointer typer sends nothing at all, and the
/// same when that value cannot be read: a mode nobody could read is not "no mode". What is owed stays owed, and goes in once the
/// owner has left the mode. The bridge's port says the same (apps/bridge/src/supervisor/owed-pointer.ts).
///
/// Real private tmux; never `-L talos`. The manager's tmux is a wrapper that writes down every `send-keys` it is asked for, so
/// "nothing was sent" is read off what the manager really ran, not off what the fake happened to show. It writes down every read
/// of the mode too, so "nothing was sent while held" waits for ticks that looked at the mode and held (`heldReads`), not for a
/// length of time: a slow machine makes the wait longer, never the answer different. (The two "not typed a second time" checks
/// after a delivery wait for whole ticks of the manager instead (`ticksPass`): nothing is owed then, so nothing is read.)
///
/// The pointer's sends are `if-shell` invocations that send only when the pane is in no mode (`TmuxCommands.unlessInMode`). The
/// wrapper writes one of those down only when it sent something (it did not print the in-mode marker), so `sent` is still "what
/// reached the pane", and it can put the pane in copy mode right before such an invocation runs (`scroll-before-send`): the gap
/// between a separate check and a separate send, played with no timing.
private let scenario = "review-worker.sh"

/// The manager's wall clock, which a test can set ahead to play "the claim deadline has passed" on a copy of the app that never went away.
private final class WallClock: @unchecked Sendable {
  private let l = NSLock()
  private var offset: Double = 0
  var now: Double { l.withLock { Date().timeIntervalSince1970 + offset } }
  func jump(_ s: Double) { l.withLock { offset += s } }
}

extension WorkerRig {
  fileprivate var sentLog: String { root + "/sent.log" }
  fileprivate var modeFault: String { root + "/mode-fault" }
  fileprivate var enterFault: String { root + "/enter-fault" }
  fileprivate var readLog: String { root + "/mode-reads.log" }
  /// With this file there, the wrapper puts the pane in copy mode right after the next read of the mode (once: it takes the file).
  fileprivate var scrollAfterRead: String { root + "/scroll-after-read" }
  /// With this file there, the wrapper puts the pane in copy mode right after the next read of the screen with its colours (once).
  fileprivate var scrollAfterLook: String { root + "/scroll-after-look" }
  /// With this file there, the wrapper puts the pane in copy mode right before the next send of keys runs (once): after every check
  /// the manager made on its own, and before the keys.
  fileprivate var scrollBeforeSend: String { root + "/scroll-before-send" }
  /// With this file there, a send inside an `if-shell` is not run and prints nothing, with exit 0: a tmux that says neither "sent" nor
  /// "in a mode".
  fileprivate var muteSend: String { root + "/mute-send" }

  /// The real tmux, except: every `send-keys` invocation is logged (one line each, before it runs; one inside an `if-shell` after
  /// it ran, and only if it sent), and so is every read of `#{pane_in_mode}`; with `enter-fault` there, an Enter fails; with `mode-fault` there, the read of the mode fails (`fail`),
  /// prints nothing (`empty`) or prints something that is neither 0 nor 1 (`junk`); with `scroll-after-read` there, the pane goes
  /// into copy mode right after a read that answered; with `scroll-after-look` there, right after a `capture-pane -e`.
  fileprivate func copyModeShim() throws -> String {
    let p = root + "/tmux-copymode"
    try """
    #!/bin/bash
    keys= read= enter= look= guarded=
    for a in "$@"; do
      case "$a" in
        send-keys) keys=1 ;;
        send-keys\\ *) keys=1; guarded=1; case "$a" in *" Enter" | *" Enter "*) enter=1 ;; esac ;;  # the send of an if-shell: one string
        '#{pane_in_mode}') read=1 ;;
        Enter) enter=1 ;;
        -e) look=1 ;;
      esac
    done
    if [ -n "$keys" ]; then
      if [ -n "$enter" ] && [ -f '\(enterFault)' ]; then echo "$*" >> '\(sentLog)'; echo "server busy" >&2; exit 1; fi
      if rm '\(scrollBeforeSend)' 2>/dev/null; then  # once
        '\(Rig.tmuxPath!)' -L '\(socket)' -f '\(Rig.tmuxConf)' copy-mode -t '=t-trip:' 2>/dev/null
      fi
      if [ -n "$guarded" ]; then
        if [ -f '\(muteSend)' ]; then echo muted >> '\(readLog)'; exit 0; fi
        out="$('\(Rig.tmuxPath!)' "$@")"; rc=$?
        [ "$out" = '\(TmuxCommands.inModeMarker)' ] || echo "$*" >> '\(sentLog)'  # held by the mode: nothing reached the pane
        [ -z "$out" ] || printf '%s\\n' "$out"
        exit $rc
      fi
      echo "$*" >> '\(sentLog)'
      exec '\(Rig.tmuxPath!)' "$@"
    fi
    if [ -n "$read" ]; then
      echo read >> '\(readLog)'
      if [ -f '\(modeFault)' ]; then
        case "$(cat '\(modeFault)')" in
          fail) echo "error connecting to the socket" >&2; exit 1 ;;
          empty) exit 0 ;;
          *) echo yes; exit 0 ;;
        esac
      fi
      if rm '\(scrollAfterRead)' 2>/dev/null; then  # once: a later read must not undo the test's own leaving of the mode
        '\(Rig.tmuxPath!)' "$@"; rc=$?
        '\(Rig.tmuxPath!)' -L '\(socket)' -f '\(Rig.tmuxConf)' copy-mode -t '=t-trip:' 2>/dev/null
        exit $rc
      fi
    fi
    if [ -n "$look" ] && rm '\(scrollAfterLook)' 2>/dev/null; then  # once, the same
      '\(Rig.tmuxPath!)' "$@"; rc=$?
      '\(Rig.tmuxPath!)' -L '\(socket)' -f '\(Rig.tmuxConf)' copy-mode -t '=t-trip:' 2>/dev/null
      exit $rc
    fi
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: p, atomically: true, encoding: .utf8)
    chmod(p, 0o755)
    return p
  }

  fileprivate var sent: [String] { completeLines(sentLog) }
  fileprivate var reads: Int { completeLines(readLog).count }
  /// Waits for `n` more reads of the mode by the manager: with a pointer owed, each is a tick (or a send) that looked and held.
  fileprivate func heldReads(_ n: Int = 4, sourceLocation: SourceLocation = #_sourceLocation) {
    let from = reads
    #expect(wait(15) { reads >= from + n }, "the manager never read the pane's mode (\(reads - from) of \(n) reads)", sourceLocation: sourceLocation)
  }
  fileprivate var inMode: Bool { tmuxCmd(["display-message", "-p", "-t", "=t-trip:", "#{pane_in_mode}"]).out.hasPrefix("1") }
  fileprivate func scrollBack() {
    #expect(tmuxCmd(["copy-mode", "-t", "=t-trip:"]).ok)
    #expect(wait(5) { inMode }, "control: the pane never entered copy mode")
  }
  fileprivate func leaveMode() {
    #expect(tmuxCmd(["send-keys", "-t", "=t-trip:", "-X", "cancel"]).ok)
    #expect(wait(5) { !inMode }, "control: the pane never left copy mode")
  }
}

@Suite("The pointer and copy mode", .serialized, .enabled(if: Rig.hasTmux))
struct PointerCopyModeTests {
  private let line = "trip \(PointerTyper.text)"
  private let second = ["m_01JBF3V7Q8K2M4N6P8R0S2T402"]

  /// A warm worker whose first pointer went in the ordinary way (the control: this rig types, and the wrapper sees it).
  private func warm(clock: WallClock? = nil) throws -> WorkerRig {
    let r = try WorkerRig(scenario: scenario)
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    let shim = try r.copyModeShim()
    if let clock {
      r.manager(tmux: shim, now: { clock.now }).startTicking()
    } else {
      r.manager(tmux: shim).startTicking()
    }
    try r.wake("trip")
    #expect(r.wait(10) { r.typedLines.count == 1 }, "control: the first pointer is typed: \(r.why("trip"))")
    // The wrapper writes a guarded send down after tmux has run it, so the fake can log the typed line before the wrapper logs the
    // Enter that typed it. Wait for both: a `before` taken without the Enter would count that Enter as a later send.
    let w = waitUntil(timeout: 15, observe: { r.sent }) { $0.count >= 2 }
    #expect(w.ok, "control: the wrapper logs what the manager sends: \(w)")
    return r
  }

  /// Our line in the box with its Enter owed (the Enter failed), on the same wrapper.
  private func enterOwed(_ how: String = "crash", clock: WallClock? = nil) throws -> WorkerRig {
    let r = try WorkerRig(scenario: scenario)
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    FileManager.default.createFile(atPath: r.enterFault, contents: nil)
    if let clock {
      r.manager(tmux: try r.copyModeShim(), now: { clock.now }).startTicking()
    } else {
      r.firstCopy(how, tmux: try r.copyModeShim()).startTicking()
    }
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") && r.screen().contains(PointerTyper.text) }, "the text was never typed: \(r.why("trip"))")
    #expect(r.wait(5) { r.owed().enter == true && r.owed().until != nil }, "the owed Enter is not on disk: \(r.owed())")
    // the same order as in `warm`: the text is on the screen before the wrapper has written its send down
    let w = waitUntil(timeout: 15, observe: { r.sent }) { s in s.contains { $0.contains(PointerTyper.text) } && s.contains { $0.contains("Enter") } }
    #expect(w.ok, "control: the wrapper logs the text and the failed Enter: \(w)")
    return r
  }

  /// The owner scrolled back, then a message came: nothing is typed into the mode. Out of the mode, the line goes in, once.
  @Test func nothingIsTypedWhileThePaneIsInCopyMode() throws {
    let r = try warm()
    defer { r.teardown() }
    r.scrollBack()
    let before = r.sent
    try r.wake("trip", ids: second)
    #expect(r.wait(5) { r.owed().until != nil }, "the pointer is not owed: \(r.owed())")
    r.heldReads()
    #expect(r.sent == before, "keys were sent into copy mode: \(r.sent.dropFirst(before.count))")
    #expect(r.inMode, "the owner was thrown out of copy mode")
    #expect(r.typedLines.count == 1, "\(r.typedLines)")
    #expect(r.owed().until != nil, "the pointer was counted as delivered: \(r.owed())")
    r.leaveMode()
    #expect(r.wait(10) { r.typedLines.count == 2 }, "the pointer never went in after the mode was left: \(r.typedLines) \(r.why("trip"))")
    #expect(r.typedLines.last == line, "\(r.typedLines)")
    r.ticksPass()
    #expect(r.typedLines.count == 2, "typed more than once: \(r.typedLines)")
    #expect(r.wait(5) { r.owed().until == nil && r.owed().enter == nil }, "\(r.owed())")
  }

  /// Our line is in the box and only its Enter is owed; the owner scrolls back. An Enter then would only leave the mode, and the
  /// line would be marked delivered with nothing sent. It waits, and is finished with the Enter alone once the mode is left.
  @Test func anOwedEnterIsNotPressedInCopyMode() throws {
    let r = try enterOwed()
    defer { r.teardown() }
    r.scrollBack()
    r.heldReads(2)  // a tick that began before the mode has ended: the ones from here on saw the mode
    let before = r.sent
    unlink(r.enterFault)  // an Enter would go through now
    r.heldReads()
    #expect(r.sent == before, "keys were sent into copy mode: \(r.sent.dropFirst(before.count))")
    #expect(r.inMode, "the Enter left copy mode for the owner")
    #expect(r.typedLines.isEmpty, "\(r.typedLines)")
    #expect(r.owed().until != nil && r.owed().enter == true, "counted as delivered, with nothing sent: \(r.owed())")
    r.leaveMode()
    #expect(r.wait(10) { r.typedLines.count == 1 }, "the Enter never went in after the mode was left: \(r.typedLines)")
    #expect(r.typedLines.first == line, "the line was typed again, or went in with something else: \(r.typedLines)")
    #expect(r.wait(5) { r.owed().until == nil && r.owed().enter == nil }, "\(r.owed())")
  }

  /// Past its deadline our own line is taken out with Backspace. In copy mode a Backspace only moves the mode's cursor: three
  /// rounds of it used up the tries and the line stayed for good. None is sent; the line is cleared once the mode is left.
  @Test func anOldLineIsNotBackspacedInCopyMode() throws {
    let r = try enterOwed()
    defer { r.teardown() }
    r.appGone("crash")
    r.scrollBack()
    let before = r.sent
    _ = r.comeBack(ahead: 400, tmux: try r.copyModeShim())
    r.heldReads()
    #expect(r.sent == before, "keys were sent into copy mode: \(r.sent.dropFirst(before.count))")
    #expect(r.inMode)
    #expect(r.screen().contains(PointerTyper.text), "control: our line is still in the box")
    #expect(r.owed().until != nil, "dropped with our line still in the box: \(r.owed())")
    r.leaveMode()
    #expect(r.wait(10) { !r.screen().contains(PointerTyper.text) }, "not cleared once the mode was left:\n\(r.screen())")
    #expect(r.wait(5) { r.owed().until == nil && r.owed().enter == nil }, "\(r.owed())")
    #expect(r.typedLines.isEmpty, "the line went in after the deadline: \(r.typedLines)")
  }

  /// The mode cannot be read (tmux failed, said nothing, or said something that is neither 0 nor 1): that is not "no mode". Nothing
  /// is sent until a read says 0.
  @Test(arguments: ["fail", "empty", "junk"])
  func nothingIsTypedWhileTheModeCannotBeRead(how: String) throws {
    let r = try warm()
    defer { r.teardown() }
    try how.write(toFile: r.modeFault, atomically: true, encoding: .utf8)
    let before = r.sent
    try r.wake("trip", ids: second)
    #expect(r.wait(5) { r.owed().until != nil }, "the pointer is not owed: \(r.owed())")
    r.heldReads()
    #expect(r.sent == before, "keys were sent with the mode unread (\(how)): \(r.sent.dropFirst(before.count))")
    #expect(r.typedLines.count == 1, "\(r.typedLines)")
    #expect(r.owed().until != nil, "\(r.owed())")
    unlink(r.modeFault)
    #expect(r.wait(10) { r.typedLines.count == 2 }, "the pointer never went in once the mode could be read: \(r.typedLines)")
    #expect(r.typedLines.last == line, "\(r.typedLines)")
  }

  /// The same for the Enter alone, and for the Backspaces of a line past its deadline.
  @Test func anOwedEnterIsNotPressedWhileTheModeCannotBeRead() throws {
    let r = try enterOwed()
    defer { r.teardown() }
    try "fail".write(toFile: r.modeFault, atomically: true, encoding: .utf8)
    r.heldReads(2)
    let before = r.sent
    unlink(r.enterFault)
    r.heldReads()
    #expect(r.sent == before, "keys were sent with the mode unread: \(r.sent.dropFirst(before.count))")
    #expect(r.typedLines.isEmpty && r.owed().enter == true, "\(r.typedLines) \(r.owed())")
    unlink(r.modeFault)
    #expect(r.wait(10) { r.typedLines.count == 1 }, "\(r.typedLines)")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
  }

  @Test func anOldLineIsNotBackspacedWhileTheModeCannotBeRead() throws {
    let r = try enterOwed()
    defer { r.teardown() }
    r.appGone("crash")
    try "empty".write(toFile: r.modeFault, atomically: true, encoding: .utf8)
    let before = r.sent
    _ = r.comeBack(ahead: 400, tmux: try r.copyModeShim())
    r.heldReads()
    #expect(r.sent == before, "keys were sent with the mode unread: \(r.sent.dropFirst(before.count))")
    #expect(r.screen().contains(PointerTyper.text) && r.owed().until != nil, "\(r.owed())")
    unlink(r.modeFault)
    #expect(r.wait(10) { !r.screen().contains(PointerTyper.text) }, "not cleared once the mode could be read:\n\(r.screen())")
    #expect(r.wait(5) { r.owed().until == nil }, "\(r.owed())")
  }

  /// The owner scrolls back between the look at the box and the Enter (the look can take ten short reads): the mode is read again
  /// right before each send. Played on the manager itself: the pane is put in copy mode by the wrapper as the box is read with its
  /// colours, which is the last thing before the Enter.
  @Test func aModeEnteredAfterTheLookStillHoldsTheEnter() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    let arm = r.root + "/scroll-at-look"
    let looks = r.root + "/looks.log"  // one line per read of the client list: the first thing a tick with a pointer owed does
    let shim = r.root + "/tmux-scroll"
    try """
    #!/bin/bash
    look= guarded=
    for a in "$@"; do
      [ "$a" = -e ] && look=1; [ "$a" = list-clients ] && echo look >> '\(looks)'
      case "$a" in send-keys\\ *) guarded=1 ;; esac
    done
    if [ -n "$guarded" ]; then  # a send inside an if-shell: written down only if it sent (it did not say "in a mode")
      out="$('\(Rig.tmuxPath!)' "$@")"; rc=$?
      [ "$out" = '\(TmuxCommands.inModeMarker)' ] || echo "$*" >> '\(r.sentLog)'
      [ -z "$out" ] || printf '%s\\n' "$out"
      exit $rc
    fi
    # the mode comes with the first coloured look after the second line was typed (the key guard's own look before the typing is not
    # that one: the line must be in the box when the mode comes)
    if [ -n "$look" ] && [ -f '\(arm)' ] && [ "$(grep -c -- ' -l ' '\(r.sentLog)' 2>/dev/null)" -ge 2 ]; then
      '\(Rig.tmuxPath!)' "$@"; rc=$?
      '\(Rig.tmuxPath!)' -L '\(r.socket)' -f '\(Rig.tmuxConf)' copy-mode -t '=t-trip:' 2>/dev/null
      exit $rc
    fi
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.manager(tmux: shim).startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.typedLines.count == 1 }, "control: the first pointer is typed: \(r.why("trip"))")
    FileManager.default.createFile(atPath: arm, contents: nil)
    try r.wake("trip", ids: second)
    #expect(r.wait(10) { r.inMode && r.screen().contains(PointerTyper.text) }, "the line was never typed, or the mode never came:\n\(r.screen())")
    #expect(r.wait(5) { r.owed().enter == true }, "\(r.owed())")
    let ticks = r.lines(looks).count
    #expect(r.wait(15) { r.lines(looks).count >= ticks + 3 }, "the manager stopped looking at the pane")  // ticks that could have sent it
    #expect(r.sent.filter { $0.contains(" Enter") }.count == 1, "an Enter was sent into copy mode: \(r.sent)")
    #expect(r.typedLines.count == 1, "\(r.typedLines)")
    #expect(r.owed().until != nil && r.owed().enter == true, "counted as delivered: \(r.owed())")
    unlink(arm)
    r.leaveMode()
    #expect(r.wait(10) { r.typedLines.count == 2 }, "\(r.typedLines)")
    #expect(r.typedLines.last == line, "\(r.typedLines)")
  }

  /// The same between the first read of a tick and the typing: the pane goes into copy mode right after a read that said "no
  /// mode" (the wrapper does it), so only the read made right before the line is typed can hold it.
  @Test func aModeEnteredAfterTheFirstReadStillHoldsTheLine() throws {
    let r = try warm()
    defer { r.teardown() }
    FileManager.default.createFile(atPath: r.scrollAfterRead, contents: nil)
    let before = r.sent
    try r.wake("trip", ids: second)
    #expect(r.wait(10) { r.inMode }, "control: the wrapper never put the pane in copy mode")
    r.heldReads()
    #expect(r.sent == before, "the line was typed into copy mode: \(r.sent.dropFirst(before.count))")
    #expect(r.typedLines.count == 1 && r.owed().until != nil, "\(r.typedLines) \(r.owed())")
    r.leaveMode()
    #expect(r.wait(10) { r.typedLines.count == 2 }, "\(r.typedLines)")
    #expect(r.typedLines.last == line, "\(r.typedLines)")
  }

  /// A pointer from an earlier copy of the app, past its deadline and never typed, is dropped when the pane can be read. In copy
  /// mode nothing about it is settled: it is still owed in the file while the mode lasts, and dropped (never typed) once it is left.
  @Test func aLatePointerIsSettledOnlyOnceTheModeIsLeft() throws {
    let r = try warm()
    defer { r.teardown() }
    r.ownerTypes("half a thought")  // holds the second pointer, so it is owed and untyped when the app goes
    #expect(r.wait(5) { r.screen().contains("half a thought") })
    try r.wake("trip", ids: second)
    #expect(r.wait(5) { r.owed().until != nil }, "the held pointer is not on disk")
    r.appGone("crash")
    r.ownerBackspaces("half a thought".count)
    #expect(r.wait(5) { !r.screen().contains("half a thought") })
    r.scrollBack()
    let before = r.sent
    _ = r.comeBack(ahead: 400, tmux: try r.copyModeShim())
    r.heldReads()
    #expect(r.owed().until != nil, "settled with the pane in copy mode: \(r.owed())")
    #expect(r.sent == before, "\(r.sent.dropFirst(before.count))")
    r.leaveMode()
    #expect(r.wait(10) { r.owed().until == nil }, "never dropped: \(r.owed())")
    r.ticksPass()
    #expect(r.typedLines.count == 1, "typed for a message main has: \(r.typedLines)")
    #expect(r.sent == before, "\(r.sent.dropFirst(before.count))")
  }

  /// And between the first read of a tick and the Backspaces of a line past its deadline: the pane goes into copy mode as the box
  /// is looked at (the wrapper does it, after the tick's own read said "no mode"), so only the read made right before the
  /// Backspaces can hold them. Sent into the mode they would clear nothing and use up a round.
  @Test func aModeEnteredAfterTheFirstReadStillHoldsTheBackspaces() throws {
    let r = try enterOwed()
    defer { r.teardown() }
    r.appGone("crash")
    FileManager.default.createFile(atPath: r.scrollAfterLook, contents: nil)
    let before = r.sent
    _ = r.comeBack(ahead: 400, tmux: try r.copyModeShim())
    #expect(r.wait(10) { r.inMode }, "control: the wrapper never put the pane in copy mode")
    r.heldReads()
    #expect(r.sent == before, "Backspaces were sent into copy mode: \(r.sent.dropFirst(before.count))")
    #expect(r.screen().contains(PointerTyper.text) && r.owed().until != nil, "\(r.owed())")
    r.leaveMode()
    #expect(r.wait(10) { !r.screen().contains(PointerTyper.text) }, "not cleared once the mode was left:\n\(r.screen())")
    #expect(r.wait(5) { r.owed().until == nil && r.owed().enter == nil }, "\(r.owed())")
    #expect(r.typedLines.isEmpty, "\(r.typedLines)")
  }

  // MARK: the check and the send are one tmux invocation

  /// The owner scrolls back after every check the manager can make on its own and right before the keys go (the wrapper does it as the
  /// send is about to run). As two invocations, a read of the mode and then a `send-keys`, that scroll landed between them and the
  /// line was typed into copy mode as its commands. The send now carries its own check, inside tmux, so nothing is sent.
  @Test func aModeEnteredRightBeforeTheSendNeverGetsTheLine() throws {
    let r = try warm()
    defer { r.teardown() }
    FileManager.default.createFile(atPath: r.scrollBeforeSend, contents: nil)
    let before = r.sent
    try r.wake("trip", ids: second)
    #expect(r.wait(10) { r.inMode }, "control: the wrapper never put the pane in copy mode")
    r.heldReads()
    #expect(r.sent == before, "the line was typed into copy mode: \(r.sent.dropFirst(before.count))")
    #expect(r.inMode, "the owner was thrown out of copy mode")
    #expect(r.typedLines.count == 1 && r.owed().until != nil && r.owed().enter == nil, "\(r.typedLines) \(r.owed())")
    r.leaveMode()
    #expect(r.wait(10) { r.typedLines.count == 2 }, "\(r.typedLines)")
    #expect(r.typedLines.last == line, "something else went in with the line: \(r.typedLines)")
  }

  /// The same for the Enter of a line already in the box: it would only have left the mode, and the line was counted as delivered.
  @Test func aModeEnteredRightBeforeTheSendNeverGetsTheEnter() throws {
    let r = try enterOwed()
    defer { r.teardown() }
    FileManager.default.createFile(atPath: r.scrollBeforeSend, contents: nil)  // armed first: the failing Enter does not take it
    r.heldReads(2)
    unlink(r.enterFault)  // the next Enter would go through
    #expect(r.wait(10) { r.inMode }, "control: the wrapper never put the pane in copy mode")
    let before = r.sent
    r.heldReads()
    #expect(r.sent == before, "an Enter was sent into copy mode: \(r.sent.dropFirst(before.count))")
    #expect(r.inMode, "the Enter left copy mode for the owner")
    #expect(r.typedLines.isEmpty && r.owed().until != nil && r.owed().enter == true, "counted as delivered: \(r.typedLines) \(r.owed())")
    r.leaveMode()
    #expect(r.wait(10) { r.typedLines.count == 1 }, "\(r.typedLines)")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
  }

  /// And for the Backspaces of a line past its deadline: in the mode they clear nothing and used up a round.
  @Test func aModeEnteredRightBeforeTheSendNeverGetsTheBackspaces() throws {
    let r = try enterOwed()
    defer { r.teardown() }
    r.appGone("crash")
    FileManager.default.createFile(atPath: r.scrollBeforeSend, contents: nil)
    let before = r.sent
    _ = r.comeBack(ahead: 400, tmux: try r.copyModeShim())
    #expect(r.wait(10) { r.inMode }, "control: the wrapper never put the pane in copy mode")
    r.heldReads()
    #expect(r.sent == before, "Backspaces were sent into copy mode: \(r.sent.dropFirst(before.count))")
    #expect(r.screen().contains(PointerTyper.text) && r.owed().until != nil, "\(r.owed())")
    r.leaveMode()
    #expect(r.wait(10) { !r.screen().contains(PointerTyper.text) }, "not cleared once the mode was left (a round was used up):\n\(r.screen())")
    #expect(r.wait(5) { r.owed().until == nil && r.owed().enter == nil }, "\(r.owed())")
    #expect(r.typedLines.isEmpty, "\(r.typedLines)")
  }

  // MARK: a hold by copy mode is said, and the pointer keeps its deadline

  static let holdLine = "This thread's session is scrolled back, so Talos can't type into it; your message has probably gone to the main session. Open this thread in Terminals and press q to return to the prompt."

  /// A pointer held back by copy mode was held in silence, for as long as the pane stayed scrolled back. Now the thread gets one line
  /// for the hold and shows as Needs you until the mode is left; a later hold is a new one, with its own line.
  @Test func aHoldByCopyModeTellsTheThreadOncePerHold() throws {
    let r = try warm()
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.tune { $0.draftNoticeAfter = 1 }
    r.scrollBack()
    try r.wake("trip", ids: second)
    #expect(r.wait(15) { log.all.count == 1 }, "the hold was silent: \(log.all) \(r.owed())")
    #expect(log.all.first?.thread == "trip" && log.all.first?.text == Self.holdLine, "\(log.all)")
    #expect(r.wait(5) { r.mgr.needsYou()["trip"] == "scrolled back" }, "\(r.mgr.needsYou())")
    r.heldReads(6)
    #expect(log.all.count == 1, "told more than once for one hold: \(log.all)")
    #expect(r.typedLines.count == 1 && r.owed().until != nil, "\(r.typedLines) \(r.owed())")
    // out of the mode inside the deadline: the line goes in, and the thread no longer waits on the owner
    r.leaveMode()
    #expect(r.wait(10) { r.typedLines.count == 2 }, "\(r.typedLines)")
    #expect(r.wait(5) { r.mgr.needsYou()["trip"] == nil }, "\(r.mgr.needsYou())")
    // a second hold is its own
    r.scrollBack()
    try r.wake("trip", ids: ["m_01JBF3V7Q8K2M4N6P8R0S2T403"])
    #expect(r.wait(15) { log.all.count == 2 }, "the second hold was silent: \(log.all)")
    #expect(log.all.last?.text == Self.holdLine)
  }

  /// No pointer waiting, no hold: a pane the owner scrolled back says nothing by itself.
  @Test func aScrolledBackPaneWithNothingOwedSaysNothing() throws {
    let r = try warm()
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.tune { $0.draftNoticeAfter = 0.2 }
    r.scrollBack()
    for _ in 0..<8 { r.mgr.tickOnce() }
    #expect(log.all.isEmpty && r.mgr.needsYou()["trip"] == nil, "\(log.all) \(r.mgr.needsYou())")
  }

  /// A pointer of this copy of the app had no deadline: held back by copy mode for an hour, it was typed when the mode was left, for
  /// a message the hub had given to main long before. It keeps its deadline now. Past it, the thread is told at once (the message has
  /// gone to main), nothing is settled while the mode lasts, and out of the mode the pointer is dropped, never typed.
  @Test func aPointerHeldByCopyModePastItsDeadlineIsDroppedNotTypedLate() throws {
    let clock = WallClock()
    let r = try warm(clock: clock)
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log)  // draftNoticeAfter stays at 120 s: only the deadline can make the line due
    r.scrollBack()
    let before = r.sent
    try r.wake("trip", ids: second)
    #expect(r.wait(5) { r.owed().until != nil }, "the pointer is not owed: \(r.owed())")
    r.heldReads()
    #expect(log.all.isEmpty, "told before the deadline or the wait: \(log.all)")
    clock.jump(400)  // past the claim deadline: the hub has given the message to main
    #expect(r.wait(15) { log.all.count == 1 }, "not told at the deadline: \(log.all)")
    #expect(log.all.first?.text == Self.holdLine)
    r.heldReads()
    #expect(r.owed().until != nil, "settled with the pane in copy mode: \(r.owed())")
    r.leaveMode()
    #expect(r.wait(10) { r.owed().until == nil }, "never dropped: \(r.owed())")
    r.ticksPass()
    #expect(r.typedLines.count == 1, "typed for a message main has: \(r.typedLines)")
    #expect(r.sent == before, "\(r.sent.dropFirst(before.count))")
    #expect(r.wait(5) { r.mgr.needsYou()["trip"] == nil }, "\(r.mgr.needsYou())")
    #expect(log.all.count == 1, "\(log.all)")
  }

  /// The same with our line already in the box and only its Enter owed: past the deadline the Enter is never pressed. Out of the mode
  /// the line is taken out of the box (no client is attached, so the Backspaces can only delete our own characters).
  @Test func anEnterHeldByCopyModePastItsDeadlineIsNotPressedLate() throws {
    let clock = WallClock()
    let r = try enterOwed(clock: clock)
    defer { r.teardown() }
    r.scrollBack()
    r.heldReads(2)
    unlink(r.enterFault)  // an Enter would go through now
    clock.jump(400)
    r.heldReads()
    #expect(r.typedLines.isEmpty && r.owed().enter == true, "\(r.typedLines) \(r.owed())")
    r.leaveMode()
    #expect(r.wait(10) { !r.screen().contains(PointerTyper.text) }, "our line was left in the box:\n\(r.screen())")
    #expect(r.wait(5) { r.owed().until == nil && r.owed().enter == nil }, "\(r.owed())")
    r.ticksPass()
    #expect(r.typedLines.isEmpty, "the Enter went in after the deadline: \(r.typedLines)")
  }

  /// Control for the deadline: a pointer copy mode never held is still typed however late its turn comes (held by a draft, here), as
  /// before. Only a hold by the mode gives a pointer of this copy its deadline.
  @Test func aPointerTheModeNeverHeldKeepsNoDeadline() throws {
    let clock = WallClock()
    let r = try warm(clock: clock)
    defer { r.teardown() }
    r.ownerTypes("half a thought")
    #expect(r.wait(5) { r.screen().contains("half a thought") })
    try r.wake("trip", ids: second)
    #expect(r.wait(5) { r.owed().until != nil }, "\(r.owed())")
    clock.jump(400)
    r.heldReads()
    r.ownerBackspaces("half a thought".count)
    #expect(r.wait(15) { r.typedLines.count == 2 }, "a pointer held by a draft was dropped: \(r.typedLines) \(r.owed())")
  }

  /// A line of ours past its deadline that stays in the box because a client is attached (it may be mixed with the owner's text, so it
  /// is not cleared) leaves the pointer owed. Each scroll back is then a new hold on a pointer that is already late, and was told at
  /// once: ten scrolls, ten lines. A hold on a late pointer keeps its record, so the kind stays quiet for the debounce window.
  @Test func aLateLineKeptBesideAClientIsNotToldAgainOnEveryScroll() throws {
    let clock = WallClock()
    let r = try enterOwed(clock: clock)
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log)
    let client = try r.attachClient()
    defer {
      if client.isRunning { client.terminate() }
      client.waitUntilExit()
    }
    func told() -> Int { log.all.filter { $0.text == Self.holdLine }.count }
    r.scrollBack()
    clock.jump(400)
    #expect(r.wait(15) { told() == 1 }, "not told at the deadline: \(log.all)")
    for _ in 0..<3 {
      r.leaveMode()
      r.heldReads(3)  // ticks out of the mode: the line is kept (a client is attached), the pointer stays owed
      #expect(r.screen().contains(PointerTyper.text) && r.owed().until != nil, "control: our line is still in the box, still owed: \(r.owed())")
      r.scrollBack()
      r.heldReads(4)
    }
    #expect(told() == 1, "told again on each scroll: \(log.all.map(\.text))")
    #expect(r.typedLines.isEmpty, "\(r.typedLines)")
  }

  /// A send counts only on tmux's own word that the keys went. One that ends well and says nothing (neither "sent" nor "in a mode")
  /// is a failure: the line is not counted as typed, nothing is marked as in the box, and it goes in once tmux answers again.
  @Test func aSendThatSaysNothingIsNotCountedAsSent() throws {
    let r = try warm()
    defer { r.teardown() }
    FileManager.default.createFile(atPath: r.muteSend, contents: nil)
    try r.wake("trip", ids: second)
    #expect(r.wait(5) { r.owed().until != nil }, "the pointer is not owed: \(r.owed())")
    r.heldReads(6)  // each is a tick's read of the mode, or a send that said nothing
    #expect(r.owed().until != nil && r.owed().enter == nil, "a send that said nothing was counted as typed: \(r.owed())")
    #expect(r.typedLines.count == 1, "\(r.typedLines)")
    unlink(r.muteSend)
    #expect(r.wait(10) { r.typedLines.count == 2 }, "\(r.typedLines)")
    #expect(r.typedLines.last == line, "\(r.typedLines)")
    #expect(r.wait(5) { r.owed().until == nil && r.owed().enter == nil }, "\(r.owed())")
  }
}
