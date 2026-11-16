import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Claude Code (2.1.319, 2.1.322) never prints the channels registration notice on a RESUMED session: after the Enter the warning goes and the
/// old conversation shows, ending in Claude's input box (the fake's `FAKE_RESUMED=1`). Main is running then, without any notice; the
/// `noNotice` stop is only for a warning still on screen `noticeWait` after our Enter. Every Enter the app sends sets `confirmSentAt`: the
/// auto-accept, the tap on the card and the click on the Mac popup are tested alike. An unreadable screen stays as it was
/// (`SupervisorStallTests.aScreenReadOutagePastTheNoticeDeadline...`: still starting, nothing stopped, the start-stalled alarm at `startWait`).
private func keyedEnv(_ keys: KeyLog, resumed: Bool = true, sticky: Bool = false) -> [String: String] {
  var e = ["FAKE_DLG_KEYLOG": keys.path]
  if resumed { e["FAKE_RESUMED"] = "1" }
  if sticky { e["FAKE_STICKY"] = "1" }
  return e
}

private func noticeStopAudited(_ r: Rig) -> Bool { r.audit.contains(" auto_confirm_no_notice session=") }

extension Rig {
  /// The Enter has been sent; the notice wait (15 s) is over by the supervisor's clock; a few passes run.
  fileprivate func pastTheNoticeWait() {
    clock.advance(20)
    for _ in 0..<5 { sup.tickNow() }
  }
}

@Suite("A resumed session prints no registration notice", .serialized)
struct NoNoticeRunningTests {
  // MARK: the three ways the Enter is sent

