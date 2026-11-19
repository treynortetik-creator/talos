import AppKit
import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport
import WebKit

@testable import TalosDesktop

/// A Run for the terminal pane, end to end with real ptys: the page vouches (`run_witness`) with the owner's own click, the bridge's
/// `pane_run` arrives, and the script reaches the owner's shell exactly once, as the script and Enter. Every way that must NOT write is
/// driven through the same real path and the shell's input is read back (empty), beside a control that proves the check can see input.
/// The window is the real `WebNSWindow` with events made the way `SyntheticInputGuiTests` makes them; the clock is a fake one. Needs
/// TALOS_GUI_TESTS=1.
@MainActor
@Suite("Shell pane run", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct ShellPaneRunGuiTests {
  typealias Rig = ShellPaneGuiTests.Rig
  static let A = "m_01HZZZZZZZZZZZZZZZZZZZZZZA"
  static let B = "m_01HZZZZZZZZZZZZZZZZZZZZZZB"
  static let SCRIPT = "echo hello\nls -la\n"

  /// A rig whose window is the real Talos window class, the channel and the window on one fake clock.
  @MainActor
  final class World {
    let r: Rig
    let w: WebNSWindow
    var t: Double = 1000
    /// Whether the window is key for the click stamp; a test flips it between a press and its release.
    var keyNow = true
    /// - editor: the stand-in shell turns on bracketed paste and ignores Ctrl+C, as a shell at its prompt does (the default one never does)
    /// - zshrc: a real zsh's startup file, to make its prompt late
    init(zsh: Bool = false, key: Bool = true, editor: Bool = true, zshrc: String? = nil) {
      _ = NSApplication.shared
      w = WebNSWindow(contentRect: CGRect(x: 0, y: 0, width: 1400, height: 900), styleMask: [.titled], backing: .buffered, defer: true)
      w.isReleasedWhenClosed = false
      r = Rig(window: w)
      if !zsh && editor {
        let path = r.dir + "/editor.sh"
        let body = """
          d='\(r.dir)'
          pwd -P > "$d/pwd.$$"
          env > "$d/env.$$"
          : > "$d/in.$$"
          trap '' INT
          printf '\\033[?2004h'
          echo $$ > "$d/up.$$"
          exec /bin/cat >> "$d/in.$$"
          """
        try? body.write(toFile: path, atomically: true, encoding: .utf8)
        r.pane.source.args = [path]
      }
      if zsh {
        let zdot = r.folder(for: "zdot")
        if let zshrc { try? zshrc.write(toFile: zdot + "/.zshrc", atomically: true, encoding: .utf8) }
        r.shell = .init(executable: "/bin/zsh", execName: "-zsh")
        r.pane.source.args = []
        r.pane.source.environment = { ShellPane.environment(from: ["PATH": "/usr/bin:/bin", "HOME": zdot, "ZDOTDIR": zdot]) }
      }
      w.setActivationClockForTest { [unowned self] in self.t }
      r.c.runChannel.setClockForTest { [unowned self] in self.t }
      if key {
        r.c.runChannel.setKeyCheckForTest { _ in true }
        w.setActivationKeyForTest { [unowned self] in self.keyNow }
      }
      r.signIn()
    }
    /// Opens the pane. Waits until the shell is at its prompt (bracketed paste on) unless told not to.
    func openPane(_ thread: String = "trip", waitReady: Bool = true) async {
      r.page(r.slot(thread))
      guard waitReady else { try? await Task.sleep(nanoseconds: 200_000_000); return }
      if !zshLike { await wait { self.r.up(thread) } }
      await wait { self.r.pane.viewsForTest(thread).first?.terminalStateSnapshot().bracketedPasteMode == true }
    }
    /// A person types into the shell (what AppKit hands the view for a typed line).
    func type(_ text: String) { r.pane.viewsForTest("trip").first?.send(txt: text) }
    func fileText(_ name: String) -> String? { try? String(contentsOfFile: r.dir + "/" + name, encoding: .utf8) }
    var zshLike: Bool { r.shell.executable.hasSuffix("zsh") }
    /// A person's click, then the page's witness, then the Run: the whole Run in one call.
    func clickWitnessRun(_ id: String = A, script: String = SCRIPT) async throws -> PaneRunAnswer {
      try humanClick()
      witness(id, script: script)
      return await run(id, script: script)
    }
    func end() { r.end() }

    func humanClick() throws {
      w.sendEvent(try guiMouse(.leftMouseDown, in: w))
      w.sendEvent(try guiMouse(.leftMouseUp, in: w))
    }
    func syntheticClick() throws {
      w.sendEvent(try guiMouse(.leftMouseDown, in: w, pid: Int64(getpid()), token: 7))
      w.sendEvent(try guiMouse(.leftMouseUp, in: w, pid: Int64(getpid()), token: 7))
    }
    /// The refusals the page was told of, in order (`run_result`).
    var told: [NativeToWeb] { r.sent.filter { if case .runResult = $0 { return true } else { return false } } }
    func witness(_ id: String = A, thread: String = "trip", script: String = SCRIPT) {
      r.page(#"{"type":"run_witness","thread_id":"\#(thread)","client_msg_id":"\#(id)","script_sha256":"\#(PaneRun.sha256Hex(script))"}"#)
    }
    func run(_ id: String = A, thread: String = "trip", script: String = SCRIPT) async -> PaneRunAnswer {
      await r.c.runChannel.run(PaneRunRequest(threadId: thread, script: script, clientMsgId: id))
    }
    func wait(_ cond: @escaping () -> Bool, seconds: Double = 10) async {
      let end = Date().addingTimeInterval(seconds)
      while !cond(), Date() < end { try? await Task.sleep(nanoseconds: 50_000_000) }
    }
    /// Nothing may have been read by any shell in this world.
    func quiet() async -> Bool {
      try? await Task.sleep(nanoseconds: 300_000_000)
      return r.allInput().isEmpty
    }
  }

  // MARK: the happy path

  @Test func aClickThenTheWitnessThenTheRunWritesOneBracketedPasteAndOneReturn() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    try x.humanClick()
    x.t += 0.5
    x.witness()
    x.t += 0.4  // the bridge's round trip
    #expect(await x.run() == .done)
    // always one bracketed paste and one Return; the Ctrl+C that cleared the line was eaten by the terminal, never read by the program
    let want = "\u{1b}[200~echo hello\nls -la\u{1b}[201~\n"
    await x.wait { x.r.allInput() == want }
    #expect(x.r.allInput() == want, "the shell read \(x.r.allInput().debugDescription)")
  }

  @Test func aRealZshRunsAMultiLineBlockAsOneUnit() async throws {
    let x = World(zsh: true)
    defer { x.end() }
    let out = x.r.dir + "/zsh-run.out"
    let script = "for n in 1 2 3\ndo\n  print -r -- $n >> '\(out)'\ndone\n"
    await x.openPane()
    try x.humanClick()
    x.witness(script: script)
    #expect(await x.run(script: script) == .done)
    await x.wait { ((try? String(contentsOfFile: out, encoding: .utf8)) ?? "").split(separator: "\n").count == 3 }
    #expect((try? String(contentsOfFile: out, encoding: .utf8)) == "1\n2\n3\n")
  }

  // MARK: what does not count

  @Test func aRunWithNoWitnessWritesNothing() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    #expect(await x.run() == .noWitness)
    #expect(await x.quiet())
  }

  @Test func aSyntheticClickWithinTwoSecondsDoesNotCount() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    try x.syntheticClick()
    for e in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      x.w.sendEvent(try guiMouse(e, in: x.w, pid: 4242))  // another process's event
      x.w.sendEvent(try guiMouse(e, in: x.w, state: 0))  // not the hardware state
    }
    x.w.sendEvent(try guiKey(.keyDown, in: x.w, pid: Int64(getpid()), token: 9))  // a synthetic Return
    x.witness()
    #expect(await x.run() == .noWitness)
    #expect(await x.quiet())
  }

  @Test func aHumanClickTwoPointOneSecondsAgoDoesNotCountAndTwoSecondsDoes() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    try x.humanClick()
    x.t += 2.1
    x.witness()
    #expect(await x.run() == .noWitness)
    #expect(await x.quiet())
    try x.humanClick()
    x.t += 2.0
    x.witness(Self.B)
    #expect(await x.run(Self.B) == .done, "two seconds exactly is inside the window")
  }

  @Test func aClickInAWindowThatIsNotKeyDoesNotCount() async throws {
    // the real check, no stand-in: this window was never shown, so it is not key
    let x = World(key: false)
    defer { x.end() }
    #expect(!x.w.isKeyWindow)
    await x.openPane()
    try x.humanClick()
    x.witness()
    #expect(await x.run() == .noWitness)
    #expect(await x.quiet())
  }

  @Test func aHumanReturnOrSpaceCountsAndAnotherKeyDoesNot() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    x.w.makeFirstResponder(x.r.wv)  // the page holds the keyboard
    x.w.sendEvent(try guiKey(.keyDown, in: x.w, chars: "a", code: 0))
    x.witness()
    #expect(await x.run() == .noWitness, "a letter is not a press of a button")
    x.w.sendEvent(try guiKey(.keyDown, in: x.w, chars: " ", code: 49))
    x.witness(Self.B)
    #expect(await x.run(Self.B) == .done)
  }

  @Test func theClickThatOnlyBringsTheWindowToTheFrontDoesNotCount() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    x.keyNow = false  // the press lands while another window is key
    x.w.sendEvent(try guiMouse(.leftMouseDown, in: x.w))
    x.keyNow = true  // and the window is key by the time it is released
    x.w.sendEvent(try guiMouse(.leftMouseUp, in: x.w))
    x.witness()
    #expect(await x.run() == .noWitness)
    #expect(await x.quiet())
    try x.humanClick()  // the next click, in a window that is key, does
    x.witness(Self.B)
    #expect(await x.run(Self.B) == .done)
  }

  @Test func oneClickVouchesForOneWitnessAndOnlyOne() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    try x.humanClick()
    x.witness(Self.A)
    x.witness(Self.B)  // the page asks again on the same click
    #expect(await x.run(Self.B) == .noWitness, "the click was spent by the first witness")
    #expect(await x.run(Self.A) == .done)
  }

  @Test func aRunThatArrivesBeforeItsWitnessWaitsForItAndOneWithNoWitnessIsRefusedAfterTheWait() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    async let early = x.run()  // the bridge's road was faster than the page's
    try await Task.sleep(nanoseconds: 300_000_000)
    try x.humanClick()
    x.witness()
    #expect(await early == .done)
    let started = Date()
    #expect(await x.run(Self.B) == .noWitness)
    let waited = Date().timeIntervalSince(started)
    #expect(waited >= PaneRun.witnessWaitSeconds - 0.1 && waited < PaneRun.witnessWaitSeconds + 3, "waited \(waited) s")
  }

  @Test func everyRunTheAppAcceptsOrRefusesIsToldToThePageByItsMessageIdWithAReason() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    try x.humanClick()
    x.witness(Self.A)
    #expect(await x.run(Self.A) == .done)
    #expect(await x.run(Self.B) == .noWitness)
    try x.humanClick()
    x.witness(Self.B)
    x.t += 30.1
    #expect(await x.run(Self.B) == .witnessExpired)
    x.t += 1
    try x.humanClick()
    x.witness("m_01HZZZZZZZZZZZZZZZZZZZZZZC")
    #expect(await x.run("m_01HZZZZZZZZZZZZZZZZZZZZZZC", thread: "other") == .mismatch)
    #expect(
      x.told == [
        .runResult(clientMsgId: Self.A, ok: true, reason: nil), .runResult(clientMsgId: Self.B, ok: false, reason: .noWitness),
        .runResult(clientMsgId: Self.B, ok: false, reason: .expired),
        .runResult(clientMsgId: "m_01HZZZZZZZZZZZZZZZZZZZZZZC", ok: false, reason: .noWitness),
      ], "\(x.told)")
  }

  @Test func aReturnOrAClickInTheNativeShellPaneIsNotAPersonPressingRun() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    let view = try #require(x.r.pane.viewsForTest("trip").first)
    // a person's Return, delivered to the terminal view that holds the keyboard
    x.w.makeFirstResponder(view)
    x.w.sendEvent(try guiKey(.keyDown, in: x.w, chars: "\r", code: 36))
    x.w.sendEvent(try guiKey(.keyDown, in: x.w, chars: " ", code: 49))
    x.witness()
    #expect(await x.run() == .noWitness, "a key typed into a shell stamps nothing")
    // a person's click on the terminal itself (and on the strip over it)
    let c = x.r.pane.container
    let inPane = x.r.wv.convert(NSPoint(x: c.frame.midX, y: c.frame.midY), to: nil)
    x.w.sendEvent(try guiMouse(.leftMouseDown, in: x.w, at: inPane))
    x.w.sendEvent(try guiMouse(.leftMouseUp, in: x.w, at: inPane))
    x.witness(Self.B)
    #expect(await x.run(Self.B) == .noWitness, "a click in the shell pane stamps nothing")
    // the control: with the page holding the keyboard, the same Return counts
    x.w.makeFirstResponder(x.r.wv)
    x.w.sendEvent(try guiKey(.keyDown, in: x.w, chars: "\r", code: 36))
    x.witness("m_01HZZZZZZZZZZZZZZZZZZZZZZC")
    #expect(await x.run("m_01HZZZZZZZZZZZZZZZZZZZZZZC") == .done)
  }

  @Test func aScriptWithAnEscapeOrAnyControlIsRefusedInBothFormsAndNothingIsWritten() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    let forms = [
      ("m_01HZZZZZZZZZZZZZZZZZZZZZZA", "echo a\u{1b}[201~\ntouch pwned\n"),  // 7-bit paste end
      ("m_01HZZZZZZZZZZZZZZZZZZZZZZB", "echo a\u{9b}201~\ntouch pwned\n"),  // 8-bit paste end
      ("m_01HZZZZZZZZZZZZZZZZZZZZZZC", "echo a\u{1b}]0;x\u{7}\n"),  // another escape sequence
      ("m_01HZZZZZZZZZZZZZZZZZZZZZZD", "echo a\u{0}b\n"),
    ]
    for (id, script) in forms {
      try x.humanClick()
      x.witness(id, script: script)  // vouched for, with the right hash: the script itself is what is refused
      let a = await x.run(id, script: script)
      #expect(a.code == "bad_script" && !a.ok, "\(script.debugDescription): \(a)")
    }
    #expect(await x.quiet())
    #expect(x.told.map { if case .runResult(_, let ok, let reason) = $0 { return ok ? "ok" : reason?.rawValue ?? "?" } else { return "?" } } == Array(repeating: "bad_script", count: 4), "the page is told why: the script holds a character that is not plain text")
    // the control: a plain script with the same words goes
    try x.humanClick()
    x.witness("m_01HZZZZZZZZZZZZZZZZZZZZZZE", script: "echo a\ntouch fine\n")
    #expect(await x.run("m_01HZZZZZZZZZZZZZZZZZZZZZZE", script: "echo a\ntouch fine\n") == .done)
  }

  @Test func aWitnessIsSingleUseAndAReplayOfTheRunOrTheWitnessIsRefused() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    try x.humanClick()
    x.witness()
    #expect(await x.run() == .done)
    await x.wait { !x.r.allInput().isEmpty }
    let first = x.r.allInput()
    #expect(await x.run() == .noWitness, "gone once used")
    try x.humanClick()
    x.witness()  // the page says it again, with a fresh click
    #expect(await x.run() == .noWitness, "a Run that already ran is never witnessed again")
    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(x.r.allInput() == first, "the script ran once")
  }

  @Test func aWitnessThatIsTooOldIsRefused() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    try x.humanClick()
    x.witness()
    x.t += 30.1
    #expect(await x.run() == .witnessExpired)
    #expect(await x.quiet())
  }

  @Test func aWitnessForOneRunDoesNotAuthoriseAnotherNorAnotherScriptNorAnotherThreadAndAMismatchBurnsIt() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    try x.humanClick()
    x.witness(Self.A)
    #expect(await x.run(Self.B) == .noWitness, "id B has no witness")
    #expect(await x.run(Self.A, script: "touch pwned\n") == .mismatch, "same id, another script")
    #expect(await x.quiet())
    #expect(await x.run(Self.A) == .noWitness, "a mismatch burned the witness: the right script cannot follow the wrong one")
    try x.humanClick()
    x.witness(Self.B)
    #expect(await x.run(Self.B, thread: "other") == .mismatch, "same id, another thread")
    #expect(await x.quiet())
  }

  @Test func theChannelOpensNoPaneAndWritesNothingWhenThePaneIsNotThereOrHasNoShell() async throws {
    let x = World()
    defer { x.end() }
    try x.humanClick()
    x.witness()
    let started = Date()
    #expect(await x.run() == .noPane, "no pane for the thread: nothing was started for it either")
    #expect(x.told.last == .runResult(clientMsgId: Self.A, ok: false, reason: .notStarted))
    #expect(Date().timeIntervalSince(started) < 10)
    #expect(x.r.pane.openThreadsForTest.isEmpty)
    #expect(await x.quiet())
  }

  @Test func aShellWithAProgramRunningInItIsBusyAndTheScriptIsNotTypedAtTheProgram() async throws {
    let x = World(zsh: true)
    defer { x.end() }
    await x.openPane()
    let view = try #require(x.r.pane.viewsForTest("trip").first)
    let marker = x.r.dir + "/started"
    view.send(txt: "touch '\(marker)'; /bin/sleep 60\n")
    await x.wait { FileManager.default.fileExists(atPath: marker) }
    try await Task.sleep(nanoseconds: 500_000_000)
    let out = x.r.dir + "/busy.out"
    let script = "print busy > '\(out)'\n"
    try x.humanClick()
    x.witness(script: script)
    #expect(await x.run(script: script) == .busy)
    #expect(x.told.last == .runResult(clientMsgId: Self.A, ok: false, reason: .paneBusy))
    try await Task.sleep(nanoseconds: 300_000_000)
    #expect(!FileManager.default.fileExists(atPath: out))
  }

  // MARK: the shell's line is the shell's: a real zsh in a pty

  @Test func aHalfTypedLineIsDiscardedFirstAndOnlyTheScriptRuns() async throws {
    let x = World(zsh: true)
    defer { x.end() }
    await x.openPane()
    x.type("echo BAD > '\(x.r.dir)/bad.out'; ")  // someone's partial command, no Return
    try await Task.sleep(nanoseconds: 300_000_000)
    let script = "echo GOOD > '\(x.r.dir)/good.out'\n"
    #expect(try await x.clickWitnessRun(script: script) == .done)
    await x.wait { x.fileText("good.out") != nil }
    #expect(x.fileText("good.out") == "GOOD\n")
    try await Task.sleep(nanoseconds: 500_000_000)
    #expect(x.fileText("bad.out") == nil, "the script was appended to the half-typed line and both ran")
  }

  @Test func aContinuationPromptIsAbortedNotCompleted() async throws {
    let x = World(zsh: true)
    defer { x.end() }
    await x.openPane()
    x.type("for i in 1; do\n")  // zsh now asks for the rest of the loop (PS2)
    try await Task.sleep(nanoseconds: 300_000_000)
    let script = "echo GOOD > '\(x.r.dir)/good.out'\n"
    #expect(try await x.clickWitnessRun(script: script) == .done)
    await x.wait { x.fileText("good.out") != nil }
    #expect(x.fileText("good.out") == "GOOD\n", "the script ran as a command of its own, not as the body of someone's open loop")
  }

  @Test func aSlowStartupProfileMakesTheRunWaitForThePromptAndThenItRuns() async throws {
    let x = World(zsh: true, zshrc: "sleep 1\n")
    defer { x.end() }
    await x.openPane(waitReady: false)  // the shell is still in its .zshrc
    let script = "echo GOOD > '\(x.r.dir)/good.out'\n"
    #expect(try await x.clickWitnessRun(script: script) == .done)
    await x.wait { x.fileText("good.out") != nil }
    #expect(x.fileText("good.out") == "GOOD\n")
  }

  @Test func aShellInReadIsBusyAndNothingIsTypedAtIt() async throws {
    let x = World(zsh: true)
    defer { x.end() }
    await x.openPane()
    x.type("read -r x\n")  // a builtin: the shell itself holds the terminal, but not at its line editor
    try await Task.sleep(nanoseconds: 500_000_000)
    let script = "echo PASTED > '\(x.r.dir)/bad.out'\n"
    #expect(try await x.clickWitnessRun(script: script) == .busy)
    #expect(x.told.last == .runResult(clientMsgId: Self.A, ok: false, reason: .paneBusy))
    // what `read` gets is only what the person types next
    x.type("typed by a person\n")
    x.type("print -r -- \"$x\" > '\(x.r.dir)/x.out'\n")
    await x.wait { x.fileText("x.out") != nil }
    #expect(x.fileText("x.out") == "typed by a person\n", "read got \(String(describing: x.fileText("x.out")))")
    #expect(x.fileText("bad.out") == nil)
  }

  @Test func aTabInAScriptIsPastedAndNotCompleted() async throws {
    let x = World(zsh: true)
    defer { x.end() }
    await x.openPane()
    let script = "print -rn -- \"a\tb\" > '\(x.r.dir)/tab.out'\n"
    #expect(try await x.clickWitnessRun(script: script) == .done)
    await x.wait { x.fileText("tab.out") != nil }
    #expect(x.fileText("tab.out") == "a\tb")
  }

  @Test func aShellThatNeverTurnedOnBracketedPasteIsNeverWrittenToAndTheOwnerIsToldItIsBusy() async throws {
    let x = World(editor: false)  // the plain stand-in: no line editor, never asks for a paste
    defer { x.end() }
    await x.openPane()
    #expect(try await x.clickWitnessRun() == .busy)
    #expect(await x.quiet(), "nothing was typed at a shell that was not at its line editor")
  }

  // MARK: the Run's budget, one at a time, a slow prompt

  @Test func aRunPastItsBudgetWritesNothingAndIsRefusedBusy() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    try await Task.sleep(nanoseconds: 400_000_000)  // the shell has had its moment to start (PaneRun.shellStartSeconds)
    var n = 0
    x.r.c.runChannel.setBudgetClockForTest { n += 1; return n == 1 ? 0 : 100 }  // the first look is the start; every later one is long past it
    let a = try await x.clickWitnessRun()
    #expect(a == .busy, "\(a)")
    #expect(x.r.pane.writesForTest.isEmpty, "not even the Ctrl+C: \(x.r.pane.writesForTest)")
    #expect(x.told.last == .runResult(clientMsgId: Self.A, ok: false, reason: .paneBusy))
    #expect(await x.quiet())
  }

  @Test func aBudgetThatRunsOutAfterTheCtrlCNeverPastes() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    try await Task.sleep(nanoseconds: 400_000_000)
    let pane = x.r.pane
    x.r.c.runChannel.setBudgetClockForTest { pane.writesForTest.isEmpty ? 0 : 100 }  // in time until the line was cleared, then out of it
    #expect(try await x.clickWitnessRun() == .busy)
    #expect(pane.writesForTest == [[0x03]], "only the Ctrl+C went; the paste did not: \(pane.writesForTest)")
    #expect(await x.quiet())
  }

  @Test func twoRunsForOneShellAreSerializedAndEachIsWholeInTheShellsInput() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    let s1 = "echo one\n", s2 = "echo two\n"
    let b = "m_01HZZZZZZZZZZZZZZZZZZZZZZB"
    try x.humanClick()
    x.witness(Self.A, script: s1)
    try x.humanClick()
    x.witness(b, script: s2)
    async let first = x.run(Self.A, script: s1)
    async let second = x.run(b, script: s2)
    let (r1, r2) = await (first, second)
    #expect(r1 == .done && r2 == .done)
    #expect(x.r.pane.maxRunsInFlightForTest == 1, "two runScript calls were in the shell at once")
    let paste = { (s: String) in "\u{1b}[200~\(s.dropLast())\u{1b}[201~\n" }
    await x.wait { x.r.allInput().count == paste(s1).count + paste(s2).count }
    #expect([paste(s1) + paste(s2), paste(s2) + paste(s1)].contains(x.r.allInput()), "interleaved: \(x.r.allInput().debugDescription)")
  }

  @Test func aPromptWithASlowHookStillGetsItsRunBecauseTheShellHasThreeSecondsToComeBack() async throws {
    let x = World(zsh: true, zshrc: "precmd() { sleep 1.5 }\n")  // a synchronous git prompt, say
    defer { x.end() }
    await x.openPane()
    let script = "echo GOOD > '\(x.r.dir)/good.out'\n"
    let started = Date()
    #expect(try await x.clickWitnessRun(script: script) == .done)
    #expect(Date().timeIntervalSince(started) < PaneRun.totalBudgetSeconds)
    await x.wait { x.fileText("good.out") != nil }
    #expect(x.fileText("good.out") == "GOOD\n")
  }

  // MARK: the click that brought the window forward

  @Test func aPressRightAfterTheAppBecameActiveOrTheWindowBecameKeyIsNotARunPress() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    // driven by the notifications the system posts, not by flags
    NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
    x.t += 0.2
    try x.humanClick()
    x.witness()
    #expect(await x.run() == .noWitness, "a press 0.2 s after the app became active only brought it forward")
    x.t += 0.4  // 0.6 s on
    #expect(try await x.clickWitnessRun(Self.B) == .done, "and a press well after it counts")
    NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: x.w)
    x.t += 0.3
    try x.humanClick()
    x.witness("m_01HZZZZZZZZZZZZZZZZZZZZZZC")
    #expect(await x.run("m_01HZZZZZZZZZZZZZZZZZZZZZZC") == .noWitness, "the same for the window becoming key")
    // another window becoming key says nothing about this one
    x.t += 1
    NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: NSWindow())
    x.t += 0.1
    #expect(try await x.clickWitnessRun("m_01HZZZZZZZZZZZZZZZZZZZZZZD") == .done)
  }

  // MARK: off reaches the live thing

  @Test func signOutAndANewDocumentTakeWhatThePageVouchedForWithThem() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    try x.humanClick()
    x.witness()
    x.r.c.forgetShellPaneSlot()  // a new document
    #expect(await x.run() == .noWitness)
    try x.humanClick()
    x.witness(Self.B)
    x.r.c.endShellPanes()  // sign out
    #expect(await x.run(Self.B) == .noPane, "signing out bars every run")
    #expect(await x.quiet())
    x.t += 0.1
    try x.humanClick()
    x.witness(Self.A)
    #expect(await x.run(Self.A) == .noPane, "no pane opens again until a new page has loaded")
  }

  // MARK: every entry point, through the real channel

  private func socketAnswer(_ p: ScreenProtocol, _ o: [String: Any]) async throws -> [String: Any] {
    let d = await p.answer(try JSONSerialization.data(withJSONObject: o))
    return try #require(try JSONSerialization.jsonObject(with: d) as? [String: Any])
  }

  @Test func throughTheSocketOnlyAWitnessedPaneRunReachesTheShellAndNoOtherMessageDoes() async throws {
    let x = World()
    defer { x.end() }
    await x.openPane()
    let p = ScreenProtocol(
      service: FakeGuiScreenService(), allowList: EmptyScreenAllowList(), signing: FakeGuiSigning(), paneRun: x.r.c.runChannel)
    // an unwitnessed pane_run, and every other op the socket has, with text that would run if it got through
    let pane: [String: Any] = ["v": 1, "id": "r1", "op": "pane_run", "thread_id": "trip", "script": Self.SCRIPT, "client_msg_id": Self.A]
    let refused = try await socketAnswer(p, pane)
    #expect(refused["ok"] as? Bool == false)
    #expect((refused["error"] as? [String: Any])?["code"] as? String == "no_witness")
    for op in ["type", "key", "click", "scroll", "apps", "shot", "open_app", "ask_info", "allow", "pane_status", "pane_runs"] {
      _ = try await socketAnswer(p, ["v": 1, "op": op, "text": "touch pwned\n", "keys": "return", "x": 5, "y": 5, "script": Self.SCRIPT])
    }
    #expect(await x.quiet())
    // the same socket, with the owner's click and the page's witness: it runs
    try x.humanClick()
    x.witness()
    let done = try await socketAnswer(p, pane)
    #expect(done["ok"] as? Bool == true)
    let want = "\u{1b}[200~echo hello\nls -la\u{1b}[201~\n"
    await x.wait { x.r.allInput() == want }
    #expect(x.r.allInput() == want)
  }

  @Test func theNativeMenuAndTheAgentTerminalHoldNoWayToTheOwnersShell() async throws {
    // the menu, the sign-in pane and the screen tools hold the pane only through the window (a source scan runs in the default suite,
    // ShellPaneReachTests); here: a witness sent by the page with a script in it, or keys aimed at the view by an agent, write nothing
    let x = World()
    defer { x.end() }
    await x.openPane()
    #expect(!x.r.page(#"{"type":"run_witness","thread_id":"trip","client_msg_id":"\#(Self.A)","script_sha256":"\#(PaneRun.sha256Hex(Self.SCRIPT))","script":"touch pwned\n"}"#))
    let view = try #require(x.r.pane.viewsForTest("trip").first)
    x.w.makeFirstResponder(view)
    x.w.sendEvent(try guiKey(.keyDown, in: x.w, chars: "x", code: 7, pid: Int64(getpid()), token: 11))
    #expect(await x.quiet())
  }
}

/// A screen service that does nothing and refuses everything: the socket's other ops are driven, and none of them can type anywhere.
final class FakeGuiScreenService: ScreenService, @unchecked Sendable {
  func shot(area: ScreenArea, allowed: ScreenAllowed) async throws(ScreenRefusal) -> ScreenShot { throw .badRequest("fake") }
  func input(_ request: ScreenInputRequest, allowed: ScreenAllowed) throws(ScreenRefusal) -> Int { throw .badRequest("fake") }
  func listApps() -> [ScreenApp] { [] }
  func open(bundleID: String, allowed: ScreenAllowed) async throws(ScreenRefusal) { throw .badRequest("fake") }
}

final class FakeGuiSigning: ScreenCodeSigning, @unchecked Sendable {
  func isApple(pid: Int32, identifier: String) -> Bool { false }
  func lookup(pid: Int32) -> ScreenCodeLookup { .gone }
  func lookup(appPath: String) -> ScreenCodeLookup { .gone }
  func matches(pid: Int32, app: ScreenAllowedApp) -> Bool { false }
  func matches(appPath: String, app: ScreenAllowedApp) -> Bool { false }
}
