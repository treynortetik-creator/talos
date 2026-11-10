import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Main's development-channels warning as a Needs-you card (the Mac side): every refusal of the guard is offered (`status.devDialog`, which
/// the worker manager writes to workers.json as `supervisor.main_dialog` and the bridge turns into a card); a guard that accepts offers nothing; the owner's
/// signed tap presses the key after a fresh look at the screen and, on "I am using this for local development", stores the launch he confirmed;
/// "Exit" presses Exit and stores nothing; a stale, replayed, forged or screen-changed answer presses nothing. Real pty, real private tmux server.
private let general = "general"

extension Rig {
  var generalDir: String { talosHome + "/workers/" + general }
  var devicesPath: String { talosHome + "/devices.json" }
  var answerPath: String { generalDir + "/main-dialog-answer.json" }
  var resultPath: String { generalDir + "/dialog-result.json" }
  var offer: DialogOffer? { sup.status.devDialog }
  var offeredEvents: [String] {
    allEvents.compactMap { if case .devCardOffered(let id) = $0 { return id } else { return nil } }
  }
  var answeredEvents: [Int] {
    allEvents.compactMap { if case .devCardAnswered(_, let c) = $0 { return c } else { return nil } }
  }
  var result: [String: Any]? {
    FileManager.default.contents(atPath: resultPath).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
  }

  func pairPhone(_ owner: TestOwner) throws {
    try JSONSerialization.data(withJSONObject: ["version": 1, "devices": [owner.entry()]]).write(to: URL(fileURLWithPath: devicesPath), options: .atomic)
  }

  /// A tap on the card, as the bridge writes it: the owner's signature over the card.resolve frame, the card's binding, the answer file.
  func tap(
    _ offer: DialogOffer, owner: TestOwner, choice: Int, control: String, tsOffset: Double = 0, dialogId: String? = nil, thread: String = general,
    omitLaunchChanged: Bool = false, at: Double = Date().timeIntervalSince1970
  ) throws {
    let cardId = "c_01JBF3V7Q8K2M4N6P8R0S2T404"
    var payload: [String: Any] = [
      "dialog_id": offer.id, "dialog_kind": offer.kind.rawValue, "expires_at": offer.expires_at, "options": offer.options, "thread": thread,
    ]
    payload["subject"] = offer.subject.map { $0 as Any } ?? NSNull()
    if let lc = offer.launch_changed, !omitLaunchChanged { payload["launch_changed"] = lc }
    let binding = TestOwner.json([
      "id": cardId, "kind": "dialog", "thread_id": thread, "payload": payload, "title": "Allow Talos's development channel?", "primary_label": "Answer",
    ])
    let frame: [String: Any] = [
      "type": "card.resolve", "v": 1, "id": "01JBF3V7Q8K2M4N6P8R0S2T4AB", "card_id": cardId, "action": "primary", "device_id": owner.deviceId,
      "payload_hash": "sha256:" + TestOwner.hex(binding), "ts": ISOTime.string(Date().timeIntervalSince1970 + tsOffset), "choice": choice,
    ]
    let signed = TestOwner.json(frame)
    let o: [String: Any] = [
      "v": 2, "dialog_id": dialogId ?? offer.id, "choice": choice, "label": offer.options[choice], "by": "Test phone", "at": ISOTime.string(at),
      "control_id": control, "proof": ["signed": signed, "osig": owner.osig(signed), "device_id": owner.deviceId, "binding": binding],
    ]
    try FileManager.default.createDirectory(atPath: generalDir, withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: o).write(to: URL(fileURLWithPath: answerPath), options: .atomic)
  }

  /// Waits for a card offer, with the supervisor ticking.
  func waitForOffer(_ cap: Double = 30) -> DialogOffer? {
    poll(cap) { sup.tickNow(); return offer }
  }
}

private func keyedEnv(_ keys: KeyLog, row: Int = 1) -> [String: String] { ["FAKE_DLG_KEYLOG": keys.path, "FAKE_START_ROW": "\(row)"] }

@Suite("Main's dev-channels dialog as a card", .serialized)
struct DevChannelsCardTests {
  // MARK: every refusal is one offer

