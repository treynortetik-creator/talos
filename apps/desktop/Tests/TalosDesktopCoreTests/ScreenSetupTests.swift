import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// Fake prompts: counts each ask and answers what the test says macOS would.
final class FakeGrants: ScreenGrantActions, @unchecked Sendable {
  private let lock = NSLock()
  private var _screen = 0
  private var _ax = 0
  var answer = false
  var screenAsks: Int { lock.withLock { _screen } }
  var axAsks: Int { lock.withLock { _ax } }
  func requestScreenRecording() -> Bool {
    lock.withLock { _screen += 1 }
    return answer
  }
  func requestAccessibility() -> Bool {
    lock.withLock { _ax += 1 }
    return answer
  }
}

/// A permission probe the test can flip while a model holds it.
final class FlipPermissions: ScreenPermissionProbe, @unchecked Sendable {
  var screen: Bool
  var ax: Bool
  init(screen: Bool, ax: Bool) {
    self.screen = screen
    self.ax = ax
  }
  func screenRecording() -> Bool { screen }
  func accessibility() -> Bool { ax }
}

@Suite("Screen setup: the live test of the screen helper")
struct ScreenLiveTestTests {
  @Test func bothPartsWorkThroughTheRealCoreAndTheCaptureIsFiltered() async throws {
    let cap = FakeCapture(Fx.content(), colours: Fx.colours)
    let input = FakeInput()
    let r = await Fx.core(capture: cap, input: input).liveTest(signing: FakeSigning())
    #expect(r == ScreenLiveTest(see: .working, control: .working))
    // the agent's own filter, with no app allowed: only the desktop picture is named, never the whole display
    #expect(cap.plans.count == 1)
    guard case .display(_, let only?) = cap.plans.first?.source else {
      Issue.record("the live test must capture through the filter, never unfiltered")
      return
    }
    #expect(only.map(\.id) == [Fx.wallpaper.id])
    // the probe posts nothing an app would see
    #expect(input.posted.isEmpty)
    #expect(input.probes == 1)
  }

  @Test func eachPartFailsInPlainWordsAndNothingIsAsked() async {
    let noScreen = await Fx.core(permissions: FakePermissions(screen: false)).liveTest(signing: FakeSigning())
    #expect(noScreen.see == .failed("macOS hasn't allowed it yet: open Privacy & Security → Screen & System Audio Recording and turn on Talos."))
    #expect(noScreen.control == .working)
    let input = FakeInput()
    let noAX = await Fx.core(input: input, permissions: FakePermissions(ax: false)).liveTest(signing: FakeSigning())
    #expect(noAX.control == .failed("macOS hasn't allowed it yet: open Privacy & Security → Accessibility and turn on Talos."))
    #expect(input.probes == 0, "no probe without the grant")
    let cap = FakeCapture(Fx.content(), colours: Fx.colours)
    cap.listError = Boom(text: "window list gone")
    #expect(await Fx.core(capture: cap).liveTest(signing: FakeSigning()).see == .failed(ScreenRefusal.filterUnavailable("window list gone").reason))
    let broken = FakeInput()
    broken.probeError = ScreenRefusal.accessibilityNotGranted
    #expect(await Fx.core(input: broken).liveTest(signing: FakeSigning()).control == .failed(ScreenSetupText.missing(.accessibility)))
    broken.probeError = Boom(text: "tap gone")
    #expect(await Fx.core(input: broken).liveTest(signing: FakeSigning()).control == .failed("Talos couldn't send a test event: tap gone."))
  }
}

@Suite("Screen setup: the Permissions rows")
struct ScreenSetupModelTests {
  func model(
    _ p: FlipPermissions, _ g: FakeGrants = FakeGrants(), test: ScreenLiveTest = .init(see: .working, control: .working),
    serving: String? = nil
  ) -> ScreenSetupModel {
    ScreenSetupModel(permissions: p, grants: g, test: { test }, serving: { serving })
  }

  @Test func aTickOnlyAfterTheLiveTestSaysWorking() async {
    let m = model(FlipPermissions(screen: true, ax: true))
    #expect(m.rows.map(\.status) == [ScreenSetupText.notTested, ScreenSetupText.notTested])
    #expect(m.state(.screenRecording) == .missing, "a grant alone is not a tick")
    await m.runTest()
    #expect(m.rows.map(\.status) == ["Working", "Working"])
    #expect(m.state(.screenRecording) == .granted && m.state(.accessibility) == .granted)
  }

  @Test func aGrantedPermissionWhoseTestFailsShowsTheReason() async {
    let m = model(FlipPermissions(screen: true, ax: true), test: .init(see: .failed("The screenshot failed: x."), control: .working))
    await m.runTest()
    #expect(m.rows[0].status == "The screenshot failed: x." && m.state(.screenRecording) == .missing)
    #expect(m.state(.accessibility) == .granted)
  }

  @Test func missingGrantsSayWhereToTurnThemOn() {
    let m = model(FlipPermissions(screen: false, ax: false))
    #expect(m.rows[0].status == ScreenSetupText.missing(.screenRecording))
    #expect(m.rows[1].status == ScreenSetupText.missing(.accessibility))
    #expect(m.rows[0].settingsURL == PermissionsModel.settingsBase + "Privacy_ScreenCapture")
    #expect(m.rows[1].settingsURL == PermissionsModel.settingsBase + "Privacy_Accessibility")
  }