  @Test(arguments: bothHosts)
  func autoConfirmThenTheResumedConversationIsRunning(kind: HostKind) throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: keyedEnv(keys))
    defer { r.teardown() }
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return r.autoConfirms == 1 }, "audit: \(r.audit)")
    #expect(r.wait(10) { !r.screenContains(DialogMatcher.Strings.devTitle) }, "the warning is gone")
    r.pastTheNoticeWait()
    #expect(isRunning(r.phase()), "\(r.phase()), audit: \(r.audit)")
    #expect(r.audit.contains(" auto_confirm_ok session="), "audit: \(r.audit)")
    #expect(!noticeStopAudited(r) && !r.allEvents.contains(.confirmFailed) && stopReason(r.phase()) == nil)
    #expect(r.sup.status.needsYou == nil, "\(String(describing: r.sup.status.needsYou))")
    #expect(r.starts.count == 1 && keys.presses == ["ENTER"], "\(r.starts) \(keys.keys)")
  }

  @Test(arguments: bothHosts)
  func cardTapThenTheResumedConversationIsRunning(kind: HostKind) throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: keyedEnv(keys), launchConfirmed: false)
    defer { r.teardown() }
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    try r.tap(o, owner: owner, choice: 0, control: "ctl_1")
    let cap: Double = kind == .tmux ? 30 : 10
    #expect(r.wait(cap) { r.sup.tickNow(); return r.audit.contains("dev_card_answered") }, "keys \(keys.keys), audit: \(r.audit)")
    #expect(r.wait(10) { !r.screenContains(DialogMatcher.Strings.devTitle) }, "the warning is gone")
    r.pastTheNoticeWait()
    #expect(isRunning(r.phase()), "\(r.phase()), audit: \(r.audit)")
    #expect(!noticeStopAudited(r) && !r.allEvents.contains(.confirmFailed))
    #expect(keys.presses == ["ENTER"] && r.autoConfirms == 0, "\(keys.keys)")
    #expect(r.config.confirmedLaunch == nil && r.config.confirmedLaunchMac == nil, "a card tap starts this launch only: it seals nothing")
  }

  @Test func popupClickThenTheResumedConversationIsRunning() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: keyedEnv(keys), launchConfirmed: false)
    defer { r.teardown() }
    r.start()
    let item = try #require(r.waitForPopup(), "no popup item: audit \(r.audit)")
    let res = r.popupClick(item, choice: 0)
    #expect(res == .pressed(choice: 0, label: "I am using this for local development"), "\(String(describing: res)) audit \(r.audit)")
    #expect(r.wait(10) { !r.screenContains(DialogMatcher.Strings.devTitle) }, "the warning is gone")
    r.pastTheNoticeWait()
    #expect(isRunning(r.phase()), "\(r.phase()), audit: \(r.audit)")
    #expect(!noticeStopAudited(r) && !r.allEvents.contains(.confirmFailed))
    #expect(keys.presses == ["ENTER"], "\(keys.keys)")
    #expect(r.sealed, "the click is still the owner's confirm")
  }

  // MARK: unchanged

  /// The Mac's own Enter did nothing and the warning is still up: it is offered to the owner, and while that offer stands nothing
  /// stops Main, however long past the notice wait (the popup and the phone both say it is waiting for him). The stop that stays is
  /// for the warning still on screen after HIS key: then nobody is left to answer it.
  @Test(arguments: bothHosts)
  func anOfferedWarningIsNeverStoppedUntilTheOwnersOwnKeyAlsoFails(kind: HostKind) throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: keyedEnv(keys, resumed: false, sticky: true))
    defer { r.teardown() }
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return r.autoConfirms == 1 }, "audit: \(r.audit)")
    #expect(r.screenContains(DialogMatcher.Strings.devTitle), "the Enter did nothing: the warning is still up")
    let item = try #require(r.waitForPopup(), "the warning that stayed is offered: \(r.audit)")
    r.pastTheNoticeWait()
    r.pastTheNoticeWait()
    #expect(r.phase() == .starting, "left for the owner: \(r.phase()), audit: \(r.audit)")
    #expect(!noticeStopAudited(r) && !r.allEvents.contains(.confirmFailed), "audit: \(r.audit)")
    #expect(r.mainPopup?.dialog.id == item.dialog.id, "the same offer still stands")

    // his click: the key goes (the fake swallows it too), and now the stop is right
    let res = r.popupClick(item, choice: 0)
    #expect(res == .pressed(choice: 0, label: "I am using this for local development"), "\(String(describing: res)), audit: \(r.audit)")
    #expect(r.wait(10) { keys.presses == ["ENTER", "ENTER"] }, "\(keys.keys)")
    r.pastTheNoticeWait()
    #expect(r.wait(10) { r.sup.tickNow(); return stopReason(r.phase()) == .noNotice }, "\(r.phase()), audit: \(r.audit)")
    #expect(noticeStopAudited(r) && !r.audit.contains("auto_confirm_no_notice_running"))
    #expect(r.wait(5) { r.allEvents.contains(.confirmFailed) })
  }

  /// ... and when his click does take, Main is running: the offer was worth keeping.
  @Test(arguments: bothHosts)
  func theOwnersClickOnAnOfferKeptPastTheNoticeWaitStartsMain(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-twice.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return r.autoConfirms == 1 }, "audit: \(r.audit)")
    let item = try #require(r.waitForPopup(), "the second appearance is offered: \(r.audit)")
    r.pastTheNoticeWait()
    r.pastTheNoticeWait()
    #expect(r.phase() == .starting && !noticeStopAudited(r), "\(r.phase()), audit: \(r.audit)")
    let res = r.popupClick(try #require(r.mainPopup ?? item), choice: 0)
    #expect(res == .pressed(choice: 0, label: "I am using this for local development"), "\(String(describing: res)), audit: \(r.audit)")
    #expect(r.wait(30) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.starts.count == 1 && r.autoConfirms == 1 && r.sup.status.needsYou == nil)
  }

  /// A fresh start prints the notice: running at once (no wait), confirmed as before, and the new rule never fires.
  @Test(arguments: bothHosts)
  func aFreshStartThatPrintsTheNoticeIsRunningAsBefore(kind: HostKind) throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: keyedEnv(keys, resumed: false))
    defer { r.teardown() }
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.audit.contains(" auto_confirm_ok session="), "audit: \(r.audit)")
    r.pastTheNoticeWait()
    #expect(isRunning(r.phase()) && r.starts.count == 1)
    #expect(!r.audit.contains("auto_confirm_no_notice"), "audit: \(r.audit)")
  }
}