  enum Refuse: String, CaseIterable, Sendable {
    case launchChanged, extraChannel, wrongHighlight, twoTitles, autoAcceptOff, outsideWindow
  }

  @Test(arguments: Refuse.allCases)
  func everyRefusalIsOfferedOnceAsACard(why: Refuse) throws {
    var env: [String: String] = [:]
    var scenario = "dev-dialog.sh"
    var confirmed = true
    var configure: @Sendable (inout DesktopConfig) -> Void = { _ in }
    var wait = false
    switch why {
    case .launchChanged: confirmed = false
    case .extraChannel: env = ["FAKE_CHANNELS": "server:talos-app, server:talos-app-evil"]
    case .wrongHighlight: scenario = "dev-dialog-wrong-highlight.sh"
    case .twoTitles: scenario = "dev-dialog-two-titles.sh"
    case .autoAcceptOff: configure = { $0.autoConfirmRestart = false }
    case .outsideWindow:
      scenario = "dev-dialog-wait.sh"
      wait = true
    }
    let r = try Rig(.direct, scenario: scenario, env: env, launchConfirmed: confirmed, configure: configure)
    defer { r.teardown() }
    r.start()
    if wait {
      #expect(r.wait(10) { r.sup.status.childPid != nil })
      r.clock.advance(61)
      r.showDialog()
    }
    let o = try #require(r.waitForOffer(), "no card offer: audit \(r.audit)")
    #expect(o.kind == .devChannels && o.kind.rawValue == "dev_channels")
    #expect(o.options == ["I am using this for local development", "Exit"])
    #expect(o.isValid)
    if why == .extraChannel { #expect(o.subject == "server:talos-app, server:talos-app-evil") }
    if why == .launchChanged { #expect(o.launch_changed == [], "nothing was confirmed yet: changed, but nothing to compare") }
    // the same sighting keeps its offer however long it stays: one card, never a second
    for _ in 0..<10 {
      usleep(150_000)
      r.sup.tickNow()
    }
    #expect(r.offer?.id == o.id)
    #expect(r.offeredEvents == [o.id], "\(r.offeredEvents)")
    #expect(r.audit.components(separatedBy: " dev_card_offered ").count - 1 == 1, "one audit line: \(r.audit)")
  }

  /// A typing client holds the Enter for a few passes first (it may clear by itself): the card comes only once the hold is over.
  @Test(.enabled(if: Rig.hasTmux))
  func aTypingClientIsHeldThenOffered() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let shim = r.root + "/tmux-clients-shim"
    try """
    #!/bin/bash
    for a in "$@"; do
      if [ "$a" = list-clients ]; then echo 'list-clients: broken' >&2; exit 1; fi
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeSupervisor()
    r.start()
    let o = try #require(r.waitForOffer(40), "audit: \(r.audit)")
    #expect(o.kind == .devChannels)
    #expect(r.audit.contains("auto_confirm_refused kind=cold reason=clientsMayBeTyping"), "audit: \(r.audit)")
  }

  /// A second appearance after our own Enter: the dialog is offered too.
  @Test func aSecondAppearanceIsOffered() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-twice.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == .restartNotConfirmed(.alreadyConfirmedThisStart) }, "audit: \(r.audit)")
    #expect(r.waitForOffer(10) != nil, "audit: \(r.audit)")
    #expect(r.offeredEvents.count == 1)
  }

  /// A changed program says so at the level the fingerprint knows; no value is in the offer.
  @Test func aChangedProgramIsNamedNotQuoted() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase())")
    let other = r.home + "/other-claude"
    try "#!/bin/bash\nexec \(Rig.fixtures)/claude \"$@\"\n".write(toFile: other, atomically: true, encoding: .utf8)
    chmod(other, 0o755)
    r.sup.mutateConfig { $0.claudePath = other }
    r.sup.restartCold()
    let o = try #require(r.poll(30) { r.sup.tickNow(); return r.offer }, "audit: \(r.audit)")
    #expect(o.launch_changed == ["program"], "the piece, not the path")
  }

  /// A tap on the card stores the pieces, so a later change says which piece.
  @Test func aLaterChangeNamesThePiece() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", launchConfirmed: false)
    defer { r.teardown() }
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.start()
    let first = try #require(r.waitForOffer())
    try r.tap(first, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) && r.config.confirmedLaunchParts != nil }, "\(r.phase())")
    #expect(Set(r.config.confirmedLaunchParts?.keys.map { $0 } ?? []) == ["folder", "program", "flags", "env"])
    r.sup.mutateConfig { $0.env["SOME_NEW_VARIABLE"] = "hunter2" }
    r.sup.restartCold()
    let o = try #require(r.poll(30) { r.sup.tickNow(); return r.offer?.launch_changed == nil ? nil : r.offer }, "audit: \(r.audit)")
    #expect(o.launch_changed == ["env"])
    #expect(!String(decoding: try JSONEncoder().encode(o), as: UTF8.self).contains("hunter2"), "never a value")
  }

  // MARK: the guard accepts: no card

  @Test(arguments: bothHosts)
  func aGuardThatAcceptsOffersNoCard(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.start()
    let cap: Double = kind == .tmux ? 30 : 10
    #expect(r.wait(cap) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.offer == nil)
    #expect(r.offeredEvents.isEmpty)
    #expect(!r.audit.contains("dev_card_offered"))
  }

  // MARK: the tap

  /// "I am using this for local development": one Enter after a fresh look, the launch he confirmed is stored, the guard never pressed anything.
  @Test(arguments: bothHosts)
  func theTapOnConfirmPressesEnterAndStoresTheLaunch(kind: HostKind) throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: keyedEnv(keys), launchConfirmed: false)
    defer { r.teardown() }
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    #expect(r.config.confirmedLaunch == nil)
    try r.tap(o, owner: owner, choice: 0, control: "ctl_1")
    let cap: Double = kind == .tmux ? 30 : 10
    #expect(r.wait(cap) { r.sup.tickNow(); return r.result?["control_id"] as? String == "ctl_1" }, "no result: \(keys.keys), audit: \(r.audit)")
    #expect(r.result?["outcome"] as? String == "pressed" && r.result?["choice"] as? Int == 0 && r.result?["source"] as? String == "card", "\(String(describing: r.result))")
    #expect(r.result?["label"] as? String == "I am using this for local development")
    #expect(r.wait(cap) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(keys.presses == ["ENTER"], "\(keys.keys)")
    #expect(r.config.confirmedLaunch != nil, "the owner's tap is his confirm")
    #expect(r.config.confirmedLaunch == r.config.launchFingerprint(resolvedClaude: r.config.claudePath))
    #expect(r.autoConfirms == 0, "the app pressed nothing by itself: \(r.audit)")
    #expect(r.answeredEvents == [0])
    #expect(r.audit.contains("dev_card_answered"))
    #expect(r.wait(10) { r.sup.tickNow(); return r.offer == nil }, "the offer ends with the dialog")
    // the next start with the same launch is automatic
    r.sup.restartCold()
    #expect(r.wait(60) { r.sup.tickNow(); return r.starts.count == 2 && isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.offer == nil)
  }

  /// The wrong row highlighted: the guard refuses it; a tap on the confirm walks Up one row, then Enter, each on a fresh look.
  @Test(arguments: bothHosts)
  func aTapWalksToTheSignedRowFirst(kind: HostKind) throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: keyedEnv(keys, row: 2))
    defer { r.teardown() }
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    #expect(o.cursor == 1)
    try r.tap(o, owner: owner, choice: 0, control: "ctl_1")
    let cap: Double = kind == .tmux ? 30 : 10
    #expect(r.wait(cap) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), keys \(keys.keys), audit: \(r.audit)")
    #expect(keys.presses == ["UP", "ENTER"], "\(keys.keys)")
  }

  /// "Exit" presses Exit and stores nothing.
  @Test(arguments: bothHosts)
  func theTapOnExitPressesExitAndStoresNothing(kind: HostKind) throws {
    let keys = KeyLog()
    defer { keys.remove() }
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.dialogStall = 600
    t.restartCap = 0  // the exit is the owner's: nothing here restarts it into the same dialog
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: keyedEnv(keys), timings: t, launchConfirmed: false, configure: { $0.autoRestart = false })
    defer { r.teardown() }
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    try r.tap(o, owner: owner, choice: 1, control: "ctl_1")
    let cap: Double = kind == .tmux ? 30 : 10
    #expect(r.wait(cap) { r.sup.tickNow(); return r.result?["control_id"] as? String == "ctl_1" }, "no result: \(keys.keys)")
    #expect(r.result?["outcome"] as? String == "pressed" && r.result?["choice"] as? Int == 1 && r.result?["label"] as? String == "Exit", "\(String(describing: r.result))")
    #expect(keys.presses == ["DOWN", "ENTER"], "\(keys.keys)")
    #expect(r.config.confirmedLaunch == nil, "Exit confirms nothing")
    #expect(r.answeredEvents == [1])
  }

  /// The owner's Exit is an intended stop, like his Stop: the process ends, nothing restarts into the same dialog, no second card, no crash-loop
  /// post; status says stopped; his later Start works and shows the dialog (and a card) again.
  @Test(arguments: bothHosts)
  func theTapOnExitStaysStopped(kind: HostKind) throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: keyedEnv(keys), launchConfirmed: false)
    defer { r.teardown() }
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    try r.tap(o, owner: owner, choice: 1, control: "ctl_1")
    let cap: Double = kind == .tmux ? 30 : 10
    #expect(r.wait(cap) { r.sup.tickNow(); return r.phase() == .stopped(.user) }, "\(r.phase()), audit: \(r.audit)")
    for _ in 0..<25 {
      usleep(200_000)
      r.sup.tickNow()
    }
    #expect(r.phase() == .stopped(.user))
    #expect(r.starts.count == 1, "no restart: \(r.starts)")
    #expect(r.offeredEvents == [o.id], "no second card")
    #expect(r.phonePosts.isEmpty && r.crashPosts.isEmpty, "\(r.phonePosts)")
    #expect(r.sup.status.devDialog == nil)
    #expect(r.config.confirmedLaunch == nil)
    // his own Start later works, and the dialog (still unconfirmed) is offered again
    r.sup.start()
    let again = try #require(r.poll(cap) { r.sup.tickNow(); return r.offer }, "audit: \(r.audit)")
    #expect(again.id != o.id && r.starts.count == 2)
  }

  // MARK: nothing pressed

  /// A forged answer, a phone that is not paired, an old signature, another dialog's id, another thread's card: nothing is pressed.
  @Test(arguments: ["unpaired", "oldts", "otherDialog", "otherThread"])
  func aProofThatDoesNotCheckOutPressesNothing(what: String) throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: keyedEnv(keys), launchConfirmed: false)
    defer { r.teardown() }
    let owner = TestOwner()
    if what != "unpaired" { try r.pairPhone(owner) }
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    switch what {
    case "oldts": try r.tap(o, owner: owner, choice: 0, control: "ctl_1", tsOffset: -20 * 60)
    case "otherDialog": try r.tap(o, owner: owner, choice: 0, control: "ctl_1", dialogId: "Wq5Lm8ZtRx3Cv9PkNa2HdB")
    case "otherThread": try r.tap(o, owner: owner, choice: 0, control: "ctl_1", thread: "trip")
    default: try r.tap(o, owner: owner, choice: 0, control: "ctl_1")
    }
    #expect(r.wait(10) { r.sup.tickNow(); return r.result?["control_id"] as? String == "ctl_1" }, "no result")
    #expect(r.result?["outcome"] as? String == "nothing_pressed", "\(String(describing: r.result))")
    for _ in 0..<5 {
      usleep(150_000)
      r.sup.tickNow()
    }
    #expect(keys.presses.isEmpty, "a key was sent: \(keys.keys)")
    #expect(r.config.confirmedLaunch == nil)
    #expect(r.offer?.id == o.id, "the card is still waiting")
  }

  /// The same signed tap again, under a new control id: used once.
  @Test func aReplayedTapIsPressedOnce() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: keyedEnv(keys), launchConfirmed: false)
    defer { r.teardown() }
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    try r.tap(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(10) { r.sup.tickNow(); return r.result?["control_id"] as? String == "ctl_1" })
    try r.tap(o, owner: owner, choice: 0, control: "ctl_2")
    for _ in 0..<5 {
      usleep(150_000)
      r.sup.tickNow()
    }
    #expect(keys.presses == ["ENTER"], "\(keys.keys)")
  }

  /// A card for a dialog that is gone: the owner answered in the pane first. The late tap presses nothing, and no key reaches the session.
  @Test func aStaleCardPressesNothing() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: keyedEnv(keys), launchConfirmed: false)
    defer { r.teardown() }
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.start()
    let o = try #require(r.waitForOffer(), "audit: \(r.audit)")
    r.humanEnter()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) && r.offer == nil }, "\(r.phase())")
    try r.tap(o, owner: owner, choice: 0, control: "ctl_1")
    for _ in 0..<8 {
      usleep(150_000)
      r.sup.tickNow()
    }
    #expect(keys.presses == ["ENTER"], "only the owner's own Enter: \(keys.keys)")
    #expect(r.answeredEvents.isEmpty)
  }

  /// tmux, except that once the offer stands the pane reads as another screen: the key is not sent (the fresh look before the key).
  @Test(.enabled(if: Rig.hasTmux))
  func aScreenThatChangedBeforeTheKeyGetsNoKey() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog-keys.sh", launchConfirmed: false)
    defer { r.teardown() }
    let swap = r.root + "/swap"
    let sends = r.root + "/sends"
    let shim = r.root + "/tmux-swap-shim"
    try """
    #!/bin/bash
    for a in "$@"; do
      case "$a" in
        send-keys) echo x >> '\(sends)' ;;
        capture-pane) if [ -e '\(swap)' ]; then printf ' > working\\n'; exit 0; fi ;;
      esac
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeSupervisor()
    let owner = TestOwner()
    try r.pairPhone(owner)
    r.start()
    let o = try #require(r.waitForOffer(40), "audit: \(r.audit)")
    FileManager.default.createFile(atPath: swap, contents: Data())
    try r.tap(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(30) { r.sup.tickNow(); return r.result?["control_id"] as? String == "ctl_1" }, "no result")
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "screen_changed", "\(String(describing: r.result))")
    #expect(!FileManager.default.fileExists(atPath: sends), "no key was sent")
    #expect(r.config.confirmedLaunch == nil)
  }
}

