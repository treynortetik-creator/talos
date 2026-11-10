import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Main's development-channels warning on the Mac's own Needs-you popup. The bridge is Main's child, so while Main sits on the warning no
/// bridge runs and no card is posted: the popup is the way. A real click on "I am using this for local development" seals the launch (the
/// key is made if there is none); "Exit" stores nothing and leaves Main stopped; a pane Enter still seals nothing. The phone gets one plain
/// line per start from the Mac itself (`talos-app post`), which needs no bridge. Auto-accept is off where the dialog must stay on screen
/// (`launchConfirmed: false`).
private final class NoWorkers: NeedsYouPopupSource, @unchecked Sendable {
  private let lock = NSLock()
  private var asked: [String] = []
  var threads: [String] { lock.withLock { asked } }
  func popupOffers() -> [NeedsYouPopupItem] { [] }
  func popupAnswer(thread: String, dialogId: String, action: NeedsYouPopupAction, completion: @escaping @Sendable (PopupAnswerResult) -> Void) {
    lock.withLock { asked.append(thread) }
    completion(.nothing(.notOffered))
  }
}

private final class Answer: @unchecked Sendable {
  private let lock = NSLock()
  private var value: PopupAnswerResult?
  func set(_ r: PopupAnswerResult) { lock.withLock { value = r } }
  var result: PopupAnswerResult? { lock.withLock { value } }
}

extension Rig {
  var mainPopup: NeedsYouPopupItem? { sup.mainPopupItem() }

  /// The popup's button, as the controller wires it: through the source. Waits for the answer.
  @discardableResult
  fileprivate func popupClick(_ item: NeedsYouPopupItem, choice: Int, id: String? = nil, label: String? = nil, workers: NeedsYouPopupSource = NoWorkers()) -> PopupAnswerResult? {
    let source = MainAndWorkersPopupSource(workers: workers, main: sup)
    let got = Answer()
    let sem = DispatchSemaphore(value: 0)
    let text = label ?? (item.dialog.options.indices.contains(choice) ? item.dialog.options[choice] : "")
    source.popupAnswer(thread: item.thread, dialogId: id ?? item.dialog.id, action: .choose(choice, label: text)) {
      got.set($0)
      sem.signal()
    }
    guard sem.wait(timeout: .now() + 30) == .success else { return nil }
    return got.result
  }

  func waitForPopup(_ cap: Double = 30) -> NeedsYouPopupItem? { poll(cap) { sup.tickNow(); return mainPopup } }
  var sealed: Bool {
    let c = config
    return LaunchSeal.isConfirmed(c, fingerprint: c.launchFingerprint(resolvedClaude: c.claudePath), parts: c.launchParts(resolvedClaude: c.claudePath), trust: trust)
  }
}

private func keyed(_ keys: KeyLog) -> [String: String] { ["FAKE_DLG_KEYLOG": keys.path] }