  @Test func grantAsksMacOSOnlyWhenPressedAndScreenRecordingNeedsAReopen() async {
    let g = FakeGrants()
    let p = FlipPermissions(screen: false, ax: false)
    let m = model(p, g)
    _ = m.rows
    await m.runTest()
    #expect(g.screenAsks == 0 && g.axAsks == 0, "looking and testing never ask macOS")
    m.grant(.screenRecording)
    #expect(g.screenAsks == 1 && g.axAsks == 0)
    #expect(m.showReopen, "macOS counts Screen Recording only after Talos reopens")
    #expect(ScreenSetupText.reopen == "After you turn on Screen Recording, macOS needs Talos to Quit & Reopen. Your agent keeps running.")
    m.grant(.accessibility)
    #expect(g.axAsks == 1)
    g.answer = true
    let m2 = model(p, g)
    m2.grant(.screenRecording)
    #expect(!m2.showReopen)
  }

  /// The stale-entry line: Grant pressed, Talos relaunched, macOS still says no. Two runs are two memories on the same file with
  /// different run tokens, as two processes of Talos would be (the real FileScreenGrantMemory, in a scratch folder).
  @Test func grantPressedThenStillNoAfterARelaunchSaysHowToRemoveTheOldEntry() throws {
    let dir = TestTemp.base + "grant-mem-" + UUID().uuidString
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let file = dir + "/Talos/screen-grant-pressed"
    let p = FlipPermissions(screen: false, ax: false)
    let g = FakeGrants()
    func run(_ token: String) -> ScreenSetupModel {
      ScreenSetupModel(
        permissions: p, grants: g, test: { .init(see: .working, control: .working) },
        memory: FileScreenGrantMemory(path: file, run: token))
    }
    let first = run("run-1")
    #expect(!first.showStaleEntry, "never pressed: nothing to say")
    first.grant(.screenRecording)
    #expect(first.showReopen && !first.showStaleEntry, "the same run says Quit & Reopen, not the old-entry line")
    #expect(FileManager.default.fileExists(atPath: file))
    // Talos reopens and macOS still says no
    let second = run("run-2")
    #expect(second.showStaleEntry)
    #expect(
      ScreenSetupText.staleEntry
        == "macOS may still hold an old Talos entry. In System Settings → Privacy & Security → Screen & System Audio Recording, select Talos, press −, then Allow here again.")
    #expect(g.screenAsks == 1, "showing the line asks macOS nothing")
    // pressing Grant again in this run: the line waits for the next relaunch
    second.grant(.screenRecording)
    #expect(!second.showStaleEntry)
    #expect(run("run-3").showStaleEntry, "still no after another relaunch: the line comes back")
    // macOS says yes: the line goes and the press is forgotten, so a later revoke does not bring the line back on its own
    p.screen = true
    #expect(!run("run-4").showStaleEntry)
    #expect(!FileManager.default.fileExists(atPath: file))
    p.screen = false
    #expect(!run("run-5").showStaleEntry)
  }

  /// The Permissions panel builds its model with the file memory in Talos's support folder and shows the line.
  @Test func thePermissionsPanelWiresTheMemoryAndTheLine() throws {
    let desktop = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let view = try String(contentsOf: desktop.appendingPathComponent("Sources/TalosDesktop/PermissionsView.swift"), encoding: .utf8)
    #expect(view.contains(#"memory: FileScreenGrantMemory(path: SupervisorController.supportDir + "/screen-grant-pressed")"#))
    #expect(view.contains("if screen.showStaleEntry {") && view.contains("ScreenSetupText.staleEntry"))
  }

  @Test func withoutAMemoryTheLineNeverShows() {
    let m = model(FlipPermissions(screen: false, ax: false))
    m.grant(.screenRecording)
    #expect(!m.showStaleEntry)
  }

  @Test func aScreenHelperThatIsNotRunningIsSaidSoWhateverTheGrants() async {
    let m = model(FlipPermissions(screen: true, ax: true), serving: "another Talos app already answers on /home/alex/.talos/run/screen.sock")
    await m.runTest()
    #expect(m.rows.allSatisfy { $0.status?.hasPrefix("The screen helper isn't running") == true && !$0.working })
  }

  @Test func theRowsInThePermissionsListHaveAGrantButtonNotJustSettings() {
    let rows = PermissionsModel.rows { _ in .missing }
    #expect(rows.first { $0.kind == .screenRecording }?.button == .grant(PermissionsModel.settingsBase + "Privacy_ScreenCapture"))
    #expect(rows.first { $0.kind == .accessibility }?.button == .grant(PermissionsModel.settingsBase + "Privacy_Accessibility"))
    #expect(rows.first { $0.kind == .screenRecording }?.stateNote == ScreenSetupText.missing(.screenRecording))
    #expect(rows.first { $0.kind == .accessibility }?.stateNote == ScreenSetupText.missing(.accessibility))
  }
}