/// The hand-over: Main's offer is written to workers.json as `supervisor.main_dialog` within a tick of appearing or going, and nowhere else.
@Suite("Main's offer reaches workers.json", .serialized, .enabled(if: Rig.hasTmux))
struct MainDialogFileTests {
  final class Box: @unchecked Sendable {
    private let lock = NSLock()
    private var o: DialogOffer?
    var offer: DialogOffer? {
      get { lock.withLock { o } }
      set { lock.withLock { o = newValue } }
    }
  }

  @Test func theOfferIsWrittenWhenItAppearsAndRemovedWhenItGoes() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let box = Box()
    r.mgr.setMainDialog { box.offer }
    let path = r.talosHome + "/workers.json"
    func mainDialog() -> DialogOffer? { FileManager.default.contents(atPath: path).flatMap(WorkersFile.decode)?.supervisor.main_dialog }
    r.mgr.tickOnce()
    #expect(mainDialog() == nil)
    let seen = ISOTime.string(Date().timeIntervalSince1970)
    let offer = DialogOffer(
      id: "Dv5Qm8ZtRx3Cw9PkNa2HdB", kind: .devChannels, subject: "server:talos-app", options: ["I am using this for local development", "Exit"], cursor: 0,
      launch_changed: [], seen_at: seen, expires_at: ISOTime.string(Date().timeIntervalSince1970 + 900))
    box.offer = offer
    r.mgr.tickOnce()  // far inside the heartbeat: the change itself is what writes the file
    #expect(mainDialog() == offer)
    box.offer = nil
    r.mgr.tickOnce()
    #expect(mainDialog() == nil)
    #expect(!String(decoding: FileManager.default.contents(atPath: path) ?? Data(), as: UTF8.self).contains("main_dialog"))
  }
}