@Suite("Main's dev-channels warning on the Mac popup", .serialized)
struct DevChannelsPopupTests {
  /// Accept by a real click: the key goes after a fresh look at the screen, the launch is sealed, and the next start is automatic.
  @Test func aClickOnAcceptSealsTheLaunchAndTheNextStartIsAutomatic() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: keyed(keys), launchConfirmed: false)
    defer { r.teardown() }
    r.start()
    let item = try #require(r.waitForPopup(), "no popup item: audit \(r.audit)")
    #expect(item.thread == Supervisor.mainPopupThread && item.threadName == "Main")
    #expect(item.dialog.options == ["I am using this for local development", "Exit"])
    #expect(!r.sealed)
    let res = r.popupClick(item, choice: 0)
    #expect(res == .pressed(choice: 0, label: "I am using this for local development"), "\(String(describing: res)) audit \(r.audit)")
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(keys.presses == ["ENTER"], "\(keys.keys)")
    #expect(r.sealed && r.trust.hasKey, "the click sealed the launch")
    r.sup.restartCold()
    #expect(r.wait(60) { r.sup.tickNow(); return r.starts.count == 2 && isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.autoConfirms == 1, "the second start was answered by the app: \(r.audit)")
    #expect(keys.presses == ["ENTER", "ENTER"], "\(keys.keys)")
  }

  /// Nothing seals from a call that is not the popup's click on Accept: another dialog id, a label that is not the row, the login "open"
  /// action. (A press of the button without a mouse event is stopped in the view: NeedsYouPopupGuiTests.)
  @Test func aCallThatIsNotAClickOnTheOfferedAcceptSealsNothing() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: keyed(keys), launchConfirmed: false)
    defer { r.teardown() }
    r.start()
    let item = try #require(r.waitForPopup(), "audit: \(r.audit)")
    #expect(r.popupClick(item, choice: 0, id: "ZZZZZZZZZZZZZZZZZZZZZZ") == .nothing(.notOffered))
    #expect(r.popupClick(item, choice: 0, label: "Exit") == .nothing(.screenChanged))
    #expect(r.popupClick(item, choice: 7) == .nothing(.screenChanged))
    let source = MainAndWorkersPopupSource(workers: NoWorkers(), main: r.sup)
    let sem = DispatchSemaphore(value: 0)
    let got = Answer()
    source.popupAnswer(thread: Supervisor.mainPopupThread, dialogId: item.dialog.id, action: .open) { got.set($0); sem.signal() }
    _ = sem.wait(timeout: .now() + 10)
    #expect(got.result == .nothing(.notOffered))
    #expect(keys.presses.isEmpty && !r.sealed && r.config.confirmedLaunch == nil, "\(keys.keys)")
    #expect(r.mainPopup?.dialog.id == item.dialog.id, "the offer still stands")
  }

  /// A pane Enter confirms that start only: no seal, so the next start asks again.
  @Test func aPaneEnterStillSealsNothing() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: keyed(keys), launchConfirmed: false)
    defer { r.teardown() }
    r.start()
    _ = try #require(r.waitForPopup(), "audit: \(r.audit)")
    r.humanEnter()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) && r.offer == nil }, "\(r.phase())")
    #expect(!r.sealed && r.config.confirmedLaunchMac == nil && !r.trust.hasKey)
    r.sup.restartCold()
    #expect(r.wait(30) { r.sup.tickNow(); return r.starts.count == 2 && r.offer != nil }, "asked again: audit \(r.audit)")
    #expect(r.autoConfirms == 0)
  }

  /// Exit by a click: Down, then Enter on "Exit"; nothing stored; Main stays stopped.
  @Test func aClickOnExitStoresNothingAndMainStaysStopped() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: keyed(keys), launchConfirmed: false)
    defer { r.teardown() }
    r.start()
    let item = try #require(r.waitForPopup(), "audit: \(r.audit)")
    let res = r.popupClick(item, choice: 1)
    #expect(res == .pressed(choice: 1, label: "Exit"), "\(String(describing: res)) audit \(r.audit)")
    #expect(r.wait(10) { r.sup.tickNow(); return r.phase() == .stopped(.user) }, "\(r.phase()), audit: \(r.audit)")
    for _ in 0..<15 {
      usleep(200_000)
      r.sup.tickNow()
    }
    #expect(r.phase() == .stopped(.user) && r.starts.count == 1, "\(r.starts)")
    #expect(keys.presses == ["DOWN", "ENTER"], "\(keys.keys)")
    #expect(r.config.confirmedLaunch == nil && r.config.confirmedLaunchMac == nil && !r.sealed)
  }

  /// The same popup cannot press twice: a second click on the same offer presses nothing.
  @Test func aSecondClickPressesNothing() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: keyed(keys), launchConfirmed: false)
    defer { r.teardown() }
    r.start()
    let item = try #require(r.waitForPopup(), "audit: \(r.audit)")
    _ = r.popupClick(item, choice: 0)
    guard case .nothing? = r.popupClick(item, choice: 0) else {
      Issue.record("a second click pressed")
      return
    }
    usleep(500_000)
    #expect(keys.presses == ["ENTER"], "\(keys.keys)")
  }

  /// The workers' popups keep going to the workers; only Main's own id goes to the supervisor.
  @Test func theSourceRoutesByThread() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", launchConfirmed: false)
    defer { r.teardown() }
    let workers = NoWorkers()
    let source = MainAndWorkersPopupSource(workers: workers, main: r.sup)
    let sem = DispatchSemaphore(value: 0)
    source.popupAnswer(thread: "garden", dialogId: "A", action: .choose(0, label: "x")) { _ in sem.signal() }
    _ = sem.wait(timeout: .now() + 10)
    #expect(workers.threads == ["garden"])
    r.start()
    let item = try #require(r.waitForPopup(), "audit: \(r.audit)")
    #expect(source.popupOffers().contains { $0.dialog.id == item.dialog.id && $0.thread == Supervisor.mainPopupThread })
  }

  // MARK: the offer says what changed

  @Test func theOfferAndTheAuditNameWhatChangedInAChangedLaunch() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.sup.mutateConfig { $0.args.append("--some-new-flag") }
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    #expect(o.launch_changed == ["flags"])
    #expect(r.audit.contains("dev_card_offered ") && r.audit.contains("launch_changed=flags"), "audit: \(r.audit)")
  }

  /// A launch nothing was confirmed for (no key, the first start after the update): the offer says so; the audit line is never empty.
  @Test func anUnconfirmedLaunchIsNeverAnEmptyAuditValue() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh", launchConfirmed: false)
    defer { r.teardown() }
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    #expect(o.launch_changed == [])
    #expect(r.audit.contains("launch_changed=unconfirmed"), "audit: \(r.audit)")
    #expect(!r.audit.contains("launch_changed= ") && !r.audit.contains("launch_changed=\n"), "audit: \(r.audit)")
  }

  // MARK: the phone, without a bridge

  /// The owner starts Main himself at the Mac: he sees the popup, the phone is not told.
  @Test func anOwnersOwnStartAtTheMacDoesNotPostToThePhone() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh", launchConfirmed: false)
    defer { r.teardown() }
    r.start()
    _ = try #require(r.waitForOffer(), "audit: \(r.audit)")
    for _ in 0..<12 {
      usleep(150_000)
      r.sup.tickNow()
    }
    #expect(r.phonePosts.isEmpty, "\(r.phonePosts)")
    r.sup.restartCold()
    #expect(r.wait(30) { r.sup.tickNow(); return r.starts.count == 2 && r.offer != nil }, "audit \(r.audit)")
    usleep(500_000)
    #expect(r.phonePosts.isEmpty, "a menu restart is the owner at the Mac too: \(r.phonePosts)")
  }

  /// A cold start the phone asked for: the owner is away, so the Mac tells the phone, once, with no bridge involved.
  @Test func aPhoneRestartPostsTheNoticeOnceWithoutABridge() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh", launchConfirmed: false)
    defer { r.teardown() }
    #expect(!FileManager.default.fileExists(atPath: r.talosHome + "/status.json"), "no bridge")
    r.start()
    _ = try #require(r.waitForOffer(), "audit: \(r.audit)")
    let ts = Int(r.clock.wallMs())
    try #"{"v":1,"control_id":"c1","action":"restart","ts":\#(ts)}"#.write(toFile: r.talosHome + "/" + AgentRequest.fileName, atomically: true, encoding: .utf8)
    #expect(r.wait(30) { r.sup.tickNow(); return r.starts.count == 2 && r.phonePosts.count == 1 }, "posts \(r.posts) audit \(r.audit)")
    for _ in 0..<12 {
      usleep(150_000)
      r.sup.tickNow()
    }
    #expect(r.phonePosts == ["post general Main is waiting at your Mac: answer the Talos popup there."], "\(r.phonePosts)")
  }

  // MARK: the offer outlives its 15 minutes while the warning stays on screen

  private func quietTimings() -> Supervisor.Timings {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.backoff = Backoff(steps: [0.3, 0.5, 0.5, 0.5, 0.5], jitter: 0)
    t.dialogStall = 100_000
    t.startWait = 100_000
    t.stopGrace = 3
    return t
  }

  private func phoneRestart(_ r: Rig) throws {
    let ts = Int(r.clock.wallMs())
    try #"{"v":1,"control_id":"c1","action":"restart","ts":\#(ts)}"#.write(toFile: r.talosHome + "/" + AgentRequest.fileName, atomically: true, encoding: .utf8)
  }

  @Test func anExpiredOfferIsMadeAgainWhileTheWarningIsStillThereAndTheClickWorks() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: keyed(keys), timings: quietTimings(), launchConfirmed: false)
    defer { r.teardown() }
    r.start()
    _ = try #require(r.waitForOffer(), "audit: \(r.audit)")
    try phoneRestart(r)
    #expect(r.wait(30) { r.sup.tickNow(); return r.starts.count == 2 && r.phonePosts.count == 1 }, "posts \(r.posts) audit \(r.audit)")
    let first = try #require(r.waitForPopup(), "audit: \(r.audit)")
    r.clock.advance(901)
    #expect(r.mainPopup == nil, "expired: no popup before the next look")
    let again = try #require(r.waitForPopup(), "a fresh offer while the warning is still up: audit \(r.audit)")
    #expect(again.dialog.id != first.dialog.id)
    #expect(again.phoneTold, "the phone was told once for this start")
    let res = r.popupClick(again, choice: 0)
    #expect(res == .pressed(choice: 0, label: "I am using this for local development"), "\(String(describing: res)) audit \(r.audit)")
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase())")
    #expect(r.sealed && keys.presses == ["ENTER"], "\(keys.keys)")
    #expect(r.phonePosts.count == 1, "no second phone post: \(r.phonePosts)")
  }

  // MARK: the footer says only what is true

  @Test func theFooterSaysThePhoneIsToldOnlyWhenItWas() throws {
    let owner = try Rig(.direct, scenario: "dev-dialog.sh", launchConfirmed: false)
    defer { owner.teardown() }
    owner.start()
    let own = try #require(owner.waitForPopup(), "audit: \(owner.audit)")
    #expect(!own.phoneTold)
    #expect(NeedsYouPopupContent.make(own).footer != "Your phone is told to come here.")

    let away = try Rig(.direct, scenario: "dev-dialog.sh", launchConfirmed: false)
    defer { away.teardown() }
    away.start()
    _ = try #require(away.waitForPopup(), "audit: \(away.audit)")
    try phoneRestart(away)
    #expect(away.wait(30) { away.sup.tickNow(); return away.starts.count == 2 && away.phonePosts.count == 1 }, "posts \(away.posts)")
    let told = try #require(away.waitForPopup(), "audit: \(away.audit)")
    #expect(told.phoneTold)
    #expect(NeedsYouPopupContent.make(told).footer == "Your phone is told to come here.")
  }

  @Test func theItemIsFirst() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh", launchConfirmed: false)
    defer { r.teardown() }
    r.start()
    #expect(try #require(r.waitForPopup(), "audit: \(r.audit)").first)
  }

  // MARK: the audit says where an answer came from

  @Test func theAnswerLineSaysViaPopupOrViaCard() throws {
    let a = try Rig(.direct, scenario: "dev-dialog-keys.sh", launchConfirmed: false)
    defer { a.teardown() }
    a.start()
    let item = try #require(a.waitForPopup(), "audit: \(a.audit)")
    a.popupClick(item, choice: 0)
    #expect(a.audit.contains("dev_card_answered") && a.audit.contains("via=popup") && !a.audit.contains("via=card"), "audit: \(a.audit)")

    let b = try Rig(.direct, scenario: "dev-dialog-keys.sh", launchConfirmed: false)
    defer { b.teardown() }
    let owner = TestOwner()
    try b.pairPhone(owner)
    b.start()
    let o = try #require(b.waitForOffer(), "audit: \(b.audit)")
    try b.tap(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(b.wait(10) { b.sup.tickNow(); return b.audit.contains("dev_card_answered") }, "audit: \(b.audit)")
    #expect(b.audit.contains("via=card") && !b.audit.contains("via=popup"), "audit: \(b.audit)")
  }
}
